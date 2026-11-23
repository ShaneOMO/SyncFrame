# SyncFrame 全量镜像：构建前端产物 + 运行后端（单容器、单端口）
# 构建上下文 = 仓库根目录（见 docker-compose.yml），路径需带 syncframe-poc/ 前缀
# 运行时后端同时托管 API / WebSocket / 静态资源；反向代理由部署者自行设置。
#
# 三阶段构建，镜像只包含运行必需内容：
#   - 前端：仅 Vite 构建产物 dist
#   - 后端：仅 @syncframe/server 及其 workspace 依赖的 prod node_modules（tsx 为生产依赖）
#   - 运行时基础：alpine + apk nodejs，不含 npm/yarn/corepack（node:22-alpine 约 140MB+ 的主要来源）
#
# 包管理用 pnpm（packageManager 字段锁定版本，corepack 自动激活）：
#   - lockfile 正确记录全部平台 optional 依赖，无需 npm 时代的 musl 原生绑定补装 hack
#   - 阶段 2 用 --filter 只装 server 的生产依赖，比全量 npm ci --omit=dev 快且小
#
# 层缓存策略：依赖清单与源码分两次 COPY —— 日常改业务代码不会触发重装依赖，
# 只有 package.json / pnpm-lock.yaml 变动才会重装。
# 注意：不使用 RUN --mount=type=cache（npm cache clean 与 cache mount 组合在部分
# 文件系统上报 ENOTEMPTY 导致构建失败，曾导致线上部署失败），层缓存已足够。

# ---------- 阶段 1：构建前端产物 ----------
FROM node:22-alpine AS build
WORKDIR /app

RUN corepack enable

# 第一步只拷贝依赖清单（package.json / lockfile），不拷贝源码：
# 源码改动不会改变这一层，install 层才能稳定复用缓存。
COPY syncframe-poc/package.json syncframe-poc/pnpm-lock.yaml syncframe-poc/pnpm-workspace.yaml syncframe-poc/tsconfig.base.json ./
COPY syncframe-poc/packages/sync-protocol/package.json ./packages/sync-protocol/
COPY syncframe-poc/packages/openlist-adapter/package.json ./packages/openlist-adapter/
COPY syncframe-poc/apps/web/package.json ./apps/web/

# 部署服务器到 registry 链路不稳：整体重试 3 次。
# pnpm 的 lockfile 会装齐当前平台（linux-x64-musl）的 optional 原生绑定，
# Windows 上生成的 lockfile 也无需像 npm 那样手动补 lightningcss / tailwind oxide。
RUN for i in 1 2 3; do pnpm install --frozen-lockfile && break || { [ "$i" = 3 ] && exit 1; sleep 15; }; done \
    && cd apps/web && node -e "const r=require('module').createRequire(require.resolve('tailwindcss/package.json')); r('@tailwindcss/oxide'); console.log('oxide ok')" && cd /app

# 依赖装好之后再拷源码：改代码只会重建这两层 + build 层，不会重装依赖
COPY syncframe-poc/packages ./packages
COPY syncframe-poc/apps/web ./apps/web

# 版本信息由 CI 通过 build-arg 传入（镜像内不含 .git，读不到 commit）。
# 放在这里而不是文件开头：只有下面这一层会随 commit 变化，install 层仍可复用。
ARG GIT_COMMIT=dev
ARG BUILD_TIME=
ARG APP_VERSION=0.1.0
ENV VITE_GIT_COMMIT=$GIT_COMMIT \
    VITE_BUILD_TIME=$BUILD_TIME \
    VITE_APP_VERSION=$APP_VERSION

RUN pnpm --filter @syncframe/web build

# ---------- 阶段 2：安装 server 生产依赖（含 tsx 运行时） ----------
FROM node:22-alpine AS deps
WORKDIR /app

RUN corepack enable

# 同样只拷依赖清单；源码在阶段 3 直接从构建上下文拷贝，这里不需要
COPY syncframe-poc/package.json syncframe-poc/pnpm-lock.yaml syncframe-poc/pnpm-workspace.yaml ./
COPY syncframe-poc/packages/sync-protocol/package.json ./packages/sync-protocol/
COPY syncframe-poc/packages/openlist-adapter/package.json ./packages/openlist-adapter/
COPY syncframe-poc/apps/server/package.json ./apps/server/

# 只装 @syncframe/server 及其 workspace 依赖的生产依赖（含 tsx / ws），
# 不装 web / tests / devDependencies。产物落在 apps/server/node_modules 与根 node_modules。
RUN for i in 1 2 3; do pnpm install --frozen-lockfile --prod --filter @syncframe/server... && break || { [ "$i" = 3 ] && exit 1; sleep 15; }; done

# ---------- 阶段 3：运行时（无 npm，仅 nodejs） ----------
FROM alpine:3.21

# apk 的 nodejs 包即 Node 22 LTS；不装 npm/yarn/corepack
RUN apk add --no-cache nodejs \
    && adduser -D -u 1000 node

WORKDIR /app

# pnpm 严格布局：server 的依赖在 apps/server/node_modules（含 .bin/tsx 与
# 指向 ../../packages/* 的 @syncframe/* 软链），根 node_modules 也要一并拷贝
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/server/node_modules ./apps/server/node_modules
COPY syncframe-poc/packages ./packages
COPY syncframe-poc/apps/server ./apps/server
COPY --from=build /app/apps/web/dist ./apps/web/dist

ENV SERVER_PORT=8787
ENV WEB_DIST=/app/apps/web/dist
ENV DATA_DIR=/app/data

# 运行时版本信息（启动日志 + /api/health 返回），与前端注入的 VITE_* 同源
ARG GIT_COMMIT=dev
ARG BUILD_TIME=
ARG APP_VERSION=0.1.0
ENV GIT_COMMIT=$GIT_COMMIT \
    BUILD_TIME=$BUILD_TIME \
    APP_VERSION=$APP_VERSION
EXPOSE 8787

# 非 root 运行：容器被攻破时影响面更小；/app/data 需对 node 用户可写。
RUN mkdir -p /app/data && chown -R node:node /app/data
USER node

CMD ["/app/apps/server/node_modules/.bin/tsx", "apps/server/src/index.ts"]
