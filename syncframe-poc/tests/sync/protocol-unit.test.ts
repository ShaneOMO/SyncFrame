/**
 * sync-protocol 单元测试：时钟偏移、目标计算、漂移纠正、状态定序、消息校验。
 * 运行：node --import tsx --test tests/sync/protocol-unit.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { ClockSync } from "../../packages/sync-protocol/src/clock.ts";
import {
  computeTarget,
  isNewerState,
  planCorrection,
} from "../../packages/sync-protocol/src/follower.ts";
import { parseClientMessage } from "../../packages/sync-protocol/src/validate.ts";
import { VirtualMediaClock } from "../../packages/sync-protocol/src/virtual-clock.ts";
import type { RoomState } from "../../packages/sync-protocol/src/types.ts";

function makeState(over: Partial<RoomState> = {}): RoomState {
  return {
    roomId: "r1",
    revision: 1,
    mediaRevision: 1,
    mediaId: "/media/a.mkv",
    mediaMeta: { name: "a.mkv" },
    paused: false,
    positionMs: 60_000,
    rate: 1,
    serverTimeMs: 1_000_000,
    actorId: "host",
    action: "play",
    ...over,
  };
}

// ── ClockSync ──────────────────────────────────────────────
test("时钟偏移：无延迟网络下 offset 精确等于时钟差", () => {
  let t = 0;
  const clock = new ClockSync({ now: () => t });
  // 服务端时钟比客户端快 +5000ms；RTT=100（t0=0, t1 在服务端时刻 5050, t2=100）
  t = 0;
  clock.addSample(0, 5050, 100);
  const est = clock.estimate();
  assert.equal(est.offsetMs, 5000);
  assert.equal(est.bestRttMs, 100);
});

test("时钟偏移：多样本取 RTT 最小者，坏样本被丢弃", () => {
  let t = 0;
  const clock = new ClockSync({ now: () => t, windowSize: 4 });
  // 真实偏移 +200；第一个样本 RTT 大（排队），后续样本 RTT 小
  clock.addSample(0, 200 + 400, 800); // rtt=800, offset=200+400-400=200？ 对称假设下 offset=200
  t = 1000;
  clock.addSample(1000, 1000 + 200 + 50, 1100); // rtt=100, offset=200
  t = 2000;
  clock.addSample(2000, 2000 + 200 + 30, 2060); // rtt=60, offset=200
  const est = clock.estimate();
  assert.ok(Math.abs(est.offsetMs - 200) <= 60, `offset=${est.offsetMs}`);
  assert.equal(est.bestRttMs, 60);
});

test("时钟偏移：单次跳变受 maxStepMs 限制", () => {
  let t = 0;
  const clock = new ClockSync({ now: () => t, maxStepMs: 250 });
  clock.addSample(0, 500, 100); // offset=500 被采纳（首个样本）
  t = 1000;
  // 来一个噪声样本声称 offset=5000，rtt 很小
  clock.addSample(1000, 5000 + 1050, 1100);
  const est = clock.estimate();
  assert.ok(est.offsetMs <= 500 + 250, `offset=${est.offsetMs} 不应跳到 5000`);
});

test("时钟偏移：负 RTT / 超 RTT 上限样本返回 null", () => {
  const clock = new ClockSync({ maxRttMs: 500 });
  assert.equal(clock.addSample(100, 150, 90), null); // t2<t0
  assert.equal(clock.addSample(0, 100, 2000), null); // rtt=2000 > 500
});

// ── computeTarget / planCorrection ─────────────────────────
test("目标位置：播放中按经过时间×倍速推进", () => {
  const s = makeState({ paused: false, positionMs: 60_000, rate: 2, serverTimeMs: 1000 });
  const { targetMs } = computeTarget(s, 1000 + 5000); // 服务端过了 5s
  assert.equal(targetMs, 60_000 + 10_000);
});

test("目标位置：暂停时不推进", () => {
  const s = makeState({ paused: true, positionMs: 60_000, serverTimeMs: 1000 });
  const { targetMs } = computeTarget(s, 1000 + 5000);
  assert.equal(targetMs, 60_000);
});

test("漂移纠正：阈值内不 seek，阈值外硬 seek", () => {
  const s = makeState({ serverTimeMs: 1000 });
  const within = planCorrection(s, 1000 + 300, 60_000 + 300 + 900); // 漂移 +900ms
  assert.equal(within.kind, "none");
  const beyond = planCorrection(s, 1000 + 300, 60_000 + 300 + 1200); // 漂移 +1200ms
  assert.equal(beyond.kind, "seek");
  assert.equal(beyond.targetMs, 60_000 + 300);
});

test("漂移纠正：force（加入/重连/命令）即使在阈值内也 seek 对齐", () => {
  const s = makeState({ action: "seek", paused: false, positionMs: 30_000, serverTimeMs: 500 });
  const plan = planCorrection(s, 500 + 100, 30_000 + 80, { force: true });
  assert.equal(plan.kind, "seek");
  assert.ok(Math.abs(plan.driftMs) <= 1000, "阈值内 force 不触发大幅跳转");
});

// ── isNewerState ───────────────────────────────────────────
test("状态定序：revision 乱序丢弃，mediaRevision 优先", () => {
  const cur = { revision: 10, mediaRevision: 2 };
  assert.equal(isNewerState({ revision: 9, mediaRevision: 2 }, cur), false); // S14 旧消息
  assert.equal(isNewerState({ revision: 11, mediaRevision: 2 }, cur), true);
  assert.equal(isNewerState({ revision: 1, mediaRevision: 3 }, cur), true); // 换片后一切新状态胜出
  assert.equal(isNewerState({ revision: 99, mediaRevision: 1 }, cur), false); // 旧片迟到消息
  assert.equal(isNewerState({ revision: 1, mediaRevision: 1 }, null), true); // 首个状态
});

// ── parseClientMessage ─────────────────────────────────────
test("消息校验：合法命令通过", () => {
  const cases = [
    { t: "cmd", action: "play", positionMs: 1000 },
    { t: "cmd", action: "pause", positionMs: 1000 },
    { t: "cmd", action: "seek", positionMs: 5000 },
    { t: "cmd", action: "rate", rate: 1.25, positionMs: 1000 },
    { t: "cmd", action: "load", mediaId: "/movies/a.mkv", mediaMeta: { name: "a.mkv" }, positionMs: 0, paused: true, rate: 1 },
    { t: "hb", positionMs: 100, paused: false, rate: 1 },
    { t: "ping", id: "abc" },
    { t: "bye" },
  ];
  for (const c of cases) {
    const r = parseClientMessage(JSON.stringify(c));
    assert.ok(r.ok, `${c.t}/${(c as { action?: string }).action ?? ""} 应通过: ${r.ok ? "" : r.reason}`);
  }
});

test("消息校验：非法形状与 URL 泄露被拒（S13/S14 服务端防线）", () => {
  const bad = [
    { t: "cmd", action: "seek", positionMs: NaN },
    { t: "cmd", action: "seek", positionMs: -5 },
    { t: "cmd", action: "rate", rate: 40, positionMs: 0 },
    { t: "cmd", action: "rate", rate: 1.3, positionMs: 0 }, // 不在白名单
    { t: "cmd", action: "load", mediaId: "http://cdn.example.com/x.mkv?sign=s", positionMs: 0, paused: true, rate: 1 },
    { t: "cmd", action: "load", mediaId: "/ok.mkv", mediaMeta: { nope: 1 }, positionMs: 0, paused: true, rate: 1 },
    { t: "hb", positionMs: Number.POSITIVE_INFINITY, paused: false, rate: 1 },
    { t: "cmd", action: "evict", positionMs: 0 },
    { t: "mystery" },
    "not json",
  ];
  for (const c of bad) {
    const raw = typeof c === "string" ? c : JSON.stringify(c);
    const r = parseClientMessage(raw);
    assert.ok(!r.ok, `${raw.slice(0, 60)} 应被拒绝`);
  }
});

// ── VirtualMediaClock ──────────────────────────────────────
test("虚拟时钟：seek 延迟期内保持原位，完成后落到目标并补记墙钟推进", () => {
  let t = 0;
  const vc = new VirtualMediaClock({ seekLatencyMs: 200, now: () => t });
  vc.setPosition(10_000);
  vc.play();
  t = 1000;
  assert.ok(Math.abs(vc.getCurrentTimeMs() - 11_000) < 1);
  vc.seek(60_000);
  t = 1100;
  assert.ok(vc.getCurrentTimeMs() < 11_100, "seek 中不应前进到目标");
  t = 1300;
  // 落点 = 目标 + seek 发起以来的墙钟推进（播放中 300ms × 1）
  assert.equal(vc.getCurrentTimeMs(), 60_300);
  t = 1500;
  assert.equal(vc.getCurrentTimeMs(), 60_500);
});

test("虚拟时钟：倍速与暂停", () => {
  let t = 0;
  const vc = new VirtualMediaClock({ now: () => t });
  vc.setPosition(0);
  vc.play();
  vc.setRate(2);
  t = 5000;
  assert.equal(vc.getCurrentTimeMs(), 10_000);
  vc.pause();
  t = 9000;
  assert.equal(vc.getCurrentTimeMs(), 10_000);
});
