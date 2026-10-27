/**
 * 带网络计数的 SourceAdapter：替代 movi-player 内置 HttpSource，
 * 精确统计 Range 请求数、读取字节量与失败次数（计划 §7.1 采集字段）。
 * 非 206 响应直接抛错——服务器忽略 Range 是必须暴露的失败模式。
 */

export interface RequestLogEntry {
  offset: number;
  length: number;
  status: number;
  bytes: number;
  durationMs: number;
  at: number;
}

const MAX_LOG = 500;

export class CountingHttpSource {
  readonly url: string;
  requestCount = 0;
  bytesRead = 0;
  failures = 0;
  readonly requestLog: RequestLogEntry[] = [];
  private size: number | null = null;

  constructor(url: string, knownSize: number | null = null) {
    this.url = url;
    this.size = knownSize;
  }

  getKey(): string {
    return this.url;
  }

  /**
   * 获取文件大小，多级回退：
   * 1. 服务端已提供（resolve 返回 size）→ 直接用
   * 2. HEAD 的 Content-Length
   * 3. GET Range bytes=0-0 的 Content-Range
   * 4. GET Range bytes=0-4095 的 Content-Range
   * （实测光雅盘 CDN：HEAD 不返回 Content-Length，且对 bytes=0-0 返回 200 无 Content-Range）
   */
  async getSize(): Promise<number> {
    if (this.size !== null) return this.size;

    // 2) HEAD
    try {
      const res = await fetch(this.url, { method: "HEAD" });
      if (res.ok) {
        const len = Number(res.headers.get("content-length"));
        if (Number.isFinite(len) && len > 0) {
          this.size = len;
          return len;
        }
      }
    } catch {
      // 继续回退
    }

    // 3) / 4) 小 Range GET，从 Content-Range 解析总量
    for (const range of ["bytes=0-0", "bytes=0-4095"]) {
      try {
        const res = await fetch(this.url, { headers: { Range: range } });
        res.body?.cancel().catch(() => {});
        if (res.status === 206) {
          const cr = res.headers.get("content-range");
          const m = cr?.match(/\/(\d+)\s*$/);
          if (m) {
            this.size = Number(m[1]);
            return this.size;
          }
        }
      } catch {
        // 继续下一个回退
      }
    }
    throw new Error("无法确定文件大小（HEAD 无 Content-Length，Range 探测失败）");
  }

  async read(offset: number, length: number): Promise<ArrayBuffer> {
    const started = performance.now();
    const end = offset + length - 1;
    let res: Response;
    try {
      res = await fetch(this.url, { headers: { Range: `bytes=${offset}-${end}` } });
    } catch (err) {
      this.failures++;
      throw err;
    }
    this.requestCount++;
    if (res.status !== 206) {
      this.failures++;
      res.body?.cancel().catch(() => {});
      throw new Error(`Range 请求未返回 206: HTTP ${res.status}（服务器可能忽略 Range）`);
    }
    const buf = await res.arrayBuffer();
    this.bytesRead += buf.byteLength;
    this.requestLog.push({
      offset,
      length,
      status: res.status,
      bytes: buf.byteLength,
      durationMs: Math.round(performance.now() - started),
      at: Date.now(),
    });
    if (this.requestLog.length > MAX_LOG) this.requestLog.splice(0, this.requestLog.length - MAX_LOG);
    return buf;
  }

  // SourceAdapter 契约要求的其余方法（对只读随机访问源为安全空实现）
  seek(o: number): number {
    return o;
  }
  getPosition(): number {
    return 0;
  }
  close(): void {
    // fetch 无需显式清理
  }
}
