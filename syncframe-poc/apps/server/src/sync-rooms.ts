/**
 * P2 同步房间：WebSocket 房间管理 + 状态定序 + 权威时钟戳。
 *
 * 与 Movi Watch Party 原型的差异（审计结论，见 docs/p2-sync-protocol.md）：
 * - 广播不透明 mediaId，不广播原始 src/URL；
 * - 仅房主可控制（无 grant/promote），房主离开→房间暂停+宽限期等待，不自动转移（S15）；
 * - revision + mediaRevision 定序，乱序/旧片迟到消息在客户端丢弃（S14）；
 * - 服务端单调时钟：系统时钟回拨不会让 serverTimeMs 倒退。
 *
 * 延迟注入（SYNC_INJECT_LATENCY_MS / SYNC_INJECT_JITTER_MS）统一加在
 * 服务端→客户端投递路径与命令处理路径上，用于仿真 WAN（测试用例 T-RTT100）。
 */

import type { WebSocket } from "ws";
import { parseClientMessage } from "@syncframe/sync-protocol";
import type {
  Heartbeat,
  HostCommand,
  MemberInfo,
  Role,
  RoomState,
  ServerMessage,
} from "@syncframe/sync-protocol";

const MAX_MEMBERS = 12; // 计划 §2.2：12 人为验证上限
const MAX_NAME_LEN = 24;
const SWEEP_EVERY_MS = 10_000;
const DEAD_AFTER_MS = 55_000;
/** 房主断开后房间保留状态等待重连的宽限期（计划 §4.7：MVP 暂停 + 30s）。 */
export const HOST_GRACE_MS = 30_000;
/** 房间最后一人离开后保留多久（给刷新页面/瞬时断连留窗口）。 */
const EMPTY_GRACE_MS = 5_000;

interface Member {
  id: string;
  name: string;
  role: Role;
  ws: WebSocket;
  alive: number;
}

export interface RoomManagerOptions {
  /** 注入的固定单向延迟（毫秒），仿真 WAN RTT = 2×该值。 */
  injectLatencyMs?: number;
  /** 注入的随机抖动（毫秒），均匀分布于 [0, jitter]。 */
  injectJitterMs?: number;
  now?: () => number;
  onDebug?: (line: string) => void;
  /** 房间回收回调（P3：联动清理注册表里的成员/媒体记录）。 */
  onRoomDisposed?: (roomId: string) => void;
}

export class RoomManager {
  private rooms = new Map<string, Room>();
  private readonly injectLatencyMs: number;
  private readonly injectJitterMs: number;
  private readonly now: () => number;
  private readonly onDebug: (line: string) => void;
  private readonly onRoomDisposed: (roomId: string) => void;
  /** 房间外可读的统计（测试断言用）：被拒绝的命令数。 */
  rejectedCommands = 0;

  constructor(opts: RoomManagerOptions = {}) {
    this.injectLatencyMs = opts.injectLatencyMs ?? 0;
    this.injectJitterMs = opts.injectJitterMs ?? 0;
    this.now = opts.now ?? Date.now;
    this.onDebug = opts.onDebug ?? (() => {});
    this.onRoomDisposed = opts.onRoomDisposed ?? (() => {});
  }

  /** 单调权威时钟：只进不退（系统时钟回拨防护）。 */
  stamp(): number {
    const t = this.now();
    if (t <= this.lastStamp) return this.lastStamp + 1;
    this.lastStamp = t;
    return t;
  }
  private lastStamp = 0;

  roomCount(): number {
    return this.rooms.size;
  }

  /** 测试钩子：直接查看房间内部状态。 */
  peek(roomId: string): Room | undefined {
    return this.rooms.get(roomId);
  }

  /** WS upgrade 入口（P3 起鉴权前置）：room 必须已存在，成员身份由 room-auth 校验后传入。 */
  handleJoin(ws: WebSocket, roomId: string, member: { clientId: string; name: string; role: Role }): void {
    if (!roomId) {
      ws.close(4000, "缺少 room 参数");
      return;
    }

    let room = this.rooms.get(roomId);
    if (!room) {
      room = new Room(roomId, this);
      this.rooms.set(roomId, room);
    }
    if (room.memberCount() >= MAX_MEMBERS) {
      ws.close(4001, "房间已满（上限 12 人）");
      return;
    }
    room.join(ws, member.clientId, member.name, member.role);
  }

  /** 延迟注入投递：所有服务端→客户端消息都走这里。 */
  deliver(ws: WebSocket, msg: ServerMessage): void {
    const payload = JSON.stringify(msg);
    const delay = this.injectLatencyMs + (this.injectJitterMs > 0 ? Math.random() * this.injectJitterMs : 0);
    if (delay <= 0) {
      this.rawSend(ws, payload);
      return;
    }
    setTimeout(() => this.rawSend(ws, payload), delay);
  }

