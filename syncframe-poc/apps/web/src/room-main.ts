/**
 * P3 房间页主逻辑：房间鉴权会话 + 受控媒体链路 + OpenList 媒体库。
 *
 * 会话：成员令牌从 sessionStorage 恢复（大厅页写入）；缺失/过期 → 回大厅重新加入。
 * 媒体：WebSocket 只传播不透明 mediaId；客户端用成员令牌向
 *   GET /api/rooms/:id/media/:mediaId/grant 换取短期媒体地址（10 分钟提示期，服务端缓存 60s）。
 *
 * 两种媒体模式：
 * - player（默认）：真实 Movi Player + grant 媒体链路（需 OpenList 配置）；
 * - clock：VirtualMediaClock 纯时钟，同步行为的可重复演示/测试载体（?mode=clock）。
 *
 * URL 参数：room / name / mode=player|clock / hardDriftMs
 */

import { SyncClient, VirtualMediaClock } from "@syncframe/sync-protocol";
import type { MediaAdapter } from "@syncframe/sync-protocol";
import "movi-player/element/slim";
import wasmUrl from "movi-player/movi.wasm?url";
import { initBrowsePanel } from "./browse.ts";
import { loadSession, clearSession } from "./session.ts";
import { iconElement } from "./icons.ts";
import { biliCredentialHeaders, loadBiliSessdata } from "./bili-credential.ts";

const params = new URLSearchParams(location.search);
const roomId = (params.get("room") || "").slice(0, 64);
const name = (params.get("name") || `Guest-${Math.random().toString(36).slice(2, 6)}`).slice(0, 24);
const mode = params.get("mode") === "clock" ? "clock" : "player";
const hardDriftMs = Number(params.get("hardDriftMs") ?? 1000);

// ── P3 房间鉴权：无有效会话 → 回大厅（携带房间号便于重新加入）────────────────

const session = roomId ? loadSession(roomId) : null;
if (!roomId || !session) {
  location.replace(`/lobby.html${roomId ? `?room=${encodeURIComponent(roomId)}&expired=1` : ""}`);
  throw new Error("等待重定向到大厅");
}
const role = session.role;
const memberToken = session.memberToken;
const authHeaders = { Authorization: `Bearer ${memberToken}` };

// P4：登录用户令牌（大厅页写入 localStorage），用于私有 provider 的媒体注册。
interface LocalUser {
  token: string;
  username: string;
}
function loadUser(): LocalUser | null {
  try {
    const raw = localStorage.getItem("syncframe-user");
    if (!raw) return null;
    const parsed = JSON.parse(raw) as LocalUser;
    return parsed.token && parsed.username ? parsed : null;
  } catch {
    return null;
  }
}
const localUser = loadUser();

interface PublicProvider {
  id: string;
  kind: "openlist" | "bilibili";
  label: string;
  baseUrl?: string;
  username?: string;
}

async function fetchMyProviders(): Promise<PublicProvider[]> {
  if (!localUser) return [];
  try {
    const res = await fetch("/api/me", { headers: { Authorization: `Bearer ${localUser.token}` } });
    if (!res.ok) return [];
    const body = (await res.json()) as { providers?: PublicProvider[] };
    return body.providers ?? [];
  } catch {
    return [];
  }
}

// 每房间稳定身份：来自会话（大厅 join 时服务端签发/复用）。
const clientId = session.clientId;

const $ = <T extends HTMLElement>(sel: string): T => {
  const el = document.querySelector<T>(sel);
  if (!el) throw new Error(`缺少元素 ${sel}`);
  return el;
};

interface MoviElement extends HTMLElement {
  currentTime: number;
  duration: number;
  paused: boolean;
  playbackRate: number;
  /** 与原生媒体元素同义的只读状态（部分实现未必暴露，读取时按可选处理）。 */
  seeking?: boolean;
  readyState?: number;
  play(): Promise<void>;
  pause(): void;
  load(): void;
  player: {
    getAudioTracks(): { id: number; label?: string }[];
    getSubtitleTracks(): { id: number; label?: string }[];
    selectAudioTrack(id: number): void;
    selectSubtitleTrack(id: number | null): void;
  };
}

// ── 媒体状态徽标（加载/缓冲/同步/手势/失败/重连 的可见状态）──────────────────

const mediaBadge = $("#mediaBadge");
function setMediaBadge(text: string, state: "none" | "loading" | "ok" | "fail" = "none"): void {
  mediaBadge.textContent = text;
  mediaBadge.className =
    "badge " + (state === "ok" ? "media-ok" : state === "loading" ? "media-loading" : state === "fail" ? "media-fail" : "");
}

// ── 媒体适配器 ────────────────────────────────────────────

function makeClockAdapter(): { adapter: MediaAdapter; clock: VirtualMediaClock } {
  const clock = new VirtualMediaClock({});
  return {
    clock,
    adapter: {
      getTimeMs: () => clock.getCurrentTimeMs(),
      isPaused: () => clock.isPaused(),
      getRate: () => clock.getRate(),
      play: () => clock.play(),
      pause: () => clock.pause(),
      seek: (ms) => clock.seek(ms),
      setRate: (r) => clock.setRate(r),
      load: () => {
        clock.seek(0);
      },
      hasMedia: () => true,
    },
  };
}

const playerRef: { current: MoviElement } = {
  current: document.querySelector("movi-player") as unknown as MoviElement,
};
playerRef.current.setAttribute("wasmurl", wasmUrl);

/** 仅房主（player 模式）启用 movi-player 内置控件；观众端始终跟随，无本地控制。 */
const showBuiltInControls = mode === "player" && role === "host";
if (showBuiltInControls) playerRef.current.setAttribute("controls", "");

