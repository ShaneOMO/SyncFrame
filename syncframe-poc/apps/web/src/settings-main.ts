/**
 * 账户设置页（settings.html）：
 * - 左侧导航：「视频 Provider」（所有用户）+「用户管理」（仅管理员，即管理员专属入口）；
 * - 个人 pane：provider 卡片网格 + 添加表单（OpenList / 哔哩哔哩）；
 * - 管理员 pane：账户表格（角色 / provider 数）、创建账户、重置密码、删除账户；
 * - 登录态从 localStorage（syncframe-user）恢复，详情经 GET /api/me 拉取；
 *   令牌失效时清理本地状态并跳回大厅重新登录。
 *
 * 路由：#providers / #users（大厅管理员「管理用户」入口直接链到 #users）。
 */

const USER_KEY = "syncframe-user";

/** B 站凭证存储在浏览器（服务端不保存），与账户令牌分开管理。 */
import { clearBiliSessdata, loadBiliSessdata, saveBiliSessdata } from "./bili-credential.ts";

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

interface AdminUser {
  username: string;
  role: "admin" | "user";
  providerCount: number;
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

const $ = <T extends HTMLElement>(sel: string): T => {
  const node = document.querySelector<T>(sel);
  if (!node) throw new Error(`缺少元素 ${sel}`);
  return node;
};

let user: UserState | null = loadUser();
let isAdmin = false;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  text = "",
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "className") node.className = v;
    else node.setAttribute(k, v);
  }
  if (text) node.textContent = text;
  return node;
}

function msg(text: string, ok = false, admin = false): void {
  const node = $(admin ? "[data-admin-msg]" : "[data-msg]");
  node.textContent = text;
  node.classList.toggle("ok", ok);
}

function authHeaders(): Record<string, string> {
  return user ? { Authorization: `Bearer ${user.token}` } : {};
}

async function fetchMe(): Promise<{ username: string; role?: string; providers: PublicProvider[] } | null> {
  if (!user) return null;
  const res = await fetch("/api/me", { headers: authHeaders() });
  if (!res.ok) return null;
  return (await res.json()) as { username: string; role?: string; providers: PublicProvider[] };
}

/** 令牌失效：清理本地状态并回大厅登录。 */
function expireToLobby(): never {
  localStorage.removeItem(USER_KEY);
  location.href = "/lobby.html";
  throw new Error("登录已过期");
}

// ── 页签导航（#providers / #users）────────────────────────────

function currentTab(): "providers" | "users" {
  return location.hash === "#users" && isAdmin ? "users" : "providers";
}

function syncTabs(): void {
  const tab = currentTab();
  for (const btn of document.querySelectorAll<HTMLElement>("[data-nav]")) {
    btn.classList.toggle("active", btn.dataset.nav === tab);
  }
  for (const pane of document.querySelectorAll<HTMLElement>("[data-pane]")) {
    pane.hidden = pane.dataset.pane !== tab;
  }
  document.title = tab === "users" ? "SyncFrame · 用户管理" : "SyncFrame · 账户设置";
}

function bindTabs(): void {
  for (const btn of document.querySelectorAll<HTMLElement>("[data-nav]")) {
    btn.addEventListener("click", () => {
      location.hash = btn.dataset.nav === "users" ? "#users" : "#providers";
      syncTabs();
    });
  }
  window.addEventListener("hashchange", syncTabs);
}

// ── 个人：视频 provider 管理 ─────────────────────────────────

