# SyncFrame 后端镜像（账户权限 + 房间鉴权 + 同步 + provider 媒体解析）
# 构建上下文 = syncframe-poc 目录（需要仓库的 workspace 结构与 lockfile）
# 管理员账户由 ADMIN_USERNAME / ADMIN_PASSWORD 环境变量初始化（compose 注入，不入镜像）

FROM node:22-alpine

WORKDIR /app

# 只拷贝依赖清单，最大化利用构建缓存
# 注意：构建上下文 = 仓库根目录（见 docker-compose.yml），路径需带 syncframe-poc/ 前缀
COPY syncframe-poc/package.json syncframe-poc/package-lock.json syncframe-poc/tsconfig.base.json ./
COPY syncframe-poc/packages ./packages
COPY syncframe-poc/apps/server ./apps/server
COPY syncframe-poc/apps/web/package.json ./apps/web/package.json

# devDependencies（tsx/typescript/ws 等）随 workspaces 一起安装
RUN npm ci --no-audit --no-fund

ENV SERVER_PORT=8787
EXPOSE 8787

CMD ["npx", "tsx", "apps/server/src/index.ts"]
