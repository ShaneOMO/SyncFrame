/**
 * 账户设置弹窗（大厅与房间页共用）：provider 管理 + 管理员账户面板 + 退出登录。
 *
 * 设计：登录后不再直接铺出 provider 表单；点击用户名（大厅顶栏 / 房间页自己的成员 chip）
 * 才打开本弹窗。登录态从 localStorage（syncframe-user）恢复，详情经 GET /api/me 拉取；
 * 令牌失效时清理本地状态并提示重新登录。
 *
 * 弹窗 DOM 由本模块动态创建（样式类复用各页面已有的 modal / provider-row 体系）。
 */

const USER_KEY = "syncframe-user";

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

let modalEl: HTMLElement | null = null;

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

/** 打开账户设置弹窗；未登录返回 false（调用方应改走登录流程）。 */
export async function openUserSettings(): Promise<boolean> {
  const user = loadUser();
  if (!user) return false;
  ensureModal();
  modalEl!.hidden = false;
  await render(user);
  return true;
}

function ensureModal(): void {
  if (modalEl) return;
  modalEl = el("div", { className: "modal", id: "userSettingsModal", hidden: "" });
  modalEl.innerHTML = `
    <div class="modal-card" role="dialog" aria-modal="true" aria-label="账户设置">
      <div class="modal-head">
        <h2>账户设置</h2>
        <button class="icon ghost" data-close aria-label="关闭">✕</button>
      </div>
      <p class="provider-who">当前用户：<b data-who></b> <span>（凭据仅存服务端内存）</span></p>
      <h3 class="settings-h">我的视频 provider</h3>
      <div data-provider-list></div>
      <h3 class="settings-h">添加 provider</h3>
      <div class="provider-form">
        <select data-kind style="width:100%">
          <option value="openlist">OpenList（自建网盘）</option>
          <option value="bilibili">哔哩哔哩（可选 SESSDATA，画质更高）</option>
        </select>
        <div data-openlist-fields>
          <input data-label type="text" maxlength="24" placeholder="名称（如：家里 OpenList）" />
          <input data-baseurl type="text" placeholder="https://openlist.example.com" />
          <input data-username type="text" maxlength="64" placeholder="OpenList 用户名" autocomplete="off" />
          <input data-password type="password" maxlength="64" placeholder="OpenList 密码" autocomplete="new-password" />
        </div>
        <div data-bilibili-fields hidden>
          <input data-bililabel type="text" maxlength="24" placeholder="名称（如：我的 B 站）" />
          <input data-bilicookie type="text" placeholder="SESSDATA cookie（可选，留空则匿名）" autocomplete="off" />
        </div>
        <button data-add class="primary">添加 provider</button>
      </div>
      <p class="provider-hint">「直链」「B 站视频」无需配置：在房间里点「添加影片」直接粘贴地址 / BV 号即可。</p>
      <div data-admin hidden>
        <h3 class="settings-h">账户管理（管理员）</h3>
        <div data-admin-list></div>
        <div class="provider-form" style="margin-top:8px">
          <input data-new-username type="text" maxlength="24" placeholder="新用户名" autocomplete="off" />
          <input data-new-password type="password" maxlength="64" placeholder="密码" autocomplete="new-password" />
          <button data-create-user>创建账户</button>
        </div>
        <p class="provider-hint">被删除用户的会话与凭据立即失效；重置密码后需重新登录。</p>
      </div>
      <p data-msg role="status" aria-live="polite" style="min-height:18px;font-size:12px;color:var(--warning);margin:8px 0 0"></p>
      <button data-logout class="danger" style="margin-top:16px;padding:8px 0;width:100%">退出登录</button>
    </div>`;
  document.body.appendChild(modalEl);
  const $ = <T extends HTMLElement>(sel: string): T => modalEl!.querySelector<T>(sel)!;

  modalEl.addEventListener("click", (e) => {
    if (e.target === modalEl || (e.target as HTMLElement).hasAttribute("data-close")) {
      modalEl!.hidden = true;
    }
  });
  $("[data-kind]").addEventListener("change", () => {
    const kind = ($("[data-kind]") as HTMLSelectElement).value;
    $("[data-openlist-fields]").hidden = kind !== "openlist";
    $("[data-bilibili-fields]").hidden = kind !== "bilibili";
  });
  $("[data-add]").addEventListener("click", () => void onAdd());
  $("[data-create-user]").addEventListener("click", () => void onCreateUser());
  $("[data-logout]").addEventListener("click", () => {
    localStorage.removeItem(USER_KEY);
    modalEl!.hidden = true;
    location.reload();
  });
}

