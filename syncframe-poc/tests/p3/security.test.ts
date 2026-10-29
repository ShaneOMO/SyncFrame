/**
 * P3 安全测试：账户权限模型 + 房间鉴权 + mediaId 受控映射 + 短期媒体凭证 + 日志泄露检查。
 *
 * 覆盖门槛：
 * - 游客（未登录）只能加入房间：创建房间 401、配置 provider 401、访问管理接口 401；
 * - 非管理账户不能管理用户（403）；OpenList 媒体操作必须使用房间创建者本人的 provider；
 * - 房间码或媒体链接不能越权访问其他媒体；
 * - 日志不泄露 OpenList 令牌、完整签名 URL 或敏感路径。
 *
 * 运行：node --import tsx --test tests/p3/security.test.ts
 * 依赖：tests/p3/openlist-stub.ts（OpenList 桩， Range/签名/raw_url 语义齐全）
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import WebSocket from "ws";
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
  type SpawnedServer,
} from "./room-api.ts";

const PORT = 8910;
const STUB_PORT = 8911;
const BASE = `http://localhost:${PORT}`;
const WS_BASE = `ws://localhost:${PORT}`;
const HOST_USER = "host1";
const HOST_PASS = "hostpw123";

let stub: { close: () => Promise<void> };
let server: SpawnedServer;
let created: CreatedRoom;
/** host1 的账户令牌与用户令牌（provider 操作要求 X-User-Token = 房间创建者本人）。 */
let hostUserToken: string;
let hostProviderId = "";
/** 房主当前有效成员令牌：同一身份重新加入会作废旧令牌（防双身份），后续用例跟随最新令牌。 */
let hostToken: string;

function wsConnect(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error("WS 连接超时"));
    }, 3000);
    ws.on("open", () => {
      clearTimeout(timer);
      resolve(ws);
    });
    ws.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function firstMessage(ws: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("等待 welcome 超时")), 8000);
    ws.once("message", (data) => {
      clearTimeout(timer);
      resolve(JSON.parse(String(data)) as Record<string, unknown>);
    });
  });
}

before(async () => {
  stub = await startOpenListStub(STUB_PORT);
  // 无 OPENLIST_* 环境变量：OpenList 凭据只存在于账户 provider 配置中。
  server = await startServer(PORT, {
    ADMIN_USERNAME: ADMIN_USER,
    ADMIN_PASSWORD: ADMIN_PASS,
  });
  // 管理员创建房主账户；房主配置自己的 OpenList provider（指向桩）。
  const adminToken = await loginUser(BASE, ADMIN_USER, ADMIN_PASS);
  await createUserAsAdmin(BASE, adminToken, HOST_USER, HOST_PASS);
  hostUserToken = await loginUser(BASE, HOST_USER, HOST_PASS);
  const setRes = await fetch(`${BASE}/api/me/providers`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${hostUserToken}` },
    body: JSON.stringify({
      providers: [
        { kind: "openlist", label: "桩", baseUrl: `http://localhost:${STUB_PORT}`, username: "stub", password: "stub" },
      ],
    }),
  });
  assert.equal(setRes.status, 200);
  const me = (await (await fetch(`${BASE}/api/me`, { headers: { Authorization: `Bearer ${hostUserToken}` } })).json()) as {
    providers: { id: string }[];
  };
  hostProviderId = me.providers[0]?.id ?? "";
  assert.ok(hostProviderId, "应能取到房主 provider id");

  const res = await createRoom(BASE, "安全测试房主", hostUserToken);
  assert.equal(res.status, 200);
  created = res.data;
  hostToken = created.memberToken;
});

after(async () => {
  server.proc.kill();
  await stub.close();
});

