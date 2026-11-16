/**
 * P3 大厅 UI 冒烟（React 版）：真实 Vite + 服务端，Playwright 驱动浏览器验证
 * 「登录 → 配置 OpenList → 创建房间 → 邀请链接自动进房 → 选片同步」全链路。
 * 选择器基于 React 版 DOM（角色/文本/placeholder），运行：node --import tsx tests/p3/lobby-ui-smoke.ts
 */

import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { existsSync } from "node:fs";
import { chromium, type Page } from "playwright-core";
import { startOpenListStub } from "./openlist-stub.ts";
import { ADMIN_PASS, ADMIN_USER, createUserAsAdmin, loginUser, postJson, repoRoot } from "./room-api.ts";

const BACKEND_PORT = 8940;
const STUB_PORT = 8941;
const WEB_PORT = 5940;
const WEB = `http://localhost:${WEB_PORT}`;
const children: ChildProcess[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  console.log(`  [${cond ? "PASS" : "FAIL"}] ${name}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
}

async function waitHttp(url: string, timeoutMs = 20_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      if ((await fetch(url)).ok) return;
    } catch { /* retry */ }
    await sleep(250);
  }
  throw new Error(`等待超时: ${url}`);
}

/** 等待房间页 __sync 测试句柄连接成功且角色匹配。 */
async function waitSyncRole(page: Page, role: "host" | "viewer"): Promise<void> {
  await page.waitForFunction(
    (r) => {
      const s = (window as unknown as { __sync?: { sample: () => { connected: boolean; role: string } } }).__sync;
      return Boolean(s && s.sample().connected && s.sample().role === r);
    },
    role,
    { timeout: 15_000 },
  );
}

async function main(): Promise<void> {
  console.log("\n=== P3 大厅 UI 冒烟（React 版） ===\n");
  const stub = await startOpenListStub(STUB_PORT);
  const server = spawn(process.execPath, ["--import", "tsx", "apps/server/src/index.ts"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      SERVER_PORT: String(BACKEND_PORT),
      DATA_DIR: path.join(process.env.TEMP ?? "/tmp", `syncframe-ui-${Date.now()}`),
      ADMIN_USERNAME: ADMIN_USER,
      ADMIN_PASSWORD: ADMIN_PASS,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stderr?.on("data", (d) => process.stderr.write(d));
  children.push(server);
  const vite = spawn(process.execPath, [path.join(repoRoot, "node_modules/vite/bin/vite.js"), "--port", String(WEB_PORT), "--strictPort"], {
    cwd: path.join(repoRoot, "apps/web"),
    env: { ...process.env, SYNC_BACKEND_PORT: String(BACKEND_PORT) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  vite.stderr?.on("data", (d) => process.stderr.write(d));
  children.push(vite);
  await waitHttp(`http://localhost:${BACKEND_PORT}/api/health`);
  await waitHttp(`${WEB}/lobby.html`);
  const adminToken = await loginUser(`http://localhost:${BACKEND_PORT}`, ADMIN_USER, ADMIN_PASS);
  await createUserAsAdmin(`http://localhost:${BACKEND_PORT}`, adminToken, "member1", "memberpw123");

  const executablePath = [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  ].find((p) => existsSync(p));
  if (!executablePath) throw new Error("未找到系统 Chrome/Edge");

  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    // ── 场景 1：房主链路 ─────────────────────────────
    const ctx1 = await browser.newContext();
    const host = await ctx1.newPage();
    const consoleErrors: string[] = [];
    host.on("console", (m) => {
      if (m.type() === "error") consoleErrors.push(m.text());
    });
    await host.goto(`${WEB}/lobby.html`, { waitUntil: "domcontentloaded" });
    await host.getByRole("button", { name: "创建房间" }).first().waitFor();
    check("大厅页加载无 JS 错误", consoleErrors.length === 0, consoleErrors.join(" | "));

    // 未登录点「创建房间」→ 弹出登录框（游客只能加入房间）
    await host.getByRole("button", { name: "创建房间" }).first().click();
    const authDialog = host.getByRole("dialog");
    await authDialog.getByRole("heading", { name: "登录" }).waitFor();
    check("游客态创建房间弹出登录框", true);
    await host.keyboard.press("Escape");

    // 登录管理员
    await host.getByRole("button", { name: "登录", exact: true }).click();
    await authDialog.getByLabel("用户名").fill(ADMIN_USER);
    await authDialog.getByLabel("密码").fill(ADMIN_PASS);
    await authDialog.getByRole("button", { name: "登录", exact: true }).click();
    await host.getByRole("button", { name: ADMIN_USER }).waitFor({ timeout: 10_000 });
    check("登录后顶栏显示用户名", true);
    check("管理员显示用户管理入口", await host.getByRole("button", { name: "用户管理" }).isVisible());

    // 账户设置：添加 OpenList provider（指向桩）
    await host.getByRole("button", { name: ADMIN_USER }).click();
    await host.waitForURL(/settings\.html/, { timeout: 10_000 });
    await host.getByRole("button", { name: "用户管理" }).waitFor();
    check("账户设置页打开（管理员含用户管理页签）", true);
    await host.getByPlaceholder("名称（如：家里 OpenList）").fill("桩");
    await host.getByPlaceholder("https://openlist.example.com").fill(`http://localhost:${STUB_PORT}`);
    await host.getByPlaceholder("OpenList 用户名").fill("stub");
    await host.getByPlaceholder("OpenList 密码").fill("stub");
    await host.getByRole("button", { name: "添加", exact: true }).click();
    await host.getByText("已保存").waitFor({ timeout: 10_000 });
    check("添加 OpenList provider", true);

    // 回大厅创建房间
    await host.getByRole("button", { name: "← 返回大厅" }).click();
    await host.waitForURL(/lobby\.html/, { timeout: 10_000 });
    await host.getByRole("main").getByRole("button", { name: "创建房间" }).click();
    const createDialog = host.getByRole("dialog");
    await createDialog.getByLabel(/房间名/).fill("UI房间");
    await createDialog.getByRole("button", { name: "创建房间" }).click();
    await host.waitForURL(/room\.html\?room=/, { timeout: 30_000 });
    const roomUrl = new URL(host.url());
    const roomId = roomUrl.searchParams.get("room") ?? "";
    check("创建后跳转房间页", roomUrl.pathname === "/room.html" && /^[0-9a-f-]{36}$/.test(roomId), `roomId=${roomId}`);
    await waitSyncRole(host, "host");
    check("房主 WS 已连接", true);
    check("房主显示账户名而不是房间名", (await host.locator("body").innerText()).includes(`${ADMIN_USER} · 房主`));
    check("内部 GUID 不在房间界面展示", !(await host.locator("body").innerText()).includes(roomId));
    const invite = await host.evaluate(() => sessionStorage.getItem(`syncframe-invite-${new URL(location.href).searchParams.get("room")}`) ?? "");
    check("邀请码已存会话（8 位）", /^[A-Z2-9]{8}$/.test(invite), invite);

    // 邀请链接携带 room+key
    await host.getByRole("button", { name: "邀请" }).click();
    const inviteLinkVal = await host.locator("#invite-link").inputValue();
    check(
      "房主邀请链接携带 room+key",
      inviteLinkVal.includes(`room=${roomId}`) && inviteLinkVal.includes(`key=${invite}`),
      inviteLinkVal,
    );

    // 添加影片弹窗：OpenList 媒体库页签 + 目录浏览
    await host.getByRole("button", { name: "＋ 添加影片" }).click();
    const mediaDialog = host.getByRole("dialog");
    await mediaDialog.getByRole("tab", { name: "OpenList 媒体库" }).click();
    await mediaDialog.getByText("桩").first().waitFor();
    check("浏览面板含 provider（桩）", true);
    await mediaDialog.getByText("movies", { exact: true }).waitFor({ timeout: 10_000 });
    check("目录列表已加载（根目录含 movies）", true);

    // ── 场景 2：游客点开邀请链接自动进房 ──────────────
    const ctx2 = await browser.newContext();
    const viewer = await ctx2.newPage();
    await viewer.goto(`${WEB}/lobby.html?room=${roomId}&key=${invite}&name=${encodeURIComponent("UI观众")}`, { waitUntil: "domcontentloaded" });
    await viewer.waitForURL(/room\.html\?room=/, { timeout: 30_000 });
    await waitSyncRole(viewer, "viewer");
    check("游客经邀请链接自动进房（viewer 角色）", true);
    check("游客身份明确显示", (await viewer.locator("body").innerText()).includes("UI观众 · 游客"));
    check("观众无添加影片入口", (await viewer.getByRole("button", { name: "＋ 添加影片" }).count()) === 0);
    await sleep(800);
    check("房主看到观众成员", (await host.locator("body").innerText()).includes("UI观众"));

    // ── 场景 3：登录成员从大厅加入，不得显示为游客 ──────
    const ctx3 = await browser.newContext();
    const member = await ctx3.newPage();
    await member.goto(`${WEB}/lobby.html`, { waitUntil: "domcontentloaded" });
    await member.getByRole("button", { name: "登录", exact: true }).click();
    const memberAuth = member.getByRole("dialog");
    await memberAuth.getByLabel("用户名").fill("member1");
    await memberAuth.getByLabel("密码").fill("memberpw123");
    await memberAuth.getByRole("button", { name: "登录", exact: true }).click();
    await member.getByRole("button", { name: "member1", exact: true }).waitFor();
    await member.locator("div.border-b", { hasText: "UI房间" }).getByRole("button", { name: "立即加入" }).click();
    const memberJoin = member.getByRole("dialog");
    check("登录成员加入时锁定账户身份", await memberJoin.getByLabel("登录身份").isDisabled());
    check("加入表单不包含房间号", (await memberJoin.locator("#join-room").count()) === 0);
    await memberJoin.getByLabel("邀请码").fill(invite);
    await memberJoin.getByRole("button", { name: "加入房间" }).click();
    await member.waitForURL(/room\.html\?room=/, { timeout: 30_000 });
    await waitSyncRole(member, "viewer");
    check("登录成员显示为成员而非游客", (await member.locator("body").innerText()).includes("member1 · 登录成员"));
    await sleep(800);
    check("房主名册将登录成员标记为成员", /member1\s*·\s*成员/.test(await host.locator("body").innerText()));

    // ── 场景 4：房主选片 → 双方都收到媒体状态 ─────────
    await mediaDialog.getByText("movies", { exact: true }).click();
    await mediaDialog.getByText("a.mkv", { exact: true }).waitFor({ timeout: 10_000 });
    await mediaDialog.locator("div.border-b", { hasText: "a.mkv" }).getByRole("button", { name: "添加" }).click();
    // 房主无回声（服务端不回显发送者）：以媒体徽标 + 观众端 appliedMediaId 为准
    await host.getByText(/^就绪/).first().waitFor({ timeout: 20_000 });
    check("房主媒体载入就绪", true);
    const viewerMedia = await viewer.waitForFunction(
      () => {
        const s = (window as unknown as { __sync: { sample: () => { appliedMediaId: string } } }).__sync;
        return s.sample().appliedMediaId;
      },
      { timeout: 15_000 },
    );
    check("观众同步收到 mediaId", String(await viewerMedia.jsonValue()).startsWith("m_"));
    await viewer.getByText(/^就绪/).first().waitFor({ timeout: 10_000 });
    check("观众媒体徽标就绪", true);

    // ── 场景 5：公开房间和房主本人加入均不弹窗 ─────────
    const backend = `http://localhost:${BACKEND_PORT}`;
    const publicRoom = await postJson(backend, "/api/rooms", { name: "公开房间", noInvite: true }, adminToken);
    check("创建无邀请码公开房间", publicRoom.status === 200);
    const ctx4 = await browser.newContext();
    const publicGuest = await ctx4.newPage();
    await publicGuest.goto(`${WEB}/lobby.html`, { waitUntil: "domcontentloaded" });
    await publicGuest.locator("div.border-b", { hasText: "公开房间" }).getByRole("button", { name: "立即加入" }).click();
    await publicGuest.waitForURL(/room\.html\?room=/, { timeout: 30_000 });
    await waitSyncRole(publicGuest, "viewer");
    check("公开房间直接进入且不弹窗", (await publicGuest.getByRole("dialog").count()) === 0);

    await host.goto(`${WEB}/lobby.html`, { waitUntil: "domcontentloaded" });
    await host.locator("div.border-b", { hasText: "UI房间" }).getByRole("button", { name: "立即加入" }).click();
    await host.waitForURL(/room\.html\?room=/, { timeout: 30_000 });
    await waitSyncRole(host, "host");
    check("房主重新加入无需邀请码或弹窗", (await host.getByRole("dialog").count()) === 0);

    console.log(failures === 0 ? "\n大厅 UI 冒烟通过 ✔" : `\n${failures} 项失败 ✘`);
    process.exitCode = failures === 0 ? 0 : 1;
  } finally {
    await browser.close().catch(() => {});
    for (const c of children) c.kill();
    await stub.close();
  }
}

void main();