/**
 * 同步转发抑制窗口：适配器驱动（应用远端状态 / 恢复媒体）触发的回放事件不回传给房间，
 * 只有用户在内置控件上的手势操作才转发为房主命令。seeked 等事件异步到达，故用时间窗。
 */
let suppressPlaybackEventsUntil = 0;
function markPlaybackEventSuppressed(ms = 800): void {
  suppressPlaybackEventsUntil = Date.now() + ms;
}

/** 把内置控件上的用户手势转发为房主同步命令（viewer 与 clock 模式不接线）。 */
function wireControlForwarding(el: MoviElement): void {
  if (!showBuiltInControls) return;
  const fromUserGesture = (): boolean =>
    Date.now() >= suppressPlaybackEventsUntil
    && !playerReloading
    && playerReady
    && playerMediaId !== "";
  el.addEventListener("play", () => {
    if (playerReloading) return;
    wantPlay = true;
    if (fromUserGesture()) void client.hostPlay();
  });
  el.addEventListener("pause", () => {
    // 换源/重载自身会触发 pause：不代表用户意图，也不该改变"应播放"状态。
    if (playerReloading) return;
    wantPlay = false;
    if (!fromUserGesture()) return;
    // 换源/重载会把位置打回 0：这种"位置归零的暂停"不是用户操作，
    // 上报出去会让全房间跳回开头并暂停。
    const posMs = (el.currentTime || 0) * 1000;
    if (posMs < 1000 && lastConfirmedPosMs > 5000) return;
    client.hostPause();
  });
  el.addEventListener("ratechange", () => {
    if (fromUserGesture()) client.hostRate(el.playbackRate || 1);
  });
  el.addEventListener("seeked", () => {
    if (fromUserGesture()) client.hostSeek((el.currentTime || 0) * 1000);
  });
}

interface GrantResponse {
  url: string;
  name: string;
  size: number;
  expiresInSec: number;
  cached: boolean;
  /** B 站独立音轨（无独立音轨时为 undefined，例如 durl 音画合一）。 */
  audioUrl?: string;
  /** 直连不可用或失败时的服务端反代地址。 */
  fallbackUrl?: string;
  fallbackAudioUrl?: string;
  /** true = url 为 B 站 CDN 直链（浏览器直拉，不占服务器带宽）。 */
  direct?: boolean;
  /** true = 本次按匿名解析（未绑定 B 站凭证），画质受匿名上限限制。 */
  anonymous?: boolean;
}

let playerMediaId = "";
let playerReady = false;
/** 至少成功开始播放过一次：区分「真实签名/网络错误」与「初始解码失败（如 stub 假数据）」。 */
let hasStartedPlayback = false;
/** 恢复中标志：防止 error 事件循环触发 recoverMedia。 */
let recovering = false;
/** 直连探测失败过一次后，本次会话后续 grant 直接走反代，避免反复超时。 */
let preferProxy = false;
/** 当前播放源是否为直连（直连播放失败时据此切回反代）。 */
let currentSourceDirect = false;
/** 播放器是否处于缓冲/加载中（供同步纠偏避让）。 */
let mediaBuffering = false;
/**
 * 换源/重载窗口内为 true：此时播放器会自发 pause/play/seek，
 * 这些事件不是用户操作，绝不能上报成房主命令（否则会把全房间拉回开头）。
 */
let playerReloading = false;
/** 最近一次确认过的播放位置（用于识别"重载导致位置归零"的假暂停）。 */
let lastConfirmedPosMs = 0;
/** 期望播放（供换源/重载就绪后自动续播）。 */
let wantPlay = false;

/**
 * 把媒体地址交给播放器原生流式源（src / <source>），而不是自定义 sourceAdapter。
 *
 * 关键：内置 HttpSource 是单连接流式下载（首包 4MB）；自定义 adapter 会让播放器按
 * 512KB 一块、每块一次 HTTP 请求地拉取，一个视频几百次请求，且每块都要等一次往返，
 * 一旦网络抖动就落后 → 触发纠偏 → 缓冲作废 → 更卡。
 *
 * 分离音轨用 <source kind="audio">：B 站 DASH 音视频本就是两条流，
 * 播放器内部会自己管理两条流的时间轴，不需要我们再手工对齐。
 */
function setPlayerSources(videoUrl: string, audioUrl?: string): void {
  const el = playerRef.current;
  // 裸 src 会覆盖并隐藏 <source> 子节点，必须清掉。
  el.removeAttribute("src");
  const nodes: HTMLSourceElement[] = [];
  const v = document.createElement("source");
  v.setAttribute("src", videoUrl);
  v.setAttribute("type", "video/mp4");
  nodes.push(v);
  if (audioUrl) {
    const a = document.createElement("source");
    a.setAttribute("src", audioUrl);
    a.setAttribute("type", "audio/mp4");
    a.setAttribute("kind", "audio");
    nodes.push(a);
  }
  // 一次性替换：元素用 MutationObserver 监听 <source> 变化并自动重载，
  // 分批增删会被当成多次变更，因此这里合并成一次。
  el.replaceChildren(...nodes);
}

/** 缓冲/就绪/位置跟踪：同步纠偏据此避让，换源后据此自动续播。 */
function bindPlayerEvents(el: MoviElement): void {
  const buffering = (): void => {
    mediaBuffering = true;
  };
  el.addEventListener("waiting", buffering);
  el.addEventListener("stalled", buffering);
  el.addEventListener("seeking", buffering);
  el.addEventListener("timeupdate", () => {
    const ms = (el.currentTime || 0) * 1000;
    if (ms > 0) lastConfirmedPosMs = ms;
  });
  el.addEventListener("canplay", () => {
    mediaBuffering = false;
    // 换源/重载完成：恢复"应该播放"的状态，避免重载后停在暂停。
    if (wantPlay && el.paused) void el.play().catch(() => {});
  });
  el.addEventListener("playing", () => {
    mediaBuffering = false;
    playerReloading = false;
  });
  el.addEventListener("seeked", () => {
    mediaBuffering = false;
  });
}