test("权限模型：游客只能加入房间（创建 401 / provider 401 / 管理接口 401）", async () => {
  // 创建房间必须登录
  const guestCreate = await createRoom(BASE, "游客房主");
  assert.equal(guestCreate.status, 401);
  // 游客不能配置 provider
  const guestProviders = await fetch(`${BASE}/api/me/providers`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ providers: [] }),
  });
  assert.equal(guestProviders.status, 401);
  // 游客不能访问管理接口
  const guestAdmin = await getJson(BASE, "/api/admin/users");
  assert.equal(guestAdmin.status, 401);
  // 注册接口已关闭（路由不存在）
  const register = await postJson(BASE, "/api/auth/register", { username: "evil", password: "pw123456" });
  assert.equal(register.status, 404);
});

test("账户管理：非管理员 403；管理员可创建/删除/重置密码", async () => {
  const nonAdmin = await loginUser(BASE, HOST_USER, HOST_PASS);
  const forbidden = await getJson(BASE, "/api/admin/users", nonAdmin);
  assert.equal(forbidden.status, 403);

  const adminToken = await loginUser(BASE, ADMIN_USER, ADMIN_PASS);
  const list = await getJson(BASE, "/api/admin/users", adminToken);
  assert.equal(list.status, 200);
  const users = (list.data.users as { username: string; role: string }[]) ?? [];
  assert.ok(users.some((u) => u.role === "admin" && u.username === ADMIN_USER));
  assert.ok(users.some((u) => u.username === HOST_USER));

  // 创建 + 重置密码 + 删除
  const createdUser = await postJson(BASE, "/api/admin/users", { username: "tempuser", password: "pw123456" }, adminToken);
  assert.equal(createdUser.status, 200);
  const reset = await postJson(BASE, "/api/admin/users/tempuser/password", { password: "newpw5678x" }, adminToken);
  assert.equal(reset.status, 200);
  const relogin = await loginUser(BASE, "tempuser", "newpw5678x");
  assert.ok(relogin.length > 20);
  // 非管理员删除 → 403；管理员删除 → 200；删除后令牌立即失效
  const delForbidden = await fetch(`${BASE}/api/admin/users/tempuser`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${nonAdmin}` },
  });
  assert.equal(delForbidden.status, 403);
  const del = await fetch(`${BASE}/api/admin/users/tempuser`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  assert.equal(del.status, 200);
  const afterDel = await getJson(BASE, "/api/me", relogin);
  assert.equal(afterDel.status, 401, "被删用户令牌应立即失效");
  // 不能删除自己 / 最后一个管理员
  const delSelf = await fetch(`${BASE}/api/admin/users/${ADMIN_USER}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  assert.equal(delSelf.status, 400);
});

test("创建房间：返回房间号 + 邀请码 + 房主成员令牌", () => {
  assert.match(created.roomId, /^[a-z0-9]{6}$/);
  assert.match(created.inviteCode, /^[A-Z2-9]{8}$/);
  assert.equal(created.role, "host");
  assert.ok(created.memberToken.length > 20);
  assert.ok(created.hostSecret.length > 20);
});

test("加入房间：错误邀请码 → 401，且不暴露房间存在性", async () => {
  const bad = await joinRoom(BASE, created.roomId, "小明", "XXXXXX");
  assert.equal(bad.status, 401);
  const noRoom = await joinRoom(BASE, "zzzzzz", "小明", created.inviteCode);
  assert.equal(noRoom.status, 401);
});

test("加入房间：正确邀请码 → 观众成员令牌（clientId 由服务端签发，重复加入各自独立）", async () => {
  const v1 = await joinRoom(BASE, created.roomId, "小红", created.inviteCode);
  assert.equal(v1.status, 200);
  assert.equal(v1.data.role, "viewer");
  assert.ok(v1.data.clientId.length >= 8);
  const v2 = await joinRoom(BASE, created.roomId, "小红", created.inviteCode);
  assert.equal(v2.status, 200);
  assert.notEqual(v2.data.memberToken, v1.data.memberToken);
  // 两个令牌都有效（观众刷新走 sessionStorage 原令牌，不做身份重认领）
  const auth1 = await getJson(BASE, `/api/rooms/${created.roomId}/media`, v1.data.memberToken);
  assert.equal(auth1.status, 200);
});

test("房主可用 hostSecret 重建 host 会话（房主重连路径 S07 的 HTTP 侧）", async () => {
  const rejoin = await joinRoom(BASE, created.roomId, "房主回来", undefined, created.hostSecret);
  assert.equal(rejoin.status, 200);
  assert.equal(rejoin.data.role, "host");
  assert.equal(rejoin.data.clientId, created.clientId, "重建会话应恢复同一 clientId（房主重认领）");
  // 同一身份重新加入：旧令牌作废（防双身份），后续用例改用新令牌
  hostToken = rejoin.data.memberToken;
});

test("WS 入场：无令牌 / 伪造令牌 → 拒绝；有效观众令牌 → welcome", async () => {
  await assert.rejects(wsConnect(`${WS_BASE}/ws?room=${created.roomId}`));
  await assert.rejects(wsConnect(`${WS_BASE}/ws?room=${created.roomId}&token=forged-token`));
  // 不存在的房间同样拒绝
  await assert.rejects(wsConnect(`${WS_BASE}/ws?room=noroom&token=forged-token`));

  const v = await joinRoom(BASE, created.roomId, "WS观众", created.inviteCode);
  const ws = await wsConnect(`${WS_BASE}/ws?room=${created.roomId}&token=${v.data.memberToken}`);
  const welcome = await firstMessage(ws);
  assert.equal(welcome.t, "welcome");
  assert.equal(welcome.role, "viewer");
  assert.equal(welcome.you, v.data.clientId);
  ws.close();
});

test("浏览/搜索：观众 403（不能浏览未授权目录），无令牌 401，房主 200（需本人 provider）", async () => {
  const v = await joinRoom(BASE, created.roomId, "浏览观众", created.inviteCode);
  const viewerBrowse = await getJson(BASE, `/api/browse?room=${created.roomId}&provider=${hostProviderId}&path=/`, v.data.memberToken, { "X-User-Token": hostUserToken });
  assert.equal(viewerBrowse.status, 403);
  const anonBrowse = await getJson(BASE, `/api/browse?room=${created.roomId}&provider=${hostProviderId}&path=/`);
  assert.equal(anonBrowse.status, 401);
  // 房主浏览必须用创建者本人的用户令牌：缺失 → 401，他人令牌 → 403
  const noUserToken = await getJson(BASE, `/api/browse?room=${created.roomId}&provider=${hostProviderId}&path=/movies`, hostToken);
  assert.equal(noUserToken.status, 401);
  const adminToken2 = await loginUser(BASE, ADMIN_USER, ADMIN_PASS);
  const wrongUser = await getJson(
    BASE,
    `/api/browse?room=${created.roomId}&provider=${hostProviderId}&path=/movies`,
    hostToken,
    { "X-User-Token": adminToken2 },
  );
  assert.equal(wrongUser.status, 403);
  const hostBrowse = await getJson(
    BASE,
    `/api/browse?room=${created.roomId}&provider=${hostProviderId}&path=/movies`,
    hostToken,
    { "X-User-Token": hostUserToken },
  );
  assert.equal(hostBrowse.status, 200);
  const content = hostBrowse.data.content as { name: string; isDir: boolean }[];
  assert.ok(content.some((c) => c.name === "a.mkv" && !c.isDir));

  const viewerSearch = await getJson(
    BASE,
    `/api/search?room=${created.roomId}&provider=${hostProviderId}&keywords=mkv`,
    v.data.memberToken,
    { "X-User-Token": hostUserToken },
  );
  assert.equal(viewerSearch.status, 403);
  const hostSearch = await getJson(
    BASE,
    `/api/search?room=${created.roomId}&provider=${hostProviderId}&keywords=mkv`,
    hostToken,
    { "X-User-Token": hostUserToken },
  );
  assert.equal(hostSearch.status, 200);
  assert.ok(((hostSearch.data.content as unknown[]) ?? []).length >= 1);
});

test("注册媒体：观众 403；房主用本人 provider 注册成功返回不透明 mediaId + 自动注册外挂字幕", async () => {
  const v = await joinRoom(BASE, created.roomId, "注册观众", created.inviteCode);
  const viewerReg = await postJson(
    BASE,
    `/api/rooms/${created.roomId}/media`,
    { provider: hostProviderId, path: "/movies/a.mkv" },
    v.data.memberToken,
    { "X-User-Token": hostUserToken },
  );
  assert.equal(viewerReg.status, 403);

  const hostReg = await postJson(
    BASE,
    `/api/rooms/${created.roomId}/media`,
    { provider: hostProviderId, path: "/movies/a.mkv" },
    hostToken,
    { "X-User-Token": hostUserToken },
  );
  assert.equal(hostReg.status, 200);
  assert.match(String(hostReg.data.mediaId), /^m_[a-z0-9]{8}$/);
  const related = (hostReg.data.related as { name: string; mediaId: string }[]) ?? [];
  assert.ok(related.some((r) => r.name === "a.srt"), "外挂字幕应自动注册");

  // 环境变量 OpenList 已移除：不带 provider 直接 400，不触及任何 OpenList
  const noProvider = await postJson(
    BASE,
    `/api/rooms/${created.roomId}/media`,
    { path: "/movies/a.mkv" },
    hostToken,
    { "X-User-Token": hostUserToken },
  );
  assert.equal(noProvider.status, 400);

  // 路径穿越：直接 400，不触及 OpenList
  const traversal = await postJson(
    BASE,
    `/api/rooms/${created.roomId}/media`,
    { provider: hostProviderId, path: "/../secret.mkv" },
    hostToken,
    { "X-User-Token": hostUserToken },
  );
  assert.equal(traversal.status, 400);

  // 幂等：同路径重复注册返回同一 mediaId
  const again = await postJson(
    BASE,
    `/api/rooms/${created.roomId}/media`,
    { provider: hostProviderId, path: "/movies/a.mkv" },
    hostToken,
    { "X-User-Token": hostUserToken },
  );
  assert.equal(again.data.mediaId, hostReg.data.mediaId);
});

async function registeredMediaId(): Promise<string> {
  const list = await getJson(BASE, `/api/rooms/${created.roomId}/media`, hostToken);
  const media = (list.data.media as { mediaId: string; kind: string }[]) ?? [];
  const video = media.find((m) => m.kind === "video");
  assert.ok(video, "房间应有已注册视频");
  return video.mediaId;
}

test("grant：无令牌 401；未注册 mediaId 404；跨房间 mediaId 404；观众可授权且字节可取", async () => {
  const mediaId = await registeredMediaId();
  const v = await joinRoom(BASE, created.roomId, "授权观众", created.inviteCode);

  const noToken = await getJson(BASE, `/api/rooms/${created.roomId}/media/${mediaId}/grant`);
  assert.equal(noToken.status, 401);
  const unknown = await getJson(BASE, `/api/rooms/${created.roomId}/media/m_zzzzzzzz/grant`, v.data.memberToken);
  assert.equal(unknown.status, 404);

  // 跨房间：另一个房间的媒体在本房间不可见（不暴露存在性）
  const other = await createRoom(BASE, "另一房主", hostUserToken);
  const otherReg = await postJson(
    BASE,
    `/api/rooms/${other.data.roomId}/media`,
    { provider: hostProviderId, path: "/movies/b.mp4" },
    other.data.memberToken,
    { "X-User-Token": hostUserToken },
  );
  const cross = await getJson(
    BASE,
    `/api/rooms/${created.roomId}/media/${String(otherReg.data.mediaId)}/grant`,
    v.data.memberToken,
  );
  assert.equal(cross.status, 404);

  // 观众授权成功，URL 可直接 Range 读取（非 OpenList 登录用户可观看指定视频）
  const grant = await getJson(BASE, `/api/rooms/${created.roomId}/media/${mediaId}/grant`, v.data.memberToken);
  assert.equal(grant.status, 200);
  assert.equal(typeof grant.data.url, "string");
  assert.ok(Number(grant.data.expiresInSec) > 0, "应返回短期凭证有效期提示");
  const mediaRes = await fetch(String(grant.data.url), { headers: { Range: "bytes=0-1023" } });
  assert.equal(mediaRes.status, 206);
  const buf = await mediaRes.arrayBuffer();
  assert.equal(buf.byteLength, 1024);
});

test("grant 缓存：同一成员 60s 内重复授权返回 cached=true", async () => {
  const mediaId = await registeredMediaId();
  const g1 = await getJson(BASE, `/api/rooms/${created.roomId}/media/${mediaId}/grant`, hostToken);
  const g2 = await getJson(BASE, `/api/rooms/${created.roomId}/media/${mediaId}/grant`, hostToken);
  assert.equal(g1.data.cached, false);
  assert.equal(g2.data.cached, true);
  assert.equal(g1.data.url, g2.data.url);
});

test("外挂字幕授权与视频一致：同 grant 路径、同存储前缀", async () => {
  const list = await getJson(BASE, `/api/rooms/${created.roomId}/media`, hostToken);
  const media = (list.data.media as { mediaId: string; kind: string; name: string }[]) ?? [];
  const video = media.find((m) => m.kind === "video");
  const subtitle = media.find((m) => m.kind === "subtitle");
  assert.ok(video && subtitle, "应有视频 + 字幕");
  const v = await joinRoom(BASE, created.roomId, "字幕观众", created.inviteCode);
  const vg = await getJson(BASE, `/api/rooms/${created.roomId}/media/${video!.mediaId}/grant`, v.data.memberToken);
  const sg = await getJson(BASE, `/api/rooms/${created.roomId}/media/${subtitle!.mediaId}/grant`, v.data.memberToken);
  assert.equal(vg.status, 200);
  assert.equal(sg.status, 200);
  const videoUrl = new URL(String(vg.data.url));
  const subUrl = new URL(String(sg.data.url));
  assert.equal(videoUrl.origin, subUrl.origin, "字幕与视频应来自同一存储");
  assert.equal(videoUrl.pathname.slice(0, 7), subUrl.pathname.slice(0, 7), "字幕与视频应同存储前缀（桩为扁平 /media/ 布局）");
  const subRes = await fetch(String(sg.data.url), { headers: { Range: "bytes=0-99" } });
  assert.equal(subRes.status, 206);
});

test("WS 广播只含不透明 mediaId：无 URL、无签名、无路径", async () => {
  const mediaId = await registeredMediaId();
  const v = await joinRoom(BASE, created.roomId, "抓包观众", created.inviteCode);
  const ws = await wsConnect(`${WS_BASE}/ws?room=${created.roomId}&token=${v.data.memberToken}`);
  await firstMessage(ws); // welcome
  const captured: string[] = [];
  ws.on("message", (d) => captured.push(String(d)));

  // 房主在 WS 上发 load（走 SyncClient 相同消息形态）
  const hostWs = await wsConnect(`${WS_BASE}/ws?room=${created.roomId}&token=${hostToken}`);
  await firstMessage(hostWs);
  hostWs.send(
    JSON.stringify({
      t: "cmd",
      action: "load",
      mediaId,
      mediaMeta: { name: "a.mkv" },
      positionMs: 0,
      paused: true,
      rate: 1,
    }),
  );
  await new Promise((r) => setTimeout(r, 500));
  hostWs.close();
  ws.close();

  const stateMsg = captured.find((m) => m.includes('"t":"state"'));
  assert.ok(stateMsg, "观众应收到 state 广播");
  assert.ok(!stateMsg.includes("http"), "广播不得包含 URL");
  assert.ok(!stateMsg.includes("sign="), "广播不得包含签名");
  assert.ok(!stateMsg.includes("/movies"), "广播不得包含文件路径");
  assert.ok(stateMsg.includes(`"mediaId":"${mediaId}"`));
});

test("WS 权限门：观众令牌连接后发送控制命令被服务端拒绝", async () => {
  const v = await joinRoom(BASE, created.roomId, "越权观众", created.inviteCode);
  const ws = await wsConnect(`${WS_BASE}/ws?room=${created.roomId}&token=${v.data.memberToken}`);
  await firstMessage(ws);
  const rejected = new Promise<string>((resolve) => {
    ws.on("message", (d) => {
      const m = JSON.parse(String(d)) as { t?: string; reason?: string };
      if (m.t === "rejected" && m.reason) resolve(m.reason);
    });
  });
  ws.send(JSON.stringify({ t: "cmd", action: "play", positionMs: 0 }));
  const reason = await Promise.race([rejected, new Promise<string>((r) => setTimeout(() => r(""), 2000))]);
  assert.ok(reason.includes("房主"), `观众命令应被拒绝，实际: ${reason || "无响应"}`);
  ws.close();
});

test("邀请码轮换：旧码立即失效，新码可加入；观众无权重置", async () => {
  const old = await joinRoom(BASE, created.roomId, "轮换前观众", created.inviteCode);
  assert.equal(old.status, 200, "轮换前的邀请码应有效");
  const viewerRotate = await postJson(BASE, `/api/rooms/${created.roomId}/invite/rotate`, {}, old.data.memberToken);
  assert.equal(viewerRotate.status, 403, "观众重置邀请码必须 403");

  const res = await postJson(BASE, `/api/rooms/${created.roomId}/invite/rotate`, {}, hostToken);
  assert.equal(res.status, 200);
  const newCode = String(res.data.inviteCode ?? "");
  assert.match(newCode, /^[A-Z2-9]{8}$/);
  assert.notEqual(newCode, created.inviteCode);
  const withOld = await joinRoom(BASE, created.roomId, "旧码观众", created.inviteCode);
  assert.equal(withOld.status, 401, "旧邀请码必须失效");
  const withNew = await joinRoom(BASE, created.roomId, "新码观众", newCode);
  assert.equal(withNew.status, 200, "新邀请码应可加入");
  // 后续用例若以邀请码加入，使用新码
  created.inviteCode = newCode;
});

test("限流：join 端点 60s 超过 20 次 → 429", async () => {
  let lastStatus = 0;
  for (let i = 0; i < 21; i++) {
    const res = await joinRoom(BASE, created.roomId, "刷", created.inviteCode);
    lastStatus = res.status;
  }
  assert.equal(lastStatus, 429, `第 21 次加入应被限流，实际 ${lastStatus}`);
});

test("审计日志不泄露令牌 / 签名 URL / 文件路径", () => {
  const auditLines = server.stdout.split("\n").filter((l) => l.includes("[audit]"));
  assert.ok(auditLines.length > 0, "应有审计日志");
  for (const line of auditLines) {
    assert.ok(!line.includes(hostToken), `日志含房主令牌: ${line}`);
    assert.ok(!line.includes("sign="), `日志含签名: ${line}`);
    assert.ok(!line.includes("/movies"), `日志含文件路径: ${line}`);
    assert.ok(!line.includes("stub-openlist-token"), `日志含 OpenList 令牌: ${line}`);
  }
  // WS 拒绝日志只留令牌指纹
  const rejectedLine = auditLines.find((l) => l.includes("auth:ws-rejected"));
  assert.ok(!rejectedLine?.includes("forged-token"), "拒绝日志不得回显原始令牌");
});
