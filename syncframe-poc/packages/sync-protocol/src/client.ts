/**
 * SyncClient：同步客户端核心（浏览器房间页与 Node 仿真测试共用）。
 *
 * 职责：
 * - WebSocket 连接 / 指数退避重连（S06/S07）；
 * - 周期 ping/pong 估算服务端时钟偏移；
 * - 房主：命令发送 + 周期心跳（5–10s），本地媒体为权威；
 * - 观众：状态应用（revision/mediaRevision 丢弃乱序 S14）、
 *   目标位置推算、超阈值硬漂移纠正、自动播放被拦时上报手势需求（S08）。
 *
 * 回放回声防护：观众从不主动上报状态（只有房主说话），
 * 服务端不回显发送者——因此不存在「自己的 seek 被当命令广播」的回环（S01 注释的原型教训）。
 */

import { ClockSync } from "./clock.ts";
import { computeTarget, isImmediateAction, isNewerState, planCorrection } from "./follower.ts";
import type { MediaMeta, Role, RoomState, Roster, ServerMessage } from "./types.ts";

/** 媒体适配器：真实播放器（MoviElement）与 VirtualMediaClock 都实现它。 */
export interface MediaAdapter {
  getTimeMs(): number;
  isPaused(): boolean;
  getRate(): number;
  play(): void | Promise<void>;
  pause(): void;
  seek(targetMs: number): void;
  setRate(rate: number): void;
  /** 切换视频（load 命令）。clock 模式可为空实现。 */
  load?(mediaId: string, meta: MediaMeta | null): Promise<void> | void;
  /** 当前是否已加载媒体（心跳/命令前检查）。 */
  hasMedia?(): boolean;
}

export interface TimerShim {
  setInterval: (fn: () => void, ms: number) => unknown;
  clearInterval: (handle: unknown) => void;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}

const defaultTimers: TimerShim = {
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => clearInterval(h as Parameters<typeof clearInterval>[0]),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as Parameters<typeof clearTimeout>[0]),
};

export interface SyncClientOptions {
  /** ws:// 或 wss:// 完整地址（含 room/name/role/clientId 查询参数）。 */
  wsUrl: string;
  role: Role;
  media: MediaAdapter;
  hardDriftMs?: number;
  /** 房主心跳周期（毫秒）。 */
  heartbeatMs?: number;
  /** 观众漂移检查周期（毫秒）。 */
  driftCheckMs?: number;
  /** 时钟 ping 周期（毫秒）。Spike 取 2s 以获得密集样本。 */
  pingIntervalMs?: number;
  now?: () => number;
  timers?: TimerShim;
  /** 注入 WebSocket 实现（Node 仿真传 ws 包，浏览器用全局）。 */
  WebSocketImpl?: unknown;
  onStatus?: (line: string) => void;
  onRoster?: (msg: Roster) => void;
  onGestureNeeded?: () => void;
  onStateApplied?: (state: RoomState) => void;
  /** 底层 socket 打开后回调（测试注入/诊断用）。 */
  onSocket?: (ws: unknown) => void;
}

export interface SyncClientStats {
  role: Role;
  connected: boolean;
  clockOffsetMs: number;
  bestRttMs: number;
  revision: number;
  mediaRevision: number;
  appliedMediaId: string;
  expectedTargetMs: number | null;
  clientTimeMs: number;
  driftMs: number | null;
  corrections: number;
  alignments: number;
  reconnects: number;
  droppedStates: number;
  samples: number;
}

interface WSLike {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: string, listener: (ev: unknown) => void): void;
}

export class SyncClient {
  private readonly opts: SyncClientOptions;
  private readonly clock: ClockSync;
  private readonly timers: TimerShim;
  private ws: WSLike | null = null;
  private closedByUs = false;
  private reconnectAt = 1000;
  private reconnects = 0;
  private reconnectTimer: unknown = null;
  private pingTimer: unknown = null;
  private hbTimer: unknown = null;
  private driftTimer: unknown = null;
  private pings = new Map<string, number>();
  private pingSeq = 0;

  private currentState: RoomState | null = null;
  private appliedMediaId = "";
  private corrections = 0;
  private alignments = 0;
  private droppedStates = 0;
  private samples = 0;
  private gesturePending = false;

  constructor(opts: SyncClientOptions) {
    this.opts = opts;
    this.timers = opts.timers ?? defaultTimers;
    this.clock = new ClockSync({ now: opts.now });
  }

  get role(): Role {
    return this.opts.role;
  }

  /** 本端时钟估算（metrics 采样用）。 */
  clockEstimate() {
    return this.clock.estimate();
  }

  currentRoomState(): RoomState | null {
    return this.currentState;
  }

