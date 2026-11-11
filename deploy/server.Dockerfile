# SyncFrame 全量镜像：构建前端产物 + 运行后端（单容器、单端口）
# 构建上下文 = 仓库根目录（见 docker-compose.yml），路径需带 syncframe-poc/ 前缀
# 运行时后端同时托管 API / WebSocket / 静态资源；反向代理由部署者自行设置。
#
# 多阶段构建，镜像只包含运行必需内容：
#   - 前端：仅 Vite 构建产物 dist（不含 vite/movi-player 源码依赖链以外的 devDeps）
#   - 后端：仅 @syncframe/server 及其 workspace 依赖的 prod node_modules
#     （tsx 已声明为 server 的 dependency，可直接以生产依赖安装）

# ---------- 阶段 1：构建前端产物 ----------
FROM node:22-alpine AS build
WORKDIR /app

# 只拷贝依赖清单，最大化利用构建缓存
COPY syncframe-poc/package.json syncframe-poc/package-lock.json syncframe-poc/tsconfig.base.json ./
COPY syncframe-poc/packages ./packages
COPY syncframe-poc/apps/web ./apps/web

RUN npm ci --no-audit --no-fund && npm run build -w @syncframe/web

# ---------- 阶段 2：运行时 ----------
FROM node:22-alpine
WORKDIR /app

# 后端运行所需的清单与源码（server 以 tsx 直接跑 TS 源码）
COPY syncframe-poc/package.json syncframe-poc/package-lock.json ./
COPY syncframe-poc/packages ./packages
COPY syncframe-poc/apps/server ./apps/server

# 只安装 server workspace 的生产依赖（含 workspace 内的 openlist-adapter / sync-protocol，
# 不含 vite / typescript / playwright 等 devDependencies，也不装 web 的依赖）
RUN npm ci --no-audit --no-fund --omit=dev -w @syncframe/server \
    && npm cache clean --force

# 前端静态产物来自构建阶段，源码不进运行时镜像
COPY --from=build /app/apps/web/dist ./apps/web/dist

ENV SERVER_PORT=8787
ENV WEB_DIST=/app/apps/web/dist
ENV DATA_DIR=/app/data
EXPOSE 8787

# 非 root 运行：容器被攻破时影响面更小；/app/data 需对 node 用户可写。
RUN mkdir -p /app/data && chown -R node:node /app/data
USER node

CMD ["npx", "tsx", "apps/server/src/index.ts"]
