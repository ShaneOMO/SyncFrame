/**
 * P4 用户账户与视频 provider 配置（PoC：单进程内存存储）。
 *
 * 职责：
 * - 注册/登录：用户名 + 密码（scrypt 哈希 + 随机盐，内存存储）；
 * - 用户令牌：随机 256bit，30 天有效，用于 /api/me 与 provider 配置管理；
 * - provider 配置：每个登录用户可配置自己可用的视频 provider（OpenList 实例凭据）。
 *   凭据只存服务端内存；对外只回显 label/kind/baseUrl（不回显密码）。
 *
 * 说明：这是 PoC 级账户系统（重启即失），用于验证「登录用户配置 provider → 房间添加视频」的产品流程，
 * 不是生产鉴权方案。
 */

import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

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
  providers: Map<string, ProviderConfig>;
}

export interface PublicProvider {
  id: string;
  kind: "openlist" | "bilibili";
  label: string;
  baseUrl?: string;
  username?: string;
}

const USER_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function hashPassword(password: string, salt: string): string {
  return scryptSync(password, salt, 32).toString("hex");
}

export class UserAccounts {
  private readonly users = new Map<string, UserRecord>();
  private readonly tokens = new Map<string, { username: string; expiresAt: number }>();

  register(username: string, password: string): { ok: true; token: string } | { ok: false; error: string } {
    const name = username.trim().slice(0, 24);
    if (!/^[A-Za-z0-9_-]{2,24}$/.test(name)) return { ok: false, error: "用户名需为 2-24 位字母数字/下划线/横线" };
    if (password.length < 4) return { ok: false, error: "密码至少 4 位" };
    if (this.users.has(name)) return { ok: false, error: "用户名已存在" };
    const salt = randomBytes(16).toString("hex");
    this.users.set(name, { username: name, salt, hash: hashPassword(password, salt), providers: new Map() });
    return { ok: true, token: this.issueToken(name) };
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

  /** 更新该用户的 provider 配置（全量替换）。仅保留 OpenList 合法配置。 */
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
