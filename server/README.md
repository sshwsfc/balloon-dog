# 气球狗 · 后端服务

Express 5 + TypeScript + Prisma + PostgreSQL。
按 feature slice 组织（`dto / routes / controller / service / repository`），
架构与 `~/workspaces/kesi/packages/saas/server` 保持一致。

---

## 快速开始

```bash
cd server
npm install

npm run db:up            # 起 PostgreSQL（docker，端口 5433）
npm run prisma:migrate   # 建表
npm run seed             # 灌演示数据（题库 + 演示账号 + 演示设备）
npm run dev              # 启动，监听 http://localhost:4000
```

健康检查：

```bash
curl localhost:4000/health   # {"status":"ok","env":"development"}
curl localhost:4000/ready    # {"status":"ok","checks":{"database":"ok"}}
```

演示凭据（由 seed 写入）：

| 用途 | 值 |
| --- | --- |
| 家长账号 | `13800138000` / `balloon123` |
| 已绑定设备 | `DEMO0001`（小明的小米手机）、`DEMO0002`（小明的 iPad） |
| 待认领设备 | 绑定码 `PAIRME01` |
| 管理后台（超级管理员） | `admin` / `balloon-admin-2026` ⚠️ 上线前必须修改 |
| 管理后台（运营） | `operator` / `balloon-operator-2026` |

> 本地开发时**不配置**腾讯云短信即可：`POST /api/auth/send-code` 会在响应里返回
> `devCode` 并自动用于注册，无需去翻服务端日志。生产环境缺配置会直接 503 报错
> （fail-fast，避免「提示已发送、实际没发」的静默故障）。

---

## 目录结构

```
server/
├─ prisma/
│  ├─ schema.prisma        # 数据模型（36 张表）
│  ├─ migrations/          # 迁移历史
│  └─ seed.ts              # 种子数据（幂等）
├─ scripts/
│  ├─ smoke-test.mjs       # 端到端冒烟测试（167 项断言，无第三方依赖）
│  ├─ device-agent-example.mjs  # 可运行的设备端 Agent 参考实现
│  └─ clean-test-data.ts   # 清理冒烟测试留下的临时账号/设备
├─ src/
│  ├─ server.ts            # 启动入口：校验 DB → listen → 定时清理过期指令
│  ├─ app.ts               # Express 应用工厂（中间件顺序在此固定）
│  ├─ config.ts            # zod 校验的环境配置（启动即 fail-fast）
│  ├─ logger.ts            # pino 结构化日志（含敏感字段 redact）
│  ├─ prisma.ts            # PrismaClient 单例
│  ├─ errors/              # AppError 家族（操作型错误）
│  ├─ middleware/          # requestId / errorHandler / notFound / auth
│  ├─ shared/              # asyncHandler / tokens / deviceScope
│  └─ features/
│     ├─ auth/             # 注册、登录、短信、微信、资料
│     ├─ devices/          # 设备、功能开关、指令队列、设备端 Agent 接口
│     ├─ quiz/             # 题库、答题、统计
│     ├─ locations/        # 位置轨迹、安全区
│     ├─ media/            # 设备回传媒体（落盘 + 签名 URL）
│     └─ admin/            # 管理后台：独立认证、平台统计、账号/设备/题库管理、操作审计
├─ docker-compose.yml
├─ .env / .env.example
└─ eslint.config.mjs
```

---

## 设计要点

### 1. 一切以 userId 为隔离边界

`/api/device`、`/api/features` 这类接口**全部要求登录**，并且所有设备维度数据
都先经过归属校验（`shared/deviceScope.ts` 的 `requireOwnedDevice`）。
未指定 `deviceId` 时按「请求参数 → `User.activeDeviceId` → 最早绑定的设备」三级回落，
所以前端不传 `deviceId` 也能用，但每台设备的数据是真实隔离的。

> 被替换掉的 mock 版把 `device` / `features` 做成全局单例且不鉴权，
> 任何未登录请求都能读写，且用户之间互相串数据。详见根目录 README 的「修复清单」。

### 2. 远程能力走「指令队列」，不在 HTTP 请求里假装成功

远程锁屏、拍照、录像、截图这些能力后端**无法自己完成**，必须有设备端 Agent 执行。
所以后端只做三件事：

1. 以 `pending` 状态入队（带过期时间）；
2. 设备端长轮询领取，用 compare-and-set 转 `dispatched`（防并发重复领取）；
3. 设备端回报结果 → `succeeded` / `failed`。

家长端看到的 `locked` / `tempUnlock` 是**期望状态**：下发时立即更新（保证 UI 即时反馈），
但会同时把下发前的状态快照存进 `payload.__revert`。指令失败、超时、被撤销时自动回滚。

超时未领取/未完成的指令由定时任务（`COMMAND_SWEEP_INTERVAL_MS`）收敛成 `expired` 并回滚。

### 3. 设备配对流程

```
孩子设备                                    家长 App
────────                                   ────────
本地生成 deviceCode + deviceSecret
POST /api/agent/register  ──────────────►  建一条 userId=null 的待认领设备
拿到 deviceToken（长期有效）并持久化
屏幕上显示 8 位 deviceCode
                                           输入 deviceCode
                                           POST /api/devices/bind ──► 认领（userId 落库）
循环：heartbeat / commands/next / config
```

- 同一对 `deviceCode + deviceSecret` 重复 `register` 是幂等的（用于 App 重装/重启后恢复身份），
  密钥不匹配返回 403 —— 防止别人拿设备码冒充设备。
- 已认领的设备不能再被他人绑定（409）。
- 解绑会级联删除该设备的指令、位置、媒体、答题记录，并立即让设备令牌失效。

### 4. 媒体访问用「短时效签名 URL」

孩子屏幕的照片是最敏感的数据，因此：

- 上传只允许设备令牌，且 `kind` 与 mime 类型必须匹配；
- 落盘文件名由服务端随机生成（防路径穿越），白名单映射扩展名；
- 读取**没有**无凭据路径，只接受两种方式：
  - `?t=<expire>.<hmac>`（签名绑定 mediaId，默认 10 分钟有效）—— 供 `<img src>` 使用；
  - `Authorization: Bearer <家长令牌>` —— 供程序化下载。

### 5. 错误体约定

所有错误响应统一为：

```json
{
  "title": "VALIDATION_ERROR",
  "status": 422,
  "message": "提交内容有 1 项未通过校验",
  "detail": "code: 验证码为 6 位数字",
  "errors": [{ "path": "code", "message": "验证码为 6 位数字" }],
  "request_id": "8f3c…"
}
```

`message` 永远是可直接展示给用户的中文短句；前端 `ApiError.userMessage` 直接取它。
`request_id` 与结构化日志一一对应，排查线上问题时用它串起来。

---

## 管理后台（/admin）

后台是**独立的管理员体系**，与家长端完全隔离：独立的表（`Admin`）、独立的令牌
（JWT 里 `kind: 'admin'`）、独立的 SPA 入口、独立的 localStorage key。

### 三层防护

1. **操作审计**（`admin.audit.ts`）挂在路由最前面 —— 无论成功、失败还是 401，
   `/api/admin/*` 的每一次请求都会落库（含**登录失败**的尝试，便于发现爆破）。
   请求体里的 `password` / `token` / `secret` / `openid` 等字段在入库前统一替换为 `***`。
2. **登录单独限流**：`ADMIN_LOGIN_RATE_LIMIT_MAX`（默认 10 次/分钟），并且
   `skipSuccessfulRequests: true` —— 只统计**失败**尝试。爆破仍被限死，
   但同一出口 IP 下多个管理员的正常登录不会互相挤掉配额。
3. **双闸鉴权**：`authenticateAdmin`（任何管理员）+ `requireSuperAdmin`（仅超级管理员）。

### 角色

| 角色 | 能做 |
| --- | --- |
| `super` 超级管理员 | 全部权限，含新建/禁用/删除管理员、重置他人密码 |
| `operator` 运营 | 看数据、处置家长账号与设备、维护题库；**不能**管理管理员账号 |

代码层面还有几条硬性保护：

- 不能禁用或删除**自己**；
- 不能删掉/禁用**最后一个可用的超级管理员**（避免把后台锁死）；
- 改自己的密码必须走 `/admin/password`（校验原密码），不能走「重置他人密码」接口。

### 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/admin/login` | 管理员登录（唯一公开接口，单独限流） |
| GET | `/api/admin/profile` | 当前管理员身份 |
| POST | `/api/admin/password` | 修改自己的密码（校验原密码） |
| GET | `/api/admin/stats?days=30` | 数据看板：KPI + 按天趋势 + 分布 |
| GET | `/api/admin/users` | 家长账号列表（`q` / `status` / 分页） |
| GET | `/api/admin/users/:userId` | 家长账号详情（设备清单、各类计数、最近指令） |
| PATCH | `/api/admin/users/:userId/status` | 启用/禁用（禁用后其令牌立即失效） |
| DELETE | `/api/admin/users/:userId` | 删除账号（级联清理其所有数据） |
| GET | `/api/admin/devices` | 设备列表（`q` / `bound` / `status` / `locked` / `userId`） |
| GET | `/api/admin/devices/:deviceId` | 设备详情（管控配置快照 + 指令历史） |
| POST | `/api/admin/devices/:deviceId/unbind` | 强制解绑（设备保留，等待新家长认领） |
| DELETE | `/api/admin/devices/:deviceId` | 删除设备 |
| GET | `/api/admin/commands` | 指令监控（`status` / `type` / `deviceId` / `onlyFailed`） |
| POST | `/api/admin/commands/:commandId/cancel` | 撤销未执行的指令（含状态回滚） |
| GET | `/api/admin/questions` | 题库列表（`type` / `grade` / `q`，附年级题量分布） |
| POST/PATCH/DELETE | `/api/admin/questions[/:id]` | 题目增删改 |
| GET | `/api/admin/quiz-records` | 全平台答题记录 |
| GET | `/api/admin/sms-codes` | 验证码审计（`phone` / `purpose` / `state`） |
| POST | `/api/admin/sms-codes/purge` | 清理已使用/已过期的验证码 |
| GET | `/api/admin/logs` | 操作日志（`action` / `status` / `onlyFailed`） |
| GET/POST | `/api/admin/membership/plans` | 套餐列表（含已售数量与上架覆盖矩阵）/ 新建套餐 |
| PATCH/DELETE | `/api/admin/membership/plans/:id` | 改价、上下架 / 删除（**有订单的套餐拒绝删除**，只能停用） |
| GET/POST | `/api/admin/membership/rules` | 定价规则列表（附带「参数不全、永不命中」的告警）/ 新建规则 |
| PATCH/DELETE | `/api/admin/membership/rules/:id` | 改规则（校验**合并后**的规则）/ 删除（订单存的是快照，可安全删） |
| GET/POST | `/api/admin/membership/referral-rules` | 受邀用户定价规则列表 / 新建（`percent` 上浮比例 · `amount` 加收固定金额 · `fixed` 一口价） |
| PATCH/DELETE | `/api/admin/membership/referral-rules/:id` | 改 / 删（订单存的是快照，可安全删） |
| POST | `/api/admin/membership/simulate` | 试算：可按 `userId` 用真实画像，也可直接传画像（含 `invited` / `referralActive`）；同时给出「命中但被不可叠加挤掉」的规则 |
| GET | `/api/admin/membership/orders` | 订单列表（状态/档位/周期/渠道/日期区间/订单号或手机号） |
| GET | `/api/admin/membership/stats?days=30` | 会员统计（收入、付费用户、转化率、档位分布、按天序列、套餐销量） |
| GET | `/api/admin/referral/stats?days=30` | 返现统计（总/待发/已发放、首充 vs 续费、提现口径、按天序列、邀请排行） |
| GET | `/api/admin/referral/invitees` | 邀请记录（`q` / `status` / 日期区间） |
| GET | `/api/admin/referral/rewards` | 返现明细（`q` / `status` / `kind` / 日期区间） |
| GET | `/api/admin/referral/coupons` | 优惠券发放与核销 |
| GET | `/api/admin/referral/withdrawals` | 提现申请（`q` / `status` / `channel`） |
| POST | `/api/admin/referral/withdrawals/:id/review` | 审核提现：`approve` / `reject` / `pay`，**状态机单向** |
| GET/PUT | `/api/admin/referral/rules` | 返现阶梯 + 券里程碑（PUT 是**整表替换**） |
| GET/PUT | `/api/admin/referral/config` | 活动开关、文案、说明条款、发放日、提现门槛 |
| GET | `/api/admin/referral/risk` | 反作弊排查（自邀 / 同证件多账号 / 短时批量绑定 / 提现久悬） |
| GET | `/api/admin/admins` | 管理员列表 |
| POST | `/api/admin/admins` | 新建管理员 🔒 超级管理员 |
| PATCH | `/api/admin/admins/:id/password` | 重置他人密码 🔒 |
| PATCH | `/api/admin/admins/:id/status` | 启用/禁用 🔒 |
| DELETE | `/api/admin/admins/:id` | 删除管理员 🔒 |

