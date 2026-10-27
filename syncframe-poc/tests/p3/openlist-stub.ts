/**
 * P3 测试用 OpenList 桩： emulate 官方契约（POST JSON + envelope + token），
 * 提供 /api/auth/login、/api/fs/list、/api/fs/get、/api/fs/search 与带 Range 的媒体字节。
 *
 * VFS：
 *   /movies/        a.mkv（1 MiB）+ a.srt（外挂字幕，a.mkv 的 related）
 *                   b.mp4（512 KiB）
 *   /music/         song.mp3
 *
 * 签名：fs/get 返回 sign=STUB-SIGN-<path>，raw_url 指向本桩的 /media/<name>?sign=。
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

export interface StubFile {
  name: string;
  path: string;
  parent: string;
  size: number;
}

const FILE_SIZES: Record<string, number> = {
  "/movies/a.mkv": 1024 * 1024,
  "/movies/a.srt": 2048,
  "/movies/b.mp4": 512 * 1024,
  "/music/song.mp3": 128 * 1024,
};

const VIDEO_SUBTITLES: Record<string, string[]> = {
  "/movies/a.mkv": ["/movies/a.srt"],
};

function fileEntries(): StubFile[] {
  return Object.entries(FILE_SIZES).map(([p, size]) => ({
    name: p.split("/").pop()!,
    path: p,
    parent: p.slice(0, p.lastIndexOf("/")) || "/",
    size,
  }));
}

const DIRS = ["/", "/movies", "/music"];

export function startOpenListStub(port: number): Promise<{ close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${port}`);
    const body: Buffer[] = [];
    req.on("data", (c) => body.push(c));
    req.on("end", () => {
      void handle(req, res, url, Buffer.concat(body).toString("utf-8")).catch((err) => {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ code: 500, message: String(err), data: null }));
      });
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse, url: URL, rawBody: string): Promise<void> {
    const json = (code: number, data: unknown, message = "") => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ code, message, data }));
    };

    if (url.pathname === "/api/auth/login" && req.method === "POST") {
      json(200, { token: "stub-openlist-token" });
      return;
    }

    // /media/* 是类 CDN 直链：浏览器播放端不带 OpenList 令牌，靠 sign 防伪链。
    const isMediaPath = url.pathname.startsWith("/media/");

    // 以下接口要求 Authorization（验证服务端确实带了令牌）
    if (!isMediaPath && req.headers.authorization !== "stub-openlist-token") {
      json(401, null, "unauthorized");
      return;
    }

    if (url.pathname === "/api/fs/list" && req.method === "POST") {
      const b = JSON.parse(rawBody || "{}") as { path?: string; page?: number; per_page?: number };
      const dir = b.path ?? "/";
      if (!DIRS.includes(dir)) {
        json(500, null, `path not found: ${dir}`);
        return;
      }
      const perPage = b.per_page ?? 100;
      const page = b.page ?? 1;
      const all = [
        ...DIRS.filter((d) => d !== "/" && d.startsWith(dir === "/" ? "/" : dir + "/")).map((d) => ({
          name: d.split("/").pop()!,
          path: d,
          is_dir: true,
          size: 0,
        })),
        ...fileEntries()
          .filter((f) => f.parent === dir)
          .map((f) => ({ name: f.name, path: f.path, is_dir: false, size: f.size })),
      ];
      const slice = all.slice((page - 1) * perPage, page * perPage);
      json(200, { content: slice, total: all.length });
      return;
    }

    if (url.pathname === "/api/fs/get" && req.method === "POST") {
      const b = JSON.parse(rawBody || "{}") as { path?: string };
      const p = b.path ?? "";
      const size = FILE_SIZES[p];
      if (!size) {
        json(500, null, `file not found: ${p}`);
        return;
      }
      const name = p.split("/").pop()!;
      const related = (VIDEO_SUBTITLES[p] ?? [])
        .map((sp) => ({ name: sp.split("/").pop()!, size: FILE_SIZES[sp], is_dir: false }));
      json(200, {
        name,
        size,
        is_dir: false,
        sign: `STUB-SIGN-${name}`,
        raw_url: `http://localhost:${port}/media/${name}?sign=STUB-SIGN-${name}`,
        provider: "StubDrive",
        related,
      });
      return;
    }

    if (url.pathname === "/api/fs/search" && req.method === "POST") {
      const b = JSON.parse(rawBody || "{}") as { keywords?: string; parent?: string; page?: number; per_page?: number };
      const kw = (b.keywords ?? "").toLowerCase();
      const parent = b.parent ?? "/";
      const perPage = b.per_page ?? 50;
      const page = b.page ?? 1;
      const hits = fileEntries()
        .filter((f) => f.name.toLowerCase().includes(kw))
        .filter((f) => parent === "/" || f.path.startsWith(parent))
        .map((f) => ({ parent: f.parent, name: f.name, is_dir: false, size: f.size }));
      json(200, { content: hits.slice((page - 1) * perPage, page * perPage), total: hits.length });
      return;
    }

    if (url.pathname.startsWith("/media/") && req.method === "GET") {
      const name = decodeURIComponent(url.pathname.slice("/media/".length));
      const entry = fileEntries().find((f) => f.name === name);
      if (!entry || url.searchParams.get("sign") !== `STUB-SIGN-${name}`) {
        res.writeHead(403);
        res.end("bad sign");
        return;
      }
      // 确定性填充内容（测试只验证 Range/字节数/可达性，无需真实视频码流）
      const size = entry.size;
      const range = req.headers.range;
      res.setHeader("Accept-Ranges", "bytes");
      res.setHeader("Content-Type", "application/octet-stream");
      res.setHeader("Access-Control-Allow-Origin", "*");
      if (range) {
        const m = /bytes=(\d+)-(\d*)/.exec(range);
        const start = m ? Number(m[1]) : 0;
        const end = m && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
        res.writeHead(206, {
          "Content-Range": `bytes ${start}-${end}/${size}`,
          "Content-Length": end - start + 1,
        });
        res.end(Buffer.alloc(end - start + 1, start % 251));
      } else {
        res.writeHead(200, { "Content-Length": size });
        res.end(Buffer.alloc(size, 7));
      }
      return;
    }

    if (url.pathname.startsWith("/media/") && req.method === "HEAD") {
      const name = decodeURIComponent(url.pathname.slice("/media/".length));
      const entry = fileEntries().find((f) => f.name === name);
      if (!entry || url.searchParams.get("sign") !== `STUB-SIGN-${name}`) {
        res.writeHead(403);
        res.end();
        return;
      }
      res.writeHead(200, { "Content-Length": String(entry.size), "Accept-Ranges": "bytes" });
      res.end();
      return;
    }

    json(404, null, "not found");
  }

  return new Promise((resolve) => {
    server.listen(port, () => resolve({ close: () => new Promise((r) => server.close(() => r())) }));
  });
}
