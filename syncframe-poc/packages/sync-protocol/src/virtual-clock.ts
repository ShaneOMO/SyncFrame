/**
 * 虚拟媒体时钟：模拟一个「完美跟随命令」的播放器。
 *
 * 用途：
 * - Node 仿真测试：在没有真实视频/浏览器的情况下，验证整条同步链路
 *   （时钟偏移、状态应用、漂移纠正）的收敛行为。
 * - room.html 的 clock 模式：无 OpenList 环境时演示 1 房主 + 多观众同步。
 *
 * 语义对齐真实播放器契约：seek 有延迟、play/pause/rate 立即生效、
 * currentTime 只随墙钟前进（paused 时不动）。
 */

export interface VirtualClockOptions {
  /** seek 耗时（毫秒），模拟真实播放器 seek 到可播放的延迟。 */
  seekLatencyMs?: number;
  now?: () => number;
}

export class VirtualMediaClock {
  private positionMs = 0;
  private rate = 1;
  private paused = true;
  private updatedAt: number;
  private seekTarget: number | null = null;
  private seekReadyAt = 0;
  /** seek 发起时刻：结算时补记 seek 期间墙钟推进（播放器冻结但房间时钟在走）。 */
  private seekStartAt = 0;
  private readonly seekLatencyMs: number;
  private readonly now: () => number;

  constructor(opts: VirtualClockOptions = {}) {
    this.seekLatencyMs = opts.seekLatencyMs ?? 0;
    this.now = opts.now ?? Date.now;
    this.updatedAt = this.now();
  }

  getCurrentTimeMs(): number {
    const t = this.now();
    // seek 进行中：在 seek 完成前保持原位，完成后落到目标并补记 seek 期间的墙钟推进。
    if (this.seekTarget !== null) {
      if (t >= this.seekReadyAt) {
        const jumped = this.seekTarget;
        const credit = this.paused ? 0 : (t - this.seekStartAt) * this.rate;
        this.seekTarget = null;
        this.positionMs = jumped + credit;
        this.updatedAt = t;
      } else {
        return this.positionMs;
      }
    }
    if (this.paused) return this.positionMs;
    const delta = (t - this.updatedAt) * this.rate;
    this.positionMs += delta;
    this.updatedAt = t;
    return this.positionMs;
  }

  isPaused(): boolean {
    return this.paused;
  }

  getRate(): number {
    return this.rate;
  }

  isSeeking(): boolean {
    return this.seekTarget !== null;
  }

  play(): void {
    this.getCurrentTimeMs(); // 结算挂起 seek
    this.paused = false;
    this.updatedAt = this.now();
  }

  pause(): void {
    this.getCurrentTimeMs();
    this.paused = true;
    this.updatedAt = this.now();
  }

  seek(targetMs: number): void {
    const t = this.now();
    // 发起 seek 前先结算当前进度，避免叠 seek 时丢失位置。
    this.getCurrentTimeMs();
    if (this.seekLatencyMs <= 0) {
      this.positionMs = Math.max(0, targetMs);
      this.updatedAt = t;
      return;
    }
    this.seekTarget = Math.max(0, targetMs);
    this.seekStartAt = t;
    this.seekReadyAt = t + this.seekLatencyMs;
  }

  setRate(rate: number): void {
    this.getCurrentTimeMs();
    this.rate = rate;
    this.updatedAt = this.now();
  }

  /** 测试钩子：直接设置当前位置（模拟房主播放到某处）。 */
  setPosition(ms: number): void {
    this.positionMs = ms;
    this.updatedAt = this.now();
  }
}
