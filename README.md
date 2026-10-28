# SyncFrame

基于 **Movi Player + OpenList** 的多人同步观影室。
房主从自己挂载的 OpenList 媒体库中添加视频，观众通过邀请链接进房，全房间播放/暂停/进度/倍速自动同步；
媒体字节由播放器直连 OpenList 拉取，不经过房间服务。

| 大厅 | 观影房间 |
| --- | --- |
| ![大厅](shot-lobby.png) | ![房间](shot-room.png) |

## 功能

- **同步房间**：房主创建房间、分享邀请链接，游客点开即进房（无需账号）
- **播放列表**：房主可添加直链视频，或从自己配置的 OpenList 媒体库中选择；点击条目即全房间切换播放
- **账户与 provider**：登录账户后可配置自己可用的 OpenList 实例（凭据只存服务端内存）
- **精同步**：时钟偏移估计 + 漂移纠偏，播放/暂停/seek/倍速由房主统一控制，观众自动跟随
- **安全模型**：成员令牌鉴权、媒体注册为不透明 mediaId、短期签名地址授权、邀请码可重置

## 仓库结构

```text
SyncFrame/
├── syncframe-poc/            # 全部代码（npm workspaces：apps + packages + tests）
│   ├── apps/web/             # Vite 前端：大厅 lobby.html（入口）/ 房间 room.html
│   ├── apps/server/          # Node 后端：REST 鉴权 + WebSocket 同步房间 + OpenList 媒体库/媒体授权
│   ├── packages/sync-protocol/# 同步协议包（时钟偏移、跟随纠偏、消息校验）
│   ├── packages/openlist-adapter/ # OpenList API 适配器
│   ├── tests/                # 自动化测试（协议 / 安全 / e2e / UI 冒烟）
│   └── docs/                 # 实现说明
├── deploy/                   # Dockerfile × 2 + nginx 反代配置
└── docker-compose.yml        # 一键 Docker 部署（web + server）
```

## 快速开始

前置：Node.js 22+ 与 npm（本地调试）；Docker 与 Docker Compose v2（容器部署）。

### 方式一：npm 本地调试

```bash
cd syncframe-poc
npm install
cp .env.example .env        # Windows: copy .env.example .env
```

编辑 `syncframe-poc/.env`，填入 OpenList 实例地址与**最小只读权限**账号：

| 变量 | 说明 |
| --- | --- |
| `OPENLIST_BASE_URL` | OpenList 实例地址，如 `http://192.168.1.10:5244` |
| `OPENLIST_USERNAME` / `OPENLIST_PASSWORD` | 只读账号（勿用管理员） |

**启动（两个终端）：**

```bash
# 终端 1：后端（REST + WS 同步房间 + OpenList 代理），默认 :8787
npm run p1:server

# 终端 2：前端 Vite 开发服务器，默认 :5173（/api、/ws 已代理到 8787）
npm run p1:web
```

打开 **http://localhost:5173/lobby.html** → 输入昵称 → 创建房间 → 把邀请链接发给观众即可同步观影。

**开发：**

- Vite 自带 HMR，改前端即热更新；代理配置在 `apps/web/vite.config.ts`
- 改后端代码用 `npx tsx watch --env-file-if-exists=.env apps/server/src/index.ts` 自动重启
- 类型检查：`npm run typecheck`
- 前端冒烟测试：`npm run p3:ui`（需本机 Chrome/Edge）

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
