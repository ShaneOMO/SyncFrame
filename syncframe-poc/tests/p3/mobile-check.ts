/** 移动端适配检查：iPhone 尺寸视口渲染大厅/房间页，输出横向溢出诊断。 */
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { existsSync } from "node:fs";
import { chromium } from "playwright-core";
import { ADMIN_PASS, ADMIN_USER, repoRoot } from "./room-api.ts";

const BACKEND_PORT = 8950;
const WEB_PORT = 5950;
const children: ChildProcess[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitHttp(url: string, timeoutMs = 20_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { if ((await fetch(url)).ok) return; } catch { /* retry */ }
    await sleep(250);
  }
  throw new Error(`等待超时: ${url}`);
}

async function diagnose(page: import("playwright-core").Page, label: string): Promise<void> {
  const metrics = await page.evaluate(() => {
    const doc = document.documentElement;
    const offenders: string[] = [];
    const vw = doc.clientWidth;
    for (const el of document.querySelectorAll<HTMLElement>("body *")) {
      const r = el.getBoundingClientRect();
      if (r.width > vw + 1 || r.right > vw + 1) {
        const desc = `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}${el.className && typeof el.className === "string" ? `.${el.className.split(" ")[0]}` : ""} w=${Math.round(r.width)} right=${Math.round(r.right)}`;
        if (!offenders.includes(desc)) offenders.push(desc);
      }
    }
    return {
      vw,
      scrollW: doc.scrollWidth,
      overflow: doc.scrollWidth > vw + 1,
      offenders: offenders.slice(0, 12),
    };
  });
  console.log(`\n[${label}] vw=${metrics.vw} scrollWidth=${metrics.scrollW} 横向溢出=${metrics.overflow}`);
  for (const o of metrics.offenders) console.log(`   溢出元素: ${o}`);
}

async function main(): Promise<void> {
  const server = spawn(process.execPath, ["--import", "tsx", "apps/server/src/index.ts"], {
    cwd: repoRoot,
    env: { ...process.env, SERVER_PORT: String(BACKEND_PORT), DATA_DIR: path.join(process.env.TEMP ?? "/tmp", `syncframe-mobile-${Date.now()}`), ADMIN_USERNAME: ADMIN_USER, ADMIN_PASSWORD: ADMIN_PASS },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stderr?.on("data", (d) => process.stderr.write(d));
  children.push(server);
  const vite = spawn(process.execPath, [path.join(repoRoot, "node_modules/vite/bin/vite.js"), "--port", String(WEB_PORT), "--strictPort"], {
    cwd: path.join(repoRoot, "apps/web"),
    env: { ...process.env, SYNC_BACKEND_PORT: String(BACKEND_PORT) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(vite);
  try {
    await waitHttp(`http://localhost:${BACKEND_PORT}/api/health`);
    await waitHttp(`http://localhost:${WEB_PORT}/lobby.html`);

    const executablePath = [
      "C:/Program Files/Google/Chrome/Application/chrome.exe",
      "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
      "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
      "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
    ].find((p) => existsSync(p));
    if (!executablePath) throw new Error("未找到系统 Chrome/Edge");

    const browser = await chromium.launch({ executablePath, headless: true });
    const ctx = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 3,
      isMobile: true,
      hasTouch: true,
      userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
    });
    const page = await ctx.newPage();
    const web = `http://localhost:${WEB_PORT}`;

    // 大厅页（未登录 / 登录弹窗 / provider 面板）
    await page.goto(`${web}/lobby.html`, { waitUntil: "networkidle" });
    await sleep(400);
    await page.screenshot({ path: "/tmp/m-lobby.png", fullPage: false });
    await diagnose(page, "大厅");
    await page.click("#loginBtn");
    await sleep(300);
    await page.screenshot({ path: "/tmp/m-lobby-login.png" });
    await diagnose(page, "大厅-登录弹窗");

    // 登录管理员并进房间（clock 模式避免媒体依赖）；注册已关闭，账户由管理员创建
    await page.fill("#authUsername", ADMIN_USER);
    await page.fill("#authPassword", ADMIN_PASS);
    await page.click("#authSubmit");
    await sleep(600);
    await page.click("#loginBtn"); // 用户名按钮 → 账户设置（provider 管理）
    await sleep(500);
    await page.screenshot({ path: "/tmp/m-lobby-provider.png" });
    await diagnose(page, "大厅-账户设置弹窗");
    await page.click("#userSettingsModal [data-close]");
    await page.fill("#createName", "移动端房主");
    await page.click("#createBtn");
    await page.waitForURL(/room\.html/, { timeout: 10_000 });
    await page.evaluate(() => { const u = new URL(location.href); u.searchParams.set("mode", "clock"); location.href = u.toString(); });
    await page.waitForLoadState("networkidle");
    await sleep(800);
    await page.screenshot({ path: "/tmp/m-room-clock.png" });
    await diagnose(page, "房间-clock（观众态无添加影片入口）");

    // 房主态：重新开房（host 会话），展示添加影片弹窗 / 播放列表
    await page.goto(`${web}/lobby.html`, { waitUntil: "networkidle" });
    await sleep(300);
    await page.fill("#createName", "房主A");
    await page.click("#createBtn");
    await page.waitForURL(/room\.html/, { timeout: 10_000 });
    await page.waitForLoadState("networkidle");
    await sleep(600);
    await page.screenshot({ path: "/tmp/m-room-host.png" });
    await diagnose(page, "房间-房主态");
    await page.click("#addMediaBtn");
    await sleep(300);
    await page.screenshot({ path: "/tmp/m-room-addcard.png" });
    await diagnose(page, "房间-添加影片弹窗(直链)");

    await browser.close();
  } finally {
    for (const c of children) c.kill("SIGKILL");
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