/**
 * 直连可用性探测：mcdn 在部分网络/运营商不可达，失败则回落服务端反代。
 *
 * 只用「简单请求」探测：带 Range 头会触发跨域预检（OPTIONS），而 mcdn 不一定支持，
 * 会导致直连被误判为不可用、全部流量压回服务器。这里不带任何自定义头，读到响应头即取消。
 */
async function probeDirect(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
    res.body?.cancel().catch(() => {});
    return res.ok;
  } catch {
    return false;
  }
}

/** 按 grant 结果挑实际播放地址：直连优先（带宽走用户），失败回落反代。 */
async function applyGrant(info: GrantResponse): Promise<{ url: string; audioUrl?: string; direct: boolean }> {
  if (info.direct && info.fallbackUrl && !preferProxy) {
    if (await probeDirect(info.url)) return { url: info.url, audioUrl: info.audioUrl, direct: true };
    preferProxy = true;
    setStatus("B 站直连不可用，已切换到服务端代理（画质不变，占用服务器带宽）", true);
  }
  return {
    url: info.fallbackUrl ?? info.url,
    audioUrl: info.fallbackAudioUrl ?? info.audioUrl,
    direct: false,
  };
}

/** 匿名解析 B 站视频时的提示（绑定凭证后画质更高；凭证只存本浏览器）。 */
let biliHintShown = false;
function showBiliCredentialHint(): void {
  if (biliHintShown || loadBiliSessdata()) return;
  biliHintShown = true;
  const wrap = document.createElement("div");
  wrap.className = "modal";
  const card = document.createElement("div");
  card.className = "modal-card";
  card.setAttribute("role", "dialog");
  card.setAttribute("aria-modal", "true");
  card.setAttribute("aria-label", "B 站未绑定");
  const head = document.createElement("div");
  head.className = "modal-head";
  const title = document.createElement("h2");
  title.textContent = "未绑定 B 站账号，播放将受限制";
  head.appendChild(title);
  const body = document.createElement("div");
  body.className = "add-body";
  const hint = document.createElement("p");
  hint.className = "provider-hint";
  hint.textContent =
    "当前以匿名身份解析 B 站视频：画质上限 720P，番剧与会员内容可能无法播放。" +
    "绑定后凭证只保存在本浏览器，服务器不会保存，也不会共享给其他人。";
  const actions = document.createElement("div");
  actions.className = "row";
  const go = document.createElement("button");
  go.className = "primary";
  go.textContent = "去绑定 B 站账号";
  go.addEventListener("click", () => {
    location.href = "/settings.html";
  });
  const skip = document.createElement("button");
  skip.textContent = "继续观看（受限）";
  skip.addEventListener("click", () => wrap.remove());
  actions.append(go, skip);
  body.append(hint, actions);
  card.append(head, body);
  wrap.appendChild(card);
  wrap.addEventListener("click", (ev) => {
    if (ev.target === wrap) wrap.remove();
  });
  document.body.appendChild(wrap);
}

/** P3 受控媒体链路：mediaId →（成员令牌）→ 短期媒体地址。 */
async function fetchGrant(mediaId: string): Promise<GrantResponse> {
  const res = await fetch(`/api/rooms/${encodeURIComponent(roomId)}/media/${encodeURIComponent(mediaId)}/grant`, {
    // B 站凭证由本浏览器 localStorage 提供，服务端只在本次请求内使用。
    headers: { ...authHeaders, ...biliCredentialHeaders() },
  });
  if (!res.ok) {
    if (res.status === 401) {
      // 成员凭证过期：清理会话并回大厅。
      clearSession(roomId);
      location.replace(`/lobby.html?room=${encodeURIComponent(roomId)}&expired=1`);
    }
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(`媒体授权失败 HTTP ${res.status}: ${body.error ?? "未知错误"}`);
  }
  return (await res.json()) as GrantResponse;
}

/**
 * 换源后恢复播放位置与播放状态。
 *
 * 换源（`<source>` 变化）会让播放器整个重载并从 0 开始、处于暂停状态，
 * 因此必须做两件事：把位置落回去，并按"原本是否在播"决定是否继续播。
 * 重载是异步的，所以立即试一次，再在 loadedmetadata / canplay 各兜一次。
 */
function resumeAfterReload(posMs: number, shouldPlay: boolean): void {
  const el = playerRef.current;
  wantPlay = shouldPlay;
  let done = false;
  const apply = (): void => {
    if (done) return;
    done = true;
    markPlaybackEventSuppressed(1500);
    if (posMs > 0) el.currentTime = posMs / 1000;
    if (shouldPlay) {
      void el.play().catch(() => {
        gestureOverlay.classList.add("show");
      });
    }
  };
  apply();
  el.addEventListener("loadedmetadata", apply, { once: true });
  el.addEventListener("canplay", apply, { once: true });
}

