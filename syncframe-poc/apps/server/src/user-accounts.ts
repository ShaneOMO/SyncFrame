/**
 * 用户账户与视频 provider 配置。
 *
 * 权限模型：
 * - 注册接口已关闭；账户由环境变量初始化的管理员创建/删除/管理（见 index.ts 的
 *   ADMIN_USERNAME / ADMIN_PASSWORD）；
 * - 角色：admin（管理账户）/ user（普通用户）。游客（未登录）只能凭邀请码加入房间，
 *   不能创建房间、不能配置 provider；
 * - OpenList 凭据保存在服务端 provider 配置中；
 *   **Bilibili SESSDATA 不入服务端**：由浏览器 localStorage 持有，请求时经
 *   X-Bili-Sessdata 头传入，服务端即用即弃（见 index.ts）。
 *
 * 持久化：传入 dataDir 后，账户（含 OpenList 凭据）经 store.ts 落盘为 <dataDir>/syncframe.db
 * （SQLite，单条写入原子）；重启后账户保留，用户令牌仍内存态（重启需重新登录）。
 * 首次启动自动从旧的 users.json 迁移。注意：库文件含 OpenList 凭据，务必保持私有。
 */

import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { Store } from "./store.ts";

export type UserRole = "admin" | "user";

export interface OpenListProviderConfig {
  id: string;
  kind: "openlist";
  label: string;
  baseUrl: string;
  username: string;
  password: string;
}

/** Bilibili provider（参考 SyncTV）：仅保存展示用标签，SESSDATA 由浏览器持有。 */
export interface BilibiliProviderConfig {
  id: string;
  kind: "bilibili";
  label: string;
}

export type ProviderConfig = OpenListProviderConfig | BilibiliProviderConfig;

interface UserRecord {
  username: string;
  salt: string;
  hash: string;
  role: UserRole;
  providers: Map<string, ProviderConfig>;
}

export interface PublicProvider {
  id: string;
  kind: "openlist" | "bilibili";
  label: string;
  baseUrl?: string;
  username?: string;
}

export interface PublicUser {
  username: string;
  role: UserRole;
  providerCount: number;
  createdAt: number;
}

const USER_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function hashPassword(password: string, salt: string): string {
  return scryptSync(password, salt, 32).toString("hex");
}

function validateCredentials(username: string, password: string): string | null {
  if (!/^[A-Za-z0-9_-]{2,24}$/.test(username)) return "用户名需为 2-24 位字母数字/下划线/横线";
  if (password.length < 8) return "密码至少 8 位";
  return null;
}

export class UserAccounts {
  private readonly users = new Map<string, UserRecord>();
  private readonly tokens = new Map<string, { username: string; expiresAt: number }>();
  /** 持久化存储；null = 纯内存（测试/未配置 dataDir）。 */
  private readonly store: Store | null;

  constructor(dataDir: string | null = null) {
    if (!dataDir) {
      this.store = null;
      return;
    }
    this.store = new Store(dataDir);
    for (const u of this.store.loadUsers()) {
      this.users.set(u.username, {
        username: u.username,
        salt: u.salt,
        hash: u.hash,
        role: u.role as UserRecord["role"],
        providers: new Map(
          ((u.providers ?? []) as ProviderConfig[]).map((p) => {
            // 旧版本曾把 SESSDATA 落盘：加载时立即丢弃，确保服务端不再持有 B 站凭据。
            if (p.kind === "bilibili" && "cookie" in p) {
              const { cookie: _legacy, ...rest } = p as BilibiliProviderConfig & { cookie?: string };
              return [p.id, rest as BilibiliProviderConfig] as const;
            }
            return [p.id, p] as const;
          }),
        ),
      });
    }
  }

  /** 全量同步落盘；未配置 dataDir 时为无操作。 */
  private save(): void {
    if (!this.store) return;
    try {
      for (const u of this.users.values()) {
        this.store.upsertUser({ ...u, providers: [...u.providers.values()] });
      }
      // 删除操作后同步移除已不存在的账户。
      const names = new Set(this.users.keys());
      for (const s of this.store.loadUsers()) {
        if (!names.has(s.username)) this.store.deleteUser(s.username);
      }
    } catch (err) {
      console.warn(`[store] 账户落盘失败: ${err instanceof Error ? err.message : err}`);
    }
  }

  /**
   * 启动时以环境变量初始化管理员账户：不存在则创建，已存在则提升为 admin。
   * 幂等，可重复调用。凭据无效（空/格式错）时返回 false，由调用方告警。
   */
  initAdmin(username: string, password: string): boolean {
    const name = username.trim();
    if (!name || !password) return false;
    const existing = this.users.get(name);
    if (existing) {
      existing.role = "admin";
      this.save();
      return true;
    }
    const invalid = validateCredentials(name, password);
    if (invalid) return false;
    const salt = randomBytes(16).toString("hex");
    this.users.set(name, {
      username: name,
      salt,
      hash: hashPassword(password, salt),
      role: "admin",
      providers: new Map(),
    });
    this.save();
    return true;
  }

  login(username: string, password: string): string | null {
    const user = this.users.get(username.trim());
    if (!user) return null;
    const candidate = hashPassword(password, user.salt);
    const ok = timingSafeEqual(Buffer.from(candidate, "hex"), Buffer.from(user.hash, "hex"));
    return ok ? this.issueToken(user.username) : null;
  }

  private issueToken(username: string): string {
    const token = randomBytes(32).toString("base64url");
    this.tokens.set(token, { username, expiresAt: Date.now() + USER_TOKEN_TTL_MS });
    return token;
  }

