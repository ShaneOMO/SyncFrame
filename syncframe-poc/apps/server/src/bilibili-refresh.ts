import { constants, publicEncrypt } from "node:crypto";
import { BilibiliError, biliCredentialCookie, credentialFingerprint, type BiliCredential } from "./bilibili.ts";
import { extractLoginCredential } from "./bilibili-login.ts";

const REFRESH_CHECK_INTERVAL_MS = 12 * 60 * 60 * 1000;
const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const REFRESH_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDLgd2OAkcGVtoE3ThUREbio0Eg
Uc/prcajMKXvkCKFCWhJYJcLkcM2DKKcSeFpD/j6Boy538YXnR6VhcuUJOhH2x71
nzPjfdTcqMz7djHum0qSZA0AyCBDABUqCrfNgCiJ00Ra7GmRj+YCK1NJEuewlb40
JNrRuoEUXpabUzGB8QIDAQAB
-----END PUBLIC KEY-----`;

interface RefreshResult {
  credential: BiliCredential;
  changed: boolean;
}

const pending = new Map<string, Promise<RefreshResult>>();

function headers(credential: BiliCredential): Record<string, string> {
  return {
    "User-Agent": DEFAULT_UA,
    Referer: "https://www.bilibili.com",
    Cookie: biliCredentialCookie(credential, true),
  };
}

async function jsonBody(res: Response): Promise<{ code: number; message: string; data?: Record<string, unknown> }> {
  const body = (await res.json()) as { code?: number; message?: string; data?: Record<string, unknown> };
  if (!res.ok || body.code !== 0) throw new BilibiliError(`B 站凭据续期失败（${body.code ?? res.status}: ${body.message || res.statusText}）`);
  return { code: body.code, message: body.message ?? "", data: body.data };
}

function setCookies(res: Response): string[] | undefined {
  return res.headers.getSetCookie?.() ?? (res.headers.get("set-cookie") ? [res.headers.get("set-cookie")!] : undefined);
}

function correspondPath(): string {
  const encrypted = publicEncrypt(
    { key: REFRESH_PUBLIC_KEY, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
    Buffer.from(`refresh_${Date.now() - 20_000}`),
  );
  return encrypted.toString("hex");
}

async function refreshCredential(old: BiliCredential): Promise<BiliCredential> {
  const path = correspondPath();
  const csrfRes = await fetch(`https://www.bilibili.com/correspond/1/${path}`, {
    headers: { ...headers(old), Cookie: `${biliCredentialCookie(old, true)}; Domain=.bilibili.com` },
  });
  if (!csrfRes.ok) throw new BilibiliError(`B 站 refresh_csrf 获取失败 HTTP ${csrfRes.status}`);
  const html = await csrfRes.text();
  const refreshCsrf = /<div id="1-name">(.+?)<\/div>/.exec(html)?.[1];
  if (!refreshCsrf) throw new BilibiliError("B 站未返回 refresh_csrf");

  const refreshRes = await fetch("https://passport.bilibili.com/x/passport-login/web/cookie/refresh", {
    method: "POST",
    headers: {
      ...headers(old),
      Cookie: `${biliCredentialCookie(old, true)}; Domain=.bilibili.com`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      csrf: old.biliJct,
      refresh_csrf: refreshCsrf,
      refresh_token: old.acTimeValue,
      source: "main_web",
    }),
  });
  const refreshBody = await jsonBody(refreshRes);
  const next = extractLoginCredential(setCookies(refreshRes), refreshBody.data?.refresh_token);
  if (!next) throw new BilibiliError("B 站续期未返回完整 Cookie 或新 refresh_token");
  next.buvid3 = old.buvid3;
  next.uname = old.uname;

  const confirmRes = await fetch("https://passport.bilibili.com/x/passport-login/web/confirm/refresh", {
    method: "POST",
    headers: { ...headers(next), "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ csrf: next.biliJct, refresh_token: old.acTimeValue }),
  });
  await jsonBody(confirmRes);
  return next;
}

async function checkAndRefresh(credential: BiliCredential): Promise<RefreshResult> {
  const res = await fetch("https://passport.bilibili.com/x/passport-login/web/cookie/info", { headers: headers(credential) });
  const body = await jsonBody(res);
  if (body.data?.refresh !== true) {
    return { credential: { ...credential, lastRefreshCheckAt: Date.now() }, changed: true };
  }
  const renewed = await refreshCredential(credential);
  return { credential: { ...renewed, lastRefreshCheckAt: Date.now(), updatedAt: Date.now() }, changed: true };
}

export async function prepareBiliCredential(credential: BiliCredential, forceCheck = false): Promise<RefreshResult> {
  if (!forceCheck && Date.now() - credential.lastRefreshCheckAt < REFRESH_CHECK_INTERVAL_MS) {
    return { credential, changed: false };
  }
  const key = `${credentialFingerprint(biliCredentialCookie(credential, true))}:${credentialFingerprint(credential.acTimeValue)}`;
  const existing = pending.get(key);
  if (existing) return existing;
  const promise = checkAndRefresh(credential).finally(() => pending.delete(key));
  pending.set(key, promise);
  return promise;
}