  private rawSend(ws: WebSocket, payload: string): void {
    if (ws.readyState !== ws.OPEN) return;
    try {
      ws.send(payload);
    } catch {
      /* 断线清理由 sweep 负责 */
    }
  }

  debug(line: string): void {
    this.onDebug(line);
  }

  /** 房间空了之后回收。 */
  disposeRoom(roomId: string): void {
    this.rooms.delete(roomId);
    this.onRoomDisposed(roomId);
  }
}

export class Room {
  readonly id: string;
  private readonly mgr: RoomManager;
  private members = new Map<string, Member>();
  private hostId: string | null = null;
  private hostAwaySince: number | null = null;
  private revision = 0;
  private mediaRevision = 0;
  private state: RoomState | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private emptySince: number | null = null;

  constructor(id: string, mgr: RoomManager) {
    this.id = id;
    this.mgr = mgr;
  }

  memberCount(): number {
    return this.members.size;
  }

  getState(): RoomState | null {
    return this.state;
  }

  isHostAway(): boolean {
    return this.hostAwaySince !== null;
  }

  join(ws: WebSocket, clientId: string, name: string, wantRole: Role): void {
    // 房主重连（同一 clientId）：恢复 host 身份与权威状态（S07）。
    const reclaimHost = this.hostId === clientId;
    const isHost = reclaimHost || (wantRole === "host" && this.hostId === null);
    const role: Role = isHost ? "host" : "viewer";

    // 同一 clientId 重复连接（旧 socket 未清）：踢掉旧的，避免双连接双身份。
    const existing = this.members.get(clientId);
    if (existing) {
      try {
        existing.ws.close(4002, "同一身份在新连接登录");
      } catch {
        /* already gone */
      }
      this.members.delete(clientId);
    }

    const member: Member = { id: clientId, name, role, ws, alive: this.mgr.stamp() };
    this.members.set(clientId, member);
    if (isHost) {
      this.hostId = clientId;
      this.hostAwaySince = null;
      // 房主回来了：若房间因房主离开而暂停，权威状态保持暂停，由房主发 play 恢复——
      // 不自动续播（MVP 行为明确性优先，见计划 §4.7）。
    }
    this.emptySince = null;
    this.ensureTimer();

    ws.on("message", (raw) => this.onMessage(member, raw.toString()));
    ws.on("close", () => this.drop(member.id));
    ws.on("error", () => this.drop(member.id));

    // 新成员（含迟到加入 S05、断线重连 S06）拿当前权威状态，由客户端自行对齐。
    this.mgr.deliver(ws, {
      t: "welcome",
      you: clientId,
      role,
      hostId: this.hostId,
      hostAway: this.hostAwaySince !== null,
      members: this.roster(),
      state: this.state,
      serverNow: this.mgr.stamp(),
    });
    this.broadcastRoster();
  }

  private onMessage(member: Member, raw: string): void {
    member.alive = this.mgr.stamp();
    const parsed = parseClientMessage(raw);
    if (!parsed.ok) {
      this.mgr.deliver(member.ws, { t: "error", code: "BAD_MESSAGE", message: parsed.reason });
      return;
    }
    const msg = parsed.msg;
    switch (msg.t) {
      case "ping":
        this.mgr.deliver(member.ws, { t: "pong", id: msg.id, serverNow: this.mgr.stamp() });
        return;
      case "bye":
        this.drop(member.id);
        return;
      case "hb":
        this.applyHeartbeat(member, msg);
        return;
      case "cmd":
        this.applyCommand(member, msg);
        return;
    }
  }

  /** 仅房主可驱动（S13）：服务端是最后的权限门。 */
  private requireHost(member: Member, action: string): boolean {
    if (member.role === "host" && member.id === this.hostId) return true;
    this.mgr.rejectedCommands++;
    this.mgr.deliver(member.ws, {
      t: "rejected",
      reason: "只有房主可以控制播放",
      action,
    });
    this.mgr.debug(`room=${this.id} 拒绝非房主命令 member=${member.id} action=${action}`);
    return false;
  }

  private applyHeartbeat(member: Member, hb: Heartbeat): void {
    if (!this.requireHost(member, "hb")) return;
    if (!this.state) return;
    this.publish({
      mediaId: this.state.mediaId,
      mediaMeta: this.state.mediaMeta,
      paused: hb.paused,
      positionMs: hb.positionMs,
      rate: hb.rate,
      actorId: member.id,
      action: "hb",
    });
  }

