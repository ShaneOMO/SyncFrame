/**
 * OpenList 客户端 v2 —— 契约与健壮性对齐 SyncTV synctv-media-providers 的 alist provider：
 * - fs/list、fs/get 使用 POST JSON body（官方契约；GET 查询串不是稳定接口）
 * - fs/get 携带 user_agent（部分存储按 UA 生成/校验 raw_url）
 * - 自动附带 Origin / Referer（从 baseUrl 推导，部分存储防盗链校验）
 * - 路径穿越校验、baseUrl 规范化（拒绝 userinfo / 查询串 / fragment）
 * - 网络错误 / 5xx / 429 指数退避重试；响应体大小限制
 * - fs/search 搜索（P3 文件浏览用）
 */

import { OpenListAdapterError, normalizeError } from "./errors.ts";
import type {
  FsGetResult,
  FsListResult,
  FsSearchResult,
  LoginResult,
  MeResult,
  OpenListClientConfig,
  OpenListEnvelope,
} from "./types.ts";

/** JSON 响应体上限（SyncTV 用 json_with_limit 防异常大响应） */
const MAX_JSON_BYTES = 16 * 1024 * 1024;
const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

/** 路径穿越校验（对齐 SyncTV validate_path_for_traversal） */
export function validatePath(path: string): void {
  if (!path.startsWith("/")) {
    throw new OpenListAdapterError({ kind: "config", message: `路径必须以 / 开头: ${path}` });
  }
  const segments = path.split("/");
  for (const seg of segments) {
    if (seg === "..") {
      throw new OpenListAdapterError({ kind: "config", message: `路径不允许包含 ..: ${path}` });
    }
  }
}

