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
│  ├─ schema.prisma        # 数据模型（14 张表）
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
- **已有孩子作答记录的题目不允许删除**，返回 409 并提示改为「修改题干」，
  避免外键级联把答题历史一并清掉。

### 前端

后台是独立的 Vite 入口（`admin/index.html` + `src/admin/`），
路由 `basename = /admin`，挂载点 `#admin-root`。
这样后台代码不会进家长端的产物包，家长端的改动也不会意外暴露后台页面。

```bash
npm run dev              # 家长端与后台同一个 dev server
# 家长端： http://localhost:5173/
# 管理后台：http://localhost:5173/admin
```

开发态由 Vite 插件把 `/admin/**` 回落到 `admin/index.html`（否则刷新深层路由会 404），
生产部署时需要 nginx 做同样的 try_files 配置。

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

### 答题 `/api/quiz`

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET/PUT | `/config` | 答题配置（`grade` 与 `questionBank` 同义，两个都给） |
| GET | `/question` | 预览题目（**不返回正确答案**） |
| POST | `/answer` | 家长端自测答题 |
| GET | `/records` | 答题记录 |
| GET | `/statistics` | 统计（`byType` 固定含 english/poetry/random） |
| POST | `/questions` | 新增题目 |

### 位置 `/api/locations`、`/api/safe-zones`

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/locations` | 轨迹（可 `?from=&to=&limit=`），每条都会标注命中的安全区 |
| GET | `/api/locations/latest` | 最近一次定位 |
| GET/POST | `/api/safe-zones` | 安全区列表 / 新增 |
| PUT/DELETE | `/api/safe-zones/:safeZoneId` | 修改 / 删除 |

### 媒体 `/api/media`

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/` | 当前设备的媒体列表（返回带签名的 `url`） |
| GET | `/:mediaId` | 读取文件（签名 或 家长令牌） |
| DELETE | `/:mediaId` | 删除（同时删磁盘文件） |

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
| GET | `/api/agent/config` | 拉取管控策略：锁屏、功能开关、每日时长与剩余、应用限额、网址黑名单、答题配置 |
| GET | `/api/agent/commands/next?wait=25` | 长轮询领取指令（`wait` 秒内无指令则返回 `command: null`） |
| POST | `/api/agent/commands/:commandId/result` | 回报 `status`(`succeeded`/`failed`)、`result`、`error` |
| POST | `/api/agent/locations` | 上报位置（同设备 30 秒内重复上报自动折叠为一条） |
| POST | `/api/agent/media` | 上传媒体（`multipart/form-data`：`file`、`kind`、可选 `commandId`） |
| GET | `/api/agent/quiz/question` | 取题（需该设备已开启答题解锁） |
| POST | `/api/agent/quiz/answer` | 交卷；答对后自动延长可用时长（锁屏状态会顺带解锁） |

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
