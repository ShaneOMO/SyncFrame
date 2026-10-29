/**
 * SyncFrame 后端：账户/角色权限 + 房间鉴权 + mediaId 受控映射 + provider 媒体库。
 *
 * 权限模型：
 * - 游客（未登录）：只能凭邀请码加入房间、观看；不能创建房间、不能配置 provider；
 * - 用户（登录）：可创建房间、配置自己的 provider（OpenList 凭据 / Bilibili SESSDATA）；
 * - 管理员：由环境变量 ADMIN_USERNAME / ADMIN_PASSWORD 初始化，负责创建/删除/重置密码全部账户。
 *   注册接口已关闭。
 *
 * 接口：
 *  - GET  /api/health                                存活检查
 *  - POST /api/auth/login        {username,password} → userToken（无注册接口）
 *  - GET  /api/me                  (Bearer userToken)  当前用户（含 role）+ provider 列表（不含凭据）
 *  - PUT  /api/me/providers        (Bearer userToken)  全量替换自己的 provider 配置
 *  - GET  /api/admin/users         (Bearer admin)      账户列表（不含凭据）
 *  - POST /api/admin/users         (Bearer admin)      创建账户
 *  - DELETE /api/admin/users/:name (Bearer admin)      删除账户
 *  - POST /api/admin/users/:name/password (Bearer admin) 重置密码
 *  - GET  /api/rooms                                   公开房间列表（大厅）
 *  - POST /api/rooms            (Bearer userToken) {name} → {roomId, inviteCode, memberToken, ...}
 *                                                    （游客 401：创建房间必须登录）
 *  - POST /api/rooms/:id/join   {name, inviteCode?, clientId?}（公开，凭邀请码）
 *  - GET  /api/browse?provider=&path=&page=           列目录（仅房主本人账户 + X-User-Token）
 *  - GET  /api/search?provider=&keywords=&parent=&page= 搜索（同上）
 *  - POST /api/rooms/:id/media  注册媒体（仅房主）。三种形态：
 *      {provider:"direct", name, url}                 直链（校验 http/https、禁带凭证）
 *      {provider:"bilibili", url}                     B 站视频（BV/av/链接，服务端解析标题与分 P）
 *      {provider:<id>, path} + X-User-Token           房主本人账户的 OpenList provider
 *      {provider:"bilibili:<id>", url} + X-User-Token 房主本人账户的 Bilibili provider
 *    自动注册同目录外挂字幕（srt/ass/ssa/vtt）
 *  - GET  /api/rooms/:id/media/:mediaId/grant        签发短期媒体访问凭证（房间成员；跨房间 404）
 *  - GET  /api/rooms/:id/media/:mediaId/stream?token=  Bilibili 流反代（透传 Range，代发 Referer）
 *
 *  - WS   /ws?room=<id>&token=<memberToken>          同步房间（凭成员令牌入场）
 *
 * 令牌缓存于内存；provider 凭据只存在于服务端；不再从环境变量读取 OpenList。
 * 审计日志见 [audit] 行：只含 roomId/mediaId/clientId/动作，不含令牌、签名 URL 或文件路径。
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { WebSocketServer } from "ws";
import { OpenListClient } from "@syncframe/openlist-adapter";
import { RoomManager } from "./sync-rooms.ts";
import { RoomRegistry, tokenFingerprint } from "./room-auth.ts";
import type { MemberRecord } from "./room-auth.ts";
import { UserAccounts } from "./user-accounts.ts";
import type { ProviderConfig } from "./user-accounts.ts";
import { BilibiliClient, getPlayUrlCached, parseVideoId } from "./bilibili.ts";

const PORT = Number(process.env.SERVER_PORT ?? 8787);

// P4：账户系统。管理员由环境变量初始化（注册接口已关闭）；
// OpenList / Bilibili 凭据不再来自环境变量，全部由各账户在 provider 配置中自行保存。
const accounts = new UserAccounts();
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
const registry = new RoomRegistry({  onAudit: (ev) => {
    const fp = ev.clientId ? ` member=${ev.clientId}` : "";
    const mid = ev.mediaId ? ` media=${ev.mediaId}` : "";
    const detail = ev.detail ? ` ${ev.detail}` : "";
    console.log(`[audit] room=${ev.roomId}${fp}${mid} action=${ev.action}${detail}`);
  },
});

// 房主私有 OpenList provider 的客户端缓存（凭据不出服务端）。
const userClients = new Map<string, { client: OpenListClient; baseUrl: string }>();

// Bilibili provider：内置匿名客户端 + 用户私有（带 SESSDATA cookie）客户端缓存。
const anonBilibili = new BilibiliClient();
const userBilibiliClients = new Map<string, BilibiliClient>();

function bilibiliClientFor(provider: ProviderConfig | undefined): BilibiliClient {
  if (provider && provider.kind === "bilibili" && provider.cookie) {
    let cached = userBilibiliClients.get(provider.id);
    if (!cached) {
      cached = new BilibiliClient({ cookie: provider.cookie });
      userBilibiliClients.set(provider.id, cached);
    }
    return cached;
  }
  return anonBilibili;
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

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
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

// ── 账户 / provider 配置 / 管理员 / 公开房间列表 ───────────────────────────

async function handleLogin(req: IncomingMessage, res: ServerResponse, body: string): Promise<void> {
  const parsed = readJsonBody(body);
  const token = accounts.login(
    typeof parsed.username === "string" ? parsed.username : "",
    typeof parsed.password === "string" ? parsed.password : "",
  );
  if (!token) {
    sendJson(res, 401, { error: "用户名或密码错误" });
    return;
  }
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
  userBilibiliClients.clear();
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
  // bilibili cookie 可能被替换：全部重建（PoC 规模下成本可忽略）。
  userBilibiliClients.clear();
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
  const name = typeof parsed.name === "string" ? parsed.name : "房主";
  const clientId = typeof parsed.clientId === "string" ? parsed.clientId : undefined;
  const { room, member, hostSecret } = registry.createRoom(name, hostUser, clientId);
  sendJson(res, 200, {
    roomId: room.roomId,
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
  const name = typeof parsed.name === "string" ? parsed.name : "Guest";
  const inviteCode = typeof parsed.inviteCode === "string" ? parsed.inviteCode : undefined;
  const hostSecret = typeof parsed.hostSecret === "string" ? parsed.hostSecret : undefined;
  const member = registry.joinRoom(roomId, name, { inviteCode, hostSecret });
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
  });
}

/** 邀请码轮换（仅房主）：旧邀请码立即失效。 */
async function handleRotateInvite(req: IncomingMessage, res: ServerResponse, roomId: string): Promise<void> {
  const member = requireMember(req, res, roomId, { hostOnly: true });
  if (!member) return;
  const result = registry.rotateInvite(roomId, member);
  if (!result.ok) {
    sendJson(res, result.reason === "no-room" ? 404 : 403, { error: "房间不存在或只有房主可以重置邀请码" });
    return;
  }
  sendJson(res, 200, { inviteCode: result.inviteCode });
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
  // Bilibili provider：粘贴 BV 号 / av 号 / bilibili 链接，服务端解析标题与分 P（参考 SyncTV）。
  // 内置匿名；也可在 provider 配置里绑定 SESSDATA cookie 的私有 bilibili provider（更高画质）。
  if (provider === "bilibili" || provider.startsWith("bilibili:")) {
    const rawUrl = typeof parsed.url === "string" ? parsed.url : (typeof parsed.bvid === "string" ? parsed.bvid : "");
    const ref = parseVideoId(rawUrl);
    if (!ref) {
      sendJson(res, 400, { error: "无法识别 bilibili 视频（支持 BV 号 / av 号 / bilibili 链接）" });
      return;
    }
    // 私有 provider：bilibili:<providerId>，必须是房间创建者本人账户的 cookie 配置。
    let providerCfg: ProviderConfig | undefined;
    let providerLabel = "哔哩哔哩";
    let providerOwner: string | undefined;
    if (provider.startsWith("bilibili:")) {
      const providerId = provider.slice("bilibili:".length);
      const owner = requireRoomOwner(req, res, roomId);
      if (!owner) return;
      providerCfg = accounts.getUser(owner)?.providers.get(providerId);
      if (!providerCfg || providerCfg.kind !== "bilibili") {
        sendJson(res, 403, { error: "provider 不存在或不属于房间创建者" });
        return;
      }
      providerLabel = providerCfg.label;
      providerOwner = owner;
    }
    try {
      const bc = bilibiliClientFor(providerCfg);
      const info = await bc.getVideoInfo(ref);
      const result = registry.registerMedia(roomId, member, "", { name: info.title, size: 0 }, [], {
        provider: providerLabel,
        bilibili: { bvid: info.bvid, cid: info.cid, aid: info.aid },
        ...(providerOwner ? { providerOwner, providerId: providerCfg!.id } : {}),
      });
      if ("error" in result) {
        sendJson(res, 403, { error: result.error });
        return;
      }
      sendJson(res, 200, { mediaId: result.mediaId, name: info.title, size: 0, related: result.related, provider: providerLabel });
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
  try {
    const grant = await registry.grant(roomId, mediaId, member, (entry) => {
      // Bilibili：流地址 Referer 敏感，grant 只下发服务端反代地址（/stream 透传 Range）。
      if (entry.bilibili) {
        const streamUrl = `/api/rooms/${encodeURIComponent(roomId)}/media/${encodeURIComponent(mediaId)}/stream?token=${encodeURIComponent(member.token)}`;
        return Promise.resolve({ url: streamUrl, name: entry.name, size: 0 });
      }
      // OpenList provider：用注册者（房间创建者）的凭据解析（凭据不出服务端）。
      if (entry.providerOwner && entry.providerId) {
        return userOpenListClient(entry.providerOwner, entry.providerId).then((ol) => {
          if (!ol) throw new Error("provider 不可用");
          return resolveWithClient(ol.client, ol.baseUrl, entry.path, req.headers["user-agent"] ?? "SyncFrame-PoC/0.1");
        });
      }
      throw new Error("媒体来源 provider 不可用");
    });
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

async function handleStream(
  req: IncomingMessage,
  res: ServerResponse,
  roomId: string,
  mediaId: string,
  url: URL,
): Promise<void> {
  const token = url.searchParams.get("token");
  const member = registry.authenticate(roomId, token);
  if (!member) {
    sendJson(res, 401, { error: "成员令牌无效或已过期" });
    return;
  }
  const entry = registry.resolveMediaPath(roomId, mediaId);
  if (!entry || !entry.bilibili) {
    // 跨房间/非 bilibili 条目：404，与 grant 的存在性语义一致。
    sendJson(res, 404, { error: "媒体不存在或未授权" });
    return;
  }
  if (!rateLimit("grant", clientIp(req))) {
    sendJson(res, 429, { error: "拉流请求过于频繁，请稍后再试" });
    return;
  }
  try {
    const bc = bilibiliClientFor(
      entry.providerOwner && entry.providerId
        ? accounts.getUser(entry.providerOwner)?.providers.get(entry.providerId)
        : undefined,
    );
    const play = await getPlayUrlCached(bc, entry.bilibili.bvid, entry.bilibili.cid);
    const range = req.headers.range;
    const upstream = await fetch(play.url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        Referer: "https://www.bilibili.com",
        ...(range ? { Range: range } : {}),
      },
    });
    res.writeHead(upstream.status, {
      "Content-Type": upstream.headers.get("content-type") ?? "video/mp4",
      ...(upstream.headers.get("content-length")
        ? { "Content-Length": upstream.headers.get("content-length")! }
        : {}),
      ...(upstream.headers.get("content-range")
        ? { "Content-Range": upstream.headers.get("content-range")! }
        : {}),
      "Accept-Ranges": "bytes",
      // 媒体片段允许跨域直放（与 grant 响应的 CORS 语义一致）。
      "Access-Control-Allow-Origin": "*",
    });
    if (!upstream.body || upstream.status === 204) {
      res.end();
      return;
    }
    // 手动逐段泵送（Node 18 fetch 的 body 是 web ReadableStream）。
    const reader = upstream.body.getReader();
    const pump = (): void => {
      void reader.read().then(({ done, value }) => {
        if (done) {
          res.end();
          return;
        }
        res.write(Buffer.from(value));
        pump();
      }, (err) => {
        console.warn(`[stream] bilibili 拉流中断 media=${mediaId}: ${err instanceof Error ? err.message : err}`);
        res.end();
      });
    };
    pump();
  } catch (err) {
    if (!res.headersSent) sendJson(res, 502, { error: err instanceof Error ? err.message : String(err) });
    else res.end();
  }
}

// ── 基础限流（PoC：单进程内存滑动窗口，防爆破/防刷）────────────────────────

interface RateBucket {
  timestamps: number[];
}
const rateBuckets = new Map<string, RateBucket>();
const RATE_LIMITS: Record<string, { windowMs: number; max: number }> = {
  join: { windowMs: 60_000, max: 20 },
  grant: { windowMs: 60_000, max: 60 },
  "ws-reject": { windowMs: 60_000, max: 30 },
};

/** 返回 true 表示放行；false 表示超限（调用方回 429）。窗口边缘惰性清理。 */
function rateLimit(action: string, key: string): boolean {
  const limit = RATE_LIMITS[action];
  if (!limit) return true;
  const now = Date.now();
  const bucketKey = `${action}:${key}`;
  let bucket = rateBuckets.get(bucketKey);
  if (!bucket) {
    bucket = { timestamps: [] };
    rateBuckets.set(bucketKey, bucket);
  }
  bucket.timestamps = bucket.timestamps.filter((t) => t > now - limit.windowMs);
  if (bucket.timestamps.length >= limit.max) return false;
  bucket.timestamps.push(now);
  return true;
}

function clientIp(req: IncomingMessage): string {
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd.length > 0) return fwd.split(",")[0].trim();
  return req.socket.remoteAddress ?? "unknown";
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
      // P4 大厅房间列表（公开摘要：房间号/房主昵称/人数/视频数）。
      sendJson(res, 200, { rooms: registry.listRooms() });
    } else if (url.pathname === "/api/auth/login" && req.method === "POST") {
      await handleLogin(req, res, await readBody(req));
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
    } else if (url.pathname.startsWith("/api/rooms/") && req.method === "POST" && url.pathname.endsWith("/invite/rotate")) {
      await handleRotateInvite(req, res, url.pathname.split("/")[3]);
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
    } else if (url.pathname.startsWith("/api/rooms/") && req.method === "GET" && url.pathname.endsWith("/stream")) {
      const parts = url.pathname.split("/"); // ["","api","rooms",:id,"media",:mediaId,"stream"]
      await handleStream(req, res, parts[3], parts[5], url);
    } else {
      sendJson(res, 404, { error: "not found" });
    }
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
});

