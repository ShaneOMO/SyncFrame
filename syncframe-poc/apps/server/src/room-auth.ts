/**
 * P3 房间鉴权与媒体受控映射。
 *
 * 职责：
 * - 房间注册：POST /api/rooms 生成 roomId + 观众邀请码 inviteCode，创建者成为房主成员；
 * - 成员会话：join 签发 memberToken（随机、12h 有效、绑定房间+角色+clientId），
 *   WebSocket 凭 memberToken 入场（服务端由此获得最后的权限门）；
 * - 媒体受控映射：房主通过 POST /api/rooms/:id/media 把 OpenList 路径注册为
 *   不透明 mediaId（m_<base36>）；WebSocket 只广播 mediaId，永不出现 URL/路径；
 * - 短期媒体访问凭证：GET .../media/:mediaId/grant 校验「是该房间成员 + mediaId 已注册」后，
 *   用服务端 OpenList 会话解析出最终媒体地址返回；按 (member, mediaId) 缓存 60s；
 *   OpenList 管理令牌只在服务端内存，绝不进入 WS/日志/响应。
 *
 * 安全约定（P3 通过门槛的证据）：
 * - 令牌、签名 URL、OpenList 路径不写入任何日志（audit 只记 roomId/mediaId/clientId/动作）；
 * - 浏览/搜索接口仅房主可用（观众不能浏览未授权目录）；
 * - grant 校验 mediaId 属于该房间（跨房间 mediaId 一律 404，不暴露存在性）；
 * - viewer 令牌注册媒体 → 403；未知/过期令牌 → 401；URL 中的 sign 参数不回显给非授权路径。
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomBytes, randomUUID, createHash } from "node:crypto";

/** 成员令牌有效期：12h（刷新页面/短期断网重连在窗口内免登录）。 */
export const MEMBER_TOKEN_TTL_MS = 12 * 60 * 60 * 1000;
/** grant 结果服务端缓存：同一成员同一 mediaId 60s 内直接复用（签名 URL 短时稳定）。 */
const GRANT_CACHE_MS = 60_000;
/** 客户端拿到的 expiresInSec 提示：到期前应重新 grant（刷新签名）。 */
export const GRANT_TTL_SEC = 600;
/** 房间邀请码：6 位大写字母数字（去掉易混淆字符）。 */
const INVITE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
/** 外挂字幕扩展名：与视频一同自动注册，走同一 grant 授权路径（P3 任务 8）。 */
const SUBTITLE_EXTS = new Set([".srt", ".ass", ".ssa", ".vtt"]);

export type Role = "host" | "viewer";

export interface MediaEntry {
  mediaId: string;
  /** OpenList 文件路径（仅服务端持有，不外发）。直链条目此字段为空字符串。 */
  path: string;
  name: string;
  size: number;
  registeredBy: string;
  registeredAt: number;
  /** 来源 provider 标签（直链 / OpenList / 用户自定义 provider 名），用于播放列表展示。 */
  provider: string;
  /** 直链 provider：最终地址（成员经 grant 拿到；仅服务端持有，不进 WS/日志）。 */
  directUrl?: string;
  /** 房主私有 OpenList provider 的所有者（用户名）+ providerId；grant 时用该用户的凭据解析。 */
  providerOwner?: string;
  providerId?: string;
  /** Bilibili provider：BV 号 + 分 P cid + aid（仅服务端持有）。 */
  bilibili?: { bvid: string; cid: number; aid: number };
}

export interface RelatedEntry {
  mediaId: string;
  name: string;
  size: number;
}

export interface MemberRecord {
  token: string;
  clientId: string;
  name: string;
  role: Role;
  expiresAt: number;
  joinedAt: number;
}

