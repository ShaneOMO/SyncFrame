import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  BilibiliClient,
  BilibiliError,
  credentialFingerprint,
  getPlayUrlCached,
  parseVideoId,
  type BilibiliVideoRef,
} from "./bilibili.ts";
import { fetchNavInfo, pollQrLogin, startQrLogin } from "./bilibili-login.ts";
import { BiliSessionStore } from "./session.ts";

const PORT = Number(process.env.SYNCFRAME_LOCAL_PORT ?? 8788);
const HOST = "127.0.0.1";
const DATA_DIR = process.env.SYNCFRAME_LOCAL_DATA_DIR ?? path.join(process.cwd(), "data", "local");
const ALLOWED_ORIGINS = new Set(
  (process.env.SYNCFRAME_WEB_ORIGINS ?? "http://localhost:5173,http://127.0.0.1:5173")
    .split(",")
    .map((origin) => origin.trim().replace(/\/+$/, ""))
    .filter(Boolean),
);
const STREAM_TICKET_TTL_MS = 3 * 60 * 60 * 1000;
const BILIBILI_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const sessions = new BiliSessionStore(DATA_DIR);

interface StreamTicket {
  upstreamUrl: string;
  track: "video" | "audio";
  expiresAt: number;
}

const streamTickets = new Map<string, StreamTicket>();
const ticketSweep = setInterval(() => {
  const now = Date.now();
  for (const [key, ticket] of streamTickets) {
    if (ticket.expiresAt <= now) streamTickets.delete(key);
  }
}, 60_000);
ticketSweep.unref();

function setCors(req: IncomingMessage, res: ServerResponse): boolean {
  const origin = req.headers.origin?.replace(/\/+$/, "");
  if (origin && !ALLOWED_ORIGINS.has(origin)) return false;
  if (origin) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Private-Network", "true");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Referrer-Policy", "no-referrer");
  return true;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(data) });
  res.end(data);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += data.length;
    if (size > 64 * 1024) throw new BilibiliError("请求体过大");
    chunks.push(data);
  }
  if (!chunks.length) return {};
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new BilibiliError("请求体必须是 JSON 对象");
  return parsed as Record<string, unknown>;
}

function clientFor(session: NonNullable<ReturnType<BiliSessionStore["get"]>>): BilibiliClient {
  return new BilibiliClient({ cookie: session.cookie, buvidSeed: session.buvidSeed });
}

function requireSession(res: ServerResponse) {
  const session = sessions.get();
  if (session) return session;
  sendJson(res, 401, { error: "本机尚未登录 B 站，请在账户设置中扫码登录", code: "BILI_LOGIN_REQUIRED" });
  return null;
}

function issueStreamUrl(upstreamUrl: string, track: "video" | "audio"): string {
  const ticket = randomUUID();
  streamTickets.set(ticket, { upstreamUrl, track, expiresAt: Date.now() + STREAM_TICKET_TTL_MS });
  return `/stream?ticket=${encodeURIComponent(ticket)}`;
}

let validation: Promise<ReturnType<BiliSessionStore["get"]>> | null = null;
async function validateSession(): Promise<ReturnType<BiliSessionStore["get"]>> {
  const session = sessions.get();
  if (!session) return null;
  if (!sessions.needsValidation()) return session;
  if (validation) return validation;
  validation = (async () => {
    try {
      const uname = await fetchNavInfo(session.cookie);
      return sessions.markValid(uname);
    } catch (err) {
      if (err instanceof BilibiliError && /无效或已过期/.test(err.message)) {
        sessions.clear();
        streamTickets.clear();
        return null;
      }
      throw err;
    } finally {
      validation = null;
    }
  })();
  return validation;
}

async function handleResolve(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const session = requireSession(res);
  if (!session) return;
  const body = await readJson(req);
  const input = typeof body.url === "string" ? body.url : "";
  const ref = parseVideoId(input);
  if (!ref) {
    sendJson(res, 400, { error: "无法识别 B 站视频（支持 BV / av / 视频链接 / 番剧 ep、ss）" });
    return;
  }
  const client = clientFor(session);
  const info = ref.epId || ref.seasonId
    ? await client.getBangumiInfo({ epId: ref.epId, seasonId: ref.seasonId })
    : await client.getVideoInfo(ref);
  const bilibili: BilibiliVideoRef = info;
  sendJson(res, 200, {
    name: info.title,
    bilibili: { bvid: bilibili.bvid, cid: bilibili.cid, aid: bilibili.aid, epId: bilibili.epId },
  });
}

async function handlePlay(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const session = requireSession(res);
  if (!session) return;
  const body = await readJson(req);
  const cid = Number(body.cid);
  const bvid = typeof body.bvid === "string" ? body.bvid : undefined;
  const epId = body.epId === undefined ? undefined : Number(body.epId);
  if (!Number.isSafeInteger(cid) || cid <= 0 || (!bvid && !epId) || (epId !== undefined && (!Number.isSafeInteger(epId) || epId <= 0))) {
    sendJson(res, 400, { error: "非法 B 站视频标识" });
    return;
  }
  const play = await getPlayUrlCached(
    clientFor(session),
    { bvid, cid, epId },
    credentialFingerprint(session.cookie),
  );
  sendJson(res, 200, {
    url: play.url,
    audioUrl: play.audioUrl,
    fallbackUrl: issueStreamUrl(play.url, "video"),
    fallbackAudioUrl: play.audioUrl ? issueStreamUrl(play.audioUrl, "audio") : undefined,
    direct: play.directOk,
    format: play.format,
    quality: play.quality,
    timelength: play.timelength,
  });
}

