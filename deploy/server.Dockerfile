# SyncFrame 全量镜像：构建前端产物 + 运行后端（单容器、单端口）
# 构建上下文 = 仓库根目录（见 docker-compose.yml），路径需带 syncframe-poc/ 前缀
# 运行时后端同时托管 API / WebSocket / 静态资源；反向代理由部署者自行设置。
#
# 三阶段构建，镜像只包含运行必需内容：
#   - 前端：仅 Vite 构建产物 dist
#   - 后端：仅 @syncframe/server 及其 workspace 依赖的 prod node_modules（tsx 为生产依赖）
#   - 运行时基础：alpine + apk nodejs，不含 npm/yarn/corepack（node:22-alpine 约 140MB+ 的主要来源）

# ---------- 阶段 1：构建前端产物 ----------
FROM node:22-alpine AS build
WORKDIR /app

# 只拷贝依赖清单，最大化利用构建缓存
COPY syncframe-poc/package.json syncframe-poc/package-lock.json syncframe-poc/tsconfig.base.json ./
COPY syncframe-poc/packages ./packages
COPY syncframe-poc/apps/web ./apps/web

# npm 网络偶发 ECONNRESET（部署服务器到 registry 链路不稳）：加重试参数 + 整体重试 3 次
# 另：lockfile 在 Windows 上生成，npm ci 在 alpine 下会漏装 musl 原生绑定（npm/cli#4828），
# 显式按已装版本补齐 lightningcss / tailwind oxide 的 musl 绑定并验证可加载。
RUN npm config set fetch-retries 5 fetch-retry-mintimeout 20000 fetch-retry-maxtimeout 120000 \
    && for i in 1 2 3; do npm ci --no-audit --no-fund && break || { [ "$i" = 3 ] && exit 1; sleep 15; }; done \
    && for pkg in lightningcss @tailwindcss/oxide; do \
         ver=$(node -p "require('$pkg/package.json').version"); \
         npm i --no-save --no-audit --no-fund "$pkg-linux-x64-musl@$ver" || exit 1; \
       done \
    && node -e "require('lightningcss'); require('@tailwindcss/oxide')" \
    && npm run build -w @syncframe/web

# ---------- 阶段 2：安装 server 生产依赖（含 tsx 运行时） ----------
FROM node:22-alpine AS deps
WORKDIR /app

COPY syncframe-poc/package.json syncframe-poc/package-lock.json ./
COPY syncframe-poc/packages ./packages
COPY syncframe-poc/apps/server ./apps/server

# 只装 server workspace 的生产依赖（含 openlist-adapter / sync-protocol），
# 不含 vite / typescript / playwright 等 devDependencies，也不装 web 的依赖
RUN npm config set fetch-retries 5 fetch-retry-mintimeout 20000 fetch-retry-maxtimeout 120000 \
    && for i in 1 2 3; do npm ci --no-audit --no-fund --omit=dev -w @syncframe/server && break || { [ "$i" = 3 ] && exit 1; sleep 15; }; done \
    && npm cache clean --force

# ---------- 阶段 3：运行时（无 npm，仅 nodejs） ----------
FROM alpine:3.21

# apk 的 nodejs 包即 Node 22 LTS；不装 npm/yarn/corepack
RUN apk add --no-cache nodejs \
    && adduser -D -u 1000 node

WORKDIR /app

# node_modules 内的 @syncframe/* 为指向 ../packages/* 的相对软链，需一并拷贝 packages 源码
COPY --from=deps /app/node_modules ./node_modules
COPY syncframe-poc/packages ./packages
COPY syncframe-poc/apps/server ./apps/server
COPY --from=build /app/apps/web/dist ./apps/web/dist

ENV SERVER_PORT=8787
ENV WEB_DIST=/app/apps/web/dist
ENV DATA_DIR=/app/data
EXPOSE 8787

# 非 root 运行：容器被攻破时影响面更小；/app/data 需对 node 用户可写。
RUN mkdir -p /app/data && chown -R node:node /app/data
USER node

CMD ["/app/node_modules/.bin/tsx", "apps/server/src/index.ts"]
