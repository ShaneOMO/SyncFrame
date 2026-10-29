/**
 * P4 大厅页：
 * - 房间列表：GET /api/rooms 展示本实例活跃房间（房间号/房主/人数/视频数），点击房间号填入加入表单；
 * - 右上角登录按钮：注册/登录账户（localStorage 存用户令牌），登录后可配置自己的视频 provider
 *   （OpenList 凭据只存服务端内存；直链 provider 内置无需配置）；
 * - 创建房间 / 凭邀请码加入房间（P3 行为不变）。
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

/** 从 URL 预填（房间页把用户带回大厅时携带 ?room=&expired=1；邀请链接携带 ?room=&key=）。 */
const params = new URLSearchParams(location.search);
if (params.get("room")) ($("#joinRoom") as HTMLInputElement).value = params.get("room")!;
if (params.get("expired")) msg("成员凭证已过期，请重新加入房间");

async function postJson(url: string, body: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
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
  msg("");
  const name = ($("#createName") as HTMLInputElement).value.trim() || "房主";
  const btn = $("#createBtn") as HTMLButtonElement;
  btn.disabled = true;
  try {
    const data = await postJson("/api/rooms", { name });
    const roomId = String(data.roomId);
    // 邀请码/hostSecret 只在创建响应里出现一次：存进 sessionStorage 供房间页展示与房主重建会话。
    sessionStorage.setItem(`syncframe-invite-${roomId}`, String(data.inviteCode));
    sessionStorage.setItem(`syncframe-hostsecret-${roomId}`, String(data.hostSecret));
    enterRoom(roomId, data, name);
  } catch (err) {
    msg(`创建失败：${err instanceof Error ? err.message : err}`);
  } finally {
    btn.disabled = false;
  }
});

