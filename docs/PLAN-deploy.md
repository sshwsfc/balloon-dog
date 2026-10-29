# 部署（bdog.gtsiot.cn / docker compose）

线上地址：**https://bdog.gtsiot.cn**（证书未装前先 http） · 服务器 `43.137.2.132`（CentOS 7，Docker 19.03）
一条命令：`npm run deploy` · 回滚：`npm run deploy -- --rollback`

这份文档只讲「怎么把它跑在服务器上、坏了怎么查、还差什么」。产品本身的设计见
[`PLAN-roadmap.md`](PLAN-roadmap.md)，测试体系见 [`PLAN-e2e-automation.md`](PLAN-e2e-automation.md)。

---

## 1. 拓扑

```
                    ┌────────────────────────────── 43.137.2.132 ─────────────────────────────┐
  浏览器 / 孩子手机 │                                                                            │
  ─────────────────┼── 80/443 ──► [web] 边缘 nginx（已有容器，gtsiot/kesi 等站点都挂在它上面）   │
                    │                 │                                                        │
                    │                 ├─ /api/     ──► bdog-server:4000  ┐                      │
                    │                 ├─ /health   ──► bdog-server:4000  │  同一个 docker 网络  │
                    │                 └─ /         ──► bdog-web:80       │  app_backend        │
                    │                                                  │                      │
                    │   [bdog-web] nginx:1.25.0  ── 静态 dist（家长端 + /admin）              │
                    │   [bdog-server] node:22（Express + Prisma）                            │
                    │   [bdog-postgres] postgres:16-alpine（不发布端口）                      │
                    └────────────────────────────────────────────────────────────────────────────┘
```

**一个宿主端口都不新增**。这台机器上 80/443 属于边缘 nginx、4000 属于 kesi-server、5432 属于
gtsiot-postgres；再抢端口只会把现有站点弄挂。所以三个容器都接入已有的外部网络 `app_backend`，
由边缘 nginx 按**容器名**反代 —— gtsiot 与 kesi 两个站点现在就是这个做法。

为什么静态站点也单独跑一个 nginx（而不是复用边缘 nginx 的 bind mount）：边缘 nginx 由别的
compose 项目管，往里塞我们的 dist 会让「换一版」变成「改别人的容器」。现在换版只动我们自己的
`current` 软链。

## 2. 服务器上的目录

```
/opt/app/bdog/
├── releases/
│   ├── current -> <tag>           # 软链，nginx 每请求解析，切它=发布（不需要重建容器）
│   ├── 20261020-094538-2b041eb/   # 一份完整 dist（家长端 + admin/ + download/）
│   └── ...                        # 只保留最近 3 份
├── docker-compose.yml             # 由 deploy/deploy/docker-compose.prod.yml 上传
├── nginx/ballondog-web.conf       # bdog-web 容器内的站点配置
├── .env.prod                      # 生产环境变量（chmod 600，含密钥）
├── .deploy-state.json             # 当前/上一版 release + 镜像 tag（回滚读它）
├── build/server/                  # 服务端构建上下文（源码副本，docker build 用）
├── pgdata/                        # PostgreSQL 数据目录
├── uploads/                       # 照片 / 录音 / 截屏（媒体不在库里，在盘上）
└── backup/                        # 留给备份脚本
```

镜像跑在服务器本地（`bdog-server:<tag>`），不推任何 registry（D6：不用 ACR）。

## 3. `npm run deploy` 做了什么

`scripts/deploy.mjs`，10 步，任何一步失败就停在那里并打印原因：

| # | 步骤 | 关键点 |
|---|------|--------|
| 1 | 前置校验 | `.env.prod` 存在；APK 存在；`app_backend` 网络存在；服务器目录可建 |
| 2 | 构建前端 | `VITE_SERVER_URL=https://<DEPLOY_DOMAIN> npm run build`（**构建期覆盖**，本地 `.env` 指向本机也不影响线上），并确认 `dist/admin/index.html` 存在（后台是第二个入口，漏了就白屏） |
| 3 | 构建后端镜像 | 默认**在服务器上** `docker build`（见 §7.1 为什么不是本机） |
| 4 | 上传静态产物 + 编排文件 | `rsync dist/ → releases/<tag>/`；compose / nginx / `.env.prod` 先写 `.tmp-<tag>` 再 `mv`（不留半个文件） |
| 5 | 传送镜像 | 仅 `--build-on=local` 时：`docker save \| gzip \| ssh docker load` |
| 6 | 切换 + 启动 | 在 `releases/` 里 `ln -sfn <tag> current.tmp && mv -T`（原子换链，web 容器不用重启）；`docker-compose -p bdog up -d` |
| 7 | 等健康 | 轮询 `docker inspect bdog-server` 的 health，最多 2 分钟；超时打印 `docker logs --tail 60` |
| 8 | 冒烟 | `/health`、`/`、`/admin/login`、`/api/payments/catalog`（未登录必须 401，不是 502）、APK sha256 与本地一致 |
| 9 | 清理 | release 保留 3 份、镜像保留 3 个 tag |

