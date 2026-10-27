/**
 * OpenList 错误标准化。
 * 所有适配器错误统一为 OpenListAdapterError，便于上层区分：
 * - 网络/超时问题
 * - OpenList API 业务错误（code != 200）
 * - HTTP 层错误（401/403/404/5xx）
 */

export type AdapterErrorKind =
  | "network" // 连接失败、DNS、超时
  | "http" // 非 2xx HTTP 状态
  | "api" // OpenList 返回 code != 200
  | "config"; // 配置缺失或非法

export class OpenListAdapterError extends Error {
  readonly kind: AdapterErrorKind;
  /** OpenList 业务错误码（仅 kind === "api" 时存在） */
  readonly apiCode?: number;
  /** HTTP 状态码（仅 kind === "http" 时存在） */
  readonly httpStatus?: number;
  /** 原始响应体（截断到 512 字符，避免日志泄露签名等敏感信息） */
  readonly rawBody?: string;

  constructor(init: {
    kind: AdapterErrorKind;
    message: string;
    apiCode?: number;
    httpStatus?: number;
    rawBody?: string;
  }) {
    super(init.message);
    this.name = "OpenListAdapterError";
    this.kind = init.kind;
    this.apiCode = init.apiCode;
    this.httpStatus = init.httpStatus;
    this.rawBody = init.rawBody?.slice(0, 512);
  }

  toJSON() {
    return {
      name: this.name,
      kind: this.kind,
      message: this.message,
      apiCode: this.apiCode,
      httpStatus: this.httpStatus,
    };
  }
}

/** 从 unknown 异常提取标准化错误，绝不抛出非 AdapterError 的异常 */
export function normalizeError(err: unknown): OpenListAdapterError {
  if (err instanceof OpenListAdapterError) return err;
  if (err instanceof Error) {
    const msg = err.message ?? "unknown error";
    // Node fetch 网络错误（fetch failed / TimeoutError 等）
    if (
      msg.includes("fetch failed") ||
      msg.includes("timeout") ||
      err.name === "TimeoutError" ||
      err.name === "AbortError"
    ) {
      return new OpenListAdapterError({ kind: "network", message: msg });
    }
    return new OpenListAdapterError({ kind: "network", message: msg });
  }
  return new OpenListAdapterError({
    kind: "network",
    message: String(err),
  });
}