// P3：WebSocket 房间端点 /ws?room=<id>&token=<memberToken>（鉴权后入场）
const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  if (url.pathname !== "/ws") {
    socket.destroy();
    return;
  }
  const roomId = (url.searchParams.get("room") || "").trim().slice(0, 64);
  const token = url.searchParams.get("token");
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

// P3：注册表房间保留期——同步房间销毁（全员离开 5s 宽限）后，注册表房间仍保留 30 分钟，
// 保证房主/观众刷新页面、短期断网后可凭原令牌/邀请码直接恢复（P3 通过门槛）。
const REGISTRY_RETAIN_MS = 30 * 60 * 1000;
const registrySweep = setInterval(() => {
  const cutoff = Date.now() - REGISTRY_RETAIN_MS;
  for (const roomId of registry.roomIds()) {
    if (roomManager.peek(roomId)) continue; // 同步房间还活着
    const rec = registry.peek(roomId);
    if (rec && rec.lastActiveAt < cutoff) registry.disposeRoom(roomId);
  }
}, 60_000);
registrySweep.unref();

server.listen(PORT, () => {
  console.log(`SyncFrame 后端已启动: http://localhost:${PORT}`);
  console.log(`  POST /api/auth/login | GET /api/me | PUT /api/me/providers   （账户与 provider；注册已关闭）`);
  console.log(`  GET/POST/DELETE /api/admin/users…   （管理员账户管理）`);
  console.log(`  GET  /api/rooms | POST /api/rooms（需登录）| /api/rooms/:id/join   （房间列表 + 房间鉴权）`);
  console.log(`  GET  /api/browse?room=&provider= | /api/search?provider=&keywords=   （房主本人媒体库）`);
  console.log(`  POST /api/rooms/:id/media | GET .../media/:mediaId/grant   （受控映射 + 短期凭证）`);
  console.log(`  GET  .../media/:mediaId/stream?token=   （Bilibili 流反代，Range 透传）`);
  console.log(`  WS   /ws?room=<id>&token=<memberToken>   （凭成员令牌入场）`);
});
