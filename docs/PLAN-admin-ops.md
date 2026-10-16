# 后台运营能力（规划 §5.5）—— 实现计划

> 本文档是 R4 的 §5.5「后台：告警大盘、灰度开关、客服工单」的契约。三端（server / 家长 web /
> 后台 web）共用同一份契约，改契约时三处一起改。**口径定义在这里，代码与文档都不许各自发明一套。**

---

## 0. 需求拆解与对应实现

| # | 需求 | 实现位置 |
| --- | --- | --- |
| 1 | 告警大盘：设备失联率 / 管控失效率 / 支付异常（+ 指令失败率、通知投递失败率） | `GET /api/admin/alerts/overview` + `/admin/alerts` 第一 Tab |
| 2 | 告警阈值与窗口后台可改 | `AlertRule` 表 + `PATCH /api/admin/alerts/rules/:key` + 第二 Tab |
| 3 | 「这条告警我看过了」——否则大盘永远亮着，等于没有告警 | `AlertAck` 表 + `POST /api/admin/alerts/acks`（可撤销）+ 第一 Tab 的确认按钮 |
| 4 | 灰度开关：把一个能力按账号/设备百分比放量，出问题能一键关掉 | `RuntimeFlag` 表 + `flagEnabled()` 求值器 + `/admin/flags` |
| 5 | 灰度开关**必须真的接在功能上**（假开关是欺骗） | 支付渠道可用性、自助退款、微信模板消息投递、客服工单入口，见 §4 |
| 6 | 客服工单：家长提交、看进度，后台分派、回复、关闭 | `SupportTicket` 表 + `/api/support/*` + `/api/admin/tickets*` + 家长端 `/support` |
| 7 | 每一次后台改动都要留痕 | 复用 `admin.audit.ts`（`/api/admin/*` 全量审计），不新造一套 |

**非目标（本轮不做，界面与文档都要如实写）**：工单附件与图片（家长在正文里描述，或引用
「媒体库」里的记录）；工单模板与自动回复机器人；告警的短信/电话升级链路（通知不出站，
只在后台显示）；按人/按设备的多档灰度（本轮只有一个百分比 + 白名单）。

---

## 1. 数据模型（Prisma）

```
AlertRule     key(唯一) / label / enabled / severity(info|warn|danger) / threshold / windowMinutes / note
              默认五行在迁移里 seed：见 §2 的告警口径表
AlertAck      key + subject(设备 id / 订单号 / 空) 唯一 / adminId / note / snapshot(确认那一刻的指标快照)
              唯一约束保证「同一条告警只有一个确认」，撤销 = 删除
SupportTicket ticketNo(唯一) / userId / deviceId? / contact / category / subject / body
              status(open|processing|waiting|closed) / priority(low|normal|high)
              assigneeId? / replies(JSON 数组) / closedAt?
RuntimeFlag   key(主键) / label / description / enabled / rolloutPercent(0-100) / allowIds(JSON) / updatedBy
              默认四行在迁移里 seed：见 §4
```

`AlertRule` / `RuntimeFlag` 的默认值**写在迁移里**（生产库直接可用），但**代码里同时有一份
`DEFAULT_RULES` / `FLAG_DEFS` 作为契约与兜底**：数据库缺行时按代码默认值求值，后台也能
「恢复默认」。两份必须一致 —— 不一致时以代码为准并把缺行补回去（`ensureDefaults()`）。

---

## 2. 告警口径（唯一权威定义）

| key | 中文名 | 指标口径 | 默认阈值 | 默认严重度 | 窗口 |
| --- | --- | --- | --- | --- | --- |
| `device_offline` | 设备失联率 | `livenessOf()` ∈ {offline, lost} 的**已绑定**设备 ÷ 已绑定设备 | 30（%） | danger | — |
| `control_gap` | 管控失效率 | 有健康快照且（`openGaps > 0` **或** `serviceRunning = false`）的设备 ÷ 有健康快照的已绑定设备 | 30（%） | warn | — |
| `command_failure` | 指令失败率 | `status ∈ {failed, expired}` ÷ 同期 `finishedAt` 非空的指令 | 20（%） | warn | 60 分钟 |
| `payment_anomaly` | 支付异常 | `PaymentEvent.result ≠ 'ok'` 的条数（含坏签名 / 金额不符 / 未知单 / error） | 1（条） | danger | 60 分钟 |
| `notify_failure` | 通知投递失败 | `NotificationDelivery` 中 `attempts >= 3` 且 `lastError ≠ ''` 的条数 | 5（条） | warn | 60 分钟 |