  connect(): void {
    const Impl = (this.opts.WebSocketImpl ?? globalThis.WebSocket) as new (
      url: string,
    ) => WSLike;
    const sock = new Impl(this.opts.wsUrl);
    this.ws = sock;

    sock.addEventListener("open", () => {
      if (this.ws !== sock) return;
      this.opts.onSocket?.(sock);
      this.reconnectAt = 1000;
      this.status(`已连接（${this.opts.role === "host" ? "房主" : "观众"}）`);
      // 连发 3 个 ping 快速收敛初始偏移，再进入周期测量。
      this.sendPing();
      this.timers.setTimeout(() => this.sendPing(), 400);
      this.timers.setTimeout(() => this.sendPing(), 900);
      this.pingTimer = this.timers.setInterval(() => this.sendPing(), this.opts.pingIntervalMs ?? 2000);
      if (this.opts.role === "host") {
        this.hbTimer = this.timers.setInterval(() => this.sendHeartbeat(), this.opts.heartbeatMs ?? 8000);
      } else {
        this.driftTimer = this.timers.setInterval(() => this.driftCheck(), this.opts.driftCheckMs ?? 1000);
      }
    });

    sock.addEventListener("message", (ev) => {
      if (this.ws !== sock) return;
      const data = (ev as { data: unknown }).data;
      const raw = typeof data === "string" ? data : String(data ?? "");
      let msg: ServerMessage;
      try {
        msg = JSON.parse(raw) as ServerMessage;
      } catch {
        return;
      }
      this.onServerMessage(msg);
    });

    sock.addEventListener("close", () => {
      if (this.ws !== sock) return;
      this.stopTimers();
      this.status("连接断开，重连中…");
      if (this.closedByUs) return;
      this.reconnects++;
      this.reconnectTimer = this.timers.setTimeout(() => this.connect(), this.reconnectAt);
      this.reconnectAt = Math.min(this.reconnectAt * 2, 20_000);
    });

    sock.addEventListener("error", () => {
      /* close 事件统一处理重连 */
    });
  }

  /** 页面离开时主动关闭（浏览器 pagehide）。 */
  disconnect(): void {
    this.closedByUs = true;
    try {
      this.send({ t: "bye" });
      this.ws?.close(1000, "bye");
    } catch {
      /* going away */
    }
    this.stopTimers();
  }

  /** 测试/诊断：直接断开底层连接（模拟断网，走重连路径）。 */
  simulateNetworkDrop(): void {
    const ws = this.ws as { terminate?: () => void } | null;
    try {
      // 优先 terminate（硬断、不发 close 帧，最接近断网）；
      // 1006 是保留状态码不能被发送方使用，故不用 close(1006)。
      if (ws?.terminate) ws.terminate();
      else this.ws?.close(1001);
    } catch {
      /* already gone */
    }
  }

  /** 测试入口：把一条服务端消息直接喂给客户端状态机（S14 乱序丢弃验证）。 */
  ingestServerMessage(msg: ServerMessage): void {
    this.onServerMessage(msg);
  }

  private stopTimers(): void {
    for (const t of [this.pingTimer, this.hbTimer, this.driftTimer]) {
      if (t !== null) this.timers.clearInterval(t);
    }
    this.pingTimer = this.hbTimer = this.driftTimer = null;
  }

  private status(line: string): void {
    this.opts.onStatus?.(line);
  }

