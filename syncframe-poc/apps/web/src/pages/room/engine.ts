/**
 * 房间页播放器/同步引擎（React 版，行为与旧 room-main.ts 对齐）。
 *
 * 设计：movi-player 与 SyncClient 都是非 React 的命令式对象，引擎保持模块级可变状态
 * （换源窗口、抑制窗口、恢复标志等），通过 UiBridge 把可见状态推给 React。
 * UI 只读快照、调动作，不直接碰播放器。
 */

import { SyncClient, VirtualMediaClock } from "@syncframe/sync-protocol";
import type { MediaAdapter } from "@syncframe/sync-protocol";
import "movi-player/element/slim";
import wasmUrl from "movi-player/movi.wasm?url";
import { biliCredentialHeaders, loadBiliSessdata } from "@/bili-credential.ts";
import { clearSession } from "@/session.ts";
import type { LocalUser } from "@/lib/user.ts";

export type RoomMode = "player" | "clock";
export type RoomRole = "host" | "viewer";

export interface RoomParams {
  roomId: string;
  name: string;
  mode: RoomMode;
  hardDriftMs: number;
}

export interface RoomIdentity {
  role: RoomRole;
  memberToken: string;
  clientId: string;
  roomName?: string;
}

export interface MoviElement extends HTMLElement {
  currentTime: number;
  duration: number;
  paused: boolean;
  playbackRate: number;
  seeking?: boolean;
  readyState?: number;
  play(): Promise<void>;
  pause(): void;
  load(): void;
  player: {
    getAudioTracks(): { id: number; label?: string }[];
    getSubtitleTracks(): { id: number; label?: string }[];
    selectAudioTrack(id: number): void;
    selectSubtitleTrack(id: number | null): void;
  };
}

/** React 可见状态桥：引擎把状态写进来，hook 里 setState 分发。 */
export interface UiBridge {
  setStatus(text: string, warn?: boolean): void;
  setMediaBadge(text: string, state: "none" | "loading" | "ok" | "fail"): void;
  setRouteBadge(direct: boolean, reason?: string): void;
  clearRouteBadge(): void;
  showGesture(): void;
  hideGesture(): void;
  showBiliHint(): void;
}

export interface EngineHooks {
  onMediaListChanged(): void;
}

// ── 引擎可变状态（原 room-main.ts 模块级变量的直译） ──────

interface EngineFlags {
  suppressPlaybackEventsUntil: number;
  playerMediaId: string;
  playerReady: boolean;
  hasStartedPlayback: boolean;
  recovering: boolean;
  preferProxy: boolean;
  currentSourceDirect: boolean;
  mediaBuffering: boolean;
  playerReloading: boolean;
  lastConfirmedPosMs: number;
  wantPlay: boolean;
}

export function makeFlags(): EngineFlags {
  return {
    suppressPlaybackEventsUntil: 0,
    playerMediaId: "",
    playerReady: false,
    hasStartedPlayback: false,
    recovering: false,
    preferProxy: false,
    currentSourceDirect: false,
    mediaBuffering: false,
    playerReloading: false,
    lastConfirmedPosMs: 0,
    wantPlay: false,
  };
}

// ── 时钟适配器 ────────────────────────────────────────────

export function makeClockAdapter(): { adapter: MediaAdapter; clock: VirtualMediaClock } {
  const clock = new VirtualMediaClock({});
  return {
    clock,
    adapter: {
      getTimeMs: () => clock.getCurrentTimeMs(),
      isPaused: () => clock.isPaused(),
      getRate: () => clock.getRate(),
      play: () => clock.play(),
      pause: () => clock.pause(),
      seek: (ms) => clock.seek(ms),
      setRate: (r) => clock.setRate(r),
      load: () => {
        clock.seek(0);
      },
      hasMedia: () => true,
    },
  };
}

// ── 播放器命令 ────────────────────────────────────────────

export function markPlaybackEventSuppressed(f: EngineFlags, ms = 800): void {
  f.suppressPlaybackEventsUntil = Date.now() + ms;
}

