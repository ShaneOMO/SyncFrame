/**
 * 登录用户本地状态：localStorage 存取（大厅页与房间页/设置页共用）。
 * 结构：{ token, username }，浏览器长期持有。
 */

export const USER_KEY = "syncframe-user";

export interface LocalUser {
  token: string;
  username: string;
}

export function loadUser(): LocalUser | null {
  try {
    const raw = localStorage.getItem(USER_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as LocalUser;
    return parsed.token && parsed.username ? parsed : null;
  } catch {
    return null;
  }
}

export function saveUser(user: LocalUser): void {
  localStorage.setItem(USER_KEY, JSON.stringify(user));
}

export function clearUser(): void {
  localStorage.removeItem(USER_KEY);
}

export function userHeaders(user: LocalUser | null): Record<string, string> {
  return user ? { Authorization: `Bearer ${user.token}` } : {};
}
