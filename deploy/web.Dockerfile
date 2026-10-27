# SyncFrame Web 镜像：Vite 构建 + nginx 托管，反代 /api 与 /ws 到 server 服务
# 构建上下文 = 仓库根目录（见 docker-compose.yml），路径需带 syncframe-poc/ 前缀

FROM node:22-alpine AS build
WORKDIR /app
COPY syncframe-poc/package.json syncframe-poc/package-lock.json syncframe-poc/tsconfig.base.json ./
COPY syncframe-poc/packages ./packages
COPY syncframe-poc/apps/web ./apps/web
# web 依赖 movi-player（体积大），npm ci 按 workspaces 安装
RUN npm ci --no-audit --no-fund
WORKDIR /app/apps/web
RUN npx vite build

FROM nginx:1.27-alpine
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
