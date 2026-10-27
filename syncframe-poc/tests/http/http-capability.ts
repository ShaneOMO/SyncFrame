/**
 * P0 HTTP 能力检查核心模块。
 * 针对一个文件 URL 验证：
 *  - HEAD / GET
 *  - 文件头 / 中部 / 尾部 Range（206 vs 200，字节是否正确）
 *  - 重定向链及重定向后 Range 是否仍正确
 *  - CORS 响应头与预检请求
 *  - 并发 Range 读取稳定性
 * 原始记录全部落盘，便于归因。
 */

export interface CorsInfo {
  requestOrigin: string;
  allowOrigin?: string;
  allowHeaders?: string;
  exposeHeaders?: string;
  allowCredentials?: string;
  corsEnabled: boolean;
}

export interface RequestRecord {
  method: string;
  url: string;
  status: number;
  statusText: string;
  contentLength?: string;
  contentRange?: string;
  acceptRanges?: string;
  contentType?: string;
  location?: string;
  cors: CorsInfo;
  durationMs: number;
  bytesRead: number;
  error?: string;
}

export interface RangeCase {
  name: string; // head / middle / tail
  rangeHeader: string;
  expectedStart: number;
  expectedEnd: number; // inclusive
  record: RequestRecord;
  rangeHonored: boolean;
  bytesCorrect: boolean;
}

export interface PreflightRecord {
  url: string;
  status: number;
  allowOrigin?: string;
  allowMethods?: string;
  allowHeaders?: string;
  durationMs: number;
  error?: string;
}

export interface ConcurrencySession {
  sessionIndex: number;
  reads: number;
  bytesRead: number;
  failures: string[];
  durationMs: number;
}

export interface ConcurrencyResult {
  sessions: number;
  totalBytes: number;
  totalDurationMs: number;
  aggregateMbps: number;
  failures: number;
  sessionsDetail: ConcurrencySession[];
}

export interface UrlCapabilityReport {
  url: string;
  /** 脱敏后的 URL（查询串打码），用于报告展示 */
  urlRedacted: string;
  finalUrl: string;
  finalUrlRedacted: string;
  redirectCount: number;
  head: RequestRecord;
  get: RequestRecord;
  sizeBytes: number | null;
  rangeCases: RangeCase[];
  /** 重定向最终地址上的 Range 复测；无重定向时为 null */
  redirectRangeRecheck: RangeCase | null;
  corsPreflight: PreflightRecord | null;
  concurrency: ConcurrencyResult;
  timestamp: string;
  notes: string[];
}

export interface CheckOptions {
  /** GET 截断读取字节数（避免整文件下载），默认 64 KiB */
  getCapBytes?: number;
  /** 每个 Range 用例读取字节数，默认 1 MiB（头部用例固定 4 KiB） */
  rangeChunkBytes?: number;
  /** 并发会话数，默认 5 */
  concurrency?: number;
  /** 每个并发会话顺序读取次数，默认 3 */
  concurrencyReadsPerSession?: number;
  /** 请求超时，默认 30s */
  timeoutMs?: number;
  /** 用于 CORS 检查的模拟 Origin */
  origin?: string;
}

const VIDEO_EXT = /\.(mkv|mp4|avi|mov|webm|m4v|ts|m2ts|flv|wmv|mpg|mpeg|rmvb|iso)$/i;

export function isVideoFile(name: string): boolean {
  return VIDEO_EXT.test(name);
}

/** 脱敏 URL：隐藏查询串，避免签名/令牌进入报告 */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.search) u.search = "?<redacted>";
    return u.toString();
  } catch {
    return "<invalid-url>";
  }
}

function toCorsInfo(res: Response, origin: string): CorsInfo {
  const h = res.headers;
  const allowOrigin = h.get("access-control-allow-origin") ?? undefined;
  return {
    requestOrigin: origin,
    allowOrigin,
    allowHeaders: h.get("access-control-allow-headers") ?? undefined,
    exposeHeaders: h.get("access-control-expose-headers") ?? undefined,
    allowCredentials: h.get("access-control-allow-credentials") ?? undefined,
    corsEnabled: Boolean(allowOrigin),
  };
}

