/**
 * P3 大厅 UI 冒烟：真实 Vite + 服务端，Playwright 驱动浏览器验证
 * 「创建房间 → 跳转房间页 → WS 连接 → 成员/邀请码展示」全链路。
 * 运行：node --import tsx tests/p3/lobby-ui-smoke.ts
 */

import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { chromium } from "playwright-core";
import { startOpenListStub } from "./openlist-stub.ts";
import { ADMIN_PASS, ADMIN_USER, createRoom, joinRoom, repoRoot } from "./room-api.ts";

const BACKEND_PORT = 8940;
const STUB_PORT = 8941;
const WEB_PORT = 5940;
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

async function main(): Promise<void> {
  console.log("\n=== P3 大厅 UI 冒烟 ===\n");
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
  await waitHttp(`http://localhost:${WEB_PORT}/lobby.html`);

  const executablePath = [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  ].find((p) => existsSync(p));
  if (!executablePath) throw new Error("未找到系统 Chrome/Edge");

  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    // 场景 1：房主创建房间 → 房间页 → 选片面板加载 → 邀请码展示
    const ctx1 = await browser.newContext();
    const host = await ctx1.newPage();
    const consoleErrors: string[] = [];
    host.on("console", (m) => {
      if (m.type() === "error") consoleErrors.push(m.text());
    });
    await host.goto(`http://localhost:${WEB_PORT}/lobby.html`, { waitUntil: "domcontentloaded" });
    check("大厅页加载无 JS 错误", consoleErrors.length === 0, consoleErrors.join(" | "));
    // 未登录：创建房间被隐藏，只能加入房间
    check("游客态隐藏创建房间表单", await host.locator("#createForm").isHidden());
    check("游客态显示登录提示", await host.locator("#createGate").isVisible());
    // 登录管理员并在弹窗里配置 OpenList provider（指向桩）
    await host.click("#loginBtn");
    await host.fill("#authUsername", ADMIN_USER);
    await host.fill("#authPassword", ADMIN_PASS);
    await host.click("#authSubmit");
    await host.waitForSelector("#providerPanel:not([hidden])", { timeout: 10_000 });
    check("登录后显示 provider 面板", true);
    check("管理员显示账户管理面板", await host.locator("#adminPanel").isVisible());
    await host.selectOption("#pKind", "openlist");
    await host.fill("#pLabel", "桩");
    await host.fill("#pBaseUrl", `http://localhost:${STUB_PORT}`);
    await host.fill("#pUsername", "stub");
    await host.fill("#pPassword", "stub");
    await host.click("#pAdd");
    await host.waitForFunction(() => document.querySelector("#providerMsg")?.textContent === "已保存", { timeout: 10_000 });
    check("添加 OpenList provider", true);
    await host.click("#authClose");
    await host.fill("#createName", "UI房主");
    await host.click("#createBtn");
    await host.waitForURL(/room\.html\?room=/, { timeout: 30_000 });
    const roomUrl = new URL(host.url());
    const roomId = roomUrl.searchParams.get("room") ?? "";
    check("创建后跳转房间页", roomUrl.pathname === "/room.html" && roomId.length === 6);
    await host.waitForFunction(
      () => {
        const s = (window as unknown as { __sync?: { sample: () => { connected: boolean; role: string } } }).__sync;
        return s && s.sample().connected && s.sample().role === "host";
      },
      { timeout: 15_000 },
    );
    check("房主 WS 已连接", true);
    const invite = await host.evaluate(() => sessionStorage.getItem(`syncframe-invite-${new URL(location.href).searchParams.get("room")}`) ?? "");
    check("邀请码已存会话（6 位）", /^[A-Z2-9]{6}$/.test(invite), invite);
    check("选片面板对房主可见", await host.locator("#browseCard").isVisible());
    check("浏览面板含 provider 选择器", (await host.locator("#browseProvider option").allTextContents()).some((t) => t.includes("桩")));
    await host.waitForSelector("#browseList .browse-row", { timeout: 10_000 });
    check("目录列表已加载（根目录含 movies）", (await host.locator("#browseList .browse-row").allTextContents()).join(" ").includes("movies"));

    // 场景 2：观众点开邀请链接自动进房（无需手动输入邀请码）→ 无选片面板 → 成员列表出现
    const ctx2 = await browser.newContext();
    const viewer = await ctx2.newPage();
    await viewer.goto(`http://localhost:${WEB_PORT}/lobby.html?room=${roomId}&key=${invite}&name=${encodeURIComponent("UI观众")}`, { waitUntil: "domcontentloaded" });
    // 链接形态：房主页邀请链接输入框应包含 room 与 key
    const inviteLinkVal = await host.locator("#inviteLink").inputValue();
    check(
      "房主邀请链接携带 room+key",
      inviteLinkVal.includes(`room=${roomId}`) && inviteLinkVal.includes(`key=${invite}`),
      inviteLinkVal,
    );
    await viewer.waitForURL(/room\.html\?room=/, { timeout: 30_000 });
    await viewer.waitForFunction(
      () => {
        const s = (window as unknown as { __sync?: { sample: () => { connected: boolean; role: string } } }).__sync;
        return s && s.sample().connected && s.sample().role === "viewer";
      },
      { timeout: 15_000 },
    );
    check("观众 WS 已连接（viewer 角色）", true);
    check("观众无选片面板", await viewer.locator("#browseCard").isHidden());
    await sleep(800);
    const memberText = await host.locator("#members").innerText();
    check("房主看到观众成员", memberText.includes("UI观众"), memberText.replace(/\n/g, " "));

    // 场景 3：房主进入 /movies 选片 → 双方都收到媒体状态
    await host.click("#browseList .browse-row:has-text('movies')");
    await host.waitForSelector("#browseList .browse-row.video", { timeout: 10_000 });
    await host.click("#browseList .browse-row.video >> nth=0");
    // 房主无回声（服务端不回显发送者）：以媒体徽标 + 观众端 appliedMediaId 为准
    await host.waitForFunction(
      () => document.querySelector("#mediaBadge")?.textContent?.startsWith("就绪"),
      { timeout: 20_000 },
    );
    check("房主媒体载入就绪", true);
    const viewerMedia = await viewer.waitForFunction(
      () => {
        const s = (window as unknown as { __sync: { sample: () => { appliedMediaId: string } } }).__sync;
        return s.sample().appliedMediaId;
      },
      { timeout: 15_000 },
    );
    check("观众同步收到 mediaId", String(await viewerMedia.jsonValue()).startsWith("m_"));
    check("观众媒体徽标就绪", (await viewer.locator("#mediaBadge").innerText()).startsWith("就绪"));

    console.log(failures === 0 ? "\n大厅 UI 冒烟通过 ✔" : `\n${failures} 项失败 ✘`);
    process.exitCode = failures === 0 ? 0 : 1;
  } finally {
    await browser.close().catch(() => {});
    for (const c of children) c.kill();
    await stub.close();
  }
}

void main();