function renderProviders(providers: PublicProvider[]): void {
  const bound = Boolean(loadBiliSessdata());
  $("[data-provider-count]").textContent = String(providers.length + (bound ? 1 : 0));
  const listEl = $("[data-provider-list]");
  listEl.textContent = "";
  if (providers.length === 0 && !bound) {
    listEl.appendChild(el("div", { className: "browse-empty" },
      "（尚未配置 provider；可添加 OpenList，或在房间里直接用直链、B 站链接）"));
    return;
  }
  const grid = el("div", { className: "provider-grid" });
  // B 站凭证属于本浏览器（服务端不保存），因此单独渲染一张卡片，避免看起来"凭空消失"。
  if (bound) {
    const card = el("div", { className: "provider-card" });
    const top = el("div", { className: "top" });
    top.append(el("span", { className: "kind" }, "哔哩哔哩"), el("b", {}, "本浏览器已绑定"));
    const meta = el("span", { className: "meta" }, "凭证保存在本浏览器，服务端不保存");
    const actions = el("div", { className: "actions" });
    const del = el("button", { className: "danger" }, "清除");
    del.addEventListener("click", () => {
      clearBiliSessdata();
      renderProviders(providers);
      renderBiliCredStatus();
      msg("已清除本浏览器的 B 站凭证", true);
    });
    actions.appendChild(del);
    card.append(top, meta, actions);
    grid.appendChild(card);
  }
  for (const p of providers) {
    const card = el("div", { className: "provider-card" });
    const top = el("div", { className: "top" });
    top.append(
      el("span", { className: "kind" }, p.kind === "openlist" ? "OpenList" : "哔哩哔哩"),
      el("b", {}, p.label),
    );
    const meta = el("span", { className: "meta" },
      p.kind === "openlist" ? `${p.baseUrl} · ${p.username}` : "B 站凭证保存在浏览器，服务端不保存");
    const actions = el("div", { className: "actions" });
    const del = el("button", { className: "danger" }, "删除");
    del.addEventListener("click", () => void saveProviders(providers.filter((x) => x.id !== p.id)));
    actions.appendChild(del);
    card.append(top, meta, actions);
    grid.appendChild(card);
  }
  listEl.appendChild(grid);
}

/** 全量替换 provider 配置（删除/添加覆盖 PoC 需求）。 */
async function saveProviders(next: PublicProvider[]): Promise<void> {
  if (!user) expireToLobby();
  msg("");
  try {
    const res = await fetch("/api/me/providers", {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ providers: next }),
    });
    const body = (await res.json().catch(() => ({}))) as { providers?: PublicProvider[]; error?: string };
    if (!res.ok || !body.providers) {
      msg(body.error ?? `HTTP ${res.status}`);
      return;
    }
    renderProviders(body.providers);
    msg("已保存", true);
  } catch (err) {
    msg(err instanceof Error ? err.message : String(err));
  }
}

async function onAdd(): Promise<void> {
  if (!user) expireToLobby();
  const kind = ($("[data-kind]") as HTMLSelectElement).value;
  let next: Record<string, unknown> | null = null;
  if (kind === "openlist") {
    const label = ($("[data-label]") as HTMLInputElement).value.trim();
    const baseUrl = ($("[data-baseurl]") as HTMLInputElement).value.trim();
    const username = ($("[data-username]") as HTMLInputElement).value.trim();
    const password = ($("[data-password]") as HTMLInputElement).value;
    if (!baseUrl || !username || !password) {
      msg("请填写完整的 OpenList 地址、用户名与密码");
      return;
    }
    next = { id: "", kind: "openlist", label: label || "OpenList", baseUrl, username, password };
  } else {
    // B 站凭证保存在本浏览器，不再创建服务端 provider。
    msg("B 站凭证只保存在本浏览器：请点「扫码绑定 B 站」，无需添加 provider");
    return;
  }
  try {
    const me = await fetchMe();
    if (!me) expireToLobby();
    await saveProviders([...me!.providers, next as unknown as PublicProvider]);
    if ($("[data-msg]").classList.contains("ok")) {
      for (const sel of ["[data-label]", "[data-baseurl]", "[data-username]", "[data-password]"]) {
        ($(sel) as HTMLInputElement).value = "";
      }
    }
  } catch (err) {
    msg(err instanceof Error ? err.message : String(err));
  }
}

function renderBiliCredStatus(): void {
  const el = document.querySelector<HTMLElement>("[data-bili-cred-status]");
  if (!el) return;
  el.textContent = loadBiliSessdata()
    ? "本浏览器已绑定 B 站账号：播放时使用该凭证解析（服务器不会保存，也不会共享给其他人）。"
    : "本浏览器未绑定：匿名解析，画质上限 720P，番剧/会员内容可能无法播放。";
}

