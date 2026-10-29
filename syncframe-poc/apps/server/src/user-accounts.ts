/**
 * 用户账户与视频 provider 配置。
 *
 * 权限模型：
 * - 注册接口已关闭；账户由环境变量初始化的管理员创建/删除/管理（见 index.ts 的
 *   ADMIN_USERNAME / ADMIN_PASSWORD）；
 * - 角色：admin（管理账户）/ user（普通用户）。游客（未登录）只能凭邀请码加入房间，
 *   不能创建房间、不能配置 provider；
 * - 每个用户在自己的 provider 配置里保存 OpenList 凭据 / Bilibili SESSDATA
 *   （凭据只存服务端，不回显密码与 cookie）。
 *
 * 持久化：传入 dataDir 后，账户（含 provider 凭据）落盘为 <dataDir>/users.json
 * （原子写入：tmp + rename）；重启后账户保留，用户令牌仍内存态（重启需重新登录）。
 * 注意：该文件含凭据，务必保持私有（chmod 600 / 不要提交 git）。
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

export type UserRole = "admin" | "user";

export interface OpenListProviderConfig {
  id: string;
  kind: "openlist";
  label: string;
  baseUrl: string;
  username: string;
  password: string;
}

/** Bilibili provider（参考 SyncTV）：可选 SESSDATA cookie，匿名也可播放（≤1080P）。 */
export interface BilibiliProviderConfig {
  id: string;
  kind: "bilibili";
  label: string;
  /** SESSDATA 等 cookie 串（可选；只存服务端内存，不回显）。 */
  cookie?: string;
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
  /** 持久化文件路径；null = 纯内存（测试/未配置 dataDir）。 */
  private readonly file: string | null;

  constructor(dataDir: string | null = null) {
    this.file = dataDir ? path.join(dataDir, "users.json") : null;
    if (!this.file) return;
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf-8")) as {
        users?: (Omit<UserRecord, "providers"> & { providers?: ProviderConfig[] })[];
      };
      for (const u of raw.users ?? []) {
        this.users.set(u.username, { ...u, providers: new Map((u.providers ?? []).map((p) => [p.id, p])) });
      }
    } catch {
      // 文件不存在或损坏：从空账户开始（损坏时备份由部署者处理）。
    }
  }

  /** 原子落盘（tmp + rename）；未配置 dataDir 时为无操作。 */
  private save(): void {
    if (!this.file) return;
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      writeFileSync(
        tmp,
        JSON.stringify({ version: 1, users: [...this.users.values()].map((u) => ({ ...u, providers: [...u.providers.values()] })) }),
      );
      renameSync(tmp, this.file);
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
        const cookie = typeof p.cookie === "string" ? p.cookie.trim() : "";
        next.set(id, { id, kind: "bilibili", label: label.slice(0, 24), ...(cookie ? { cookie } : {}) });
      } else {
        return { ok: false, error: "仅支持 openlist / bilibili provider" };
      }
    }
    user.providers = next;
    this.save();
    return { ok: true };
  }

  /** 对外展示形态（不含密码/cookie 等凭据）。 */
  listProviders(username: string): PublicProvider[] {
    const user = this.users.get(username);
    if (!user) return [];
    return [...user.providers.values()].map((p) => {
      if (p.kind === "openlist") {
        const { password: _pw, ...pub } = p;
        return pub;
      }
      const { cookie: _ck, ...pub } = p;
      return pub;
    });
  }
}
