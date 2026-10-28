/**
 * 跟随端目标位置计算与漂移纠正决策（计划 §4.5/§4.6）。
 *
 * target = positionMs + (paused ? 0 : max(0, serverNow - serverTimeMs) × rate)
 *
 * 最小版本只硬纠正（> 阈值直接 seek），不做小偏差倍速微调；
 * 阈值预算是墙钟时间：0.5× 下 1s 墙钟只走 0.5s 片长。
 */

import type { RoomState } from "./types.ts";

export interface FollowTarget {
  targetMs: number;
  elapsedMs: number;
}

export function computeTarget(state: RoomState, serverNowMs: number): FollowTarget {
  const elapsedMs = state.paused ? 0 : Math.max(0, serverNowMs - state.serverTimeMs) * state.rate;
  return { targetMs: state.positionMs + elapsedMs, elapsedMs };
}

export type CorrectionKind = "none" | "seek";

export interface CorrectionPlan {
  kind: CorrectionKind;
  targetMs: number;
  /** 观测到的偏差（客户端当前 - 目标），纠正决策依据。 */
  driftMs: number;
}

export interface CorrectionPolicy {
  /** 硬纠正阈值（毫秒，墙钟预算）。默认 1000ms（计划 §4.6）。 */
  hardDriftMs?: number;
}

/**
 * 决定本次纠偏动作。
 * force=true 的场景（加入、重连、seek/load/play 命令、切换视频后首次对齐）直接 seek，
 * 不受阈值限制——但漂移仍在阈值内时返回 none 以避免来回跳（S02）。
 */
export function planCorrection(
  state: RoomState,
  serverNowMs: number,
  clientTimeMs: number,
  opts: CorrectionPolicy & { force?: boolean } = {},
): CorrectionPlan {
  const { targetMs } = computeTarget(state, serverNowMs);
  const driftMs = clientTimeMs - targetMs;
  const hard = opts.hardDriftMs ?? 1000;
  if (Math.abs(driftMs) <= hard && !opts.force) {
    return { kind: "none", targetMs, driftMs };
  }
  return { kind: "seek", targetMs, driftMs };
}

/**
 * 新到达的状态是否比本地已应用的更新。
 * 规则：mediaRevision 更大 → 更新；相等时 revision 更大 → 更新；否则丢弃（S14）。
 * mediaRevision 更小的状态永远丢弃（旧片的迟到消息）。
 */
export function isNewerState(
  incoming: Pick<RoomState, "revision" | "mediaRevision">,
  current: Pick<RoomState, "revision" | "mediaRevision"> | null,
): boolean {
  if (!current) return true;
  if (incoming.mediaRevision !== current.mediaRevision) {
    return incoming.mediaRevision > current.mediaRevision;
  }
  return incoming.revision > current.revision;
}

/** 动作是否为「必须立即对齐」的命令（区别于心跳）。 */
export function isImmediateAction(action: string): boolean {
  return action === "play" || action === "seek" || action === "load";
}
