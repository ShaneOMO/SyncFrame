# SyncFrame Web 镜像：Vite 构建 + nginx 托管，反代 /api 与 /ws 到 server 服务
# 构建上下文 = syncframe-poc 目录

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages ./packages
COPY apps/web ./apps/web
# web 依赖 movi-player（体积大），npm ci 按 workspaces 安装
RUN npm ci --no-audit --no-fund
WORKDIR /app/apps/web
RUN npx vite build

FROM nginx:1.27-alpine
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