$("#joinBtn").addEventListener("click", async () => {
  msg("");
  const roomId = ($("#joinRoom") as HTMLInputElement).value.trim();
  const code = ($("#joinCode") as HTMLInputElement).value.trim().toUpperCase();
  const name = ($("#joinName") as HTMLInputElement).value.trim() || "Guest";
  if (!roomId || !code) {
    msg("请填写房间号和邀请码");
    return;
  }
  const btn = $("#joinBtn") as HTMLButtonElement;
  btn.disabled = true;
  try {
    // 房主重建会话：本浏览器若持有该房间的 hostSecret（成员令牌过期后回到大厅），自动带上。
    const hostSecret = sessionStorage.getItem(`syncframe-hostsecret-${roomId}`) ?? undefined;
    const data = await postJson(`/api/rooms/${encodeURIComponent(roomId)}/join`, {
      name,
      inviteCode: code,
      ...(hostSecret ? { hostSecret } : {}),
    });
    enterRoom(roomId, data, name);
  } catch (err) {
    msg(`加入失败：${err instanceof Error ? err.message : err}`);
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

interface RoomSummary {
  roomId: string;
  hostName: string;
  createdAt: number;
  memberCount: number;
  mediaCount: number;
}

async function refreshRoomList(): Promise<void> {
  const listEl = $("#roomList");
  try {
    const res = await fetch("/api/rooms");
    const body = (await res.json().catch(() => ({}))) as { rooms?: RoomSummary[] };
    const rooms = body.rooms ?? [];
    $("#roomCount").textContent = rooms.length > 0 ? `共 ${rooms.length} 个` : "";
    listEl.textContent = "";
    if (rooms.length === 0) {
      const d = document.createElement("div");
      d.className = "browse-empty";
      d.textContent = "（当前没有活跃房间，创建一个吧）";
      listEl.appendChild(d);
      return;
    }
    for (const r of rooms) {
      const row = document.createElement("div");
      row.className = "room-row";
      const idBtn = document.createElement("button");
      idBtn.className = "room-id";
      idBtn.textContent = r.roomId;
      idBtn.title = "点击填入下方房间号";
      idBtn.addEventListener("click", () => {
        ($("#joinRoom") as HTMLInputElement).value = r.roomId;
        $("#joinRoom").scrollIntoView({ behavior: "smooth", block: "center" });
        msg(`已填入房间号 ${r.roomId}，请输入邀请码加入`);
      });
      const host = document.createElement("span");
      host.className = "room-host";
      host.textContent = `房主：${r.hostName}`;
      const meta = document.createElement("span");
      meta.className = "room-meta";
      meta.textContent = `${r.memberCount} 人在线 · ${r.mediaCount} 个视频`;
      row.append(idBtn, host, meta);
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

// ── 登录与 provider 配置 ──────────────────────────────────

const USER_KEY = "syncframe-user"; // localStorage：{ token, username }（浏览器长期持有）

interface UserState {
  token: string;
  username: string;
}

interface PublicProvider {
  id: string;
  kind: "openlist" | "bilibili";
  label: string;
  baseUrl?: string;
  username?: string;
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
let authMode: "login" | "register" = "login";

const authModal = $("#authModal") as HTMLElement;
const authFormsEl = $("#authForms") as HTMLElement;
const providerPanelEl = $("#providerPanel") as HTMLElement;

function userHeaders(): Record<string, string> {
  return user ? { Authorization: `Bearer ${user.token}` } : {};
}

/** 拉取 /api/me 刷新登录态与 provider 列表；令牌失效则登出。 */
async function refreshAuthState(): Promise<void> {
  const btnText = $("#loginBtnText");
  if (!user) {
    btnText.textContent = "登录";
    authFormsEl.hidden = false;
    providerPanelEl.hidden = true;
    return;
  }
  try {
    const res = await fetch("/api/me", { headers: userHeaders() });
    if (!res.ok) throw new Error("expired");
    const body = (await res.json()) as { username: string; providers: PublicProvider[] };
    btnText.textContent = body.username;
    authFormsEl.hidden = true;
    providerPanelEl.hidden = false;
    renderProviders(body.providers);
  } catch {
    // 服务端重启等导致令牌失效：清理本地状态回登录态。
    user = null;
    localStorage.removeItem(USER_KEY);
    btnText.textContent = "登录";
    authFormsEl.hidden = false;
    providerPanelEl.hidden = true;
  }
}

function openModal(): void {
  authModal.hidden = false;
  void refreshAuthState();
}
function closeModal(): void {
  authModal.hidden = true;
}

$("#loginBtn").addEventListener("click", openModal);
$("#authClose").addEventListener("click", closeModal);
authModal.addEventListener("click", (e) => {
  if (e.target === authModal) closeModal();
});

function setAuthMode(mode: "login" | "register"): void {
  authMode = mode;
  $("#tabLogin").classList.toggle("active", mode === "login");
  $("#tabRegister").classList.toggle("active", mode === "register");
  ($("#authSubmit") as HTMLButtonElement).textContent = mode === "login" ? "登录" : "注册并登录";
  $("#authMsg").textContent = "";
}
$("#tabLogin").addEventListener("click", () => setAuthMode("login"));
$("#tabRegister").addEventListener("click", () => setAuthMode("register"));
setAuthMode("login");

$("#authSubmit").addEventListener("click", async () => {
  const username = ($("#authUsername") as HTMLInputElement).value;
  const password = ($("#authPassword") as HTMLInputElement).value;
  const msgEl2 = $("#authMsg");
  msgEl2.textContent = "";
  try {
    const data = await postJson(`/api/auth/${authMode}`, { username, password });
    user = { token: String(data.userToken), username: String(data.username ?? username).trim() };
    localStorage.setItem(USER_KEY, JSON.stringify(user));
    ($("#authPassword") as HTMLInputElement).value = "";
    await refreshAuthState();
  } catch (err) {
    msgEl2.textContent = err instanceof Error ? err.message : String(err);
  }
});

$("#logoutBtn").addEventListener("click", () => {
  user = null;
  localStorage.removeItem(USER_KEY);
  void refreshAuthState();
});

function renderProviders(providers: PublicProvider[]): void {
  $("#providerUser").textContent = user?.username ?? "-";
  const listEl = $("#providerList");
  listEl.textContent = "";
  if (providers.length === 0) {
    const d = document.createElement("div");
    d.className = "browse-empty";
    d.textContent = "（尚未配置 provider；可添加 OpenList / 哔哩哔哩，或在房间里直接用直链、B 站链接）";
    listEl.appendChild(d);
    return;
  }
  for (const p of providers) {
    const row = document.createElement("div");
    row.className = "provider-row";
    const kind = document.createElement("span");
    kind.className = "kind";
    kind.textContent = p.kind === "openlist" ? "OpenList" : "哔哩哔哩";
    const label = document.createElement("b");
    label.textContent = p.label;
    const url = document.createElement("span");
    url.className = "url";
    url.textContent = p.kind === "openlist" ? `${p.baseUrl} · ${p.username}` : "SESSDATA 凭据仅存服务端";
    const del = document.createElement("button");
    del.className = "danger";
    del.textContent = "删除";
    del.addEventListener("click", () => void saveProviders(providers.filter((x) => x.id !== p.id)));
    row.append(kind, label, url, del);
    listEl.appendChild(row);
  }
}

/** 全量替换 provider 配置（含既有项的编辑入口未做，删除/添加覆盖 PoC 需求）。 */
async function saveProviders(next: PublicProvider[]): Promise<void> {
  const msgEl2 = $("#providerMsg");
  msgEl2.textContent = "";
  try {
    const res = await fetch("/api/me/providers", {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...userHeaders() },
      body: JSON.stringify({ providers: next }),
    });
    const body = (await res.json().catch(() => ({}))) as { providers?: PublicProvider[]; error?: string };
    if (!res.ok || !body.providers) {
      msgEl2.textContent = body.error ?? `HTTP ${res.status}`;
      return;
    }
    renderProviders(body.providers);
    msgEl2.textContent = "已保存";
  } catch (err) {
    msgEl2.textContent = err instanceof Error ? err.message : String(err);
  }
}

$("#pKind").addEventListener("change", () => {
  const kind = ($("#pKind") as HTMLSelectElement).value;
  ($("#pOpenlistFields") as HTMLElement).hidden = kind !== "openlist";
  ($("#pBilibiliFields") as HTMLElement).hidden = kind !== "bilibili";
});

$("#pAdd").addEventListener("click", async () => {
  const msgEl2 = $("#providerMsg");
  msgEl2.textContent = "";
  const kind = ($("#pKind") as HTMLSelectElement).value;
  let next: Record<string, unknown> | null = null;
  if (kind === "openlist") {
    const label = ($("#pLabel") as HTMLInputElement).value.trim();
    const baseUrl = ($("#pBaseUrl") as HTMLInputElement).value.trim();
    const username = ($("#pUsername") as HTMLInputElement).value.trim();
    const password = ($("#pPassword") as HTMLInputElement).value;
    if (!baseUrl || !username || !password) {
      msgEl2.textContent = "请填写完整的 OpenList 地址、用户名与密码";
      return;
    }
    next = { id: "", kind: "openlist", label: label || "OpenList", baseUrl, username, password };
  } else {
    const label = ($("#pBiliLabel") as HTMLInputElement).value.trim();
    const cookie = ($("#pBiliCookie") as HTMLInputElement).value.trim();
    next = { id: "", kind: "bilibili", label: label || "哔哩哔哩", cookie };
  }
  // 基于当前渲染的列表 + 新增项；更简单做法是从 /api/me 重拉。
  try {
    const me = await fetch("/api/me", { headers: userHeaders() }).then((r) => r.json()) as { providers: PublicProvider[] };
    await saveProviders([
      ...me.providers,
      next as unknown as PublicProvider,
    ]);
    if (msgEl2.textContent === "已保存") {
      ($("#pLabel") as HTMLInputElement).value = "";
      ($("#pBaseUrl") as HTMLInputElement).value = "";
      ($("#pUsername") as HTMLInputElement).value = "";
      ($("#pPassword") as HTMLInputElement).value = "";
      ($("#pBiliLabel") as HTMLInputElement).value = "";
      ($("#pBiliCookie") as HTMLInputElement).value = "";
    }
  } catch (err) {
    msgEl2.textContent = err instanceof Error ? err.message : String(err);
  }
});

void refreshAuthState();