容器启动命令是 `npx prisma migrate deploy && node dist/server.js` —— **迁移和应用永远同一份代码**，
不会出现「镜像更新了但库里还是旧表」。

常用开关：

```bash
npm run deploy                    # 全量：前端 + 后端镜像 + 切换 + 冒烟
npm run deploy -- --dry-run       # 只打印要执行的命令
npm run deploy -- --rollback      # 切回上一版（release 软链 + 镜像 tag 一起回）
npm run deploy -- --skip-image    # 只更新前端（改样式、文案）
npm run deploy -- --skip-web      # 只更新后端（改接口）
npm run deploy -- --build-apk     # 顺手重打孩子端 release APK 并带上
BUILD_ON=local npm run deploy      # 在本机构建镜像再 save/load 过去
```

## 4. 首次上线（已经做过，重复搭建时照抄）

1. **目录**：`mkdir -p /opt/app/bdog/{releases,nginx,uploads,pgdata,backup}`（脚本会自动建）。
2. **`.env.prod`**：从 `deploy/.env.prod.example` 复制，填数据库密码 / `JWT_SECRET` / 支付与短信密钥。
   注意 `POSTGRES_PASSWORD` 与 `DATABASE_URL` 里的密码必须一致。
3. **超级管理员**（不跑 seed —— seed 会灌演示家长和演示设备进真实库）：

   ```bash
   # 在容器里跑，密码用环境变量传，别写进 shell history
   docker exec -it -e BOOTSTRAP_ADMIN_PASSWORD='***' bdog-server \
     node scripts/bootstrap-admin.mjs --username admin --name 超级管理员
   ```

   该脚本幂等：账号已存在时**不改密码**，要改加 `--reset-password`。
4. **边缘 nginx**：把 [`deploy/nginx/edge-ballondog.snippet.conf`](../deploy/nginx/edge-ballondog.snippet.conf)
   粘到 `/opt/app/airiot/web/nginx.conf` 的 `http { }` 末尾（**先备份**），然后

   ```bash
   docker exec web nginx -t && docker exec web nginx -s reload
   ```

   它包含 80 → 301 → 443 两段。证书还没到位时先粘
   [`edge-ballondog.http-only.conf`](../deploy/nginx/edge-ballondog.http-only.conf)（80 直接反代，明文过渡），
   拿到证书再换成上面这份。
5. **证书**：放进 §5 的目录（文件名固定），再 `nginx -t && nginx -s reload`。
6. **备份**：目前**没有**定时备份（见 §8），至少手工 `pg_dump` 一次再开张：

   ```bash
   docker exec bdog-postgres pg_dump -U balloon balloon_dog | gzip > /opt/app/bdog/backup/$(date +%F).sql.gz
   ```

## 5. 证书（已装，2027-01-18 到期）

现有站点都是**手工放证书**、没有 certbot。布局固定：

```
/opt/app/airiot/web/ssl/bdog.gtsiot.cn_nginx/      （容器内 /usr/local/nginx/cert/..）
├── bdog.gtsiot.cn_bundle.pem   # 证书链：站点证书 + TrustAsia DV TLS RSA CA 2024 + TrustAsia TLS RSA Root CA
├── bdog.gtsiot.cn.key          # 私钥（chmod 600）
├── bdog.gtsiot.cn_bundle.crt   # 同一份链的 .crt 副本，和 kesi 那套保持一致
└── bdog.gtsiot.cn.csr
```

