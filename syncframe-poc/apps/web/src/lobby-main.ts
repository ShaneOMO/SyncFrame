/**
 * 大厅页：
 * - 房间列表：GET /api/rooms 展示本实例同步房间（房间号/房主/人数/视频数），行右侧「直接加入」
 *   弹出加入弹窗并预填房间号；
 * - 顶部「创建房间 / 加入房间」按钮：分别弹出创建 / 加入设置弹窗；
 * - 右上角用户按钮：未登录 → 登录弹窗（仅登录，注册已关闭，账户由管理员创建）；
 *   已登录 → 跳转 /settings.html 账户设置页（provider 管理 / 管理员用户管理）；
 * - 管理员在顶栏额外拥有「用户管理」入口（直达设置页 #users 页签）；
 * - 创建房间：必须登录 + 房间名必填；房间号与邀请码可自定义（固定房间长期使用）；
 * - 权限模型：游客只能凭邀请码加入房间；管理员额外拥有账户管理面板。
 *
 * 加入成功后把成员令牌写入 sessionStorage（见 session.ts），
 * 再跳转 /room.html?room=<id>&name=<n>；房间页据此恢复会话，令牌过期则回到本页。
 */

import { saveSession } from "./session.ts";

const $ = <T extends HTMLElement>(sel: string): T => {
  const el = document.querySelector<T>(sel);
  if (!el) throw new Error(`缺少元素 ${sel}`);
  return el;
};

const msgEl = $("#msg");
function msg(text: string): void {
  msgEl.textContent = text;
}

// ── 创建 / 加入弹窗 ───────────────────────────────────────

/** 弹窗开关：点击遮罩或关闭按钮均可关闭。 */
function bindModal(modal: HTMLElement, closeBtn: HTMLElement): void {
  closeBtn.addEventListener("click", () => {
    modal.hidden = true;
  });
  modal.addEventListener("click", (e) => {
    if (e.target === modal) modal.hidden = true;
  });
}

const createModal = $("#createModal") as HTMLElement;
const joinModal = $("#joinModal") as HTMLElement;
bindModal(createModal, $("#createClose"));
bindModal(joinModal, $("#joinClose"));

// 「生成访问码」开关：默认勾选（生成 8 位访问码）；取消勾选则创建无需访问码的房间，
// 任何人凭房间号即可加入，创建后直接进入房间。
const createNoInviteChk = $("#createNoInvite") as HTMLInputElement;
createNoInviteChk.addEventListener("change", () => {
  ($("#createInviteWrap") as HTMLElement).hidden = !createNoInviteChk.checked;
  ($("#createInvite") as HTMLInputElement).disabled = !createNoInviteChk.checked;
});

function openCreateModal(): void {
  $("#createMsg").textContent = "";
  createModal.hidden = false;
  ($("#createName") as HTMLInputElement).focus();
}

/** 打开加入弹窗；roomId 存在则预填并聚焦邀请码。 */
function openJoinModal(roomId?: string): void {
  $("#joinMsg").textContent = "";
  if (roomId !== undefined) ($("#joinRoom") as HTMLInputElement).value = roomId;
  joinModal.hidden = false;
  (roomId ? $("#joinCode") : $("#joinRoom")).focus();
}

$("#openCreateBtn").addEventListener("click", openCreateModal);
$("#openJoinBtn").addEventListener("click", () => openJoinModal());

/** 弹窗内回车直接提交对应表单。 */
$("#createForm").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !(e.target as HTMLElement).closest("button")) $("#createBtn").click();
});
joinModal.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !(e.target as HTMLElement).closest("button")) $("#joinBtn").click();
});

/** 从 URL 预填（房间页把用户带回大厅时携带 ?room=&expired=1；邀请链接携带 ?room=&key=）。 */
const params = new URLSearchParams(location.search);
if (params.get("room")) ($("#joinRoom") as HTMLInputElement).value = params.get("room")!;
if (params.get("expired")) msg("成员凭证已过期，请重新加入房间");

