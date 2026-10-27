/**
 * P0 检查入口 A：对任意 URL 直接执行 HTTP 能力检查。
 * 用法：
 *   npm run p0:check -- <url1> [url2 ...]
 * 或：
 *   npx tsx tests/http/check-http.ts <url>
 * 原始 JSON 报告写入 reports/http-raw/。
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { checkUrlCapability, printReportSummary, type UrlCapabilityReport } from "./http-capability.ts";

const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const concurrencyFlag = process.argv.find((a) => a.startsWith("--concurrency="));
const concurrency = concurrencyFlag ? Number(concurrencyFlag.split("=")[1]) : Number(process.env.CHECK_CONCURRENCY ?? 5);

if (args.length === 0) {
  console.error("用法: npm run p0:check -- <文件URL> [更多URL...] [--concurrency=N]");
  console.error("示例: npm run p0:check -- \"http://192.168.1.10:5244/d/movies/a.mkv\"");
  process.exit(1);
}

const rawDir = path.resolve(process.cwd(), "reports/http-raw");
await mkdir(rawDir, { recursive: true });

for (const url of args) {
  console.log(`\n开始检查: ${url.replace(/\?.*$/, "?<redacted>")}`);
  try {
    const report = await checkUrlCapability(url, { concurrency });
    printReportSummary(report);
    const file = path.join(rawDir, `check-${Date.now()}.json`);
    await writeFile(file, JSON.stringify(report, null, 2), "utf-8");
    console.log(`原始记录: ${file}`);
  } catch (err) {
    console.error(`检查失败: ${err instanceof Error ? err.message : err}`);
  }
}
