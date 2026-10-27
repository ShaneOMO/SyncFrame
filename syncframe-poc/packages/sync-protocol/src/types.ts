/**
 * P2 同步协议：消息与状态类型。
 *
 * 设计要点（对照 docs/feasibility-validation-plan.md §4.5/§4.6 与 Movi Watch Party 审计）：
 * - WebSocket 只传播放状态，永不传媒体字节，也不传原始 URL——广播的是不透明 mediaId。
 * - 所有状态由服务端定序：revision 单调递增；mediaRevision 在换片时递增，
 *   用于丢弃「换片前的旧消息延迟到达」（S14）。
 * - 所有状态带 serverTimeMs（服务端权威时钟戳），跟随端据此推算「房主此刻应在哪」。
 * - 服务端时钟戳用单调时钟防护：系统时钟回拨不会让 serverTimeMs 倒退。
 */

/** 媒体元信息：host 换片时随状态广播，观众展示用；不含任何 URL。 */
export interface MediaMeta {
  name: string;
  size?: number;
  durationMs?: number;
}

/** 房间权威播放状态（服务端为唯一定序者）。 */
export interface RoomState {
  roomId: string;
  /** 单调递增，每次状态变更 +1，用于乱序/过期消息丢弃（S14）。 */
  revision: number;
  /** 换片时 +1；mediaRevision 更大的状态总是胜出。 */
  mediaRevision: number;
  /** 不透明媒体标识（P3 将映射到 OpenList 路径；Spike 里直接是路径字符串）。 */
  mediaId: string;
  mediaMeta: MediaMeta | null;
  paused: boolean;
  /** 操作发生时的媒体位置（毫秒）。 */
  positionMs: number;
  rate: number;
  /** 服务端确认该状态时的权威时间戳（毫秒，单调）。 */
  serverTimeMs: number;
  /** 触发该状态的动作来源成员 id。 */
  actorId: string;
  /** 动作标签：play | pause | seek | rate | load | hb（心跳）。 */
  action: StateAction;
}

export type StateAction = "play" | "pause" | "seek" | "rate" | "load" | "hb";
export type Role = "host" | "viewer";

export interface MemberInfo {
  id: string;
  name: string;
  role: Role;
}

/** 房主发出的控制命令（仅 host；服务端校验 role，S13）。 */
export type HostCommand =
  | { t: "cmd"; action: "play" | "pause"; positionMs: number }
  | { t: "cmd"; action: "seek"; positionMs: number }
  | { t: "cmd"; action: "rate"; rate: number; positionMs: number }
  | {
      t: "cmd";
      action: "load";
      mediaId: string;
      mediaMeta: MediaMeta | null;
      positionMs: number;
      paused: boolean;
      rate: number;
    };

/** 房主心跳（周期 5–10s）：只携带位置，服务端盖时间戳后广播。 */
export interface Heartbeat {
  t: "hb";
  positionMs: number;
  paused: boolean;
  rate: number;
}

/** 客户端时钟测量 ping。 */
export interface Ping {
  t: "ping";
  id: string;
}

export type ClientMessage = HostCommand | Heartbeat | Ping | { t: "bye" };

export interface Welcome {
  t: "welcome";
  you: string;
  role: Role;
  hostId: string | null;
  /** 房主断开但处于宽限期时为 true（房间已暂停等待房主回来，S07）。 */
  hostAway: boolean;
  members: MemberInfo[];
  state: RoomState | null;
  serverNow: number;
}

export interface Pong {
  t: "pong";
  id: string;
  serverNow: number;
}

export interface Roster {
  t: "roster";
  hostId: string | null;
  hostAway: boolean;
  members: MemberInfo[];
}

export interface StateMsg extends RoomState {
  t: "state";
}

export interface ErrorMsg {
  t: "error";
  code: string;
  message: string;
}

/** 控制命令被服务端拒绝（非房主或无房主时，S13 的证据）。 */
export interface RejectedMsg {
  t: "rejected";
  reason: string;
  action?: string;
}

export type ServerMessage = Welcome | Pong | Roster | StateMsg | ErrorMsg | RejectedMsg;
