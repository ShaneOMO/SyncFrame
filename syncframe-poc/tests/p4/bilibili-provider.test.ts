/**
 * P4 provider 扩展测试：bilibili provider（参考 SyncTV 设计）+ 直链 provider。
 *
 * 覆盖：
 * - parseVideoId：BV 号 / av 号 / bilibili 链接 / 非法输入；
 * - BilibiliClient.getPlayUrl：DASH 最高画质选取 + durl 回退（mock fetch，不打真实网络）；
 * - UserAccounts：bilibili provider 配置（cookie 可选、不回显）与非法 kind 拒绝；
 * - RoomRegistry：bilibili 媒体注册校验、幂等去重、grant 走 resolve 回调。
 *
 * 运行：node --import tsx --test tests/p4/bilibili-provider.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseVideoId, BilibiliClient } from "../../apps/server/src/bilibili.ts";
import { UserAccounts } from "../../apps/server/src/user-accounts.ts";
import { RoomRegistry } from "../../apps/server/src/room-auth.ts";

// ── parseVideoId ────────────────────────────────────────────

test("parseVideoId 识别 BV 号", () => {
  assert.deepEqual(parseVideoId("BV1xx411c7mD"), { bvid: "BV1xx411c7mD" });
  assert.deepEqual(parseVideoId("  BV1xx411c7mD  "), { bvid: "BV1xx411c7mD" });
});

test("parseVideoId 识别 av 号与链接", () => {
  assert.deepEqual(parseVideoId("av170001"), { aid: 170001 });
  assert.deepEqual(parseVideoId("https://www.bilibili.com/video/BV1xx411c7mD"), { bvid: "BV1xx411c7mD" });
  assert.deepEqual(parseVideoId("https://www.bilibili.com/video/av170001"), { aid: 170001 });
  assert.deepEqual(parseVideoId("https://www.bilibili.com/video/BV1xx411c7mD?p=2"), { bvid: "BV1xx411c7mD" });
});

test("parseVideoId 拒绝无关输入", () => {
  assert.equal(parseVideoId(""), null);
  assert.equal(parseVideoId("https://example.com/foo"), null);
  assert.equal(parseVideoId("BV2xx411c7mD"), null); // BV2 不是合法前缀
});

test("parseVideoId 识别番剧 ep / ss 号与链接", () => {
  assert.deepEqual(parseVideoId("ep123456"), { epId: 123456 });
  assert.deepEqual(parseVideoId("https://www.bilibili.com/bangumi/play/ep123456"), { epId: 123456 });
  assert.deepEqual(parseVideoId("https://www.bilibili.com/bangumi/media/ss45678"), { seasonId: 45678 });
  assert.deepEqual(parseVideoId("ss45678"), { seasonId: 45678 });
  assert.deepEqual(parseVideoId("https://www.bilibili.com/bangumi/play/ep123456?from_spmid=666"), { epId: 123456 });
});

// ── BilibiliClient.getPlayUrl（mock fetch）──────────────────

function mockFetchOnce(payload: unknown, status = 200): void {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } })) as typeof fetch;
}

test("getPlayUrl 从 DASH 选最高画质 mp4 流", async () => {
  mockFetchOnce({
    code: 0,
    message: "0",
    data: {
      timelength: 300_000,
      support_formats: [
        { quality: 80, new_description: "1080P 高清" },
        { quality: 64, new_description: "720P 高清" },
      ],
      dash: {
        duration: 300,
        video: [
          { id: 64, baseUrl: "https://upos-sz-mirror.bilivideo.com/low.mp4", codecid: 7 },
          { id: 80, baseUrl: "https://upos-sz-mirror.bilivideo.com/high.mp4", codecid: 7 },
        ],
        audio: [],
      },
    },
  });
  const bc = new BilibiliClient();
  const play = await bc.getPlayUrl({ bvid: "BV1xx411c7mD", cid: 123456 });
  assert.equal(play.url, "https://upos-sz-mirror.bilivideo.com/high.mp4");
  assert.equal(play.format, "mp4");
  assert.equal(play.quality, "1080P 高清");
  assert.equal(play.timelength, 300);
});

test("getPlayUrl 无 DASH 时回退 durl", async () => {
  mockFetchOnce({
    code: 0,
    message: "0",
    data: {
      timelength: 60_000,
      format: "mp4",
      quality: 32,
      support_formats: [{ quality: 32, new_description: "480P 清晰" }],
      durl: [{ url: "https://upos-sz-mirror.bilivideo.com/seg1.mp4", backup_url: ["https://backup.example.com/seg1.mp4"] }],
    },
  });
  const bc = new BilibiliClient();
  const play = await bc.getPlayUrl({ bvid: "BV1xx411c7mD", cid: 123456 });
  assert.equal(play.url, "https://upos-sz-mirror.bilivideo.com/seg1.mp4");
  assert.equal(play.backupUrl, "https://backup.example.com/seg1.mp4");
});

test("getPlayUrl 上报 bilibili 业务错误", async () => {
  mockFetchOnce({ code: -404, message: "啥都木有" });
  const bc = new BilibiliClient();
  await assert.rejects(() => bc.getPlayUrl({ bvid: "BV1xx411c7mD", cid: 123456 }), /bilibili 错误 -404/);
});

// 记录最近一次请求的 URL，用于校验番剧走 pgc playurl。
let lastFetchUrl = "";
function mockFetchTraced(payload: unknown, status = 200): void {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    lastFetchUrl = String(input);
    return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
}

test("getBangumiInfo 按 ep 号解析季标题 + 单集 cid", async () => {
  mockFetchTraced({
    code: 0,
    message: "0",
    result: {
      season_title: "某科学的超电磁炮",
      episodes: [
        { id: 123456, cid: 987654, aid: 555, bvid: "BV1xx411c7mD", title: "1", long_title: "超电磁炮" },
        { id: 123457, cid: 987655, title: "2", long_title: "" },
      ],
    },
  });
  const bc = new BilibiliClient();
  const ep = await bc.getBangumiInfo({ epId: 123456 });
  assert.equal(ep.cid, 987654);
  assert.equal(ep.bvid, "BV1xx411c7mD");
  assert.equal(ep.title, "某科学的超电磁炮 超电磁炮");
  assert.match(lastFetchUrl, /\/pgc\/view\/web\/season\?ep_id=123456/);
});

test("getBangumiInfo 按 ss 号取首集", async () => {
  mockFetchTraced({
    code: 0,
    message: "0",
    result: { title: "某番", episodes: [{ id: 42, cid: 1001, title: "1", long_title: "开幕" }] },
  });
  const bc = new BilibiliClient();
  const ep = await bc.getBangumiInfo({ seasonId: 45678 });
  assert.equal(ep.epId, 42);
  assert.equal(ep.cid, 1001);
  assert.equal(ep.title, "某番 开幕");
});

test("getPlayUrl 番剧走 /pgc/player/web/playurl（带 ep_id）", async () => {
  mockFetchTraced({
    code: 0,
    message: "0",
    result: {
      timelength: 120_000,
      support_formats: [{ quality: 120, new_description: "4K 超清" }],
      dash: { duration: 120, video: [{ id: 120, baseUrl: "https://upos.example.com/4k.mp4", codecid: 7 }], audio: [] },
    },
  });
  const bc = new BilibiliClient();
  const play = await bc.getPlayUrl({ epId: 123456, cid: 987654 });
  assert.match(lastFetchUrl, /\/pgc\/player\/web\/playurl\?ep_id=123456&cid=987654/);
  assert.equal(play.url, "https://upos.example.com/4k.mp4");
  assert.equal(play.quality, "4K 超清");
});

// ── UserAccounts：bilibili provider 配置 ────────────────────

test("setProviders 接受 bilibili（cookie 可选，不回显）", () => {
  const accounts = new UserAccounts();
  assert.equal(accounts.initAdmin("admin", "adminpw123"), true);
  assert.equal(accounts.createUser("admin", "alice", "pw123456").ok, true);
  const res = accounts.setProviders("alice", [
    { kind: "bilibili", label: "我的 B 站", cookie: "SESSDATA=xyz" },
    { kind: "bilibili" }, // 匿名
  ]);
  assert.equal(res.ok, true);
  const pub = accounts.listProviders("alice");
  assert.equal(pub.length, 2);
  assert.equal(pub[0].kind, "bilibili");
  assert.equal(pub[0].label, "我的 B 站");
  assert.ok(!("cookie" in pub[0]), "cookie 不得回显");
  assert.equal(pub[1].label, "哔哩哔哩");
});

test("setProviders 仍拒绝未知 kind", () => {
  const accounts = new UserAccounts();
  accounts.initAdmin("admin", "adminpw123");
  accounts.createUser("admin", "bob", "pw123456");
  const res = accounts.setProviders("bob", [{ kind: "emby", label: "x" }]);
  assert.equal(res.ok, false);
});

test("upsertBilibiliCookie 新建/更新 provider 且不回显 cookie", () => {
  const accounts = new UserAccounts();
  accounts.initAdmin("admin", "adminpw123");
  accounts.createUser("admin", "carol", "pw123456");
  const created = accounts.upsertBilibiliCookie("carol", "SESSDATA=abc; bili_jct=xyz", "测试用户");
  assert.equal(created.ok, true);
  if (created.ok) assert.match(created.provider.label, /哔哩哔哩·测试用户/);
  const updated = accounts.upsertBilibiliCookie("carol", "SESSDATA=new; bili_jct=xyz");
  assert.equal(updated.ok, true);
  const pub = accounts.listProviders("carol");
  assert.equal(pub.length, 1, "重复登录应更新同一 provider 而非新增");
  assert.ok(!("cookie" in pub[0]), "cookie 不得回显");
  const bad = accounts.upsertBilibiliCookie("carol", "foo=bar");
  assert.equal(bad.ok, false);
});

// ── Bilibili 扫码登录：Set-Cookie 提取 ───────────────────────

test("extractLoginCookie 提取 SESSDATA 等并拒绝缺失", async () => {
  const { extractLoginCookie } = await import("../../apps/server/src/bilibili-login.ts");
  const cookie = extractLoginCookie([
    "SESSDATA=abc123; Domain=.bilibili.com; Path=/; HttpOnly",
    "bili_jct=xyz; Domain=.bilibili.com; Path=/",
    "DedeUserID=42; Domain=.bilibili.com; Path=/",
    "buvid3=ignored; Domain=.bilibili.com; Path=/",
  ]);
  assert.equal(cookie, "SESSDATA=abc123; bili_jct=xyz; DedeUserID=42");
  assert.equal(extractLoginCookie(["buvid3=x; Path=/"]), null);
  assert.equal(extractLoginCookie([]), null);
});

// ── RoomRegistry：bilibili 媒体注册与授权 ───────────────────

function makeHost() {
  const registry = new RoomRegistry({});
  const { room, member } = registry.createRoom("房主", "alice");
  return { registry, roomId: room.roomId, host: member };
}

test("registerMedia 接受 bilibili 条目并校验标识", () => {
  const { registry, roomId, host } = makeHost();
  const ok = registry.registerMedia(roomId, host, "", { name: "测试视频", size: 0 }, [], {
    provider: "哔哩哔哩",
    bilibili: { bvid: "BV1xx411c7mD", cid: 123456, aid: 170001 },
  });
  assert.ok("mediaId" in ok);
  const bad = registry.registerMedia(roomId, host, "", { name: "x", size: 0 }, [], {
    bilibili: { bvid: "not-a-bv", cid: 1, aid: 1 },
  });
  assert.deepEqual(bad, { error: "非法 bilibili 视频标识" });
});

test("registerMedia 同一 BV+分 P 幂等去重", () => {
  const { registry, roomId, host } = makeHost();
  const a = registry.registerMedia(roomId, host, "", { name: "测试视频", size: 0 }, [], {
    bilibili: { bvid: "BV1xx411c7mD", cid: 123456, aid: 170001 },
  });
  const b = registry.registerMedia(roomId, host, "", { name: "测试视频", size: 0 }, [], {
    bilibili: { bvid: "BV1xx411c7mD", cid: 123456, aid: 170001 },
  });
  assert.ok("mediaId" in a && "mediaId" in b);
  assert.equal(a.mediaId, b.mediaId);
});

test("registerMedia 接受番剧条目（epId + cid），并拒绝无 bvid 无 epId 的标识", () => {
  const { registry, roomId, host } = makeHost();
  const ok = registry.registerMedia(roomId, host, "", { name: "番剧第1集", size: 0 }, [], {
    provider: "哔哩哔哩",
    bilibili: { epId: 123456, cid: 987654 },
  });
  assert.ok("mediaId" in ok);
  const bad = registry.registerMedia(roomId, host, "", { name: "x", size: 0 }, [], {
    bilibili: { cid: 1 },
  });
  assert.deepEqual(bad, { error: "非法 bilibili 视频标识" });
});

test("grant 对 bilibili 条目调用 resolve 回调（流地址由服务端生成）", async () => {
  const { registry, roomId, host } = makeHost();
  const { mediaId } = registry.registerMedia(roomId, host, "", { name: "测试视频", size: 0 }, [], {
    provider: "哔哩哔哩",
    bilibili: { bvid: "BV1xx411c7mD", cid: 123456, aid: 170001 },
  }) as { mediaId: string };
  const grant = await registry.grant(roomId, mediaId, host, (entry) => {
    assert.deepEqual(entry.bilibili, { bvid: "BV1xx411c7mD", cid: 123456, aid: 170001 });
    return Promise.resolve({ url: `/api/rooms/${roomId}/media/${mediaId}/stream?token=t`, name: entry.name, size: 0 });
  });
  assert.ok(grant);
  assert.match(grant.url, /\/stream\?token=/);
  // 60s 缓存：第二次直接复用，不再调用 resolve。
  let resolveCalls = 0;
  const cached = await registry.grant(roomId, mediaId, host, () => {
    resolveCalls++;
    return Promise.resolve({ url: "x", name: "n", size: 0 });
  });
  assert.equal(resolveCalls, 0);
  assert.equal(cached.cached, true);
});
