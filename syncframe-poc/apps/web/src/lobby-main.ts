/**
 * P3 大厅页：创建房间 / 凭邀请码加入房间。
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