/** 把内置控件上的用户手势转发为房主同步命令（viewer 与 clock 模式不接线）。 */
export function wireControlForwarding(
  el: MoviElement,
  f: EngineFlags,
  showBuiltInControls: boolean,
  client: () => SyncClient,
): void {
  if (!showBuiltInControls) return;
  const fromUserGesture = (): boolean =>
    Date.now() >= f.suppressPlaybackEventsUntil
    && !f.playerReloading
    && f.playerReady
    && f.playerMediaId !== "";
  el.addEventListener("play", () => {
    if (f.playerReloading) return;
    f.wantPlay = true;
    if (fromUserGesture()) void client().hostPlay();
  });
  el.addEventListener("pause", () => {
    // 换源/重载自身会触发 pause：不代表用户意图，也不该改变"应播放"状态。
    if (f.playerReloading) return;
    f.wantPlay = false;
    if (!fromUserGesture()) return;
    // 换源/重载会把位置打回 0：这种"位置归零的暂停"不是用户操作。
    const posMs = (el.currentTime || 0) * 1000;
    if (posMs < 1000 && f.lastConfirmedPosMs > 5000) return;
    client().hostPause();
  });
  el.addEventListener("ratechange", () => {
    if (fromUserGesture()) client().hostRate(el.playbackRate || 1);
  });
  el.addEventListener("seeked", () => {
    if (fromUserGesture()) client().hostSeek((el.currentTime || 0) * 1000);
  });
}

/** 缓冲/就绪/位置跟踪：同步纠偏据此避让，换源后据此自动续播。 */
export function bindPlayerEvents(el: MoviElement, f: EngineFlags, ui: UiBridge): void {
  const buffering = (): void => {
    f.mediaBuffering = true;
  };
  el.addEventListener("waiting", buffering);
  el.addEventListener("stalled", buffering);
  el.addEventListener("seeking", buffering);
  el.addEventListener("timeupdate", () => {
    const ms = (el.currentTime || 0) * 1000;
    if (ms > 0) f.lastConfirmedPosMs = ms;
  });
  el.addEventListener("canplay", () => {
    f.mediaBuffering = false;
    if (f.wantPlay && el.paused) void el.play().catch(() => {});
  });
  el.addEventListener("playing", () => {
    f.mediaBuffering = false;
    f.playerReloading = false;
  });
  el.addEventListener("seeked", () => {
    f.mediaBuffering = false;
  });
}

function setPlayerSources(el: MoviElement, videoUrl: string, audioUrl?: string): void {
  el.removeAttribute("src");
  const nodes: HTMLSourceElement[] = [];
  const v = document.createElement("source");
  v.setAttribute("src", videoUrl);
  v.setAttribute("type", "video/mp4");
  nodes.push(v);
  if (audioUrl) {
    const a = document.createElement("source");
    a.setAttribute("src", audioUrl);
    a.setAttribute("type", "audio/mp4");
    a.setAttribute("kind", "audio");
    nodes.push(a);
  }
  // 一次性替换：元素用 MutationObserver 监听 <source> 变化并自动重载，分批增删会被当成多次变更。
  el.replaceChildren(...nodes);
}

async function probeDirect(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
    res.body?.cancel().catch(() => {});
    return res.ok;
  } catch {
    return false;
  }
}

export interface GrantResponse {
  url: string;
  name: string;
  size: number;
  expiresInSec: number;
  cached: boolean;
  audioUrl?: string;
  fallbackUrl?: string;
  fallbackAudioUrl?: string;
  direct?: boolean;
  anonymous?: boolean;
}

interface AppliedSource {
  url: string;
  audioUrl?: string;
  direct: boolean;
  reason?: string;
}

async function applyGrant(info: GrantResponse, f: EngineFlags): Promise<AppliedSource> {
  if (info.direct === undefined) {
    return { url: info.url, audioUrl: info.audioUrl, direct: true };
  }
  const proxy = {
    url: info.fallbackUrl ?? info.url,
    audioUrl: info.fallbackAudioUrl ?? info.audioUrl,
    direct: false,
  };
  if (info.direct && info.fallbackUrl && !f.preferProxy) {
    if (await probeDirect(info.url)) return { url: info.url, audioUrl: info.audioUrl, direct: true };
    f.preferProxy = true;
    return { ...proxy, reason: "直连探测失败（网络到 CDN 不通）" };
  }
  return { ...proxy, reason: info.direct ? "本次会话已回落代理" : "该视频的 CDN 节点要求 Referer，无法直连" };
}

