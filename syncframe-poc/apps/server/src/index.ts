/**
 * P3 验证后端：房间鉴权 + mediaId 受控映射 + OpenList 选片。
 *
 * 接口：
 *  - GET  /api/health                                存活检查
 *  - POST /api/rooms            {name}               → {roomId, inviteCode, memberToken, clientId, role}
 *  - POST /api/rooms/:id/join   {name, inviteCode?, clientId?}
 *                                                    → {memberToken, clientId, role}（clientId=房主时恢复 host）
 *  - GET  /api/browse?path=&page=                    列目录（仅房主；观众 403）
 *  - GET  /api/search?keywords=&parent=&page=        搜索（仅房主）
 *  - POST /api/rooms/:id/media  {path}               注册 OpenList 路径为不透明 mediaId（仅房主），
 *                                                    自动注册同目录外挂字幕（srt/ass/ssa/vtt）
 *  - GET  /api/rooms/:id/media/:mediaId/grant        签发短期媒体访问凭证（房间成员；跨房间 404）
 *  - GET  /api/resolve?path=&route=raw|proxy         P1 遗留：直接解析（无房间授权，仅验证用）
 *  - POST /api/report | /api/sync-report             P1/P2 指标落盘
 *
 *  - WS   /ws?room=<id>&token=<memberToken>          同步房间（P3 起凭成员令牌入场）
 *
 * 令牌缓存于内存；OpenList 管理令牌只存在于服务端；
 * 审计日志见 [audit] 行：只含 roomId/mediaId/clientId/动作，不含令牌、签名 URL 或文件路径。
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { OpenListClient } from "@syncframe/openlist-adapter";
import { RoomManager } from "./sync-rooms.ts";
import { RoomRegistry, tokenFingerprint } from "./room-auth.ts";
import type { MemberRecord } from "./room-auth.ts";

const PORT = Number(process.env.SERVER_PORT ?? 8787);
const baseUrl = process.env.OPENLIST_BASE_URL;
const username = process.env.OPENLIST_USERNAME;
const password = process.env.OPENLIST_PASSWORD;

// OpenList 凭证缺省时不再直接退出：同步功能不依赖媒体解析，
// 只有调用 /api/resolve、browse、media、grant 时才要求配置完整。
if (!baseUrl || !username || !password) {
  console.warn("警告: 未配置 OPENLIST_BASE_URL / USERNAME / PASSWORD，媒体相关接口不可用（同步功能不受影响）");
}

// 项目根（apps/server 上三级）
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const reportDir = path.join(repoRoot, "reports/playback-raw");
const syncReportDir = path.join(repoRoot, "reports/sync-raw");
await mkdir(reportDir, { recursive: true });
await mkdir(syncReportDir, { recursive: true });

// P3：房间注册表（鉴权 + 媒体受控映射 + 授权缓存）。审计日志不含令牌/URL/路径。
const registry = new RoomRegistry({
  onAudit: (ev) => {
    const fp = ev.clientId ? ` member=${ev.clientId}` : "";
    const mid = ev.mediaId ? ` media=${ev.mediaId}` : "";
    const detail = ev.detail ? ` ${ev.detail}` : "";
    console.log(`[audit] room=${ev.roomId}${fp}${mid} action=${ev.action}${detail}`);
  },
});

// P2：同步房间。延迟注入用于仿真 WAN（单向延迟=RTT/2），见 tests/sync。
const roomManager = new RoomManager({
  injectLatencyMs: Number(process.env.SYNC_INJECT_LATENCY_MS ?? 0),
  injectJitterMs: Number(process.env.SYNC_INJECT_JITTER_MS ?? 0),
  onDebug: (line) => console.log(`[sync] ${line}`),
  /** 同步房间销毁后回调（注册表房间另有更长保留期，见下方清扫）。 */
  onRoomDisposed: (_roomId) => {},
});

const client = baseUrl ? new OpenListClient({ baseUrl, timeoutMs: 15_000 }) : null;
let tokenPromise: Promise<void> | null = null;

async function ensureLogin(): Promise<void> {
  if (!client || !baseUrl || !username || !password) {
    throw new Error("OpenList 未配置（OPENLIST_BASE_URL / USERNAME / PASSWORD）");
  }
  if (client.hasToken) return;
  tokenPromise ??= client.login(username, password).finally(() => {
    // 失败后允许重试
    setTimeout(() => {
      tokenPromise = null;
    }, 0);
  });
  return tokenPromise;
}

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