async function handleStream(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const ticketId = url.searchParams.get("ticket");
  const ticket = ticketId ? streamTickets.get(ticketId) : undefined;
  if (!ticket || ticket.expiresAt <= Date.now()) {
    sendJson(res, 401, { error: "本机播放票据无效或已过期" });
    return;
  }
  const isHead = req.method === "HEAD";
  const upstreamHeaders: Record<string, string> = {
    "User-Agent": BILIBILI_UA,
    Referer: "https://www.bilibili.com",
  };
  if (req.headers.range) upstreamHeaders.Range = req.headers.range;
  const upstream = await fetch(ticket.upstreamUrl, { method: isHead ? "HEAD" : "GET", headers: upstreamHeaders });
  if (isHead && !upstream.ok) {
    const probe = await fetch(ticket.upstreamUrl, { headers: { ...upstreamHeaders, Range: "bytes=0-0" } });
    const total = probe.headers.get("content-range")?.match(/\/(\d+)\s*$/)?.[1];
    await probe.body?.cancel().catch(() => {});
    if (total) {
      res.writeHead(200, {
        "Content-Type": ticket.track === "audio" ? "audio/mp4" : "video/mp4",
        "Content-Length": total,
        "Accept-Ranges": "bytes",
      });
      res.end();
      return;
    }
  }
  res.writeHead(upstream.status, {
    "Content-Type": ticket.track === "audio" ? "audio/mp4" : "video/mp4",
    ...(upstream.headers.get("content-length") ? { "Content-Length": upstream.headers.get("content-length")! } : {}),
    ...(upstream.headers.get("content-range") ? { "Content-Range": upstream.headers.get("content-range")! } : {}),
    "Accept-Ranges": "bytes",
    "Access-Control-Expose-Headers": "Content-Length, Content-Range, Accept-Ranges",
  });
  if (isHead || !upstream.body || upstream.status === 204) {
    res.end();
    return;
  }
  const reader = upstream.body.getReader();
  let stopped = false;
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    void reader.cancel().catch(() => {});
  };
  req.on("close", stop);
  res.on("close", stop);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done || stopped) break;
      if (!res.write(Buffer.from(value))) await new Promise<void>((resolve) => res.once("drain", resolve));
    }
    if (!stopped) res.end();
  } catch (err) {
    if (!stopped) {
      console.warn(`[local] B 站 CDN 拉流中断: ${err instanceof Error ? err.message : err}`);
      res.end();
    }
  }
}

const server = createServer(async (req, res) => {
  if (!setCors(req, res)) {
    sendJson(res, 403, { error: "该网页来源未获本机助手授权" });
    return;
  }
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }
  const url = new URL(req.url ?? "/", `http://${HOST}:${PORT}`);
  try {
    if (url.pathname === "/health" && req.method === "GET") {
      const session = sessions.get();
      sendJson(res, 200, { ok: true, authenticated: Boolean(session), uname: session?.uname ?? "" });
    } else if (url.pathname === "/login/qrcode" && req.method === "POST") {
      sendJson(res, 200, await startQrLogin());
    } else if (url.pathname === "/login/poll" && req.method === "GET") {
      const key = url.searchParams.get("qrcodeKey") ?? "";
      if (!key) {
        sendJson(res, 400, { error: "缺少 qrcodeKey" });
        return;
      }
      const status = await pollQrLogin(key);
      if (status.status !== "confirmed") {
        sendJson(res, 200, { status: status.status });
        return;
      }
      const session = sessions.save(status.cookie, status.uname);
      streamTickets.clear();
      console.log(`[local] B 站扫码登录成功${session.uname ? `：${session.uname}` : ""}；会话仅保存于本机`);
      sendJson(res, 200, { status: "confirmed", uname: session.uname });
    } else if (url.pathname === "/session/validate" && req.method === "POST") {
      const session = await validateSession();
      if (!session) sendJson(res, 401, { error: "B 站会话无效或已过期，请重新扫码", code: "BILI_LOGIN_REQUIRED" });
      else sendJson(res, 200, { authenticated: true, uname: session.uname, validated: true });
    } else if (url.pathname === "/session" && req.method === "DELETE") {
      sessions.clear();
      streamTickets.clear();
      sendJson(res, 200, { ok: true });
    } else if (url.pathname === "/resolve" && req.method === "POST") {
      await handleResolve(req, res);
    } else if (url.pathname === "/play" && req.method === "POST") {
      await handlePlay(req, res);
    } else if (url.pathname === "/stream" && (req.method === "GET" || req.method === "HEAD")) {
      await handleStream(req, res, url);
    } else {
      sendJson(res, 404, { error: "not found" });
    }
  } catch (err) {
    const status = err instanceof SyntaxError ? 400 : 502;
    if (!res.headersSent) sendJson(res, status, { error: err instanceof Error ? err.message : String(err) });
    else res.end();
  }
});

server.listen(PORT, HOST, () => {
  console.log(`SyncFrame 本机助手已启动: http://${HOST}:${PORT}`);
  console.log(`  B 站会话目录: ${path.resolve(DATA_DIR)}（不上传云端）`);
  console.log(`  允许的网页来源: ${[...ALLOWED_ORIGINS].join(", ") || "（无）"}`);
  console.log("  B 站登录、API 解析与 CDN 本机转发均由此进程处理");
});
