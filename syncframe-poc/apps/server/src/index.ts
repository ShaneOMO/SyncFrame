/**
 * SyncFrame 后端：账户/角色权限 + 房间鉴权 + mediaId 受控映射 + provider 媒体库。
 *
 * 权限模型：
 * - 游客（未登录）：只能凭邀请码加入房间、观看；不能创建房间、不能配置 provider；
 * - 用户（登录）：可创建房间、配置自己的 OpenList provider；
 * - 管理员：由环境变量 ADMIN_USERNAME / ADMIN_PASSWORD 初始化，负责创建/删除/重置密码全部账户。
 *   注册接口已关闭。
 *
 * B 站凭证模型：SESSDATA 由浏览器 localStorage 持有，经 X-Bili-Sessdata 头随请求传入；
 * 服务端只在单次请求内使用（解析 playurl），不落盘、不跨请求缓存、不共享给其他成员。
 * 扫码登录只把 SESSDATA 交还浏览器（bili_jct 等写操作 cookie 就地丢弃）。
 *
 * 接口：
 *  - GET  /api/health                                存活检查
 *  - POST /api/auth/login        {username,password} → userToken（无注册接口）
 *  - GET  /api/me                  (Bearer userToken)  当前用户（含 role）+ provider 列表（不含凭据）
 *  - PUT  /api/me/providers        (Bearer userToken)  全量替换自己的 provider 配置
 *  - GET  /api/bilibili/login/qrcode (Bearer userToken) 申请 B 站扫码登录二维码
 *  - GET  /api/bilibili/login/poll?qrcodeKey= (Bearer)   轮询扫码状态；确认后仅把 SESSDATA 交还浏览器保存 *  - GET  /api/admin/users         (Bearer admin)      账户列表（不含凭据）
 *  - POST /api/admin/users         (Bearer admin)      创建账户
 *  - DELETE /api/admin/users/:name (Bearer admin)      删除账户
 *  - POST /api/admin/users/:name/password (Bearer admin) 重置密码
 *  - GET  /api/rooms                                   公开房间列表（大厅；带 userToken 时标记可删除的房间）
 *  - POST /api/rooms            (Bearer userToken) {name, roomId?, inviteCode?, noInvite?} → {roomId, inviteCode|null, memberToken, ...}
 *                                                    （游客 401；noInvite=true 则不生成访问码，凭房间号即可加入）
 *  - POST /api/rooms/:id/join   {name, inviteCode?, clientId?}（公开；访问码只约束游客，
 *                                                    可选 Bearer userToken：登录用户凭房间号即可进房、昵称缺省用用户名）
 *  - POST /api/rooms/:id/rename {name}（Bearer memberToken，仅房主）修改房间名（纯展示）
 *  - DELETE /api/rooms/:id      (Bearer userToken)   删除房间（仅房主本人或管理员）；房间只有被删除才会消失
 *  - GET  /api/browse?provider=&path=&page=           列目录（仅房主本人账户 + X-User-Token）
 *  - GET  /api/search?provider=&keywords=&parent=&page= 搜索（同上）
 *  - POST /api/rooms/:id/media  注册媒体（仅房主）。三种形态：
 *      {provider:"direct", name, url}                 直链（校验 http/https、禁带凭证）
 *      {provider:"bilibili", url}                     B 站视频（凭证经 X-Bili-Sessdata，可选）
 *      {provider:<id>, path} + X-User-Token           房主本人账户的 OpenList provider
 *    自动注册同目录外挂字幕（srt/ass/ssa/vtt）
 *  - GET  /api/rooms/:id/media/:mediaId/grant        签发媒体地址（房间成员；跨房间 404）
 *      B 站：mcdn 可直连时下发 CDN 直链（浏览器直拉，服务器不耗带宽），否则下发 /stream 票据；两者均带回落地址
 *      OpenList：解析存储直链后统一下发 /stream 票据（网盘后端不放行 CORS，浏览器无法跨域拉流）
 *  - GET  /api/rooms/:id/media/:mediaId/stream?ticket=  流反代（透传 Range/HEAD；票据绑定已解析的上游地址；B 站/OpenList 按票据类型带上游头）
 *  - DELETE /api/rooms/:id/media/:mediaId  从播放列表移除（仅房主；删除视频时联动移除同目录自动注册的字幕）

 *
 *  - WS   /ws?room=<id>（子协议 sf.token.<memberToken>）  同步房间（凭成员令牌入场）
 *
 * 令牌缓存于内存；OpenList 凭据只存在于服务端；B 站 SESSDATA 不经服务端持久化。
 * 审计日志见 [audit] 行：只含 roomId/mediaId/clientId/动作，不含令牌、签名 URL 或文件路径。
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { WebSocketServer } from "ws";
import { OpenListClient } from "@syncframe/openlist-adapter";
import { RoomManager } from "./sync-rooms.ts";
import { RoomRegistry, tokenFingerprint } from "./room-auth.ts";
import type { MediaEntry, MemberRecord } from "./room-auth.ts";
import { UserAccounts } from "./user-accounts.ts";
import { BilibiliClient, credentialFingerprint, getPlayUrlCached, parseSessdata, parseVideoId } from "./bilibili.ts";
import { extractSessdata, fetchNavInfo, pollQrLogin, startQrLogin } from "./bilibili-login.ts";

const PORT = Number(process.env.SERVER_PORT ?? 8787);

// P4：账户系统。管理员由环境变量初始化（注册接口已关闭）；
// OpenList / Bilibili 凭据不再来自环境变量，全部由各账户在 provider 配置中自行保存。
// 持久化：账户与房间落盘 DATA_DIR（默认 ./data，Docker 挂卷），重启保留。
const DATA_DIR = process.env.DATA_DIR ?? "./data";
const accounts = new UserAccounts(DATA_DIR);
if (process.env.ADMIN_USERNAME && process.env.ADMIN_PASSWORD) {
  if (accounts.initAdmin(process.env.ADMIN_USERNAME, process.env.ADMIN_PASSWORD)) {
    console.log(`管理员账户已就绪: ${process.env.ADMIN_USERNAME.trim()}`);
  } else {
    console.warn("警告: ADMIN_USERNAME/ADMIN_PASSWORD 格式无效，未创建管理员账户");
  }
} else {
  console.warn("警告: 未配置 ADMIN_USERNAME / ADMIN_PASSWORD，将没有管理员账户（无法登录与管理用户）");
}

// P3：房间注册表（鉴权 + 媒体受控映射 + 授权缓存）。审计日志不含令牌/URL/路径。
const registry = new RoomRegistry({  dataDir: DATA_DIR, isAdmin: (username) => accounts.isAdmin(username), onAudit: (ev) => {
    const fp = ev.clientId ? ` member=${ev.clientId}` : "";
    const mid = ev.mediaId ? ` media=${ev.mediaId}` : "";
    const detail = ev.detail ? ` ${ev.detail}` : "";
    console.log(`[audit] room=${ev.roomId}${fp}${mid} action=${ev.action}${detail}`);
  },
});

// 房主私有 OpenList provider 的客户端缓存（凭据不出服务端）。
const userClients = new Map<string, { client: OpenListClient; baseUrl: string }>();

// Bilibili 凭证：由浏览器 localStorage 持有，经 X-Bili-Sessdata 头随请求传入。
// 服务端只在本次请求内使用，不落盘、不跨请求保存、不共享给其他成员。
const anonBilibili = new BilibiliClient();

/** SESSDATA 上限：真实值约 60-120 字符，留足余量但不接受任意长串。 */
const MAX_SESSDATA_LEN = 512;

/** 从请求头取用户自带的 SESSDATA（只接受单个 `SESSDATA=...` 形态）。 */
function requestSessdata(req: IncomingMessage): string | null {
  const raw = req.headers["x-bili-sessdata"];
  return typeof raw === "string" ? parseSessdata(raw, MAX_SESSDATA_LEN) : null;
}