**三条口径纪律**：

1. **分母永远写清楚**：失联率的分母是「已绑定设备」（`userId != null`），未认领的设备不算 ——
   否则设备端自助注册出来的待认领记录会把失联率稀释成永远正常。
2. **率类指标在分母为 0 时返回 `null`，不返回 0**：0% 是「查过了，都正常」，null 是「没有可
   统计的对象」。界面必须区分（显示「—」而不是「0%」）。这条与设备健康页「从未上报 ≠ 一切正常」
   是同一条规矩。
3. **`never`（从未连接）不算失联**：它是「还没开始」，单独一列显示，不并进失联率 ——
   并进去会让「刚绑上还没开机」看起来像事故。

---

## 3. 接口契约

### 3.1 告警（后台，全部 `authenticateAdmin` + 自动审计）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/admin/alerts/overview` | `{ generatedAt, metrics, alerts[] }`；每条告警带 `key/label/severity/enabled/triggered/value/threshold/unit/windowMinutes/samples[]/ack` |
| GET | `/api/admin/alerts/rules` | 规则列表（含代码默认值，便于「恢复默认」） |
| PATCH | `/api/admin/alerts/rules/:key` | `{ enabled?, severity?, threshold?, windowMinutes?, note? }` |
| DELETE | `/api/admin/alerts/rules/:key/reset` | 恢复该 key 的代码默认值 |
| GET | `/api/admin/alerts/acks` | 已确认列表（分页） |
| POST | `/api/admin/alerts/acks` | `{ key, subject?, note? }`，upsert；`snapshot` 由服务端写，前端不许传 |
| DELETE | `/api/admin/alerts/acks/:id` | 撤销确认 |

`samples` 是**触发时才给的证据**（最多 5 条）：失联给设备名 + 最后心跳，管控给设备名 + 缺口中文，
指令给指令类型 + 错误，支付给事件 kind + 结果 + 订单号。没有样本的告警不许只给一个数字。

### 3.2 客服工单

家长端（`authenticate`，全部按 `userId` 限权）：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/support/config` | `{ enabled, categories[], contact }`；`enabled=false` 时家长端不渲染入口 |
| POST | `/api/support/tickets` | `{ category, subject, body, contact?, deviceId? }`；同一家长未关闭的工单上限 **5** 张（409） |
| GET | `/api/support/tickets` | 自己的工单列表 |
| GET | `/api/support/tickets/:ticketNo` | 自己的工单详情（别人的 **404**，不是 403 —— 与全仓「不泄露存在性」一致） |
| POST | `/api/support/tickets/:ticketNo/replies` | 家长补充信息；**已关闭的工单不能再回**（409），回复后 `waiting` 回到 `processing` 重新进入客服待办 |

后台：`GET /api/admin/tickets`（筛选 `status/category/priority/keyword` + 分页）、
`GET /api/admin/tickets/:ticketNo`、`PATCH /api/admin/tickets/:ticketNo`（`status/priority/assigneeId`）、
`POST /api/admin/tickets/:ticketNo/replies`（追加一条后台回复，并把 `open` 自动推到 `waiting`）。

`replies` 是 JSON 数组 `[{ by, adminId?, adminName?, at, body }]`（`by: parent | admin`）：读取时**不回传管理员账号**，
只回名字（后台内部页面用），家长端只看到 `body` 与 `at` —— 家长不需要知道值班的是哪一位，
更不能看到 `adminId` 对应的登录名。

### 3.3 灰度开关

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/admin/flags` | 列表，每行带 `key/label/description/enabled/rolloutPercent/allowIds/bucket/updatedAt` |
| PATCH | `/api/admin/flags/:key` | `{ enabled?, rolloutPercent?, allowIds?, description? }` |
| GET | `/api/admin/flags/:key/preview?subjectId=` | → `{ hit, reason, reasonText }`：**不猜**，后台能直接验一个账号/设备命不命中 |
| DELETE | `/api/admin/flags/:key/reset` | 恢复代码默认值 |

