# SyncFrame 全量镜像：构建前端产物 + 运行后端（单容器、单端口）
# 构建上下文 = 仓库根目录（见 docker-compose.yml），路径需带 syncframe-poc/ 前缀
# 运行时后端同时托管 API / WebSocket / 静态资源；反向代理由部署者自行设置。

FROM node:22-alpine

WORKDIR /app

# 只拷贝依赖清单，最大化利用构建缓存
COPY syncframe-poc/package.json syncframe-poc/package-lock.json syncframe-poc/tsconfig.base.json ./
COPY syncframe-poc/packages ./packages
COPY syncframe-poc/apps ./apps

# devDependencies（tsx/typescript/vite 等）随 workspaces 一起安装；
# 同一阶段构建前端产物，单容器直接托管，不再单独出 web/nginx 镜像。
RUN npm ci --no-audit --no-fund && npm run build -w @syncframe/web

ENV SERVER_PORT=8787
ENV WEB_DIST=/app/apps/web/dist
EXPOSE 8787

CMD ["npx", "tsx", "apps/server/src/index.ts"]
