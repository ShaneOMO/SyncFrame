# SyncFrame 验证后端镜像（P3：房间鉴权 + 同步 + OpenList 代理）
# 构建上下文 = syncframe-poc 目录（需要仓库的 workspace 结构与 lockfile）

FROM node:22-alpine

WORKDIR /app

# 只拷贝依赖清单，最大化利用构建缓存
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages ./packages
COPY apps/server ./apps/server
COPY apps/web/package.json ./apps/web/package.json

# devDependencies（tsx/typescript/ws 等）随 workspaces 一起安装
RUN npm ci --no-audit --no-fund

ENV SERVER_PORT=8787
EXPOSE 8787

CMD ["npx", "tsx", "apps/server/src/index.ts"]
