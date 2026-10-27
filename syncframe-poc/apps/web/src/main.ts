/**
 * P1 播放器验证页主逻辑。
 * 流程：解析 OpenList 路径 → 获取媒体地址 → CountingHttpSource 接入 movi-player
 *      → 事件驱动指标采集 → 导出 / 上传报告。
 */

import "movi-player/element/slim";
// Vite 将 movi.wasm 作为资源发出，得到可缓存的 URL（自托管 WASM，不走 CDN）
import wasmUrl from "movi-player/movi.wasm?url";
import { CountingHttpSource } from "./counting-source.ts";
import { PlaybackMetrics, type PlaybackReport } from "./metrics.ts";
import { icon } from "./icons.ts";

interface ResolveResponse {
  name: string;
  size: number;
  path: string;
  route: "raw" | "proxy";
  url: string;
  redirected: boolean;
  provider: string | null;
  related: { name: string; size: number }[];
}

interface MoviElement extends HTMLElement {
  sourceAdapter: unknown;
  currentTime: number;
  duration: number;
  videoWidth: number;
  videoHeight: number;
  paused: boolean;
  playbackRate: number;
  play(): Promise<void>;
  load(): void;
  getVideoPlaybackQuality?: () => { totalVideoFrames: number; droppedVideoFrames: number };
}

const $ = <T extends HTMLElement>(sel: string): T => {
  const el = document.querySelector<T>(sel);
  if (!el) throw new Error(`缺少元素 ${sel}`);
  return el;
};

const pathInput = $<HTMLInputElement>("#path");
const routeSel = $<HTMLSelectElement>("#route");
const statusEl = $("#status");
const statsEl = $("#stats");
const decoderSel = $<HTMLSelectElement>("#decoder");
const codecInfoInput = $<HTMLInputElement>("#codecInfo");

// 预置 .env 中固定的测试文件，减少手工输入
pathInput.value =
  "/guanya/05.动漫/Cyberpunk.Edgerunners.S02E01.Last.Chance.for.a.Slow.Dance.1080p.NF.WEB-DL.DUAL.DDP5.1.H.264-VARYG.mkv";

let metrics: PlaybackMetrics | null = null;
let current: ResolveResponse | null = null;
let currentSource: CountingHttpSource | null = null;
const RATES = [1, 1.25, 1.5, 2, 0.5];
let rateIdx = 0;

// 播放器引用：冷启动重载时替换 DOM 节点，引用随之更新
const playerRef: { current: MoviElement } = {
  current: document.querySelector("movi-player") as unknown as MoviElement,
};
playerRef.current.setAttribute("wasmurl", wasmUrl);

function setStatus(text: string, ico?: "alert"): void {
  if (!ico) {
    statusEl.textContent = text;
    return;
  }
  // 图标为受信静态 SVG，文本仍以 textContent 方式写入，避免注入
  statusEl.textContent = "";
  statusEl.insertAdjacentHTML("beforeend", icon(ico));
  statusEl.appendChild(document.createTextNode(` ${text}`));
}

function containerOf(name: string): string {
  const m = name.match(/\.([a-z0-9]+)$/i);
  return m ? m[1].toUpperCase() : "";
}

async function resolve(path: string, route: "raw" | "proxy"): Promise<ResolveResponse> {
  // 透传浏览器 UA：部分存储按 UA 生成 raw_url，必须与播放端一致
  const params = new URLSearchParams({ path, route, ua: navigator.userAgent });
  const res = await fetch(`/api/resolve?${params}`);
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(`解析失败 HTTP ${res.status}: ${body.error ?? "未知错误"}`);
  }
  return (await res.json()) as ResolveResponse;
}

/** 冷启动：销毁旧元素、插入新元素（全新播放器状态） */
function rebuildPlayer(): void {
  const old = playerRef.current;
  const fresh = old.cloneNode(false) as HTMLElement;
  old.replaceWith(fresh);
  playerRef.current = fresh as unknown as MoviElement;
  playerRef.current.setAttribute("wasmurl", wasmUrl);
}