/** 按凭证构造客户端；buvid 由凭证指纹派生，保持稳定且不产生跨请求状态。 */
function bilibiliClientFor(sessdata: string | null): BilibiliClient {
  if (!sessdata) return anonBilibili;
  return new BilibiliClient({ cookie: sessdata, buvidSeed: credentialFingerprint(sessdata) });
}

async function userOpenListClient(username: string, providerId: string): Promise<{ client: OpenListClient; baseUrl: string } | null> {
  const user = accounts.getUser(username);
  const cfg = user?.providers.get(providerId);
  if (!cfg || cfg.kind !== "openlist") return null;
  const key = `${username}:${providerId}`;
  let cached = userClients.get(key);
  if (!cached) {
    cached = { client: new OpenListClient({ baseUrl: cfg.baseUrl, timeoutMs: 15_000 }), baseUrl: cfg.baseUrl };
    await cached.client.login(cfg.username, cfg.password);
    userClients.set(key, cached);
  }
  return cached;
}

// P2：同步房间。延迟注入用于仿真 WAN（单向延迟=RTT/2），见 tests/sync。
const roomManager = new RoomManager({
  injectLatencyMs: Number(process.env.SYNC_INJECT_LATENCY_MS ?? 0),
  injectJitterMs: Number(process.env.SYNC_INJECT_JITTER_MS ?? 0),
  onDebug: (line) => console.log(`[sync] ${line}`),
  /** 同步房间销毁后回调（注册表房间另有更长保留期，见下方清扫）。 */
  onRoomDisposed: (_roomId) => {},
});

/**
 * 全局安全响应头。
 * 凭证改为浏览器持有后，XSS 是最大的威胁面：CSP 用于阻断内联/第三方脚本，
 * 避免 localStorage 中的 SESSDATA 被注入脚本读走。
 */
const SECURITY_HEADERS: Record<string, string> = {
  // M3：任何情况下都不向外泄漏本页 URL（含 ?key= 邀请码）。
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; " +
    "style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; " +
    "media-src 'self' blob: https:; connect-src 'self' https: ws: wss:; " +
    "frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
};

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...SECURITY_HEADERS,
  });
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 5 * 1024 * 1024) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      data += chunk;
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function readJsonBody(body: string): Record<string, unknown> {
  if (!body) return {};
  const parsed: unknown = JSON.parse(body);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("请求体必须是 JSON 对象");
  }
  return parsed as Record<string, unknown>;
}

/** 从 Authorization: Bearer <memberToken> 取令牌。 */
function bearerToken(req: IncomingMessage): string | null {
  const h = req.headers.authorization ?? "";
  const m = /^Bearer\s+(.+)$/.exec(h);
  return m ? m[1].trim() : null;
}

/** 鉴权 + 房主校验：浏览/搜索/注册媒体用。返回 null 时已写出响应。 */
function requireMember(
  req: IncomingMessage,
  res: ServerResponse,
  roomId: string,
  opts: { hostOnly?: boolean } = {},
): MemberRecord | null {
  const member = registry.authenticate(roomId, bearerToken(req));
  if (!member) {
    sendJson(res, 401, { error: "成员令牌无效或已过期" });
    return null;
  }
  if (opts.hostOnly && member.role !== "host") {
    registry.audit({ roomId, action: "auth:forbidden", clientId: member.clientId, detail: opts.hostOnly ? "host-only" : "" });
    sendJson(res, 403, { error: "只有房主可以浏览媒体库" });
    return null;
  }
  return member;
}

// ── OpenList 解析（服务端代理解析，OpenList 令牌不出服务端）────────────────

async function resolveWithClient(
  olClient: OpenListClient,
  baseUrl: string,
  filePath: string,
  userAgent: string,
): Promise<{
  name: string;
  size: number;
  url: string;
  related: { name: string; size: number }[];
}> {
  const detail = await olClient.getFile(filePath, { userAgent: userAgent || "SyncFrame-PoC/0.1" });
  const proxy = `${baseUrl.replace(/\/+$/, "")}/d${filePath.startsWith("/") ? "" : "/"}${filePath}${
    detail.sign ? `?sign=${encodeURIComponent(detail.sign)}` : ""
  }`;
  // 优先 raw_url；服务端跟随重定向链得到最终地址（CORS/签名敏感规避，见 P1）。
  const initial = detail.raw_url ?? proxy;
  const { url: finalUrl } = await resolveRedirectChain(initial);
  return {
    name: detail.name,
    size: detail.size,
    url: finalUrl,
    related: (detail.related ?? []).map((r) => ({ name: r.name, size: r.size })),
  };
}

/** 重定向地址基本防护：仅 http/https、不允许携带凭证、限制跳数。
 *  注意：不拦截私网地址——用户的 OpenList 可能部署在局域网。 */
function assertSafeRedirectUrl(url: string): void {
  const parsed = new URL(url);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`重定向目标协议不允许: ${parsed.protocol}`);
  }
  if (parsed.username || parsed.password) {
    throw new Error("重定向目标不允许包含凭证");
  }
}

/** 用 HEAD 手动跟随重定向（最多 5 跳），返回最终地址；HEAD 失败时返回当前地址 */
async function resolveRedirectChain(url: string): Promise<{ url: string; redirectCount: number }> {
  let current = url;
  for (let i = 0; i < 5; i++) {
    let res: Response;
    try {
      res = await fetch(current, { method: "HEAD", redirect: "manual" });
    } catch {
      return { url: current, redirectCount: i };
    }
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) return { url: current, redirectCount: i };
      current = new URL(loc, current).toString();
      assertSafeRedirectUrl(current);
    } else {
      return { url: current, redirectCount: i };
    }
  }
  return { url: current, redirectCount: 5 };
}

/** 校验 X-User-Token 并确认该账户是房间创建者（provider 操作只允许房主本人账户）。返回 null 时已写出响应。 */
function requireRoomOwner(req: IncomingMessage, res: ServerResponse, roomId: string): string | null {
  const username = accounts.authenticate(
    typeof req.headers["x-user-token"] === "string" ? req.headers["x-user-token"] : null,
  );
  if (!username) {
    sendJson(res, 401, { error: "需要登录（X-User-Token）" });
    return null;
  }
  if (!registry.isRoomOwner(roomId, username)) {
    sendJson(res, 403, { error: "只能使用房间创建者本人的 provider" });
    return null;
  }
  return username;
}

// ── Bilibili 扫码登录（SyncTV 式绑定）：凭据只在服务端，写入用户自己的 provider 配置 ──

async function handleBiliQrCode(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const username = accounts.authenticate(bearerToken(req));
  if (!username) {
    sendJson(res, 401, { error: "需要登录（Bearer userToken）" });
    return;
  }
  try {
    const { url, qrcodeKey } = await startQrLogin();
    sendJson(res, 200, { url, qrcodeKey });
  } catch (err) {
    sendJson(res, 502, { error: err instanceof Error ? err.message : String(err) });
  }
}

async function handleBiliQrPoll(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const username = accounts.authenticate(bearerToken(req));
  if (!username) {
    sendJson(res, 401, { error: "需要登录（Bearer userToken）" });
    return;
  }
  const qrcodeKey = (url.searchParams.get("qrcodeKey") ?? "").trim();
  if (!qrcodeKey) {
    sendJson(res, 400, { error: "缺少 qrcodeKey" });
    return;
  }
  try {
    const status = await pollQrLogin(qrcodeKey);
    if (status.status !== "confirmed") {
      sendJson(res, 200, { status: status.status });
      return;
    }
    // 只取出 SESSDATA 交给浏览器保存；其余 cookie（bili_jct 等）就地丢弃，服务端不落盘。
    const sessdata = extractSessdata(status.cookie);
    if (!sessdata) {
      sendJson(res, 500, { error: "登录确认但未取到 SESSDATA，请重试" });
      return;
    }
    console.log(`[bilibili] 用户 ${username} 已完成扫码${status.uname ? `（${status.uname}）` : ""}，凭据交由浏览器保存`);
    sendJson(res, 200, { status: "confirmed", uname: status.uname, sessdata });
  } catch (err) {
    sendJson(res, 502, { error: err instanceof Error ? err.message : String(err) });
  }
}

