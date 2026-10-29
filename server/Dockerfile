#
# 后端镜像（Express 5 + Prisma 5 + PostgreSQL）
#
# 构建上下文是 `server/` 目录：`docker build -f server/Dockerfile -t bdog-server:<tag> server`
#
# 注意：**不要加 `# syntax=docker/dockerfile:1`**。那会让构建器先去 Docker Hub 拉
# 语法前端镜像，而这台开发机和服务器都连不上 registry-1.docker.io，构建会直接 timeout。
# 这个文件只用到最基础的指令，默认前端的 Dockerfile 1.4 就够。
#
# 两个约束决定了这个文件的写法：
#
#  1. **基础镜像走国内镜像站**。这台服务器（以及开发机）连不上 registry-1.docker.io，
#     swr.cn-north-4.myhuaweicloud.com/ddn-k8s/docker.io/... 与 docker.m.daocloud.io 可用。
#
#  2. **bullseye 而不是 bookworm**。服务器是 CentOS 7 + Docker **19.03**，它的默认 seccomp
#     配置比 glibc 2.36 旧：bookworm 镜像里 `node -e 'console.log(1)'` 直接 abort（
#     `Assertion failed: (0) == (uv_thread_create(t.get(), start_thread, this))`），
#     node:20 与 node:22 都一样。bullseye 的 glibc 2.31 不用 clone3，能正常启动 ——
#     验证过：`docker run --rm docker.m.daocloud.io/library/node:22-bullseye-slim node -v`。
#     镜像里 `prisma generate` 会自动选中 debian-openssl-1.1.x 引擎，不用手写 binaryTargets。
#  3. **debian 而不是 alpine**。Prisma 的查询引擎按 libc 选二进制，debian(bookworm) 的
#     `debian-openssl-3.0.x` 是官方长期支持的目标；换 alpine 就得改 schema 的
#     binaryTargets，还要额外处理 libssl。体积差 ~40MB，不值得。
#
# 运行时镜像里保留 prisma CLI（已从 devDependencies 移到 dependencies）：容器的启动命令是
# `prisma migrate deploy && node dist/server.js` —— 迁移和应用始终是同一份代码，不会出现
# 「镜像更新了但库里还是旧表」这种只有出错时才发现的情况。

ARG NODE_IMAGE=docker.m.daocloud.io/library/node:22-bullseye-slim

# ---------- 1. 依赖 + 生成 Prisma Client ----------
FROM ${NODE_IMAGE} AS deps
WORKDIR /app

# 先只拷贝清单，让 npm ci 这一层能被缓存住
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci --no-audit --no-fund && npx prisma generate

# ---------- 2. 编译 TypeScript ----------
FROM deps AS build
WORKDIR /app
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---------- 3. 运行时 ----------
FROM ${NODE_IMAGE} AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    PORT=4000 \
    MEDIA_DIR=/app/uploads

# 不装任何东西：node:22-bullseye-slim 自带 libssl1.1 与 ca-certificates，
# Prisma 的 debian-openssl-1.1.x 引擎直接能用。
# （这台服务器连不上 deb.debian.org，任何 apt-get 都会 timeout 把构建卡死。）

# 生产依赖：包含 prisma CLI（migrate deploy 要用），不含 typescript / tsx / @types
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci --omit=dev --no-audit --no-fund \
 && npm cache clean --force

COPY --from=build /app/dist ./dist

# 媒体目录（照片/录音/截屏）与运行用户。宿主机上对应 /opt/app/bdog/uploads，
# 属主必须是 1000:1000，否则非 root 用户写不进去。
RUN mkdir -p /app/uploads && chown -R node:node /app /app/uploads

USER node
EXPOSE 4000

# 健康检查只用 Node 自己（slim 镜像里没有 curl）
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["sh", "-c", "npx prisma migrate deploy && node dist/server.js"]
