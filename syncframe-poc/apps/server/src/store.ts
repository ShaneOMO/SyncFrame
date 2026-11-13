/**
 * SQLite 持久化层（node:sqlite 内置模块，无原生依赖，Node ≥ 22.5）。
 *
 * 为什么从「单一 JSON 整文件重写」迁过来：
 * - JSON 每次变更全量重写，进程在写入瞬间被杀/容器被重建会得到截断文件（旧实现加载时
 *   直接静默放弃全部数据）；SQLite 单条写天然原子，并自带事务与损坏恢复；
 * - 数据量增长时 JSON 全量序列化开销线性上升；SQLite 按需读写；
 * - 仍是「单文件」部署（<dataDir>/syncframe.db），挂载/备份方式不变。
 *
 * 结构：users / rooms 两张表。providers / media / members 以内嵌 JSON 列存放
 * （该 PoC 的数据形态就是整块读写的文档结构，拆成关系列没有收益）。
 *
 * 迁移：数据库文件不存在而旧的 users.json / rooms.json 存在时，自动导入一次，
 * 并将旧文件重命名为 *.migrated 备份（不删除，部署者可自行清理）。
 * 该文件含 OpenList 凭据与房间成员令牌，务必保持私有（落盘权限 0600）。
 */

import { DatabaseSync } from "node:sqlite";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import path from "node:path";

/** 用户记录（与 user-accounts.ts 的落盘形态一致，providers 为数组）。 */
export interface StoredUser {
  username: string;
  salt: string;
  hash: string;
  role: string;
  providers?: unknown[];
}

/** 房间记录（与 room-auth.ts 的落盘形态一致，media/members 为 entries 数组）。 */
export interface StoredRoom {
  roomId: string;
  /** 房间名（旧数据无此列，加载时回落为 hostName）。 */
  roomName?: string | null;
  inviteCode: string | null;
  hostSecret: string;
  createdAt: number;
  lastActiveAt: number;
  hostClientId: string;
  hostName: string;
  hostUser: string;
  media?: [string, unknown][];
  members?: [string, unknown][];
}

export class Store {
  private readonly db: DatabaseSync | null;