// ── 账户 / provider 配置 / 管理员 / 公开房间列表 ───────────────────────────

async function handleLogin(req: IncomingMessage, res: ServerResponse, body: string): Promise<void> {
  // M2：同一用户名连续失败锁定（在路由限流之后做细粒度控制）。
  const parsed0 = readJsonBody(body);
  const username0 = typeof parsed0.username === "string" ? parsed0.username.trim() : "";
  if (username0 && loginThrottled(username0)) {
    sendJson(res, 429, { error: "该账户尝试过于频繁，已临时锁定，请 5 分钟后再试" });
    return;
  }
  const parsed = parsed0;
  const token = accounts.login(
    typeof parsed.username === "string" ? parsed.username : "",
    typeof parsed.password === "string" ? parsed.password : "",
  );
  if (!token) {
    if (username0) recordLoginFailure(username0);
    sendJson(res, 401, { error: "用户名或密码错误" });
    return;
  }
  clearLoginFailures(username0);
  sendJson(res, 200, { userToken: token, username: (typeof parsed.username === "string" ? parsed.username : "").trim() });
}

function handleMe(req: IncomingMessage, res: ServerResponse): void {
  const username = accounts.authenticate(bearerToken(req));
  if (!username) {
    sendJson(res, 401, { error: "未登录或登录已过期" });
    return;
  }
  sendJson(res, 200, { username, role: accounts.getUser(username)?.role ?? "user", providers: accounts.listProviders(username) });
}

// ── 管理员：账户创建/删除/重置密码（注册接口已关闭）─────────────────────────

/** 校验管理员身份，返回管理员用户名；非管理员已写出 401/403。 */
function requireAdmin(req: IncomingMessage, res: ServerResponse): string | null {
  const username = accounts.authenticate(bearerToken(req));
  if (!username) {
    sendJson(res, 401, { error: "未登录或登录已过期" });
    return null;
  }
  if (!accounts.isAdmin(username)) {
    sendJson(res, 403, { error: "只有管理员可以管理账户" });
    return null;
  }
  return username;
}

function handleAdminListUsers(req: IncomingMessage, res: ServerResponse): void {
  const admin = requireAdmin(req, res);
  if (!admin) return;
  sendJson(res, 200, { users: accounts.listUsers(admin) ?? [] });
}

async function handleAdminCreateUser(req: IncomingMessage, res: ServerResponse, body: string): Promise<void> {
  const admin = requireAdmin(req, res);
  if (!admin) return;
  const parsed = readJsonBody(body);
  const result = accounts.createUser(
    admin,
    typeof parsed.username === "string" ? parsed.username : "",
    typeof parsed.password === "string" ? parsed.password : "",
  );
  if (!result.ok) {
    sendJson(res, 400, { error: result.error });
    return;
  }
  sendJson(res, 200, { ok: true });
}

async function handleAdminDeleteUser(req: IncomingMessage, res: ServerResponse, username: string): Promise<void> {
  const admin = requireAdmin(req, res);
  if (!admin) return;
  const result = accounts.deleteUser(admin, username);
  if (!result.ok) {
    sendJson(res, 400, { error: result.error });
    return;
  }
  // 被删用户的 OpenList 客户端缓存一并失效。
  for (const key of [...userClients.keys()]) {
    if (key.startsWith(`${username}:`)) userClients.delete(key);
  }
  sendJson(res, 200, { ok: true });
}

async function handleAdminResetPassword(req: IncomingMessage, res: ServerResponse, username: string, body: string): Promise<void> {
  const admin = requireAdmin(req, res);
  if (!admin) return;
  const parsed = readJsonBody(body);
  const result = accounts.resetPassword(admin, username, typeof parsed.password === "string" ? parsed.password : "");
  if (!result.ok) {
    sendJson(res, 400, { error: result.error });
    return;
  }
  sendJson(res, 200, { ok: true });
}

async function handleSetProviders(req: IncomingMessage, res: ServerResponse, body: string): Promise<void> {
  const username = accounts.authenticate(bearerToken(req));
  if (!username) {
    sendJson(res, 401, { error: "未登录或登录已过期" });
    return;
  }
  const parsed = readJsonBody(body);
  const result = accounts.setProviders(username, parsed.providers);
  if (!result.ok) {
    sendJson(res, 400, { error: result.error });
    return;
  }
  // 凭据变更后丢弃该用户的 OpenList 客户端缓存（下次 grant 重新登录）。
  for (const key of [...userClients.keys()]) {
    if (key.startsWith(`${username}:`)) userClients.delete(key);
  }
  sendJson(res, 200, { providers: accounts.listProviders(username) });
}

// ── 房间端点实现 ─────────────────────────────────────────────

async function handleCreateRoom(req: IncomingMessage, res: ServerResponse, body: string): Promise<void> {
  // 游客只能加入房间：创建房间必须登录（用户令牌）。
  const hostUser = accounts.authenticate(bearerToken(req));
  if (!hostUser) {
    sendJson(res, 401, { error: "创建房间需要先登录账户" });
    return;
  }
  const parsed = readJsonBody(body);
  const name = typeof parsed.name === "string" ? parsed.name : "";
  const clientId = typeof parsed.clientId === "string" ? parsed.clientId : undefined;
  const roomIdOpt = typeof parsed.roomId === "string" && parsed.roomId.trim() ? parsed.roomId.trim() : undefined;
  const inviteOpt = typeof parsed.inviteCode === "string" && parsed.inviteCode.trim() ? parsed.inviteCode.trim() : undefined;
  // 创建时可选不生成访问码：此时任何人凭房间号即可加入（显式自定义邀请码优先）。
  const noInvite = parsed.noInvite === true && inviteOpt === undefined;
  if (!name.trim()) {
    sendJson(res, 400, { error: "房间名不能为空" });
    return;
  }
  let created: ReturnType<typeof registry.createRoom>;
  try {
    // hostName = 创建者用户名（房主显示名）；name = 房间名（展示用，与房主解耦）。
    created = registry.createRoom(hostUser, hostUser, clientId, { roomId: roomIdOpt, inviteCode: inviteOpt, noInvite, roomName: name });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    sendJson(res, message.includes("已被占用") ? 409 : 400, { error: message });
    return;
  }
  const { room, member, hostSecret } = created;
  sendJson(res, 200, {
    roomId: room.roomId,
    // 房间页徽标展示用。
    roomName: room.roomName,
    // 未生成访问码的房间返回 null，客户端不展示邀请链接。
    inviteCode: room.inviteCode,
    hostSecret,
    memberToken: member.token,
    clientId: member.clientId,
    role: member.role,
    expiresAt: member.expiresAt,
  });
}

async function handleJoinRoom(
  req: IncomingMessage,
  res: ServerResponse,
  roomId: string,
  body: string,
): Promise<void> {  const parsed = readJsonBody(body);
  // 可选 Bearer userToken：登录用户未填昵称（或仍是默认 Guest 名）时用其用户名。
  const username = accounts.authenticate(bearerToken(req));
  let name = typeof parsed.name === "string" ? parsed.name.trim() : "";
  if (username && (!name || /^guest/i.test(name))) name = username;
  const inviteCode = typeof parsed.inviteCode === "string" ? parsed.inviteCode : undefined;
  const hostSecret = typeof parsed.hostSecret === "string" ? parsed.hostSecret : undefined;
  // 登录用户凭账户身份进房（访问码只约束游客）；房主重建会话凭 hostSecret。
  const member = registry.joinRoom(roomId, name, { inviteCode, hostSecret, ...(username ? { asUser: username } : {}) });
  if (!member) {
    // 房间不存在与邀请码错误都返回 401，不暴露房间存在性。
    sendJson(res, 401, { error: "房间不存在或邀请码错误" });
    return;
  }
  sendJson(res, 200, {
    memberToken: member.token,
    clientId: member.clientId,
    role: member.role,
    expiresAt: member.expiresAt,
    name: member.name,
    // 房间页徽标展示用。
    roomName: registry.peek(roomId)?.roomName ?? "",
  });
}