function bindProviderForm(): void {
  $("[data-kind]").addEventListener("change", () => {
    const kind = ($("[data-kind]") as HTMLSelectElement).value;
    $("[data-openlist-fields]").hidden = kind !== "openlist";
    $("[data-bilibili-fields]").hidden = kind !== "bilibili";
    renderBiliCredStatus();
  });
  $("[data-add]").addEventListener("click", () => void onAdd());
  $("[data-bili-qr]").addEventListener("click", () => void startBiliQrLogin());
  $("[data-bili-clear]").addEventListener("click", () => {
    clearBiliSessdata();
    renderBiliCredStatus();
    void fetchMe().then((me) => {
      if (me) renderProviders(me.providers);
    });
    setQrStatus("已清除本浏览器的 B 站凭证");
    msg("已清除本浏览器的 B 站凭证", true);
  });
}

// ── Bilibili 扫码登录（SyncTV 式绑定；凭据只在服务端，前端只见二维码与登录昵称）──

let qrPollTimer: number | null = null;

function setQrStatus(text: string): void {
  $("[data-bili-qr-status]").textContent = text;
}

function stopQrPolling(): void {
  if (qrPollTimer !== null) {
    window.clearInterval(qrPollTimer);
    qrPollTimer = null;
  }
}

async function startBiliQrLogin(): Promise<void> {
  if (!user) expireToLobby();
  stopQrPolling();
  const canvas = $("[data-bili-qr-canvas]") as HTMLCanvasElement;
  canvas.hidden = true;
  setQrStatus("正在获取二维码…");
  try {
    const res = await fetch("/api/bilibili/login/qrcode", { headers: authHeaders() });
    const body = (await res.json().catch(() => ({}))) as { url?: string; qrcodeKey?: string; error?: string };
    if (!res.ok || !body.url || !body.qrcodeKey) {
      setQrStatus(body.error ?? `获取二维码失败 HTTP ${res.status}`);
      return;
    }
    const { toCanvas } = await import("qrcode");
    await toCanvas(canvas, body.url, { width: 180, margin: 1 });
    canvas.hidden = false;
    setQrStatus("请用哔哩哔哩 App 扫码并确认登录");
    qrPollTimer = window.setInterval(() => void pollBiliQr(body.qrcodeKey!), 2000);
  } catch (err) {
    setQrStatus(err instanceof Error ? err.message : String(err));
  }
}

async function pollBiliQr(qrcodeKey: string): Promise<void> {
  try {
    const res = await fetch(`/api/bilibili/login/poll?qrcodeKey=${encodeURIComponent(qrcodeKey)}`, {
      headers: authHeaders(),
    });
    const body = (await res.json().catch(() => ({}))) as {
      status?: string;
      uname?: string;
      sessdata?: string;
      error?: string;
    };
    if (!res.ok) {
      stopQrPolling();
      setQrStatus(body.error ?? `登录失败 HTTP ${res.status}`);
      return;
    }
    if (body.status === "scanned") {
      setQrStatus("已扫码，请在手机上确认登录…");
    } else if (body.status === "expired") {
      stopQrPolling();
      setQrStatus("二维码已过期，请点击按钮重新获取");
    } else if (body.status === "confirmed") {
      stopQrPolling();
      ($("[data-bili-qr-canvas]") as HTMLCanvasElement).hidden = true;
      const sessdata = body.sessdata ?? "";
      if (!saveBiliSessdata(sessdata)) {
        setQrStatus("登录已确认，但凭证保存失败（浏览器存储不可用，请检查隐私模式）");
        return;
      }
      setQrStatus(`绑定成功${body.uname ? `：${body.uname}` : ""}，凭证已保存在本浏览器`);
      msg("B 站账号已绑定到本浏览器（服务器不保存）", true);
      renderBiliCredStatus();
      // 立即把「本浏览器已绑定」卡片显示出来（否则要刷新页面才看得到）
      void fetchMe().then((me) => {
        if (me) renderProviders(me.providers);
      });
    }
    // waiting：保持轮询。
  } catch {
    /* 单次轮询失败忽略，下轮重试；连续失败由用户重开。 */
  }
}

// ── 管理员：用户管理 ─────────────────────────────────────────