async function postJson(url: string, body: unknown, token?: string): Promise<Record<string, unknown>> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    throw new Error(typeof data.error === "string" ? data.error : `HTTP ${res.status}`);
  }
  return data;
}

function enterRoom(
  roomId: string,
  data: Record<string, unknown>,
  name: string,
): void {
  saveSession({
    roomId,
    memberToken: String(data.memberToken),
    clientId: String(data.clientId),
    role: data.role === "host" ? "host" : "viewer",
    name,
    expiresAt: Number(data.expiresAt ?? 0),
    ...(typeof data.hostSecret === "string" ? { hostSecret: data.hostSecret } : {}),
  });
  location.href = `/room.html?room=${encodeURIComponent(roomId)}&name=${encodeURIComponent(name)}`;
}

$("#createBtn").addEventListener("click", async () => {
  const createMsg = $("#createMsg");
  createMsg.textContent = "";
  if (!user) {
    createMsg.textContent = "创建房间需要先登录（右上角「登录」）；游客可凭邀请码加入房间";
    createModal.hidden = true;
    openModal();
    return;
  }
  // 房间名必填（服务端同样校验，空名直接 400）。
  const name = ($("#createName") as HTMLInputElement).value.trim();
  if (!name) {
    createMsg.textContent = "请填写房间名";
    ($("#createName") as HTMLInputElement).focus();
    return;
  }
  const roomId = ($("#createRoomId") as HTMLInputElement).value.trim();
  const inviteCode = ($("#createInvite") as HTMLInputElement).value.trim();
  const noInvite = !createNoInviteChk.checked;
  const btn = $("#createBtn") as HTMLButtonElement;
  btn.disabled = true;
  try {
    // 创建房间必须登录：携带用户令牌（服务端游客 401）。
    const data = await postJson("/api/rooms", { name, roomId, inviteCode, noInvite }, user.token);
    const newRoomId = String(data.roomId);
    // 邀请码/hostSecret 只在创建响应里出现一次：存进 sessionStorage 供房间页展示与房主重建会话。
    // 选择不生成访问码时 inviteCode 为 null：无存档、不展示邀请链接。
    if (typeof data.inviteCode === "string" && data.inviteCode) {
      sessionStorage.setItem(`syncframe-invite-${newRoomId}`, data.inviteCode);
    } else {
      sessionStorage.removeItem(`syncframe-invite-${newRoomId}`);
    }
    sessionStorage.setItem(`syncframe-hostsecret-${newRoomId}`, String(data.hostSecret));
    enterRoom(newRoomId, data, name);
  } catch (err) {
    createMsg.textContent = `创建失败：${err instanceof Error ? err.message : err}`;
  } finally {
    btn.disabled = false;
  }
});

$("#joinBtn").addEventListener("click", async () => {
  const joinMsg = $("#joinMsg");
  joinMsg.textContent = "";
  const roomId = ($("#joinRoom") as HTMLInputElement).value.trim();
  const codeRaw = ($("#joinCode") as HTMLInputElement).value.trim();
  const code = codeRaw ? codeRaw.toUpperCase() : undefined;
  const name = ($("#joinName") as HTMLInputElement).value.trim() || "Guest";
  if (!roomId) {
    joinMsg.textContent = "请填写房间号";
    ($("#joinRoom") as HTMLInputElement).focus();
    return;
  }
  // 访问码可留空：设置了访问码的房间由服务端校验，未设置的房间凭房间号即可加入。
  const btn = $("#joinBtn") as HTMLButtonElement;
  btn.disabled = true;
  try {
    // 房主重建会话：本浏览器若持有该房间的 hostSecret（成员令牌过期后回到大厅），自动带上。
    const hostSecret = sessionStorage.getItem(`syncframe-hostsecret-${roomId}`) ?? undefined;
    const data = await postJson(`/api/rooms/${encodeURIComponent(roomId)}/join`, {
      name,
      ...(code ? { inviteCode: code } : {}),
      ...(hostSecret ? { hostSecret } : {}),
    });
    enterRoom(roomId, data, name);
  } catch (err) {
    joinMsg.textContent = `加入失败：${err instanceof Error ? err.message : err}`;
  } finally {
    btn.disabled = false;
  }
});

