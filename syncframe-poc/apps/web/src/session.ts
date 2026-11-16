export interface RoomSession {
  memberToken: string;
  clientId: string;
  role: "host" | "viewer";
  kind: "user" | "guest";
  name: string;
  username: string | null;
  roomId: string;
  roomName: string;
  expiresAt: number;
}

export const sessionKey = (roomId: string): string => `syncframe-session-${roomId}`;
export const inviteKey = (roomId: string): string => `syncframe-invite-${roomId}`;

export function saveSession(session: RoomSession): void {
  sessionStorage.setItem(sessionKey(session.roomId), JSON.stringify(session));
}

export function loadSession(roomId: string): RoomSession | null {
  try {
    const raw = sessionStorage.getItem(sessionKey(roomId));
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<RoomSession>;
    if (
      typeof value.memberToken !== "string" ||
      typeof value.clientId !== "string" ||
      value.roomId !== roomId ||
      (value.role !== "host" && value.role !== "viewer") ||
      (value.kind !== "user" && value.kind !== "guest") ||
      typeof value.name !== "string"
    ) return null;
    return value as RoomSession;
  } catch {
    return null;
  }
}

export function clearSession(roomId: string): void {
  sessionStorage.removeItem(sessionKey(roomId));
}

export function saveInviteCode(roomId: string, inviteCode: string): void {
  if (inviteCode) sessionStorage.setItem(inviteKey(roomId), inviteCode);
  else sessionStorage.removeItem(inviteKey(roomId));
}

export function loadInviteCode(roomId: string): string {
  return sessionStorage.getItem(inviteKey(roomId)) ?? "";
}