### 刻意不做的事

- **后台不提供孩子照片、位置轨迹、录音的内容查看**。设备详情只展示管控配置与
  统计口径（数量、体积），家长账号详情不返回原始 `wechatOpenid`。
  这类内容是儿童隐私，运营没有查看的必要；确实需要时应走独立的、有单独授权与
  留痕的流程，而不是顺手挂在后台列表上。
- **验证码审计不返回 `codeHash`**，后台无法查看验证码明文 —— 审计表不能成为破解入口。
- **后台不提供通话记录与短信内容**（`/api/admin/*` 下没有对应的内容接口，只有计数）。
  短信用看板计数即可满足运营需要，内容属于儿童隐私。
- **已有孩子作答记录的题目不允许删除**，返回 409 并提示改为「修改题干」，
  避免外键级联把答题历史一并清掉。

### 前端

后台是独立的 Vite 入口（`admin/index.html` + `src/admin/`），
路由 `basename = /admin`，挂载点 `#admin-root`。
这样后台代码不会进家长端的产物包，家长端的改动也不会意外暴露后台页面。

```bash
npm run preview          # 对外站点（2727，跑 dist/ 产物，需先 npm run build）
# 家长端： http://localhost:2727/
# 管理后台：http://localhost:2727/admin

npm run dev              # 本机开发（5173，带 HMR；家长端与后台同一个 dev server）
# 家长端： http://localhost:5173/
# 管理后台：http://localhost:5173/admin
```

`vite.config.ts` 里的 `admin-history-fallback` 插件会给 dev 与 preview 两个服务器都装上
`/admin/**` → `admin/index.html` 的回落（否则刷新深层路由会 404），
生产部署时 nginx 需要做同样的 try_files 配置。

---

## API 一览

### 认证 `/api/auth`

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/send-code` | 发送短信验证码。`purpose`: `register` / `login` / `bind`；未配置短信通道时返回 `devCode` |
| POST | `/register` | 注册（手机号 + 密码 + **真实验证码**） |
| POST | `/login` | 密码登录（bcrypt 校验） |
| POST | `/sms-login` | 验证码登录，手机号首次使用自动注册 |
| POST | `/logout` | 登出（JWT 无状态，服务端仅记日志） |
| GET | `/wechat/qr` | 创建微信扫码会话 |
| GET | `/wechat/state` | 轮询扫码状态（done 时返回 token，**一次性交付**） |
| GET | `/wechat/authorize-url` | 微信内置浏览器直接授权跳转 |
| POST | `/wechat/dev-scan` | 联调模拟扫码（仅未配置真实微信时可用） |
| GET | `/wechat/callback` | 微信授权回调（返回 HTML，postMessage + 顶层跳转双模式） |
| GET | `/wechat/jsapi-signature` | 微信 JS-SDK 签名（给家长端在微信里扫孩子端绑定码二维码用）。`url` 必填且必须是绝对 http(s) 地址，**不能 trim/转义** —— 微信要求它与页面 url 逐字符一致，签名串固定为 `jsapi_ticket=…&noncestr=…&timestamp=…&url=…` 再 SHA-1。`access_token` / `jsapi_ticket` 各缓存 2 小时（提前 5 分钟过期），否则每次扫码都换 token 会烧光每天 2000 次的配额；未配置公众号凭证时返回 503 `WECHAT_NOT_CONFIGURED`，前端据此退回页面内摄像头扫码 |
| GET/PUT | `/profile` | 读取/更新资料 |
| POST | `/change-password` | 修改密码 |
| POST | `/bind-phone` | 绑定/换绑手机号 |

### 用户 `/api/user`（兼容旧前端路径）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET/PUT | `/info` | 等价于 `/auth/profile` |
| GET | `/devices` | 等价于 `/api/devices` |
| DELETE | `/devices/:deviceId` | 等价于 `DELETE /api/devices/:id` |
| POST | `/select-device` | 切换当前设备 |

### 设备 `/api/devices`、`/api/device`

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/devices` | 设备列表 |
| POST | `/api/devices/bind` | 凭 `deviceCode` 认领设备（幂等） |
| PUT/DELETE | `/api/devices/:deviceId` | 改名 / 解绑 |
| POST | `/api/devices/:deviceId/select` | 设为当前设备 |
| GET | `/api/device` | 当前设备视图 |
| POST | `/api/device/lock` | 锁屏/解锁（下发指令） |
| POST | `/api/device/temp-unlock` | 临时解锁 N 分钟 |
| POST | `/api/device/cancel-temp-unlock` | 取消临时解锁 |
| GET | `/api/device/time-requests` | 孩子的申请列表。`?status=pending`（默认）/`approved`/`rejected`/`all`；响应 `{ items: TimeRequestView[] }`，每项 `{ id, kind, kindLabel, minutes, reason, status, reviewNote, grantedMinutes, reviewedAt, createdAt }`（`kindLabel` 是服务端给的中文类型名，前端在渲染处包 `t()`） |
| POST | `/api/device/time-requests/:id/review` | 批准/拒绝一条申请。body: `{ status: 'approved'\|'rejected', minutes?, note? }`。**批准会真的下发 `temp_unlock` 指令**（服务端绝不自己宣布已解锁），且 `minutes` 只能**改小**（`Math.min(输入, 申请值)`），实际给的存进 `grantedMinutes` 留痕；拒绝不发指令。已处理过再改 → `409 这条申请已经处理过了` |
| POST | `/api/device/remote-photo` | 远程拍照 |
| POST | `/api/device/screenshot` | 屏幕截图 |
| POST | `/api/device/start-recording` `/stop-recording` | 录像 |
| POST | `/api/device/start-audio` `/stop-audio` | 录音 |
| POST | `/api/device/start-ambient` `/stop-ambient` | 环境监听（分片连续录音），需要 `audioRecord`；**`stop-ambient` 不校验开关**，保证随时停得下来 |
| POST | `/api/device/remote-action` | 远程协助。body: `{ action: 'back'\|'home'\|'recents'\|'notifications'\|'open_app', packageName? }`，需要 `remoteHelp`；`action='open_app'` 必须带 `packageName` |
| POST | `/api/device/sync-calls-sms` | 让设备立即上报通话/短信，需要 `callSms`（平时设备每 6 小时自报） |
| GET | `/api/device/health` | 设备健康快照：哪些开关被关了、缺口原文、三档等级、在线分级 |
| POST | `/api/device/health/check` | 下发 `self_check` 让设备立刻体检并回传快照 |
| GET | `/api/device/commands` | 指令历史（可 `?status=` `?limit=`） |
| POST | `/api/device/commands/:commandId/cancel` | 撤销未执行的指令 |

> 下发类接口返回 `202` + `{ command, device, warning? }`。
> 设备离线时 `warning` 会明确告知「指令将在设备上线后执行」。

### 设备健康与权限可见性

孩子端 20 多项管控能力全都压在两三个开关上（设备所有者 / 无障碍看门狗 / 运行时权限 /
电池白名单 / VPN）。任意一个被关掉，管控就**静默失效** —— 设备照样在线、家长端照样绿灯。
这一块把「设备自己知道的事」变成「家长端一眼看得见 + 一点就能修」。

**上报**（设备令牌，覆盖式，不是增量）：

```
POST /api/agent/health
{
  level?: 'ok'|'warn'|'danger',        // 设备端自己的结论；缺省时服务端兜底推算（老版本 Agent）
  gaps: [{ id, label, detail, importance: critical|major|minor,
           fixability: auto|manual|none, fixHint }],
  checks:        { deviceOwner: true, accessibility: false, ... },   // 容忍未知 key
  permissions:   { location: 'granted'|'denied', ... },
  restrictions:  [{ id, label, supported, applied }],                // OwnerHardening.audit() 原样
  serviceRunning, clockSkewSeconds, healCount, lastHealAt
}
→ { success, serverTime, level, openGaps }
```

四条设计约束：

- **`checks` 刻意不写成固定 key 的 object**：设备端版本可能比服务端新（先发了新检查项）
  也可能更旧（还没实现某项）。固定 key 会让老设备直接 422，或者让缺失项的 `default(false)`
  变成一条「开关被关掉」的**假警报**。所以只约束「值必须是 boolean」，缺 key 就是「未知」，
  家长端显示「未知」而不是猜一个绿灯。
- **缺口原文透传**：`detail` 就是设备端 `LongevityGuard` 那句中文，服务端与家长端都不重写。
  两边各写一套迟早会出现「设备说无障碍被关、家长端说悬浮窗被关」的矛盾。
- **等级以设备端为准**，服务端只在 `level` 缺失时才用 `deriveHealthLevel` 兜底
  （关键项关着 → danger，否则有缺口 → warn）。
- **整份覆盖**：某条缺口修好后不再出现在 `gaps` 里，`openGaps` 会跟着降下来，不是累加。

