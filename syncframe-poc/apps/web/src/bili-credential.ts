/**
 * B 站凭证（SESSDATA）的浏览器本地存储。
 *
 * 设计约定：凭证只存在于用户自己的浏览器（localStorage），服务器不落盘、不跨请求保存。
 * 请求时经 X-Bili-Sessdata 头一次性传给服务端解析播放地址，解析完即丢弃。
 * 因此这里的读写只影响本机本浏览器；换设备需要重新扫码。
 */

const KEY = "syncframe-bili-sessdata";

/**
 * 只接受 `SESSDATA=...` 单值形态，避免把其他 cookie 或脏数据存进来。
 * 取值字符集必须允许 `%`（B 站 SESSDATA 是 URL 编码的，如 `%2C`）；
 * 校验规则与 apps/server/src/bilibili.ts 的 parseSessdata 保持一致。
 */
function normalize(raw: string | null): string | null {
  if (!raw) return null;
  const value = raw.trim();
  return /^SESSDATA=[^;\s]{4,256}$/.test(value) ? value : null;
}

export function loadBiliSessdata(): string | null {
  try {
    return normalize(localStorage.getItem(KEY));
  } catch {
    return null;
  }
}

export function saveBiliSessdata(sessdata: string): boolean {
  const value = normalize(sessdata);
  if (!value) return false;
  try {
    localStorage.setItem(KEY, value);
    return true;
  } catch {
    return false;
  }
}

export function clearBiliSessdata(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* 隐私模式下不可用：忽略 */
  }
}

/** 附带 B 站凭证的请求头（未绑定时为空对象）。 */
export function biliCredentialHeaders(): Record<string, string> {
  const value = loadBiliSessdata();
  return value ? { "X-Bili-Sessdata": value } : {};
}
