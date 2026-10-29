/**
 * P3 房间 API 测试助手：创建/加入房间的 HTTP 封装 + 服务端子进程管理。
 * 供 security.test.ts、e2e-smoke、P2 测试改造共用。
 *
 * 权限模型（注册已关闭）：服务端以 ADMIN_USERNAME/ADMIN_PASSWORD 环境变量初始化管理员；
 * 测试用 startServer 传入该环境变量，然后 loginUser 登录、createUserAsAdmin 创建普通账户。
 */

import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export const ADMIN_USER = "testadmin";
export const ADMIN_PASS = "adminpw123";

export interface RoomMember {
  memberToken: string;
  clientId: string;
  role: "host" | "viewer";
  expiresAt: number;
}

export interface CreatedRoom extends RoomMember {
  roomId: string;
  inviteCode: string;
  hostSecret: string;
}

export async function postJson(base: string, url: string, body: unknown, token?: string, extraHeaders: Record<string, string> = {}): Promise<{
  status: number;
  data: Record<string, unknown>;
}> {
  const res = await fetch(`${base}${url}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

export async function getJson(base: string, url: string, token?: string, extraHeaders: Record<string, string> = {}): Promise<{
  status: number;
  data: Record<string, unknown>;
}> {
  const res = await fetch(`${base}${url}`, {
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extraHeaders },
  });
  return { status: res.status, data: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

/** 登录账户 → userToken。 */
export async function loginUser(base: string, username: string, password: string): Promise<string> {
  const res = await postJson(base, "/api/auth/login", { username, password });
  if (res.status !== 200 || typeof res.data.userToken !== "string") {
    throw new Error(`登录失败 ${username}: HTTP ${res.status} ${JSON.stringify(res.data)}`);
  }
  return res.data.userToken;
}

/** 管理员创建普通账户并返回其用户名。 */
export async function createUserAsAdmin(base: string, adminToken: string, username: string, password = "userpw123"): Promise<void> {
  const res = await postJson(base, "/api/admin/users", { username, password }, adminToken);
  if (res.status !== 200) {
    throw new Error(`创建用户失败 ${username}: HTTP ${res.status} ${JSON.stringify(res.data)}`);
  }
}

/** 创建房间：必须携带创建者账户的用户令牌（游客 401）。 */
export function createRoom(base: string, name = "房主", userToken = "", clientId?: string): Promise<{
  status: number;
  data: CreatedRoom;
}> {
  return postJson(base, "/api/rooms", { name, ...(clientId ? { clientId } : {}) }, userToken) as unknown as Promise<{
    status: number;
    data: CreatedRoom;
  }>;
}

export function joinRoom(
  base: string,
  roomId: string,
  name: string,
  inviteCode?: string,
  hostSecret?: string,
): Promise<{ status: number; data: RoomMember & { error?: string } }> {
  return postJson(base, `/api/rooms/${encodeURIComponent(roomId)}/join`, {
    name,
    ...(inviteCode ? { inviteCode } : {}),
    ...(hostSecret ? { hostSecret } : {}),
  }) as unknown as Promise<{ status: number; data: RoomMember & { error?: string } }>;
}

export interface SpawnedServer {
  proc: ChildProcess;
  stdout: string;
}

/** 启动真实服务端子进程；ADMIN_USERNAME/ADMIN_PASSWORD 由调用方在 env 中给出。
 *  默认 DATA_DIR 指向每次运行新建的临时目录（测试间/运行间互不污染）。 */
export async function startServer(port: number, env: Record<string, string> = {}): Promise<SpawnedServer> {
  const dataDir = path.join(process.env.TEMP ?? "/tmp", `syncframe-test-${port}-${Date.now()}`);
  const proc = spawn(process.execPath, ["--import", "tsx", "apps/server/src/index.ts"], {
    cwd: repoRoot,
    env: { ...process.env, SERVER_PORT: String(port), DATA_DIR: dataDir, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const out: SpawnedServer = { proc, stdout: "" };
  proc.stdout?.on("data", (d) => {
    out.stdout += String(d);
  });
  proc.stderr?.on("data", (d) => process.stderr.write(d));
  const start = Date.now();
  while (Date.now() - start < 20_000) {
    try {
      const res = await fetch(`http://localhost:${port}/api/health`);
      if (res.ok) return out;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  proc.kill();
  throw new Error(`服务端启动超时 (port=${port})`);
}
