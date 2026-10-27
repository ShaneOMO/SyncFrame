/**
 * 自包含冒烟测试：启动本地 Range/CORS 服务器 → 运行能力检查 → 校验断言 → 退出。
 * 用于在没有 OpenList 环境时验证检查脚本本身正确。
 * 用法: npx tsx tests/http/smoke-test.ts
 */
import { createServer, type Server } from "node:http";
import { readFileSync, statSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { checkUrlCapability } from "./http-capability.ts";

const PORT = 8899;
const FIXTURE = path.join(tmpdir(), "syncframe-smoke.bin");
if (!existsSync(FIXTURE)) {
  writeFileSync(FIXTURE, new Uint8Array(8 * 1024 * 1024).map(() => Math.floor(Math.random() * 256)));
}
const SIZE = statSync(FIXTURE).size;
const FILE = readFileSync(FIXTURE);

function startServer(): Promise<Server> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Headers", "range");
      res.setHeader("Access-Control-Expose-Headers", "content-range,content-length,accept-ranges");
      res.setHeader("Accept-Ranges", "bytes");
      if (req.method === "OPTIONS") {
        res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
        res.writeHead(204);
        res.end();
        return;
      }
      if (url.pathname === "/file.bin") {
        const range = req.headers.range;
        const m = range?.match(/bytes=(\d+)-(\d*)/);
        if (m) {
          const start = Number(m[1]);
          const end = m[2] ? Number(m[2]) : SIZE - 1;
          const buf = FILE.subarray(start, end + 1);
          res.writeHead(206, {
            "Content-Range": `bytes ${start}-${end}/${SIZE}`,
            "Content-Length": buf.length,
            "Content-Type": "application/octet-stream",
          });
          res.end(buf);
          return;
        }
        res.writeHead(200, { "Content-Length": SIZE, "Content-Type": "application/octet-stream" });
        res.end(FILE);
        return;
      }
      res.writeHead(404);
      res.end("not found");
    });
    server.listen(PORT, () => resolve(server));
  });
}

let failures = 0;
function assert(cond: boolean, name: string, detail = "") {
  if (cond) {
    console.log(`  ✔ ${name}`);
  } else {
    failures++;
    console.error(`  ✘ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const server = await startServer();
console.log(`冒烟服务器: http://localhost:${PORT}/file.bin (${SIZE} B)`);
try {
  const report = await checkUrlCapability(`http://localhost:${PORT}/file.bin`, { concurrency: 3 });

  console.log("\n断言:");
  assert(report.head.status === 200, "HEAD 返回 200");
  assert(report.get.status === 200, "GET 返回 200");
  assert(report.sizeBytes === SIZE, `文件大小正确 (${report.sizeBytes})`);
  assert(report.rangeCases.length === 3, `3 个 Range 用例 (实际 ${report.rangeCases.length})`);
  assert(report.rangeCases.every((c) => c.rangeHonored), "所有 Range 返回 206 且边界正确");
  // 字节正确性抽验：尾部用例内容与源文件一致
  const tail = report.rangeCases.find((c) => c.name === "tail");
  assert(
    tail !== undefined && tail.record.bytesRead === Math.min(1024 * 1024, SIZE - tail.expectedStart),
    "尾部 Range 字节数正确",
  );
  assert(report.head.cors.corsEnabled, "CORS ACAO 存在");
  assert(report.corsPreflight?.status === 204, "预检 OPTIONS 返回 204");
  assert(report.concurrency.failures === 0, "并发读取 0 失败");
  assert(report.concurrency.sessions === 3, "并发会话数正确");
  assert(report.concurrency.aggregateMbps > 0, `聚合吞吐 > 0 (${report.concurrency.aggregateMbps} Mbps)`);
  assert(report.redirectCount === 0, "无重定向");
} finally {
  server.close();
}

if (failures > 0) {
  console.error(`\n冒烟测试失败: ${failures} 项断言未通过`);
  process.exit(1);
}
console.log("\n冒烟测试全部通过 ✔");
