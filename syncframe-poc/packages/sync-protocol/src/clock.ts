/**
 * 客户端时钟偏移估算。
 *
 * 思路与 Movi Watch Party 一致（审计结论）：服务端时钟为准，客户端用
 * ping/pong 测偏移，取 RTT 最小的样本（单程假设误差最小）。
 * Spike 在其上补两点：
 * - 保留最近 N 个样本，偏移取「最优 RTT 样本」与「近期中位数」的融合，
 *   避免个别极小包造成跳变；变化率受 maxStepMs 限制。
 * - 完全注入 now() 与时间源，可在 Node 仿真里用虚拟时钟确定性回放。
 */

export interface ClockSample {
  /** 客户端发送时刻。 */
  t0: number;
  /** 服务端接收/回包时刻（服务端时钟）。 */
  t1: number;
  /** 客户端接收时刻。 */
  t2: number;
  rtt: number;
}

export interface ClockEstimate {
  /** offset 使 serverNow ≈ now() + offset。 */
  offsetMs: number;
  bestRttMs: number;
  sampleCount: number;
  /** 上次更新距现在多久（用于判断估算是否可信）。 */
  ageMs: number;
}

export interface ClockSyncOptions {
  /** 保留的样本窗口。 */
  windowSize?: number;
  /** 单次偏移修正上限，防止坏样本跳变。 */
  maxStepMs?: number;
  /** 超过该 RTT 的样本直接丢弃（噪声无意义）。 */
  maxRttMs?: number;
  now?: () => number;
}

export class ClockSync {
  private samples: ClockSample[] = [];
  private offset = 0;
  private bestRtt = Infinity;
  private updatedAt: number;
  private readonly windowSize: number;
  private readonly maxStepMs: number;
  private readonly maxRttMs: number;
  private readonly now: () => number;

  constructor(opts: ClockSyncOptions = {}) {
    this.windowSize = opts.windowSize ?? 8;
    this.maxStepMs = opts.maxStepMs ?? 250;
    this.maxRttMs = opts.maxRttMs ?? 2000;
    this.now = opts.now ?? Date.now;
    this.updatedAt = this.now();
  }

  /**
   * 记录一次 ping/pong 往返。
   * 返回该样本估算的偏移；样本过差时返回 null。
   */
  addSample(t0: number, t1: number, t2: number): number | null {
    const rtt = t2 - t0;
    if (rtt < 0 || rtt > this.maxRttMs) return null;
    // NTP 单程对称假设：offset = t1 - (t0 + t2) / 2
    const sampleOffset = t1 - (t0 + t2) / 2;
    const sample: ClockSample = { t0, t1, t2, rtt };
    this.samples.push(sample);
    if (this.samples.length > this.windowSize) this.samples.shift();

    this.bestRtt = Math.min(this.bestRtt, rtt);
    // 用窗口内 RTT 最小的样本做主估计；中位数做 sanity 对照。
    const best = this.samples.reduce((a, b) => (a.rtt <= b.rtt ? a : b));
    let next = best.t1 - (best.t0 + best.t2) / 2;
    const sorted = [...this.samples].sort((a, b) => a.rtt - b.rtt);
    const median = sorted[Math.floor(sorted.length / 2)];
    const medianOffset = median.t1 - (median.t0 + median.t2) / 2;
    // 最优样本与 median 差太多说明网络不对称剧烈，本次不采纳跳变。
    if (Math.abs(next - medianOffset) > this.maxStepMs) {
      next = this.offset + Math.sign(next - this.offset) * this.maxStepMs;
    }
    const delta = Math.abs(next - this.offset);
    if (delta <= this.maxStepMs || this.samples.length === 1) {
      this.offset = next;
      this.updatedAt = this.now();
    }
    return sampleOffset;
  }

  estimate(): ClockEstimate {
    return {
      offsetMs: this.offset,
      bestRttMs: Number.isFinite(this.bestRtt) ? this.bestRtt : -1,
      sampleCount: this.samples.length,
      ageMs: this.now() - this.updatedAt,
    };
  }

  /** 当前服务端时刻估计。 */
  serverNow(): number {
    return this.now() + this.offset;
  }

  /** 把服务端时刻换算成本地时刻。 */
  fromServerTime(serverMs: number): number {
    return serverMs - this.offset;
  }

  reset(): void {
    this.samples = [];
    this.offset = 0;
    this.bestRtt = Infinity;
    this.updatedAt = this.now();
  }
}