function msg(text: string): void {
  modalEl!.querySelector<HTMLElement>("[data-msg]")!.textContent = text;
}

async function fetchMe(user: UserState): Promise<{ username: string; role?: string; providers: PublicProvider[] } | null> {
  const res = await fetch("/api/me", { headers: { Authorization: `Bearer ${user.token}` } });
  if (!res.ok) return null;
  return (await res.json()) as { username: string; role?: string; providers: PublicProvider[] };
}

async function render(user: UserState): Promise<void> {
  const $ = <T extends HTMLElement>(sel: string): T => modalEl!.querySelector<T>(sel)!;
  let me: Awaited<ReturnType<typeof fetchMe>> = null;
  try {
    me = await fetchMe(user);
  } catch {
    me = null;
  }
  if (!me) {
    // 服务端重启等导致令牌失效：清理本地状态，提示重新登录。
    localStorage.removeItem(USER_KEY);
    $("[data-who]").textContent = user.username;
    msg("登录已过期，请关闭本窗口后重新登录");
    return;
  }
  $("[data-who]").textContent = me.username;
  renderProviders(me.providers);
  const isAdmin = me.role === "admin";
  $("[data-admin]").hidden = !isAdmin;
  if (isAdmin) void renderAdminUsers(user);
}

function renderProviders(providers: PublicProvider[]): void {
  const $ = <T extends HTMLElement>(sel: string): T => modalEl!.querySelector<T>(sel)!;
  const listEl = $("[data-provider-list]");
  listEl.textContent = "";
  if (providers.length === 0) {
    const d = el("div", { className: "browse-empty" }, "（尚未配置 provider；可添加 OpenList / 哔哩哔哩，或在房间里直接用直链、B 站链接）");
    listEl.appendChild(d);
    return;
  }
  for (const p of providers) {
    const row = el("div", { className: "provider-row" });
    const kind = el("span", { className: "kind" }, p.kind === "openlist" ? "OpenList" : "哔哩哔哩");
    const label = el("b", {}, p.label);
    const url = el("span", { className: "url" }, p.kind === "openlist" ? `${p.baseUrl} · ${p.username}` : "SESSDATA 凭据仅存服务端");
    const del = el("button", { className: "danger" }, "删除");
    del.addEventListener("click", () => void saveProviders(providers.filter((x) => x.id !== p.id)));
    row.append(kind, label, url, del);
    listEl.appendChild(row);
  }
}