/** 规范化 baseUrl：仅 http/https，不允许 userinfo / 查询串 / fragment，去尾斜杠 */
export function normalizeBaseUrl(input: string): string {
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    throw new OpenListAdapterError({ kind: "config", message: `非法的 baseUrl: ${input}` });
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new OpenListAdapterError({ kind: "config", message: `baseUrl 仅支持 http/https: ${input}` });
  }
  if (parsed.username || parsed.password) {
    throw new OpenListAdapterError({ kind: "config", message: "baseUrl 不允许包含用户名/密码" });
  }
  if (parsed.search || parsed.hash) {
    throw new OpenListAdapterError({ kind: "config", message: "baseUrl 不允许包含查询串或 fragment" });
  }
  return parsed.toString().replace(/\/+$/, "");
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export class OpenListClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private token: string | undefined;

  constructor(config: OpenListClientConfig) {
    this.baseUrl = normalizeBaseUrl(config.baseUrl);
    this.timeoutMs = config.timeoutMs ?? 15_000;
    this.retries = config.retries ?? 2;
    this.token = config.token;
  }

  get hasToken(): boolean {
    return Boolean(this.token);
  }

  /** 登录并持有令牌；hashed=true 时使用 /api/auth/login/hash */
  async login(username: string, password: string, opts: { hashed?: boolean; otpCode?: string } = {}): Promise<void> {
    const endpoint = opts.hashed ? "/api/auth/login/hash" : "/api/auth/login";
    const data = await this.request<LoginResult>(
      "POST",
      endpoint,
      { username, password, otp_code: opts.otpCode ?? "" },
      false,
    );
    if (!data.token) {
      throw new OpenListAdapterError({ kind: "api", message: "登录成功但响应缺少 token", apiCode: 200 });
    }
    this.token = data.token;
  }

  /** 当前登录用户信息（验证令牌有效性） */
  async me(): Promise<MeResult> {
    return this.request<MeResult>("GET", "/api/me");
  }

  /** 列目录（POST /api/fs/list） */
  async listDir(
    path: string,
    opts: { page?: number; perPage?: number; refresh?: boolean; password?: string } = {},
  ): Promise<FsListResult> {
    validatePath(path);
    return this.request<FsListResult>("POST", "/api/fs/list", {
      path,
      password: opts.password ?? "",
      page: opts.page ?? 1,
      per_page: opts.perPage ?? 100,
      refresh: opts.refresh ?? false,
    });
  }

  /** 文件详情（POST /api/fs/get）：raw_url、related、签名、大小 */
  async getFile(path: string, opts: { password?: string; userAgent?: string } = {}): Promise<FsGetResult> {
    validatePath(path);
    return this.request<FsGetResult>("POST", "/api/fs/get", {
      path,
      password: opts.password ?? "",
      // 关键：部分存储按 user_agent 生成 raw_url，客户端 UA 应与播放端一致
      user_agent: opts.userAgent ?? "SyncFrame-PoC/0.1",
    });
  }

  /** 搜索（POST /api/fs/search；实例未开启索引时服务端会报错） */
  async search(
    keywords: string,
    opts: { parent?: string; scope?: 0 | 1; page?: number; perPage?: number; password?: string } = {},
  ): Promise<FsSearchResult> {
    const parent = opts.parent ?? "/";
    validatePath(parent);
    return this.request<FsSearchResult>("POST", "/api/fs/search", {
      parent,
      keywords,
      scope: opts.scope ?? 0,
      page: opts.page ?? 1,
      per_page: opts.perPage ?? 50,
      password: opts.password ?? "",
    });
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Origin: this.baseUrl,
      Referer: `${this.baseUrl}/`,
    };
    if (this.token) headers["Authorization"] = this.token;
    return headers;
  }

  /** 带重试、超时与鉴权的请求 */
  private async request<T>(
    method: "GET" | "POST",
    endpoint: string,
    body?: unknown,
    requireAuth = true,
  ): Promise<T> {
    if (requireAuth && !this.token) {
      throw new OpenListAdapterError({ kind: "config", message: "未登录且未提供 token，无法访问受保护接口" });
    }

    let lastErr: unknown = null;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      if (attempt > 0) await sleep(300 * 2 ** (attempt - 1));
      try {
        return await this.requestOnce<T>(method, endpoint, body);
      } catch (err) {
        lastErr = err;
        if (err instanceof OpenListAdapterError) {
          // 仅网络错误、超时、429 与 5xx 值得重试；4xx 业务错误直接失败
          const retryable =
            err.kind === "network" ||
            (err.kind === "http" && err.httpStatus !== undefined && RETRYABLE_STATUSES.has(err.httpStatus));
          if (!retryable) throw err;
        } else {
          throw err;
        }
      }
    }
    throw normalizeError(lastErr);
  }

  private async requestOnce<T>(method: "GET" | "POST", endpoint: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}${endpoint}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(url, {
        method,
        headers: this.buildHeaders(),
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
        redirect: "follow",
      });

      // 响应体大小限制
      const len = Number(res.headers.get("content-length"));
      if (Number.isFinite(len) && len > MAX_JSON_BYTES) {
        throw new OpenListAdapterError({
          kind: "http",
          message: `响应体过大: ${len} B`,
          httpStatus: res.status,
        });
      }

      let text = "";
      if (res.body) {
        const reader = res.body.getReader();
        const chunks: Uint8Array[] = [];
        let total = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.length;
          if (total > MAX_JSON_BYTES) {
            await reader.cancel().catch(() => {});
            throw new OpenListAdapterError({ kind: "http", message: `响应体超过 ${MAX_JSON_BYTES} B`, httpStatus: res.status });
          }
          chunks.push(value);
        }
        text = new TextDecoder().decode(Buffer.concat(chunks));
      }

      let envelope: OpenListEnvelope<T>;
      try {
        envelope = JSON.parse(text) as OpenListEnvelope<T>;
      } catch {
        throw new OpenListAdapterError({
          kind: "http",
          message: `响应不是 JSON（HTTP ${res.status}）`,
          httpStatus: res.status,
          rawBody: text,
        });
      }

      if (!res.ok) {
        throw new OpenListAdapterError({
          kind: "http",
          message: `HTTP ${res.status}: ${envelope.message ?? res.statusText}`,
          httpStatus: res.status,
          rawBody: text,
        });
      }
      if (envelope.code !== 200) {
        throw new OpenListAdapterError({
          kind: "api",
          message: `OpenList 错误 ${envelope.code}: ${envelope.message}`,
          apiCode: envelope.code,
          rawBody: text,
        });
      }
      if (envelope.data == null) {
        throw new OpenListAdapterError({ kind: "api", message: `响应缺少 data 字段（${endpoint}）`, apiCode: envelope.code });
      }
      return envelope.data;
    } catch (err) {
      throw normalizeError(err);
    } finally {
      clearTimeout(timer);
    }
  }
}
