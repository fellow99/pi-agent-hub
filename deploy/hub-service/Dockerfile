# ============================================================
# pi-agent-hub 镜像 —— hub-service
#
# 基镜像：node:24-alpine
# 职责  ：编译 pnpm monorepo（生成 hub-service 及其 workspace 依赖产物），
#          以 node 运行 hub-service；数据目录固定在 /root/.pi-agent-hub
# ============================================================
FROM node:24-alpine

# corepack 启用 pnpm（镜像内置）；git 供 pnpm 解析 git 依赖（无害）
RUN apk add --no-cache git && corepack enable

WORKDIR /app

# 依赖清单先行，最大化 BuildKit 缓存
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json .npmrc ./
COPY packages/ ./packages/

# 安装全部 workspace 依赖（锁文件校验）
RUN pnpm install --frozen-lockfile

# 按拓扑顺序构建全部包（hub-service 依赖 pi-session/protocol/plugin-sdk 的 dist，故 -r 全量构建）
RUN pnpm -r run build

# 运行期
ENV NODE_ENV=production \
    PI_AGENT_HUB_HOME=/root/.pi-agent-hub \
    HUB_CONFIG_FILE=/root/.pi-agent-hub/hub-service.json

WORKDIR /app/packages/hub-service
EXPOSE 8000

# 配置通过数据卷挂载到 /root/.pi-agent-hub/hub-service.json
CMD ["node", "dist/main.js"]