当前这张：`CN=bdog.gtsiot.cn`，SAN 只有 `bdog.gtsiot.cn`，RSA 2048，签发
`TrustAsia DV TLS RSA CA 2024`，**有效 2026-10-20 → 2027-01-18**。签发方式不是 acme 自动续期，
所以到期前要重新签一张再放进来。

**换证书 / 续期**（不重启容器，平滑 reload）：

```bash
# 1. 传新证书与私钥（文件名必须一致）
scp bdog.gtsiot.cn_bundle.pem bdog.gtsiot.cn.key \
    root@43.137.2.132:/opt/app/airiot/web/ssl/bdog.gtsiot.cn_nginx/
# 2. 校验
docker exec web nginx -t && docker exec web nginx -s reload
# 3. 确认换上了（看 notAfter）
echo | openssl s_client -connect bdog.gtsiot.cn:443 -servername bdog.gtsiot.cn 2>/dev/null | openssl x509 -noout -dates
```

**TLS 策略为什么不写在 bdog 的 server 块里**：同一台机器的 443 是所有站点共用的一个 socket，
nginx 只认第一个 server 块上的 `ssl_protocols` / `ssl_ciphers`。在 bdog 块里再写一遍只会得到
`protocol options redefined for 0.0.0.0:443` 警告，实际不生效。现在全站用的是 `http{}` 里那套
（`TLSv1 TLSv1.1 TLSv1.2`），实测协商结果是 **TLSv1.2 + ECDHE-RSA-AES256-GCM-SHA384**。
要收紧到只留 TLS1.2/1.3，得改 `http{}` 那两行 —— 会影响 gtsiot / kesi / dsh 所有站点，需要单独排期。

## 6. 回滚

```bash
npm run deploy -- --rollback
```

读服务器上的 `.deploy-state.json`，把 `current` 软链换回上一份 release，并用上一版镜像 tag
`up -d`。**两个指针一起回**，所以不会出现「新前端 + 旧后端」。状态文件里同时保留
previous 与 current，连按两次回滚会在两版之间来回，不会越滚越旧。

## 7. 排障手册（都是这套环境里真踩过的）

### 7.1 容器里 `node` 起不来：`uv_thread_create` 断言失败

```
Assertion failed: (0) == (uv_thread_create(t.get(), start_thread, this))
```

服务器是 CentOS 7 + **Docker 19.03**，它的默认 seccomp 配置比 glibc 2.36 旧；`node:20` / `node:22`
的 **bookworm** 镜像在容器里连 `node -e 'console.log(1)'` 都会 abort。不是镜像坏，是宿主 Docker 太老。

解决：基础镜像用 **bullseye**（glibc 2.31，不用 clone3）。`server/Dockerfile` 的 `NODE_IMAGE`
默认就是 `docker.m.daocloud.io/library/node:22-bullseye-slim`。验证过：

```bash
docker run --rm docker.m.daocloud.io/library/node:22-bullseye-slim node -v   # 正常
```

Docker 19.03 的 `docker build` **不支持** `--security-opt`（会报 "daemon on this platform does not
support setting security options on build"），所以别指望用 seccomp 参数绕过去。根治办法是升级宿主
Docker，但那会影响 gtsiot / kesi / airiot 一堆现有容器，不在本次范围。

### 7.2 构建时 `apt-get` 全部 timeout

服务器连不上 `deb.debian.org`，任何 `apt-get update` 都会卡死。所以运行时镜像**不装任何包** ——
`node:22-bullseye-slim` 自带 libssl1.1 与 ca-certificates，Prisma 的 `debian-openssl-1.1.x` 引擎直接能用。

### 7.3 `Additional property name is not allowed`

服务器上的 compose 是 **v2.2.2**，不认识 compose 文件顶层的 `name:`（2.3.3+ 才有）。项目名统一用
`-p bdog` 传，compose 文件里不要写 `name`。

### 7.4 `docker: 'compose' is not a docker command`

Docker 19.03 没有内置 compose 子命令，用独立的 `docker-compose`（v2.2.2）二进制。脚本里已经改成
`docker-compose --env-file ... -p bdog -f ... up -d`。

### 7.5 `scp: stat local "22"` / ssh 端口

`ssh` 的端口是 `-p`，`scp` 是 **`-P`**。脚本里两套参数分开拼（`sshBase` / `scpBase`）。

### 7.6 本机构建镜像报 `input/output error`