  private applyCommand(member: Member, cmd: HostCommand): void {
    if (!this.requireHost(member, cmd.action)) return;
    const prev = this.state;
    if (cmd.action === "load") {
      this.mediaRevision++;
      this.publish({
        mediaId: cmd.mediaId,
        mediaMeta: cmd.mediaMeta,
        paused: cmd.paused,
        positionMs: cmd.positionMs,
        rate: cmd.rate,
        actorId: member.id,
        action: "load",
      });
      return;
    }
    if (!prev) return; // 还没有媒体，非 load 命令无从依附
    switch (cmd.action) {
      case "play":
        this.publish({
          mediaId: prev.mediaId,
          mediaMeta: prev.mediaMeta,
          paused: false,
          positionMs: cmd.positionMs,
          rate: prev.rate,
          actorId: member.id,
          action: "play",
        });
        return;
      case "pause":
        this.publish({
          mediaId: prev.mediaId,
          mediaMeta: prev.mediaMeta,
          paused: true,
          positionMs: cmd.positionMs,
          rate: prev.rate,
          actorId: member.id,
          action: "pause",
        });
        return;
      case "seek":
        this.publish({
          mediaId: prev.mediaId,
          mediaMeta: prev.mediaMeta,
          paused: prev.paused,
          positionMs: cmd.positionMs,
          rate: prev.rate,
          actorId: member.id,
          action: "seek",
        });
        return;
      case "rate":
        this.publish({
          mediaId: prev.mediaId,
          mediaMeta: prev.mediaMeta,
          paused: prev.paused,
          positionMs: cmd.positionMs,
          rate: cmd.rate,
          actorId: member.id,
          action: "rate",
        });
        return;
    }
  }

  /** 定序 + 盖时间戳 + 广播（不回显发送者）。 */
  private publish(
    partial: Omit<RoomState, "roomId" | "revision" | "mediaRevision" | "serverTimeMs">,
  ): RoomState {
    this.revision++;
    const state: RoomState = {
      roomId: this.id,
      revision: this.revision,
      mediaRevision: this.mediaRevision,
      serverTimeMs: this.mgr.stamp(),
      ...partial,
    };
    this.state = state;
    const payload: ServerMessage = { t: "state", ...state };
    for (const [id, m] of this.members) {
      if (id === state.actorId) continue; // 不回显，发送者以本地时钟为准（防回声回环）
      this.mgr.deliver(m.ws, payload);
    }
    return state;
  }

  private drop(memberId: string): void {
    const member = this.members.get(memberId);
    if (!member) return;
    this.members.delete(memberId);
    this.mgr.debug(`room=${this.id} member=${memberId}(${member.name}) 离开 role=${member.role}`);

    if (this.hostId === memberId) {
      // S15 / 计划 §4.7：房主离开 → 房间进入暂停并保留 30s 重连宽限期，不自动转移。
      this.hostId = null;
      this.hostAwaySince = this.mgr.stamp();
      if (this.state && !this.state.paused) {
        this.publish({
          mediaId: this.state.mediaId,
          mediaMeta: this.state.mediaMeta,
          paused: true,
          positionMs: this.state.positionMs,
          rate: this.state.rate,
          actorId: memberId,
          action: "pause",
        });
      }
    }

    if (this.members.size === 0) {
      this.emptySince = this.mgr.stamp();
    }
    this.broadcastRoster();
  }

  private roster(): MemberInfo[] {
    return [...this.members.values()].map((m) => ({ id: m.id, name: m.name, role: m.role }));
  }

  private broadcastRoster(): void {
    const payload: ServerMessage = {
      t: "roster",
      hostId: this.hostId,
      hostAway: this.hostAwaySince !== null,
      members: this.roster(),
    };
    for (const m of this.members.values()) this.mgr.deliver(m.ws, payload);
  }

  private ensureTimer(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.sweep(), SWEEP_EVERY_MS);
  }

  private sweep(): void {
    const now = this.mgr.stamp();
    // 死连接清理（浏览器崩溃、断网无 close 帧）。
    for (const [id, m] of [...this.members]) {
      if (m.alive < now - DEAD_AFTER_MS) {
        try {
          m.ws.close(1001, "心跳超时");
        } catch {
          /* gone */
        }
        this.drop(id);
      }
    }
    // 房主宽限期：超过后仍保持暂停（无自动转移），只记录日志。
    if (this.hostAwaySince !== null && now - this.hostAwaySince > HOST_GRACE_MS) {
      this.mgr.debug(`room=${this.id} 房主宽限期已过，房间保持暂停等待房主回来`);
      this.hostAwaySince = this.mgr.stamp(); // 避免每 10s 重复刷日志
    }
    // 空房间回收。
    if (this.members.size === 0) {
      if (this.emptySince === null) this.emptySince = now;
      if (now - this.emptySince > EMPTY_GRACE_MS) {
        if (this.timer) clearInterval(this.timer);
        this.state = null;
        this.mgr.disposeRoom(this.id);
      }
    }
  }
}
