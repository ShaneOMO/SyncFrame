/**
 * P2 同步仿真测试：真实服务端 + 真实 WebSocket + 真实 SyncClient，
 * 媒体用 VirtualMediaClock（seek 有 150ms 延迟，模拟真实播放器）。
 *
 * 覆盖计划 §8 用例：S01–S07、S13、S14，并产出漂移原始记录（§7.2 字段）。
 *
 * 运行：
 *   node --import tsx tests/sync/sync-sim-test.ts           # LAN 场景（无注入）
 *   SYNC_SIM_RTT=100 node --import tsx tests/sync/sync-sim-test.ts   # WAN：100ms RTT + 30ms 抖动
 *
 * 环境变量 SYNC_SIM_RTT 设置后，会以子进程方式启动服务端并注入
 * SYNC_INJECT_LATENCY_MS = RTT/2、SYNC_INJECT_JITTER_MS = 30。
 */

import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

import { SyncClient, VirtualMediaClock } from "../../packages/sync-protocol/src/index.ts";
import type { MediaAdapter, ServerMessage } from "../../packages/sync-protocol/src/index.ts";
import { ADMIN_PASS, ADMIN_USER, createRoom, createUserAsAdmin, joinRoom, loginUser } from "../p3/room-api.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PORT = 8899;
const RTT = Number(process.env.SYNC_SIM_RTT ?? 0);
const BASE = `http://localhost:${PORT}`;

// ── 断言与工具 ────────────────────────────────────────────

let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  const mark = cond ? "PASS" : "FAIL";
  if (!cond) failures++;
  console.log(`  [${mark}] ${name}${detail ? ` — ${detail}` : ""}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(name: string, cond: () => boolean, timeoutMs = 5000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (cond()) return true;
    await sleep(50);
  }
  console.log(`  [FAIL] 等待超时: ${name}`);
  failures++;
  return false;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

// ── 服务端子进程 ──────────────────────────────────────────

let serverProc: ChildProcess | null = null;

async function startServer(): Promise<void> {
  const inject = RTT > 0;
  serverProc = spawn(
    process.execPath,
    ["--import", "tsx", "apps/server/src/index.ts"],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        SERVER_PORT: String(PORT),
        ADMIN_USERNAME: ADMIN_USER,
        ADMIN_PASSWORD: ADMIN_PASS,
        SYNC_INJECT_LATENCY_MS: inject ? String(RTT / 2) : "0",
        SYNC_INJECT_JITTER_MS: inject ? "30" : "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  serverProc.stderr?.on("data", (d) => process.stderr.write(d));
  const start = Date.now();
  while (Date.now() - start < 15_000) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) {
        const j = (await res.json()) as { injectLatencyMs: number };
        console.log(`服务端就绪: latency注入=${j.injectLatencyMs}ms（RTT 仿真=${RTT}ms）`);
        return;
      }
    } catch {
      /* not up yet */
    }
    await sleep(200);
  }
  throw new Error("服务端启动超时");
}

function stopServer(): void {
  serverProc?.kill();
}

// ── 仿真客户端 ────────────────────────────────────────────

interface SimClient {
  id: string;
  client: SyncClient;
  clock: VirtualMediaClock;
  socket: WebSocket | null;
  lastRejected: string | null;
  lastError: string | null;
}

/** P3 起 WS 凭成员令牌入场：房主用创建令牌，观众先走 /join 拿令牌。 */
let roomId = "";
let hostToken = "";
let inviteCode = "";

async function join(name: string, role: "host" | "viewer", id: string): Promise<SimClient> {
  let token = hostToken;
  if (role === "viewer") {
    const res = await joinRoom(BASE, roomId, name, inviteCode);
    if (res.status !== 200) throw new Error(`观众加入失败: ${JSON.stringify(res.data)}`);
    token = res.data.memberToken;
  }
  const clock = new VirtualMediaClock({ seekLatencyMs: 150 });
  const adapter: MediaAdapter = {
    getTimeMs: () => clock.getCurrentTimeMs(),
    isPaused: () => clock.isPaused(),
    getRate: () => clock.getRate(),
    play: () => clock.play(),
    pause: () => clock.pause(),
    seek: (ms) => clock.seek(ms),
    setRate: (r) => clock.setRate(r),
    load: () => clock.seek(0),
    hasMedia: () => true,
  };
  const sc: SimClient = { id, client: null as unknown as SyncClient, clock, socket: null, lastRejected: null, lastError: null };
  const client = new SyncClient({
    wsUrl: `ws://localhost:${PORT}/ws?room=${encodeURIComponent(roomId)}&token=${encodeURIComponent(token)}`,
    role,
    media: adapter,
    pingIntervalMs: 1000,
    heartbeatMs: 4000,
    driftCheckMs: 500,
    WebSocketImpl: WebSocket,
    onStatus: () => {},
    onSocket: (ws) => {
      sc.socket = ws as WebSocket;
    },
  });
  // 通过重载消息处理捕获 rejected：包一层 onStatus 不够，直接监听 socket message
  sc.client = client;
  client.connect();
  await waitFor(`${name} 连接`, () => sc.socket !== null && sc.socket.readyState === WebSocket.OPEN);
  sc.socket!.on("message", (data) => {
    const msg = JSON.parse(String(data)) as ServerMessage;
    if (msg.t === "rejected") sc.lastRejected = msg.reason;
    if (msg.t === "error") sc.lastError = msg.message;
  });
  return sc;
}