/** 修改房间名（仅房主；纯展示字段）。 */
async function handleRenameRoom(req: IncomingMessage, res: ServerResponse, roomId: string, body: string): Promise<void> {
  const member = requireMember(req, res, roomId, { hostOnly: true });
  if (!member) return;
  const parsed = readJsonBody(body);
  const name = typeof parsed.name === "string" ? parsed.name : "";
  const result = registry.renameRoom(roomId, member, name);
  if (!result.ok) {
    if (result.reason === "no-room") sendJson(res, 404, { error: "房间不存在" });
    else if (result.reason === "bad-name") sendJson(res, 400, { error: "房间名不能为空" });
    else sendJson(res, 403, { error: "只有房主可以修改房间名" });
    return;
  }
  sendJson(res, 200, { roomName: registry.peek(roomId)?.roomName ?? "" });
}

/** 邀请码轮换（仅房主）：旧邀请码立即失效。 */
async function handleRotateInvite(req: IncomingMessage, res: ServerResponse, roomId: string): Promise<void> {
  const member = requireMember(req, res, roomId, { hostOnly: true });
  if (!member) return;
  const result = registry.rotateInvite(roomId, member);
  if (!result.ok) {
    if (result.reason === "no-room") sendJson(res, 404, { error: "房间不存在" });
    else if (result.reason === "no-invite") sendJson(res, 400, { error: "该房间未启用访问码，无需重置" });
    else sendJson(res, 403, { error: "只有房主可以重置邀请码" });
    return;
  }
  sendJson(res, 200, { inviteCode: result.inviteCode });
}

/**
 * 删除房间（仅房主本人或管理员）：注册表房间与内存同步房间一并清除，
 * 在线成员全部被踢（WS 4003）并回到大厅。房间不再因闲置自动消失，只能由此接口删除。
 */
async function handleDeleteRoom(req: IncomingMessage, res: ServerResponse, roomId: string): Promise<void> {
  const username = accounts.authenticate(bearerToken(req));
  if (!username) {
    sendJson(res, 401, { error: "删除房间需要先登录" });
    return;
  }
  const rec = registry.peek(roomId);
  if (!rec) {
    sendJson(res, 404, { error: "房间不存在" });
    return;
  }
  if (rec.hostUser !== username && !accounts.isAdmin(username)) {
    registry.audit({ roomId, action: "auth:forbidden", clientId: undefined, detail: "room-delete" });
    sendJson(res, 403, { error: "只有房主或管理员可以删除房间" });
    return;
  }
  // 先踢在线成员，再清注册表（成员令牌/邀请码/媒体映射随 syncframe.db 一并删除）。
  roomManager.destroyRoom(roomId);
  registry.disposeRoom(roomId);
  sendJson(res, 200, { ok: true });
}

async function handleBrowse(req: IncomingMessage, res: ServerResponse, url: URL, roomId: string | null): Promise<void> {
  if (!roomId) {
    sendJson(res, 400, { error: "缺少房间" });
    return;
  }
  const member = requireMember(req, res, roomId, { hostOnly: true });
  if (!member) return;
  const providerId = (url.searchParams.get("provider") ?? "").trim();
  if (!providerId) {
    sendJson(res, 400, { error: "缺少 provider 参数" });
    return;
  }
  // 只允许用房间创建者本人的 OpenList provider 浏览。
  const owner = requireRoomOwner(req, res, roomId);
  if (!owner) return;
  const dirPath = url.searchParams.get("path") ?? "/";
  const page = Math.max(1, Number(url.searchParams.get("page") ?? "1") || 1);
  try {
    const ol = await userOpenListClient(owner, providerId);
    if (!ol) {
      sendJson(res, 403, { error: "provider 不存在或不属于房间创建者" });
      return;
    }
    const data = await ol.client.listDir(dirPath, { page, perPage: 100 });
    const perPage = 100;
    sendJson(res, 200, {
      path: dirPath,
      parent: dirnameOf(dirPath),
      page,
      totalPages: Math.max(1, Math.ceil((data.total ?? 0) / perPage)),
      content: (data.content ?? []).map((c) => ({
        name: c.name,
        path: c.path ?? (dirPath === "/" ? `/${c.name}` : `${dirPath.replace(/\/+$/, "")}/${c.name}`),
        isDir: Boolean(c.is_dir),
        size: c.size ?? 0,
      })),
    });
  } catch (err) {
    sendJson(res, 502, { error: err instanceof Error ? err.message : String(err) });
  }
}

async function handleSearch(req: IncomingMessage, res: ServerResponse, url: URL, roomId: string | null): Promise<void> {
  if (!roomId) {
    sendJson(res, 400, { error: "缺少房间" });
    return;
  }
  const member = requireMember(req, res, roomId, { hostOnly: true });
  if (!member) return;
  const providerId = (url.searchParams.get("provider") ?? "").trim();
  if (!providerId) {
    sendJson(res, 400, { error: "缺少 provider 参数" });
    return;
  }
  const owner = requireRoomOwner(req, res, roomId);
  if (!owner) return;
  const keywords = (url.searchParams.get("keywords") ?? "").trim();
  const parent = url.searchParams.get("parent") ?? "/";
  const page = Math.max(1, Number(url.searchParams.get("page") ?? "1") || 1);
  if (!keywords) {
    sendJson(res, 400, { error: "缺少 keywords 参数" });
    return;
  }
  try {
    const ol = await userOpenListClient(owner, providerId);
    if (!ol) {
      sendJson(res, 403, { error: "provider 不存在或不属于房间创建者" });
      return;
    }
    const data = await ol.client.search(keywords, { parent, page, perPage: 50 });
    const perPage = 50;
    sendJson(res, 200, {
      keywords,
      page,
      totalPages: Math.max(1, Math.ceil((data.total ?? 0) / perPage)),
      content: (data.content ?? []).map((c) => ({
        name: c.name,
        parent: c.parent ?? "/",
        isDir: Boolean(c.is_dir),
        size: c.size ?? 0,
      })),
    });
  } catch (err) {
    sendJson(res, 502, { error: err instanceof Error ? err.message : String(err) });
  }
}

function dirnameOf(p: string): string {
  if (!p || p === "/") return "/";
  const trimmed = p.replace(/\/+$/, "");
  const i = trimmed.lastIndexOf("/");
  return i <= 0 ? "/" : trimmed.slice(0, i);
}