async function load(coldOrWarm: "cold" | "warm"): Promise<void> {
  const path = pathInput.value.trim();
  if (!path) {
    setStatus("请填写 OpenList 文件路径");
    return;
  }
  setStatus("正在解析媒体地址…");
  try {
    current = await resolve(path, routeSel.value as "raw" | "proxy");
  } catch (err) {
    setStatus(err instanceof Error ? err.message : String(err));
    return;
  }
  setStatus(`已解析: ${current.name}（${(current.size / 1024 / 1024).toFixed(1)} MiB，${current.provider ?? "?"}）`);

  if (coldOrWarm === "cold") rebuildPlayer();
  const el = playerRef.current;

  metrics?.detach();
  currentSource = new CountingHttpSource(current.url, current.size);
  metrics = new PlaybackMetrics({
    sampleId: current.name,
    path: current.path,
    route: current.route,
    coldOrWarm,
    container: containerOf(current.name),
  });
  metrics.attach(el as never, currentSource);
  metrics.report.fileSize = current.size;

  el.sourceAdapter = currentSource as never;
  // 首次播放 5 秒后采样画布亮度，自动判定黑屏
  el.addEventListener(
    "playing",
    () => {
      window.setTimeout(() => sampleLuminance(el), 5000);
    },
    { once: true },
  );
  void el.play().catch(() => {
    // 自动播放被浏览器拦截属预期场景（S08），由用户手势点击播放
    metrics?.note("自动播放被浏览器拦截，需手动点击播放");
    setStatus("自动播放被拦截，请点击播放器播放按钮");
  });
}

$("#load").addEventListener("click", () => void load("cold"));
$("#reloadCold").addEventListener("click", () => void load("cold"));
$("#reloadWarm").addEventListener("click", () => void load("warm"));
pathInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") void load("cold");
});

document.querySelectorAll<HTMLButtonElement>("[data-seek]").forEach((btn) => {
  btn.addEventListener("click", () => {
    const el = playerRef.current;
    if (!el.duration || !Number.isFinite(el.duration)) return;
    el.currentTime = el.duration * Number(btn.dataset.seek);
  });
});

$("#rateBtn").addEventListener("click", () => {
  rateIdx = (rateIdx + 1) % RATES.length;
  playerRef.current.playbackRate = RATES[rateIdx];
  $("#rateBtn").textContent = `倍速: ${RATES[rateIdx]}×`;
});

// ── 诊断信息捕获（浏览器兼容性问题定位用） ───────────────
const diagBuffer: string[] = [];
function diag(msg: string): void {
  diagBuffer.push(`${new Date().toISOString().slice(11, 19)} ${msg}`);
  if (diagBuffer.length > 12) diagBuffer.shift();
}

const origConsoleError = console.error.bind(console);
const origConsoleWarn = console.warn.bind(console);
console.error = (...args: unknown[]) => {
  diag(`[console.error] ${args.map(String).join(" ").slice(0, 200)}`);
  origConsoleError(...args);
};
console.warn = (...args: unknown[]) => {
  diag(`[console.warn] ${args.map(String).join(" ").slice(0, 200)}`);
  origConsoleWarn(...args);
};
window.addEventListener("error", (e) => {
  diag(`[window.onerror] ${String(e.message).slice(0, 200)} @ ${String(e.filename).split("/").pop()}:${e.lineno}`);
});
window.addEventListener("unhandledrejection", (e) => {
  diag(`[unhandledrejection] ${String(e.reason).slice(0, 200)}`);
});

/** 播放环境能力探测 */
function capabilityProbe(): string {
  const parts: string[] = [];
  parts.push(`VideoDecoder=${typeof (window as unknown as { VideoDecoder?: unknown }).VideoDecoder}`);
  parts.push(`AudioDecoder=${typeof (window as unknown as { AudioDecoder?: unknown }).AudioDecoder}`);
  parts.push(`crossOriginIsolated=${window.crossOriginIsolated}`);
  parts.push(`SharedArrayBuffer=${typeof SharedArrayBuffer}`);
  try {
    const c = document.createElement("canvas");
    parts.push(`WebGL2=${c.getContext("webgl2") !== null}`);
  } catch {
    parts.push("WebGL2=false");
  }
  return parts.join(" ");
}