`bucket` 说明这个开关按什么对象放量（`user` / `device` / `none`），由代码定义、后台不可改。

---

## 4. 四个开关接在哪（必须是真开关）

| key | bucket | 接在 | 关掉之后的行为 |
| --- | --- | --- | --- |
| `pay.channel.wechat` | user | `payments.service.catalog(userId)` / `channelEnabledFor()` | 微信支付从家长端目录消失，**目录里的 `notice` 说明「已被运营开关关闭」**；给该渠道的支付请求回 503 而不是 400（不是参数错，是能力关着） |
| `pay.channel.alipay` | user | 同上 | 同上；用来「先放 10% 的账号试支付宝」 |
| `pay.refund.selfservice` | none | `paymentsService.requestRefund()` | 自助退款回 403「自助退款暂时关闭，请联系客服」；**后台人工退款不受影响**（运营关的是家长的入口，不是自己的处置能力） |
| `notify.wechat.dispatch` | none | `notifications` 的微信投递 | 模板消息不再出站，投递行**不写**（保持 pending 无意义，直接跳过），站内通知不受影响 |
| `support.tickets` | none | `POST /api/support/tickets` 与 `/api/support/config` | 家长端入口消失、提交回 503；后台仍能看历史工单（历史不能消失） |

求值规则（`flagEnabled(key, subjectId?)`）：

1. 数据库没有这一行 → 用代码默认值（同样要过 2~5 的判定，不能因为缺行就放行）。
2. `enabled = false` → **关**。
3. `subjectId` 在白名单里 → **开**（白名单永远优先于比例，也优先于 `enabled=false` —— 白名单是
   「我就要它开」的意思；这条要写进界面提示）。
4. `rolloutPercent >= 100` → **开**；`<= 0` → **关**。
5. 需要 bucket 的开关但调用方没给 `subjectId` → **关**，并打一条 warn 日志：灰度对象不明确时
   保守关闭，绝不「不确定就放行」。
6. 其余：`sha256(`${key}:${subjectId}`)` 的前 4 字节取模 100 < `rolloutPercent` → 开。稳定散列保证
   同一账号每次结果一致（不能用 `Math.random()`，否则家长刷新两次就变一次）。

---

## 5. 验证方式

| 层 | 怎么验 |
| --- | --- |
| 告警口径 | `server:e2e:alerts`：用 prisma 造受控数据集（backdate `lastActiveAt`、插 failed 指令、插坏签名支付事件），逐条核算五个指标与阈值判定；分母为 0 时断言 `null` 而不是 0 |
| 告警规则与确认 | 同上：改阈值后 `triggered` 翻转；确认后 `ack` 出现在 overview；撤销后消失；非管理员 403；改动进 `OperationLog` |
| 工单 | `server:e2e:tickets`：提交 / 列表 / 详情、跨账号 404、未关闭上限 409、后台筛选与分派、回复推到 `waiting`、关闭后家长不能再回复、`support.tickets=false` 时提交 503 且历史仍可读 |
| 灰度 | `server:e2e:flags`：默认值；百分比稳定（同 id 多次一致、100/0 边界、N 个 id 的命中率落在合理区间）；白名单优先于关闭；缺行走默认；`pay.channel.*` 关掉后目录真的少一个渠道且支付回 503；`pay.refund.selfservice` 关掉后家长自助退款 403 而后台人工退款仍 200；`notify.wechat.dispatch` 关掉后不出站 |
| 后台界面 | 浏览器套件后台新增三节：三个页面的 Tab/表格要么渲染内容要么是明确空态，`preview` 能给出命中结果，确认告警后按钮变「撤销确认」 |
| 家长端 | 浏览器套件家长端新增一节：`/support` 能提交一张工单并在列表里看到；关掉开关时入口消失 |

**诚实边界（必须写进文档与界面）**：告警是**读时计算**的，没有后台任务在扫描、没有出站告警
（不发短信、不发微信、不打电话）；工单没有附件；灰度只支持一个全局百分比 + 白名单，没有
按地区/版本的多维放量。
