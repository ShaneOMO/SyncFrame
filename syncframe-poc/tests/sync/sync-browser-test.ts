/**
 * P2 多浏览器同步测试：Playwright 三个独立浏览器上下文（1 房主 + 2 观众），
 * 走真实 WebSocket（经 Vite 代理）+ 浏览器环境（真实定时器、真实事件循环）。
 *
 * 与 sync-sim-test 的差异：SyncClient 跑在真实浏览器里，时钟估算受真实
 * 事件循环/定时器影响；媒体仍是 clock 模式（VirtualMediaClock 在页面内运行），
 * 真实播放器链路由 P1 验证 + 人工双设备验收覆盖。
 *
 * 运行：
 *   node --import tsx tests/sync/sync-browser-test.ts           # LAN
 *   SYNC_SIM_RTT=100 node --import tsx tests/sync/sync-browser-test.ts
 *
 * 需要系统已安装 Chrome 或 Edge（playwright-core 复用系统浏览器，不下载）。
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createRoom, joinRoom, type CreatedRoom, type RoomMember } from "../p3/room-api.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const BACKEND_PORT = 8899;
const WEB_PORT = 5199;
const RTT = Number(process.env.SYNC_SIM_RTT ?? 0);
let ROOM = "";

let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  console.log(`  [${cond ? "PASS" : "FAIL"}] ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
}
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

// ── 子进程：后端 + Vite ───────────────────────────────────

const children: ChildProcess[] = [];
function spawnLogged(cmd: string, args: string[], opts: Parameters<typeof spawn>[2]): ChildProcess {
  const p = spawn(cmd, args, { ...opts, stdio: ["ignore", "pipe", "pipe"] });
  p.stdout?.on("data", () => {});
  p.stderr?.on("data", (d) => process.stderr.write(d));
  children.push(p);
  return p;
}

async function waitHttp(url: string, timeoutMs = 20_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }
  throw new Error(`等待超时: ${url}`);
}

// ── 页面句柄 ──────────────────────────────────────────────

interface PageHandle {
  name: string;
  page: import("playwright-core").Page;
}

/** P3 鉴权：先把成员会话写进 sessionStorage，房间页加载时据此连 WS（与大厅页同路径）。 */
async function openClient(
  browser: import("playwright-core").Browser,
  name: string,
  role: "host" | "viewer",
  roomId: string,
  member: { memberToken: string; clientId: string; expiresAt: number },
): Promise<PageHandle> {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await ctx.addInitScript(
    ([sess]) => {
      sessionStorage.setItem(`syncframe-session-${sess.roomId}`, JSON.stringify(sess));
    },
    [{ roomId, memberToken: member.memberToken, clientId: member.clientId, role, name, expiresAt: member.expiresAt }],
  );
  const page = await ctx.newPage();
  const url = `http://localhost:${WEB_PORT}/room.html?room=${roomId}&name=${encodeURIComponent(name)}&mode=clock`;
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => {
    const s = (window as unknown as { __sync?: { sample: () => { connected: boolean } } }).__sync;
    return s && s.sample().connected;
  }, { timeout: 15_000 });
  return { name, page };
}

async function sampleDrift(h: PageHandle): Promise<number | null> {
  return h.page.evaluate(() => {
    const s = (window as unknown as { __sync: { sample: () => { driftMs: number | null } } }).__sync;
    return s.sample().driftMs;
  });
}

async function mediaTime(h: PageHandle): Promise<number> {
  return h.page.evaluate(() => {
    const s = (window as unknown as { __sync: { mediaTimeMs: () => number } }).__sync;
    return s.mediaTimeMs();
  });
}

async function hostAction(h: PageHandle, action: "hostLoad" | "hostPlay" | "hostPause" | "hostSeek" | "hostRate", arg?: string | number): Promise<void> {
  await h.page.evaluate(
    ([a, x]) => {
      const s = (window as unknown as {
        __sync: Record<string, (v?: string | number) => Promise<void> | void>;
      }).__sync;
      return s[a](x);
    },
    [action, arg] as const,
  );
}

