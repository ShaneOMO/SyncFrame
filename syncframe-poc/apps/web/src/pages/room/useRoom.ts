/**
 * 房间页主 hook：会话引导 + SyncClient + 播放器引擎 + UI 状态。
 * 行为对齐旧 room-main.ts；URL 参数（room/name/mode/hardDriftMs）不变。
 */

import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { SyncClient } from "@syncframe/sync-protocol";
import { loadSession, clearSession, saveSession } from "@/session.ts";
import type { RoomSession } from "@/session.ts";
import { biliCredentialHeaders } from "@/bili-credential.ts";
import { loadUser } from "@/lib/user.ts";
import {
  createEngine,
  makeFlags,
  bindPlayerEvents,
  wireControlForwarding,
  wasmUrl,
  fmtTime,
  fmtTimeShort,
} from "@/pages/room/engine.ts";
import type { Engine, MoviElement, RoomMode, RoomRole, UiBridge } from "@/pages/room/engine.ts";

export interface PublicProvider {
  id: string;
  kind: "openlist" | "bilibili";
  label: string;
  baseUrl?: string;
  username?: string;
}

export interface MediaListItem {
  mediaId: string;
  name: string;
  size: number;
  kind: "video" | "subtitle";
  provider?: string;
}

export interface RosterMember {
  id: string;
  name: string;
  role: string;
}

export interface RoomUiState {
  statusText: string;
  statusWarn: boolean;
  mediaBadgeText: string;
  mediaBadgeState: "none" | "loading" | "ok" | "fail";
  routeBadge: { direct: boolean; reason?: string } | null;
  gesture: boolean;
  biliHint: boolean;
  clockFace: string;
  clockSub: string;
  connText: string;
  connOk: boolean;
  members: RosterMember[];
  statTotal: number;
  statHost: number;
  statGuest: number;
  hostAway: boolean;
  viewerText: string;
  viewerPaused: boolean;
  viewerTime: string;
  mediaItems: MediaListItem[];
  currentMediaId: string;
  providers: PublicProvider[];
}

export interface RoomActions {
  joinPlay(): void;
  deleteRoom(): Promise<void>;
  renameRoom(newName: string): Promise<boolean>;
  rotateInvite(): Promise<void>;
  copyInvite(): Promise<void>;
  registerMedia(payload: Record<string, unknown>): Promise<boolean>;
  pickBrowseFile(file: { path: string; name: string; size: number }, providerId: string): Promise<void>;
  hostLoad(mediaId: string, meta: { name: string; size?: number }): Promise<void>;
  verifySubtitleGrant(item: MediaListItem): Promise<void>;
  removeMediaItem(item: MediaListItem): Promise<void>;
  closeBiliHint(): void;
}

export type Bootstrap =
  | { phase: "loading" }
  | { phase: "redirect" }
  | {
      phase: "ready";
      session: RoomSession;
      roomId: string;
      name: string;
      mode: RoomMode;
      role: RoomRole;
      clientId: string;
      roomLabel: string;
      showBuiltInControls: boolean;
      isPlayer: boolean;
      invite: { available: boolean; link: string };
      ui: RoomUiState;
      actions: RoomActions;
      /** movi-player 元素挂载点（player 模式由组件用 callback ref 接入）。 */
      playerRef: RefObject<MoviElement | null>;
      /** 登录用户令牌（注册私有 provider 媒体时使用）。 */
      userToken: string | null;
    };

function buildLink(roomId: string, code: string): string {
  return `${location.origin}/lobby.html?room=${encodeURIComponent(roomId)}&key=${encodeURIComponent(code)}`;
}

