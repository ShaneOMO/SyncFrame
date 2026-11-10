/**
 * P4 provider 扩展测试：bilibili provider（参考 SyncTV 设计）+ 直链 provider。
 *
 * 覆盖：
 * - parseVideoId：BV 号 / av 号 / bilibili 链接 / 番剧 ep·ss / 非法输入；
 * - BilibiliClient.getPlayUrl：DASH 视频+音轨选取、mcdn 直连判定、durl 回退（mock fetch）；
 * - credentialFingerprint / extractSessdata：凭证不落库、不泄漏；
 * - UserAccounts：bilibili provider 只保留标签，旧版落盘 cookie 加载即丢弃；
 * - RoomRegistry：bilibili 媒体注册校验、幂等去重、grant 走 resolve 回调。
 *
 * 运行：node --import tsx --test tests/p4/bilibili-provider.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseVideoId,
  BilibiliClient,
  credentialFingerprint,
  isDirectPlayableHost,
  parseSessdata,
} from "../../apps/server/src/bilibili.ts";
import { UserAccounts } from "../../apps/server/src/user-accounts.ts";
import { RoomRegistry } from "../../apps/server/src/room-auth.ts";
import { extractSessdata } from "../../apps/server/src/bilibili-login.ts";

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
        audio: [
          { id: 30216, baseUrl: "https://upos-sz-mirror.bilivideo.com/a-low.m4s" },
          { id: 30280, baseUrl: "https://upos-sz-mirror.bilivideo.com/a-high.m4s" },
        ],
      },
    },
  });
  const bc = new BilibiliClient();
  const play = await bc.getPlayUrl({ bvid: "BV1xx411c7mD", cid: 123456 });
  assert.equal(play.url, "https://upos-sz-mirror.bilivideo.com/high.mp4");
  assert.equal(play.format, "mp4");
  assert.equal(play.quality, "1080P 高清");
  assert.equal(play.timelength, 300);
  // 音视频分离：必须取最高码率音轨，否则播放器没有声音
  assert.equal(play.audioUrl, "https://upos-sz-mirror.bilivideo.com/a-high.m4s");
  // 标准 443 主机强制校验 Referer → 浏览器不能直连
  assert.equal(play.directOk, false);
});

test("getPlayUrl 对 mcdn 主机标记为可直连", async () => {
  mockFetchOnce({
    code: 0,
    message: "0",
    data: {
      timelength: 60_000,
      dash: {
        duration: 60,
        video: [{ id: 80, baseUrl: "https://xy1x2x3x4xy.mcdn.bilivideo.cn:8082/v.mp4", codecid: 7 }],
        audio: [{ id: 30280, baseUrl: "https://xy1x2x3x4xy.mcdn.bilivideo.cn:8082/a.m4s" }],
      },
    },
  });
  const bc = new BilibiliClient();
  const play = await bc.getPlayUrl({ bvid: "BV1xx411c7mD", cid: 123456 });
  assert.equal(play.directOk, true);
  assert.equal(isDirectPlayableHost(play.url), true);
  assert.equal(isDirectPlayableHost("https://upos-sz-mirror.bilivideo.com/x.mp4"), false);
});

test("getPlayUrl 音轨不可直连时整体不可直连（否则会没声音）", async () => {
  mockFetchOnce({
    code: 0,
    message: "0",
    data: {
      timelength: 60_000,
      dash: {
        duration: 60,
        video: [{ id: 80, baseUrl: "https://xy1x2x3x4xy.mcdn.bilivideo.cn:8082/v.mp4", codecid: 7 }],
        audio: [{ id: 30280, baseUrl: "https://upos-sz-mirror.bilivideo.com/a.m4s" }],
      },
    },
  });
  const bc = new BilibiliClient();
  const play = await bc.getPlayUrl({ bvid: "BV1xx411c7mD", cid: 123456 });
  assert.equal(play.directOk, false, "音轨走不了直连时必须整体回落反代");
});

test("getPlayUrl durl 回退不走直连（分片无法随机访问）", async () => {
  mockFetchOnce({
    code: 0,
    message: "0",
    data: {
      timelength: 60_000,
      format: "mp4",
      quality: 32,
      durl: [{ url: "https://xy1x2x3x4xy.mcdn.bilivideo.cn:8082/seg1.mp4" }],
    },
  });
  const bc = new BilibiliClient();
  const play = await bc.getPlayUrl({ bvid: "BV1xx411c7mD", cid: 123456 });
  assert.equal(play.directOk, false);
  assert.equal(play.audioUrl, undefined, "durl 本身音画合一，不应再有独立音轨");
});

test("credentialFingerprint 区分凭证且不泄漏明文", () => {
  assert.equal(credentialFingerprint(null), "anon");
  const a = credentialFingerprint("SESSDATA=aaa");
  const b = credentialFingerprint("SESSDATA=bbb");
  assert.notEqual(a, b);
  assert.match(a, /^[0-9a-f]{16}$/);
  assert.ok(!a.includes("aaa"));
});

test("extractSessdata 只保留 SESSDATA，丢弃写操作 cookie", () => {
  assert.equal(extractSessdata("SESSDATA=abc; bili_jct=xyz; DedeUserID=42"), "SESSDATA=abc");
  assert.equal(extractSessdata("bili_jct=xyz"), null);
  assert.equal(extractSessdata(""), null);
});

test("parseSessdata 接受 URL 编码的真实 SESSDATA", () => {
  // B 站真实形态：逗号被编码成 %2C，还含 * 等字符
  const real = "SESSDATA=1a2b3c4d%2C1790000000%2C1a2b3%2A21";
  assert.equal(parseSessdata(real), real, "含 %2C 的合法凭证不得被拒");
  assert.equal(parseSessdata("  SESSDATA=abcd1234  "), "SESSDATA=abcd1234");
  // 拒绝：非 SESSDATA、多 cookie 拼接、空值、超长
  assert.equal(parseSessdata("bili_jct=xyz"), null);
  assert.equal(parseSessdata("SESSDATA=abc; DedeUserID=42"), null);
  assert.equal(parseSessdata("SESSDATA="), null);
  assert.equal(parseSessdata(null), null);
  assert.equal(parseSessdata(`SESSDATA=${"a".repeat(300)}`), null);
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

test("setProviders 忽略 bilibili cookie（凭证不落服务端）", () => {
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
  // 内存中的 provider 也不再携带 cookie
  const raw = accounts.getUser("alice")!.providers.get(pub[0].id) as unknown as Record<string, unknown>;
  assert.ok(!("cookie" in raw), "服务端不得保存 B 站凭证");
});

test("setProviders 仍拒绝未知 kind", () => {
  const accounts = new UserAccounts();
  accounts.initAdmin("admin", "adminpw123");
  accounts.createUser("admin", "bob", "pw123456");
  const res = accounts.setProviders("bob", [{ kind: "emby", label: "x" }]);
  assert.equal(res.ok, false);
});

test("加载旧版 users.json 时丢弃已落盘的 B 站 cookie", async () => {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const dir = mkdtempSync(path.join(tmpdir(), "syncframe-cred-"));
  writeFileSync(
    path.join(dir, "users.json"),
    JSON.stringify({
      version: 1,
      users: [
        {
          username: "old",
          salt: "s",
          hash: "h",
          role: "user",
          providers: [{ id: "p1", kind: "bilibili", label: "B站", cookie: "SESSDATA=legacy" }],
        },
      ],
    }),
  );
  const accounts = new UserAccounts(dir);
  assert.equal(accounts.listProviders("old").length, 1);
  const raw = accounts.getUser("old")!.providers.get("p1") as unknown as Record<string, unknown>;
  assert.ok(!("cookie" in raw), "旧版落盘的 B 站凭据必须在加载时丢弃");
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

test("grant 缓存按凭证变体隔离，且不泄漏内部字段", async () => {
  const { registry, roomId, host } = makeHost();
  const { mediaId } = registry.registerMedia(roomId, host, "", { name: "测试视频", size: 0 }, [], {
    provider: "哔哩哔哩",
    bilibili: { bvid: "BV1xx411c7mD", cid: 123456, aid: 170001 },
  }) as { mediaId: string };

  const resolveAs = (tag: string) => () =>
    Promise.resolve({ url: `/stream?ticket=${tag}`, name: "n", size: 0, audioUrl: `/a?ticket=${tag}` });

  const anon = await registry.grant(roomId, mediaId, host, resolveAs("anon"), "anon");
  const bound = await registry.grant(roomId, mediaId, host, resolveAs("bound"), "fp1234");
  assert.ok(anon && bound);
  assert.match(anon.url, /anon/);
  assert.match(bound.url, /bound/, "切换凭证后必须重新解析，不能复用匿名结果");
  assert.equal(bound.cached, false);

  // 同变体才复用
  const again = await registry.grant(roomId, mediaId, host, resolveAs("other"), "fp1234");
  assert.ok(again);
  assert.match(again.url, /bound/);
  assert.equal(again.cached, true);

  // 内部缓存时间戳 at 不得出现在响应里
  assert.ok(!("at" in (bound as unknown as Record<string, unknown>)), "内部字段 at 不应外泄");
});