async function handleRegisterMedia(
  req: IncomingMessage,
  res: ServerResponse,
  roomId: string,
  body: string,
): Promise<void> {
  const member = requireMember(req, res, roomId, { hostOnly: true });
  if (!member) return;
  let parsed: Record<string, unknown>;
  try {
    parsed = readJsonBody(body);
  } catch (err) {
    sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
    return;
  }
  const provider = typeof parsed.provider === "string" ? parsed.provider.trim() : "";
  // 直链 provider：手动添加 {name, url}，注册即最终地址。
  if (provider === "direct") {
    const name = (typeof parsed.name === "string" ? parsed.name.trim() : "").slice(0, 128) || "直链视频";
    const url = typeof parsed.url === "string" ? parsed.url.trim() : "";
    if (!url) {
      sendJson(res, 400, { error: "缺少 url" });
      return;
    }
    try {
      const result = registry.registerMedia(roomId, member, "", { name, size: 0 }, [], { provider: "直链", directUrl: url });
      if ("error" in result) {
        sendJson(res, 403, { error: result.error });
        return;
      }
      sendJson(res, 200, { mediaId: result.mediaId, name, size: 0, related: result.related, provider: "直链" });
    } catch (err) {
      sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
    return;
  }
  // Bilibili provider：粘贴 BV 号 / av 号 / 番剧 ep/ss，服务端解析标题与分 P。
  // 凭证由当前浏览器经 X-Bili-Sessdata 提供（可选）；服务端即用即弃，不落盘、不共享。
  if (provider === "bilibili" || provider.startsWith("bilibili:")) {
    const rawUrl = typeof parsed.url === "string" ? parsed.url : (typeof parsed.bvid === "string" ? parsed.bvid : "");
    const ref = parseVideoId(rawUrl);
    if (!ref) {
      sendJson(res, 400, { error: "无法识别 bilibili 视频（支持 BV 号 / av 号 / 视频或番剧链接 / ep、ss 号）" });
      return;
    }
    try {
      const bc = bilibiliClientFor(requestSessdata(req));
      // 番剧（ep/ss）：走 pgc 接口取单集 cid；普通视频走 web-interface view。
      const info = ref.epId || ref.seasonId
        ? await bc.getBangumiInfo({ epId: ref.epId, seasonId: ref.seasonId })
        : await bc.getVideoInfo(ref);
      const result = registry.registerMedia(roomId, member, "", { name: info.title, size: 0 }, [], {
        provider: "哔哩哔哩",
        bilibili: { bvid: info.bvid, cid: info.cid, aid: info.aid, epId: info.epId },
      });
      if ("error" in result) {
        sendJson(res, 403, { error: result.error });
        return;
      }
      sendJson(res, 200, { mediaId: result.mediaId, name: info.title, size: 0, related: result.related, provider: "哔哩哔哩" });
    } catch (err) {
      sendJson(res, 502, { error: err instanceof Error ? err.message : String(err) });
    }
    return;
  }
  const filePath = typeof parsed.path === "string" ? parsed.path : "";
  if (!filePath) {
    sendJson(res, 400, { error: "缺少 path 参数" });
    return;
  }
  if (!provider) {
    sendJson(res, 400, { error: "缺少 provider（环境变量 OpenList 已移除，请选择账户 provider）" });
    return;
  }
  if (!filePath.startsWith("/") || filePath.split("/").includes("..")) {
    sendJson(res, 400, { error: "非法路径" });
    return;
  }
  // OpenList provider：必须用房间创建者本人的账户（X-User-Token）。
  const owner = requireRoomOwner(req, res, roomId);
  if (!owner) return;
  const ol = await userOpenListClient(owner, provider);
  if (!ol) {
    sendJson(res, 403, { error: "provider 不存在或不属于房间创建者" });
    return;
  }
  const user = accounts.getUser(owner)!;
  try {
    const detail = await resolveWithClient(ol.client, ol.baseUrl, filePath, "SyncFrame-PoC/0.1");
    const result = registry.registerMedia(roomId, member, filePath, { name: detail.name, size: detail.size }, detail.related, {
      provider: user.providers.get(provider)!.label,
      providerOwner: owner,
      providerId: provider,
    });
    if ("error" in result) {
      sendJson(res, 403, { error: result.error });
      return;
    }
    sendJson(res, 200, { mediaId: result.mediaId, name: detail.name, size: detail.size, related: result.related, provider: user.providers.get(provider)!.label });
  } catch (err) {
    sendJson(res, 502, { error: err instanceof Error ? err.message : String(err) });
  }
}

async function handleListMedia(req: IncomingMessage, res: ServerResponse, roomId: string): Promise<void> {
  const member = registry.authenticate(roomId, bearerToken(req));
  if (!member) {
    sendJson(res, 401, { error: "成员令牌无效或已过期" });
    return;
  }
  const list = registry.listMedia(roomId);
  if (!list) {
    sendJson(res, 404, { error: "房间不存在" });
    return;
  }
  sendJson(res, 200, { media: list });
}

async function handleDeleteMedia(req: IncomingMessage, res: ServerResponse, roomId: string, mediaId: string): Promise<void> {
  const member = requireMember(req, res, roomId, { hostOnly: true });
  if (!member) return;
  if (!registry.removeMedia(roomId, mediaId, member.clientId)) {
    sendJson(res, 404, { error: "媒体不存在" });
    return;
  }
  sendJson(res, 200, { ok: true });
}

// ── Bilibili 播放地址解析（凭证请求内即用即弃）────────────────────────────

const BILIBILI_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

/** 为上游地址签发短时票据，返回浏览器可用的 /stream 反代地址。 */
function issueStreamUrl(
  roomId: string,
  mediaId: string,
  member: MemberRecord,
  track: "video" | "audio",
  upstreamUrl: string,
  opts: { kind?: StreamTicket["kind"]; referer?: string; userAgent?: string; fileName?: string } = {},
): string {
  const ticket = randomUUID();
  streamTickets.set(ticket, {
    kind: opts.kind ?? "bilibili",
    roomId,
    mediaId,
    memberClientId: member.clientId,
    track,
    upstreamUrl,
    referer: opts.referer,
    userAgent: opts.userAgent,
    fileName: opts.fileName,
    expiresAt: Date.now() + STREAM_TICKET_TTL_MS,
  });
  return `/api/rooms/${encodeURIComponent(roomId)}/media/${encodeURIComponent(mediaId)}/stream?ticket=${encodeURIComponent(ticket)}`;
}

/**
 * 解析 B 站播放地址。凭证只在本请求内使用，解析完即丢弃。
 * - 直连可用（mcdn 不校验 Referer）→ 下发 CDN 地址，浏览器直拉，服务器不耗带宽；
 * - 否则 → 下发 /stream 票据地址，由服务端反代兜底。
 * 两种情况都附带反代地址，供前端在直连失败时自动回落。
 */
async function resolveBilibiliMedia(
  roomId: string,
  mediaId: string,
  member: MemberRecord,
  entry: MediaEntry,
  sessdata: string | null,
) {
  const bc = bilibiliClientFor(sessdata);
  const play = await getPlayUrlCached(
    bc,
    { bvid: entry.bilibili!.bvid, cid: entry.bilibili!.cid, epId: entry.bilibili!.epId },
    credentialFingerprint(sessdata),
  );
  const proxyVideo = issueStreamUrl(roomId, mediaId, member, "video", play.url);
  const proxyAudio = play.audioUrl
    ? issueStreamUrl(roomId, mediaId, member, "audio", play.audioUrl)
    : undefined;
  const anonymous = !sessdata;
  if (play.directOk) {
    return {
      url: play.url,
      audioUrl: play.audioUrl,
      fallbackUrl: proxyVideo,
      fallbackAudioUrl: proxyAudio,
      direct: true,
      anonymous,
      name: entry.name,
      size: 0,
    };
  }
  return {
    url: proxyVideo,
    audioUrl: proxyAudio,
    direct: false,
    anonymous,
    name: entry.name,
    size: 0,
  };
}

async function handleGrant(
  req: IncomingMessage,
  res: ServerResponse,
  roomId: string,
  mediaId: string,
): Promise<void> {
  const member = registry.authenticate(roomId, bearerToken(req));
  if (!member) {
    sendJson(res, 401, { error: "成员令牌无效或已过期" });
    return;
  }
  const sessdata = requestSessdata(req);
  try {
    const grant = await registry.grant(roomId, mediaId, member, (entry) => {
      if (entry.bilibili) {
        return resolveBilibiliMedia(roomId, mediaId, member, entry, sessdata);
      }
      // OpenList provider：用注册者（房间创建者）的凭据解析（凭据不出服务端）。
      if (entry.providerOwner && entry.providerId) {
        return userOpenListClient(entry.providerOwner, entry.providerId).then(async (ol) => {
          if (!ol) throw new Error("provider 不可用");
          const resolved = await resolveWithClient(ol.client, ol.baseUrl, entry.path, req.headers["user-agent"] ?? "SyncFrame-PoC/0.1");
          // 跨域修复：网盘存储后端不对浏览器放行 CORS，movi-player 的 fetch/Range 拉流会被拦截。
          // 与 B 站一致改走 /stream 票据反代（票据绑定已解析的上游地址，Range/HEAD 透传），
          // 带 OpenList 源站 Referer（部分存储防盗链校验）与播放端 UA（部分存储按 UA 校验）。
          const streamUrl = issueStreamUrl(roomId, mediaId, member, "video", resolved.url, {
            kind: "openlist",
            referer: `${ol.baseUrl}/`,
            userAgent: req.headers["user-agent"] ?? "SyncFrame-PoC/0.1",
            fileName: resolved.name,
          });
          return { ...resolved, url: streamUrl };
        });
      }
      throw new Error("媒体来源 provider 不可用");
    }, credentialFingerprint(sessdata));
    if (!grant) {
      // 跨房间/未注册 mediaId：404，不暴露存在性（P3 通过门槛：不能越权访问其他媒体）。
      sendJson(res, 404, { error: "媒体不存在或未授权" });
      return;
    }
    sendJson(res, 200, grant);
  } catch (err) {
    sendJson(res, 502, { error: err instanceof Error ? err.message : String(err) });
  }
}

// ── Bilibili 流反代：浏览器 <video> 无法带 Referer，由服务端代拉流并透传 Range ──

/** OpenList 反代的扩展名 → MIME（上游未给 Content-Type 时兜底用）。 */
const OPENLIST_STREAM_MIME: Record<string, string> = {
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".mkv": "video/x-matroska",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".avi": "video/x-msvideo",
  ".ts": "video/mp2t",
  ".mpg": "video/mpeg",
  ".mpeg": "video/mpeg",
  ".flv": "video/x-flv",
  ".wmv": "video/x-ms-wmv",
  ".rmvb": "application/vnd.rn-realmedia-vbr",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".flac": "audio/flac",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
  ".srt": "application/x-subrip",
  ".vtt": "text/vtt",
  ".ass": "text/x-ssa",
  ".ssa": "text/x-ssa",
};

/**
 * /stream 响应 Content-Type：
 * - bilibili：固定 video/mp4（DASH 分段即 mp4，行为不变）；
 * - openlist：优先透传上游；上游是 octet-stream 或未给时按扩展名推断，兜底 video/mp4。
 */
function streamContentType(t: StreamTicket, upstreamType: string | null): string {
  if (t.kind === "openlist") {
    if (upstreamType && upstreamType !== "application/octet-stream") return upstreamType;
    const name = t.fileName ?? "";
    const ext = name.slice(name.lastIndexOf(".")).toLowerCase();
    return OPENLIST_STREAM_MIME[ext] ?? "video/mp4";
  }
  return "video/mp4";
}

async function handleStream(
  req: IncomingMessage,
  res: ServerResponse,
  roomId: string,
  mediaId: string,
  url: URL,
): Promise<void> {
  // 票据鉴权：ticket 绑定 room+media+track+成员，并携带已解析的上游地址。
  // 这里不出现任何凭证 —— 前端拿不到凭证，也不需要成员令牌。
  const ticketId = url.searchParams.get("ticket");
  const t = ticketId ? streamTickets.get(ticketId) : undefined;
  const trackParam = url.searchParams.get("track");
  if (
    !t || t.expiresAt <= Date.now() || t.roomId !== roomId || t.mediaId !== mediaId
    || (trackParam !== null && trackParam !== t.track)
    || !registry.hasMemberClient(roomId, t.memberClientId)
  ) {
    sendJson(res, 401, { error: "票据无效或已过期" });
    return;
  }
  const isHead = req.method === "HEAD";
  const ip = clientIp(req);
  if (!isHead) {
    // 拉流限流按票据计（每张票据 = 一个房间/媒体/轨道的合法授权），不按 IP：
    //  - 播放器按固定块大小预读（实测 512KB/块），一分钟数百次 Range 属正常行为；
    //  - 同 IP 下多人（NAT/办公室）各自有票据，不应互相挤爆。
    // 这里只做"失控保护"：阈值远高于正常播放，真正的滥用由 grant/join 限流与并发上限兜住。
    if (!rateLimit("stream", ticketId!)) {
      res.setHeader("Retry-After", "2");
      sendJson(res, 429, { error: "拉流请求过于频繁，请稍后再试" });
      return;
    }
    // 单 IP 并发流上限：视频 + 音频各 1 条，seek 期间可能短暂多出 1-2 条。
    const concurrent = activeStreams.get(ip) ?? 0;
    if (concurrent >= 8) {
      sendJson(res, 503, { error: "同 IP 并发流过多" });
      return;
    }
    activeStreams.set(ip, concurrent + 1);
    res.on("close", () => {
      const n = (activeStreams.get(ip) ?? 1) - 1;
      if (n <= 0) activeStreams.delete(ip);
      else activeStreams.set(ip, n);
    });
  }
  try {
    const range = req.headers.range;
    // 上游请求头按票据类型区分：B 站 CDN 需要桌面 UA + B 站 Referer；
    // OpenList 存储后端按 OpenList 源站 Referer 防盗链，UA 与播放端保持一致。
    const upstreamHeaders: Record<string, string> = t.kind === "openlist"
      ? {
          "User-Agent": t.userAgent ?? "SyncFrame-PoC/0.1",
          ...(t.referer ? { Referer: t.referer } : {}),
        }
      : {
          "User-Agent": BILIBILI_UA,
          Referer: "https://www.bilibili.com",
        };
    if (range) upstreamHeaders.Range = range;
    // R4：按客户端方法透传，避免 HEAD 探测被当成 GET 把整片拉下来。
    const upstream = await fetch(t.upstreamUrl, {
      method: isHead ? "HEAD" : "GET",
      headers: upstreamHeaders,
    });
    if (isHead && !upstream.ok) {
      // 实测：B 站 CDN 不支持 HEAD（404）。用 bytes=0-0 探测总长度，供播放器确定文件大小。
      const probe = await fetch(t.upstreamUrl, { headers: { ...upstreamHeaders, Range: "bytes=0-0" } });
      const total = probe.headers.get("content-range")?.match(/\/(\d+)\s*$/)?.[1];
      await probe.body?.cancel().catch(() => {});
      if (total) {
        res.writeHead(200, { "Content-Type": streamContentType(t, null), "Content-Length": total, "Accept-Ranges": "bytes" });
        res.end();
        return;
      }
    }
    res.writeHead(upstream.status, {
      // R5：上游是 application/octet-stream，播放器需要明确的容器类型。
      "Content-Type": streamContentType(t, upstream.headers.get("content-type")),
      ...(upstream.headers.get("content-length")
        ? { "Content-Length": upstream.headers.get("content-length")! }
        : {}),
      ...(upstream.headers.get("content-range")
        ? { "Content-Range": upstream.headers.get("content-range")! }
        : {}),
      "Accept-Ranges": "bytes",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
    });
    if (isHead || !upstream.body || upstream.status === 204) {
      res.end();
      return;
    }
    // 手动逐段泵送（Node 18 fetch 的 body 是 web ReadableStream）。
    // M1：加背压（write 返回 false 时等 drain）与上游取消（客户端断开时 reader.cancel），
    // 避免慢连接堆内存打满进程、seek/关页面后上游连接泄漏。
    const reader = upstream.body.getReader();
    let stopped = false;
    const stop = (): void => {
      if (stopped) return;
      stopped = true;
      void reader.cancel().catch(() => {});
    };
    req.on("close", stop);
    res.on("close", stop);
    const pump = async (): Promise<void> => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done || stopped) break;
          if (!res.write(Buffer.from(value))) {
            await new Promise<void>((resolve) => res.once("drain", resolve));
          }
        }
      } catch (err) {
        if (!stopped) {
          console.warn(`[stream] ${t.kind} 拉流中断 media=${mediaId}: ${err instanceof Error ? err.message : err}`);
        }
      }
      if (!stopped) res.end();
    };
    void pump();
  } catch (err) {
    if (!res.headersSent) sendJson(res, 502, { error: err instanceof Error ? err.message : String(err) });
    else res.end();
  }
}