// ── 主流程 ────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(`\n=== P2 多浏览器同步测试（RTT 仿真 ${RTT}ms）===\n`);

  spawnLogged(process.execPath, ["--import", "tsx", "apps/server/src/index.ts"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      SERVER_PORT: String(BACKEND_PORT),
      SYNC_BACKEND_PORT: String(BACKEND_PORT),
      SYNC_INJECT_LATENCY_MS: RTT > 0 ? String(RTT / 2) : "0",
      SYNC_INJECT_JITTER_MS: RTT > 0 ? "30" : "0",
    },
  });
  spawnLogged(process.execPath, [path.join(repoRoot, "node_modules/vite/bin/vite.js"), "--port", String(WEB_PORT), "--strictPort"], {
    cwd: path.join(repoRoot, "apps/web"),
    env: { ...process.env, SYNC_BACKEND_PORT: String(BACKEND_PORT) },
  });
  await waitHttp(`http://localhost:${BACKEND_PORT}/api/health`);
  await waitHttp(`http://localhost:${WEB_PORT}/room.html`);
  console.log("后端 + Vite 已就绪");

  // P3：创建房间，房主 + 观众均经 /join 拿成员令牌（浏览器页凭会话存储入场）
  const backendBase = `http://localhost:${BACKEND_PORT}`;
  const created = (await createRoom(backendBase, "Host")).data as CreatedRoom;
  ROOM = created.roomId;
  const joinViewer = async (name: string): Promise<RoomMember> => {
    const res = await joinRoom(backendBase, ROOM, name, created.inviteCode);
    if (res.status !== 200) throw new Error(`观众加入失败: ${JSON.stringify(res.data)}`);
    return res.data;
  };
  console.log(`房间 ${ROOM} 已建立（P3 鉴权流程）`);

  const executablePath = [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  ].find((p) => existsSync(p));
  if (!executablePath) throw new Error("未找到系统 Chrome/Edge");

  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    const host = await openClient(browser, "Host", "host", ROOM, created);
    const v1m = await joinViewer("V1");
    const v2m = await joinViewer("V2");
    const v1 = await openClient(browser, "V1", "viewer", ROOM, v1m);
    const v2 = await openClient(browser, "V2", "viewer", ROOM, v2m);
    console.log("3 个浏览器上下文已入房");

    // 观众控制面板必须隐藏（S13 UI 侧）
    for (const [h, expectHidden] of [[v1, true], [v2, true]] as const) {
      const hidden = await h.page.locator("#hostControls").isHidden();
      check(`${h.name} 无控制面板`, hidden === expectHidden);
    }

    console.log("— S01 播放/暂停 —");
    await hostAction(host, "hostLoad", "/movies/a.mkv");
    await sleep(800);
    await hostAction(host, "hostPlay");
    const played = async () => {
      await sleep(1500);
      const [t1, t2, th] = await Promise.all([mediaTime(v1), mediaTime(v2), mediaTime(host)]);
      return { t1, t2, th };
    };
    const p1 = await played();
    check("S01 观众跟随播放（时间推进）", p1.t1 > 500 && p1.t2 > 500, `v1=${Math.round(p1.t1)} v2=${Math.round(p1.t2)} host=${Math.round(p1.th)}`);
    check("S01 双观众与房主位置差 <1s", Math.abs(p1.t1 - p1.th) < 1000 && Math.abs(p1.t2 - p1.th) < 1000);

    await hostAction(host, "hostPause");
    await sleep(800);
    const afterPause = await mediaTime(v1);
    await sleep(1000);
    const afterPause2 = await mediaTime(v1);
    check("S01 暂停传播（观众停止推进）", Math.abs(afterPause2 - afterPause) < 50, `Δ=${Math.round(afterPause2 - afterPause)}ms`);

    console.log("— S02 seek —");
    await hostAction(host, "hostSeek", 200_000);
    await hostAction(host, "hostPlay");
    check("S02 观众 2s 内收敛到 seek 目标（±1.5s）", await (async () => {
      const start = Date.now();
      while (Date.now() - start < 2000) {
        const [t1, t2] = await Promise.all([mediaTime(v1), mediaTime(v2)]);
        if (Math.abs(t1 - 200_000) < 1500 && Math.abs(t2 - 200_000) < 1500) return true;
        await sleep(100);
      }
      return false;
    })());

    console.log("— S08 自动播放拦截（观众冷启动 play 被拦则提示手势）—");
    // 观众端模拟：新开一个上下文加入（浏览器自动播放策略对有声播放需手势；
    // clock 模式不触发真实自动播放限制，这里仅验证手势覆盖层机制存在）。
    const hasOverlay = await v1.page.locator("#gestureOverlay").count() === 1;
    check("S08 手势覆盖层组件存在", hasOverlay);

    console.log("— S05 迟到加入 —");
    const v3m = await joinViewer("V3");
    const v3 = await openClient(browser, "V3", "viewer", ROOM, v3m);
    await sleep(2500);
    const t3 = await mediaTime(v3);
    check("S05 新观众落在播放位置（±1.5s）", Math.abs(t3 - 200_000 - 2500) < 1500, `v3=${Math.round(t3)}`);

    console.log(`— T-sync 稳态漂移采样（15s × 3 观众）—`);
    const driftSamples: number[] = [];
    const rtts: number[] = [];
    for (let i = 0; i < 15; i++) {
      await sleep(1000);
      for (const h of [v1, v2, v3]) {
        const d = await sampleDrift(h);
        if (d !== null) driftSamples.push(Math.abs(d));
      }
      const st = await host.page.evaluate(() => (window as unknown as { __sync: { sample: () => { bestRttMs: number } } }).__sync.sample());
      rtts.push(st.bestRttMs);
    }
    driftSamples.sort((a, b) => a - b);
    const p50 = percentile(driftSamples, 50);
    const p95 = percentile(driftSamples, 95);
    const max = driftSamples[driftSamples.length - 1] ?? NaN;
    const limit = RTT > 0 ? 1500 : 1000;
    check(`T-sync |drift| P95 ≤ ${limit}ms`, p95 <= limit, `P50=${Math.round(p50)} P95=${Math.round(p95)} max=${Math.round(max)} n=${driftSamples.length}`);
    check(`时钟估算 RTT 与注入一致（${RTT}ms 场景）`, RTT === 0 || Math.abs(Math.max(...rtts) - RTT) < 80, `bestRtt=${Math.round(Math.max(...rtts))}`);

    const recDir = path.join(repoRoot, "reports/sync-raw");
    await mkdir(recDir, { recursive: true });
    const record = {
      scenario: "sync-browser",
      simulatedRttMs: RTT,
      room: ROOM,
      finishedAt: new Date().toISOString(),
      limits: { p95Ms: limit },
      result: {
        sampleCount: driftSamples.length,
        p50Ms: Math.round(p50),
        p95Ms: Math.round(p95),
        maxMs: Math.round(max),
        clockBestRttMs: Math.round(Math.max(...rtts)),
      },
    };
    const file = path.join(recDir, `sync-browser-rtt${RTT}-${Date.now()}.json`);
    await writeFile(file, JSON.stringify(record, null, 2), "utf-8");
    console.log(`\n原始记录已写入: ${path.relative(repoRoot, file)}`);
  } finally {
    await browser.close().catch(() => {});
    for (const c of children) c.kill();
  }

  console.log(failures === 0 ? "\n全部通过 ✔" : `\n${failures} 项失败 ✘`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  for (const c of children) c.kill();
  process.exit(1);
});
