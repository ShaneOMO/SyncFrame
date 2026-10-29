/**
 * P3 端到端冒烟：真实服务端 + OpenList 桩 + 真实 SyncClient（VirtualMediaClock 媒体）。
 *
 * 完整流程：创建房间 → 邀请码加入观众 → 房主浏览/搜索选片 → 注册 mediaId
 *   → WS 广播 load/play/seek/pause → 观众跟随并授权取字节 → 房主换片。
 *
 * 运行：node --import tsx tests/p3/e2e-smoke.ts
 */

import path from "node:path";
import WebSocket from "ws";
import { SyncClient, VirtualMediaClock } from "../../packages/sync-protocol/src/index.ts";
import type { MediaAdapter } from "../../packages/sync-protocol/src/index.ts";
import { startOpenListStub } from "./openlist-stub.ts";
import {
  ADMIN_PASS,
  ADMIN_USER,
  createRoom,
  createUserAsAdmin,
  joinRoom,
  getJson,
  loginUser,
  postJson,
  startServer,
  type CreatedRoom,
} from "./room-api.ts";

const PORT = 8920;
const STUB_PORT = 8921;
const BASE = `http://localhost:${PORT}`;
const WS_BASE = `ws://localhost:${PORT}`;
const HOST_USER = "e2ehost";
const HOST_PASS = "e2epw123";