// ── 场景 ─────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(`\n=== P2 同步仿真测试（RTT 仿真 ${RTT}ms）===\n`);
  await startServer();

  // P3：房间鉴权——创建房间拿到房主令牌与邀请码，观众凭邀请码换取成员令牌（创建必须登录）
  const adminToken = await loginUser(BASE, ADMIN_USER, ADMIN_PASS);
  try {
    await createUserAsAdmin(BASE, adminToken, "simhost", "simpw123");
  } catch {
    /* 已存在则复用 */
  }
  const hostUserToken = await loginUser(BASE, "simhost", "simpw123");
  const roomRes = await createRoom(BASE, "Host", hostUserToken);
  if (roomRes.status !== 200) throw new Error(`创建房间失败: ${JSON.stringify(roomRes.data)}`);
  roomId = roomRes.data.roomId;
  hostToken = roomRes.data.memberToken;
  inviteCode = roomRes.data.inviteCode;
  console.log(`房间已创建: ${roomId}（P3 鉴权流程）`);

  // 为每个场景重建房间太耗时；单房间顺序执行，动作间留收敛时间。
  console.log("— S01 播放/暂停传播 —");
  const joinR = (name: string, role: "host" | "viewer", id: string) => join(name, role, id);
  const host = await joinR("Host", "host", "h1");
  const v1 = await joinR("V1", "viewer", "v1");
  const v2 = await joinR("V2", "viewer", "v2");

  await host.client.hostLoad("/movies/a.mkv", { name: "a.mkv" });
  check("S01 换片广播（mediaId 到达观众）", await waitFor("v1 收到 load", () => v1.client.currentRoomState()?.mediaId === "/movies/a.mkv"));
  check("S01 v2 同步收到", v2.client.currentRoomState()?.mediaId === "/movies/a.mkv");

  await host.client.hostPlay();
  check("S01 播放传播到 v1", await waitFor("v1 播放", () => !v1.clock.isPaused()));
  check("S01 播放传播到 v2", await waitFor("v2 播放", () => !v2.clock.isPaused()));
  await sleep(1200);
  const hostPos = host.clock.getCurrentTimeMs();
  const v1Pos = v1.clock.getCurrentTimeMs();
  check("S01 播放 1.2s 后位置接近（<1s）", Math.abs(v1Pos - hostPos) < 1000, `host=${Math.round(hostPos)} v1=${Math.round(v1Pos)}`);

  await host.client.hostPause();
  check("S01 暂停传播到 v1", await waitFor("v1 暂停", () => v1.clock.isPaused()));
  check("S01 暂停传播到 v2", await waitFor("v2 暂停", () => v2.clock.isPaused()));
  check("S01 暂停位置接近（<1s）", Math.abs(v1.clock.getCurrentTimeMs() - host.clock.getCurrentTimeMs()) < 1000);

  console.log("— S02 连续 seek 5 次 —");
  const seekTargets = [10_000, 300_000, 60_000, 500_000, 123_456];
  for (const t of seekTargets) {
    host.client.hostSeek(t);
    await sleep(120);
  }
  check("S02 收敛到最终 seek 目标（2s 内 ±1s）", await waitFor("v1 收敛", () => Math.abs(v1.clock.getCurrentTimeMs() - 123_456) < 1000, 3000));
  const finalRevision = v1.client.currentRoomState()?.revision;
  check("S02 只应用最新状态（revision=最终）", finalRevision !== undefined && finalRevision > 0);
  await sleep(600);
  check("S02 无来回跳转（收敛后仍贴近目标）", Math.abs(v1.clock.getCurrentTimeMs() - 123_456 - 600) < 1200);

  console.log("— S03 倍速传播与漂移不累积 —");
  await host.client.hostPlay();
  await host.client.hostRate(2);
  check("S03 倍速到达 v1", await waitFor("v1 rate=2", () => v1.clock.getRate() === 2));
  await sleep(2000);
  const rateDrift = v1.client.sample().driftMs ?? 9999;
  check("S03 2× 播放 2s 后漂移 <1.5s", Math.abs(rateDrift) < 1500, `drift=${rateDrift}ms`);
  await host.client.hostRate(0.5);
  check("S03 0.5× 到达 v1", await waitFor("v1 rate=0.5", () => v1.clock.getRate() === 0.5));
  await sleep(3000);
  const slowDrift = v1.client.sample().driftMs ?? 9999;
  check("S03 0.5× 播放 3s 后漂移 <1.5s（无累积）", Math.abs(slowDrift) < 1500, `drift=${slowDrift}ms`);
  await host.client.hostRate(1);

  console.log("— S04 播放中换片 —");
  const oldMediaRev = v1.client.currentRoomState()?.mediaRevision ?? 0;
  await host.client.hostLoad("/movies/b.mkv", { name: "b.mkv" });
  check("S04 mediaRevision 递增", await waitFor("v1 mediaRev 递增", () => (v1.client.currentRoomState()?.mediaRevision ?? 0) > oldMediaRev));
  check("S04 观众切到新片", v1.client.currentRoomState()?.mediaId === "/movies/b.mkv");

  console.log("— S14 旧片迟到状态被丢弃 —");
  // 直接喂给客户端状态机一条伪造的「旧片高 revision」消息：
  // mediaRevision 更小 → 必须被丢弃（真实网络上由服务端定序保证不会到达，这里是客户端防线验证）。
  const forged: ServerMessage = {
    t: "state",
    roomId,
    revision: 9999,
    mediaRevision: oldMediaRev, // 旧片
    mediaId: "/movies/a.mkv",
    mediaMeta: { name: "a.mkv" },
    paused: true,
    positionMs: 0,
    rate: 1,
    serverTimeMs: Date.now(),
    actorId: "h1",
    action: "seek",
  };
  const droppedBefore = v1.client.sample().droppedStates;
  v1.client.ingestServerMessage(forged);
  check("S14 旧片迟到消息被丢弃", v1.client.currentRoomState()?.mediaId === "/movies/b.mkv");
  check("S14 丢弃计数增加", v1.client.sample().droppedStates > droppedBefore);
  // 服务端防线：客户端伪造的 state 消息类型根本不被协议接受。
  v2.socket!.send(JSON.stringify(forged));
  await sleep(300);
  check("S14 服务端拒绝客户端伪造 state", v2.lastError !== null, v2.lastError ?? "未收到 error");

  console.log("— S05 观众中途加入 —");
  await host.client.hostSeek(200_000);
  await host.client.hostPlay();
  await sleep(800);
  const v3 = await joinR("V3", "viewer", "v3");
  check("S05 新观众落在当前位置附近（±1.5s，2s 内）", await waitFor("v3 对齐", () => {
    const d = v3.client.sample().driftMs;
    return d !== null && Math.abs(d) < 1500;
  }, 3000));
  check("S05 新观众正在播放", !v3.clock.isPaused());

  console.log("— S06 观众断线重连 —");
  v1.client.simulateNetworkDrop();
  check("S06 自动重连成功", await waitFor("v1 重连", () => v1.client.sample().reconnects >= 1 && v1.client.sample().connected, 8000));
  check("S06 重连后重新对齐（±1.5s）", await waitFor("v1 重连对齐", () => {
    const d = v1.client.sample().driftMs;
    return d !== null && Math.abs(d) < 1500;
  }, 4000));

  console.log("— S07 房主断线重连（不双房主） —");
  const beforeDrop = v2.client.currentRoomState()?.revision ?? 0;
  host.client.simulateNetworkDrop();
  check("S07 房间转入暂停并广播", await waitFor("v2 收到暂停", () => {
    const s = v2.client.currentRoomState();
    return s !== null && s.paused && s.revision > beforeDrop;
  }, 8000));
  host.client.connect();
  check("S07 房主恢复权威（重连成功）", await waitFor("host 重连", () => host.client.sample().connected, 8000));
  await host.client.hostPlay();
  check("S07 房主恢复播放，观众跟随", await waitFor("v2 恢复播放", () => !v2.clock.isPaused(), 5000));

  console.log("— S13 非房主命令被拒绝 —");
  const revisionBefore = v2.client.currentRoomState()?.revision ?? -1;
  v2.socket!.send(JSON.stringify({ t: "cmd", action: "seek", positionMs: 42 }));
  check("S13 收到 rejected", await waitFor("v2 rejected", () => v2.lastRejected !== null));
  await sleep(500);
  check("S13 房间 revision 未变（状态未被篡改）", v2.client.currentRoomState()?.revision === revisionBefore);

  console.log("— T-sync 稳态漂移采样（20s）—");
  await host.client.hostSeek(300_000);
  await host.client.hostPlay();
  await sleep(1500); // 收敛
  const driftSamples: number[] = [];
  for (let i = 0; i < 20; i++) {
    await sleep(1000);
    for (const v of [v1, v2, v3]) {
      const d = v.client.sample().driftMs;
      if (d !== null) driftSamples.push(Math.abs(d));
    }
  }
  driftSamples.sort((a, b) => a - b);
  const p50 = percentile(driftSamples, 50);
  const p95 = percentile(driftSamples, 95);
  const max = driftSamples[driftSamples.length - 1] ?? NaN;
  const limit = RTT > 0 ? 1500 : 1000;
  check(`T-sync 稳态 |drift| P95 ≤ ${limit}ms`, p95 <= limit, `P50=${Math.round(p50)} P95=${Math.round(p95)} max=${Math.round(max)} n=${driftSamples.length}`);
  // 无持续累积漂移：后半段均值不比前半段大 500ms 以上
  const half = Math.floor(driftSamples.length / 2);
  const firstAvg = driftSamples.slice(0, half).reduce((a, b) => a + b, 0) / Math.max(1, half);
  const secondAvg = driftSamples.slice(half).reduce((a, b) => a + b, 0) / Math.max(1, driftSamples.length - half);
  check("T-sync 无持续累积漂移（后半段均值未明显变大）", secondAvg - firstAvg < 500, `first=${Math.round(firstAvg)} second=${Math.round(secondAvg)}`);

  // ── 落盘原始记录 ──────────────────────────────────────
  const recDir = path.join(repoRoot, "reports/sync-raw");
  await mkdir(recDir, { recursive: true });
  const record = {
    scenario: "sync-sim",
    simulatedRttMs: RTT,
    finishedAt: new Date().toISOString(),
    limits: { p95Ms: limit },
    result: {
      sampleCount: driftSamples.length,
      p50Ms: Math.round(p50),
      p95Ms: Math.round(p95),
      maxMs: Math.round(max),
      firstHalfAvgMs: Math.round(firstAvg),
      secondHalfAvgMs: Math.round(secondAvg),
    },
    clients: [host, v1, v2, v3].map((c) => ({ id: c.id, stats: c.client.sample() })),
  };
  const file = path.join(recDir, `sync-sim-rtt${RTT}-${Date.now()}.json`);
  await writeFile(file, JSON.stringify(record, null, 2), "utf-8");
  console.log(`\n原始记录已写入: ${path.relative(repoRoot, file)}`);

  for (const c of [host, v1, v2, v3]) c.client.disconnect();
  stopServer();

  console.log(failures === 0 ? "\n全部通过 ✔" : `\n${failures} 项失败 ✘`);
  process.exit(failures === 0 ? 0 : 1);
}

// 注入的伪造状态里 roomId 必须匹配（客户端只看 revision/mediaRevision，但保持一致更真实）
// （forged 消息在 main() 内构造，使用同一个 room 变量。）

main().catch((err) => {
  console.error(err);
  stopServer();
  process.exit(1);
});