  constructor(dataDir: string | null = null) {
    if (!dataDir) {
      this.db = null;
      return;
    }
    mkdirSync(dataDir, { recursive: true });
    const file = path.join(dataDir, "syncframe.db");
    const fresh = !existsSync(file);
    this.db = new DatabaseSync(file);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        username   TEXT PRIMARY KEY,
        salt       TEXT NOT NULL,
        hash       TEXT NOT NULL,
        role       TEXT NOT NULL,
        providers  TEXT NOT NULL DEFAULT '[]'
      );
      CREATE TABLE IF NOT EXISTS rooms (
        room_id        TEXT PRIMARY KEY,
        invite_code    TEXT,
        host_secret    TEXT NOT NULL,
        created_at     INTEGER NOT NULL,
        last_active_at INTEGER NOT NULL,
        host_client_id TEXT NOT NULL,
        host_name      TEXT NOT NULL,
        host_user      TEXT NOT NULL,
        media          TEXT NOT NULL DEFAULT '[]',
        members        TEXT NOT NULL DEFAULT '[]'
      );
    `);
    chmodSync(file, 0o600);
    // 旧库补列：room_name（房间名与房主名解耦前创建的库没有这一列）。
    const cols = this.db.prepare("PRAGMA table_info(rooms)").all() as { name: string }[];
    if (!cols.some((c) => c.name === "room_name")) {
      this.db.exec("ALTER TABLE rooms ADD COLUMN room_name TEXT");
    }
    if (fresh) this.migrateFromJson(dataDir);
  }

  /** 未配置 dataDir（测试/纯内存）时为无操作存储。 */
  get persistent(): boolean {
    return this.db !== null;
  }

  /** 一次性迁移：旧的 users.json / rooms.json → SQLite，成功后旧文件加 .migrated 后缀。 */
  private migrateFromJson(dataDir: string): void {
    const usersFile = path.join(dataDir, "users.json");
    const roomsFile = path.join(dataDir, "rooms.json");
    try {
      const raw = JSON.parse(readFileSync(usersFile, "utf-8")) as { users?: StoredUser[] };
      for (const u of raw.users ?? []) this.upsertUser(u);
      renameSync(usersFile, `${usersFile}.migrated`);
      console.log(`[store] 已从 users.json 迁移 ${raw.users?.length ?? 0} 个账户到 SQLite`);
    } catch {
      /* 无旧文件或损坏：跳过 */
    }
    try {
      const raw = JSON.parse(readFileSync(roomsFile, "utf-8")) as {
        rooms?: (Omit<StoredRoom, "media" | "members"> & {
          media?: [string, unknown][];
          members?: [string, unknown][];
        })[];
      };
      for (const r of raw.rooms ?? []) this.putRoom(r);
      renameSync(roomsFile, `${roomsFile}.migrated`);
      console.log(`[store] 已从 rooms.json 迁移 ${raw.rooms?.length ?? 0} 个房间到 SQLite`);
    } catch {
      /* 无旧文件或损坏：跳过 */
    }
  }

  // ── users ───────────────────────────────────────────────────

  loadUsers(): StoredUser[] {
    if (!this.db) return [];
    return this.db
      .prepare("SELECT username, salt, hash, role, providers FROM users")
      .all()
      .map((row) => {
        const r = row as { username: string; salt: string; hash: string; role: string; providers: string };
        return { ...r, providers: JSON.parse(r.providers) as unknown[] };
      });
  }

  upsertUser(u: StoredUser): void {
    if (!this.db) return;
    this.db
      .prepare(
        `INSERT INTO users (username, salt, hash, role, providers) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(username) DO UPDATE SET salt=excluded.salt, hash=excluded.hash,
           role=excluded.role, providers=excluded.providers`,
      )
      .run(u.username, u.salt, u.hash, u.role, JSON.stringify(u.providers ?? []));
  }

  deleteUser(username: string): void {
    if (!this.db) return;
    this.db.prepare("DELETE FROM users WHERE username = ?").run(username);
  }

  // ── rooms ───────────────────────────────────────────────────

  loadRooms(): StoredRoom[] {
    if (!this.db) return [];
    return this.db
      .prepare("SELECT * FROM rooms")
      .all()
      .map((row) => {
        const r = row as Record<string, unknown>;
        return {
          roomId: r.room_id as string,
          roomName: (r.room_name as string | null) ?? null,
          inviteCode: (r.invite_code as string | null) ?? null,
          hostSecret: r.host_secret as string,
          createdAt: r.created_at as number,
          lastActiveAt: r.last_active_at as number,
          hostClientId: r.host_client_id as string,
          hostName: r.host_name as string,
          hostUser: r.host_user as string,
          media: JSON.parse((r.media as string) ?? "[]") as [string, unknown][],
          members: JSON.parse((r.members as string) ?? "[]") as [string, unknown][],
        };
      });
  }

  putRoom(r: StoredRoom): void {
    if (!this.db) return;
    this.db
      .prepare(
        `INSERT INTO rooms (room_id, room_name, invite_code, host_secret, created_at, last_active_at,
           host_client_id, host_name, host_user, media, members)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(room_id) DO UPDATE SET room_name=excluded.room_name,
           invite_code=excluded.invite_code,
           host_secret=excluded.host_secret, created_at=excluded.created_at,
           last_active_at=excluded.last_active_at, host_client_id=excluded.host_client_id,
           host_name=excluded.host_name, host_user=excluded.host_user,
           media=excluded.media, members=excluded.members`,
      )
      .run(
        r.roomId,
        r.roomName ?? null,
        r.inviteCode,
        r.hostSecret,
        r.createdAt,
        r.lastActiveAt,
        r.hostClientId,
        r.hostName,
        r.hostUser,
        JSON.stringify(r.media ?? []),
        JSON.stringify(r.members ?? []),
      );
  }

  deleteRoom(roomId: string): void {
    if (!this.db) return;
    this.db.prepare("DELETE FROM rooms WHERE room_id = ?").run(roomId);
  }

  /** 关闭数据库连接（Windows 下打开的文件句柄会阻止目录删除；进程退出可不调用）。 */
  close(): void {
    this.db?.close();
  }
}
