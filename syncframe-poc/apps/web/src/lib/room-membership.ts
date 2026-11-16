import { clearUser, loadUser, saveUser, type LocalUser } from "@/lib/user";
import {
  clearSession,
  loadSession,
  saveInviteCode,
  saveSession,
  type RoomSession,
} from "@/session";

export interface VerifiedAccount extends LocalUser {
  role: "admin" | "user";
}

export class AccountExpiredError extends Error {
  constructor() {
    super("登录已过期，请重新登录；再次点击加入可作为游客继续");
    this.name = "AccountExpiredError";
  }
}

interface SessionResponse {
  roomId: string;
  roomName: string;
  memberToken: string;
  clientId: string;
  role: "host" | "viewer";
  kind: "user" | "guest";
  name: string;
  username: string | null;
  expiresAt: number;
  inviteCode?: string | null;
}

function parseSession(data: SessionResponse, requestedRoomId: string): RoomSession {
  if (
    data.roomId !== requestedRoomId ||
    typeof data.memberToken !== "string" ||
    typeof data.clientId !== "string" ||
    (data.role !== "host" && data.role !== "viewer") ||
    (data.kind !== "user" && data.kind !== "guest") ||
    typeof data.name !== "string"
  ) throw new Error("服务端返回了无效的房间身份");
  return {
    roomId: data.roomId,
    roomName: data.roomName || data.roomId,
    memberToken: data.memberToken,
    clientId: data.clientId,
    role: data.role,
    kind: data.kind,
    name: data.name,
    username: data.username ?? null,
    expiresAt: Number(data.expiresAt),
  };
}

async function errorFrom(response: Response): Promise<Error> {
  const body = (await response.json().catch(() => ({}))) as { error?: string; code?: string };
  if (body.code === "ACCOUNT_AUTH_EXPIRED") {
    clearUser();
    return new AccountExpiredError();
  }
  return new Error(body.error ?? `HTTP ${response.status}`);
}

export async function verifyAccount(): Promise<VerifiedAccount | null> {
  const stored = loadUser();
  if (!stored) return null;
  let response: Response;
  try {
    response = await fetch("/api/me", { headers: { Authorization: `Bearer ${stored.token}` } });
  } catch {
    throw new Error("暂时无法验证登录状态，请检查网络后重试");
  }
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      clearUser();
      throw new AccountExpiredError();
    }
    throw new Error(`暂时无法验证登录状态（HTTP ${response.status}）`);
  }
  const body = (await response.json()) as { username: string; role: "admin" | "user" };
  const account = { token: stored.token, username: body.username, role: body.role };
  saveUser({ token: account.token, username: account.username });
  return account;
}

export function storeJoinResponse(roomId: string, value: unknown, inviteCode = ""): RoomSession {
  const session = parseSession(value as SessionResponse, roomId);
  saveSession(session);
  const responseInvite = (value as SessionResponse).inviteCode;
  if (session.role === "host" && typeof responseInvite === "string") saveInviteCode(roomId, responseInvite);
  else if (inviteCode) saveInviteCode(roomId, inviteCode);
  return session;
}

interface JoinOptions {
  roomId: string;
  account: LocalUser | null;
  inviteCode?: string;
  guestName?: string;
}

const pendingJoins = new Map<string, Promise<RoomSession>>();

async function requestJoin(options: JoinOptions): Promise<RoomSession> {
  const inviteCode = options.inviteCode?.trim() ?? "";
  const response = await fetch(`/api/rooms/${encodeURIComponent(options.roomId)}/join`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(options.account ? { Authorization: `Bearer ${options.account.token}` } : {}),
    },
    body: JSON.stringify({
      ...(options.account ? {} : { name: options.guestName?.trim() ?? "" }),
      ...(inviteCode ? { inviteCode } : {}),
    }),
  });
  if (!response.ok) throw await errorFrom(response);
  return storeJoinResponse(options.roomId, await response.json(), inviteCode);
}

export function joinRoom(options: JoinOptions): Promise<RoomSession> {
  const key = [
    options.roomId,
    options.account?.username ?? "guest",
    options.inviteCode?.trim().toUpperCase() ?? "",
    options.account ? "" : options.guestName?.trim() ?? "",
  ].join(":");
  const pending = pendingJoins.get(key);
  if (pending) return pending;
  const request = requestJoin(options).finally(() => pendingJoins.delete(key));
  pendingJoins.set(key, request);
  return request;
}

export async function restoreRoomSession(roomId: string, account: LocalUser | null): Promise<RoomSession | null> {
  const previous = loadSession(roomId);
  if (!previous) return null;
  try {
    const response = await fetch(`/api/rooms/${encodeURIComponent(roomId)}/session`, {
      headers: { Authorization: `Bearer ${previous.memberToken}` },
    });
    if (!response.ok) {
      clearSession(roomId);
      return null;
    }
    const session = storeJoinResponse(roomId, await response.json());
    const sameIdentity = account
      ? session.kind === "user" && session.username === account.username
      : session.kind === "guest";
    if (!sameIdentity) {
      clearSession(roomId);
      return null;
    }
    return session;
  } catch {
    return null;
  }
}