/** 全量替换 provider 配置（删除/添加覆盖 PoC 需求）。 */
async function saveProviders(next: PublicProvider[]): Promise<void> {
  const user = loadUser();
  if (!user) return;
  msg("");
  try {
    const res = await fetch("/api/me/providers", {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${user.token}` },
      body: JSON.stringify({ providers: next }),
    });
    const body = (await res.json().catch(() => ({}))) as { providers?: PublicProvider[]; error?: string };
    if (!res.ok || !body.providers) {
      msg(body.error ?? `HTTP ${res.status}`);
      return;
    }
    renderProviders(body.providers);
    msg("已保存");
  } catch (err) {
    msg(err instanceof Error ? err.message : String(err));
  }
}

async function onAdd(): Promise<void> {
  const $ = <T extends HTMLElement>(sel: string): T => modalEl!.querySelector<T>(sel)!;
  const user = loadUser();
  if (!user) return;
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
    const label = ($("[data-bililabel]") as HTMLInputElement).value.trim();
    const cookie = ($("[data-bilicookie]") as HTMLInputElement).value.trim();
    next = { id: "", kind: "bilibili", label: label || "哔哩哔哩", cookie };
  }
  try {
    const me = await fetchMe(user);
    if (!me) throw new Error("登录已过期");
    await saveProviders([...me.providers, next as unknown as PublicProvider]);
    const msgEl = modalEl!.querySelector<HTMLElement>("[data-msg]")!;
    if (msgEl.textContent === "已保存") {
      for (const sel of ["[data-label]", "[data-baseurl]", "[data-username]", "[data-password]", "[data-bililabel]", "[data-bilicookie]"]) {
        ($(sel) as HTMLInputElement).value = "";
      }
    }
  } catch (err) {
    msg(err instanceof Error ? err.message : String(err));
  }
}

async function renderAdminUsers(user: UserState): Promise<void> {
  const $ = <T extends HTMLElement>(sel: string): T => modalEl!.querySelector<T>(sel)!;
  try {
    const res = await fetch("/api/admin/users", { headers: { Authorization: `Bearer ${user.token}` } });
    const body = (await res.json().catch(() => ({}))) as { users?: AdminUser[]; error?: string };
    if (!res.ok || !body.users) {
      msg(body.error ?? `HTTP ${res.status}`);
      return;
    }
    const listEl = $("[data-admin-list]");
    listEl.textContent = "";
    for (const u of body.users) {
      const row = el("div", { className: "provider-row" });
      const role = el("span", { className: "kind" }, u.role === "admin" ? "管理员" : "用户");
      const name = el("b", {}, u.username);
      const meta = el("span", { className: "url" }, `${u.providerCount} 个 provider`);
      row.append(role, name, meta);
      const reset = el("button", {}, "重置密码");
      reset.addEventListener("click", () => {
        const pw = prompt(`为 ${u.username} 设置新密码（至少 4 位）：`);
        if (!pw) return;
        void (async () => {
          const r = await fetch(`/api/admin/users/${encodeURIComponent(u.username)}/password`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${user.token}` },
            body: JSON.stringify({ password: pw }),
          });
          const b = (await r.json().catch(() => ({}))) as { error?: string };
          msg(r.ok ? `已重置 ${u.username} 的密码` : (b.error ?? `HTTP ${r.status}`));
        })();
      });
      row.appendChild(reset);
      if (u.username !== user.username) {
        const del = el("button", { className: "danger" }, "删除");
        del.addEventListener("click", () => {
          if (!confirm(`确定删除账户 ${u.username}？其凭据与会话将立即失效。`)) return;
          void (async () => {
            const r = await fetch(`/api/admin/users/${encodeURIComponent(u.username)}`, {
              method: "DELETE",
              headers: { Authorization: `Bearer ${user.token}` },
            });
            const b = (await r.json().catch(() => ({}))) as { error?: string };
            msg(r.ok ? `已删除 ${u.username}` : (b.error ?? `HTTP ${r.status}`));
            if (r.ok) void renderAdminUsers(user);
          })();
        });
        row.appendChild(del);
      }
      listEl.appendChild(row);
    }
  } catch (err) {
    msg(err instanceof Error ? err.message : String(err));
  }
}

async function onCreateUser(): Promise<void> {
  const $ = <T extends HTMLElement>(sel: string): T => modalEl!.querySelector<T>(sel)!;
  const user = loadUser();
  if (!user) return;
  msg("");
  const username = ($("[data-new-username]") as HTMLInputElement).value.trim();
  const password = ($("[data-new-password]") as HTMLInputElement).value;
  try {
    const res = await fetch("/api/admin/users", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${user.token}` },
      body: JSON.stringify({ username, password }),
    });
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) {
      msg(body.error ?? `HTTP ${res.status}`);
      return;
    }
    msg(`已创建账户 ${username}`);
    ($("[data-new-username]") as HTMLInputElement).value = "";
    ($("[data-new-password]") as HTMLInputElement).value = "";
    void renderAdminUsers(user);
  } catch (err) {
    msg(err instanceof Error ? err.message : String(err));
  }
}