**读取**：`GET /api/device/health` 返回三档等级（`ok` 管控正常 / `warn` 部分能力降级 /
`danger` 管控已实质失效，还有「尚未检测」）、**在线分级** `liveness`
（`online` / `delayed` / `offline` / `lost` / `never`，按 `lastActiveAt` 现算）、
开关一览（on/off/**unknown**）、权限一览、缺口清单（含严重程度与修复方式）、加固项审计、
`serviceRunning` / `healCount` / `clockSkewSeconds`。

- **快照陈旧判定**：超过 30 分钟没再上报就标 `stale` —— 过期的绿灯比红灯更危险，
  家长端会把整页降级显示成「数据陈旧」。
- **`clockSkewSeconds`**：设备墙钟与服务端的偏差，由设备端用「开机时长 + 服务端 `serverTime`」
  算出来（做法与取舍见 `android/README.md` §5.9）。**没有锚定过的设备报 0**，
  所以 0 的含义是「不知道或一致」，不是「一定准」；家长端在 `|skew| ≥ 60 秒` 时把这行标红，
  文案是「孩子手机的时间和服务端相差 N 秒」。服务端**不**因为偏差去改健康等级 ——
  时钟不准会让规则提前/推迟生效，但它本身不是「管控已失效」。
- **失联补记动态**：读健康页时若设备已 offline/lost，顺带写一条 `agent_offline`
  设备事件（6 小时去重），家长反复刷新不会刷出一屏重复告警。这也是唯一一处
  「读接口写数据」，理由是一次失联值得留在时间线上。

**「重新检测」**：`POST /api/device/health/check` 下发 `self_check` 指令（走指令队列，
服务端不能替设备看系统开关）→ 设备端跑 `LongevityGuard.selfHeal`（幂等）→ 立刻回传新快照。
家长端轮询 `updatedAt` 等回报，15 秒没等到就如实说「设备可能离线」，
**绝不乐观置绿**。设备端漏加 `self_check` 的 switch 分支就是「家长端显示已下发、设备毫无反应」，
所以它同时出现在 `COMMAND_TYPES`、`CommandExecutor` 与设备端常量表三处。

### 站内通知 `/api/notifications`

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/` | 消息列表，分页（`?page=&pageSize=&unreadOnly=&type=&level=`），响应额外带 `unreadCount` |
| GET | `/unread-count` | 只取未读数（家长端角标轮询用） |
| POST | `/:notificationId/read` | 标记单条已读 |
| POST | `/read-all` | 全部已读 |
| DELETE | `/:notificationId` | 删除单条 |
| GET | `/preferences` | 八类通知 × 三个通道的偏好（没有行 = 用默认值） |
| PUT | `/preferences` | **整份替换**偏好，不是逐条 PATCH |

**为什么不复用 `DeviceEvent`**：那张表是设备视角的运行日志 —— 没有「已读」，没有「这条是给
哪个家长的」，也不该被家长删掉。通知是**家长级**的：`Notification` 有 `userId`（必填）、
可选的 `deviceId`（账号级事件如会员到期为 null）、`readAt`，以及 `@@unique([userId, dedupeKey])`。

**幂等靠唯一约束，不靠先查后写**：`createIdempotent` 里先 `findUnique(userId_dedupeKey)`
命中就 no-op，未命中才 create。去重键由生产点自己给（例如失联用这一天的时间桶），
所以「同一次失联」只会有一条消息，重试也不会变成两条。

**关掉某一类之后，服务端就不再产生它** —— 过滤发生在**写入侧**（`notificationsService.notify`
先读偏好，`inApp: false` 直接 return），不是前端隐藏。否则家长的未读角标会一直亮着，
点进去却什么都没有。这也是 `e2e-notifications` 专门断言的一条。

**标题与正文存的是「模板 + 参数」，不是拼好的句子**：`title` / `body` 是 key 形状的模板（`'{{v0}} 已失联'`），
变量单独放在 `titleParams` / `bodyParams` 两个 JSONB 列里。**为什么**：生产者若把 `` `${device.name} 已失联` ``
拼好再落库，整句就不是一条 i18n key，家长切到英文时必然露出中文（`e2e:ux` 的英文扫描抓到过
`/notifications: 18 个中文字`）。前端渲染时把模板与每个字符串参数都过一遍 `t()` —— 参数里常常
本来就是 key（`无障碍看门狗`、`申请加时`），而设备名、孩子写的理由这类用户数据查不到词典会原样回显。
**注意 `DeviceEvent.detail` 仍是拼好的中文**：那是设备日志，不在通知这条规则里。

**微信服务号模板消息（第二个通道，规划 §2.1 第二档）**：站内之外只有这一条真实通道，
它靠 `NotificationDelivery` 投递表 + `notifications.wechat.ts` 的发送函数实现。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/channels/wechat/test` | 发一条测试消息。body: `{ notificationId? }`。未配置 → **503**、未绑定微信 → **400**、指定的 `notificationId` 不存在/不属于自己 → **404**；微信报错时把 `errcode` 原文带进 503 的 message |

- **`configured` 由环境变量决定**：`WECHAT_LOGIN_APP_ID` + `WECHAT_LOGIN_APP_SECRET` +
  `WECHAT_TEMPLATE_ID` 齐了才算配好；`bound` 看 `User.wechatOpenid`（用微信扫码登录过一次就有）。
  偏好页的逐类微信开关只在两者都成立时出现，否则显示「未配置」/「未绑定微信」。
- **投递是懒的，但不会丢**：`notify()` 在写入通知成功后才入队一条 `NotificationDelivery`
  （幂等键是 `notificationId`）。真正发送发生在家长「打开消息中心 / 拉未读数」时
  （`dispatchWechatDeliveries`，放在 `runLazyChecks` 的 `finally` 里 —— 普通账号的会员分支
  `return` 过这条路径，写成 try 后面的普通语句会永远走不到）。没配置或没绑定时停在
  `pending`，**不是 failed**：配好之后同一条会照发。
- **重试与令牌**：`WECHAT_DELIVERY_MAX_ATTEMPTS = 3`（一次投递最多发 3 次，失败原因截断 500 字存
  `lastError`）；微信的 `40001/40014/42001/42007` 视为令牌失效，
  服务端作废缓存令牌、重取一次再发（假上游就是靠这个行为做的断言）。
- **`WECHAT_API_BASE_URL`** 只是为了本地对着假上游联调（`server/scripts/mock-wechat-server.mjs`，
  默认 **:4100** —— 与 `server:mock:ai` 同一个默认端口，两者不要同时跑，冲突时用
  `MOCK_WECHAT_PORT` 改开），生产留空即走 `api.weixin.qq.com`。
- **厂商推送是「不适用」不是「未接入」**：小米/华为/OPPO 都需要原生 App 的推送 SDK，家长端是
  移动网页。`channels.push` 回 `configured: false` + 一句原因，界面显示「不适用」。
  `NotificationPreference.push` 这一列先留着，将来真有原生壳再启用。
给一个存下来却永远不会生效的开关，比不给更糟。

**只读接口里唯一会写数据的地方**是「会员到期懒检查」：没有定时任务，所以在
`GET /`（列表）与 `GET /unread-count`（角标）里顺带看一眼 `membershipExpiresAt`
（7 天内 + 未关掉该类 → 写一条，去重键按到期日）。放在角标接口里是**故意的** ——
否则家长不点开消息中心就永远看不到到期提醒。

**六个生产点**：`devicesService.getDeviceHealth` 的失联分支（与 `agent_offline` 动态同源、
同一个去重桶）、`reportHealth` 发现新的 critical 缺口、`modeService.reportEvents` 的安全区进出、
`devicesService.createAuditRequest` 的孩子申请装应用（仅新建时才写）、
`devicesService.createTimeRequest` 的孩子申请加时/延后锁屏、
`devicesService.sos` 的孩子求助（danger 级；一分钟内连点只发一条，但动态每次都写）。

### 功能配置 `/api/features`

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/` | 聚合的功能状态（形状与旧前端契约一致） |
| PUT | `/` | `{ feature, enabled }` 切换开关（feature 走白名单） |
| PUT | `/time-plan` | 每日时长上限 |
| PUT | `/app-limit` | 应用时长限制 |
| DELETE | `/app-limit/:appName` | 移除应用限制 |
| POST | `/app-audit` | 审批应用（批准后自动写入 60 分钟限制） |
| POST | `/web-block` | 添加拦截规则：域名（自动归一化成主机名）、IPv4/IPv6 字面量、或 `10.0.0.0/8` 这样的网段；既不是域名也不是地址的一律 **400**（规划 §4.1） |
| DELETE | `/web-block/:url` | 取消拦截（与写入同一套归一化；网段的斜杠要转义成 `%2F`） |

> ⚠️ `GET /api/features` 的 `appLimit.apps` 的值已由 `number`（每日分钟上限）改为
> `{ dailyLimit, usedTodaySeconds }` 对象（键仍是应用名）：`usedTodaySeconds` 是设备上报的
> 当日已用秒数，供家长端展示；今天没上报过的应用显示为 `0`（只影响展示，惰性归零、不回写）。
> 这是**跨端契约变更**，前端 `src/types/index.ts` 与 `HomePage` 需同步。

### 通话与短信 `/api/calls`、`/api/sms`

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/calls` | 通话记录，分页（`?page=&pageSize=`，可按 `type=incoming\|outgoing\|missed`、`q=` 电话/姓名筛选） |
| GET | `/api/sms` | 短信记录，分页（可按 `type=inbox\|sent`、`address=` 筛选） |

> 这些内容是儿童隐私：**管理后台不提供任何通话/短信内容接口**，只有计数（见「刻意不做的事」）。
> 设备端批量上报走 `POST /api/agent/calls` / `POST /api/agent/sms`：
> **整表替换最近 500 条**，空数组会被 `422` 拒绝，避免一次误调用清空家长可见数据。
> 未来时间会被钳到「现在」，防止设备时钟跑飞把记录顶到列表最前。

### 答题 `/api/quiz`

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET/PUT | `/config` | 答题配置（`grade` 与 `questionBank` 同义，两个都给） |
| GET | `/question` | 预览题目（**不返回正确答案**） |
| POST | `/answer` | 家长端自测答题 |
| GET | `/records` | 答题记录 |
| GET | `/statistics` | 统计（`byType` 固定含 english/poetry/random） |
| POST | `/questions` | 新增题目 |

> 整组 `/api/quiz/*` 由 `entitlementGate('quizUnlock')` 保护，非会员一律 403。

### 会员 `/api/membership`

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/` | 会员总览：当前档位、到期时间、权益、**按账号画像算好的各档报价**、`mockPay` 开关 |
| GET | `/orders` | 充值记录（分页） |
| POST | `/orders` | 下单（`{ planCode, payChannel }`）。金额由服务端算并快照，**请求体里的价格一律忽略** |
| POST | `/orders/:orderNo/pay` | 模拟支付（`{ outcome: 'success' \| 'fail' }`）；`MEMBERSHIP_MOCK_PAY=false` 时 503 |
| POST | `/orders/:orderNo/cancel` | 取消待支付订单 |
| POST | `/auto-renew` | 开关连续包月（仅对有效付费档位开放） |

### 邀请返现 `/api/referral`

家长端按登录账号自助查看，全部走 `authenticate`，**没有 accountId 参数** —— 谁的令牌看谁的账。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/` | 总览：邀请码、分享链接、收益统计、返现阶梯（含当前档）、提现门槛逐条、实名状态、最近返现与券、活动文案 |
| GET | `/invitees` | 邀请记录（分页，手机号脱敏） |
| GET | `/rewards` | 返现明细（`?status=pending\|settled\|cancelled`） |
| GET | `/coupons` | 优惠券（`?status=unused\|used\|expired\|all`，带小计） |
| GET | `/coupons/usable` | 下单可用的券（未使用且未过期），供会员下单页选券 |
| GET | `/withdrawals` | 提现记录 |
| POST | `/identity` | 实名认证（`{ realName, idCard }`，**只存 HMAC 与后 4 位**） |
| POST | `/withdrawals` | 申请提现（`{ channel, account, amountCents?, note? }`），201 |

`GET /` 返回裸对象（其余接口是 `{ success: true, ... }`），因为它是页面首屏的唯一数据源。

### 位置 `/api/locations`、`/api/safe-zones`

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/locations` | 轨迹（可 `?from=&to=&limit=`），每条都会标注命中的安全区 |
| GET | `/api/locations/latest` | 最近一次定位 |
| GET/POST | `/api/safe-zones` | 安全区列表 / 新增 |
| PUT/DELETE | `/api/safe-zones/:safeZoneId` | 修改 / 删除 |

### 锁屏策略与作息时间表 `/api/lock-policy`、`/api/schedules`

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET/PUT | `/api/lock-policy` | 锁屏强度（`kiosk` / `password`）、锁屏前倒计时预告秒数、作息总开关 |
| GET | `/api/schedules` | 时间表列表 + **按服务器时间算的实时预览**（此刻是否锁定、命中哪条规则、下次变更时刻） |
| POST/PUT/DELETE | `/api/schedules[/:scheduleId]` | 增删改；创建时自动打开作息总开关 |

时间表语义（`evaluateSchedule`，与 Android 端 `ScheduleEngine` 同一套，已交叉验证 2016 个采样点）：

- `action`：`lock` 该时段锁定 | `unlock` 该时段允许使用；**`unlock` 优先于 `lock`**，
  因此「整晚锁定 + 中午放行」可以直接叠加表达；
- `daysOfWeek`：`0`=周日 … `6`=周六（与 JS `Date.getDay()` 一致）；
- `startMinute` `0..1439`、`endMinute` `1..1440`（`1440` 即 24:00）；
- `endMinute < startMinute` 表示**跨天**（如 `1320 → 420` = 22:00 到次日 07:00）。

> 规则随 `/api/agent/config` 下发到设备后**落盘到本机**，由设备本地时钟驱动 ——
> 孩子断网也绕不过作息表。设备端还会把**实际**锁定状态随心跳上报
> （`effectiveLocked` / `lockReason`），与家长的期望状态 `locked` 分开存放，
> 这样家长能区分「我手动锁的」和「作息时间到了所以锁了」。

### 媒体 `/api/media`

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/` | 当前设备的媒体列表（返回带签名的 `url`） |
| GET | `/:mediaId` | 读取文件（签名 或 家长令牌） |
| DELETE | `/:mediaId` | 删除（同时删磁盘文件） |

---

### 屏幕行为洞察 `/api/insights`、`/api/alerts`、`/api/screen-monitor`、`/api/usage-budgets`、`/api/usage-summary`

家长端接口，全部走 `resolveDevice` 归属校验，只看得到自己孩子。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/insights` | 洞察时间线（分页），每条含 `provider` / `summary` / `activities` / `frameCount` |
| GET | `/api/insights/:insightId` | 单条详情 |
| POST | `/api/insights/:insightId/reanalyze` | 用当前 provider 重跑一次（换了模型 key 之后用得上） |
| GET | `/api/alerts` | 异常提醒列表（未成年内容 / 疑似被骗 / 情绪问题 / 游戏沉迷 / 高额消费） |
| POST | `/api/alerts/read-all` | 全部标为已读 |
| POST | `/api/alerts/:alertId/read` | 单条标为已读 |
| GET | `/api/screen-monitor` | 截屏与 AI 设置（`captureEnabled` / 间隔 / 每包帧数 / 分析模式 / 异常项开关） |
| PUT | `/api/screen-monitor` | 更新上述设置，同时下发到设备 |
| GET | `/api/usage-budgets` | 用量预算列表（游戏局数 / 动画集数） |
| PUT | `/api/usage-budgets` | 新增或更新一条预算 |
| DELETE | `/api/usage-budgets/:budgetId` | 删除预算 |
| GET | `/api/usage-summary` | 今日已玩局数 / 已看集数 / 用量明细 |

### 模式切换 / 护眼 / 功能管控 `/api/device-mode`、`/api/study-slots`、`/api/mode-apps`、`/api/device-apps`、`/api/eye-care`、`/api/app-plugins`、`/api/device-events`

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET/PUT | `/api/device-mode` | 学习模式 / 普通模式：手动指定或按 0–23 时 × 一周七天的时段自动切换；返回服务端算出的 `effectiveMode` 与 `allDayStudyWarning` |
| GET/PUT | `/api/study-slots` | 时段格子整表读取 / 批量替换（最多 168 格） |
| GET/POST/DELETE | `/api/mode-apps` | 学习模式应用白名单（`study` / `normal` 两组） |
| GET | `/api/device-apps` | 设备已安装应用（`q` 搜索、`includeSystem` 是否含系统应用）；带图标的项额外给 `hasIcon` + 签名后的 `iconUrl` |
| POST | `/api/device-apps/refresh` | 让设备重新上报清单（走指令队列，非即时） |
| GET | `/api/app-icons/:appId` | 应用图标字节（`?v=<iconHash>&t=<过期>.<签名>`，见下方「应用图标」） |
| GET/PUT | `/api/eye-care` | 护眼：连续用眼提醒、强制休息、夜间时段、亮度上限 |
| GET/PUT | `/api/app-plugins` | 按应用聚合的功能清单与逐项开关 |
| GET | `/api/device-events` | 「最新动态」事件流（分页、可按类型筛选） |

**模式求值实现了两遍**：服务端 `mode.service.ts` 的 `evaluateMode` 用于家长端展示，
Android 的 `StudyModeEngine` 用于本地强制执行（断网也要生效）。
两边由 `npm run android:crosstest` 逐点比对，**不许漂移** —— 否则会出现
「家长端显示普通模式、孩子手机却在学习模式」这种最难排查的错位。

**插件目录是代码里的版本化产品知识**（`app.plugins.catalog.ts`），不是表数据：
微信改一次版文案就可能变，匹配关键词要跟着调，家长既没能力也不该维护它。
表里只存「家长把它开成了什么」。设备端**不需要**目录副本 —— 规则（含匹配关键词）
随配置一起下发并落盘，断网照样生效。

> ⚠️ `includeSystem` 这类查询布尔值**不能用 `z.coerce.boolean()`**：
> 它走 JS 的 `Boolean(value)`，而 `Boolean("false") === true`，
> 于是 `?includeSystem=false` 的含义正好相反。见 `mode.dto.ts` 里的 `queryBoolean`。

### 应用图标

家长端的每一个应用列表都要显示图标（「不能是一个文字图标」），链路是
**孩子端抓 → 随清单上报 → 存字节 → 家长端拿签名 URL → `<img>` 取图**：

- **字节存在 `DeviceApp.icon`（`Bytes?`）里，不落磁盘。** 每个图标最多 16KB
  （孩子端压到 12KB 以内），一台手机几百个应用也就几百 KB —— 比给每张图配一个
  文件 + 一份垃圾回收逻辑简单得多；应用卸载时行被删，图标跟着消失，不会留下孤儿文件。
- **列表接口只给 URL，不给字节。** `GET /api/device-apps` 里带图标的应用多返回
  `hasIcon: true` 和一条 `iconUrl`，几百张图的字节绝不能塞进列表响应。
- **`iconUrl` 是签名链接**（`appIconUrl.ts`）：`/api/app-icons/:appId?v=<hash>&t=<过期>.<HMAC>`，
  签名绑定 `DeviceApp.id`，TTL 7 天。没签名 / 改一个字符 / 拿 A 的签名取 B 的图 / 过期，
  一律 403。`v=<iconHash>` 兼作缓存键，换图后 URL 必然变化，不会出现「换了图标还显示旧图」。
- **过期时间按 7 天窗口对齐**，不是 `now + 7 天`。签名里带当前时间的话，同一张图每次请求
  都会拿到不同的 URL，浏览器 `immutable` 缓存一次都命不中，家长端每翻一页都要重下几十张图。
  对齐到窗口后，同一个窗口内签出的链接完全一致；用 `+2 * TTL` 保证签发时至少还有 7 天
  （和 `Cache-Control: max-age=604800` 对齐，缓存没过期链接先失效就会白图）。
- **图片类型由服务端嗅探**（PNG / JPEG / WebP 的魔数），不信客户端说的 MIME；
  不是图片、超过 16KB、base64 解不开的，**单独丢弃这一条**，不让整份清单上报失败 ——
  图标只是锦上添花，孩子端不该因为一张坏图就报不上应用清单。
- **重传不带图标 ≠ 删除图标。** 上报是「先删后插」，服务端会按包名把库里的旧图标
  合并回来；不带图标的重传只是「这次没抓到」，不是「家长不再需要」。
- 家长端统一走 `src/components/AppIcon.tsx`：有 `iconUrl` 就渲染 `<img>`，
  没有或加载失败退回首字占位块。占位块是兜底，不是默认样式。
- 抓取的是**孩子端的真实图标**：Android 用 `PackageManager.getApplicationIcon` 渲染成
  48×48 PNG，只给有桌面入口的应用抓（不可启动的系统组件不抓，家长端也不展示它们）。

### 会员体系

家长账号分 **普通 / 会员 / 超级会员** 三档，权益定义在
[`src/features/membership/membership.constants.ts`](src/features/membership/membership.constants.ts)：

| 权益 key | 名称 | 最低档位 | 覆盖 |
| --- | --- | --- | --- |
| `quizUnlock` | 答题解锁 | member | `/api/quiz/*` 整组 |
| `remoteMonitor` | 远程监控 | member | `remoteHelp` / `callSms` / `remotePhoto` / `remoteRecord` / `videoRecord` / `audioRecord`，以及截屏（`requestCapture`） |
| `multiDevice` | 绑定多台手机 | member | 普通账号只能绑 1 台（`FREE_DEVICE_LIMIT`），硬上限仍是 `MAX_DEVICES_PER_USER = 20` |
| `aiInsight` | AI 洞察 | super | `/api/insights`、`/api/alerts`、`/api/screen-monitor`（`screenMonitor` 开关也算 AI 洞察），以及家长端的洞察配置页 |

- **门禁在服务端**：`membership.guard.ts` 的 `requireEntitlement(userId, key)` 抛
  `MembershipRequiredError` → **403**，错误体 `title` 是 `MEMBERSHIP_REQUIRED`，
  `detail` 带 `{ requiredTier, entitlement, currentTier }`，家长端据此渲染升级引导。
  `entitlementGate(key)` 是用来整组挂路由的中间件写法。
- **用量上限（`/api/usage-budgets`、`/api/usage-summary`）刻意不设门禁**：
  每日使用时长属于基础管控，对任何账号都该可用；把整页 403 会把时长限制一起挡掉。
- **先会员后开关**：`requireFeatureEnabled(deviceId, key, userId)` 先查会员再查开关。
  反过来的话，家长会先被要求「请先开启 X 功能」，开完才被告知「要开会员」。
  关闭开关永远允许（`setFeature` 只在 `enabled === true` 时校验）。
- **惰性收敛**：不跑定时任务降级。`resolveMembership(userId)` 每次读取时按
  `membershipExpiresAt` 判定，过期就写回 `ordinary` 并清掉自动续费 ——
  定时任务停一次，过期账号就永久白嫖。
- **三种计费周期**：`monthly` / `yearly` / `auto_monthly`（连续包月）。
  同档续费在现有到期时间上**顺延**，升级（会员 → 超级会员）**重新起算**，
  降级立即生效；`addMonths` 会把 1/31 + 1 个月压回 2/28，不滚到 3/3。
- **自动续费用乐观锁**：`updateMany` 的 `where` 带上旧的 `expiresAt` + 档位 + 开关，
  `count === 0` 即放弃，防并发重复扣费；断档超过 `MEMBERSHIP_RENEW_GRACE_DAYS`（31 天）
  直接降级，避免放半年回来静默补扣 6 个月。
- **订单是快照**：下单那刻的 `originalCents` / `amountCents` / `adjustments`(JSON) 一起落库。
  只存 `planCode` 的话，规则后台一改，就拿今天的价解释上个月的订单。
  支付时不再重算价格；同一套餐有 `pending` 订单时**复用**它，避免连点生成一堆待支付订单。
- **定价引擎是纯函数**（`membership.pricing.ts`）：折扣一律按**原价**算再相加（不做折上折，
  否则规则顺序不同会算出不同价）；`stackable=false` 的规则同单只取 `priority` 最高的一条；
  可叠加的全部生效；兜底 `MIN_PAYABLE_CENTS`（1 元）。实付金额永远是整数**分**。
- **`MEMBERSHIP_MOCK_PAY`（默认 true）**：为 true 时 `POST /orders/:orderNo/pay` 直接按
  `outcome` 成功或失败，用来跑通家长端充值流程；接真实渠道前必须关掉，关掉后该接口返回 503。
- 套餐与规则由**后台管理**（见下面「管理后台」的 `/api/admin/membership/*`），
  `membershipService.ensureDefaults()` 在 bootstrap 与 `db:seed` 时幂等补齐默认 6 个套餐 + 7 条定价规则 + 2 条受邀用户定价规则。

#### 受邀用户定价：会员价格 × 是否被邀请注册

被邀请注册的家长**价格更高**：邀请人拿到的分享返现（首充最高 50%）是平台出的，这笔成本
必须落在被邀请家长的订单上，否则每拉一个新用户平台就净亏一笔返现。规则表
`MembershipReferralPriceRule` 由后台 `/api/admin/membership/referral-rules` 维护，
默认两条：**首单上浮 100%**（priority 20）、**续费上浮 25%**（priority 10）。返现按**实付价**算，
所以「上浮 s、返现率 r」要满足 `(1+s)(1−r) ≥ 1`，即 `s ≥ r ÷ (1−r)`：

| 邀请人档位（返现率） | 打平所需上浮 |
| --- | --- |
| 0-3 人 → 50% | **100%** |
| 4-9 人 → 40% | 67% |
| ≥10 人 → 20% | 25% |

首单取最坏的一档（50%）兜底：付两倍、返一半，平台拿回原价。续费**有意只对齐 20% 那一档** ——
真按 100% 默认，受邀用户续费永远是双倍价，产品上没法接受；代价是邀请人还在 50%/40% 档时这笔续费
平台是倒贴的，要彻底不亏得把续费规则调到 67%/100%，或下调活动配置里的「续费返现比例」。
不能自动按档位算：档位看的是**邀请人**的邀请人数，而受邀定价只拿得到「买家是不是受邀注册的」。

公式分两步，**先算常规定价，再在其上取更高的那个价**：

```
常规价  = priceOf(plan, 定价规则, 画像)                      // 原价 − 可叠加折扣，兜底 1 元
受邀价  = max( 每条命中的受邀规则各算一个价 )                 // 基数是常规价**算完的实付价**
结账价  = max(常规价, 受邀价)
```

- **取 `max`**：`percent` 表示「在常规定价实付之上上浮 v%」（`候选价 = round(常规实付 ×
  (100 + v) / 100)`），`amount` 是「加收多少分」，`fixed` 是**一口价**（低于常规定价时
  不生效）。取 max 同时是一条安全边界：后台把规则配错（比例填 0、一口价填得比常规价低）
  只会**不生效**，绝不会出现「被邀请反而更便宜」的套利口子 —— 而返现正是按实付金额算的。
- **基数是常规定价的实付价，不是原价**：加价是在常规优惠**之后**对家长实际要付的钱加价。
  按原价算的话，「加收 30 元」会被常规折扣吃掉一部分，后台写着 30 元、实际只多收 20 元。
- **不是「按优先级挑一条」，而是所有命中规则各算一次再取最高价**：后台临时加一条更高的
  规则就一定生效，不用去猜现有规则的优先级。`priority` 只在同价时决定展示哪一条。
- 三个条件字段：`targetTier` / `targetPeriod`（`all` 表示不限）、`firstPurchaseOnly`
  （默认 true，首单限定）、`requireActiveReferral`（默认 true，邀请关系被判 `invalid`
  的自买自返账号不再加价）。没生效时不静默按原价，理由（`reason`）在**后台试算**里能看到，
  但不下发家长端（见下一条）。
- 是否受邀是**账号级**属性：`buildReferralPricingContext(userId)` 查 `User.referredById`
  与 `Referral` 那一行；`Referral` 不存在按「有效」处理（老账号没有这行，不该因为升级而被加价）。
- **订单存快照**：`MembershipOrder.referralRuleId` / `referralRuleName` /
  `referralSurchargeCents` 三列，规则后台改价或删除都不影响历史订单的解释。
- **加价不进 `adjustments`**：那是一份「逐条相加 == 常规优惠」的清单，把正数混进去这条
  恒等式就假了。内部关系是 `finalCents === 常规实付 + surchargeCents`。
- **对家长端完全隐蔽**（`membership.service.ts` 的 `quoteOf` / `toOrderView`）：接口不下发
  `referral`（规则名、上浮额、命中条数一个都没有）；受邀价生效时连**优惠明细和原价一起压平**
  （`originalCents = finalCents`、`adjustments = []`、`discountCents = 0`）—— 那份明细是按
  加价**之前**的常规定价算的，摆出来就是一份自相矛盾的账单（`15 − 3.75 ≠ 22.5`），等于把
  上浮写在脸上。价格本身照旧是加价后的，家长只看到一个干净的数字。完整快照仍在
  `MembershipOrder` 的三列里，后台订单页照常展示；规则名、理由与试算一律只在
  `/api/admin/*` 返回。

### 分享提成（邀请返现）

家长用自己的**邀请码 / 邀请链接**拉新：好友注册充值后，邀请人拿返现，次月结算、可提现。
规则表与配置都在后台可改（`/api/admin/referral/rules`、`/config`），代码里的默认值在
[`src/features/referral/referral.constants.ts`](src/features/referral/referral.constants.ts)。

- **邀请码自动生成**：8 位，字符集 `23456789ABCDEFGHJKMNPQRSTUVWXYZ` ——
  去掉了 `0/O/1/I/L`，因为邀请码是要念给朋友听或手抄的。建号时（`register` / `smsLogin`）
  就会补上一个，另有 `backfillInviteCodes()` 给老账号补发。
- **邀请码在「建号之前」校验**（`resolveInviteCode`）：坏码直接 400，**不会先建出账号再报错**，
  否则家长会以为注册成功、其实拿到一个没有邀请关系的孤儿账号。
- **活动暂停时不拒绝注册，只是忽略邀请码**。一条过期的分享链接不该把好友的注册一起挡掉 ——
  少一笔返现，远比少一个注册便宜。
- **奖励阶梯按「有效充值人数」选档**：0-3 人 50% / 4-9 人 40% / ≥10 人 20%。
  截图原文写的是「邀请人数 = 3 名：返现 50%」，实现成 **0-3 人**：照字面只认「正好 3 人」会留个洞，
  只邀请 1 位好友的家长在好友充值时拿不到任何返现，而大标题写着「最高可获 50%」。
  后台保存时会校验「必须有一档从 0 人开始」且「区间不能重叠」—— 重叠时同一单命中两档，
  给多少钱就取决于遍历顺序了。
- **首充与续费两套口径**（`referral.rules.ts`，纯函数，后台试算与真实返现共用）：
  首充按阶梯比例，**月卡/季卡再保底到 `shortPeriodMinRatePercent`（50%）**，
  年卡套 `longPeriodCapCents`（75 元）上限；续费把阶梯值**夹在**
  `[renewalRatePercent, 50]` 再套 `renewalCapCents`。金额一律 `Math.floor`，
  库里存的永远是整数**分**。
- **计费基数是订单实付**（`amountCents`，含优惠券抵扣后的金额），不是套餐原价。
- **幂等靠 `(userId, sourceRef)` 唯一约束**：`sourceRef` 形如 `${ruleId}#${round}`，
  而规则 id 是全平台共用的 —— 早先它单独 `@unique`，导致「满 3 人发 5 元券」这个里程碑
  **全平台只发得出第一张券**。唯一性必须带上 `userId`。
- **返现先落 `pending`，次月 10-15 日结算**（`settleMonth` + `settleForUser` 惰性收敛，
  和会员过期一样不依赖定时任务）；配置里的 `settleDayStart` 被当作「次月的第几天」。
- **提现四道门槛**（`checkWithdrawEligibility`，纯函数）：有效邀请人数、实名认证、
  **已结算**金额 ≥ `withdrawMinCents`、可提现余额 > 0。`availableCents = 已结算 − 已提现 − 审核中`，
  申请后余额立刻被冻结（同一笔钱不能提两次）。申请时把实名信息**快照**进提现单 ——
  家长后来改了实名，审批人要看到当时提交的是谁。
- **实名只存哈希**：`idCardHash = HMAC-SHA256(JWT_SECRET, 'id-card:' + 号码)` + 后四位明文。
  GB 11643 校验位、出生日期真实性、1900 年至今都会校验；同一证件已被别的账号占用 → **409**
  （`idCardHash` 上有唯一索引）。
- **提现状态机单向**：`pending → approved → paid`，或 `pending → rejected`。
  未审核直接标记打款、已打款再驳回，都是 400。
- **返现写在支付事务之外**：钱已经到账，返现逻辑抛错只能记日志 ——
  绝不能因为发券失败把会员订单回滚掉。反向操作（退款/取消）走 `onOrderReversed`。
- **风控只列不罚**（`GET /admin/referral/risk`）：自我邀请、双方共用同一实名证件、
  1 小时内绑定 ≥5 人、提现审核超 3 天未处理。自动处罚误伤正常家长的代价更大。

### AI 分析设计

- **可插拔 provider**：任何兼容 OpenAI `/v1/chat/completions` 的视觉模型都能用
  （`AI_BASE_URL` + `AI_API_KEY` + `AI_VISION_MODEL`）。
- **没有 key 就不编造结论**。`AI_ENABLED=false` 或 `AI_API_KEY` 为空时，批次状态为
  `skipped`、`provider` 为 `disabled`，家长端明确显示「未配置 AI」。
- **启发式降级**（`AI_HEURISTIC_FALLBACK=true`）会给出 `provider: 'heuristic'` 的结果，
  只依据包名与时间推断，界面**必须标明它不是 AI**。它判断不了「结算画面是否出现」
  「这一集是否看完」，所以用量统计在启发式模式下不计入。
- 模型输出经 zod 校验（`insightOutputSchema`），畸形 JSON 走宽松解析后再校验，失败即降级。
- 帧图片按 `AI_MAX_FRAMES_PER_BATCH` 抽取后再发给模型，不会把整包 10 张原样发过去。

---

## 设备端 Agent 协议

设备端需实现以下接口（全部要求 `Authorization: Bearer <deviceToken>`，`/register` 除外）。

**可运行的参考实现**见 `scripts/device-agent-example.mjs`：

```bash
npm run agent:example        # 注册一台模拟设备并打印绑定码
```

它是一个完整的模拟客户端：长轮询领指令、按类型"执行"、上传示例媒体、心跳上报电量、
拉取管控策略。在家长端输入它打印的绑定码完成认领后，点首页的锁屏/拍照就能看到
指令被领取、执行、回报的全过程。把它换成调用 Android `DevicePolicyManager` /
`Camera2` / `MediaProjection` 的真实实现，就是一个可用的客户端。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/agent/register` | 自助注册/续订令牌。body: `deviceCode, deviceSecret, model, os, osVersion, agentVersion` |
| POST | `/api/agent/heartbeat` | 上报 `battery`、`network`、`agentVersion`；返回是否已绑定、当前锁定态 |
| GET | `/api/agent/config` | 拉取管控策略：锁屏、功能开关、每日时长与剩余、应用限额、网址黑名单、答题配置，以及安全区（只含启用的）、`hideIcon`、`installApprovalUntil` |
| GET | `/api/agent/commands/next?wait=25` | 长轮询领取指令（`wait` 秒内无指令则返回 `command: null`） |
| POST | `/api/agent/commands/:commandId/result` | 回报 `status`(`succeeded`/`failed`)、`result`、`error` |
| POST | `/api/agent/locations` | 上报位置（同设备 30 秒内重复上报自动折叠为一条） |
| POST | `/api/agent/media` | 上传媒体（`multipart/form-data`：`file`、`kind`、可选 `commandId`） |
| GET | `/api/agent/quiz/question` | 取题（需该设备已开启答题解锁） |
| POST | `/api/agent/quiz/answer` | 交卷；答对后自动延长可用时长（锁屏状态会顺带解锁） |
| POST | `/api/agent/screen-batches` | 上传一包截屏（`multipart/form-data` 的 `file` 字段是 zip：`frames/*.jpg` + `manifest.json`）。服务端解包、按配额清理旧帧、落库并**同步**跑 AI 分析，返回 `{ batch, insight, alerts, budget }` |
| GET | `/api/agent/screen-quiz/next` | 取一道基于当前屏幕内容的题（没配置 AI 时返回 `question: null`，设备端回退题库） |
| POST | `/api/agent/screen-quiz/answer` | 交卷；答对即解锁并重置锁定倒计时 |
| POST | `/api/agent/apps` | 上报已安装应用清单（整表替换）。body: `{ apps: [{ packageName, appName, isSystem, isLaunchable, icon? }] }`；`icon` 是**图标 PNG 的 base64**（不带 `data:` 前缀，解出来 ≤ 16KB，孩子端建议压到 12KB / 48×48）。返回 `{ success, count, icons }`，`icons` 是这次上报之后有图标的应用数（含沿用的旧图），供设备端对账。**不带 `icon` 不等于删除图标**（见「应用图标」） |
| POST | `/api/agent/audit-requests` | 设备请求安装审核。body: `{ appName, packageName }`；同设备同包名已有 `pending` 时**幂等**返回同一条（`200`），新建返回 `201`；响应 `{ id, status }` |
| GET | `/api/agent/audit-requests/:id` | 轮询某条申请的状态，返回 `{ status }`（`pending`/`approved`/`rejected`） |

| POST | `/api/agent/time-requests` | 孩子端提交「申请加时 / 申请延后锁屏」。body: `{ kind: 'extend_time'\|'delay_lock', minutes, reason? }`（`5 ≤ minutes ≤ 240`，越界 `422`）；同设备同类型已有 `pending` 时**幂等**返回同一条（`200`，且**内容没变不刷新 `createdAt`**：否则孩子反复点「申请」会把「已经等了多久」一次次清零），新建返回 `201`；响应 `{ id, status, minutes, created }` |
| GET | `/api/agent/time-requests/:id` | 孩子端轮询结果，返回 `{ status, minutes, note }` —— `minutes` 是 `grantedMinutes ?? minutes`（批准后是**家长实际给的**），`note` 是家长的批注 |
| GET | `/api/agent/child-home` | 孩子端主页的「谁在守护」：`{ bound, deviceName, parentName, parentPhone }`。未认领时 `bound:false`、后两者为 `null`。主页其余内容（今天还剩多少、现在能不能用）都是**设备端自己算的** —— 这里只给孩子一个能拨出去的号码 |
| POST | `/api/agent/sos` | 孩子的求助。body `{ message? }`（≤200 字，越界 `422`）。写一条 `sos` 设备动态 + 发一条 `child_sos`（**danger** 级）通知，标题模板 `'{{v0}} 发起了求助'`；幂等键 `child_sos:<设备>:<分钟>` —— **一分钟内连点不会重复打扰家长，但每次点击都留一条动态**。返回 `{ success, parentName, parentPhone }`；设备**未被认领**时返回 `{ success:false, reason:'unbound' }` 且**一个字都不写**（没有收件人的通知不该存在） |
| POST | `/api/agent/app-usage` | 上报当日各应用已用时长。body: `{ usage: [{ packageName, appName, seconds }] }`，**整表替换当日数据**（未上报的已设限应用归零；只写已存在的限额行） |
| POST | `/api/agent/calls` | 批量上报通话记录，body `{ calls: [...] }`，整表替换最近 500 条 |
| POST | `/api/agent/sms` | 批量上报短信，body `{ messages: [...] }`（也接受 `sms` 作为包装字段），整表替换最近 500 条 |

### 指令类型

| type | payload | 需要开启的功能 |
| --- | --- | --- |
| `lock` / `unlock` | — | `lockScreen` |
| `temp_unlock` | `{ minutes, until }` | `tempUnlock` |
| `cancel_temp_unlock` | — | `tempUnlock` |
| `remote_photo` | — | `remotePhoto` |
| `screenshot` | — | `screenMonitor` |
| `start_recording` / `stop_recording` | `{ recordingId }` | `videoRecord` |
| `start_audio` / `stop_audio` | `{ recordingId }` | `remoteRecord` |
| `fetch_location` | — | — |
| `sync_config` | — | — |
| `sync_apps` | — | — |
| `start_ambient` / `stop_ambient` | — | `audioRecord`（`stop_ambient` 不做开关校验，随时可停） |
| `remote_action` | `{ action: 'back'\|'home'\|'recents'\|'notifications'\|'open_app', packageName? }` | `remoteHelp`（`open_app` 必须带 `packageName`） |
| `sync_calls_sms` | — | `callSms` |
| `self_check` | — | —（自愈巡检 + 回传健康快照） |

> `/api/agent/config` 额外返回 `screenMonitor` 块：是否开启截屏、间隔、每包帧数、
> 分析模式，以及 `usageBudget`（游戏局数 / 动画集数上限）。设备端据此**本地**执行，
> 超限时不等指令直接锁定。

> 未开启对应功能就下发采集类指令，服务端返回 400 —— 避免「家长以为在录，其实没录」。

### 上报媒体后回填结果

设备执行完 `remote_photo` 后，应上传媒体并把 `mediaId` 写回指令结果，
这样家长端在指令历史里能直接关联到照片：

```
POST /api/agent/media  (file + kind=photo + commandId=<指令id>)
  → { media: { id, url, ... } }
POST /api/agent/commands/<指令id>/result
  → { status: "succeeded", result: { mediaId: "<上一步的 id>" } }
```

---

## 测试

```bash
npm run smoke            # 端到端冒烟测试：167 项断言
npm run typecheck        # tsc --noEmit
npm run lint             # ESLint
npm run build            # 编译到 dist/
npm run clean:test-data  # 清理冒烟测试留下的临时账号/设备（先预演，加 --apply 才删）
```

屏幕洞察与 AI 分析另有两条脚本（在仓库根目录跑）：

```bash
npm run server:e2e:insights   # 设备端上传 → 入库 → 家长端可见 → 预算/答题/清理，28 项
npm run server:mock:ai        # 起一个假的 OpenAI 兼容视觉服务（默认 :4100）
MOCK_AI_SCENARIO=game npm run server:e2e:ai   # 对着假服务跑 AI 全链路，28 项
```

会员、分享提成与设备健康同样各有一条（**都打真实数据库、真实 HTTP，自己注册并清理临时家长/设备**）：

```bash
npm run server:e2e:membership  # 动态定价 → 订单快照 → 三种周期 → 续费/升级 → 门禁 403 → 受邀用户定价，180 项
npm run server:e2e:referral    # 邀请码 → 首充阶梯 → 续费 → 券 → 结算 → 提现审核 → 风控，159 项
npm run server:e2e:time-requests # 孩子申请加时/延后 → 家长批准 → 真的下发 temp_unlock，73 项
npm run server:e2e:wechat    # 微信模板消息：配置门禁 → 入队 → 懒投递 → 令牌失效重取 → 重试上限，52 项（自带假上游）
npm run server:e2e:health      # 健康快照 → 缺口透传 → 未知不猜 → 在线分级 → 失联动态去重 → self_check 全链路 → 分机型修复步骤，91 项
npm run server:e2e:device-members # 家庭成员与角色：邀请 / 升管理员 / 移除 / 上限 / 只读成员每个写入口 403，67 项
npm run server:e2e:children    # 孩子档案与今日任务：档案 CRUD / 年龄现算 / 设备整组替换 / 任务勾选，74 项
npm run server:e2e:privacy     # 合规留痕：同意版本与重签 / 撤回即停监控并删设备记录 / 注销冷静期与真删 / 导出，76 项
npm run server:e2e:payments    # 支付管线：下单 → 回调验签与幂等 → 退款（自助/后台）→ 主动查单 → 开票 → 后台统计，92 项（自带假渠道后端）
npm run server:e2e:flags       # 运行时灰度开关：代码默认值 / 稳定哈希放量 / 白名单 / 接进支付与退款路径 / reset / 留痕，45 项
npm run server:e2e:alerts      # 后台告警大盘：五条规则 / 分母为 0 是 null / 三值一致 / 改阈值只影响触发 / 确认不放行，65 项
npm run server:e2e:tickets     # 客服工单：提交 → 越权 404 → 分派与回复 → 关闭后不可回 → 入口开关，69 项
```

`server:e2e:health` 里三组「在线分级」断言要直接改库里的 `lastActiveAt` 来构造时间边界，
所以它动态 import `@prisma/client`；拿不到数据库时这几条会**明确标注跳过**，不伪装成通过
（其余 80 项只走 HTTP，照常跑）。

`server:e2e:referral` 会在**开头和结尾**都把活动配置与奖励阶梯写回平台默认值 ——
脚本中途抛错时 `finally` 仍会复位，否则一次中断留下的「活动已暂停 + 首档 45%」
会让下一轮从头到尾报假故障。

`AI_BASE_URL=http://localhost:4100/v1 AI_API_KEY=mock AI_VISION_MODEL=mock-vision` 指向假服务，
用 `MOCK_AI_SCENARIO` 切换「游戏结算 / 动画 / 可疑聊天 / 情绪」等场景，用来验证
结构化输出、异常提取、局数集数统计与屏幕出题，**不需要真的 AI key**。

`smoke-test.mjs` 覆盖范围：

1. 认证（错误密码必须被拒、畸形 JSON 返回 400 而非 500）
2. 未鉴权访问一律 401（10 个接口逐一验证）
3. 多用户数据隔离（B 用户无法读/写/删 A 的设备）
4. 设备状态与功能配置（含未知 feature 白名单拦截）
5. 答题解锁（配置、取题、统计、记录）
6. 位置与安全区（含 haversine 安全区命中判定）
7. 设备绑定全流程（自助注册、幂等、错误密钥、他人抢占）
8. **指令队列完整闭环**（心跳 → 策略下发 → 下发锁屏 → 设备领取 → 回报 → 状态落地 →
   失败回滚 → 临时解锁/取消 → 未开功能拒绝下发 → 令牌类型隔离）
9. 清理（解绑后设备令牌立即失效）
10. **管理后台认证与权限隔离**（家长/设备/管理员三种令牌互不通用、运营 vs 超级管理员）
11. **后台看板与 7 个列表接口**的分页结构
12. **后台处置家长账号**（禁用后令牌立即失效、无法登录；启用后恢复）
13. **题库增删改与保护规则**（答案越界被拒、有作答记录的题目拒绝删除）
14. **管理员账号的自我保护**（不能禁用/删除自己、不能删最后一个超管、改密后旧密码失效）
15. **操作审计**（记录登录/失败尝试/处置动作与来源 IP，且密码已脱敏）
16. 验证码清理（幂等）
17. 管理员修改自己的密码（原密码错误被拒，改后新密码可登录）

前端侧的浏览器端到端测试在仓库根目录：`npm run e2e`（家长端 + 管理后台，共 55 项）。

测试会写入随机账号与临时设备，并把每日时长改回 120 分钟。清理方式：

```bash
npm run clean:test-data -- --apply   # 删掉测试产生的账号与设备
npm run seed                         # 重新灌入干净的演示数据
```

---

## 数据模型增量（迁移 `agent_gaps`）

| 位置 | 变更 | 用途 |
| --- | --- | --- |
| `ChildDevice.hideIcon` | `Boolean @default(true)` | §9 隐藏桌面图标；`/api/agent/config` 下发，家长用 `PUT /api/devices/:deviceId` 读写（`GET /api/device` 也返回）。默认**隐藏**（迁移 `20261013214520_hide_icon_default_true` 改默认值并回填存量行）：桌面图标可被长按卸载，家长用「隐藏图标」卡片改回 `false` 才重新显示。图标隐藏后本机入口是拨号暗码 `*#*#2887#*#*` |
| `ChildDevice.installApprovalUntil` | `DateTime?` | §3 应用审核：家长批准时置为 `now + 30 分钟`，`/api/agent/config` 下发（已过期即回 `null`，以服务端时钟为准） |
| `AppLimit.usedTodaySeconds` / `usageDay` | `Int @default(0)` / `String @default("")` | §4 当日已用秒数；只存与展示，**不参与服务端判定**（判定在设备本地） |
| `SafeZone.enabled` | `Boolean @default(true)` | §2 安全区启用开关；`/api/agent/config` 只下发启用的（原契约假定已有此列，实际缺失，本次补齐） |
| `CallLogEntry` | 新表 | §8 通话记录（`type`: `incoming`/`outgoing`/`missed`） |
| `SmsMessage` | 新表 | §8 短信记录（`type`: `inbox`/`sent`） |

> 两张新表都带 `(deviceId, occurredAt)` 索引与级联删除；删除设备即连带清掉其通话与短信。

---

## 环境变量

见 `.env.example`，全部经 zod 校验。要点：

| 变量 | 说明 |
| --- | --- |
| `DATABASE_URL` | PostgreSQL 连接串（docker 映射到 **5433**，避免与本机其它 PG 冲突） |
| `JWT_SECRET` | **至少 32 位**，否则启动报错；也用于验证码 HMAC 与媒体签名 |
| `CORS_ORIGIN` | 逗号分隔的来源白名单 |
| `SMS_*` / `TENCENTCLOUD_*` | 腾讯云短信。缺任意一项即视为未配置 |
| `WECHAT_LOGIN_APP_ID/SECRET` | 微信网页授权。缺则进入 mock 扫码模式 |
| `ADMIN_TOKEN_TTL` | 管理后台会话有效期（默认 `12h`，比家长端短以缩小泄露窗口） |
| `ADMIN_LOGIN_RATE_LIMIT_MAX` | 后台登录**失败**尝试的每分钟上限（默认 10，成功不计入） |
| `COMMAND_TTL_SECONDS` | 指令未被执行自动过期的时长（默认 300s） |
| `MEDIA_URL_TTL_SECONDS` | 媒体签名 URL 有效期（默认 600s） |
| `AI_ENABLED` / `AI_BASE_URL` / `AI_API_KEY` | 视觉模型服务。**缺 key 即视为未配置**，批次标 `skipped`，绝不伪造结果 |
| `AI_VISION_MODEL` / `AI_TEXT_MODEL` | 视觉与文本模型名（出题用文本模型） |
| `AI_TIMEOUT_MS` / `AI_MAX_FRAMES_PER_BATCH` | 单次请求超时（默认 90s）与每次送模型的帧数上限（默认 6） |
| `AI_HEURISTIC_FALLBACK` | 无 AI 时是否用启发式兜底（默认 `true`，结果标注为非 AI） |
| `SCREEN_BATCH_MAX_SIZE_MB` / `SCREEN_BATCH_MAX_FRAMES` | 单包大小上限（默认 8 MB）与帧数上限（默认 30），超出即拒收 |

---

## 孩子的申请（加时 / 延后锁屏）

孩子被锁住时，除了「等」什么也做不了 —— 那正是亲子冲突的来源，所以后端给它开了一个正式出口。

**为什么不复用 `AppAuditRequest`**：那张表的幂等键是 `packageName`、语义是「能不能装这个包」、
落地动作是装应用放行；加时申请的幂等键是 `(设备, 类型)`、落地动作是 `temp_unlock`。
硬塞一张表要靠一堆可空字段区分两种语义，家长端两个列表还会互相污染。
所以另建 `TimeRequest`（`prisma/schema.prisma`），但复用它的**约定**：请假条式留痕、批准不删记录。

三条刻意的取舍（都有 e2e 断言）：

1. **批准 = 真的下发指令**。`reviewTimeRequest()` 批准时调 `tempUnlock(..., { accumulate: true })`，
   由指令队列把 `temp_unlock` 送到设备，设备回报成功后状态才落地。服务端**绝不**自己把
   `locked` 改成 false —— 那样孩子会看到「家长已同意」但屏幕仍锁着，比不做这个功能更伤信任。
   `accumulate` 的语义是「在已有到期时间上叠加」而不是覆盖（家长连批两次不该把第二次吃掉）。
2. **家长只能改小，不能改大**。`granted = Math.min(input.minutes ?? request.minutes, request.minutes)`。
   孩子申请 120 分钟、家长给 30 分钟是常态；反过来只可能是误触或改包。
   实际给了多少存进 `grantedMinutes`，与申请值分开留痕。
3. **反复申请收敛成一条**。按 `(deviceId, kind, status = pending)` 幂等；内容没变时
   **不刷新 `createdAt`**，否则孩子每点一次「申请」，「已经等了多久」就重置一次，
   家长的待办列表也跟着乱跳。改了时长/理由才更新，并同样不新增通知行
   （通知的 `dedupeKey` 是 `child_request:<id>`）。

隔离照既有约定走 `shared/deviceScope.ts`：不是自己的设备 → `403`；自己的设备但申请不属于它 → `404`
（不泄漏别处是否存在这个 id）；自己的设备确实没有申请 → `200` + 空列表。

---

## 家庭成员与角色（规划 §5.1）

一台设备可以由**多个家长账号**共同看护。设备的主人仍然是 `ChildDevice.userId`（唯一、不可转让），
被邀请进来的家长落在 `DeviceMember` 表：

| 字段 | 说明 |
| --- | --- |
| `deviceId` / `userId` | `@@unique([deviceId, userId])` —— 同一台设备同一个人只有一行 |
| `role` | `admin`（能改设置、能下指令）或 `viewer`（只能看） |
| `nickname` | 家长自己填的备注（显示时非空优先于账号昵称） |
| `invitedBy` | 邀请人，只用于追溯 |

**角色只有两档**，不做细粒度权限矩阵：真正的分歧是「谁有权改设置」，而矩阵必然会在某个新加的
写接口上漏一格 —— 漏掉的那一格就是越权。**主人不写进 `DeviceMember`**：主人的身份由
`ChildDevice.userId` 表达，再写一行「主人成员」就会有「这一行被删掉算不算解绑」这种自相矛盾的状态。

读写分档由 `shared/deviceScope.ts` 强制，**每个接口自己声明它要哪一档**：

- 读（设备列表 / 详情 / 媒体 / 洞察）：`resolveDevice`、`requireDeviceAccess`
- 写（改设置、下指令、审批、加减规则）：`resolveWritableDevice`、`requireWritableDevice`
  —— `viewer` 得到 `403 你是这台设备的只读成员，不能修改设置`
- 主人专属：`requireOwnerDevice` —— 只给**解绑设备**与**增删改家庭成员**用
  （`403 只有设备的主人可以执行这个操作`）

接口（`server/src/features/devices/devices.routes.ts`，前缀 `/api/devices`）：

| 方法 | 路径 | 谁能做 |
| --- | --- | --- |
| `GET` | `/:deviceId/members` | 主人与成员（无关家长 403） |
| `POST` | `/:deviceId/members` | 只有主人（`{ phone, role?, nickname? }`） |
| `PATCH` | `/:deviceId/members/:memberId` | 只有主人（`{ role?, nickname? }`，至少改一项） |
| `DELETE` | `/:deviceId/members/:memberId` | 只有主人 |

`GET /api/devices` 与设备详情会带上 `role` / `canWrite` / `canManageMembers`，家长端据此决定
「解绑」「家庭成员」按钮给不给 —— **但这只是界面便利，服务端每个写接口都会重新判一次**。

几条边界：上限 `DEVICE_MEMBER_LIMIT = 5`（**主人不占名额**），第 6 个人 → `409`；手机号一律
**打码**（`138****8000`）—— 共同看护的家长不该因为一次邀请就拿到对方完整号码；邀请只认
**已经注册的手机号**（查不到 → `404`），不做「邀请未注册用户」：那需要真实短信通道与待接受状态机，
现在做只会做出一个发不出去的假入口。邀请成功给对方写一条 `device_shared` 站内通知（模板 + 参数，
见上文「站内通知」）。`DeviceMember` 对 user / device 都是 `onDelete: Cascade`，所以设备没了成员行也没了。

**验证**：`npm run server:e2e:device-members`（67 项，真实库真实角色）。**没有设备端部分** ——
这是纯服务端 + 家长端能力，孩子的设备不受影响（`child-home` 仍然返回主人的名字与电话）。

## 孩子档案与今日任务（规划 §5.2）

在 §5.2 之前系统里只有「设备」，没有「孩子」：双胞胎的两台手机在库里毫无关联，年龄也只在
家长的脑子里。现在 `Child`（姓名 / 出生年份 / 学校 / 头像）是**家长账号级**实体，
`ChildTask` 挂在孩子身上，`ChildDevice.childId` 表示「这台设备现在算在哪个孩子名下」。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET / POST | `/api/children` | 自己的档案列表（含现算的 `age` 与今日任务 `todayTasks{total,done}`）/ 新建 |
| PATCH / DELETE | `/api/children/:childId` | 改名 / 出生年份 / 学校；删档案（**设备只是解绑**） |
| PUT | `/api/children/:childId/devices` | 设备归属**整组替换**（最多 10 台） |
| GET / POST | `/api/children/:childId/tasks` | `?date=YYYY-MM-DD`（默认今天）/ 布置任务 |
| PATCH / DELETE | `/api/children/:childId/tasks/:taskId` | 改内容 / 勾完成 / 取消完成 / 删 |
| POST | `/api/agent/tasks/:taskId` | **孩子端**回报完成（`{ done: boolean }`，设备令牌） |

几个刻意的决定：

1. **存出生年份、不存年龄**：年龄每次现算（`今年 - 出生年份`）。存下来的年龄每年都会悄悄
   过期一次，而「孩子几岁」直接影响家长看到的每一句文案。
2. **日期是 `YYYY-MM-DD` 字符串**，不是时间戳 —— 任务清单不该因为跨时区而整体挪一天。
3. **`PUT .../devices` 是整组替换**：勾选框就是最终状态。做成增删两个接口就会出现「加了新
   设备但旧设备没摘掉」这种半截状态；一台设备只能属于一个孩子，换孩子时自动从原档案移走
   （同一事务，失败整体回滚）。
4. **删档案不删设备**（`onDelete: SetNull`）：整理档案最怕顺手把孩子的手机一起删了。
5. **档案只有档案主人看得见**：§5.1 的家庭成员（哪怕是 `admin`）读别人家孩子的档案一律
   `404`（不是 `403` —— 不泄漏「这个 id 存不存在」），成员对设备的写权限完全不受影响。
6. **上限**：`CHILD_LIMIT = 5` 份档案、`CHILD_DEVICE_LIMIT = 10` 台设备、`CHILD_TASK_LIMIT = 20`
   条任务/天，超了一律 `409`（不是静默截断）。

`GET /api/agent/child-home` 现在多返回两段：`childName`（设备挂着的孩子，没挂就是 `null`）
与 `tasks`（今天的任务清单）。孩子端勾掉一条 → `POST /api/agent/tasks/:taskId` 落 `doneAt`
并给家长写一条 `child_task` 站内通知（标题模板 `'{{v0}} 完成了「{{v1}}」'`，`linkPath` 是
`/children`）；`dedupeKey` 用 `child_task:<taskId>`，所以**同一条任务重复勾选只会通知一次**，
而家长自己代勾不会打扰自己。

**验证**：`npm run server:e2e:children`（74 项，真实库：越权 / 事务 / 通知 / child-home 全链路）
+ `npm run server:e2e:notifications`（69 项 —— 通知类型从 9 类长到 10 类）。

## 网址拦截的规则形状（规划 §4.1）

家长端能填三种东西，服务端统一用 `normalizeBlockedEntry()`（`devices.service.ts`）归一化：

- **域名 / 网址**：`https://Gambling.com/lobby?x=1` → `gambling.com`（去协议、userinfo、路径、
  查询、端口、`*.` 前缀、首尾点、大小写）。
- **IPv4 字面量**：`1.2.3.4` 原样保存。
- **网段**：`10.0.0.0/8` 保存为**主机位清零**后的写法（`10.1.2.3/8` 也变成 `10.0.0.0/8`）——
  否则同一网段的两种写法会被设备端当成两条路由。
- **IPv6 字面量**：只支持字面量，不支持 v6 网段。
- 其它输入 → `400 请输入有效的域名或 IP，例如 gambling.com、1.2.3.4`。

为什么允许 IP / 网段：设备端把它们变成**隧道 /32 路由**，于是「应用缓存里的 IP」和
「直接连 IP」这两条绕过路径也走不通（细节见 `android/README.md` §5.13）。服务端的归一化
与设备端 `BlockedAddresses` 必须同一口径 —— 否则家长填得进去、设备端不认。
`server:smoke` 有 5 项钉死这个契约。

## 合规留痕、导出与注销（规划 §5.3）

在这之前应用里**没有任何**「同意」记录：家长端有说明页，但点没点过、同意的是哪一版，库里查不到。
没有同意记录的「同意页」比没有更糟 —— 它看起来像留了痕。现在：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/privacy/docs` | 当前版本的文档目录（两份必读 + 版本号）与最小必要采集清单 |
| GET / POST | `/api/privacy/consents` | 自己的同意状态（含 `needsReaccept`、历史记录）/ 记一条同意 |
| POST | `/api/privacy/consents/:consentId/revoke` | 撤回（要密码 + 手打确认词），**立即停监控并删设备记录** |
| GET | `/api/privacy/deletion` | 注销状态（是否已排期、到期时间、能否撤销） |
| POST / DELETE | `/api/privacy/deletion` | 申请注销（7 天冷静期）/ 撤销注销 |
| GET | `/api/privacy/export` | 一次性导出（账号 / 设备 / 孩子 / 任务 / 同意 / 通知 / 订单…的元数据） |

`ConsentRecord` 存 `docType` + `docVersion` + `acceptedAt` + `revokedAt` + IP + UA。**版本是文本的
指纹**：`PRIVACY_DOC_VERSION` 一改，旧记录仍然留着，但状态变成「需要重新同意」——不是静默续期，
也不是把旧记录删掉假装从未同意过。`docType` 只有 `guardian_agreement`（家长监护授权与隐私说明）
与 `minor_data_notice`（未成年人个人信息处理告知）两份，两份都必读。

**最小必要采集清单是代码里的表**（`COLLECTION_CATALOG`），不是文案：每一项写着它的用途、
保存期限与存放位置，且必须和实现一一对得上（写了「默认 7 天」就得有定时任务真的删文件，
写了「服务端没有这张表」就不能有这张表）。`server:e2e:privacy` 会断言清单里每一项的
`key` 都能在服务端找到对应实现，防止这张表漂成宣传文案。

**注销分两段，不是一次删除**：`POST /deletion` 当场做三件事 —— 停监控、**删除该账号下的设备记录**
（含磁盘上的照片与截屏文件）、把 `User.deletionScheduledAt` 写到 7 天后。到期由
`server.ts` 的 `privacyTimer`（每小时 + 启动时）调 `sweepExpiredDeletions()` 真删：先删文件，
再 `user.delete` 让外键级联清掉孩子档案、任务、订单、同意记录。撤销注销能把账号救回来，
但**设备记录已经删了** —— 撤销后要重新绑定设备才能恢复监控，确认框里写明了这一点。

为什么撤回同意也要删设备记录：设备记录（`DeviceEvent` / `MediaAsset` / `ScreenBatch`）的归属
是按 `deviceId` 归档的，设备行只要还在，下一个绑定它的家庭就可能读到上一个家庭的照片与事件。
这是一条真实的越权路径，所以**停止监控 = 删设备行**，不是把 `userId` 置空。

**已知缺口**（不在本轮修）：管理后台的 `forceUnbindDevice` 仍然只把 `ChildDevice.userId` 置空，
所以一台被运营商强制解绑、随后被另一个家庭重新绑定的设备，仍可能看到上一家的历史数据。
修它需要「按设备清数据 + 重置设备侧设置」的一套动作，属于另一轮的事；已如实记在
`docs/FEATURE-STATUS.md` §4。

**验证**：`npm run server:e2e:privacy`（76 项，真实库真实 HTTP：同意版本与重签、撤回即删设备记录
与磁盘文件、注销冷静期与到期真删、导出内容与截断标记，外加越权与密码校验）。家长端界面
由 `e2e` 的「家长端 5e. 合规与隐私」一段覆盖（只做不破坏种子库的动作：同意、采集清单展开、
注销确认框走到但不提交）。

## 真实支付渠道：下单 / 回调 / 退款 / 发票（规划 §5.4）

在这之前只有一个 `MEMBERSHIP_MOCK_PAY` 开关：点「确认支付」直接把订单改成已支付。
接真实渠道要补的不是一个 SDK 调用，而是**四条管线**：向渠道下单拿预支付信息、
收渠道异步回调并把订单置为已支付、退款、发票。本轮把管线建全，凭据留成配置位。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/payments/catalog` | 家长端支付页需要的「现在能用什么」：渠道是否配好、缺哪个环境变量、退款窗口、发票上限、`notice` 文案 |
| GET | `/api/payments/orders` | 自己的订单（含能否退款 / 发票状态，家长端不按状态猜） |
| GET | `/api/payments/orders/:orderNo` | 单张订单（含 `events` 事件流） |
| POST | `/api/payments/orders/:orderNo/pay` | 向渠道下单，返回 `prepayId` / `codeUrl` / `mode` |
| POST | `/api/payments/orders/:orderNo/sync` | **主动查单对账**：回调丢了也能把钱找回来（`changed` 表示这次是否真的结算） |
| POST | `/api/payments/refunds` | 自助退款（退款窗口内、未申请发票、非 `refunding`） |
| GET | `/api/payments/refunds` | 自己的退款单 |
| POST / GET | `/api/payments/invoices` | 申请开票 / 查自己的发票 |
| POST | `/api/payments/notify/:channel` | **渠道回调**（`express.raw`，签名校验，幂等） |
| GET | `/api/admin/payments/stats` | 后台：订单/收入/退款/坏签名/渠道配置实况 |
| GET | `/api/admin/payments/orders`、`/orders/:orderNo/events` | 后台：订单列表（按手机号搜）与事件流 |
| POST | `/api/admin/payments/refunds` | 后台：人工退款（家长超窗口、或渠道回调丢失时） |
| GET | `/api/admin/payments/refunds`、`/invoices`、`PATCH /invoices/:invoiceId` | 后台：退款单、发票审核（`issued` 必须填发票号） |

**密钥形态要能读**：环境变量里的 PEM 常常被写成一行（`\n` 转义），而支付宝密钥工具导出的
私钥/公钥**只有裸 base64**（没有 `-----BEGIN …-----` 头）。`payments.keys.ts` 的 `keyObject()`
两种形态都接受（私钥试 PKCS#8 再试 PKCS#1，公钥试 SPKI 再试 PKCS#1）。不这么做的话，
`crypto.sign()` 会抛 `DECODER routines::unsupported` —— 渠道目录却仍显示 `configured: true`，
表现就是「家长点支付直接报错」。上线前用 `npm run check:payment-keys` 自检（`npm run deploy`
的前置步骤里也会跑），它真的把密钥读一遍、签一次、验回来。

**渠道侧没签约要在家长端说人话**：支付宝的「应用没签约手机网站支付 / 没拿到接口授权」
不会在签名阶段暴露，网关收下请求后才吐 `insufficient-isv-permissions` 白页或把用户甩到
`appAssign.htm` 授权页。`AlipayProvider.cashierProblem()` 在下单那一刻用收银台 URL
自己探一次，只认已知的错误特征。签约是**按产品分别签**的，所以按「手机网站支付
（`wap.pay`）→ 电脑网站支付（`page.pay`）」两个产品各造一张链接依次探：哪张能进收银台
就用哪张（`page.pay` 是 saas 项目一直在用的那个产品）；两张都进不去才回一句中文 `503`，
并把两个产品各自的真实拒绝原因附在括号里。探测本身超时或网络异常一律放行，绝不因为
探测失败而挡住真实支付。

**第三方应用要带 `app_auth_token`**：如果 appid 建在服务商账号下（网关把你甩到
`appAssign.htm` 就是这种情况），每个 `alipay.trade.*` 请求都必须带商户扫码授权后拿到的
`ALIPAY_APP_AUTH_TOKEN`，否则永远停在授权页 —— 这时签名、密钥、时间戳全对也没用。
自研应用留空即可。

**渠道没配就不装成功**。`payments.constants.ts` 的 `missingEnvOf()` / `isChannelConfigured()` 是唯一的判据（`payments.provider.ts` 里另有 `providerReady` / `providerMissing` / `requireProvider` 做同一件事的服务端封装）：缺凭据时
`createPayment` 返回 `mode: 'mock'`（仅在 `MEMBERSHIP_MOCK_PAY` 打开且非生产时）或
`503` 并**列出缺哪几个环境变量**；`catalog.notice` 同一句话也写给家长端看。测试渠道
（`PAY_CHANNEL_FAKE`，仅测试环境、要求 `PAYMENT_FAKE_PROVIDER=true`）走完整的
下单 / 回调 / 退款管线但不联网：它就是 `server:e2e:payments` 的被测对象。

**回调不是唯一的进账路径**：`POST /api/payments/orders/:orderNo/sync` 主动向渠道查单，
渠道侧已 `SUCCESS` 就走**与回调完全同一条** `applyPaidOrder()` 结算（支付宝的同步回跳、
网络抖动丢掉的异步通知都靠它把订单救回来）。家长端收银台打开后每 3 秒自动对账一次。

**回调是结算的起点**：`POST /api/payments/notify/:channel` 校验签名（微信 APIv3
`WECHATPAY2-SHA256-RSA2048`，验签材料优先用「微信支付公钥」、回退平台证书；支付宝
RSA2 同步/异步通知两种签名串规则都接受）→ 找到订单 → 核对渠道与金额 →
`membership.service.applyPaidOrder()` 置为已支付。签名错、金额不符、订单不存在、渠道没配都会记一条 `PaymentEvent`（`bad_signature`
/ `amount_mismatch` / `unknown_order` / …）并**不改变订单状态**，方便事后对账。同一个
`transactionId` 重复回调是幂等的：不会重复开会员，也不会把 `expiresAt` 再往后推。

**退款要收回权益**。自助退款只在窗口内（`PAYMENT_REFUND_WINDOW_DAYS`，默认 7 天）、
订单未申请发票、状态不是 `refunding` 时受理；退款单号是 `RF<orderNo>`（渠道要求幂等，
重试用同一个号）。会员撤销的前提是**当前生效的这段权益正是这张订单开的**：如果家长先
退款 A 单、又用 B 单续过费，`applyPaidOrder` 会把 `tier` 降回 `free` 并扣回
`totalPaidCents`；如果这单开的会员早就被后一单覆盖，就只退钱不降级 —— 否则会误伤。

**发票是人工开的**：家长提交抬头/税号/邮箱 → `pending`；后台 `PATCH` 成 `issued` 时
**必须**带 `invoiceNo`（zod refine）。`pending` 与 `issued` 都拦住自助退款，文案提示
「先冲红」——发票已开而钱退了是财务上的漏洞。

**验证**：`npm run server:e2e:payments`（92 项，自带 :4102 后端 + 假渠道，不需要
`server:dev`，测完自行删掉订单）。覆盖：目录实况与「未配置」话术、未配置渠道下单 503 与
缺失变量名、假渠道全流程下单 → 坏签名 401 → 金额不符 400 → 渠道不符 400 → 正确回调开通
→ 重复回调幂等、别人的订单一律 404、自助退款与会员收回、超窗口 403 与后台人工退款、
发票 `pending` 挡退款 / `issued` 必须填号、后台统计与事件流。**不测**真实微信/支付宝的网络
调用（本机没有可用凭据）：两个渠道的适配层都是完整实现，但它们能不能真的收到钱取决于
商户平台侧的签约与授权 —— 这一层只能靠 `npm run check:payment-keys -- --network` 和线上
真实支付来验证。

## 后台运营：告警大盘 / 灰度开关 / 客服工单（规划 §5.5）

三件事的共同点是**「运营看得见、也改得动，但改不动事实」**：数字来自真实表，开关只决定放行，
工单只记录沟通。口径写在 [`../docs/PLAN-admin-ops.md`](../docs/PLAN-admin-ops.md)。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/admin/alerts/overview` | 五个指标 + 每条规则的触发状态、样本、确认记录 |
| GET / PATCH | `/api/admin/alerts/rules`、`/rules/:key` | 规则的开关 / 阈值 / 窗口 / 严重度 |
| DELETE | `/api/admin/alerts/rules/:key/reset` | 恢复**代码里的**默认口径 |
| GET / POST / DELETE | `/api/admin/alerts/acks` | 确认记录（谁、何时、当时的快照），撤销 = 删行 |
| GET / PATCH / DELETE | `/api/admin/flags`、`/flags/:key`、`/flags/:key/reset` | 灰度开关 |
| GET | `/api/admin/flags/:key/preview?subjectId=` | 试算某个账号/设备是否命中，并给出理由 |
| GET | `/api/support/config`、`/tickets`、`/tickets/:ticketNo` | 家长端：入口自述、我的工单、详情 |
| POST | `/api/support/tickets`、`/tickets/:ticketNo/replies` | 提交工单 / 追加回复 |
| GET / PATCH | `/api/admin/tickets`、`/tickets/:ticketNo` | 后台：列表（状态/分类/优先级/关键词）与处理 |
| POST | `/api/admin/tickets/:ticketNo/replies` | 客服回复（**回复即认领**，`open → waiting`） |

**告警的纪律是「不把没有数据说成 0%」**。五个规则（设备失联率、管控失效率、指令失败率、
支付异常、通知投递失败）各自带单位、分母口径与窗口（见 `features/opsalert/alerts.constants.ts`）；
率类指标**分母为 0 时 `value` 是 `null`**（界面显示「—」），并且不触发 —— 没有可统计对象不等于
事故。改阈值只影响 `triggered`，不会让指标本身变好看；确认（`AlertAck`）也只记「谁在什么时候
看过、当时是多少」（`snapshot` 由服务端在确认那一刻算，前端传进来的数字不作数），**确认不会让
告警消失**。

**灰度开关的纪律是「缺行 = 代码默认，不是关闭」**。`RuntimeFlag` 里没有这一行时按
`FLAG_DEFS` 的默认值放行（删掉一行不会把功能关死），读操作**不写库**，靠启动时的
`ensureFlagDefaults()` 与后台的「恢复默认」补齐。放量用**稳定散列**
（`sha256(flagKey:subjectId)`）而不是每次抽签，所以同一个账号刷新一百次结果一样；白名单优先于
开关与百分比；需要对象（`bucket: 'user' | 'device'`）却没给出对象时**保守判不命中**并说明原因。
接线点是真实路径而不是装饰：`pay.channel.wechat` / `pay.channel.alipay` 决定支付目录里渠道是否
可用、`pay.refund.selfservice` 一关家长自助退款就 403（后台人工退款不受影响）、
`notify.wechat.dispatch` 挡在微信投递入队前、`support.tickets` 一关入口就 503（历史仍可读）。

**工单的纪律是「家长看不到后台内部信息，后台看得到处理人」**。家长视图只有 `by/at/body`
（没有 `adminId`、没有客服账号名）；跨账号读写一律 404；未关闭工单最多 5 张（第 6 张 409）；
客服回复即认领并把 `open` 推到 `waiting`，家长回话推回 `processing`，关闭后双方都不能再回
（`closedAt` 落库）；后台**没有 DELETE** —— 工单是沟通记录，不是可随手清理的数据。删除账号时
工单**级联删除**（迁移 `20261020010000_ticket_cascade`）：留着正文就等于「删了账号还留着用户内容」。

环境变量只有 `SUPPORT_CONTACT`（家长端工单页显示的联系方式，留空就只显示「在工单里回复你」）。

**验证**：`npm run server:e2e:alerts`（65 项，:4104）、`npm run server:e2e:flags`（45 项，:4103）、
`npm run server:e2e:tickets`（69 项，:4105）各自拉起独立后端（假渠道 / 提高限流），不碰真实渠道、
测完自己清理；浏览器侧由 `npm run e2e` 的后台套件覆盖三页面的渲染与接口一致性。

## 部署注意

- **多实例**：数据都在 PostgreSQL，可水平扩展。但两处是进程内状态，需要替换后才能多实例：
  - 微信扫码会话（`auth.wechat.ts` 的内存 Map，TTL 10 分钟，丢了只会让用户重扫）；
  - 指令长轮询的唤醒通知（`devices.notifier.ts`，多实例下优雅退化为短轮询，不丢指令）。
- **媒体目录**：`MEDIA_DIR` 生产环境要挂到持久化卷，且不要放在部署产物目录里（覆盖发布会连带清掉）。
- **定时任务**：`COMMAND_SWEEP_INTERVAL_MS` 的过期指令清理由进程内 setInterval 承担，
  多实例会重复执行但操作幂等（按状态条件更新）。

---

## 已知边界

以下能力后端已完整建模并给出接口，但**必须在孩子设备上安装 Agent 才能真正生效**：
锁屏、临时解锁、远程拍照/截图/录像/录音、同屏监控、远程协助、通话短信、应用限制与网址拦截的强制执行。
后端负责策略下发、指令排队与结果收敛，不负责（也无法负责）设备本地的执行。

运营侧（§5.4 / §5.5）另有三条是**刻意没做**或**没有环境做**的，同样不要当成能力缺口：

- **真实支付渠道没有可用的实现证据**：微信/支付宝适配层按公开文档写全了签名、下单报文、
  回调验签与退款请求，但仓库里没有商户号与密钥，所以「真实下单/真实退款」从未联网跑过，
  后台与家长端一律如实显示 `未配置`。有端到端证据的只有管线本身（假渠道）。
- **告警不出站**：告警只出现在 `/admin/alerts` 大盘上，不发短信、不发邮件、不推微信
  （微信模板消息是家长通知的通道，不是运维通道）。要看就得打开后台 —— 这是本轮的范围，
  不是遗漏。
- **工单只有文字**：没有附件上传、没有自动回复机器人、没有按技能轮询派单（客服回复即认领）。
  工单正文与回复对家长与客服都是明文，别在工单里放密码或验证码。