/** 房主静默重建会话（成员令牌过期/丢失时凭 hostSecret 直接重新加入）。 */
async function rejoinAsHost(roomId: string, name: string, hostSecret: string): Promise<RoomSession | null> {
  try {
    const res = await fetch(`/api/rooms/${encodeURIComponent(roomId)}/join`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, hostSecret }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as Record<string, unknown>;
    if (typeof data.memberToken !== "string" || typeof data.clientId !== "string") return null;
    const sess: RoomSession = {
      roomId,
      memberToken: data.memberToken,
      clientId: String(data.clientId),
      role: "host",
      name,
      expiresAt: Number(data.expiresAt ?? 0),
      hostSecret,
      ...(typeof data.roomName === "string" && data.roomName ? { roomName: data.roomName } : {}),
    };
    saveSession(sess);
    return sess;
  } catch {
    return null;
  }
}

export function useRoom(): Bootstrap {
  const params = useMemo(() => new URLSearchParams(location.search), []);
  const roomId = (params.get("room") || "").slice(0, 64).toLowerCase();
  const name = (params.get("name") || `Guest-${Math.random().toString(36).slice(2, 6)}`).slice(0, 24);
  const mode: RoomMode = params.get("mode") === "clock" ? "clock" : "player";
  const hardDriftMs = Number(params.get("hardDriftMs") ?? 1000);

  const [session, setSession] = useState<RoomSession | null>(null);
  const [booted, setBooted] = useState(false);

  // ── 会话引导 ──────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      let sess = roomId ? loadSession(roomId) : null;
      if (roomId && !sess) {
        const hostSecret = sessionStorage.getItem(`syncframe-hostsecret-${roomId}`);
        if (hostSecret) sess = await rejoinAsHost(roomId, name, hostSecret);
      }
      if (cancelled) return;
      if (!roomId || !sess) {
        location.replace(`/lobby.html${roomId ? `?room=${encodeURIComponent(roomId)}&expired=1` : ""}`);
        return;
      }
      setSession(sess);
    })();
    return () => {
      cancelled = true;
    };
  }, [roomId, name]);

  // ── UI 状态 ───────────────────────────────────────────
  const [status, setStatus] = useState({ text: "初始化…", warn: false });
  const [mediaBadge, setMediaBadge] = useState<{ text: string; state: RoomUiState["mediaBadgeState"] }>({ text: "无媒体", state: "none" });
  const [routeBadge, setRouteBadge] = useState<{ direct: boolean; reason?: string } | null>(null);
  const [gesture, setGesture] = useState(false);
  const [biliHint, setBiliHint] = useState(false);
  const [tick, setTick] = useState(0);
  const [members, setMembers] = useState<RosterMember[]>([]);
  const [hostAway, setHostAway] = useState(false);
  const [mediaItems, setMediaItems] = useState<MediaListItem[]>([]);
  const [providers, setProviders] = useState<PublicProvider[]>([]);
  const [inviteCode, setInviteCode] = useState<string | null>(null);
  const [addMsg, setAddMsg] = useState<{ text: string; ok: boolean }>({ text: "", ok: false });

  // ── 引擎与客户端（会话就绪后一次性创建） ─────────────
  const flagsRef = useRef(makeFlags());
  const playerRef = useRef<MoviElement | null>(null);
  const clientRef = useRef<SyncClient | null>(null);
  const engineRef = useRef<Engine | null>(null);
  const sessionRef = useRef<RoomSession | null>(null);
  sessionRef.current = session;
  const localUserRef = useRef(loadUser());
  const uiBridgeRef = useRef<UiBridge | null>(null);
  const role = session?.role ?? "viewer";
  const memberToken = session?.memberToken ?? "";
  const clientId = session?.clientId ?? "";
  const roleRef = useRef(role);
  roleRef.current = role;
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const roomIdRef = useRef(roomId);
  roomIdRef.current = roomId;
  const memberTokenRef = useRef(memberToken);
  memberTokenRef.current = memberToken;

  const refreshMediaList = useCallback(async () => {
    if (modeRef.current !== "player") return;
    const client = clientRef.current;
    const sess = sessionRef.current;
    if (!client || !sess) return;
    try {
      const res = await fetch(`/api/rooms/${encodeURIComponent(roomIdRef.current)}/media`, {
        headers: { Authorization: `Bearer ${sess.memberToken}` },
      });
      if (!res.ok) return;
      const body = (await res.json()) as { media?: MediaListItem[] };
      setMediaItems(body.media ?? []);
    } catch {
      /* 清单刷新失败不阻塞主流程 */
    }
  }, []);

  const refreshMediaListRef = useRef(refreshMediaList);
  refreshMediaListRef.current = refreshMediaList;

  const remountPlayer = useCallback((): MoviElement => {
    const old = playerRef.current;
    const fresh = old!.cloneNode(false) as HTMLElement;
    old!.replaceWith(fresh);
    playerRef.current = fresh as unknown as MoviElement;
    const el = playerRef.current;
    el.setAttribute("wasmurl", wasmUrl);
    if (engineRef.current?.showBuiltInControls) el.setAttribute("controls", "");
    wireControlForwarding(el, flagsRef.current, engineRef.current?.showBuiltInControls ?? false, () => clientRef.current!);
    bindPlayerEvents(el, flagsRef.current, uiBridgeRef.current!);
    return el;
  }, []);

  useEffect(() => {
    if (!session || clientRef.current) return;
    const sess = session;
    const authHeaders = { Authorization: `Bearer ${sess.memberToken}` };
    const localUser = localUserRef.current;

    const ui: UiBridge = {
      setStatus: (text, warn = false) => setStatus({ text, warn }),
      setMediaBadge: (text, state) => setMediaBadge({ text, state }),
      setRouteBadge: (direct, reason) => setRouteBadge({ direct, reason }),
      clearRouteBadge: () => setRouteBadge(null),
      showGesture: () => setGesture(true),
      hideGesture: () => setGesture(false),
      showBiliHint: () => setBiliHint(true),
    };
    uiBridgeRef.current = ui;

    const engine = createEngine({
      roomId,
      mode,
      role: sess.role,
      memberToken: sess.memberToken,
      localUser,
      flags: flagsRef.current,
      getPlayer: () => playerRef.current,
      setPlayer: (el) => {
        playerRef.current = el;
      },
      remountPlayer,
      ui,
      getClient: () => clientRef.current!,
      hooks: { onMediaListChanged: () => void refreshMediaListRef.current() },
    });
    engineRef.current = engine;

    // 初始 movi-player 元素接线（player 模式）。
    if (mode === "player") {
      const el = playerRef.current;
      if (el) {
        el.setAttribute("wasmurl", wasmUrl);
        if (engine.showBuiltInControls) el.setAttribute("controls", "");
        wireControlForwarding(el, flagsRef.current, engine.showBuiltInControls, () => clientRef.current!);
        bindPlayerEvents(el, flagsRef.current, ui);
      }
    }

    const wsProto = location.protocol === "https:" ? "wss" : "ws";
    const wsUrl = new URL(`${wsProto}://${location.host}/ws`);
    wsUrl.searchParams.set("room", roomId);
    // 成员令牌经 WebSocket 子协议传递，URL 中不出现令牌。
    const client = new SyncClient({
      wsUrl: wsUrl.toString(),
      wsProtocols: ["syncframe.v1", `sf.token.${sess.memberToken}`],
      role: sess.role,
      media: engine.adapter,
      hardDriftMs,
      onStatus: (line) => setStatus({ text: line, warn: false }),
      onClosedByServer: (code, reason) => {
        if (code === 4003) {
          clearSession(roomId);
          setStatus({ text: `房间已被删除（${reason || "房间已被删除"}），即将返回大厅…`, warn: true });
          window.setTimeout(() => location.replace("/lobby.html"), 1500);
        }
      },
      onRoster: (msg) => {
        setHostAway(Boolean(msg.hostAway));
        let hostCount = 0;
        let guestCount = 0;
        const list: RosterMember[] = [];
        for (const m of msg.members) {
          if (m.role === "host") hostCount++;
          else guestCount++;
          list.push({ id: m.id, name: m.name, role: m.role });
        }
        setMembers(list);
        rosterStatsRef.current = { hostCount, guestCount };
      },
      onGestureNeeded: () => setGesture(true),
      onStateApplied: (state) => {
        if (mode === "player" && state.mediaId) {
          setMediaBadge({ text: `就绪: ${state.mediaMeta?.name ?? state.mediaId}`, state: "ok" });
        }
      },
    });
    clientRef.current = client;

    // 测试句柄：多浏览器同步测试（tests/sync/sync-browser-test.ts）从这里读取漂移等指标。
    (window as unknown as { __sync: unknown }).__sync = {
      sample: () => client.sample(),
      state: () => client.currentRoomState(),
      hostLoad: (p: string) => client.hostLoad(p, { name: p.split("/").pop() ?? p }),
      hostPlay: () => client.hostPlay(),
      hostPause: () => client.hostPause(),
      hostSeek: (ms: number) => client.hostSeek(ms),
      hostRate: (r: number) => client.hostRate(r),
      mediaTimeMs: () => engine.adapter.getTimeMs(),
    };

    client.connect();

    // 拉取本人 provider（填充添加影片下拉的 B 站 / OpenList 来源）。
    void (async () => {
      if (!localUser) return;
      try {
        const res = await fetch("/api/me", { headers: { Authorization: `Bearer ${localUser.token}` } });
        if (!res.ok) return;
        const body = (await res.json()) as { providers?: PublicProvider[] };
        setProviders(body.providers ?? []);
      } catch {
        /* provider 拉取失败不阻塞 */
      }
    })();

    // 邀请链接：仅创建者浏览器会话里有邀请码。
    const invite = sessionStorage.getItem(`syncframe-invite-${roomId}`);
    if (sess.role === "host") {
      if (invite) setInviteCode(invite);
    }

    const tickTimer = window.setInterval(() => setTick((t) => t + 1), 1000);
    const mediaTimer = window.setInterval(() => void refreshMediaListRef.current(), 15_000);
    void refreshMediaListRef.current();

    const onPageHide = (): void => client.disconnect();
    window.addEventListener("pagehide", onPageHide);

    setBooted(true);

    return () => {
      window.clearInterval(tickTimer);
      window.clearInterval(mediaTimer);
      window.removeEventListener("pagehide", onPageHide);
      client.disconnect();
      clientRef.current = null;
      engineRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session !== null]);

  // ── tick 派生 UI ──────────────────────────────────────
  const rosterStatsRef = useRef({ hostCount: 0, guestCount: 0 });
  const client = clientRef.current;
  const stats = client ? client.sample() : null;
  const state = client ? client.currentRoomState() : null;
  void tick;

  // ── 动作 ──────────────────────────────────────────────
  const actions: RoomActions = useMemo(
    () => ({
      joinPlay: () => {
        setGesture(false);
        void clientRef.current?.resumeFromGesture();
      },
      deleteRoom: async () => {
        const token = localUserRef.current?.token;
        if (!token) {
          setStatus({ text: "删除房间需要用创建房间的账户登录（右上角用户名处登录）", warn: true });
          return;
        }
        try {
          const res = await fetch(`/api/rooms/${encodeURIComponent(roomId)}`, {
            method: "DELETE",
            headers: { Authorization: `Bearer ${token}` },
          });
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          if (!res.ok) {
            setStatus({ text: `删除失败：${body.error ?? `HTTP ${res.status}`}`, warn: true });
            return;
          }
          clearSession(roomId);
          sessionStorage.removeItem(`syncframe-invite-${roomId}`);
          sessionStorage.removeItem(`syncframe-hostsecret-${roomId}`);
          location.replace("/lobby.html");
        } catch (err) {
          setStatus({ text: `删除失败：${err instanceof Error ? err.message : err}`, warn: true });
        }
      },
      renameRoom: async (newName) => {
        const sess = sessionRef.current;
        if (!sess) return false;
        try {
          const res = await fetch(`/api/rooms/${encodeURIComponent(roomId)}/rename`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${sess.memberToken}` },
            body: JSON.stringify({ name: newName }),
          });
          const body = (await res.json().catch(() => ({}))) as { roomName?: string; error?: string };
          if (!res.ok || !body.roomName) {
            setStatus({ text: `修改房间名失败 HTTP ${res.status}: ${body.error ?? "未知错误"}`, warn: true });
            return false;
          }
          const next = { ...sess, roomName: body.roomName };
          saveSession(next);
          setSession(next);
          setStatus({ text: `房间名已改为「${body.roomName}」`, warn: false });
          return true;
        } catch (err) {
          setStatus({ text: `修改房间名失败: ${err instanceof Error ? err.message : err}`, warn: true });
          return false;
        }
      },
      rotateInvite: async () => {
        const sess = sessionRef.current;
        if (!sess) return;
        try {
          const res = await fetch(`/api/rooms/${encodeURIComponent(roomId)}/invite/rotate`, {
            method: "POST",
            headers: { Authorization: `Bearer ${sess.memberToken}` },
          });
          const body = (await res.json().catch(() => ({}))) as { inviteCode?: string; error?: string };
          if (!res.ok || !body.inviteCode) {
            setStatus({ text: `重置链接失败 HTTP ${res.status}: ${body.error ?? "未知错误"}`, warn: true });
            return;
          }
          sessionStorage.setItem(`syncframe-invite-${roomId}`, body.inviteCode);
          setInviteCode(body.inviteCode);
          setStatus({ text: "邀请链接已重置，旧链接立即失效", warn: false });
        } catch (err) {
          setStatus({ text: `重置链接失败: ${err instanceof Error ? err.message : err}`, warn: true });
        }
      },
      copyInvite: async () => {
        if (!inviteCode) return;
        const link = buildLink(roomId, inviteCode);
        try {
          await navigator.clipboard.writeText(link);
          setStatus({ text: "邀请链接已复制到剪贴板，直接发给朋友即可进房", warn: false });
        } catch {
          setStatus({ text: "无法访问剪贴板，请手动复制链接", warn: true });
        }
      },
      registerMedia: async (payload) => {
        const sess = sessionRef.current;
        if (!sess) return false;
        setAddMsg({ text: "正在添加…", ok: false });
        try {
          const res = await fetch(`/api/rooms/${encodeURIComponent(roomId)}/media`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...{ Authorization: `Bearer ${sess.memberToken}` },
              ...(localUserRef.current ? { "X-User-Token": localUserRef.current.token } : {}),
              ...biliCredentialHeaders(),
            },
            body: JSON.stringify(payload),
          });
          const body = (await res.json().catch(() => ({}))) as { mediaId?: string; name?: string; error?: string };
          if (!res.ok || !body.mediaId) {
            setAddMsg({ text: `添加失败 HTTP ${res.status}: ${body.error ?? "未知错误"}`, ok: false });
            return false;
          }
          setAddMsg({ text: `已添加: ${body.name}（点播放列表条目开播）`, ok: true });
          await refreshMediaListRef.current();
          return true;
        } catch (err) {
          setAddMsg({ text: `添加失败: ${err instanceof Error ? err.message : err}`, ok: false });
          return false;
        }
      },
      pickBrowseFile: async (file, providerId) => {
        const sess = sessionRef.current;
        const client = clientRef.current;
        if (!sess || !client) return;
        setAddMsg({ text: `正在添加: ${file.name}…`, ok: false });
        try {
          const res = await fetch(`/api/rooms/${encodeURIComponent(roomId)}/media`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${sess.memberToken}`,
              ...(localUserRef.current ? { "X-User-Token": localUserRef.current.token } : {}),
            },
            body: JSON.stringify({ provider: providerId, path: file.path }),
          });
          const body = (await res.json().catch(() => ({}))) as {
            mediaId?: string;
            name?: string;
            size?: number;
            related?: { mediaId: string; name: string }[];
            error?: string;
          };
          if (!res.ok || !body.mediaId) {
            setAddMsg({ text: `添加视频失败 HTTP ${res.status}: ${body.error ?? "未知错误"}`, ok: false });
            return;
          }
          setAddMsg({ text: `已注册 ${body.name}（外挂字幕 ${body.related?.length ?? 0} 个）`, ok: true });
          await client.hostLoad(body.mediaId, { name: body.name ?? file.name, size: body.size ?? file.size });
          void refreshMediaListRef.current();
        } catch (err) {
          setAddMsg({ text: `添加视频失败: ${err instanceof Error ? err.message : err}`, ok: false });
        }
      },
      hostLoad: async (mediaId, meta) => {
        await clientRef.current?.hostLoad(mediaId, meta);
      },
      verifySubtitleGrant: async (item) => {
        const engine = engineRef.current;
        if (!engine) return;
        try {
          const g = await engine.fetchGrant(item.mediaId);
          const u = new URL(g.url, location.origin);
          setStatus({ text: `字幕授权 OK：${item.name}（${u.origin}${u.pathname.slice(0, 24)}…，凭证 ${g.expiresInSec / 60} 分钟）`, warn: false });
        } catch (err) {
          setStatus({ text: `字幕授权失败: ${err instanceof Error ? err.message : err}`, warn: true });
        }
      },
      removeMediaItem: async (item) => {
        const sess = sessionRef.current;
        if (!sess) return;
        try {
          const res = await fetch(
            `/api/rooms/${encodeURIComponent(roomId)}/media/${encodeURIComponent(item.mediaId)}`,
            { method: "DELETE", headers: { Authorization: `Bearer ${sess.memberToken}` } },
          );
          if (!res.ok) {
            const body = (await res.json().catch(() => null)) as { error?: string } | null;
            setStatus({ text: `删除失败: ${body?.error ?? res.status}`, warn: true });
            return;
          }
          setStatus({ text: `已删除: ${item.name}`, warn: false });
          await refreshMediaListRef.current();
        } catch (err) {
          setStatus({ text: `删除失败: ${err instanceof Error ? err.message : err}`, warn: true });
        }
      },
      closeBiliHint: () => setBiliHint(false),
    }),
    [roomId, inviteCode],
  );

  if (!session) return { phase: "loading" };

  const roomLabel = session.roomName ?? roomId;
  const connected = stats?.connected ?? false;
  const isHost = role === "host";
  const inviteLink = inviteCode ? buildLink(roomId, inviteCode) : "";

  const ui: RoomUiState = {
    statusText: status.text,
    statusWarn: status.warn,
    mediaBadgeText: mediaBadge.text,
    mediaBadgeState: mediaBadge.state,
    routeBadge,
    gesture,
    biliHint,
    clockFace: stats ? fmtTime(stats.clientTimeMs) : "00:00:00.0",
    clockSub:
      `${role === "host" ? "你是房主（权威）" : "跟随房主"} · ` +
      `${state?.paused === false ? "播放中" : "已暂停"} · ${state?.rate ?? 1}×`,
    connText: !connected
      ? "重连中…"
      : state
        ? role === "viewer" && state.paused
          ? "已暂停"
          : "已连接"
        : "已连接",
    connOk: connected,
    members,
    statTotal: rosterStatsRef.current.hostCount + rosterStatsRef.current.guestCount,
    statHost: rosterStatsRef.current.hostCount,
    statGuest: rosterStatsRef.current.guestCount,
    hostAway,
    viewerText: !connected
      ? "连接断开，重连中…"
      : hostAway
        ? "房主暂时离开，房间已暂停"
        : state?.paused === false
          ? `跟随房主 · 播放中 · ${state?.rate ?? 1}×`
          : "跟随房主 · 已暂停",
    viewerPaused: state?.paused !== false,
    viewerTime: stats ? fmtTimeShort(stats.clientTimeMs) : "00:00",
    mediaItems,
    currentMediaId: stats?.appliedMediaId ?? "",
    providers,
  };

  void booted;

  return {
    phase: "ready",
    session,
    roomId,
    name,
    mode,
    role,
    clientId,
    roomLabel,
    showBuiltInControls: mode === "player" && isHost,
    isPlayer: mode === "player",
    invite: { available: inviteCode !== null, link: inviteLink },
    ui,
    actions,
    playerRef,
    userToken: localUserRef.current?.token ?? null,
  };
}
