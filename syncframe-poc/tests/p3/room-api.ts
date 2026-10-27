/**
 * P3 房间 API 测试助手：创建/加入房间的 HTTP 封装 + 服务端子进程管理。
 * 供 security.test.ts、e2e-smoke、P2 测试改造共用。
 */

import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

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

export async function postJson(base: string, url: string, body: unknown, token?: string): Promise<{
  status: number;
  data: Record<string, unknown>;
}> {
  const res = await fetch(`${base}${url}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

export async function getJson(base: string, url: string, token?: string): Promise<{
  status: number;
  data: Record<string, unknown>;
}> {
  const res = await fetch(`${base}${url}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  return { status: res.status, data: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

export function createRoom(base: string, name = "房主", clientId?: string): Promise<{
  status: number;
  data: CreatedRoom;
}> {
  return postJson(base, "/api/rooms", { name, ...(clientId ? { clientId } : {}) }) as unknown as Promise<{
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

/** 启动真实服务端子进程；OPENLIST_* 由调用方在 env 中给出。 */
export async function startServer(port: number, env: Record<string, string> = {}): Promise<SpawnedServer> {
  const proc = spawn(process.execPath, ["--import", "tsx", "apps/server/src/index.ts"], {
    cwd: repoRoot,
    env: { ...process.env, SERVER_PORT: String(port), ...env },
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
