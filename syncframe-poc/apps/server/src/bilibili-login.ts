/**
 * Bilibili 扫码登录（设计参考 SyncTV 的 bilibili 登录绑定）：
 *
 * - startQrLogin：向 passport 申请二维码（qrcode_key + 登录链接）；
 * - pollQrLogin：轮询扫码状态；用户确认后从 Set-Cookie 中提取 SESSDATA 等凭据；
 * - fetchNavInfo：用凭据调 /x/web-interface/nav 校验登录态并取昵称（绑定展示用）。
 *
 * 凭据只在服务端内存中流转：poll 成功后只把 SESSDATA 交给前端（浏览器 localStorage 持有），
 * 服务端不落盘、不跨请求保存。其余 cookie（bili_jct 等写操作凭据）就地丢弃。
 */

import { BilibiliError } from "./bilibili.ts";

const PASSPORT_BASE = "https://passport.bilibili.com";
const API_BASE = "https://api.bilibili.com";
const WEB_ORIGIN = "https://www.bilibili.com";
const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

/** 从完整 cookie 串中只取出 SESSDATA 一项（播放所需的唯一凭据）。 */
export function extractSessdata(cookie: string): string | null {
  for (const part of cookie.split(";")) {
    const pair = part.trim();
    if (pair.startsWith("SESSDATA=") && pair.length > "SESSDATA=".length) return pair;
  }
  return null;
}

export interface QrLoginStart {
  /** 二维码登录链接（前端渲染成二维码）。 */
  url: string;
  /** 二维码 key（poll 用）。 */
  qrcodeKey: string;
}

export type QrLoginStatus =
  | { status: "waiting" }
  | { status: "scanned" }
  | { status: "expired" }
  | { status: "confirmed"; cookie: string; uname: string };

function passportHeaders(): Record<string, string> {
  return {
    "User-Agent": DEFAULT_UA,
    Referer: WEB_ORIGIN,
  };
}

/** 申请登录二维码。 */
export async function startQrLogin(): Promise<QrLoginStart> {
  const res = await fetch(`${PASSPORT_BASE}/x/passport-login/web/qrcode/generate`, { headers: passportHeaders() });
  if (!res.ok) throw new BilibiliError(`bilibili 二维码申请 HTTP ${res.status}`);
  const body = (await res.json()) as { code: number; message: string; data?: { url: string; qrcode_key: string } | null };
  if (body.code !== 0 || !body.data?.qrcode_key || !body.data.url) {
    throw new BilibiliError(`bilibili 二维码申请失败 ${body.code}: ${body.message || "未知错误"}`);
  }
  return { url: body.data.url, qrcodeKey: body.data.qrcode_key };
}

/**
 * 从 set-cookie 数组中提取登录所需 cookie（SESSDATA 必选，附带 bili_jct / DedeUserID 等）。
 * 提取后拼接为单条 Cookie 头字符串。找不到 SESSDATA 返回 null。
 */
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

/**
 * 轮询扫码状态（前端约 2s 一次）。
 * 已确认时返回 SESSDATA cookie 串与昵称；过期/未扫/已扫未确认返回对应状态。
 */
export async function pollQrLogin(qrcodeKey: string): Promise<QrLoginStatus> {
  const res = await fetch(
    `${PASSPORT_BASE}/x/passport-login/web/qrcode/poll?qrcode_key=${encodeURIComponent(qrcodeKey)}`,
    // 302 跳转携带 cookie：手动模式以便读取 Set-Cookie。
    { headers: passportHeaders(), redirect: "manual" },
  );
  if (!res.ok) throw new BilibiliError(`bilibili 扫码轮询 HTTP ${res.status}`);
  const body = (await res.json()) as { code: number; message: string; data?: { code?: number; message?: string } | null };
  // data.code: 0 确认；86101 未扫码；86090 已扫码未确认；86038 二维码过期/取消。
  const inner = body.data?.code ?? body.code;
  if (inner === 86038) return { status: "expired" };
  if (inner === 86090) return { status: "scanned" };
  if (inner !== 0) return { status: "waiting" };
  // 确认：登录 cookie 在 Set-Cookie 里（fetch 不自动合并手动重定向的 cookie）。
  const setCookie = res.headers.getSetCookie?.() ??
    (res.headers.get("set-cookie") ? [res.headers.get("set-cookie")!] : undefined);
  const cookie = extractLoginCookie(setCookie);
  if (!cookie) throw new BilibiliError("bilibili 登录确认但未返回 SESSDATA（可能被风控，请重试）");
  const uname = await fetchNavInfo(cookie).catch(() => "");
  return { status: "confirmed", cookie, uname };
}

/** 用 cookie 校验登录态并取昵称；未登录抛 BilibiliError。 */
export async function fetchNavInfo(cookie: string): Promise<string> {
  const res = await fetch(`${API_BASE}/x/web-interface/nav`, {
    headers: { "User-Agent": DEFAULT_UA, Referer: WEB_ORIGIN, Cookie: cookie },
  });
  if (!res.ok) throw new BilibiliError(`bilibili nav HTTP ${res.status}`);
  const body = (await res.json()) as { code: number; message: string; data?: { isLogin?: boolean; uname?: string } | null };
  if (body.code !== 0 || !body.data?.isLogin) {
    throw new BilibiliError(`SESSDATA 无效或已过期（${body.code}: ${body.message || "未登录"}）`);
  }
  return body.data.uname ?? "";
}