  private send(msg: unknown): void {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(msg));
  }

  private sendPing(): void {
    const id = `p${this.pingSeq++}`;
    this.pings.set(id, this.clockNow());
    this.send({ t: "ping", id });
  }

  private clockNow(): number {
    return (this.opts.now ?? Date.now)();
  }

  // ── 房主 API：先本地应用（保留用户手势上下文），再发命令 ──

  async hostPlay(): Promise<void> {
    try {
      await this.opts.media.play();
      this.gesturePending = false;
    } catch {
      // 自动播放被拦（S08）：不发送 play 命令，等待用户手势。
      this.gesturePending = true;
      this.opts.onGestureNeeded?.();
      this.status("浏览器拦截了自动播放，请点击播放按钮加入");
      return;
    }
    this.send({ t: "cmd", action: "play", positionMs: Math.round(this.opts.media.getTimeMs()) });
  }

  hostPause(): void {
    this.opts.media.pause();
    this.send({ t: "cmd", action: "pause", positionMs: Math.round(this.opts.media.getTimeMs()) });
  }

  hostSeek(targetMs: number): void {
    this.opts.media.seek(targetMs);
    this.send({ t: "cmd", action: "seek", positionMs: Math.round(targetMs) });
  }

  hostRate(rate: number): void {
    this.opts.media.setRate(rate);
    this.send({ t: "cmd", action: "rate", rate, positionMs: Math.round(this.opts.media.getTimeMs()) });
  }

  async hostLoad(mediaId: string, mediaMeta: MediaMeta | null): Promise<void> {
    if (this.opts.media.load) await this.opts.media.load(mediaId, mediaMeta);
    this.send({
      t: "cmd",
      action: "load",
      mediaId,
      mediaMeta,
      positionMs: Math.round(this.opts.media.getTimeMs()),
      paused: this.opts.media.isPaused(),
      rate: this.opts.media.getRate(),
    });
  }

  /** 用户手势后的补播（S08 的「点击加入播放」）。 */
  async resumeFromGesture(): Promise<void> {
    await this.hostPlay();
  }

  private sendHeartbeat(): void {
    if (this.opts.media.hasMedia && !this.opts.media.hasMedia()) return;
    this.send({
      t: "hb",
      positionMs: Math.round(this.opts.media.getTimeMs()),
      paused: this.opts.media.isPaused(),
      rate: this.opts.media.getRate(),
    });
  }

  // ── 消息处理 ──────────────────────────────────────────────

  private onServerMessage(msg: ServerMessage): void {
    switch (msg.t) {
      case "welcome": {
        if (msg.state) {
          this.applyState(msg.state, { force: true, reason: "welcome" });
        } else {
          this.status(this.opts.role === "host" ? "房间已建立，请载入媒体" : "等待房主载入媒体…");
        }
        return;
      }
      case "pong": {
        const sent = this.pings.get(msg.id);
        if (sent === undefined) return;
        this.pings.delete(msg.id);
        const t2 = this.clockNow();
        this.clock.addSample(sent, msg.serverNow, t2);
        return;
      }
      case "state": {
        if (!isNewerState(msg, this.currentState)) {
          this.droppedStates++;
          return; // S14：乱序或旧片迟到消息
        }
        const mediaChanged = msg.mediaId !== this.appliedMediaId;
        this.applyState(msg, { force: mediaChanged || isImmediateAction(msg.action), reason: msg.action });
        this.opts.onStateApplied?.(msg);
        return;
      }
      case "roster":
        this.opts.onRoster?.(msg);
        if (msg.hostAway) this.status("房主暂时离开，房间已暂停，等待房主回来…");
        return;
      case "rejected":
        this.status(`命令被拒绝: ${msg.reason}`);
        return;
      case "error":
        this.status(`协议错误: ${msg.message}`);
        return;
    }
  }

  /** 应用一条权威状态（观众路径；welcome 时双方都用它对齐）。 */
  private applyState(
    state: RoomState,
    opts: { force: boolean; reason: string },
  ): void {
    const media = this.opts.media;
    this.currentState = state;

    if (state.mediaId && state.mediaId !== this.appliedMediaId) {
      // 切换视频（S04）：先换源再对齐位置；旧视频的任何迟到状态已被 isNewerState 挡掉。
      if (media.load) {
        try {
          void Promise.resolve(media.load(state.mediaId, state.mediaMeta)).catch((err) => {
            this.status(`载入媒体失败: ${err instanceof Error ? err.message : String(err)}`);
          });
        } catch (err) {
          this.status(`载入媒体失败: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      this.appliedMediaId = state.mediaId;
    }

    if (Number.isFinite(state.rate) && media.getRate() !== state.rate) {
      media.setRate(state.rate);
    }

    const plan = planCorrection(state, this.clock.serverNow(), media.getTimeMs(), {
      force: opts.force,
      hardDriftMs: this.opts.hardDriftMs,
    });
    if (plan.kind === "seek") {
      media.seek(plan.targetMs);
      if (opts.force) this.alignments++;
      else this.corrections++;
    }

    if (state.paused !== media.isPaused()) {
      if (state.paused) {
        media.pause();
      } else {
        Promise.resolve(media.play()).catch(() => {
          // 观众自动播放被拦（S08）：本地保持暂停，等用户手势；绝不反过来暂停房间。
          this.gesturePending = true;
          this.opts.onGestureNeeded?.();
          this.status("浏览器拦截了自动播放，请点击「加入播放」");
        });
      }
    }
  }

  /** 观众周期漂移检查（心跳只用于小纠偏，超阈值才硬 seek）。 */
  private driftCheck(): void {
    if (!this.currentState || this.gesturePending) return;
    this.samples++;
    const plan = planCorrection(
      this.currentState,
      this.clock.serverNow(),
      this.opts.media.getTimeMs(),
      { hardDriftMs: this.opts.hardDriftMs },
    );
    if (plan.kind === "seek") {
      this.corrections++;
      this.opts.media.seek(plan.targetMs);
    }
  }

  /** 指标采样（计划 §7.2）。 */
  sample(): SyncClientStats {
    const est = this.clock.estimate();
    const state = this.currentState;
    const clientTime = this.opts.media.getTimeMs();
    let expected: number | null = null;
    let drift: number | null = null;
    if (state) {
      expected = computeTarget(state, this.clock.serverNow()).targetMs;
      drift = clientTime - expected;
      if (this.opts.role === "host") {
        // 房主即权威：以自身为基准。
        expected = clientTime;
        drift = 0;
      }
    }
    return {
      role: this.opts.role,
      connected: this.ws?.readyState === 1,
      clockOffsetMs: Math.round(est.offsetMs),
      bestRttMs: Math.round(est.bestRttMs),
      revision: state?.revision ?? -1,
      mediaRevision: state?.mediaRevision ?? -1,
      appliedMediaId: this.appliedMediaId,
      expectedTargetMs: expected === null ? null : Math.round(expected),
      clientTimeMs: Math.round(clientTime),
      driftMs: drift === null ? null : Math.round(drift),
      corrections: this.corrections,
      alignments: this.alignments,
      reconnects: this.reconnects,
      droppedStates: this.droppedStates,
      samples: this.samples,
    };
  }
}
