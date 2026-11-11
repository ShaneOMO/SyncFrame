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

RUN npm ci --no-audit --no-fund && npm run build -w @syncframe/web

# ---------- 阶段 2：安装 server 生产依赖（含 tsx 运行时） ----------
FROM node:22-alpine AS deps
WORKDIR /app

COPY syncframe-poc/package.json syncframe-poc/package-lock.json ./
COPY syncframe-poc/packages ./packages
COPY syncframe-poc/apps/server ./apps/server

# 只装 server workspace 的生产依赖（含 openlist-adapter / sync-protocol），
# 不含 vite / typescript / playwright 等 devDependencies，也不装 web 的依赖
RUN npm ci --no-audit --no-fund --omit=dev -w @syncframe/server \
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