async function renderAdminUsers(): Promise<void> {
  if (!user) expireToLobby();
  try {
    const res = await fetch("/api/admin/users", { headers: authHeaders() });
    const body = (await res.json().catch(() => ({}))) as { users?: AdminUser[]; error?: string };
    if (!res.ok || !body.users) {
      msg(body.error ?? `HTTP ${res.status}`, false, true);
      return;
    }
    const listEl = $("[data-admin-list]");
    listEl.textContent = "";
    for (const u of body.users) {
      const tr = el("tr");
      const nameTd = el("td");
      const name = el("b", {}, u.username);
      nameTd.appendChild(name);
      const roleTd = el("td");
      roleTd.appendChild(el("span", { className: `role-tag${u.role === "admin" ? " admin" : ""}` },
        u.role === "admin" ? "管理员" : "用户"));
      const metaTd = el("td", {}, `${u.providerCount} 个`);
      const actTd = el("td");
      const reset = el("button", {}, "重置密码");
      reset.addEventListener("click", () => {
        const pw = prompt(`为 ${u.username} 设置新密码（至少 8 位）：`);
        if (!pw) return;
        void (async () => {
          const r = await fetch(`/api/admin/users/${encodeURIComponent(u.username)}/password`, {
            method: "POST",
            headers: { "Content-Type": "application/json", ...authHeaders() },
            body: JSON.stringify({ password: pw }),
          });
          const b = (await r.json().catch(() => ({}))) as { error?: string };
          msg(r.ok ? `已重置 ${u.username} 的密码` : (b.error ?? `HTTP ${r.status}`), r.ok, true);
        })();
      });
      actTd.appendChild(reset);
      if (u.username !== user!.username) {
        const del = el("button", { className: "danger" }, "删除");
        del.addEventListener("click", () => {
          if (!confirm(`确定删除账户 ${u.username}？其凭据与会话将立即失效。`)) return;
          void (async () => {
            const r = await fetch(`/api/admin/users/${encodeURIComponent(u.username)}`, {
              method: "DELETE",
              headers: authHeaders(),
            });
            const b = (await r.json().catch(() => ({}))) as { error?: string };
            msg(r.ok ? `已删除 ${u.username}` : (b.error ?? `HTTP ${r.status}`), r.ok, true);
            if (r.ok) void renderAdminUsers();
          })();
        });
        actTd.appendChild(del);
      }
      tr.append(nameTd, roleTd, metaTd, actTd);
      listEl.appendChild(tr);
    }
  } catch (err) {
    msg(err instanceof Error ? err.message : String(err), false, true);
  }
}

async function onCreateUser(): Promise<void> {
  if (!user) expireToLobby();
  msg("", false, true);
  const username = ($("[data-new-username]") as HTMLInputElement).value.trim();
  const password = ($("[data-new-password]") as HTMLInputElement).value;
  try {
    const res = await fetch("/api/admin/users", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ username, password }),
    });
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) {
      msg(body.error ?? `HTTP ${res.status}`, false, true);
      return;
    }
    msg(`已创建账户 ${username}`, true, true);
    ($("[data-new-username]") as HTMLInputElement).value = "";
    ($("[data-new-password]") as HTMLInputElement).value = "";
    void renderAdminUsers();
  } catch (err) {
    msg(err instanceof Error ? err.message : String(err), false, true);
  }
}

// ── 入口 ─────────────────────────────────────────────────────

async function main(): Promise<void> {
  if (!user) {
    location.replace("/lobby.html");
    return;
  }
  bindTabs();
  bindProviderForm();
  renderBiliCredStatus();
  $("[data-create-user]").addEventListener("click", () => void onCreateUser());
  $("[data-logout]").addEventListener("click", () => {
    localStorage.removeItem(USER_KEY);
    location.href = "/lobby.html";
  });

  const me = await fetchMe();
  if (!me) expireToLobby();
  isAdmin = me!.role === "admin";

  $("[data-who]").textContent = me!.username;
  $("[data-avatar]").textContent = me!.username.slice(0, 1).toUpperCase();
  $("[data-role]").textContent = isAdmin ? "管理员" : "用户";
  // 管理员专属入口：「用户管理」页签。
  $("[data-nav='users']").hidden = !isAdmin;

  renderProviders(me!.providers);
  if (isAdmin) void renderAdminUsers();
  syncTabs();
}

void main();
