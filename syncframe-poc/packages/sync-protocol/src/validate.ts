/**
 * 消息与状态校验：服务端在定序前、客户端在应用前都要过这道门。
 * 参照 Movi sanitizeState 的思路：控制器只能说有限几种话，且每部分形状必须正确。
 */

import type { ClientMessage, HostCommand, MediaMeta, StateAction } from "./types.ts";

const MAX_POSITION_MS = 24 * 3600 * 1000; // 24h 片上界
const RATES = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];
const ACTIONS: StateAction[] = ["play", "pause", "seek", "rate", "load", "hb"];

function finiteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

export function sanitizePosition(v: unknown): number | null {
  if (!finiteNumber(v) || v < 0 || v > MAX_POSITION_MS) return null;
  return v;
}

export function sanitizeRate(v: unknown): number | null {
  if (!finiteNumber(v) || !RATES.includes(v)) return null;
  return v;
}

export function sanitizeMediaId(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const id = v.trim().slice(0, 512);
  // mediaId 是不透明标识；Spike 里允许 OpenList 路径形态，但拒绝 URL 形态——
  // 签名/原始 URL 不进房间消息（审计差异点：原型直接广播 src，本项目不允许）。
  if (/^https?:\/\//i.test(id) || id.includes("?sign=")) return null;
  return id.length > 0 ? id : null;
}

export function sanitizeMediaMeta(v: unknown): MediaMeta | null {
  if (!v || typeof v !== "object") return null;
  const m = v as Record<string, unknown>;
  if (typeof m.name !== "string" || m.name.trim().length === 0) return null;
  return {
    name: m.name.trim().slice(0, 200),
    size: finiteNumber(m.size) && m.size >= 0 ? m.size : undefined,
    durationMs: finiteNumber(m.durationMs) && m.durationMs >= 0 ? m.durationMs : undefined,
  };
}

export function sanitizeAction(v: unknown): StateAction | null {
  return typeof v === "string" && (ACTIONS as string[]).includes(v) ? (v as StateAction) : null;
}

export type ParsedMessage = { ok: true; msg: ClientMessage } | { ok: false; reason: string };

/** 解析并校验一条客户端 JSON 消息。 */
export function parseClientMessage(raw: string): ParsedMessage {
  if (raw.length > 8192) return { ok: false, reason: "消息过大" };
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "JSON 解析失败" };
  }
  if (!data || typeof data !== "object" || typeof (data as { t?: unknown }).t !== "string") {
    return { ok: false, reason: "缺少 t 字段" };
  }
  const m = data as Record<string, unknown>;
  switch (m.t) {
    case "ping":
      return typeof m.id === "string" && m.id.length <= 32
        ? { ok: true, msg: { t: "ping", id: m.id } }
        : { ok: false, reason: "ping.id 非法" };
    case "bye":
      return { ok: true, msg: { t: "bye" } };
    case "hb": {
      const positionMs = sanitizePosition(m.positionMs);
      const rate = sanitizeRate(m.rate);
      if (positionMs === null || rate === null) return { ok: false, reason: "hb 字段非法" };
      return { ok: true, msg: { t: "hb", positionMs, paused: !!m.paused, rate } };
    }
    case "cmd": {
      if (m.action === "play" || m.action === "pause") {
        const positionMs = sanitizePosition(m.positionMs);
        if (positionMs === null) return { ok: false, reason: "cmd.positionMs 非法" };
        const msg: HostCommand = { t: "cmd", action: m.action, positionMs };
        return { ok: true, msg };
      }
      if (m.action === "seek") {
        const positionMs = sanitizePosition(m.positionMs);
        if (positionMs === null) return { ok: false, reason: "seek.positionMs 非法" };
        const msg: HostCommand = { t: "cmd", action: "seek", positionMs };
        return { ok: true, msg };
      }
      if (m.action === "rate") {
        const rate = sanitizeRate(m.rate);
        const positionMs = sanitizePosition(m.positionMs);
        if (rate === null || positionMs === null) return { ok: false, reason: "rate 字段非法" };
        const msg: HostCommand = { t: "cmd", action: "rate", rate, positionMs };
        return { ok: true, msg };
      }
      if (m.action === "load") {
        const mediaId = sanitizeMediaId(m.mediaId);
        const positionMs = sanitizePosition(m.positionMs);
        const rate = sanitizeRate(m.rate);
        if (mediaId === null || positionMs === null || rate === null) {
          return { ok: false, reason: "load 字段非法（mediaId 不允许 URL 形态）" };
        }
        // mediaMeta 可缺省；提供了但形状不对则拒绝（宁可报错不静默丢元信息）。
        const mediaMeta = sanitizeMediaMeta(m.mediaMeta);
        if (m.mediaMeta != null && mediaMeta === null) {
          return { ok: false, reason: "load.mediaMeta 形状非法" };
        }
        const msg: HostCommand = {
          t: "cmd",
          action: "load",
          mediaId,
          mediaMeta,
          positionMs,
          paused: !!m.paused,
          rate,
        };
        return { ok: true, msg };
      }
      return { ok: false, reason: `未知 cmd.action: ${String(m.action)}` };
    }
    default:
      return { ok: false, reason: `未知消息类型: ${String(m.t)}` };
  }
}