Mac 磁盘满了（Docker Desktop 的 VM 磁盘一满就报 `write .../meta.db: input/output error`）。所以默认
**在服务器上构建**：上传 `server/`（几 MB）后在服务器 `docker build`，服务器能连 swr / daocloud 镜像站
和 npm 源，构建环境自洽。本机 Docker 恢复健康后可以用 `BUILD_ON=local` 走 save/load。

### 7.7 微信支付：`RESOURCE_NOT_EXISTS 无可用的平台证书`

用 saas 项目的商户私钥调 `/v3/certificates` 返回这个 —— 说明该商户是**微信支付公钥模式**，
平台证书模式已经不给用了。所以验签材料改成二选一：

```
WECHAT_PAY_PLATFORM_PUBLIC_KEY=...      # 公钥模式（还需 WECHAT_PAY_PLATFORM_PUBLIC_KEY_ID）
WECHAT_PAY_PLATFORM_CERT=...            # 老的平台证书模式
```

缺哪个，`/api/payments/catalog` 就**如实**报「未配置」，不会画一个扫不出来的二维码。
公钥要去商户平台下载（见 §8 缺口 1）。

### 7.8 设备端取了另一台机器的文件

`server/.env` 里 `PUBLIC_BASE_URL` 指向旧 demo 域名（`https://ballondog.hd.takin.cc`）时，签名媒体 URL 是**绝对**地址；
本机跑设备端 e2e 会去公网域名取字节，取到的是另一份部署的文件。`android/scripts/e2e-agent.mjs`
的 `fetchMediaBytes()` 会在 origin 与 `API_BASE` 不同时改写为 API 源站（签名只覆盖 mediaId + 过期时间，
与 host 无关）。线上部署不会有这个问题：`PUBLIC_BASE_URL` 就是自己的域名。

### 7.9 换版后首页 403 / 管理后台 500（Docker 旧软链陷阱）

发布流程是「换 `current` 软链」，如果 bdog-web 把 `current` 直接挂进容器，Docker 会在**启动时**
把软链解析成真实 inode。之后换链，容器仍然看旧目录；旧 release 一被清理，容器看到的就是一个空目录
—— 于是 `/` 变成 403（没有 index.html）、`/admin/login` 变成 500。

现在的做法是挂**整个 `releases/` 目录**，nginx 的 `root` 指向里面的 `current` 软链（每个请求自己解析），
换链立刻生效且不用重建容器。如果以后有人把挂载改回去，请记得每次发布后 `docker restart bdog-web`。

### 7.10 容器一直 `health: starting`

`nginx:1.25.0` 里**没有 wget**，只有 curl。healthcheck 写成 `wget` 会一直失败（`wget: not found`），
容器永远是 `starting`。用 `curl -fsS -o /dev/null http://127.0.0.1/`。

### 7.11 点「支付宝支付」直接报错

两层原因，先看是哪一层：

1. **密钥根本解析不了**（我们自己的 bug，已修）。支付宝密钥工具导出的是**裸 base64**，
   首尾没有 PEM 头；`crypto.sign()` 直接抛 `DECODER routines::unsupported` → 接口 500。
   而渠道目录只看「变量有没有值」，所以后台一直显示 `configured: true`。
   现在 `payments.keys.ts` 会按 PKCS#8 / PKCS#1 / SPKI 依次尝试补头解析，
   `npm run check:payment-keys`（`npm run deploy` 前置步骤也会跑）能提前发现：
   ```bash
   npm run check:payment-keys                       # 离线：密钥能否解析、能否签名
   npm run check:payment-keys -- --network          # 再加一次真实网关取证
   ```
2. **渠道侧没签约 / 没授权**（账号的事，代码改不了）。网关会返回
   `insufficient-isv-permissions`（ISV 权限不足）或把用户重定向到 `appAssign.htm`（应用授权页）。
   现在的做法是下单时用同一张收银台 URL 自探一次，命中已知错误特征就改回一句中文 `503`：
   「支付宝渠道还没开通：商户平台未签约「手机网站支付」，或该应用没拿到支付接口授权」。
   要真的收到钱，需要在支付宝开放平台给这个应用签约「手机网站支付」并完成授权。

`alipay.trade.query`（无副作用）可以单独验签名与时间戳：返回 `ACQ.TRADE_NOT_EXIST` 就说明
签名、appid、时间戳都对，只是「这个单号不存在」——这条路能排除掉 1 和签名类问题。