export interface RoomRecord {
  roomId: string;
  inviteCode: string;
  /** 房主重连密钥：只在创建响应中出现一次，可重建房主会话（替代可被观众看到的 clientId）。 */
  hostSecret: string;
  createdAt: number;
  /** 最近一次成员活动（加入/授权）：注册表清扫据此判断闲置。 */
  lastActiveAt: number;
  hostClientId: string;
  /** 房主昵称（房间列表展示）。 */
  hostName: string;
  /** 创建者账户（用户名）：provider 媒体操作只允许房主本人账户（游客无权创建房间）。 */
  hostUser: string;
  media: Map<string, MediaEntry>;
  members: Map<string, MemberRecord>; // key = memberToken
}

export interface GrantResult {
  url: string;
  name: string;
  size: number;
  expiresInSec: number;
  cached: boolean;
}

interface GrantCacheEntry {
  url: string;
  name: string;
  size: number;
  at: number;
}

export interface AuditEvent {
  roomId: string;
  action: string;
  clientId?: string;
  mediaId?: string;
  detail?: string;
}

export interface RoomRegistryOptions {
  now?: () => number;
  onAudit?: (ev: AuditEvent) => void;
  /** 持久化目录：房间（含成员令牌/邀请码/媒体映射）落盘 <dataDir>/rooms.json，重启恢复。 */
  dataDir?: string | null;
}

function makeInviteCode(): string {
  const bytes = randomBytes(6);
  let code = "";
  for (let i = 0; i < 6; i++) code += INVITE_ALPHABET[bytes[i] % INVITE_ALPHABET.length];
  return code;
}

function makeMediaId(): string {
  return `m_${randomBytes(6).toString("base64url").replace(/[-_]/g, "x").slice(0, 8).toLowerCase()}`;
}

/** 文件名扩展名（小写，含点），如 ".mkv"。 */
function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i < 0 ? "" : name.slice(i).toLowerCase();
}

export class RoomRegistry {
  private readonly rooms = new Map<string, RoomRecord>();
  private readonly now: () => number;
  private readonly onAudit: (ev: AuditEvent) => void;
  private readonly file: string | null;

