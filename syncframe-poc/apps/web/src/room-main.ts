/**
 * P3 房间页主逻辑：房间鉴权会话 + 受控媒体链路 + OpenList 选片。
 *
 * 会话：成员令牌从 sessionStorage 恢复（大厅页写入）；缺失/过期 → 回大厅重新加入。
 * 媒体：WebSocket 只传播不透明 mediaId；客户端用成员令牌向
 *   GET /api/rooms/:id/media/:mediaId/grant 换取短期媒体地址（10 分钟提示期，服务端缓存 60s）。
 *
 * 两种媒体模式：
 * - player（默认）：真实 Movi Player + grant 媒体链路（需 OpenList 配置）；
 * - clock：VirtualMediaClock 纯时钟，同步行为的可重复演示/测试载体（?mode=clock）。
 *
 * URL 参数：room / name / mode=player|clock / hardDriftMs
 */

import { SyncClient, VirtualMediaClock } from "@syncframe/sync-protocol";
import type { MediaAdapter } from "@syncframe/sync-protocol";
import "movi-player/element/slim";
import wasmUrl from "movi-player/movi.wasm?url";
import { CountingHttpSource } from "./counting-source.ts";
import { initBrowsePanel } from "./browse.ts";
import { loadSession, clearSession } from "./session.ts";
import { icon } from "./icons.ts";

const params = new URLSearchParams(location.search);
const roomId = (params.get("room") || "").slice(0, 64);
const name = (params.get("name") || `Guest-${Math.random().toString(36).slice(2, 6)}`).slice(0, 24);
const mode = params.get("mode") === "clock" ? "clock" : "player";
const hardDriftMs = Number(params.get("hardDriftMs") ?? 1000);

// ── P3 房间鉴权：无有效会话 → 回大厅（携带房间号便于重新加入）────────────────

const session = roomId ? loadSession(roomId) : null;
if (!roomId || !session) {
  location.replace(`/lobby.html${roomId ? `?room=${encodeURIComponent(roomId)}&expired=1` : ""}`);
  throw new Error("等待重定向到大厅");
}
const role = session.role;
const memberToken = session.memberToken;
const authHeaders = { Authorization: `Bearer ${memberToken}` };

// 每房间稳定身份：来自会话（大厅 join 时服务端签发/复用）。
const clientId = session.clientId;

const $ = <T extends HTMLElement>(sel: string): T => {
  const el = document.querySelector<T>(sel);
  if (!el) throw new Error(`缺少元素 ${sel}`);
  return el;
};

interface MoviElement extends HTMLElement {
  sourceAdapter: unknown;
  currentTime: number;
  duration: number;
  paused: boolean;
  playbackRate: number;
  play(): Promise<void>;
  load(): void;
  player: {
    getAudioTracks(): { id: number; label?: string }[];
    getSubtitleTracks(): { id: number; label?: string }[];
    selectAudioTrack(id: number): void;
    selectSubtitleTrack(id: number | null): void;
  };
}

// ── 媒体状态徽标（加载/缓冲/同步/手势/失败/重连 的可见状态）──────────────────

const mediaBadge = $("#mediaBadge");
function setMediaBadge(text: string, state: "none" | "loading" | "ok" | "fail" = "none"): void {
  mediaBadge.textContent = text;
  mediaBadge.className =
    "badge " + (state === "ok" ? "media-ok" : state === "loading" ? "media-loading" : state === "fail" ? "media-fail" : "");
}

// ── 媒体适配器 ────────────────────────────────────────────

