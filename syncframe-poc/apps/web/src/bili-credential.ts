export interface BiliCredential {
  version: 1;
  sessdata: string;
  biliJct: string;
  buvid3: string;
  dedeUserId: string;
  acTimeValue: string;
  uname: string;
  lastRefreshCheckAt: number;
  updatedAt: number;
}

const KEY = "syncframe-bili-credential-v1";
const LEGACY_KEY = "syncframe-bili-sessdata";

function valid(value: unknown, maxLength = 512): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength && !/[;\s\u0000-\u001f]/.test(value);
}

export function normalizeBiliCredential(raw: unknown): BiliCredential | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (
    value.version !== 1
    || !valid(value.sessdata)
    || !valid(value.biliJct)
    || !valid(value.buvid3, 128)
    || !valid(value.dedeUserId, 64)
    || !valid(value.acTimeValue, 1024)
  ) return null;
  return {
    version: 1,
    sessdata: value.sessdata,
    biliJct: value.biliJct,
    buvid3: value.buvid3,
    dedeUserId: value.dedeUserId,
    acTimeValue: value.acTimeValue,
    uname: typeof value.uname === "string" ? value.uname.slice(0, 128) : "",
    lastRefreshCheckAt: typeof value.lastRefreshCheckAt === "number" ? value.lastRefreshCheckAt : 0,
    updatedAt: typeof value.updatedAt === "number" ? value.updatedAt : Date.now(),
  };
}

export function loadBiliCredential(): BiliCredential | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? normalizeBiliCredential(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

export function saveBiliCredential(raw: unknown): BiliCredential | null {
  const credential = normalizeBiliCredential(raw);
  if (!credential) return null;
  credential.updatedAt = Date.now();
  try {
    localStorage.setItem(KEY, JSON.stringify(credential));
    return credential;
  } catch {
    return null;
  }
}

export function clearBiliCredential(): void {
  try {
    localStorage.removeItem(KEY);
    localStorage.removeItem(LEGACY_KEY);
  } catch {
    /* 浏览器存储不可用时无需额外处理。 */
  }
}

export function biliCredentialHeaders(): Record<string, string> {
  const credential = loadBiliCredential();
  return credential ? { "X-Bili-Credential": JSON.stringify(credential) } : {};
}