let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  console.log(`  [${cond ? "PASS" : "FAIL"}] ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(name: string, cond: () => boolean, timeoutMs = 5000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (cond()) return true;
    await sleep(50);
  }
  check(`等待超时: ${name}`, false);
  return false;
}

interface SimClient {
  client: SyncClient;
  clock: VirtualMediaClock;
  socket: WebSocket | null;
}

function makeClient(roomId: string, token: string, role: "host" | "viewer", id: string): SimClient {
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
  const sc: SimClient = { client: null as unknown as SyncClient, clock, socket: null };
  sc.client = new SyncClient({
    wsUrl: `${WS_BASE}/ws?room=${encodeURIComponent(roomId)}&token=${encodeURIComponent(token)}`,
    role,
    media: adapter,
    pingIntervalMs: 1000,
    heartbeatMs: 4000,
    driftCheckMs: 500,
    WebSocketImpl: WebSocket,
    onSocket: (ws) => {
      sc.socket = ws as WebSocket;
    },
  });
  sc.client.connect();
  return sc;
}

async function main(): Promise<void> {
  console.log("\n=== P3 端到端冒烟（真实服务端 + OpenList 桩 + SyncClient）===\n");
  const stub = await startOpenListStub(STUB_PORT);
  const server = await startServer(PORT, {
    ADMIN_USERNAME: ADMIN_USER,
    ADMIN_PASSWORD: ADMIN_PASS,
  });

  try {
    // 0. 管理员创建房主账户，房主配置自己的 OpenList provider（指向桩）
    const adminToken = await loginUser(BASE, ADMIN_USER, ADMIN_PASS);
    await createUserAsAdmin(BASE, adminToken, HOST_USER, HOST_PASS);
    const hostUserToken = await loginUser(BASE, HOST_USER, HOST_PASS);
    await fetch(`${BASE}/api/me/providers`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${hostUserToken}` },
      body: JSON.stringify({
        providers: [{ kind: "openlist", label: "桩", baseUrl: `http://localhost:${STUB_PORT}`, username: "stub", password: "stub" }],
      }),
    });
    const me = (await (await fetch(`${BASE}/api/me`, { headers: { Authorization: `Bearer ${hostUserToken}` } })).json()) as {
      providers: { id: string }[];
    };
    const providerId = me.providers[0]?.id ?? "";
    const userHeader = { "X-User-Token": hostUserToken };

    // 1. 创建房间 + 邀请码加入（创建必须登录）
    console.log("— 创建房间 / 加入 —");
    const guestCreate = await createRoom(BASE, "游客");
    check("游客创建房间 401", guestCreate.status === 401);
    const created = (await createRoom(BASE, "房主", hostUserToken)).data as CreatedRoom;
    check("创建房间返回房间号+邀请码", Boolean(created.roomId && created.inviteCode));
    const viewer = await joinRoom(BASE, created.roomId, "观众甲", created.inviteCode, "v-e2e-1");
    check("观众凭邀请码加入", viewer.status === 200 && viewer.data.role === "viewer");

    // 2. 房主浏览 → 搜索 → 选片注册
    console.log("— 浏览 / 搜索 / 注册 —");
    const browse = await getJson(BASE, `/api/browse?room=${created.roomId}&provider=${providerId}&path=/movies`, created.memberToken, userHeader);
    check("房主浏览 /movies", browse.status === 200);
    const search = await getJson(BASE, `/api/search?room=${created.roomId}&provider=${providerId}&keywords=mkv`, created.memberToken, userHeader);
    check("房主搜索 mkv", search.status === 200 && ((search.data.content as unknown[]) ?? []).length >= 1);
    const reg = await postJson(
      BASE,
      `/api/rooms/${created.roomId}/media`,
      { provider: providerId, path: "/movies/a.mkv" },
      created.memberToken,
      userHeader,
    );
    const mediaId = String(reg.data.mediaId ?? "");
    check("注册 a.mkv 为不透明 mediaId", reg.status === 200 && /^m_/.test(mediaId));
    const subtitle = ((reg.data.related as { name: string; mediaId: string }[]) ?? [])[0];
    check("外挂字幕自动注册", subtitle?.name === "a.srt");

    // 3. WS 同步：load → play → seek → pause
    console.log("— 同步控制 —");
    const host = makeClient(created.roomId, created.memberToken, "host", created.clientId);
    check("房主 WS 入场", await waitFor("host ws", () => host.socket?.readyState === WebSocket.OPEN));
    const v1 = makeClient(created.roomId, viewer.data.memberToken, "viewer", "v-e2e-1");
    check("观众 WS 入场", await waitFor("viewer ws", () => v1.socket?.readyState === WebSocket.OPEN));
    await sleep(400);

    await host.client.hostLoad(mediaId, { name: "a.mkv" });
    check("load 传播（观众收到 opaque mediaId）", await waitFor("v1 applied", () => v1.client.currentRoomState()?.mediaId === mediaId));
    check("广播不含 URL", !JSON.stringify(v1.client.currentRoomState()).includes("http"));

    await host.client.hostPlay();
    check("play 传播", await waitFor("v1 play", () => !v1.clock.isPaused()));
    await sleep(1200);
    check("播放 1.2s 后位置接近（<1s）", Math.abs(v1.clock.getCurrentTimeMs() - host.clock.getCurrentTimeMs()) < 1000);

    host.client.hostSeek(60_000);
    check("seek 传播（2s 内 ±1s）", await waitFor("v1 seek", () => Math.abs(v1.clock.getCurrentTimeMs() - 60_000) < 1000, 3000));
    host.client.hostPause();
    check("pause 传播", await waitFor("v1 pause", () => v1.clock.isPaused()));

    // 4. 观众授权取字节（非 OpenList 登录用户观看指定视频）
    console.log("— 媒体授权 —");
    const grant = await getJson(BASE, `/api/rooms/${created.roomId}/media/${mediaId}/grant`, viewer.data.memberToken);
    check("观众 grant 视频", grant.status === 200 && typeof grant.data.url === "string");
    const bytes = await fetch(String(grant.data.url), { headers: { Range: "bytes=0-4095" } });
    check("视频字节可取（206）", bytes.status === 206 && (await bytes.arrayBuffer()).byteLength === 4096);
    const subGrant = await getJson(BASE, `/api/rooms/${created.roomId}/media/${subtitle.mediaId}/grant`, viewer.data.memberToken);
    check("观众 grant 字幕（同视频授权路径）", subGrant.status === 200);

    // 5. 换片
    console.log("— 换片 —");
    const reg2 = await postJson(BASE, `/api/rooms/${created.roomId}/media`, { provider: providerId, path: "/movies/b.mp4" }, created.memberToken, userHeader);
    const mediaId2 = String(reg2.data.mediaId ?? "");
    const oldRev = v1.client.currentRoomState()?.mediaRevision ?? 0;
    await host.client.hostLoad(mediaId2, { name: "b.mp4" });
    check(
      "换片 mediaRevision 递增且观众应用新 mediaId",
      await waitFor("v1 换片", () => {
        const s = v1.client.currentRoomState();
        return s?.mediaId === mediaId2 && (s.mediaRevision ?? 0) > oldRev;
      }),
    );

    host.client.disconnect();
    v1.client.disconnect();
    await sleep(300);
    console.log(failures === 0 ? "\nP3 端到端冒烟通过 ✔" : `\nP3 端到端冒烟失败（${failures} 项）✘`);
    process.exitCode = failures === 0 ? 0 : 1;
  } finally {
    server.proc.kill();
    await stub.close();
  }
}

void main();
