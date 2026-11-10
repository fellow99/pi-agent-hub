# ============================================================
# pi-agent-hub 镜像 —— hub-console（前端静态服务器）
#
# 阶段1 builder : node:24-alpine 编译 Vite( Vue3 ) 产物
# 阶段2 runtime : nginx:latest 托管静态文件
# ============================================================

# ---- 阶段 1：编译 ----
FROM node:24-alpine AS builder

RUN apk add --no-cache git && corepack enable

WORKDIR /app

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json .npmrc ./
COPY packages/ ./packages/

RUN pnpm install --frozen-lockfile
# 仅构建 hub-console（Vite，base=/hub/）
RUN pnpm --filter @pi-agent-hub/hub-console build

# 阶段2 托管：Vite base=/hub/，产物放置到 /hub/ 目录下（与 SPA 路由前缀一致）
FROM nginx:latest

COPY --from=builder /app/packages/hub-console/dist/ /usr/share/nginx/html/hub/
COPY deploy/hub-console/nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80