function makeClockAdapter(): { adapter: MediaAdapter; clock: VirtualMediaClock } {
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

const playerRef: { current: MoviElement } = {
  current: document.querySelector("movi-player") as unknown as MoviElement,
};
playerRef.current.setAttribute("wasmurl", wasmUrl);

interface GrantResponse {
  url: string;
  name: string;
  size: number;
  expiresInSec: number;
  cached: boolean;
}

let playerSource: CountingHttpSource | null = null;
let playerMediaId = "";
let playerReady = false;
let grantExpiresAt = 0;
/** 至少成功开始播放过一次：区分「真实签名/网络错误」与「初始解码失败（如 stub 假数据）」。 */
let hasStartedPlayback = false;
/** 恢复中标志：防止 error 事件循环触发 recoverMedia。 */
let recovering = false;

/** P3 受控媒体链路：mediaId →（成员令牌）→ 短期媒体地址。 */
async function fetchGrant(mediaId: string): Promise<GrantResponse> {
  const res = await fetch(`/api/rooms/${encodeURIComponent(roomId)}/media/${encodeURIComponent(mediaId)}/grant`, {
    headers: authHeaders,
  });
  if (!res.ok) {
    if (res.status === 401) {
      // 成员凭证过期：清理会话并回大厅。
      clearSession(roomId);
      location.replace(`/lobby.html?room=${encodeURIComponent(roomId)}&expired=1`);
    }
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(`媒体授权失败 HTTP ${res.status}: ${body.error ?? "未知错误"}`);
  }
  return (await res.json()) as GrantResponse;
}

/** 冷启动换源：换片/错误恢复共用。返回新挂载的 source（调用方负责设置 sourceAdapter）。 */
function mountFreshPlayer(): void {
  const old = playerRef.current;
  const fresh = old.cloneNode(false) as HTMLElement;
  old.replaceWith(fresh);
  playerRef.current = fresh as unknown as MoviElement;
  playerRef.current.setAttribute("wasmurl", wasmUrl);
  wireTrackSelects();
  // 播放错误（含签名 403/网络断）→ 用新凭证重建源并恢复到原位置（S12）。
  // 仅在已就绪且开始播放过才自动恢复；初始加载阶段的解码错误（如 stub 假数据）只提示不恢复。
  playerRef.current.addEventListener("error", () => {
    if (!playerReady || !playerMediaId || recovering) return;
    if (!hasStartedPlayback) {
      setMediaBadge("媒体解码失败", "fail");
      setStatus("媒体解码失败（初始载入阶段，非签名问题），请更换片源", true);
      return;
    }
    recovering = true;
    setMediaBadge("媒体错误，正在恢复…", "fail");
    setStatus("媒体加载/播放出错（可能是签名过期），正在用新凭证恢复…", true);
    void recoverMedia().finally(() => {
      recovering = false;
    });
  });
  // 首次真实开始播放后，启用错误自动恢复门槛。
  playerRef.current.addEventListener("playing", () => {
    hasStartedPlayback = true;
  }, { once: false });
}

/** S12：签名/网络问题导致播放失败后，重新授权、重建源、跳回中断位置。 */
async function recoverMedia(): Promise<void> {
  if (!playerMediaId) return;
  try {
    const posMs = (playerRef.current.currentTime || 0) * 1000;
    const wasPaused = playerRef.current.paused;
    const info = await fetchGrant(playerMediaId);
    grantExpiresAt = Date.now() + info.expiresInSec * 1000;
    mountFreshPlayer();
    playerSource = new CountingHttpSource(info.url, info.size);
    playerRef.current.sourceAdapter = playerSource as never;
    playerRef.current.currentTime = posMs / 1000;
    setMediaBadge(`就绪: ${info.name}`, "ok");
    setStatus(`已用新凭证恢复: ${info.name}（回到 ${fmtTime(posMs)}）`);
    if (!wasPaused) {
      void playerRef.current.play().catch(() => {
        gestureOverlay.classList.add("show");
      });
    }
  } catch (err) {
    setMediaBadge("媒体恢复失败", "fail");
    setStatus(`媒体恢复失败: ${err instanceof Error ? err.message : err}`, true);
  }
}

/** S12 主动续签：凭证剩余不足 2 分钟时静默换新 URL（同源同字节，Range 拉流无感）。 */
async function refreshGrantIfNeeded(): Promise<void> {
  if (!playerReady || !playerMediaId || !playerSource) return;
  if (grantExpiresAt - Date.now() > 120_000) return;
  try {
    const info = await fetchGrant(playerMediaId);
    grantExpiresAt = Date.now() + info.expiresInSec * 1000;
    playerSource.url = info.url;
  } catch (err) {
    setStatus(`媒体凭证续签失败: ${err instanceof Error ? err.message : err}`, true);
  }
}

function makePlayerAdapter(): MediaAdapter {
  return {
    getTimeMs: () => (playerRef.current.currentTime || 0) * 1000,
    isPaused: () => playerRef.current.paused,
    getRate: () => playerRef.current.playbackRate || 1,
    play: () => playerRef.current.play(),
    pause: () => playerRef.current.pause(),
    seek: (ms) => {
      playerRef.current.currentTime = ms / 1000;
    },
    setRate: (r) => {
      playerRef.current.playbackRate = r;
    },
    hasMedia: () => playerReady,
    load: async (mediaId) => {
      setMediaBadge("加载中…", "loading");
      setStatus("正在获取媒体访问凭证…");
      const info = await fetchGrant(mediaId);
      grantExpiresAt = Date.now() + info.expiresInSec * 1000;
      mountFreshPlayer();
      playerSource = new CountingHttpSource(info.url, info.size);
      playerRef.current.sourceAdapter = playerSource as never;
      playerMediaId = mediaId;
      playerReady = true;
      hasStartedPlayback = false;
      setMediaBadge(`就绪: ${info.name}`, "ok");
      setStatus(`已载入: ${info.name}（${(info.size / 1024 / 1024).toFixed(1)} MiB，凭证 ${Math.round(info.expiresInSec / 60)} 分钟）`);
      refreshMediaList();
    },
  };
}

// ── UI 引用 ───────────────────────────────────────────────

const statusEl = $("#status");
const hudEl = $("#hud");
const clockModeEl = $("#clockMode");
const playerWrapEl = $("#playerWrap");
const gestureOverlay = $("#gestureOverlay");
const hostControlsEl = $("#hostControls");

function setStatus(text: string, warn = false): void {
  statusEl.textContent = text;
  statusEl.className = warn ? "warn" : "";
}

function fmtTime(ms: number): string {
  const s = ms / 1000;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  const tenth = Math.floor((s % 1) * 10);
  return `${h > 0 ? `${h}:` : ""}${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}.${tenth}`;
}

/** 进度条等紧凑场景用：整秒，不带十分位。 */
function fmtTimeShort(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${h > 0 ? `${h}:` : ""}${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

// ── 初始化 ────────────────────────────────────────────────

$("#roomBadge").innerHTML = `房间 <b>${roomId}</b>${mode === "clock" ? " · clock" : ""}`;
const roleBadge = $("#roleBadge");
roleBadge.textContent = role === "host" ? "房主" : "观众";
roleBadge.className = `badge ${role}`;

let adapter: MediaAdapter;
let virtualClock: VirtualMediaClock | null = null;
if (mode === "clock") {
  const made = makeClockAdapter();
  adapter = made.adapter;
  virtualClock = made.clock;
  playerWrapEl.hidden = true;
} else {
  clockModeEl.hidden = true;
  playerWrapEl.hidden = false;
  adapter = makePlayerAdapter();
}

// 观众状态条
const viewerBarEl = $("#viewerBar") as HTMLElement;
const viewerBarText = $("#viewerBarText");
const viewerBarTime = $("#viewerBarTime");
if (role !== "host") {
  viewerBarEl.hidden = false;
  viewerBarText.textContent = "跟随房主";
}

// 进度条：房主可拖（拖动中实时预览，松手才跳转）；观众只读
const seekBarEl = $("#seekBar") as HTMLInputElement;
seekBarEl.disabled = role !== "host";
seekBarEl.addEventListener("input", () => {
  $("#seekLabel").textContent = fmtTimeShort(Number(seekBarEl.value));
});

// 邀请行：房主默认展开，可用顶栏按钮折叠
const inviteRowEl = $("#inviteRow") as HTMLElement;
$("#inviteToggle").addEventListener("click", () => inviteRowEl.classList.toggle("show"));

if (role === "host") {
  hostControlsEl.hidden = false;
  $("#manualLoadRow").hidden = mode !== "clock";
  // 邀请链接展示（仅创建者浏览器会话里有邀请码；链接 = 房间号 + 邀请码）
  const invite = sessionStorage.getItem(`syncframe-invite-${roomId}`);
  if (invite) {
    inviteRowEl.classList.add("show");
    let currentInvite = invite;
    const inviteLinkEl = $("#inviteLink") as HTMLInputElement;
    const buildLink = (code: string): string =>
      `${location.origin}/lobby.html?room=${encodeURIComponent(roomId)}&key=${encodeURIComponent(code)}`;
    inviteLinkEl.value = buildLink(currentInvite);
    $("#copyInvite").addEventListener("click", async () => {
      const link = buildLink(currentInvite);
      try {
        await navigator.clipboard.writeText(link);
        setStatus("邀请链接已复制到剪贴板，直接发给朋友即可进房");
      } catch {
        inviteLinkEl.select();
        setStatus("无法访问剪贴板，链接已全选，请手动复制", true);
      }
    });
    $("#rotateInvite").addEventListener("click", () => {
      void (async () => {
        try {
          const res = await fetch(`/api/rooms/${encodeURIComponent(roomId)}/invite/rotate`, {
            method: "POST",
            headers: authHeaders,
          });
          const body = (await res.json().catch(() => ({}))) as { inviteCode?: string; error?: string };
          if (!res.ok || !body.inviteCode) {
            setStatus(`重置链接失败 HTTP ${res.status}: ${body.error ?? "未知错误"}`, true);
            return;
          }
          sessionStorage.setItem(`syncframe-invite-${roomId}`, body.inviteCode);
          currentInvite = body.inviteCode;
          inviteLinkEl.value = buildLink(body.inviteCode);
          setStatus("邀请链接已重置，旧链接立即失效");
        } catch (err) {
          setStatus(`重置链接失败: ${err instanceof Error ? err.message : err}`, true);
        }
      })();
    });
  }
}

const wsProto = location.protocol === "https:" ? "wss" : "ws";
const wsUrl = new URL(`${wsProto}://${location.host}/ws`);
wsUrl.searchParams.set("room", roomId);
wsUrl.searchParams.set("token", memberToken);

const samples: Record<string, unknown>[] = [];

const client = new SyncClient({
  wsUrl: wsUrl.toString(),
  role,
  media: adapter,
  hardDriftMs,
  onStatus: (line) => setStatus(line),
  onRoster: (msg) => {
    viewerBarText.dataset.hostAway = msg.hostAway ? "1" : "0";
    const membersEl = $("#members");
    membersEl.textContent = "";
    for (const m of msg.members) {
      const chip = document.createElement("span");
      chip.className = "chip" + (m.id === clientId ? " me" : "");
      const crown = m.role === "host" ? `<span class="crown">${icon("crown", "ic")}</span>` : "";
      chip.innerHTML = `${crown}<span></span>`;
      chip.querySelector("span")!.textContent = m.name;
      membersEl.appendChild(chip);
    }
  },
  onGestureNeeded: () => gestureOverlay.classList.add("show"),
  onStateApplied: (state) => {
    if (mode === "player" && state.mediaId) setMediaBadge(`就绪: ${state.mediaMeta?.name ?? state.mediaId}`, "ok");
  },
});

$("#joinPlay").addEventListener("click", () => {
  gestureOverlay.classList.remove("show");
  void client.resumeFromGesture();
});

// ── 房主控制 ──────────────────────────────────────────────

// clock 模式：直接载入测试 mediaId（无 OpenList 依赖）
$("#loadBtn").addEventListener("click", () => {
  const path = ($("#mediaPath") as HTMLInputElement).value.trim();
  if (!path) {
    setStatus("请填写 mediaId", true);
    return;
  }
  void client.hostLoad(path, { name: path.split("/").pop() ?? path });
});

// player 模式：OpenList 选片 → 注册 mediaId → 广播 load
if (mode === "player" && role === "host") {
  $("#browseCard").hidden = false;
  initBrowsePanel({
    roomId,
    getToken: () => memberToken,
    onStatus: (line, warn) => setStatus(line, warn),
    onPick: (file) => {
      void (async () => {
        setStatus(`正在注册片源: ${file.name}…`);
        try {
          const res = await fetch(`/api/rooms/${encodeURIComponent(roomId)}/media`, {
            method: "POST",
            headers: { "Content-Type": "application/json", ...authHeaders },
            body: JSON.stringify({ path: file.path }),
          });
          const body = (await res.json().catch(() => ({}))) as {
            mediaId?: string;
            name?: string;
            size?: number;
            related?: { mediaId: string; name: string }[];
            error?: string;
          };
          if (!res.ok || !body.mediaId) {
            setStatus(`注册片源失败 HTTP ${res.status}: ${body.error ?? "未知错误"}`, true);
            return;
          }
          setStatus(
            `已注册 ${body.name}（外挂字幕 ${body.related?.length ?? 0} 个）`,
          );
          await client.hostLoad(body.mediaId, { name: body.name ?? file.name, size: body.size ?? file.size });
          refreshMediaList();
        } catch (err) {
          setStatus(`注册片源失败: ${err instanceof Error ? err.message : err}`, true);
        }
      })();
    },
  });
}

$("#playBtn").addEventListener("click", () => void client.hostPlay());
$("#pauseBtn").addEventListener("click", () => client.hostPause());
$("#back10").addEventListener("click", () => {
  client.hostSeek(Math.max(0, adapter.getTimeMs() - 10_000));
});
$("#fwd10").addEventListener("click", () => {
  client.hostSeek(adapter.getTimeMs() + 10_000);
});
$("#rateSel").addEventListener("change", (e) => {
  client.hostRate(Number((e.target as HTMLSelectElement).value));
});
seekBarEl.addEventListener("change", () => client.hostSeek(Number(seekBarEl.value)));

// 轨道选择：仅本地，永不同步（S11）。
function wireTrackSelects(): void {
  const el = playerRef.current;
  const audioSel = $("#audioTrackSel") as HTMLSelectElement;
  const subSel = $("#subTrackSel") as HTMLSelectElement;
  el.addEventListener("trackschange", () => {
    try {
      audioSel.textContent = "";
      for (const t of el.player.getAudioTracks()) {
        const o = document.createElement("option");
        o.value = String(t.id);
        o.textContent = t.label ?? `音轨 ${t.id}`;
        audioSel.appendChild(o);
      }
      subSel.textContent = "";
      const off = document.createElement("option");
      off.value = "";
      off.textContent = "字幕关";
      subSel.appendChild(off);
      for (const t of el.player.getSubtitleTracks()) {
        const o = document.createElement("option");
        o.value = String(t.id);
        o.textContent = t.label ?? `字幕 ${t.id}`;
        subSel.appendChild(o);
      }
    } catch {
      /* 轨道列表未就绪 */
    }
  });
  audioSel.addEventListener("change", () => {
    try {
      el.player.selectAudioTrack(Number(audioSel.value));
    } catch {
      /* gone mid-swap */
    }
  });
  subSel.addEventListener("change", () => {
    try {
      el.player.selectSubtitleTrack(subSel.value === "" ? null : Number(subSel.value));
    } catch {
      /* gone mid-swap */
    }
  });
}
if (mode === "player") wireTrackSelects();

// ── 房间片源清单（mediaId 不透明映射 + 字幕授权验证入口）────────────────────

interface MediaListItem {
  mediaId: string;
  name: string;
  size: number;
  kind: "video" | "subtitle";
}

async function refreshMediaList(): Promise<void> {
  if (mode !== "player") return;
  try {
    const res = await fetch(`/api/rooms/${encodeURIComponent(roomId)}/media`, { headers: authHeaders });
    if (!res.ok) return;
    const body = (await res.json()) as { media?: MediaListItem[] };
    const listEl = $("#mediaList");
    listEl.textContent = "";
    const items = body.media ?? [];
    if (items.length === 0) {
      const d = document.createElement("div");
      d.className = "browse-empty";
      d.textContent = role === "host" ? "（尚未注册片源，用上方选片面板添加）" : "（等待房主选片）";
      listEl.appendChild(d);
      return;
    }
    for (const item of items) {
      const row = document.createElement("div");
      row.className = "browse-row";
      const kind = document.createElement("span");
      kind.className = "media-kind";
      kind.textContent = item.kind === "subtitle" ? "字幕" : "视频";
      const nameEl = document.createElement("span");
      nameEl.className = "browse-name";
      nameEl.textContent = item.name;
      const idEl = document.createElement("span");
      idEl.className = "browse-size";
      idEl.textContent = item.mediaId;
      row.append(kind, nameEl, idEl);
      if (item.kind === "subtitle") {
        // P3 任务 8：外挂字幕走与视频完全一致的授权路径，点击验证 grant 可达。
        const btn = document.createElement("button");
        btn.className = "browse-pick";
        btn.textContent = "验证授权";
        btn.addEventListener("click", () => {
          void (async () => {
            try {
              const g = await fetchGrant(item.mediaId);
              const u = new URL(g.url);
              setStatus(`字幕授权 OK：${item.name}（${u.origin}${u.pathname.slice(0, 24)}…，凭证 ${g.expiresInSec / 60} 分钟）`);
            } catch (err) {
              setStatus(`字幕授权失败: ${err instanceof Error ? err.message : err}`, true);
            }
          })();
        });
        row.appendChild(btn);
      }
      listEl.appendChild(row);
    }
  } catch {
    /* 清单刷新失败不阻塞主流程 */
  }
}

// ── HUD / 采样 ────────────────────────────────────────────

function tick(): void {
  const stats = client.sample();
  const state = client.currentRoomState();

  if (virtualClock) {
    $("#clockFace").textContent = fmtTime(stats.clientTimeMs);
    $("#clockSub").textContent =
      `${stats.role === "host" ? "你是房主（权威）" : "跟随房主"} · ` +
      `${state?.paused === false ? "播放中" : "已暂停"} · ${state?.rate ?? 1}×`;
  } else {
    seekBarEl.max = String(
      Number.isFinite(playerRef.current.duration) ? playerRef.current.duration * 1000 : 7_200_000,
    );
    const dragging = seekBarEl.matches(":active") || document.activeElement === seekBarEl;
    if (role === "host" && !dragging) {
      seekBarEl.value = String(stats.clientTimeMs);
    }
    const durationMs = Number(seekBarEl.max);
    $("#seekLabel").textContent = `${fmtTimeShort(stats.clientTimeMs)} / ${fmtTimeShort(durationMs)}`;
  }

  // 连接徽标 + 观众状态条
  const connBadge = $("#connBadge");
  connBadge.textContent = !stats.connected ? "重连中…" : state ? (stats.role === "viewer" && state.paused ? "已暂停" : "已连接") : "已连接";
  connBadge.className = `badge conn${stats.connected ? "" : " off"}`;
  if (role !== "host") {
    const hostAway = viewerBarText.dataset.hostAway === "1";
    viewerBarEl.classList.toggle("paused", state?.paused !== false);
    viewerBarText.textContent =
      !stats.connected ? "连接断开，重连中…" :
      hostAway ? "房主暂时离开，房间已暂停" :
      state?.paused === false ? `跟随房主 · 播放中 · ${state?.rate ?? 1}×` : "跟随房主 · 已暂停";
    viewerBarTime.textContent = fmtTimeShort(stats.clientTimeMs);
  }

  const grantLeft = grantExpiresAt > 0 ? Math.max(0, Math.round((grantExpiresAt - Date.now()) / 1000)) : null;
  hudEl.textContent =
    `角色: ${stats.role}${stats.connected ? "" : "（未连接/重连中）"}\n` +
    `revision: ${stats.revision}  mediaRevision: ${stats.mediaRevision}\n` +
    `媒体: ${stats.appliedMediaId || "（无）"}${grantLeft === null ? "" : `\n媒体凭证剩余: ${grantLeft}s`}\n` +
    `时钟偏移: ${stats.clockOffsetMs} ms   最佳RTT: ${stats.bestRttMs} ms\n` +
    `本地位置: ${fmtTime(stats.clientTimeMs)}\n` +
    `目标位置: ${stats.expectedTargetMs === null ? "-" : fmtTime(stats.expectedTargetMs)}\n` +
    `漂移: ${stats.driftMs === null ? "-" : `${stats.driftMs} ms`}\n` +
    `硬纠正: ${stats.corrections} 次   强制对齐: ${stats.alignments} 次\n` +
    `重连: ${stats.reconnects} 次   丢弃乱序状态: ${stats.droppedStates}`;

  // 计划 §7.2 同步采样字段
  samples.push({
    ts: Date.now(),
    roomId,
    clientId,
    role: stats.role,
    revision: stats.revision,
    mediaRevision: stats.mediaRevision,
    rtt: stats.bestRttMs,
    estimatedClockOffset: stats.clockOffsetMs,
    action: state?.action ?? null,
    hostCurrentTime: stats.expectedTargetMs,
    clientCurrentTime: stats.clientTimeMs,
    drift: stats.driftMs,
    buffering: mode === "player" ? playerRef.current.paused : false,
    seeking: virtualClock ? virtualClock.isSeeking() : false,
    playbackRate: state?.rate ?? 1,
    reconnectCount: stats.reconnects,
    correctionCount: stats.corrections + stats.alignments,
  });
  if (samples.length > 3600) samples.shift();
  $("#sampleCount").textContent = `已采样 ${samples.length} 条`;
}

$("#exportBtn").addEventListener("click", () => {
  const blob = new Blob([JSON.stringify(report(), null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `sync-${roomId}-${clientId}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
});

$("#uploadBtn").addEventListener("click", async () => {
  try {
    const res = await fetch("/api/sync-report", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(report()),
    });
    const body = (await res.json()) as { saved?: string; error?: string };
    setStatus(res.ok ? `已上传: ${body.saved}` : `上传失败: ${body.error ?? res.status}`, !res.ok);
  } catch (err) {
    setStatus(`上传失败: ${err instanceof Error ? err.message : err}`, true);
  }
});

function report(): Record<string, unknown> {
  return {
    roomId,
    clientId,
    role,
    mode,
    exportedAt: new Date().toISOString(),
    stats: client.sample(),
    samples,
  };
}

// ── 启动 ──────────────────────────────────────────────────

// 测试句柄：多浏览器同步测试（tests/sync/sync-browser-test.ts）从这里读取漂移等指标。
(window as unknown as { __sync: unknown }).__sync = {
  sample: () => client.sample(),
  state: () => client.currentRoomState(),
  hostLoad: (p: string) => client.hostLoad(p, { name: p.split("/").pop() ?? p }),
  hostPlay: () => client.hostPlay(),
  hostPause: () => client.hostPause(),
  hostSeek: (ms: number) => client.hostSeek(ms),
  hostRate: (r: number) => client.hostRate(r),
  mediaTimeMs: () => adapter.getTimeMs(),
};

client.connect();
window.addEventListener("pagehide", () => client.disconnect());
window.setInterval(tick, 1000);
if (mode === "player") window.setInterval(() => void refreshGrantIfNeeded(), 20_000);
void refreshMediaList();
void tick();