// ── 基础限流（PoC：单进程内存滑动窗口，防爆破/防刷）────────────────────────

interface RateBucket {
  timestamps: number[];
  windowMs: number;
}
const rateBuckets = new Map<string, RateBucket>();
// M2：过期桶定期清扫（伪造 IP 刷请求时 rateBuckets 会以 IP 为 key 无上限增长）。
const rateBucketSweep = setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of rateBuckets) {
    bucket.timestamps = bucket.timestamps.filter((t) => t > now - bucket.windowMs);
    if (bucket.timestamps.length === 0) rateBuckets.delete(key);
  }
}, 5 * 60_000);
rateBucketSweep.unref();

const RATE_LIMITS: Record<string, { windowMs: number; max: number }> = {
  join: { windowMs: 60_000, max: 20 },
  grant: { windowMs: 60_000, max: 60 },
  "ws-reject": { windowMs: 60_000, max: 30 },
  login: { windowMs: 60_000, max: 10 },
  stream: { windowMs: 60_000, max: 6000 },
};

/** 返回 true 表示放行；false 表示超限（调用方回 429）。窗口边缘惰性清理。 */
function rateLimit(action: string, key: string): boolean {
  const limit = RATE_LIMITS[action];
  if (!limit) return true;
  const now = Date.now();
  const bucketKey = `${action}:${key}`;
  let bucket = rateBuckets.get(bucketKey);
  if (!bucket) {
    bucket = { timestamps: [], windowMs: limit.windowMs };
    rateBuckets.set(bucketKey, bucket);
  }
  bucket.timestamps = bucket.timestamps.filter((t) => t > now - limit.windowMs);
  if (bucket.timestamps.length >= limit.max) return false;
  bucket.timestamps.push(now);
  return true;
}

