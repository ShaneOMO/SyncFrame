import { randomUUID } from "node:crypto";
import { BilibiliError, biliCredentialCookie, type BiliCredential } from "./bilibili.ts";

const PASSPORT_BASE = "https://passport.bilibili.com";
const API_BASE = "https://api.bilibili.com";
const WEB_ORIGIN = "https://www.bilibili.com";
const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

export function extractSessdata(cookie: string): string | null {
  for (const part of cookie.split(";")) {
    const pair = part.trim();
    if (pair.startsWith("SESSDATA=") && pair.length > "SESSDATA=".length) return pair;
  }
  return null;
}

export interface QrLoginStart {
  url: string;
  qrcodeKey: string;
}

export type QrLoginStatus =
  | { status: "waiting" }
  | { status: "scanned" }
  | { status: "expired" }
  | { status: "confirmed"; credential: BiliCredential; uname: string };

function passportHeaders(): Record<string, string> {
  return { "User-Agent": DEFAULT_UA, Referer: WEB_ORIGIN };
}

export async function startQrLogin(): Promise<QrLoginStart> {
  const res = await fetch(`${PASSPORT_BASE}/x/passport-login/web/qrcode/generate`, { headers: passportHeaders() });
  if (!res.ok) throw new BilibiliError(`bilibili 二维码申请 HTTP ${res.status}`);
  const body = (await res.json()) as { code: number; message: string; data?: { url: string; qrcode_key: string } | null };
  if (body.code !== 0 || !body.data?.qrcode_key || !body.data.url) {
    throw new BilibiliError(`bilibili 二维码申请失败 ${body.code}: ${body.message || "未知错误"}`);
  }
  return { url: body.data.url, qrcodeKey: body.data.qrcode_key };
}

export function extractLoginCookie(setCookies: string[] | undefined): string | null {
  if (!setCookies?.length) return null;
  const wanted = new Set(["SESSDATA", "bili_jct", "DedeUserID", "DedeUserID__ckMd5", "sid", "access_key"]);
  const pairs: string[] = [];
  let hasSessdata = false;
  for (const line of setCookies) {
    const first = line.split(";")[0]?.trim();
    if (!first) continue;
    const idx = first.indexOf("=");
    if (idx <= 0) continue;
    const name = first.slice(0, idx);
    if (!wanted.has(name)) continue;
    if (name === "SESSDATA") hasSessdata = true;
    pairs.push(first);
  }
  return hasSessdata && pairs.length ? pairs.join("; ") : null;
}

export function extractLoginCredential(setCookies: string[] | undefined, refreshToken: unknown): BiliCredential | null {
  if (!setCookies?.length || typeof refreshToken !== "string" || !refreshToken) return null;
  const values = new Map<string, string>();
  for (const line of setCookies) {
    const first = line.split(";")[0]?.trim();
    const idx = first?.indexOf("=") ?? -1;
    if (!first || idx <= 0) continue;
    values.set(first.slice(0, idx), first.slice(idx + 1));
  }
  const sessdata = values.get("SESSDATA");
  const biliJct = values.get("bili_jct");
  const dedeUserId = values.get("DedeUserID");
  if (!sessdata || !biliJct || !dedeUserId) return null;
  return {
    version: 1,
    sessdata,
    biliJct,
    buvid3: "",
    dedeUserId,
    acTimeValue: refreshToken,
    uname: "",
    lastRefreshCheckAt: Date.now(),
    updatedAt: Date.now(),
  };
}

async function fetchBuvid3(): Promise<string> {
  const res = await fetch(`${API_BASE}/x/web-frontend/getbuvid`, { headers: passportHeaders() });
  if (!res.ok) throw new BilibiliError(`bilibili buvid HTTP ${res.status}`);
  const body = (await res.json()) as { code: number; data?: { buvid?: string } };
  if (body.code !== 0 || !body.data?.buvid) throw new BilibiliError("bilibili 未返回 buvid3");
  return body.data.buvid;
}

export async function pollQrLogin(qrcodeKey: string): Promise<QrLoginStatus> {
  const res = await fetch(
    `${PASSPORT_BASE}/x/passport-login/web/qrcode/poll?qrcode_key=${encodeURIComponent(qrcodeKey)}`,
    { headers: passportHeaders(), redirect: "manual" },
  );
  if (!res.ok) throw new BilibiliError(`bilibili 扫码轮询 HTTP ${res.status}`);
  const body = (await res.json()) as {
    code: number;
    message: string;
    data?: { code?: number; message?: string; refresh_token?: string } | null;
  };
  const inner = body.data?.code ?? body.code;
  if (inner === 86038) return { status: "expired" };
  if (inner === 86090) return { status: "scanned" };
  if (inner !== 0) return { status: "waiting" };
  const setCookie = res.headers.getSetCookie?.() ??
    (res.headers.get("set-cookie") ? [res.headers.get("set-cookie")!] : undefined);
  const credential = extractLoginCredential(setCookie, body.data?.refresh_token);
  if (!credential) throw new BilibiliError("登录确认但未返回完整凭据或 refresh_token，请重试");
  credential.buvid3 = await fetchBuvid3().catch(() => `${randomUUID().replace(/-/g, "")}infoc`);
  const uname = await fetchNavInfo(biliCredentialCookie(credential, true)).catch(() => "");
  credential.uname = uname;
  return { status: "confirmed", credential, uname };
}

export async function fetchNavInfo(cookie: string): Promise<string> {
  const res = await fetch(`${API_BASE}/x/web-interface/nav`, {
    headers: { "User-Agent": DEFAULT_UA, Referer: WEB_ORIGIN, Cookie: cookie },
  });
  if (!res.ok) throw new BilibiliError(`bilibili nav HTTP ${res.status}`);
  const body = (await res.json()) as { code: number; message: string; data?: { isLogin?: boolean; uname?: string } | null };
  if (body.code !== 0 || !body.data?.isLogin) {
    throw new BilibiliError(`B 站登录无效或已过期（${body.code}: ${body.message || "未登录"}）`);
  }
  return body.data.uname ?? "";
}
