/**
 * P2 Demo 端到端冒烟：按 README 的文档化路径起真实服务，
 * 经 Vite 代理（localhost:5173/ws）跑 1 房主 + 2 观众会话。
 * 运行：node --import tsx tests/sync/demo-e2e-smoke.ts
 */
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { SyncClient, VirtualMediaClock } from "../../packages/sync-protocol/src/index.ts";
import type { MediaAdapter } from "../../packages/sync-protocol/src/index.ts";
import { ADMIN_PASS, ADMIN_USER, createRoom, createUserAsAdmin, joinRoom, loginUser } from "../p3/room-api.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const children: ChildProcess[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function start(cmd: string, args: string[], cwd: string): void {
  const p = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"], env: process.env });
  p.stderr?.on("data", (d) => process.stderr.write(d));
  children.push(p);
}

async function waitHttp(url: string, timeoutMs = 20_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      if ((await fetch(url)).ok) return;
    } catch { /* retry */ }
    await sleep(250);
  }
  throw new Error(`等待超时: ${url}`);
}

function makeClient(room: string, token: string, role: "host" | "viewer", name: string, id: string): SyncClient {
  const clock = new VirtualMediaClock({ seekLatencyMs: 120 });
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
  return new SyncClient({
    wsUrl: `ws://localhost:8787/ws?room=${encodeURIComponent(room)}&token=${encodeURIComponent(token)}`,
    role,
    media: adapter,
    WebSocketImpl: WebSocket,
    onStatus: (l) => console.log(`    [${name}] ${l}`),
  });
}

async function main(): Promise<void> {
  console.log("启动 p2:demo 后端 (8787) 与 Vite (5173)…");
  start(process.execPath, ["--import", "tsx", "apps/server/src/index.ts"], repoRoot);
  start(process.execPath, [path.join(repoRoot, "node_modules/vite/bin/vite.js"), "--strictPort"], path.join(repoRoot, "apps/web"));
  await waitHttp("http://localhost:8787/api/health");
  await waitHttp("http://localhost:5173/room.html");
  console.log("服务就绪，房间页可访问: http://localhost:5173/lobby.html\n");

  // P3：走房间鉴权流程创建房间与成员令牌（创建必须登录；本机 demo 无管理员时用不了创建 → 直接提示）
  const base = "http://localhost:8787";
  if (!process.env.ADMIN_USERNAME) {
    console.log("提示：未配置 ADMIN_USERNAME/ADMIN_PASSWORD，跳过房间自动创建（请在 .env 配置管理员后重试）");
    process.exitCode = 0;
    return;
  }
  const adminToken = await loginUser(base, process.env.ADMIN_USERNAME, process.env.ADMIN_PASSWORD ?? "");
  const demoUser = "demohost";
  try {
    await createUserAsAdmin(base, adminToken, demoUser, "demopw123");
  } catch {
    /* 已存在则复用 */
  }
  const roomRes = await createRoom(base, "Host", await loginUser(base, demoUser, "demopw123"));
  const room = roomRes.data.roomId;
  const hostToken = roomRes.data.memberToken;
  const v1Res = await joinRoom(base, room, "Viewer1", roomRes.data.inviteCode);
  const v2Res = await joinRoom(base, room, "Viewer2", roomRes.data.inviteCode);
  console.log(`房间 ${room} 已建立（邀请码 ${roomRes.data.inviteCode}），房主 + 2 观众令牌已签发\n`);

  const host = makeClient(room, hostToken, "host", "Host", "h1");
  const v1 = makeClient(room, v1Res.data.memberToken, "viewer", "Viewer1", "v1");
  const v2 = makeClient(room, v2Res.data.memberToken, "viewer", "Viewer2", "v2");
  host.connect();
  await sleep(400);
  v1.connect();
  v2.connect();
  await sleep(800);

  await host.hostLoad("/demo/movie.mkv", { name: "movie.mkv" });
  await host.hostPlay();
  console.log("房主已载入并播放，等待观众同步…");
  await sleep(3000);

  const s1 = v1.sample();
  const s2 = v2.sample();
  const ok =
    s1.appliedMediaId === "/demo/movie.mkv" &&
    s2.appliedMediaId === "/demo/movie.mkv" &&
    s1.driftMs !== null && Math.abs(s1.driftMs) < 1000 &&
    s2.driftMs !== null && Math.abs(s2.driftMs) < 1000;
  console.log(`v1 drift=${s1.driftMs}ms revision=${s1.revision} | v2 drift=${s2.driftMs}ms revision=${s2.revision}`);
  console.log(ok ? "\nDemo 端到端冒烟通过 ✔" : "\nDemo 端到端冒烟失败 ✘");
  host.disconnect();
  v1.disconnect();
  v2.disconnect();
  for (const c of children) c.kill();
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  for (const c of children) c.kill();
  process.exit(1);
});