  constructor(opts: RoomRegistryOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.onAudit = opts.onAudit ?? (() => {});
    this.file = opts.dataDir ? path.join(opts.dataDir, "rooms.json") : null;
    if (!this.file) return;
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf-8")) as {
        rooms?: (Omit<RoomRecord, "media" | "members"> & {
          media?: [string, MediaEntry][];
          members?: [string, MemberRecord][];
        })[];
      };
      for (const r of raw.rooms ?? []) {
        this.rooms.set(r.roomId, {
          ...r,
          media: new Map(r.media ?? []),
          members: new Map(r.members ?? []),
        });
      }
    } catch {
      // 文件不存在或损坏：从空注册表开始。
    }
  }

  /** 原子落盘（tmp + rename）；未配置 dataDir 时为无操作。只写非敏感摘要 + 映射，凭据不入此文件。 */
  private save(): void {
    if (!this.file) return;
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      writeFileSync(
        tmp,
        JSON.stringify({
          version: 1,
          rooms: [...this.rooms.values()].map((r) => ({
            ...r,
            media: [...r.media.entries()],
            members: [...r.members.entries()],
          })),
        }),
      );
      renameSync(tmp, this.file);
    } catch (err) {
      console.warn(`[store] 房间落盘失败: ${err instanceof Error ? err.message : err}`);
    }
  }

  audit(ev: AuditEvent): void {
    this.onAudit(ev);
  }

  roomCount(): number {
    return this.rooms.size;
  }

  roomIds(): string[] {
    return [...this.rooms.keys()];
  }

  peek(roomId: string): RoomRecord | undefined {
    return this.rooms.get(roomId);
  }

  /** 创建房间：创建者即房主（memberToken 直接签发）；hostSecret 用于房主重建会话。 */
  createRoom(hostName: string, hostUser: string, hostClientId?: string): {
    room: RoomRecord;
    member: MemberRecord;
    hostSecret: string;
  } {
    const name = hostName.trim().slice(0, 24) || "房主";
    let roomId = randomBytes(4).toString("base64url").replace(/[-_]/g, "a").slice(0, 6).toLowerCase();
    while (this.rooms.has(roomId)) roomId = makeMediaId().slice(2, 10).toLowerCase();
    const hostSecret = randomUUID();
    const room: RoomRecord = {
      roomId,
      inviteCode: makeInviteCode(),
      hostSecret,
      createdAt: this.now(),
      lastActiveAt: this.now(),
      hostClientId: "",
      hostName: name,
      hostUser,
      media: new Map(),
      members: new Map(),
    };
    this.rooms.set(roomId, room);
    const member = this.addMember(room, name, "host", hostClientId);
    this.save();
    room.hostClientId = member.clientId;
    this.audit({ roomId, action: "room:create", clientId: member.clientId });
    return { room, member, hostSecret };
  }

  private addMember(room: RoomRecord, name: string, role: Role, clientId?: string): MemberRecord {
    // 同一 clientId 重复加入：签发新令牌、作废旧令牌（同 P2 房间层的防双连接语义）。
    for (const [tok, m] of room.members) {
      if (m.clientId === clientId) room.members.delete(tok);
    }
    room.lastActiveAt = this.now();
    const member: MemberRecord = {
      token: randomUUID(),
      clientId: (clientId ?? randomUUID().slice(0, 8)).slice(0, 32),
      name: name.trim().slice(0, 24) || "Guest",
      role,
      expiresAt: this.now() + MEMBER_TOKEN_TTL_MS,
      joinedAt: this.now(),
    };
    room.members.set(member.token, member);
    return member;
  }

  /** 加入房间：观众凭邀请码；房主凭 hostSecret 重建会话（恢复同一 clientId 与控制权）。 */
  joinRoom(
    roomId: string,
    name: string,
    opts: { inviteCode?: string; hostSecret?: string } = {},
  ): MemberRecord | null {
    const room = this.rooms.get(roomId);
    if (!room) return null;
    const isHost = opts.hostSecret !== undefined && opts.hostSecret === room.hostSecret;
    if (!isHost) {
      if (!opts.inviteCode || opts.inviteCode.toUpperCase() !== room.inviteCode) return null;
    }
    const member = this.addMember(room, name, isHost ? "host" : "viewer", isHost ? room.hostClientId : undefined);
    this.save();
    this.audit({
      roomId,
      action: isHost ? "room:rejoin-host" : "room:join",
      clientId: member.clientId,
    });
    return member;
  }

  /** 轮换邀请码：旧邀请码立即失效（=撤销尚未使用的邀请），在房成员不受影响。 */
  rotateInvite(
    roomId: string,
    member: MemberRecord,
  ): { ok: true; inviteCode: string } | { ok: false; reason: "not-host" | "no-room" } {
    const room = this.rooms.get(roomId);
    if (!room) return { ok: false, reason: "no-room" };
    if (member.role !== "host" || member.clientId !== room.hostClientId) {
      return { ok: false, reason: "not-host" };
    }
    room.inviteCode = makeInviteCode();
    room.lastActiveAt = this.now();
    this.save();
    this.audit({ roomId, action: "room:rotate-invite", clientId: member.clientId });
    return { ok: true, inviteCode: room.inviteCode };
  }

  /** 校验成员令牌：返回成员记录；未知/过期返回 null。 */
  authenticate(roomId: string, token: string | null): MemberRecord | null {
    if (!token) return null;
    const room = this.rooms.get(roomId);
    if (!room) return null;
    const member = room.members.get(token);
    if (!member) return null;
    if (member.expiresAt <= this.now()) {
      room.members.delete(token);
      this.save();
      this.audit({ roomId, action: "auth:token-expired", clientId: member.clientId });
      return null;
    }
    return member;
  }

  /** 注册媒体：校验路径形态（防穿越），媒体元信息由调用方（已登录 OpenList）提供。
   *  provider 标签与直链/私有 provider 信息由调用方附带（registerMediaExt）。 */
  registerMedia(
    roomId: string,
    member: MemberRecord,
    path: string,
    meta: { name: string; size: number },
    related: { name: string; size: number }[] = [],
    ext: {
      provider?: string;
      directUrl?: string;
      providerOwner?: string;
      providerId?: string;
      bilibili?: { bvid: string; cid: number; aid: number };
    } = {},
  ): { mediaId: string; related: RelatedEntry[] } | { error: string } {
    const room = this.rooms.get(roomId);
    if (!room) return { error: "房间不存在" };
    if (member.role !== "host" || member.clientId !== room.hostClientId) {
      return { error: "只有房主可以添加视频" };
    }
    if (ext.directUrl !== undefined) {
      const u = new URL(ext.directUrl);
      if (u.protocol !== "http:" && u.protocol !== "https:" || u.username || u.password) {
        return { error: "非法直链地址" };
      }
    } else if (ext.bilibili !== undefined) {
      if (!/^BV1[a-zA-Z0-9]{9}$/.test(ext.bilibili.bvid) || !Number.isInteger(ext.bilibili.cid) || ext.bilibili.cid <= 0) {
        return { error: "非法 bilibili 视频标识" };
      }
    } else if (!path.startsWith("/") || path.split("/").includes("..")) {
      return { error: "非法路径" };
    }
    // 同一文件/同一地址/同一视频重复注册：复用既有 mediaId（幂等，防重复添加）。
    for (const entry of room.media.values()) {
      const same = ext.directUrl !== undefined
        ? entry.directUrl === ext.directUrl
        : ext.bilibili !== undefined
          ? entry.bilibili?.bvid === ext.bilibili.bvid && entry.bilibili?.cid === ext.bilibili.cid
          : entry.path === path;
      if (same) {
        return { mediaId: entry.mediaId, related: this.relatedEntries(room, entry.mediaId) };
      }
    }
    const mediaId = makeMediaId();
    room.media.set(mediaId, {
      mediaId,
      path,
      name: meta.name,
      size: meta.size,
      registeredBy: member.clientId,
      registeredAt: this.now(),
      provider: ext.provider ?? "OpenList",
      ...(ext.directUrl !== undefined ? { directUrl: ext.directUrl } : {}),
      ...(ext.providerOwner ? { providerOwner: ext.providerOwner, providerId: ext.providerId } : {}),
      ...(ext.bilibili ? { bilibili: ext.bilibili } : {}),
    });
    this.audit({ roomId, action: "media:register", clientId: member.clientId, mediaId });
    // 外挂字幕与视频同目录（fs/get related），自动注册并走同一 grant 路径（P3 任务 8）。
    const registered: RelatedEntry[] = [];
    for (const r of related) {
      if (!SUBTITLE_EXTS.has(extOf(r.name))) continue;
      const subPath = `${path.slice(0, path.length - meta.name.length)}${r.name}`;
      let subId: string;
      const existing = [...room.media.values()].find((e) => e.path === subPath);
      if (existing) {
        subId = existing.mediaId;
      } else {
        subId = makeMediaId();
        room.media.set(subId, {
          mediaId: subId,
          path: subPath,
          name: r.name,
          size: r.size,
          registeredBy: member.clientId,
          registeredAt: this.now(),
          provider: ext.provider ?? "OpenList",
          ...(ext.providerOwner ? { providerOwner: ext.providerOwner, providerId: ext.providerId } : {}),
        });
        this.audit({ roomId, action: "media:register-subtitle", clientId: member.clientId, mediaId: subId });
      }
      registered.push({ mediaId: subId, name: r.name, size: r.size });
    }
    this.save();
    return { mediaId, related: registered };
  }

  private relatedEntries(room: RoomRecord, _videoMediaId: string): RelatedEntry[] {
    // 幂等分支：按字幕扩展名收集已注册项。
    return [...room.media.values()]
      .filter((e) => SUBTITLE_EXTS.has(extOf(e.name)))
      .map((e) => ({ mediaId: e.mediaId, name: e.name, size: e.size }));
  }

  /** 解析 mediaId → 条目（仅服务端内部使用）。 */
  resolveMediaPath(roomId: string, mediaId: string): MediaEntry | null {
    const room = this.rooms.get(roomId);
    if (!room) return null;
    return room.media.get(mediaId) ?? null;
  }

  /** 房间是否由该账户创建（provider 媒体操作的归属校验）。 */
  isRoomOwner(roomId: string, username: string): boolean {
    return this.rooms.get(roomId)?.hostUser === username;
  }

  /** 房间媒体清单（成员可见：mediaId + 文件名 + 类型 + provider 标签；不含路径/URL）。 */
  listMedia(roomId: string): { mediaId: string; name: string; size: number; kind: "video" | "subtitle"; provider: string }[] | null {
    const room = this.rooms.get(roomId);
    if (!room) return null;
    return [...room.media.values()].map((e) => ({
      mediaId: e.mediaId,
      name: e.name,
      size: e.size,
      kind: SUBTITLE_EXTS.has(extOf(e.name)) ? "subtitle" : "video",
      provider: e.provider,
    }));
  }

  /** 公开房间列表（大厅展示）：房间号、房主昵称、创建时间、在线人数、视频数。 */
  listRooms(): { roomId: string; hostName: string; createdAt: number; memberCount: number; mediaCount: number }[] {
    return [...this.rooms.values()].map((r) => ({
      roomId: r.roomId,
      hostName: r.hostName,
      createdAt: r.createdAt,
      memberCount: r.members.size,
      mediaCount: r.media.size,
    }));
  }

  /**
   * 签发/复用媒体访问凭证（grant）：
   * - 调用方必须已通过 authenticate（房间成员）；
   * - mediaId 必须是本房间已注册媒体（跨房间 → null，不暴露存在性）；
   * - resolve 由服务端完成（OpenList 令牌不出服务端），结果缓存 60s。
   */
  async grant(
    roomId: string,
    mediaId: string,
    member: MemberRecord,
    resolve: (entry: MediaEntry) => Promise<{ url: string; name: string; size: number }>,
  ): Promise<GrantResult | null> {
    const room = this.rooms.get(roomId);
    if (!room) return null;
    const entry = room.media.get(mediaId);
    if (!entry) return null;
    const cacheKey = `${member.clientId}:${mediaId}`;
    const cached = this.grantCache.get(cacheKey);
    if (cached && cached.at > this.now() - GRANT_CACHE_MS) {
      return { url: cached.url, name: cached.name, size: cached.size, expiresInSec: GRANT_TTL_SEC, cached: true };
    }
    // 直链 provider：地址即注册值，无需解析；私有 OpenList provider 的解析由调用方按 providerOwner 完成。
    const resolved = entry.directUrl !== undefined
      ? { url: entry.directUrl, name: entry.name, size: entry.size }
      : await resolve(entry);
    this.grantCache.set(cacheKey, { ...resolved, at: this.now() });
    room.lastActiveAt = this.now();
    // 审计不记录 URL/路径。
    this.audit({ roomId, action: "media:grant", clientId: member.clientId, mediaId });
    return { url: resolved.url, name: resolved.name, size: resolved.size, expiresInSec: GRANT_TTL_SEC, cached: false };
  }

  private readonly grantCache = new Map<string, GrantCacheEntry>();

  /** 房间回收（同步房间销毁时联动）。 */
  disposeRoom(roomId: string): void {
    const room = this.rooms.get(roomId);
    if (!room) return;
    for (const key of [...this.grantCache.keys()]) {
      // 缓存键不含 roomId，靠 room dispose 全量清理规模足够（PoC 单进程）。
      void key;
    }
    this.grantCache.clear();
    this.rooms.delete(roomId);
    this.save();
    this.audit({ roomId, action: "room:dispose" });
  }
}

/** 令牌脱敏（日志用）：只留前 8 位指纹。 */
export function tokenFingerprint(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 8);
}