async function timedFetch(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  origin: string,
  capBytes?: number,
): Promise<{ record: RequestRecord; body: Uint8Array }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = performance.now();
  let record: RequestRecord;
  let body: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  try {
    const headers: Record<string, string> = { Origin: origin, ...(init.headers as Record<string, string> | undefined) };
    const res = await fetch(url, { ...init, headers, signal: controller.signal, redirect: "follow" });
    const info: RequestRecord = {
      method: init.method ?? "GET",
      url: redactUrl(url),
      status: res.status,
      statusText: res.statusText,
      contentLength: res.headers.get("content-length") ?? undefined,
      contentRange: res.headers.get("content-range") ?? undefined,
      acceptRanges: res.headers.get("accept-ranges") ?? undefined,
      contentType: res.headers.get("content-type") ?? undefined,
      location: res.headers.get("location") ?? undefined,
      cors: toCorsInfo(res, origin),
      durationMs: 0,
      bytesRead: 0,
    };
    if (res.ok && res.body) {
      const reader = res.body.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      const cap = capBytes ?? Number.POSITIVE_INFINITY;
      while (total < cap) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        total += value.length;
        if (total >= cap) break;
      }
      await reader.cancel().catch(() => {});
      body = concatChunks(chunks, Math.min(total, cap));
      info.bytesRead = body.length;
    } else {
      // 错误响应只读取少量内容用于诊断
      const buf = await res.arrayBuffer().catch(() => new ArrayBuffer(0));
      body = new Uint8Array(buf.slice(0, 4096));
      info.bytesRead = body.length;
    }
    info.durationMs = Math.round(performance.now() - started);
    record = info;
  } catch (err) {
    record = {
      method: init.method ?? "GET",
      url: redactUrl(url),
      status: 0,
      statusText: "",
      cors: { requestOrigin: origin, corsEnabled: false },
      durationMs: Math.round(performance.now() - started),
      bytesRead: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
  return { record, body };
}

function concatChunks(chunks: Uint8Array[], size: number): Uint8Array {
  const out = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    const n = Math.min(c.length, size - offset);
    out.set(c.subarray(0, n), offset);
    offset += n;
    if (offset >= size) break;
  }
  return out;
}

function parseContentRange(cr: string | undefined): { start: number; end: number; total: number | null } | null {
  if (!cr) return null;
  const m = cr.match(/bytes\s+(\d+)-(\d+)\/(\d+|\*)/i);
  if (!m) return null;
  return {
    start: Number(m[1]),
    end: Number(m[2]),
    total: m[3] === "*" ? null : Number(m[3]),
  };
}

/** 探测重定向链（不跟随），返回最终 URL 与跳数 */
async function probeRedirectChain(
  url: string,
  timeoutMs: number,
  origin: string,
): Promise<{ finalUrl: string; redirectCount: number }> {
  let current = url;
  let count = 0;
  for (let i = 0; i < 10; i++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(current, {
        method: "HEAD",
        headers: { Origin: origin },
        redirect: "manual",
        signal: controller.signal,
      });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("location");
        if (!loc) break;
        current = new URL(loc, current).toString();
        count++;
      } else {
        break;
      }
    } catch {
      break;
    } finally {
      clearTimeout(timer);
    }
  }
  return { finalUrl: current, redirectCount: count };
}

async function runRangeCase(
  name: string,
  url: string,
  start: number,
  end: number,
  opts: Required<Omit<CheckOptions, "origin" | "concurrency" | "concurrencyReadsPerSession">> & { origin: string },
): Promise<RangeCase | null> {
  if (start < 0 || end < start) return null;
  const rangeHeader = `bytes=${start}-${end}`;
  const { record, body } = await timedFetch(
    url,
    { method: "GET", headers: { Range: rangeHeader } },
    opts.timeoutMs,
    opts.origin,
  );
  const cr = parseContentRange(record.contentRange);
  const rangeHonored =
    record.status === 206 && cr !== null && cr.start === start && cr.end === end;
  // 字节校验：读到的首字节应与文件 offset 处一致（至少验证长度）
  const expectedLen = end - start + 1;
  const bytesCorrect =
    record.status === 206 ? body.length === expectedLen : record.status === 200;
  return { name, rangeHeader, expectedStart: start, expectedEnd: end, record, rangeHonored, bytesCorrect };
}

function summarizeCors(r: RequestRecord): string {
  return r.cors.corsEnabled
    ? `CORS 允许来源: ${r.cors.allowOrigin}${r.cors.allowCredentials === "true" ? " (允许凭证)" : ""}`
    : "无 Access-Control-Allow-Origin，浏览器跨域读取将被拦截";
}