// M2：登录失败锁定——同一用户名连续 5 次失败锁 5 分钟（防撞库）。
const loginFailures = new Map<string, { count: number; lockedUntil: number }>();
function loginThrottled(username: string): boolean {
  const rec = loginFailures.get(username);
  return !!rec && rec.lockedUntil > Date.now();
}
function recordLoginFailure(username: string): void {
  const rec = loginFailures.get(username) ?? { count: 0, lockedUntil: 0 };
  rec.count += 1;
  if (rec.count >= 5) {
    rec.lockedUntil = Date.now() + 5 * 60_000;
    rec.count = 0;
  }
  loginFailures.set(username, rec);
}
function clearLoginFailures(username: string): void {
  loginFailures.delete(username);
}

// M2：默认不信任 X-Forwarded-For（直连部署下客户端可伪造）。
// 仅当前面确实挂了会覆盖该头的可信反代时，设 TRUST_PROXY=1 才读取，且取最右侧一跳。
const TRUST_PROXY = process.env.TRUST_PROXY === "1";

function clientIp(req: IncomingMessage): string {
  if (TRUST_PROXY) {
    const fwd = req.headers["x-forwarded-for"];
    if (typeof fwd === "string" && fwd.length > 0) {
      const parts = fwd.split(",").map((s) => s.trim()).filter(Boolean);
      if (parts.length > 0) return parts[parts.length - 1];
    }
  }
  return req.socket.remoteAddress ?? "unknown";
}

/**
 * /stream 票据有效期：与成员令牌同量级（12h）。
 * 票据绑定「房间 + 媒体 + 轨道 + 成员」，成员被移除即刻失效，
 * 因此不需要靠"短 TTL + 定时换票"来控权——而定时换票会重载播放器、打断播放。
 * 真正的硬限制是 B 站 CDN 地址自身的 sign（约 2h），到期由错误恢复流程重新 playurl。
 */
const STREAM_TICKET_TTL_MS = 12 * 60 * 60 * 1000;

interface StreamTicket {
  /** bilibili：上游是 B 站 CDN（带 B 站 UA/Referer，固定 video/mp4）；
   *  openlist：上游是网盘存储直链（带 OpenList 源站 Referer，Content-Type 按上游/扩展名推断）。 */
  kind: "bilibili" | "openlist";
  roomId: string;
  mediaId: string;
  memberClientId: string;
  track: "video" | "audio";
  /** 已解析的上游地址（不含任何凭证）；/stream 直接代理，不再二次解析。 */
  upstreamUrl: string;
  /** openlist：上游防盗链 Referer（OpenList 源站）。 */
  referer?: string;
  /** openlist：播放端 UA（部分存储按 UA 生成/校验直链）。 */
  userAgent?: string;
  /** openlist：文件名（用于推断 Content-Type）。 */
  fileName?: string;
  expiresAt: number;
}

const streamTickets = new Map<string, StreamTicket>();
const activeStreams = new Map<string, number>();
const streamTicketSweep = setInterval(() => {
  const now = Date.now();
  for (const [key, t] of streamTickets) {
    if (t.expiresAt <= now) streamTickets.delete(key);
  }
}, 60_000);
streamTicketSweep.unref();

// ── 静态资源托管（单容器部署：后端直接出前端构建产物；反向代理由用户自行设置）──
// 仅当 WEB_DIST 指向 Vite 构建产物目录时启用；本地开发仍走 Vite（HMR + 代理）。
const WEB_DIST = (process.env.WEB_DIST ?? "").replace(/\/+$/, "");

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
};

/** 托管 Vite 多页构建产物。返回 true 表示请求已处理；路径穿越已防护。 */
async function tryServeStatic(res: ServerResponse, pathname: string): Promise<boolean> {
  if (!WEB_DIST) return false;
  let rel: string;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    return false;
  }
  const distRoot = path.resolve(WEB_DIST);
  const clean = path.normalize(rel).replace(/^([/\\])+/, "");
  let filePath = path.join(distRoot, clean);
  if (filePath !== distRoot && !filePath.startsWith(distRoot + path.sep)) return false;
  let info = await stat(filePath).catch(() => null);
  if (info?.isDirectory()) {
    filePath = path.join(filePath, "index.html");
    info = await stat(filePath).catch(() => null);
  }
  if (!info?.isFile()) {
    // 多页应用：/lobby、/room 这类无扩展路径补 .html 再试一次
    if (filePath.endsWith(".html")) return false;
    const alt = `${filePath}.html`;
    const altInfo = await stat(alt).catch(() => null);
    if (!altInfo?.isFile()) return false;
    filePath = alt;
    info = altInfo;
  }
  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, {
    "Content-Type": MIME_TYPES[ext] ?? "application/octet-stream",
    "Content-Length": info.size,
    // 带内容哈希的静态资源长缓存；HTML 不缓存（保证发版即生效）
    "Cache-Control": ext === ".html" ? "no-cache" : "public, max-age=31536000, immutable",
    ...SECURITY_HEADERS,
  });
  createReadStream(filePath).pipe(res);
  return true;
}

