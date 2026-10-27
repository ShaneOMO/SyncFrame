import { defineConfig } from "vite";
import { resolve } from "node:path";

// 测试时可经 SYNC_BACKEND_PORT 指向注入延迟的后端实例（默认 8787）
const backend = `http://localhost:${process.env.SYNC_BACKEND_PORT ?? 8787}`;

export default defineConfig({
  server: {
    port: 5173,
    proxy: {
      "/api": backend,
      // P2：WebSocket 房间端点代理到同步后端
      "/ws": { target: `ws://localhost:${process.env.SYNC_BACKEND_PORT ?? 8787}`, ws: true },
    },
  },
  build: {
    target: "es2022",
    // 多页应用：显式声明三个入口，否则仅 index.html 会被构建
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        lobby: resolve(__dirname, "lobby.html"),
        room: resolve(__dirname, "room.html"),
      },
    },
  },
  assetsInclude: ["**/*.wasm"],
});
