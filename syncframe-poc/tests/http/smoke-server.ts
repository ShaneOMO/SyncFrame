/**
 * 本地冒烟测试服务器：模拟一个支持 Range + CORS 的文件源，
 * 用于在没有 OpenList 环境时验证 check-http 检查脚本本身工作正常。
 * 用法: npx tsx tests/http/smoke-server.ts [端口]   默认 8899
 */
import { createServer } from "node:http";
import { readFileSync, statSync, existsSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { writeFileSync } from "node:fs";

const port = Number(process.argv[2] ?? 8899);

// 生成 8 MiB 随机测试文件
const fixturePath = path.join(tmpdir(), "syncframe-smoke.bin");
if (!existsSync(fixturePath)) {
  writeFileSync(fixturePath, new Uint8Array(8 * 1024 * 1024).map(() => Math.floor(Math.random() * 256)));
}
const size = statSync(fixturePath).size;

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${port}`);
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
    if (range) {
      const m = range.match(/bytes=(\d+)-(\d*)/);
      if (m) {
        const start = Number(m[1]);
        const end = m[2] ? Number(m[2]) : size - 1;
        const buf = readFileSync(fixturePath).subarray(start, end + 1);
        res.writeHead(206, {
          "Content-Range": `bytes ${start}-${end}/${size}`,
          "Content-Length": buf.length,
          "Content-Type": "application/octet-stream",
        });
        res.end(buf);
        return;
      }
    }
    res.writeHead(200, { "Content-Length": size, "Content-Type": "application/octet-stream" });
    res.end(readFileSync(fixturePath));
    return;
  }
  res.writeHead(404);
  res.end("not found");
});

server.listen(port, () => {
  console.log(`冒烟服务器已启动: http://localhost:${port}/file.bin (大小 ${size} B)，Ctrl+C 停止`);
});
