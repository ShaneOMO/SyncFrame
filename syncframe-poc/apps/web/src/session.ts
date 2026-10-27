/**
 * P3 房间会话：成员令牌在浏览器 tab 内的存取（sessionStorage）。
 * 大厅页与房间页共用；令牌不出现在 URL 中。
 */

export interface RoomSession {
  memberToken: string;
  clientId: string;
  role: "host" | "viewer";
  name: string;
  roomId: string;
  expiresAt: number;
  /** 仅房主会话持有：成员令牌过期后凭它重建房主身份。 */
  hostSecret?: string;
}

export const sessionKey = (roomId: string): string => `syncframe-session-${roomId}`;

export function saveSession(sess: RoomSession): void {
  sessionStorage.setItem(sessionKey(sess.roomId), JSON.stringify(sess));
}

export function loadSession(roomId: string): RoomSession | null {
  try {
    const raw = sessionStorage.getItem(sessionKey(roomId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as RoomSession;
    if (!parsed.memberToken || !parsed.clientId || parsed.roomId !== roomId) return null;
    if (parsed.expiresAt && parsed.expiresAt <= Date.now()) {
      sessionStorage.removeItem(sessionKey(roomId));
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function clearSession(roomId: string): void {
  sessionStorage.removeItem(sessionKey(roomId));
}