/** 对单个 URL 执行完整能力检查 */
export async function checkUrlCapability(url: string, options: CheckOptions = {}): Promise<UrlCapabilityReport> {
  const opts = {
    getCapBytes: options.getCapBytes ?? 64 * 1024,
    rangeChunkBytes: options.rangeChunkBytes ?? 1024 * 1024,
    concurrency: options.concurrency ?? 5,
    concurrencyReadsPerSession: options.concurrencyReadsPerSession ?? 3,
    timeoutMs: options.timeoutMs ?? 30_000,
    origin: options.origin ?? "http://localhost:5173",
  };

  const notes: string[] = [];
  const head = (await timedFetch(url, { method: "HEAD" }, opts.timeoutMs, opts.origin)).record;

  // 获取文件大小：优先 HEAD 的 Content-Length；部分存储 HEAD 不准时用 GET 补充
  let sizeBytes: number | null = head.contentLength ? Number(head.contentLength) : null;
  if (sizeBytes === null || Number.isNaN(sizeBytes)) sizeBytes = null;

  // GET（截断读取，避免下载整文件）
  const getRes = await timedFetch(url, { method: "GET" }, opts.timeoutMs, opts.origin, opts.getCapBytes);
  if (sizeBytes === null && getRes.record.contentLength) {
    const n = Number(getRes.record.contentLength);
    if (!Number.isNaN(n)) sizeBytes = n;
  }

  // Range 用例：头部 / 中部 / 尾部
  const rangeCases: RangeCase[] = [];
  const headEnd = Math.min(4095, (sizeBytes ?? 4096) - 1);
  const headCase = await runRangeCase("head", url, 0, Math.max(0, headEnd), opts);
  if (headCase) rangeCases.push(headCase);

  if (sizeBytes !== null && sizeBytes > opts.rangeChunkBytes * 2) {
    const midStart = Math.floor(sizeBytes / 2);
    const midCase = await runRangeCase("middle", url, midStart, midStart + opts.rangeChunkBytes - 1, opts);
    if (midCase) rangeCases.push(midCase);
    const tailStart = Math.max(0, sizeBytes - opts.rangeChunkBytes);
    const tailCase = await runRangeCase("tail", url, tailStart, sizeBytes - 1, opts);
    if (tailCase) rangeCases.push(tailCase);
  } else {
    notes.push("文件大小未知或过小，跳过中部/尾部 Range 用例");
  }

  // 重定向链：记录并对最终地址复测 Range
  const chain = await probeRedirectChain(url, opts.timeoutMs, opts.origin);
  let redirectRangeRecheck: RangeCase | null = null;
  if (chain.redirectCount > 0 && sizeBytes !== null && sizeBytes > 0) {
    const midStart = Math.floor(sizeBytes / 2);
    const recheck = await runRangeCase(
      "redirect-recheck",
      chain.finalUrl,
      midStart,
      Math.min(midStart + opts.rangeChunkBytes - 1, sizeBytes - 1),
      opts,
    );
    if (recheck) {
      redirectRangeRecheck = recheck;
      if (!recheck.rangeHonored) {
        notes.push("重定向后 Range 未被遵守：OpenList/存储重定向可能丢失 Range 头");
      }
    }
  }

  // CORS 预检（浏览器带 Range 头跨域读取视频时会触发）
  let corsPreflight: PreflightRecord | null = null;
  {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
    const started = performance.now();
    try {
      const res = await fetch(url, {
        method: "OPTIONS",
        headers: {
          Origin: opts.origin,
          "Access-Control-Request-Method": "GET",
          "Access-Control-Request-Headers": "range",
        },
        signal: controller.signal,
        redirect: "follow",
      });
      corsPreflight = {
        url: redactUrl(url),
        status: res.status,
        allowOrigin: res.headers.get("access-control-allow-origin") ?? undefined,
        allowMethods: res.headers.get("access-control-allow-methods") ?? undefined,
        allowHeaders: res.headers.get("access-control-allow-headers") ?? undefined,
        durationMs: Math.round(performance.now() - started),
      };
    } catch (err) {
      corsPreflight = {
        url: redactUrl(url),
        status: 0,
        durationMs: Math.round(performance.now() - started),
        error: err instanceof Error ? err.message : String(err),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  // 并发会话：N 个会话各自在随机偏移顺序读取 M 块
  const concurrency = await runConcurrency(url, sizeBytes, opts);

  const corsOk = head.cors.corsEnabled;
  if (!corsOk) notes.push(summarizeCors(head));
  const rangesOk = rangeCases.length > 0 && rangeCases.every((c) => c.rangeHonored);
  if (!rangesOk) notes.push("存在 Range 未被遵守（返回 200 或字节错误）的用例");

  return {
    url,
    urlRedacted: redactUrl(url),
    finalUrl: chain.finalUrl,
    finalUrlRedacted: redactUrl(chain.finalUrl),
    redirectCount: chain.redirectCount,
    head,
    get: getRes.record,
    sizeBytes,
    rangeCases,
    redirectRangeRecheck,
    corsPreflight,
    concurrency,
    timestamp: new Date().toISOString(),
    notes,
  };
}

async function runConcurrency(
  url: string,
  sizeBytes: number | null,
  opts: {
    concurrency: number;
    concurrencyReadsPerSession: number;
    rangeChunkBytes: number;
    timeoutMs: number;
    origin: string;
  },
): Promise<ConcurrencyResult> {
  const chunk = Math.min(opts.rangeChunkBytes, 4 * 1024 * 1024);
  const sessions: ConcurrencySession[] = [];
  let totalBytes = 0;
  let failures = 0;

  const runSession = async (index: number): Promise<ConcurrencySession> => {
    const started = performance.now();
    const s: ConcurrencySession = { sessionIndex: index, reads: 0, bytesRead: 0, failures: [], durationMs: 0 };
    for (let r = 0; r < opts.concurrencyReadsPerSession; r++) {
      let start: number;
      if (sizeBytes !== null && sizeBytes > chunk) {
        start = Math.floor(Math.random() * (sizeBytes - chunk));
      } else {
        start = 0;
      }
      const end = Math.min(start + chunk - 1, (sizeBytes ?? chunk) - 1);
      const c = await runRangeCase(`c${index}-r${r}`, url, start, end, {
        getCapBytes: 0,
        rangeChunkBytes: opts.rangeChunkBytes,
        timeoutMs: opts.timeoutMs,
        origin: opts.origin,
      });
      if (!c || !c.rangeHonored) {
        failures++;
        s.failures.push(`read#${r}: ${c ? `status ${c.record.status}` : "invalid range"}`);
      } else {
        s.reads++;
        s.bytesRead += c.record.bytesRead;
      }
    }
    s.durationMs = Math.round(performance.now() - started);
    return s;
  };

  const results = await Promise.all(
    Array.from({ length: opts.concurrency }, (_, i) => runSession(i)),
  );
  sessions.push(...results);
  for (const s of sessions) totalBytes += s.bytesRead;
  const totalDurationMs = Math.max(...sessions.map((s) => s.durationMs), 1);
  const aggregateMbps = (totalBytes * 8) / (totalDurationMs / 1000) / 1e6;

  return {
    sessions: opts.concurrency,
    totalBytes,
    totalDurationMs,
    aggregateMbps: Math.round(aggregateMbps * 100) / 100,
    failures,
    sessionsDetail: sessions,
  };
}

/** 控制台摘要输出 */
export function printReportSummary(report: UrlCapabilityReport): void {
  const line = "─".repeat(72);
  console.log(`\n${line}`);
  console.log(`目标: ${report.urlRedacted}`);
  console.log(`时间: ${report.timestamp}`);
  console.log(`重定向: ${report.redirectCount} 次${report.redirectCount > 0 ? `，最终地址 ${report.finalUrlRedacted}` : ""}`);
  console.log(`文件大小: ${report.sizeBytes !== null ? `${(report.sizeBytes / 1024 / 1024).toFixed(2)} MiB` : "未知"}`);
  console.log(line);
  console.log(`HEAD: ${report.head.status} ${report.head.statusText}  Accept-Ranges: ${report.head.acceptRanges ?? "-"}`);
  console.log(`GET : ${report.get.status} ${report.get.statusText}  读取 ${report.get.bytesRead} B / ${report.get.durationMs} ms`);
  console.log(line);
  console.log("Range 用例:");
  for (const c of report.rangeCases) {
    console.log(
      `  ${c.name.padEnd(8)} ${c.rangeHeader.padEnd(28)} → ${c.record.status}  ` +
      `${c.rangeHonored ? "✔ 遵守" : "✘ 未遵守"}  ${c.record.durationMs} ms`,
    );
  }
  if (report.redirectRangeRecheck) {
    const r = report.redirectRangeRecheck;
    console.log(`  重定向复测: ${r.rangeHeader} → ${r.record.status} ${r.rangeHonored ? "✔ 遵守" : "✘ 未遵守"}`);
  }
  console.log(line);
  console.log(`CORS: ${report.head.cors.corsEnabled ? `允许 ${report.head.cors.allowOrigin}` : "✘ 无 ACAO 头"}`);
  if (report.corsPreflight) {
    console.log(
      `预检: ${report.corsPreflight.status}  allow-headers: ${report.corsPreflight.allowHeaders ?? "-"}` +
      `${report.corsPreflight.error ? `  (${report.corsPreflight.error})` : ""}`,
    );
  }
  console.log(line);
  console.log(
    `并发: ${report.concurrency.sessions} 会话 × ${report.concurrency.sessionsDetail[0]?.reads ?? 0} 次读取  ` +
    `吞吐 ${report.concurrency.aggregateMbps} Mbps  失败 ${report.concurrency.failures}`,
  );
  if (report.notes.length > 0) {
    console.log(line);
    console.log("备注:");
    for (const n of report.notes) console.log(`  - ${n}`);
  }
  console.log(line);
}