// ── HTTP 路由 ───────────────────────────────────────────────

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  try {
    if (url.pathname === "/api/health") {
      sendJson(res, 200, {
        ok: true,
        rooms: roomManager.roomCount(),
        registryRooms: registry.roomCount(),
        hasAdmin: process.env.ADMIN_USERNAME ? accounts.isAdmin(process.env.ADMIN_USERNAME.trim()) : false,
        injectLatencyMs: Number(process.env.SYNC_INJECT_LATENCY_MS ?? 0),
        injectJitterMs: Number(process.env.SYNC_INJECT_JITTER_MS ?? 0),
      });
    } else if (url.pathname === "/api/rooms" && req.method === "POST") {
      await handleCreateRoom(req, res, await readBody(req));
    } else if (url.pathname === "/api/rooms" && req.method === "GET") {
      // P4 大厅房间列表（公开摘要：房间号/房主昵称/人数/视频数/是否有访问码/当前用户可否删除）。
      // 可选 Bearer userToken：登录后标记自己创建的房间，大厅据此展示「删除」按钮。
      const viewer = accounts.authenticate(bearerToken(req));
      // 在线人数以内存同步房间为准：注册表成员记录保留 12h（令牌有效期内可重连），
      // 直接数它会把你已退出房间的人也算成"在线"。
      const rooms = registry.listRooms(viewer ?? undefined).map((r) => ({
        ...r,
        memberCount: roomManager.peek(r.roomId)?.memberCount() ?? 0,
      }));
      sendJson(res, 200, { rooms });
    } else if (url.pathname === "/api/auth/login" && req.method === "POST") {
      // M2：登录接口限流（10 次/分钟/IP），配合用户名级失败锁定防撞库。
      if (!rateLimit("login", clientIp(req))) {
        sendJson(res, 429, { error: "尝试过于频繁，请稍后再试" });
        return;
      }
      await handleLogin(req, res, await readBody(req));
    } else if (url.pathname === "/api/bilibili/login/qrcode" && req.method === "GET") {
      await handleBiliQrCode(req, res);
    } else if (url.pathname === "/api/bilibili/login/poll" && req.method === "GET") {
      await handleBiliQrPoll(req, res, url);
    } else if (url.pathname === "/api/me" && req.method === "GET") {
      handleMe(req, res);
    } else if (url.pathname === "/api/me/providers" && req.method === "PUT") {
      await handleSetProviders(req, res, await readBody(req));
    } else if (url.pathname === "/api/admin/users" && req.method === "GET") {
      handleAdminListUsers(req, res);
    } else if (url.pathname === "/api/admin/users" && req.method === "POST") {
      await handleAdminCreateUser(req, res, await readBody(req));
    } else if (url.pathname.startsWith("/api/admin/users/") && req.method === "DELETE") {
      await handleAdminDeleteUser(req, res, decodeURIComponent(url.pathname.split("/")[4]));
    } else if (url.pathname.startsWith("/api/admin/users/") && req.method === "POST" && url.pathname.endsWith("/password")) {
      await handleAdminResetPassword(req, res, decodeURIComponent(url.pathname.split("/")[4]), await readBody(req));
    } else if (url.pathname.startsWith("/api/rooms/") && req.method === "POST" && url.pathname.endsWith("/join")) {
      if (!rateLimit("join", clientIp(req))) {
        sendJson(res, 429, { error: "尝试过于频繁，请稍后再试" });
        return;
      }
      await handleJoinRoom(req, res, url.pathname.split("/")[3], await readBody(req));
    } else if (url.pathname.startsWith("/api/rooms/") && req.method === "DELETE" && url.pathname.split("/")[4] === "media") {
      const parts = url.pathname.split("/"); // ["","api","rooms",:id,"media",:mediaId]
      await handleDeleteMedia(req, res, parts[3], parts[5]);
    } else if (url.pathname.startsWith("/api/rooms/") && req.method === "DELETE") {
      await handleDeleteRoom(req, res, url.pathname.split("/")[3]);
    } else if (url.pathname.startsWith("/api/rooms/") && req.method === "POST" && url.pathname.endsWith("/invite/rotate")) {
      await handleRotateInvite(req, res, url.pathname.split("/")[3]);
    } else if (url.pathname.startsWith("/api/rooms/") && req.method === "POST" && url.pathname.endsWith("/rename")) {
      await handleRenameRoom(req, res, url.pathname.split("/")[3], await readBody(req));
    } else if (url.pathname === "/api/browse" && req.method === "GET") {
      await handleBrowse(req, res, url, url.searchParams.get("room"));
    } else if (url.pathname === "/api/search" && req.method === "GET") {
      await handleSearch(req, res, url, url.searchParams.get("room"));
    } else if (url.pathname.startsWith("/api/rooms/") && req.method === "POST" && url.pathname.endsWith("/media")) {
      await handleRegisterMedia(req, res, url.pathname.split("/")[3], await readBody(req));
    } else if (url.pathname.startsWith("/api/rooms/") && req.method === "GET" && url.pathname.endsWith("/media")) {
      await handleListMedia(req, res, url.pathname.split("/")[3]);
    } else if (url.pathname.startsWith("/api/rooms/") && req.method === "GET" && url.pathname.endsWith("/grant")) {
      if (!rateLimit("grant", clientIp(req))) {
        sendJson(res, 429, { error: "授权请求过于频繁，请稍后再试" });
        return;
      }
      const parts = url.pathname.split("/"); // ["","api","rooms",:id,"media",:mediaId,"grant"]
      await handleGrant(req, res, parts[3], parts[5]);
    } else if (url.pathname.startsWith("/api/rooms/") && (req.method === "GET" || req.method === "HEAD") && url.pathname.endsWith("/stream")) {
      const parts = url.pathname.split("/"); // ["","api","rooms",:id,"media",:mediaId,"stream"]
      await handleStream(req, res, parts[3], parts[5], url);
    } else if (req.method === "GET" && (await tryServeStatic(res, url.pathname))) {
      // 静态资源（单容器部署：WEB_DIST 指向 Vite 构建产物；本地开发走 Vite 不经过这里）
    } else {
      sendJson(res, 404, { error: "not found" });
    }
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
});

// P3：WebSocket 房间端点。M3：令牌优先经子协议 sf.token.<memberToken> 传递（不进 URL），
// 兼容期仍接受 ?token= query（旧客户端/测试）。
const wss = new WebSocketServer({
  noServer: true,
  // 回写协商子协议：浏览器只接受被服务端 echo 的那一项。
  handleProtocols: (protocols) => (protocols.has("syncframe.v1") ? "syncframe.v1" : false),
});
server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  if (url.pathname !== "/ws") {
    socket.destroy();
    return;
  }
  const roomId = (url.searchParams.get("room") || "").trim().slice(0, 64);
  // M3：从 Sec-WebSocket-Protocol 取 sf.token.<token>（URL 里不再出现 12h 令牌）。
  const protoHeader = String(req.headers["sec-websocket-protocol"] ?? "");
  const protoToken = protoHeader
    .split(",")
    .map((s) => s.trim())
    .find((s) => s.startsWith("sf.token."))
    ?.slice("sf.token.".length) ?? null;
  const token = protoToken ?? url.searchParams.get("token");
  const member = registry.authenticate(roomId, token);
  if (!member) {
    // 未知房间/无效令牌：拒绝升级（P3 房间鉴权门）。
    if (!rateLimit("ws-reject", clientIp(req))) {
      socket.destroy();
      return;
    }
    registry.audit({ roomId: roomId || "-", action: "auth:ws-rejected", detail: token ? `fp=${tokenFingerprint(token)}` : "no-token" });
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    roomManager.handleJoin(ws, roomId, member);
  });
});

// 房间生命周期：注册表房间不再因闲置自动消失——只有房主/管理员显式删除
// （DELETE /api/rooms/:id）才会清除；全员离开后内存同步房间照常回收，下次加入自动重建。
// 成员令牌 12h 过期、邀请码随 syncframe.db 持久化，重启/刷新均可凭原凭据恢复。

server.listen(PORT, () => {
  console.log(`SyncFrame 已启动: http://localhost:${PORT}${WEB_DIST ? "（含前端静态资源，单端口）" : ""}`);
  console.log(`  数据目录: ${path.resolve(DATA_DIR)}（账户/房间持久化；含凭据，请保持私有）`);
  if (WEB_DIST) console.log(`  静态资源目录: ${WEB_DIST}`);
  else console.log("  提示: 未设置 WEB_DIST，仅提供 API/WS（前端请用 Vite 开发服务器或另行托管）");
  console.log(`  POST /api/auth/login | GET /api/me | PUT /api/me/providers   （账户与 provider；注册已关闭）`);
  console.log(`  GET/POST/DELETE /api/admin/users…   （管理员账户管理）`);
  console.log(`  GET  /api/rooms | POST /api/rooms（需登录）| /api/rooms/:id/join   （房间列表 + 房间鉴权）`);
  console.log(`  GET  /api/browse?room=&provider= | /api/search?provider=&keywords=   （房主本人媒体库）`);
  console.log(`  POST /api/rooms/:id/media | GET .../media/:mediaId/grant   （受控映射 + 媒体地址）`);
  console.log(`  POST media {provider:"bilibili", url}  支持 BV/av/视频链接/番剧 ep、ss（凭证走 X-Bili-Sessdata，可选）`);
  console.log(`  GET  .../media/:mediaId/stream?ticket=   （流反代兜底：B 站 CDN / OpenList 存储，Range/HEAD 透传，票据绑定上游地址）`);
  console.log(`  WS   /ws?room=<id>（子协议 sf.token.*）   （凭成员令牌入场）`);
});