/** 采样播放器画布中心区域平均亮度（0-255），用于自动判定黑屏 */
function sampleLuminance(el: HTMLElement): void {
  try {
    const canvas = (el.shadowRoot ?? el).querySelector("canvas");
    if (!canvas || canvas.width === 0 || canvas.height === 0) {
      diag("亮度检测: 未找到画布");
      return;
    }
    const probe = document.createElement("canvas");
    probe.width = 64;
    probe.height = 64;
    const ctx = probe.getContext("2d", { willReadFrequently: true });
    if (!ctx) {
      diag("亮度检测: 无法创建 2D 上下文");
      return;
    }
    // 取中心 64×64 区域
    const sx = Math.max(0, canvas.width / 2 - 32);
    const sy = Math.max(0, canvas.height / 2 - 32);
    ctx.drawImage(canvas, sx, sy, 64, 64, 0, 0, 64, 64);
    const data = ctx.getImageData(0, 0, 64, 64).data;
    let sum = 0;
    for (let i = 0; i < data.length; i += 4) {
      sum += 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
    }
    const lum = Math.round(sum / (data.length / 4));
    metrics && (metrics.report.blackScreenLuminance = lum);
    diag(`亮度检测: 平均亮度 ${lum}/255 ${lum < 8 ? "（黑屏）" : ""}`);
  } catch (err) {
    diag(`亮度检测失败: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ── 实时统计 HUD ────────────────────────────────────────
function fmtTime(sec: number): string {
  if (!Number.isFinite(sec)) return "--:--";
  const s = Math.floor(sec % 60);
  const m = Math.floor((sec / 60) % 60);
  const h = Math.floor(sec / 3600);
  return `${h > 0 ? `${h}:` : ""}${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function updateStats(): void {
  const el = playerRef.current;
  if (metrics && currentSource && current) {
    const r = metrics.snapshot(0);
    const pos = Number.isFinite(el.currentTime) ? `${fmtTime(el.currentTime)} / ${fmtTime(el.duration)}` : "--:--";
    const q = el.getVideoPlaybackQuality?.();
    statsEl.textContent =
      `播放位置: ${pos}\n` +
      `首帧/元数据: ${r.firstFrameTimeMs ?? "-"} ms / ${r.metadataTimeMs ?? "-"} ms\n` +
      `重新缓冲: ${r.rebufferCount} 次 / ${r.rebufferDurationMs} ms\n` +
      `帧: 渲染 ${q?.totalVideoFrames ?? "-"} / 丢弃 ${q?.droppedVideoFrames ?? "-"}\n` +
      `网络: ${r.rangeRequestCount} 个 Range 请求 / ${(r.bytesRead / 1024 / 1024).toFixed(1)} MiB / 失败 ${r.requestFailures}\n` +
      `JS Heap: ${r.jsHeapUsedMB ?? "-"} MB\n` +
      `Seek 记录: ${r.seekTests.map((s) => `${s.targetSec}s→${s.latencyMs}ms`).join(", ") || "（暂无）"}\n` +
      `错误: ${r.errors.join("; ") || "无"}\n` +
      `环境: ${capabilityProbe()}\n` +
      `诊断: ${diagBuffer.join(" | ") || "（暂无）"}`;
  }
  window.setTimeout(updateStats, 1000);
}
void updateStats();

// ── 导出 / 上传 / 清空 ──────────────────────────────────
function collectReport(): PlaybackReport | null {
  if (!metrics || !current) {
    setStatus("尚无指标可导出");
    return null;
  }
  const r = metrics.snapshot(0);
  r.decoderEngine = decoderSel.value;
  r.hardwareOrSoftware = decoderSel.options[decoderSel.selectedIndex]?.text ?? "";
  r.envInfo = capabilityProbe();
  r.diagnostics = [...diagBuffer];
  const info = codecInfoInput.value.trim();
  if (info) {
    const parts = info.split("/");
    r.container = parts[0]?.trim().toUpperCase() || r.container;
    r.videoCodec = parts[1]?.trim() ?? "";
    r.audioCodec = parts[2]?.trim() ?? "";
  }
  return r;
}

$("#export").addEventListener("click", () => {
  const r = collectReport();
  if (!r) return;
  const blob = new Blob([JSON.stringify(r, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `playback-${r.testId}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  setStatus(`已导出 ${a.download}`);
});

$("#upload").addEventListener("click", async () => {
  const r = collectReport();
  if (!r) return;
  try {
    const res = await fetch("/api/report", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(r),
    });
    const body = (await res.json()) as { saved?: string; error?: string };
    setStatus(res.ok ? `已上传: ${body.saved}` : `上传失败: ${body.error ?? res.status}`);
  } catch (err) {
    setStatus(`上传失败: ${err instanceof Error ? err.message : err}`);
  }
});

$("#clear").addEventListener("click", () => {
  if (metrics) {
    metrics.detach();
    metrics = null;
  }
  decoderSel.value = "";
  codecInfoInput.value = "";
  setStatus("指标已清空");
});

// 页面加载后检查后端连通性
fetch("/api/health")
  .then((r) => r.json())
  .then((j: { ok: boolean }) => setStatus(j.ok ? "后端已连接。填写路径后点击「载入」。" : "后端异常"))
  .catch(() => setStatus("无法连接后端，请先启动: npm run p1:server", "alert"));