export function fmtTime(ms: number): string {
  const s = ms / 1000;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  const tenth = Math.floor((s % 1) * 10);
  return `${h > 0 ? `${h}:` : ""}${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}.${tenth}`;
}

/** 进度条等紧凑场景用：整秒，不带十分位。 */
export function fmtTimeShort(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${h > 0 ? `${h}:` : ""}${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

// ── 引擎主体 ──────────────────────────────────────────────

export interface EngineContext {
  roomId: string;
  mode: RoomMode;
  role: RoomRole;
  memberToken: string;
  localUser: LocalUser | null;
  flags: EngineFlags;
  getPlayer: () => MoviElement | null;
  setPlayer: (el: MoviElement) => void;
  /** 换源/重载：整体重建 movi-player 元素并重新接线。 */
  remountPlayer: () => MoviElement;
  ui: UiBridge;
  getClient: () => SyncClient;
  hooks: EngineHooks;
}

export interface Engine {
  adapter: MediaAdapter;
  virtualClock: VirtualMediaClock | null;
  showBuiltInControls: boolean;
  fetchGrant: (mediaId: string) => Promise<GrantResponse>;
  recoverMedia: () => Promise<void>;
}

export function createEngine(ctx: EngineContext): Engine {
  const f = ctx.flags;
  const showBuiltInControls = ctx.mode === "player" && ctx.role === "host";
  let virtualClock: VirtualMediaClock | null = null;
  let biliHintShown = false;

  const showBiliCredentialHint = (): void => {
    if (biliHintShown || loadBiliSessdata()) return;
    biliHintShown = true;
    ctx.ui.showBiliHint();
  };

  const fetchGrant = async (mediaId: string): Promise<GrantResponse> => {
    const res = await fetch(`/api/rooms/${encodeURIComponent(ctx.roomId)}/media/${encodeURIComponent(mediaId)}/grant`, {
      headers: { Authorization: `Bearer ${ctx.memberToken}`, ...biliCredentialHeaders() },
    });
    if (!res.ok) {
      if (res.status === 401) {
        clearSession(ctx.roomId);
        location.replace(`/lobby.html?room=${encodeURIComponent(ctx.roomId)}&expired=1`);
      }
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(`媒体授权失败 HTTP ${res.status}: ${body.error ?? "未知错误"}`);
    }
    return (await res.json()) as GrantResponse;
  };

  /** 换源后恢复播放位置与播放状态。 */
  const resumeAfterReload = (posMs: number, shouldPlay: boolean): void => {
    const el = ctx.getPlayer();
    if (!el) return;
    f.wantPlay = shouldPlay;
    let done = false;
    const apply = (): void => {
      if (done) return;
      done = true;
      markPlaybackEventSuppressed(f, 1500);
      if (posMs > 0) el.currentTime = posMs / 1000;
      if (shouldPlay) {
        void el.play().catch(() => {
          ctx.ui.showGesture();
        });
      }
    };
    apply();
    el.addEventListener("loadedmetadata", apply, { once: true });
    el.addEventListener("canplay", apply, { once: true });
  };

  /** 冷启动换源：切换视频/错误恢复共用。 */
  const mountFreshPlayer = (): void => {
    const el = ctx.remountPlayer();
    // 播放错误（含签名 403/网络断）→ 用新凭证重建源并恢复到原位置（S12）。
    el.addEventListener("error", (ev) => {
      if (!f.playerReady || !f.playerMediaId || f.recovering) return;
      if (!f.hasStartedPlayback) {
        const detail = (ev as Event & { detail?: { message?: string } }).detail;
        const reason = detail?.message ?? (ev as ErrorEvent).message ?? "";
        const networkLike = /fetch|network|http|range|timeout|failed|超时/i.test(reason);
        if (networkLike) {
          ctx.ui.setMediaBadge("媒体加载失败", "fail");
          ctx.ui.setStatus(`媒体加载失败（网络/源站/跨域错误${reason ? `：${reason.slice(0, 120)}` : ""}），请重试或更换视频`, true);
        } else {
          ctx.ui.setMediaBadge("媒体解码失败", "fail");
          ctx.ui.setStatus("媒体解码失败（初始载入阶段，非签名问题），请更换视频", true);
        }
        return;
      }
      f.recovering = true;
      if (f.currentSourceDirect) {
        f.preferProxy = true;
        ctx.ui.setStatus("B 站直连失败，切换到服务端代理后重试…", true);
      } else {
        ctx.ui.setStatus("媒体加载/播放出错（可能是签名过期），正在用新凭证恢复…", true);
      }
      ctx.ui.setMediaBadge("媒体错误，正在恢复…", "fail");
      void recoverMedia().finally(() => {
        f.recovering = false;
      });
    });
    el.addEventListener("playing", () => {
      f.hasStartedPlayback = true;
    });
  };

  /** S12：签名/网络问题导致播放失败后，重新授权、重建源、跳回中断位置。 */
  const recoverMedia = async (): Promise<void> => {
    if (!f.playerMediaId) return;
    try {
      const el = ctx.getPlayer();
      const posMs = (el?.currentTime || 0) * 1000;
      const wasPaused = el?.paused ?? true;
      const info = await fetchGrant(f.playerMediaId);
      const src = await applyGrant(info, f);
      mountFreshPlayer();
      f.currentSourceDirect = src.direct;
      ctx.ui.setRouteBadge(src.direct, src.reason);
      f.playerReloading = true;
      const fresh = ctx.getPlayer()!;
      setPlayerSources(fresh, src.url, src.audioUrl);
      resumeAfterReload(posMs, !wasPaused);
      ctx.ui.setMediaBadge(`就绪: ${info.name}`, "ok");
      ctx.ui.setStatus(`已重新获取地址并恢复播放: ${info.name}（回到 ${fmtTime(posMs)}）`);
    } catch (err) {
      f.playerReloading = false;
      ctx.ui.setMediaBadge("媒体恢复失败", "fail");
      ctx.ui.setStatus(`媒体恢复失败: ${err instanceof Error ? err.message : err}`, true);
    }
  };

  let adapter: MediaAdapter;
  if (ctx.mode === "clock") {
    const made = makeClockAdapter();
    adapter = made.adapter;
    virtualClock = made.clock;
  } else {
    adapter = {
      getTimeMs: () => (ctx.getPlayer()?.currentTime || 0) * 1000,
      isPaused: () => ctx.getPlayer()?.paused ?? true,
      getRate: () => ctx.getPlayer()?.playbackRate || 1,
      play: () => {
        markPlaybackEventSuppressed(f, 500);
        f.wantPlay = true;
        const el = ctx.getPlayer();
        if (!el) return Promise.resolve();
        if ((el.readyState ?? 4) < 2) return Promise.resolve();
        return el.play();
      },
      pause: () => {
        markPlaybackEventSuppressed(f, 500);
        f.wantPlay = false;
        ctx.getPlayer()?.pause();
      },
      seek: (ms) => {
        markPlaybackEventSuppressed(f, 800);
        if (ctx.getPlayer()) ctx.getPlayer()!.currentTime = ms / 1000;
      },
      setRate: (r) => {
        markPlaybackEventSuppressed(f, 500);
        if (ctx.getPlayer()) ctx.getPlayer()!.playbackRate = r;
      },
      hasMedia: () => f.playerReady,
      isBuffering: () => f.mediaBuffering,
      load: async (mediaId) => {
        ctx.ui.setMediaBadge("加载中…", "loading");
        ctx.ui.clearRouteBadge();
        ctx.ui.setStatus("正在获取媒体访问凭证…");
        const info = await fetchGrant(mediaId);
        const src = await applyGrant(info, f);
        mountFreshPlayer();
        f.currentSourceDirect = src.direct;
        ctx.ui.setRouteBadge(src.direct, src.reason);
        f.playerReloading = true;
        setPlayerSources(ctx.getPlayer()!, src.url, src.audioUrl);
        f.playerMediaId = mediaId;
        f.playerReady = true;
        f.hasStartedPlayback = false;
        f.lastConfirmedPosMs = 0;
        f.wantPlay = false;
        ctx.ui.setMediaBadge(`就绪: ${info.name}`, "ok");
        ctx.ui.setStatus(
          info.size > 0
            ? `已载入: ${info.name}（${(info.size / 1024 / 1024).toFixed(1)} MiB）`
            : `已载入: ${info.name}`,
        );
        if (info.anonymous) showBiliCredentialHint();
        ctx.hooks.onMediaListChanged();
      },
    };
  }

  return { adapter, virtualClock, showBuiltInControls, fetchGrant, recoverMedia };
}

export { wasmUrl, setPlayerSources };