async function resolveOpenListUrl(filePath: string, userAgent: string): Promise<{
  name: string;
  size: number;
  url: string;
  related: { name: string; size: number }[];
}> {
  await ensureLogin();
  if (!client) throw new Error("OpenList client 未初始化");
  const detail = await client.getFile(filePath, { userAgent: userAgent || "SyncFrame-PoC/0.1" });
  const proxy = `${baseUrl!.replace(/\/+$/, "")}/d${filePath.startsWith("/") ? "" : "/"}${filePath}${
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

// ── P1 遗留：无房间授权的直解析（仅播放能力验证用，MVP 观影走 grant 链路）──

async function handleResolve(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const filePath = url.searchParams.get("path");
  const route = url.searchParams.get("route") ?? "raw";
  const ua = url.searchParams.get("ua") ?? "SyncFrame-PoC/0.1";
  if (!filePath) {
    sendJson(res, 400, { error: "缺少 path 参数" });
    return;
  }
  if (route !== "raw" && route !== "proxy") {
    sendJson(res, 400, { error: "route 必须是 raw 或 proxy" });
    return;
  }
  try {
    const detail = await client!.getFile(filePath, { userAgent: ua });
    const proxy = `${baseUrl!.replace(/\/+$/, "")}/d${filePath.startsWith("/") ? "" : "/"}${filePath}${
      detail.sign ? `?sign=${encodeURIComponent(detail.sign)}` : ""
    }`;
    const initial = route === "raw" ? (detail.raw_url ?? proxy) : proxy;
    const { url: finalUrl, redirectCount } = await resolveRedirectChain(initial);
    sendJson(res, 200, {
      name: detail.name,
      size: detail.size,
      path: filePath,
      provider: detail.provider ?? null,
      route,
      url: finalUrl,
      redirected: redirectCount > 0,
      rawUrl: detail.raw_url ?? null,
      related: (detail.related ?? []).map((r) => ({ name: r.name, size: r.size })),
    });
  } catch (err) {
    sendJson(res, 502, { error: err instanceof Error ? err.message : String(err) });
  }
}

// ── P3 端点实现 ─────────────────────────────────────────────

async function handleCreateRoom(req: IncomingMessage, res: ServerResponse, body: string): Promise<void> {
  const parsed = readJsonBody(body);
  const name = typeof parsed.name === "string" ? parsed.name : "房主";
  const clientId = typeof parsed.clientId === "string" ? parsed.clientId : undefined;
  const { room, member, hostSecret } = registry.createRoom(name, clientId);
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
  const dirPath = url.searchParams.get("path") ?? "/";
  const page = Math.max(1, Number(url.searchParams.get("page") ?? "1") || 1);
  try {
    await ensureLogin();
    const data = await client!.listDir(dirPath, { page, perPage: 100 });
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
  const keywords = (url.searchParams.get("keywords") ?? "").trim();
  const parent = url.searchParams.get("parent") ?? "/";
  const page = Math.max(1, Number(url.searchParams.get("page") ?? "1") || 1);
  if (!keywords) {
    sendJson(res, 400, { error: "缺少 keywords 参数" });
    return;
  }
  try {
    await ensureLogin();
    const data = await client!.search(keywords, { parent, page, perPage: 50 });
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
  const filePath = typeof parsed.path === "string" ? parsed.path : "";
  if (!filePath) {
    sendJson(res, 400, { error: "缺少 path 参数" });
    return;
  }
  if (!filePath.startsWith("/") || filePath.split("/").includes("..")) {
    sendJson(res, 400, { error: "非法路径" });
    return;
  }
  try {
    // 用 fs/get 校验文件存在并取元信息/related（同时完成路径合法性校验）。
    const detail = await resolveOpenListUrl(filePath, "SyncFrame-PoC/0.1");
    const result = registry.registerMedia(roomId, member, filePath, {
      name: detail.name,
      size: detail.size,
    }, detail.related);
    if ("error" in result) {
      sendJson(res, 403, { error: result.error });
      return;
    }
    sendJson(res, 200, { mediaId: result.mediaId, name: detail.name, size: detail.size, related: result.related });
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
    const grant = await registry.grant(roomId, mediaId, member, (entry) =>
      resolveOpenListUrl(entry.path, req.headers["user-agent"] ?? "SyncFrame-PoC/0.1"),
    );
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

async function handleReport(_req: IncomingMessage, res: ServerResponse, body: string): Promise<void> {
  try {
    const parsed = JSON.parse(body);
    const file = path.join(reportDir, `playback-${Date.now()}.json`);
    await writeFile(file, JSON.stringify(parsed, null, 2), "utf-8");
    sendJson(res, 200, { saved: file });
  } catch (err) {
    sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
  }
}

/** P2：接收浏览器/仿真端上传的同步漂移采样，落盘 reports/sync-raw/。 */
async function handleSyncReport(_req: IncomingMessage, res: ServerResponse, body: string): Promise<void> {
  try {
    const parsed = JSON.parse(body);
    const clientId = typeof parsed.clientId === "string" ? parsed.clientId.replace(/[^\w-]/g, "").slice(0, 32) : "unknown";
    const file = path.join(syncReportDir, `sync-${Date.now()}-${clientId}.json`);
    await writeFile(file, JSON.stringify(parsed, null, 2), "utf-8");
    sendJson(res, 200, { saved: file });
  } catch (err) {
    sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
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
        hasToken: client?.hasToken ?? false,
        rooms: roomManager.roomCount(),
        registryRooms: registry.roomCount(),
        injectLatencyMs: Number(process.env.SYNC_INJECT_LATENCY_MS ?? 0),
        injectJitterMs: Number(process.env.SYNC_INJECT_JITTER_MS ?? 0),
      });
    } else if (url.pathname === "/api/rooms" && req.method === "POST") {
      await handleCreateRoom(req, res, await readBody(req));
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
    } else if (url.pathname === "/api/resolve" && req.method === "GET") {
      await handleResolve(req, res, url);
    } else if (url.pathname === "/api/report" && req.method === "POST") {
      await handleReport(req, res, await readBody(req));
    } else if (url.pathname === "/api/sync-report" && req.method === "POST") {
      await handleSyncReport(req, res, await readBody(req));
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
  console.log(`验证后端已启动: http://localhost:${PORT}`);
  console.log(`  POST /api/rooms | /api/rooms/:id/join   （P3 房间鉴权）`);
  console.log(`  GET  /api/browse?room=&path= | /api/search?room=&keywords=   （房主选片）`);
  console.log(`  POST /api/rooms/:id/media | GET .../media/:mediaId/grant   （受控映射 + 短期凭证）`);
  console.log(`  GET  /api/resolve?path=<OpenList路径>&route=raw|proxy   （P1 遗留）`);
  console.log(`  WS   /ws?room=<id>&token=<memberToken>   （P3 起凭成员令牌入场）`);
  console.log(`  POST /api/report → ${reportDir} | /api/sync-report → ${syncReportDir}`);
});