// 链接即邀请：?room=<id>&key=<code> 的大厅自动加入，无需手动输入邀请码。
// key 仍作为 join 接口的凭据（安全模型不变），只是由链接携带。
const linkKey = params.get("key");
if (params.get("room") && linkKey) {
  ($("#joinCode") as HTMLInputElement).value = linkKey;
  if (params.get("name")) ($("#joinName") as HTMLInputElement).value = params.get("name")!;
  msg("正在通过邀请链接加入房间…");
  ($("#joinBtn") as HTMLButtonElement).click();
}

// ── 房间列表 ──────────────────────────────────────────────

const USER_KEY = "syncframe-user"; // localStorage：{ token, username }（浏览器长期持有）

interface UserState {
  token: string;
  username: string;
}

function loadUser(): UserState | null {
  try {
    const raw = localStorage.getItem(USER_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as UserState;
    return parsed.token && parsed.username ? parsed : null;
  } catch {
    return null;
  }
}

let user = loadUser();

interface RoomSummary {
  roomId: string;
  hostName: string;
  createdAt: number;
  memberCount: number;
  mediaCount: number;
  /** false = 创建时选择不生成访问码：凭房间号即可加入。 */
  hasInvite: boolean;
  /** 当前登录用户是否可删除该房间（房主本人或管理员）。 */
  deletable: boolean;
}

async function refreshRoomList(): Promise<void> {
  const listEl = $("#roomList");
  try {
    const res = await fetch("/api/rooms", { headers: userHeaders() });
    const body = (await res.json().catch(() => ({}))) as { rooms?: RoomSummary[] };
    const rooms = body.rooms ?? [];
    $("#roomCount").textContent = rooms.length > 0 ? `共 ${rooms.length} 个` : "";
    listEl.textContent = "";
    if (rooms.length === 0) {
      const d = document.createElement("div");
      d.className = "browse-empty";
      d.textContent = "（当前没有房间，创建一个吧；房间只有被删除后才会消失）";
      listEl.appendChild(d);
      return;
    }
    for (const r of rooms) {
      const row = document.createElement("div");
      row.className = "room-row";
      const idEl = document.createElement("span");
      idEl.className = "room-id";
      idEl.textContent = r.roomId;
      const host = document.createElement("span");
      host.className = "room-host";
      host.textContent = r.hostName;
      const meta = document.createElement("span");
      meta.className = "room-meta";
      meta.innerHTML = `<span></span><span class="dot">·</span><span></span><span class="dot">·</span><span></span>`;
      const metaSpans = meta.querySelectorAll("span");
      metaSpans[0].textContent = `${r.memberCount} 人在线`;
      metaSpans[2].textContent = `${r.mediaCount} 个视频`;
      metaSpans[4].textContent = r.hasInvite ? "凭访问码加入" : "无需访问码";
      // 右侧「直接加入」：弹出加入弹窗并预填房间号，只需输入邀请码。
      const joinBtn = document.createElement("button");
      joinBtn.className = "primary room-join";
      joinBtn.textContent = "直接加入";
      joinBtn.addEventListener("click", () => openJoinModal(r.roomId));
      row.append(idEl, host, meta, joinBtn);
      // 「删除」：仅房主本人或管理员可见；删除后房间立即消失，在线成员被踢回大厅。
      if (r.deletable) {
        const delBtn = document.createElement("button");
        delBtn.className = "danger room-del";
        delBtn.title = "删除房间（不可恢复，在线成员将被请出）";
        delBtn.innerHTML = `<svg class="ic"><use href="#i-trash"/></svg>删除`;
        delBtn.addEventListener("click", () => {
          if (!window.confirm(`确认删除房间「${r.roomId}」？\n删除后不可恢复，房间内的成员将被请出。`)) return;
          void (async () => {
            try {
              const res = await fetch(`/api/rooms/${encodeURIComponent(r.roomId)}`, {
                method: "DELETE",
                headers: userHeaders(),
              });
              const body = (await res.json().catch(() => ({}))) as { error?: string };
              if (!res.ok) {
                msg(`删除失败：${body.error ?? `HTTP ${res.status}`}`);
                return;
              }
              msg(`房间「${r.roomId}」已删除`);
              await refreshRoomList();
            } catch (err) {
              msg(`删除失败：${err instanceof Error ? err.message : err}`);
            }
          })();
        });
        row.appendChild(delBtn);
      }
      listEl.appendChild(row);
    }
  } catch {
    listEl.textContent = "";
    const d = document.createElement("div");
    d.className = "browse-empty";
    d.textContent = "（房间列表加载失败）";
    listEl.appendChild(d);
  }
}

$("#refreshRooms").addEventListener("click", () => void refreshRoomList());
void refreshRoomList();
window.setInterval(refreshRoomList, 15_000);

// ── 登录 ──────────────────────────────────────────────────

const authModal = $("#authModal") as HTMLElement;

function userHeaders(): Record<string, string> {
  return user ? { Authorization: `Bearer ${user.token}` } : {};
}

/** 创建房间卡片：未登录时只显示登录提示（游客只能加入房间）。 */
function renderCreateGate(): void {
  ($("#createGate") as HTMLElement).hidden = Boolean(user);
  ($("#createForm") as HTMLElement).hidden = !user;
}

/** 顶栏用户按钮文案与创建入口（provider 管理在 settings.html 账户设置页）。 */
async function refreshAuthState(): Promise<void> {
  const btnText = $("#loginBtnText");
  const adminBtn = $("#adminBtn") as HTMLElement;
  if (!user) {
    btnText.textContent = "登录";
    adminBtn.hidden = true;
    renderCreateGate();
    return;
  }
  try {
    const res = await fetch("/api/me", { headers: userHeaders() });
    if (!res.ok) throw new Error("expired");
    const body = (await res.json()) as { username: string; role?: string };
    user.username = body.username;
    localStorage.setItem(USER_KEY, JSON.stringify(user));
    btnText.textContent = body.username;
    // 管理员专属入口：直达设置页「用户管理」页签。
    adminBtn.hidden = body.role !== "admin";
    renderCreateGate();
  } catch {
    // 服务端重启等导致令牌失效：清理本地状态回登录态。
    user = null;
    localStorage.removeItem(USER_KEY);
    btnText.textContent = "登录";
    adminBtn.hidden = true;
    renderCreateGate();
  }
}

function openModal(): void {
  authModal.hidden = false;
}
function closeModal(): void {
  authModal.hidden = true;
}

/** 顶栏用户按钮：未登录 → 登录弹窗；已登录 → 账户设置页（provider 管理）。 */
$("#loginBtn").addEventListener("click", () => {
  if (user) location.href = "/settings.html";
  else openModal();
});
// 管理员专属入口：直达账户设置页「用户管理」页签。
$("#adminBtn").addEventListener("click", () => {
  location.href = "/settings.html#users";
});
$("#authClose").addEventListener("click", closeModal);
authModal.addEventListener("click", (e) => {
  if (e.target === authModal) closeModal();
});

$("#authSubmit").addEventListener("click", async () => {
  const username = ($("#authUsername") as HTMLInputElement).value;
  const password = ($("#authPassword") as HTMLInputElement).value;
  const msgEl2 = $("#authMsg");
  msgEl2.textContent = "";
  try {
    // 注册已关闭：只有登录。账户由管理员在「账户设置 → 账户管理」中创建。
    const data = await postJson("/api/auth/login", { username, password });
    user = { token: String(data.userToken), username: String(data.username ?? username).trim() };
    localStorage.setItem(USER_KEY, JSON.stringify(user));
    ($("#authPassword") as HTMLInputElement).value = "";
    closeModal();
    await refreshAuthState();
    msg(`已登录 ${user.username}；点击右上角用户名可管理视频 provider（OpenList / B 站凭据）`);
  } catch (err) {
    msgEl2.textContent = err instanceof Error ? err.message : String(err);
  }
});

void refreshAuthState();