/** 冷启动换源：切换视频/错误恢复共用。 */
function mountFreshPlayer(): void {
  const old = playerRef.current;
  const fresh = old.cloneNode(false) as HTMLElement;
  old.replaceWith(fresh);
  playerRef.current = fresh as unknown as MoviElement;
  playerRef.current.setAttribute("wasmurl", wasmUrl);
  if (showBuiltInControls) playerRef.current.setAttribute("controls", "");
  wireControlForwarding(playerRef.current);
  bindPlayerEvents(playerRef.current);
  // 播放错误（含签名 403/网络断）→ 用新凭证重建源并恢复到原位置（S12）。
  // 仅在已就绪且开始播放过才自动恢复；初始加载阶段的错误只提示不恢复。
  // 初始错误既有解码失败，也有源站/网络/跨域导致的拉流失败（两者在 error 事件里同形），按 movi 的 detail 区分提示。
  playerRef.current.addEventListener("error", (ev) => {
    if (!playerReady || !playerMediaId || recovering) return;
    if (!hasStartedPlayback) {
      const detail = (ev as CustomEvent<{ message?: string }>).detail;
      const reason = detail?.message ?? "";
      const networkLike = /fetch|network|http|range|timeout|failed|超时/i.test(reason);
      if (networkLike) {
        setMediaBadge("媒体加载失败", "fail");
        setStatus(`媒体加载失败（网络/源站/跨域错误${reason ? `：${reason.slice(0, 120)}` : ""}），请重试或更换视频`, true);
      } else {
        setMediaBadge("媒体解码失败", "fail");
        setStatus("媒体解码失败（初始载入阶段，非签名问题），请更换视频", true);
      }
      return;
    }
    recovering = true;
    // 直连失败（mcdn 端口被拦等）→ 本次会话改为走服务端反代后重试。
    if (currentSourceDirect) {
      preferProxy = true;
      setStatus("B 站直连失败，切换到服务端代理后重试…", true);
    } else {
      setStatus("媒体加载/播放出错（可能是签名过期），正在用新凭证恢复…", true);
    }
    setMediaBadge("媒体错误，正在恢复…", "fail");
    void recoverMedia().finally(() => {
      recovering = false;
    });
  });
  // 首次真实开始播放后，启用错误自动恢复门槛。
  playerRef.current.addEventListener("playing", () => {
    hasStartedPlayback = true;
  }, { once: false });
}

/** S12：签名/网络问题导致播放失败后，重新授权、重建源、跳回中断位置。 */
async function recoverMedia(): Promise<void> {
  if (!playerMediaId) return;
  try {
    const posMs = (playerRef.current.currentTime || 0) * 1000;
    const wasPaused = playerRef.current.paused;
    const info = await fetchGrant(playerMediaId);
    const src = await applyGrant(info);
    mountFreshPlayer();
    currentSourceDirect = src.direct;
    playerReloading = true;
    setPlayerSources(src.url, src.audioUrl);
    resumeAfterReload(posMs, !wasPaused);
    setMediaBadge(`就绪: ${info.name}`, "ok");
    setStatus(`已重新获取地址并恢复播放: ${info.name}（回到 ${fmtTime(posMs)}）`);
  } catch (err) {
    // 恢复失败：解除换源闸门，否则房主的播放/暂停将永远无法上报。
    playerReloading = false;
    setMediaBadge("媒体恢复失败", "fail");
    setStatus(`媒体恢复失败: ${err instanceof Error ? err.message : err}`, true);
  }
}

function makePlayerAdapter(): MediaAdapter {
  return {
    getTimeMs: () => (playerRef.current.currentTime || 0) * 1000,
    isPaused: () => playerRef.current.paused,
    getRate: () => playerRef.current.playbackRate || 1,
    play: () => {
      // 应用远端/本地同步状态：抑制随后的事件，避免回声广播。
      markPlaybackEventSuppressed(500);
      wantPlay = true;
      const el = playerRef.current;
      // 换源瞬间播放器还没就绪：交给 canplay 自动续播，
      // 否则 play() 会以"未加载"失败，被上层误判为"自动播放被拦截"而永久停用纠偏。
      if ((el.readyState ?? 4) < 2) return Promise.resolve();
      return el.play();
    },
    pause: () => {
      markPlaybackEventSuppressed(500);
      wantPlay = false;
      playerRef.current.pause();
    },
    seek: (ms) => {
      markPlaybackEventSuppressed(800);
      playerRef.current.currentTime = ms / 1000;
    },
    setRate: (r) => {
      markPlaybackEventSuppressed(500);
      playerRef.current.playbackRate = r;
    },
    hasMedia: () => playerReady,
    isBuffering: () => mediaBuffering,
    load: async (mediaId) => {
      setMediaBadge("加载中…", "loading");
      setStatus("正在获取媒体访问凭证…");
      const info = await fetchGrant(mediaId);
      const src = await applyGrant(info);
      mountFreshPlayer();
      currentSourceDirect = src.direct;
      // 换源期间屏蔽控件事件转发：重载自发的 pause/seek 不是用户操作。
      playerReloading = true;
      setPlayerSources(src.url, src.audioUrl);
      playerMediaId = mediaId;
      playerReady = true;
      hasStartedPlayback = false;
      lastConfirmedPosMs = 0;
      wantPlay = false;
      setMediaBadge(`就绪: ${info.name}`, "ok");
      setStatus(
        info.size > 0
          ? `已载入: ${info.name}（${(info.size / 1024 / 1024).toFixed(1)} MiB）`
          : `已载入: ${info.name}`,
      );
      if (info.anonymous) showBiliCredentialHint();
      refreshMediaList();
    },
  };
}

// ── UI 引用 ───────────────────────────────────────────────

const statusEl = $("#status");
const clockModeEl = $("#clockMode");
const playerWrapEl = $("#playerWrap");
const gestureOverlay = $("#gestureOverlay");

function setStatus(text: string, warn = false): void {
  statusEl.textContent = text;
  statusEl.className = warn ? "warn" : "";
}

function fmtTime(ms: number): string {
  const s = ms / 1000;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  const tenth = Math.floor((s % 1) * 10);
  return `${h > 0 ? `${h}:` : ""}${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}.${tenth}`;
}