### 7.12 微信域名校验文件（`MP_verify_*.txt` / `*_*.txt`）

微信后台校验「网页授权域名 / JS 接口安全域名」时，要求把给定的文本放到站点根路径。
本项目不在 `bdog-web` 的静态产物里，而是放在**边缘 nginx 的静态根**
`/opt/app/airiot/web/public/`，并在 `/opt/app/airiot/web/nginx.conf` 的 `bdog.gtsiot.cn`
server 块里加 `location = /<文件名> { root /usr/share/nginx/html; }` 精确匹配。
换域名或微信要求重新校验时，按同样方式再放一次即可（校验通过后文件可以留着）。

## 8. 已知缺口（诚实清单）

1. **两个支付渠道都还不能真正收款**：
   - 微信：**已连通**。商户是公钥模式（调 `/v3/certificates` 返回 `RESOURCE_NOT_EXISTS`），
     微信支付公钥 `pub_key.pem` 已写入 `WECHAT_PAY_PLATFORM_PUBLIC_KEY`（ID
     `PUB_KEY_ID_0117493864142026081900192149000003`），生产实测下单返回真实 `code_url`
     （`weixin://wxpay/bizpayurl?pr=…`）。还差的只是「真扫一次钱」这一步没做。
   - 支付宝：密钥齐全（与 saas 项目**逐字节相同**）、签名与时间戳都对（`check:payment-keys
     -- --network` 能过），但**手机网站支付未签约**、**电脑网站支付没有商户授权**。代码侧已把
     两个产品的失败原因翻译成家长能看懂的中文提示（§7.11）；签约或用 `ALIPAY_APP_AUTH_TOKEN`
     授权后**无需发版**即可生效。
2. **证书是手工放的，没有自动续期**：这张 2027-01-18 到期，到期前要按 §5 重新签一张换上去。
   忘了换就是全站证书过期（家长端、后台、孩子端下载、微信登录回调、支付回调一起挂）。
3. **没有定时备份**：`/opt/app/bdog/backup/` 是空目录，`pgdata` 与 `uploads` 都没人备。建议加一条
   cron：`pg_dump | gzip` + `rsync uploads`，保留 7 天。
4. **单机，没有监控**：挂了不会有人知道。可用的最便宜信号是 `curl /health` 的定时探测。
5. **媒体在本地盘**：`uploads/` 没做对象存储，换机器要连盘一起搬。
6. **没有 CI**：部署是「本机一条命令」，没走流水线；好处是简单，坏处是「谁在哪台机器上发的版」没有记录
   （`.deploy-state.json` 里有 tag 和 UTC 时间，算半条记录）。
7. **宿主 Docker 19.03**：老到连 `docker compose` 都没有，且默认 seccomp 与新版 node 冲突（§7.1）。
   升级能一次性解决，但会动到现有站点，需要单独排期。
8. **只跑过 API 33 模拟器**：孩子端真机（尤其小米/华为的强管控）还需要按
   [`PLAN-e2e-automation.md`](PLAN-e2e-automation.md) §5 的机型矩阵实机验证。

## 9. 日常命令速查

```bash
# 发布 / 回滚
npm run deploy
npm run deploy -- --rollback

# 线上冒烟（真开浏览器：页面渲染、控制台报错、接口反代、APK 下载）
node scripts/smoke-deployed.mjs https://bdog.gtsiot.cn
SMOKE_PHONE=... SMOKE_PASSWORD=... node scripts/smoke-deployed.mjs https://bdog.gtsiot.cn  # 含登录
SMOKE_SHOT=/tmp/live.png node scripts/smoke-deployed.mjs http://bdog.gtsiot.cn              # 存截图

# 服务器上
ssh -i ~/Documents/keys/gtsiot.pem root@43.137.2.132
docker ps --filter name=bdog
docker logs -f --tail 100 bdog-server
docker exec -it bdog-server sh
docker exec -it bdog-postgres psql -U balloon balloon_dog

# 边缘 nginx（改动必须先备份）
cp /opt/app/airiot/web/nginx.conf /opt/app/airiot/web/nginx.conf.bak-$(date +%s)
docker exec web nginx -t && docker exec web nginx -s reload
```
