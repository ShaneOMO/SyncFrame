# SyncFrame

基于 **Movi Player + OpenList** 的多人同步观影室（可行性验证 PoC，P0–P3 已全部通过）。
房主从自己挂载的 OpenList 媒体库中添加视频，观众通过邀请链接进房，全房间播放/暂停/seek/倍速自动同步；
媒体字节由播放器直连 OpenList 拉取，不经过房间服务。

| 大厅 | 观影房间 |
| --- | --- |
| ![大厅](shot-lobby.png) | ![房间](shot-room.png) |

## 仓库结构

```text
SyncFrame/
├── syncframe-poc/            # 全部代码（npm workspaces：apps + packages + tests）
│   ├── apps/web/             # Vite 前端：大厅 lobby.html（入口）/ 房间 room.html
│   ├── apps/server/          # Node 后端：REST 鉴权 + WebSocket 同步房间 + OpenList 媒体库/媒体授权
│   ├── packages/sync-protocol/# 同步协议包（时钟偏移、跟随纠偏、消息校验）
│   ├── packages/openlist-adapter/ # OpenList API 适配器
│   ├── tests/                # P0 HTTP 探测 / P2 协议与浏览器同步 / P3 安全与 e2e
│   └── docs/                 # P2 协议草案、P3 MVP 实现说明
├── deploy/                   # Dockerfile × 2 + nginx 反代配置
├── docker-compose.yml        # 一键 Docker 部署（web + server）
├── docs/feasibility-validation-plan.md  # 总体验证计划
└── reports/（本地生成，已 gitignore）# P0/P1/P2/P3 验证报告与原始记录
```

## 快速开始

前置：Node.js 22+ 与 npm（本地调试）；Docker 与 Docker Compose v2（容器部署）。

### 方式一：npm 本地调试

```bash
cd syncframe-poc
npm install
cp .env.example .env        # Windows: copy .env.example .env
```

编辑 `syncframe-poc/.env`，填入 OpenList 实例地址与**最小只读权限**测试账号：

| 变量 | 说明 |
| --- | --- |
| `OPENLIST_BASE_URL` | OpenList 实例地址，如 `http://192.168.1.10:5244` |
| `OPENLIST_USERNAME` / `OPENLIST_PASSWORD` | 测试账号（勿用管理员） |
| `OPENLIST_TEST_DIR` / `OPENLIST_TEST_FILE` | P0 探测目录 / 可选指定文件 |
| `CHECK_CONCURRENCY` | 并发读取会话数，默认 5 |

**启动（两个终端）：**

```bash
# 终端 1：后端（REST + WS 同步房间 + OpenList 代理），默认 :8787
npm run p1:server

# 终端 2：前端 Vite 开发服务器，默认 :5173（/api、/ws 已代理到 8787）
npm run p1:web
```

打开 **http://localhost:5173/lobby.html** → 输入昵称 → 创建房间 → 把邀请链接发给观众即可同步观影。

其他入口：

- `http://localhost:5173/room.html?room=demo&role=host&mode=clock` — P2 房间页（clock 演示模式 / player 真实播放器模式，观众 `role=viewer`，可开多个窗口）

**调试技巧：**

- **前端**：Vite 开发服务器自带 HMR，改代码即热更新；代理配置在 `apps/web/vite.config.ts`
- **后端热重载**：`npm run p1:server` 是单次运行；改后端代码时用
  `npx tsx watch --env-file-if-exists=.env apps/server/src/index.ts` 自动重启
- **接调试器**：`npx tsx --inspect --env-file-if-exists=.env apps/server/src/index.ts`，
  VS Code 选 "Attach to Node.js" 即可打断点
- **指向另一个后端**：`SYNC_BACKEND_PORT=9999 npm run p1:web` 让 Vite 代理改走指定端口（如注入延迟的实例）
- **模拟广域网延迟**：后端设 `SYNC_INJECT_LATENCY_MS=100`（单向）/ `SYNC_INJECT_JITTER_MS=30`，
  服务端注入延迟，验证同步纠偏
- **类型检查**：`npm run typecheck`

**测试：**

```bash
npm run p2:unit        # P2 协议单元测试
npm run p2:sim         # P2 Node 仿真（可加 SYNC_SIM_RTT=100 注入 RTT）
npm run p2:browser     # P2 Playwright 三浏览器上下文同步
npm run p3:security    # P3 鉴权/越权安全测试（13 项）
npm run p3:e2e         # P3 端到端冒烟
npm run p3:ui          # P3 大厅 UI 冒烟
```

更完整的 P0–P2 验证流程（OpenList HTTP 能力探测、播放器指标采集）见 [syncframe-poc/README.md](syncframe-poc/README.md)。

### 方式二：Docker 构建并部署

在**仓库根目录**（含 `docker-compose.yml` 的目录）执行：

```bash
docker compose up --build -d
```

构建并启动两个容器，然后浏览器打开 **http://localhost:7300/lobby.html**。

OpenList 连接通过环境变量注入（**不写入镜像**）。在仓库根目录建一个 `.env`
（compose 会自动读取，该文件已被 gitignore）：

```bash
OPENLIST_BASE_URL=http://192.168.1.10:5244
OPENLIST_USERNAME=readonly_user
OPENLIST_PASSWORD=your_password
```

或直接 export 后运行 `docker compose up --build -d`。

**容器架构：**

```text
浏览器 ──→ web（nginx:1.27，:7300→80）
            ├─ 静态托管 Vite 构建产物（lobby / room 多页）
            ├─ /api → server:8787（房间鉴权 / 媒体库 / 媒体授权）
            └─ /ws  → server:8787（WebSocket 同步房间，长连接）
浏览器 ←── server（node:22-alpine，tsx 直接运行 TS）
            └─ 仅签发短期媒体地址；视频字节由浏览器直连 OpenList 拉取
```

**常用命令：**

```bash
docker compose logs -f server   # 看后端日志
docker compose ps               # 查看容器状态
docker compose down             # 停止并删除容器
docker compose up --build -d    # 改了代码后重新构建并启动
docker compose build web        # 只重建 web 镜像（利用层缓存）
```

**部署注意：**

- 对外端口改 `docker-compose.yml` 里 web 的 `"7300:80"` 映射
- HTTPS 建议在最外层再加一层反向代理（Caddy/Traefik/Nginx），本仓库 nginx 只负责容器内路由
- 两个镜像都带 `restart: unless-stopped`，宿主机重启后自动拉起

## 验证文档索引

| 阶段 | 内容 | 文档 |
| --- | --- | --- |
| 计划 | 总体验证计划与通过门槛 | [feasibility-validation-plan](docs/feasibility-validation-plan.md) |
| P0 | OpenList HTTP 能力（Range/CORS/重定向/签名） | [syncframe-poc/README](syncframe-poc/README.md) §P0 |
| P1 | Movi Player 原始文件播放验证 | [syncframe-poc/README](syncframe-poc/README.md) §P1 |
| P2 | 多人同步协议 Spike（已通过） | [p2-sync-protocol](syncframe-poc/docs/p2-sync-protocol.md) |
| P3 | 最小观影室 MVP：实现 + 安全测试记录 | [p3-mvp](syncframe-poc/docs/p3-mvp.md) |

`reports/` 目录（验证报告与原始 JSON）为本地生成物，已被 gitignore，不入库。