/** 进度条等紧凑场景用：整秒，不带十分位。 */
function fmtTimeShort(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${h > 0 ? `${h}:` : ""}${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

// ── 初始化 ────────────────────────────────────────────────

const roomBadgeEl = $("#roomBadge");
roomBadgeEl.textContent = "房间 ";
const roomBadgeId = document.createElement("b");
roomBadgeId.textContent = roomId;
roomBadgeEl.appendChild(roomBadgeId);
if (mode === "clock") roomBadgeEl.appendChild(document.createTextNode(" · clock"));
const roleBadge = $("#roleBadge");
roleBadge.textContent = role === "host" ? "房主" : "观众";
roleBadge.className = `badge ${role}`;

let adapter: MediaAdapter;
let virtualClock: VirtualMediaClock | null = null;
if (mode === "clock") {
  const made = makeClockAdapter();
  adapter = made.adapter;
  virtualClock = made.clock;
  playerWrapEl.hidden = true;
} else {
  clockModeEl.hidden = true;
  playerWrapEl.hidden = false;
  adapter = makePlayerAdapter();
}

// 观众状态条
const viewerBarEl = $("#viewerBar") as HTMLElement;
const viewerBarText = $("#viewerBarText");
const viewerBarTime = $("#viewerBarTime");
if (role !== "host") {
  viewerBarEl.hidden = false;
  viewerBarText.textContent = "跟随房主";
}

// 邀请行：房主默认展开，可用顶栏按钮折叠。
// 创建时选择「不生成访问码」的房间没有邀请链接：隐藏邀请按钮，任何人凭房间号即可加入。
const inviteRowEl = $("#inviteRow") as HTMLElement;
const inviteToggleBtn = $("#inviteToggle") as HTMLElement;
inviteToggleBtn.addEventListener("click", () => inviteRowEl.classList.toggle("show"));

// 删除房间（仅房主可见按钮）：删除后房间立即消失，全员被踢回大厅。
if (role === "host") {
  const delBtn = $("#deleteRoomBtn") as HTMLButtonElement;
  delBtn.hidden = false;
  delBtn.addEventListener("click", () => {
    if (!window.confirm(`确认删除房间「${roomId}」？\n删除后不可恢复，房间内的所有成员将被请出。`)) return;
    void (async () => {
      try {
        const token = localUser?.token;
        if (!token) {
          setStatus("删除房间需要用创建房间的账户登录（右上角用户名处登录）", true);
          return;
        }
        const res = await fetch(`/api/rooms/${encodeURIComponent(roomId)}`, {
          method: "DELETE",
          headers: { Authorization: `Bearer ${token}` },
        });
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        if (!res.ok) {
          setStatus(`删除失败：${body.error ?? `HTTP ${res.status}`}`, true);
          return;
        }
        clearSession(roomId);
        sessionStorage.removeItem(`syncframe-invite-${roomId}`);
        sessionStorage.removeItem(`syncframe-hostsecret-${roomId}`);
        location.replace("/lobby.html");
      } catch (err) {
        setStatus(`删除失败：${err instanceof Error ? err.message : err}`, true);
      }
    })();
  });
}

// 旧版自定义控制条已由 movi-player 内置控件接管，保持隐藏（元素保留，tick/事件接线不变）。
if (role === "host") {
  // 邀请链接展示（仅创建者浏览器会话里有邀请码；链接 = 房间号 + 邀请码）
  const invite = sessionStorage.getItem(`syncframe-invite-${roomId}`);
  if (invite) {
    inviteRowEl.classList.add("show");    let currentInvite = invite;
    const inviteLinkEl = $("#inviteLink") as HTMLInputElement;
    const buildLink = (code: string): string =>
      `${location.origin}/lobby.html?room=${encodeURIComponent(roomId)}&key=${encodeURIComponent(code)}`;
    inviteLinkEl.value = buildLink(currentInvite);
    $("#copyInvite").addEventListener("click", async () => {
      const link = buildLink(currentInvite);
      try {
        await navigator.clipboard.writeText(link);
        setStatus("邀请链接已复制到剪贴板，直接发给朋友即可进房");
      } catch {
        inviteLinkEl.select();
        setStatus("无法访问剪贴板，链接已全选，请手动复制", true);
      }
    });
    $("#rotateInvite").addEventListener("click", () => {
      void (async () => {
        try {
          const res = await fetch(`/api/rooms/${encodeURIComponent(roomId)}/invite/rotate`, {
            method: "POST",
            headers: authHeaders,
          });
          const body = (await res.json().catch(() => ({}))) as { inviteCode?: string; error?: string };
          if (!res.ok || !body.inviteCode) {
            setStatus(`重置链接失败 HTTP ${res.status}: ${body.error ?? "未知错误"}`, true);
            return;
          }
          sessionStorage.setItem(`syncframe-invite-${roomId}`, body.inviteCode);
          currentInvite = body.inviteCode;
          inviteLinkEl.value = buildLink(body.inviteCode);
          setStatus("邀请链接已重置，旧链接立即失效");
        } catch (err) {
          setStatus(`重置链接失败: ${err instanceof Error ? err.message : err}`, true);
        }
      })();
    });
  } else {
    // 未生成访问码的房间：没有邀请链接，隐藏邀请入口（凭房间号即可加入）。
    inviteToggleBtn.hidden = true;
  }
}

const wsProto = location.protocol === "https:" ? "wss" : "ws";
const wsUrl = new URL(`${wsProto}://${location.host}/ws`);
wsUrl.searchParams.set("room", roomId);
// M3：成员令牌经 WebSocket 子协议传递（sf.token.<token>），URL 中不再出现令牌（防日志/Referer 泄漏）。
const wsProtocols = ["syncframe.v1", `sf.token.${memberToken}`];

const client = new SyncClient({
  wsUrl: wsUrl.toString(),
  wsProtocols,
  role,
  media: adapter,
  hardDriftMs,
  onStatus: (line) => setStatus(line),
  onClosedByServer: (code, reason) => {
    // 房间被房主/管理员删除（服务端 4003）：清掉本地会话并回大厅，不再重连。
    if (code === 4003) {
      clearSession(roomId);
      setStatus(`房间已被删除（${reason || "房间已被删除"}），即将返回大厅…`, true);
      window.setTimeout(() => location.replace("/lobby.html"), 1500);
    }
  },
  onRoster: (msg) => {
    viewerBarText.dataset.hostAway = msg.hostAway ? "1" : "0";
    const membersEl = $("#members");
    membersEl.textContent = "";
    let hostCount = 0;
    let guestCount = 0;
    for (const m of msg.members) {
      if (m.role === "host") hostCount++;
      else guestCount++;
      const chip = document.createElement("span");
      chip.className = "chip" + (m.id === clientId ? " me" : "");
      if (m.role === "host") {
        const crown = document.createElement("span");
        crown.className = "crown";
        crown.appendChild(iconElement("crown", "ic"));
        chip.appendChild(crown);
      }
      const chipName = document.createElement("span");
      chipName.textContent = m.name;
      chip.appendChild(chipName);
      if (m.id === clientId) {
        // 点击自己的昵称 → 账户设置页（provider 管理）。
        chip.title = "账户设置（provider 管理）";
        chip.addEventListener("click", () => {
          location.href = "/settings.html";
        });
      }
      membersEl.appendChild(chip);
    }
    // 右侧在线人数统计（同步用户 = 房主 + 游客）。
    $("#statTotal").textContent = String(hostCount + guestCount);
    $("#statHost").textContent = String(hostCount);
    $("#statGuest").textContent = String(guestCount);
  },
  onGestureNeeded: () => gestureOverlay.classList.add("show"),
  onStateApplied: (state) => {
    if (mode === "player" && state.mediaId) setMediaBadge(`就绪: ${state.mediaMeta?.name ?? state.mediaId}`, "ok");
  },
});

$("#joinPlay").addEventListener("click", () => {
  gestureOverlay.classList.remove("show");
  void client.resumeFromGesture();
});

// ── 房主控制：添加影片弹窗（直链 / B 站 / OpenList 媒体库 / OpenList 路径）────

const addMediaModal = $("#addMediaModal") as HTMLElement;
const addMediaMsg = $("#addMediaMsg");

function setAddMsg(text: string, ok = false): void {
  addMediaMsg.textContent = text;
  addMediaMsg.className = ok ? "ok" : "";
}

if (mode === "player" && role === "host") {
  ($("#addMediaBtn") as HTMLElement).hidden = false;

  // 弹窗开关与页签切换
  $("#addMediaBtn").addEventListener("click", () => {
    addMediaModal.hidden = false;
    setAddMsg("");
  });
  $("#addMediaClose").addEventListener("click", () => (addMediaModal.hidden = true));
  addMediaModal.addEventListener("click", (e) => {
    if (e.target === addMediaModal) addMediaModal.hidden = true;
  });
  $("#addMediaTabs").addEventListener("click", (e) => {
    const tab = (e.target as HTMLElement).closest("[data-tab]") as HTMLElement | null;
    if (!tab) return;
    for (const t of addMediaModal.querySelectorAll<HTMLElement>(".tab")) t.classList.toggle("active", t === tab);
    for (const pane of addMediaModal.querySelectorAll<HTMLElement>("[data-pane]")) {
      pane.hidden = pane.dataset.pane !== tab.dataset.tab;
    }
  });
  $("#addMediaSettings").addEventListener("click", () => {
    location.href = "/settings.html";
  });

  /** 注册媒体进播放列表（共用：直链 / B 站 / 路径）。 */
  async function registerMedia(payload: Record<string, unknown>): Promise<void> {
    setAddMsg("正在添加…");
    try {
      const res = await fetch(`/api/rooms/${encodeURIComponent(roomId)}/media`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...authHeaders,
          ...(localUser ? { "X-User-Token": localUser.token } : {}),
          // B 站条目：凭证随请求一次性传入（服务端即用即弃），番剧解析也需要。
          ...biliCredentialHeaders(),
        },
        body: JSON.stringify(payload),
      });
      const body = (await res.json().catch(() => ({}))) as {
        mediaId?: string;
        name?: string;
        error?: string;
      };
      if (!res.ok || !body.mediaId) {
        setAddMsg(`添加失败 HTTP ${res.status}: ${body.error ?? "未知错误"}`);
        return;
      }
      setAddMsg(`已添加: ${body.name}（点播放列表条目开播）`, true);
      await refreshMediaList();
    } catch (err) {
      setAddMsg(`添加失败: ${err instanceof Error ? err.message : err}`);
    }
  }

  // 直链
  $("#addDirectBtn").addEventListener("click", () => {
    const name = ($("#addName") as HTMLInputElement).value.trim();
    const url = ($("#addUrl") as HTMLInputElement).value.trim();
    if (!url) {
      setAddMsg("请填写直链视频地址");
      return;
    }
    void registerMedia({ provider: "direct", name, url }).then(() => {
      ($("#addUrl") as HTMLInputElement).value = "";
    });
  });

  // B 站：凭证由本浏览器提供（未绑定则匿名），服务端即用即弃
  $("#addBiliBtn").addEventListener("click", () => {
    const provider = ($("#biliProviderSel") as HTMLSelectElement).value || "bilibili";
    const url = ($("#addBiliUrl") as HTMLInputElement).value.trim();
    if (!url) {
      setAddMsg("请填写 BV 号 / av 号 / 视频或番剧链接（番剧建议先扫码绑定 B 站）");
      return;
    }
    void registerMedia({ provider, url }).then(() => {
      ($("#addBiliUrl") as HTMLInputElement).value = "";
    });
  });

  // OpenList 路径（手动填路径）
  $("#addPathBtn").addEventListener("click", () => {
    const value = ($("#addProvider") as HTMLSelectElement).value;
    const path = ($("#addPath") as HTMLInputElement).value.trim();
    if (!value) {
      setAddMsg("请选择 OpenList provider（在账户设置中添加）");
      return;
    }
    if (!path) {
      setAddMsg("请填写 OpenList 文件路径");
      return;
    }
    void registerMedia({ provider: value, path }).then(() => {
      ($("#addPath") as HTMLInputElement).value = "";
    });
  });

  // 拉取本人 provider：填充 B 站来源 / OpenList provider 下拉，并按需挂载媒体库浏览。
  void (async () => {
    const providers = await fetchMyProviders();
    // B 站凭证由本浏览器提供；服务端不再区分 provider，下拉只反映本地绑定状态。
    const biliSel = $("#biliProviderSel") as HTMLSelectElement;
    biliSel.textContent = "";
    const optBili = document.createElement("option");
    optBili.value = "bilibili";
    optBili.textContent = loadBiliSessdata() ? "使用本浏览器绑定的 B 站账号" : "匿名（未绑定，画质上限 480P）";
    biliSel.appendChild(optBili);
    if (!loadBiliSessdata()) {
      const hint = document.createElement("option");
      hint.value = "";
      hint.disabled = true;
      hint.textContent = "（扫码绑定后画质更高：账户设置 → 哔哩哔哩）";
      biliSel.appendChild(hint);
    }
    const pathSel = $("#addProvider") as HTMLSelectElement;
    pathSel.textContent = "";
    const browseSel = $("#browseProvider") as HTMLSelectElement;
    browseSel.textContent = "";

    const openlist = providers.filter((p) => p.kind === "openlist");
    for (const p of providers.filter((x) => x.kind === "bilibili")) {
      const o = document.createElement("option");
      o.value = `bilibili:${p.id}`;
      o.textContent = `${p.label}（使用本浏览器 B 站凭证）`;
      biliSel.appendChild(o);
    }
    for (const p of openlist) {
      const o = document.createElement("option");
      o.value = p.id;
      o.textContent = `${p.label}（${p.baseUrl}）`;
      pathSel.appendChild(o);
      const ob = document.createElement("option");
      ob.value = p.id;
      ob.textContent = `${p.label}（${p.baseUrl}）`;
      browseSel.appendChild(ob);
    }
    if (!localUser) {
      const hint = document.createElement("option");
      hint.value = "";
      hint.disabled = true;
      hint.textContent = "（登录后可配置更多 provider）";
      pathSel.appendChild(hint);
    }
    if (openlist.length === 0) {
      // 没有 OpenList provider：隐藏媒体库/路径页签（仍可用直链 / B 站）。
      setStatus("未配置 OpenList provider：可点「添加影片」用直链或 B 站链接（登录后也可在账户设置配置 OpenList）", true);
      return;
    }
    ($("#tabOpenlist") as HTMLElement).hidden = false;
    ($("#tabPath") as HTMLElement).hidden = false;
    const browse = initBrowsePanel({
      roomId,
      getToken: () => memberToken,
      getUserToken: () => localUser?.token ?? null,
      getProviderId: () => browseSel.value,
      onStatus: (line, warn) => {
        setStatus(line, warn);
        if (!warn) setAddMsg(line, false);
      },
      onPick: (file) => {
        void (async () => {
          setAddMsg(`正在添加: ${file.name}…`);
          try {
            const res = await fetch(`/api/rooms/${encodeURIComponent(roomId)}/media`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                ...authHeaders,
                ...(localUser ? { "X-User-Token": localUser.token } : {}),
              },
              body: JSON.stringify({ provider: browseSel.value, path: file.path }),
            });
            const body = (await res.json().catch(() => ({}))) as {
              mediaId?: string;
              name?: string;
              size?: number;
              related?: { mediaId: string; name: string }[];
              error?: string;
            };
            if (!res.ok || !body.mediaId) {
              setAddMsg(`添加视频失败 HTTP ${res.status}: ${body.error ?? "未知错误"}`);
              return;
            }
            setAddMsg(`已注册 ${body.name}（外挂字幕 ${body.related?.length ?? 0} 个）`, true);
            await client.hostLoad(body.mediaId, { name: body.name ?? file.name, size: body.size ?? file.size });
            refreshMediaList();
          } catch (err) {
            setAddMsg(`添加视频失败: ${err instanceof Error ? err.message : err}`);
          }
        })();
      },
    });
    browseSel.addEventListener("change", () => browse.reload());
  })();
}