  /** 校验用户令牌 → 用户名；未知/过期返回 null。 */
  authenticate(token: string | null | undefined): string | null {
    if (!token) return null;
    const rec = this.tokens.get(token);
    if (!rec) return null;
    if (rec.expiresAt <= Date.now()) {
      this.tokens.delete(token);
      return null;
    }
    return rec.username;
  }

  getUser(username: string): UserRecord | null {
    return this.users.get(username) ?? null;
  }

  isAdmin(username: string): boolean {
    return this.users.get(username)?.role === "admin";
  }

  /** 关闭底层存储连接（测试清理临时目录前调用；常驻进程无需调用）。 */
  close(): void {
    this.store?.close();
  }

  /** 管理员创建普通账户。 */
  createUser(byAdmin: string, username: string, password: string): { ok: true } | { ok: false; error: string } {
    if (!this.isAdmin(byAdmin)) return { ok: false, error: "只有管理员可以管理账户" };
    const name = username.trim();
    const invalid = validateCredentials(name, password);
    if (invalid) return { ok: false, error: invalid };
    if (this.users.has(name)) return { ok: false, error: "用户名已存在" };
    const salt = randomBytes(16).toString("hex");
    this.users.set(name, { username: name, salt, hash: hashPassword(password, salt), role: "user", providers: new Map() });
    this.save();
    return { ok: true };
  }

  /** 管理员删除账户：不能删除自己，也不能删除最后一个管理员。 */
  deleteUser(byAdmin: string, username: string): { ok: true } | { ok: false; error: string } {
    if (!this.isAdmin(byAdmin)) return { ok: false, error: "只有管理员可以管理账户" };
    const name = username.trim();
    if (name === byAdmin) return { ok: false, error: "不能删除当前登录的管理员" };
    const target = this.users.get(name);
    if (!target) return { ok: false, error: "用户不存在" };
    if (target.role === "admin" && ![...this.users.values()].some((u) => u.role === "admin" && u.username !== name)) {
      return { ok: false, error: "不能删除最后一个管理员" };
    }
    this.users.delete(name);
    for (const [tok, rec] of this.tokens) {
      if (rec.username === name) this.tokens.delete(tok);
    }
    this.save();
    return { ok: true };
  }

  /** 管理员重置任意账户密码。 */
  resetPassword(byAdmin: string, username: string, password: string): { ok: true } | { ok: false; error: string } {
    if (!this.isAdmin(byAdmin)) return { ok: false, error: "只有管理员可以管理账户" };
    const user = this.users.get(username.trim());
    if (!user) return { ok: false, error: "用户不存在" };
    if (password.length < 8) return { ok: false, error: "密码至少 8 位" };
    user.salt = randomBytes(16).toString("hex");
    user.hash = hashPassword(password, user.salt);
    // 旧令牌全部作废，需重新登录。
    for (const [tok, rec] of this.tokens) {
      if (rec.username === user.username) this.tokens.delete(tok);
    }
    this.save();
    return { ok: true };
  }

  /** 管理员列出全部账户（不含任何凭据）。 */
  listUsers(byAdmin: string): PublicUser[] | null {
    if (!this.isAdmin(byAdmin)) return null;
    return [...this.users.values()].map((u) => ({
      username: u.username,
      role: u.role,
      providerCount: u.providers.size,
      createdAt: 0, // PoC 内存存储未记录创建时间
    }));
  }

  /** 更新该用户的 provider 配置（全量替换）。仅保留 openlist/bilibili 合法配置。 */
  setProviders(username: string, providers: unknown): { ok: true } | { ok: false; error: string } {
    const user = this.users.get(username);
    if (!user) return { ok: false, error: "用户不存在" };
    if (!Array.isArray(providers)) return { ok: false, error: "providers 必须是数组" };
    const next = new Map<string, ProviderConfig>();
    for (const raw of providers) {
      if (typeof raw !== "object" || raw === null) return { ok: false, error: "provider 配置格式错误" };
      const p = raw as Record<string, unknown>;
      const id = typeof p.id === "string" && p.id ? p.id : randomBytes(6).toString("base64url");
      if (p.kind === "openlist") {
        const baseUrl = typeof p.baseUrl === "string" ? p.baseUrl.trim() : "";
        const usernameCfg = typeof p.username === "string" ? p.username.trim() : "";
        const password = typeof p.password === "string" ? p.password : "";
        const label = (typeof p.label === "string" ? p.label.trim() : "") || usernameCfg || "OpenList";
        if (!/^https?:\/\//.test(baseUrl)) return { ok: false, error: "baseUrl 必须是 http(s) 地址" };
        if (!usernameCfg || !password) return { ok: false, error: "OpenList provider 需要用户名与密码" };
        next.set(id, { id, kind: "openlist", label: label.slice(0, 24), baseUrl: baseUrl.replace(/\/+$/, ""), username: usernameCfg, password });
      } else if (p.kind === "bilibili") {
        const label = (typeof p.label === "string" ? p.label.trim() : "") || "哔哩哔哩";
        // SESSDATA 由浏览器持有，服务端只保留展示标签（即使请求里带了 cookie 也丢弃）。
        next.set(id, { id, kind: "bilibili", label: label.slice(0, 24) });
      } else {
        return { ok: false, error: "仅支持 openlist / bilibili provider" };
      }
    }
    user.providers = next;
    this.save();
    return { ok: true };
  }

  /** 对外展示形态（不含密码等凭据）。 */
  listProviders(username: string): PublicProvider[] {
    const user = this.users.get(username);
    if (!user) return [];
    return [...user.providers.values()].map((p) => {
      if (p.kind === "openlist") {
        const { password: _pw, ...pub } = p;
        return pub;
      }
      return p as PublicProvider;
    });
  }
}
