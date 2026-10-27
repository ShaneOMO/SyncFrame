/**
 * P0 检查入口 B：完整 OpenList 探测链路。
 * 流程：
 *  1. 登录 OpenList 并验证令牌（me）
 *  2. 列出测试目录，输出目录信息（数量、大小范围）
 *  3. 选定测试文件（env 指定或自动选第一个视频文件）
 *  4. 获取文件详情：raw_url、related、签名、大小
 *  5. 分别对「OpenList 代理地址 /d<path>」和「raw_url 直链」执行 HTTP 能力检查
 *  6. 原始记录全部写入 reports/http-raw/
 *
 * 用法：复制 .env.example 为 .env 并填写后：
 *   npm run p0:probe
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { OpenListClient, OpenListAdapterError } from "@syncframe/openlist-adapter";
import { checkUrlCapability, isVideoFile, printReportSummary, type UrlCapabilityReport } from "./http-capability.ts";

function requiredEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`缺少环境变量 ${name}，请参照 .env.example 配置 .env`);
    process.exit(1);
  }
  return v;
}

const baseUrl = requiredEnv("OPENLIST_BASE_URL");
const username = requiredEnv("OPENLIST_USERNAME");
const password = requiredEnv("OPENLIST_PASSWORD");
const testDir = process.env.OPENLIST_TEST_DIR ?? "/";
const testFileEnv = process.env.OPENLIST_TEST_FILE ?? "";
const concurrency = Number(process.env.CHECK_CONCURRENCY ?? 5);

const rawDir = path.resolve(process.cwd(), "reports/http-raw");
await mkdir(rawDir, { recursive: true });

const client = new OpenListClient({ baseUrl, timeoutMs: 15_000 });

// ── 1. 登录 ──────────────────────────────────────────────
console.log(`[1/5] 登录 ${baseUrl} ...`);
try {
  await client.login(username, password);
} catch (err) {
  if (err instanceof OpenListAdapterError) {
    console.error(`登录失败: [${err.kind}] ${err.message}`);
  } else {
    console.error(`登录失败: ${err}`);
  }
  process.exit(1);
}
console.log("  登录成功");

// ── 2. 验证令牌 ─────────────────────────────────────────
console.log("[2/5] 验证令牌 (me) ...");
try {
  const me = await client.me();
  console.log(`  当前用户: ${me.username} (role=${me.role}, base_path=${me.base_path})`);
} catch (err) {
  console.warn(`  me 接口失败（不阻塞）: ${err instanceof Error ? err.message : err}`);
}

// ── 3. 列目录 ───────────────────────────────────────────
console.log(`[3/5] 列出目录 ${testDir} ...`);
let testPath = testFileEnv;
try {
  const list = await client.listDir(testDir, { page: 1, perPage: 100 });
  const items = list.content ?? [];
  const videos = items.filter((i) => !i.is_dir && isVideoFile(i.name));
  const dirs = items.filter((i) => i.is_dir);
  console.log(`  目录共 ${items.length} 项（子目录 ${dirs.length}，视频文件 ${videos.length}）`);
  for (const v of videos.slice(0, 10)) {
    console.log(`    视频: ${v.name}  (${(v.size / 1024 / 1024).toFixed(1)} MiB)`);
  }
  if (videos.length > 10) console.log(`    ... 另有 ${videos.length - 10} 个视频文件`);
  if (!testPath) {
    // 当前目录没有视频时下钻子目录搜索（最多 2 层，每层最多看 50 个子目录）
    let found: { path: string; name: string; size: number }[] = [];
    if (videos.length === 0) {
      console.log("  当前目录无视频文件，正在搜索子目录（最多 2 层）...");
      const joinPath = (dir: string, name: string) =>
        `${dir.endsWith("/") ? dir : `${dir}/`}${name}`;
      const queue: { path: string; depth: number }[] = dirs
        .slice(0, 50)
        .map((d) => ({ path: joinPath(testDir, d.name), depth: 1 }));
      while (queue.length > 0) {
        const cur = queue.shift()!;
        try {
          const sub = await client.listDir(cur.path, { page: 1, perPage: 100 });
          const subItems = sub.content ?? [];
          for (const i of subItems) {
            if (!i.is_dir && isVideoFile(i.name)) {
              found.push({ path: joinPath(cur.path, i.name), name: i.name, size: i.size });
            }
          }
          if (cur.depth < 2 && found.length === 0) {
            for (const d of subItems.filter((i) => i.is_dir).slice(0, 50)) {
              queue.push({ path: joinPath(cur.path, d.name), depth: cur.depth + 1 });
            }
          }
        } catch {
          // 无权限或读取失败的子目录直接跳过
        }
        if (found.length >= 10) break;
      }
      if (found.length > 0) {
        console.log(`  子目录中找到 ${found.length} 个视频文件:`);
        for (const f of found.slice(0, 10)) {
          console.log(`    ${f.path}  (${(f.size / 1024 / 1024).toFixed(1)} MiB)`);
        }
      }
    } else {
      found = videos.map((v) => ({
        path: `${testDir.endsWith("/") ? testDir : `${testDir}/`}${v.name}`,
        name: v.name,
        size: v.size,
      }));
    }
    if (found.length === 0) {
      console.error("未找到视频文件，请通过 OPENLIST_TEST_DIR / OPENLIST_TEST_FILE 指定");
      process.exit(1);
    }
    // 选中等大小的文件：避免极小测试文件或超大文件拖慢检查
    const sorted = [...found].sort((a, b) => a.size - b.size);
    testPath = sorted[Math.floor(sorted.length / 2)].path;
    console.log(`  自动选中测试文件: ${testPath}`);
  }
} catch (err) {
  console.error(`列目录失败: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
}

// ── 4. 文件详情 ─────────────────────────────────────────
console.log(`[4/5] 获取文件详情 ${testPath} ...`);
let detail;
try {
  detail = await client.getFile(testPath);
  console.log(`  大小: ${(detail.size / 1024 / 1024).toFixed(1)} MiB  provider: ${detail.provider ?? "-"}`);
  console.log(`  签名 sign: ${detail.sign ? `存在（${detail.sign.length} 字符）` : "无"}`);
  console.log(`  raw_url: ${detail.raw_url ? detail.raw_url.replace(/\?.*$/, "?<redacted>") : "（无）"}`);
  const related = detail.related ?? [];
  console.log(`  related 相关文件: ${related.length} 个${related.length ? `（${related.map((r) => r.name).slice(0, 5).join(", ")}${related.length > 5 ? "..." : ""}）` : ""}`);
  await writeFile(
    path.join(rawDir, `fs-get-${Date.now()}.json`),
    JSON.stringify(detail, null, 2),
    "utf-8",
  );
} catch (err) {
  console.error(`获取文件详情失败: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
}

// ── 5. HTTP 能力检查：代理地址 + 直链 ───────────────────
// OpenList 的 /d 代理地址需要带 fs/get 返回的 sign 签名参数
const proxyUrl = `${baseUrl.replace(/\/+$/, "")}/d${testPath.startsWith("/") ? "" : "/"}${testPath}${
  detail.sign ? `?sign=${encodeURIComponent(detail.sign)}` : ""
}`;
const targets: { label: string; url: string | null }[] = [
  { label: "OpenList 代理地址", url: proxyUrl },
  { label: "raw_url 实际存储直链", url: detail.raw_url ?? null },
];

const allReports: Record<string, UrlCapabilityReport> = {};
for (const t of targets) {
  if (!t.url) {
    console.log(`\n[5/5] 跳过 ${t.label}：无 URL`);
    continue;
  }
  console.log(`\n[5/5] 检查 ${t.label}: ${t.url.replace(/\?.*$/, "?<redacted>")}`);
  try {
    const report = await checkUrlCapability(t.url, { concurrency });
    printReportSummary(report);
    allReports[t.label] = report;
  } catch (err) {
    console.error(`  检查失败: ${err instanceof Error ? err.message : err}`);
  }
}

const summaryFile = path.join(rawDir, `probe-summary-${Date.now()}.json`);
await writeFile(summaryFile, JSON.stringify(allReports, null, 2), "utf-8");
console.log(`\n全部原始记录已写入: ${rawDir}`);
console.log(`汇总记录: ${summaryFile}`);

// ── 结论提示 ────────────────────────────────────────────
console.log("\n===== 初步路线判断（需人工确认）=====");
const proxyOk = allReports["OpenList 代理地址"];
const directOk = allReports["raw_url 实际存储直链"];
function routeUsable(r?: UrlCapabilityReport): boolean {
  if (!r) return false;
  const rangesOk = r.rangeCases.length > 0 && r.rangeCases.every((c) => c.rangeHonored);
  return rangesOk && r.concurrency.failures === 0;
}
const proxyCors = proxyOk?.head.cors.corsEnabled ?? false;
const directCors = directOk?.head.cors.corsEnabled ?? false;

if (routeUsable(proxyOk)) {
  console.log(`代理地址: Range 正常${proxyCors ? "，CORS 允许跨域" : "，但 CORS 不允许跨域（浏览器需走同源代理）"}`);
} else if (proxyOk) {
  console.log("代理地址: Range 检查未通过，详见上方用例");
}
if (routeUsable(directOk)) {
  console.log(`存储直链: Range 正常${directCors ? "，CORS 允许跨域，可优先直链" : "，但 CORS 不允许跨域（浏览器仍无法直接读取）"}`);
} else if (directOk) {
  console.log("存储直链: Range 检查未通过，详见上方用例");
}