if (mode === "player") {
  wireControlForwarding(playerRef.current);
  bindPlayerEvents(playerRef.current);
}

// ── 播放列表（mediaId 不透明映射 + 字幕授权验证入口）────────────────────

interface MediaListItem {
  mediaId: string;
  name: string;
  size: number;
  kind: "video" | "subtitle";
  provider?: string;
}

async function refreshMediaList(): Promise<void> {
  if (mode !== "player") return;
  try {
    const res = await fetch(`/api/rooms/${encodeURIComponent(roomId)}/media`, { headers: authHeaders });
    if (!res.ok) return;
    const body = (await res.json()) as { media?: MediaListItem[] };
    const listEl = $("#mediaList");
    listEl.textContent = "";
    const items = body.media ?? [];
    if (items.length === 0) {
      const d = document.createElement("div");
      d.className = "browse-empty";
      d.textContent = role === "host" ? "（播放列表为空，点右上角「＋ 添加影片」）" : "（等待房主添加视频）";
      listEl.appendChild(d);
      return;
    }
    const currentId = client.sample().appliedMediaId;
    for (const item of items) {
      const row = document.createElement("div");
      row.className = "browse-row";
      const kind = document.createElement("span");
      kind.className = "media-kind";
      kind.textContent = item.kind === "subtitle" ? "字幕" : "视频";
      row.appendChild(kind);
      if (item.provider) {
        const prov = document.createElement("span");
        prov.className = "media-provider";
        prov.textContent = item.provider;
        prov.title = "来源 provider";
        row.appendChild(prov);
      }
      const nameEl = document.createElement("span");
      nameEl.className = "browse-name";
      nameEl.textContent = item.name;
      row.appendChild(nameEl);
      if (item.kind === "subtitle") {
        // P3 任务 8：外挂字幕走与视频完全一致的授权路径，点击验证 grant 可达。
        const btn = document.createElement("button");
        btn.className = "browse-pick";
        btn.textContent = "验证授权";
        btn.addEventListener("click", () => {
          void (async () => {
            try {
              const g = await fetchGrant(item.mediaId);
              // OpenList/反代地址为同源相对路径，B 站为绝对地址：都按当前源解析。
              const u = new URL(g.url, location.origin);
              setStatus(`字幕授权 OK：${item.name}（${u.origin}${u.pathname.slice(0, 24)}…，凭证 ${g.expiresInSec / 60} 分钟）`);
            } catch (err) {
              setStatus(`字幕授权失败: ${err instanceof Error ? err.message : err}`, true);
            }
          })();
        });
        row.appendChild(btn);
        if (role === "host") row.appendChild(makeDeleteBtn(item));
      } else if (role === "host") {
        // 房主点击播放列表条目即切换播放（已注册的 mediaId 直接广播 load）。
        row.classList.add("video-row");
        if (item.mediaId === currentId) row.classList.add("current");
        const play = document.createElement("button");
        play.className = "browse-pick";
        play.textContent = item.mediaId === currentId ? "播放中" : "播放";
        play.addEventListener("click", (e) => {
          e.stopPropagation();
          void client.hostLoad(item.mediaId, { name: item.name, size: item.size });
        });
        row.addEventListener("click", () => void client.hostLoad(item.mediaId, { name: item.name, size: item.size }));
        row.appendChild(play);
        row.appendChild(makeDeleteBtn(item));
      }
      listEl.appendChild(row);
    }
  } catch {
    /* 清单刷新失败不阻塞主流程 */
  }
}

