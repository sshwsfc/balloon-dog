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
│  ├─ smoke-test.mjs       # 端到端冒烟测试（158 项断言，无第三方依赖）
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
| POST | `/api/device/remote-photo` | 远程拍照 |
| POST | `/api/device/screenshot` | 屏幕截图 |
| POST | `/api/device/start-recording` `/stop-recording` | 录像 |
| POST | `/api/device/start-audio` `/stop-audio` | 录音 |
| POST | `/api/device/start-ambient` `/stop-ambient` | 环境监听（分片连续录音），需要 `audioRecord`；**`stop-ambient` 不校验开关**，保证随时停得下来 |
| POST | `/api/device/remote-action` | 远程协助。body: `{ action: 'back'\|'home'\|'recents'\|'notifications'\|'open_app', packageName? }`，需要 `remoteHelp`；`action='open_app'` 必须带 `packageName` |
| POST | `/api/device/sync-calls-sms` | 让设备立即上报通话/短信，需要 `callSms`（平时设备每 6 小时自报） |
| GET | `/api/device/commands` | 指令历史（可 `?status=` `?limit=`） |
| POST | `/api/device/commands/:commandId/cancel` | 撤销未执行的指令 |

> 下发类接口返回 `202` + `{ command, device, warning? }`。
> 设备离线时 `warning` 会明确告知「指令将在设备上线后执行」。

### 功能配置 `/api/features`

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/` | 聚合的功能状态（形状与旧前端契约一致） |
| PUT | `/` | `{ feature, enabled }` 切换开关（feature 走白名单） |
| PUT | `/time-plan` | 每日时长上限 |
| PUT | `/app-limit` | 应用时长限制 |
| DELETE | `/app-limit/:appName` | 移除应用限制 |
| POST | `/app-audit` | 审批应用（批准后自动写入 60 分钟限制） |
| POST | `/web-block` | 添加拦截域名（自动归一化为纯域名） |
| DELETE | `/web-block/:url` | 取消拦截 |

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
默认两条：**首单上浮 100%**（priority 20）、**续费上浮 25%**（priority 10）。返现按实付价算，所以「上浮 s、返现率 r」要满足 `(1+s)(1−r) ≥ 1`；首充返现最高 50% → 要上浮 100%（付两倍、返一半、平台拿原价），续费返现兜底 20% → 上浮 25% 正好打平。
50% 不是随手拍的 —— 它正好等于邀请人首充返现的最高档。

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
  的自买自返账号不再加价）。没生效时**不静默按原价**，而是把理由（`reason`）一起下发，
  家长端直接显示为什么贵、后台试算也能看到。
- 是否受邀是**账号级**属性：`buildReferralPricingContext(userId)` 查 `User.referredById`
  与 `Referral` 那一行；`Referral` 不存在按「有效」处理（老账号没有这行，不该因为升级而被加价）。
- **订单存快照**：`MembershipOrder.referralRuleId` / `referralRuleName` /
  `referralSurchargeCents` 三列，规则后台改价或删除都不影响历史订单的解释。
- **加价不进 `adjustments`**：那是一份「逐条相加 == 常规优惠」的清单，把正数混进去这条
  恒等式就假了。所以关系是 `finalCents === 常规实付 + surchargeCents`，家长端把加价单独
  显示一行（灰色，不混在琥珀色的优惠标签里）。

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
npm run smoke            # 端到端冒烟测试：158 项断言
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

会员与分享提成同样各有一条（**都打真实数据库、真实 HTTP，自己注册并清理临时家长**）：

```bash
npm run server:e2e:membership  # 动态定价 → 订单快照 → 三种周期 → 续费/升级 → 门禁 403 → 受邀用户定价，175 项
npm run server:e2e:referral    # 邀请码 → 首充阶梯 → 续费 → 券 → 结算 → 提现审核 → 风控，159 项
```

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