/** 房主专用的列表删除按钮：确认后调服务端移除并刷新列表。 */
function makeDeleteBtn(item: MediaListItem): HTMLButtonElement {
  const del = document.createElement("button");
  del.className = "browse-pick";
  del.textContent = "删除";
  del.title = "从播放列表移除";
  del.addEventListener("click", (e) => {
    e.stopPropagation();
    if (!window.confirm(`确定从播放列表删除「${item.name}」吗？`)) return;
    void (async () => {
      try {
        const res = await fetch(`/api/rooms/${encodeURIComponent(roomId)}/media/${encodeURIComponent(item.mediaId)}`, {
          method: "DELETE",
          headers: authHeaders,
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { error?: string } | null;
          setStatus(`删除失败: ${body?.error ?? res.status}`, true);
          return;
        }
        setStatus(`已删除: ${item.name}`);
        await refreshMediaList();
      } catch (err) {
        setStatus(`删除失败: ${err instanceof Error ? err.message : err}`, true);
      }
    })();
  });
  return del;
}

// ── HUD / 采样 ────────────────────────────────────────────

function tick(): void {
  const stats = client.sample();
  const state = client.currentRoomState();

  if (virtualClock) {
    $("#clockFace").textContent = fmtTime(stats.clientTimeMs);
    $("#clockSub").textContent =
      `${stats.role === "host" ? "你是房主（权威）" : "跟随房主"} · ` +
      `${state?.paused === false ? "播放中" : "已暂停"} · ${state?.rate ?? 1}×`;
  }
  // player 模式：时间与进度由 movi-player 内置控件呈现，无需同步到自定义 DOM。
  // B 站分离音轨由播放器内部的 <source kind="audio"> 自行对齐，这里不做任何手工同步。

  // 连接徽标 + 观众状态条
  const connBadge = $("#connBadge");
  connBadge.textContent = !stats.connected ? "重连中…" : state ? (stats.role === "viewer" && state.paused ? "已暂停" : "已连接") : "已连接";
  connBadge.className = `badge conn${stats.connected ? "" : " off"}`;
  if (role !== "host") {
    const hostAway = viewerBarText.dataset.hostAway === "1";
    viewerBarEl.classList.toggle("paused", state?.paused !== false);
    viewerBarText.textContent =
      !stats.connected ? "连接断开，重连中…" :
      hostAway ? "房主暂时离开，房间已暂停" :
      state?.paused === false ? `跟随房主 · 播放中 · ${state?.rate ?? 1}×` : "跟随房主 · 已暂停";
    viewerBarTime.textContent = fmtTimeShort(stats.clientTimeMs);
  }
}

// ── 启动 ──────────────────────────────────────────────────

// 测试句柄：多浏览器同步测试（tests/sync/sync-browser-test.ts）从这里读取漂移等指标。
(window as unknown as { __sync: unknown }).__sync = {
  sample: () => client.sample(),
  state: () => client.currentRoomState(),
  hostLoad: (p: string) => client.hostLoad(p, { name: p.split("/").pop() ?? p }),
  hostPlay: () => client.hostPlay(),
  hostPause: () => client.hostPause(),
  hostSeek: (ms: number) => client.hostSeek(ms),
  hostRate: (r: number) => client.hostRate(r),
  mediaTimeMs: () => adapter.getTimeMs(),
};

client.connect();
window.addEventListener("pagehide", () => client.disconnect());
window.setInterval(tick, 1000);
// 不再定时换票：票据有效期 12h，B 站 CDN 地址约 2h；到期由 error → recoverMedia 处理。
// 定时换源会让播放器重载、位置归零并暂停，是"播一会儿跳回开头"的根因。
if (mode === "player") window.setInterval(() => void refreshMediaList(), 15_000);
void refreshMediaList();
void tick();
