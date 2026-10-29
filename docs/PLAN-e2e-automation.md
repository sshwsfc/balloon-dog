# 端到端自动化测试总纲（家长端 + 孩子端 + 机型矩阵）

> 这份文档是给**自动化测试 agent**（不是人类点页面）执行的操作手册：它规定跑什么、
> 按什么顺序跑、每一步用什么证据判定通过、失败时归因到哪一层，以及同一份脚本怎么在
> 不同 Android 系统版本与厂商 ROM 上重放。
>
> 一句话版本：**别再造第二套测试。** 仓库里已经有 1 个 smoke + 18 个服务端契约套件、4 个浏览器套件、
> 4 个设备端套件、1 个跨语言交叉测试。真正缺的是「一次跑完 + 按机型矩阵跑 + 产物可归档 +
> 失败可归因」的入口，以及把**还没被任何套件覆盖的功能**补成用例。这份文档和第 3 节的
> 执行器 `scripts/e2e-matrix.mjs` 补的就是这两件事。

---

## 0. 三条命令

```bash
npm run e2e:all                                  # 全金字塔（L0 静态 → L1 契约 → L2 界面 → L3 设备）
npm run e2e:matrix -- --only=static,contract,ui   # 不接手机时跑的那一档（CI 每次 PR）
npm run e2e:matrix -- --only=device --profile=avd-33-aosp-arm64 --boot
                                                 # 指定机型档，自动起 AVD、跑完关掉
```

`--list` 列出所有层与机型档，`--dry-run` 只打印将要执行的命令而不执行。

---

## 1. 分层：每条结论的「证据等级」

测试的价值不在数量，而在**一条断言能证明什么、不能证明什么**。本仓库的四层证据如下，
任何对外结论都必须能指到自己这一层的证据，不许跨层借用。

| 层 | 命令 | 证明什么 | **不能**证明什么 |
| --- | --- | --- | --- |
| **L0 静态** | `build` / `lint` / `i18n:coverage` / `server:typecheck` / `server lint` / `android:crosstest` | 类型、语法、英文词条完整、调度引擎与后端逐点一致（2016 个采样点） | 任何运行时行为 |
| **L1 契约** | `server:smoke` + 18 个 `server:e2e:*`（共 19 个） | HTTP 契约、权限边界、落库、幂等、状态机（真实 Postgres） | 界面是否把字段显示出来、按钮是否连到接口 |
| **L2 界面** | `e2e:parent` / `e2e:admin` / `e2e:ux` / `e2e:responsive` | 真实浏览器里点得到、看得见、写入真的落库、英文界面不残留中文、5 档视口不溢出 | 设备真的执行了（浏览器只发命令） |
| **L3 设备端** | `android:e2e` / `android:e2e:gaps` / `android:e2e:mode` / `android:e2e:screen` | 真机/模拟器上：安装、授权、指令执行、本地强制、媒体上传、杀进程自愈、锁屏 Kiosk | 厂商 ROM 的真实后台策略、真实孩子绕过、相机画质 |
| **L4 跨端** | 本计划新增的串联剧本（§4.5） | 「家长点了 X → 设备做了 Y → 家长看到 Z」整条链 | 生产规模与并发 |

**判定规则（三条硬规矩）**

1. **跳过不是通过。** 设备所有者没设、屏幕采集权限没人点，相关步骤会被套件主动跳过；
   报告里必须记 `SKIP` 并写原因，绝不允许计入 `PASS`。
2. **数字不涨就是跌 —— 但只对确定性套件。** `scripts/e2e-matrix.mjs` 的 `CONTRACT_SUITES` /
   `UI_SUITES` / `DEVICE_SUITES` 里带 `expected` 的才有硬基线，实际数低于它 → 判 `FAIL`
   （那说明有人删了断言而不是修了 bug）。**项数随数据变化的套件不设基线**：`e2e:parent`
   在没有已绑定设备时是 109 项、有设备时 120 项，`e2e:responsive` 是把 5 档视口聚合成一条总结。
   给它们设数字，只会让干净库上的运行假红。
3. **假红优先怀疑环境。** 并发跑两套浏览器会抢同一个 CDP 端口、被限流会伪装成「已登出」、
   上一次中断的残留活动配置会毒化下一次。归因顺序见 §7。

---

## 2. 环境与前置

### 2.1 本机必需

| 依赖 | 检查命令 | 说明 |
| --- | --- | --- |
| PostgreSQL | `docker ps \| grep balloon-dog-postgres` | 容器端口 `5433`，`server/.env` 的 `DATABASE_URL` 指向它 |
| 后端 :4000 | `curl -s localhost:4000/health` | `npm run server:dev`（设备端与浏览器端都要） |
| 前端 :2727 | `curl -s -o /dev/null -w '%{http_code}' localhost:2727/` | `npm run build && npm run preview` |
| 种子数据 | `npm run db:seed` | 家长 `13800138000/balloon123`、后台 `admin/balloon-admin-2026`、运营 `operator/balloon-operator-2026` |
| Chrome | `/Applications/Google Chrome.app/...` | 可用 `CHROME_PATH` 覆盖 |
| Android SDK | `adb devices` | `~/Library/Android/sdk/platform-tools/adb`，可用 `ADB` 覆盖 |
| 孩子端 APK | `ls android/app/build/outputs/apk/debug/app-debug.apk` | `npm run android:build` |

### 2.2 四个必须记在脑子里的环境坑

- **`e2e:responsive` 要限流放行。** 它做 90 次整页刷新、峰值 300+ req/min。后端必须用
  `RATE_LIMIT_MAX=100000` 起，否则 429 会被前端当成「登录态失效」跳到 `/login`，
  失败信息会伪装成「找不到文案」。执行器会打印警告但不替你改后端配置。
- **浏览器套件不能并发。** 四套共用一个 CDP 端口（默认 9333），并发会出现「页面里出现
  管理后台登录页」「`Cannot read properties of undefined (reading 'pkg')`」这种假红。
  `e2e-matrix.mjs` 强制串行；手动跑也必须串行。
- **设备端不能与浏览器端抢机器。** 设备套件会 `adb install`、`pm clear`、拉起守护进程，
  同一时间只能有一个套件持有设备；同一台主机也只应有一个 adb 目标在跑 e2e。
- **`PUBLIC_BASE_URL` 会让媒体签名 URL 指向公网。** 本机 `server/.env` 配了
  `PUBLIC_BASE_URL` 指向旧 demo 域名（`https://ballondog.hd.takin.cc`）时，后端签发的媒体地址是绝对 URL
  （`server/src/features/media/media.signedUrl.ts:31`）。设备刚把照片上传到本机 :4000，
  再去公网域名取字节，取到的是**另一份部署**里根本不存在的文件 → 三条 JPEG 断言与录音下载
  全红（`status null` / 0 字节），看着像产品坏了。`android/scripts/e2e-agent.mjs` 的
  `fetchMediaBytes()` 已在 origin 不同时改走 API 源站（签名只覆盖 mediaId + 过期时间，与 host
  无关），并在日志里打一行说明。所以那几条断言证明的是「签名 URL 能取到刚上传的真实字节」，
  不是「公网那份部署也有这个文件」。

### 2.3 Android 侧一次性预置（每台设备一份，见 §6 操作手册）

```bash
adb -s "$ANDROID_SERIAL" shell dpm set-device-owner \
  com.balloondog.agent/.capability.AgentAdminReceiver      # 强管控阶段的前置
adb -s "$ANDROID_SERIAL" shell settings put global animator_duration_scale 0
adb -s "$ANDROID_SERIAL" shell settings put global window_animation_scale 0
adb -s "$ANDROID_SERIAL" shell settings put global transition_animation_scale 0
```

设备所有者设不上（系统里已登录了账号 / 已有其他 owner）时，`e2e-gaps` 的强管控段会跳过。
这不是 bug，是设备状态；报告必须如实记 `SKIP:device-owner`。

---

## 3. 执行器：`scripts/e2e-matrix.mjs`

### 3.1 设计原则

- **只编排，不重写。** 每个用例都落到已有的 npm 脚本；执行器负责顺序、环境变量、超时、
  日志、计数核对与报告。这样任何单套件仍然可以被人手工复跑。
- **串行，且没有并发开关。** 浏览器四套共用一个 CDP 端口、设备四套独占一台 adb 设备，
  并发只会制造「页面里出现后台登录页」这类假红；L0 内部也串行（构建会写 `dist/`，lint 读全仓）。
- **产物完整。** 每个套件的完整 stdout/stderr 落到 `artifacts/e2e/<runId>/<suite>.log`，
  报告里只留摘要与失败行，避免日志腐烂。
- **可判定。** 退出码：`0` 全绿；`1` 有 FAIL；`2` 前置不满足（什么都没跑）。

### 3.2 层的定义

| 层 | 套件（按执行顺序） | 前置 |
| --- | --- | --- |
| `static` | `build` → `lint` → `i18n:coverage` → `server:typecheck` → `server lint` → `android:crosstest` | 无 |
| `contract` | `server:smoke` → 18 个 `server:e2e:*` | DB；`server:smoke` 需 :4000 在跑 |
| `ui` | `e2e:ux` → `e2e:responsive` → `e2e:parent` → `e2e:admin` | :2727 + :4000 + 种子数据；responsive 需放宽限流 |
| `device` | `android:e2e` → `android:e2e:gaps` → `android:e2e:mode` → `android:e2e:screen` | adb 设备 + APK + :4000 + 种子数据 |
| `matrix` | `device` 层按 `scripts/device-matrix.json` 的每个档跑一遍 | 同上，另加 `--boot` 可自动起 AVD |

### 3.3 常用调用

```bash
node scripts/e2e-matrix.mjs --list
node scripts/e2e-matrix.mjs --dry-run --only=contract
node scripts/e2e-matrix.mjs --only=static,ui
node scripts/e2e-matrix.mjs --only=device --serial=emulator-5554
node scripts/e2e-matrix.mjs --only=matrix --boot --artifacts=/tmp/e2e-run
node scripts/e2e-matrix.mjs --only=contract --filter=payments,tickets   # 只跑名字含这些的
```

### 3.4 报告格式

`artifacts/e2e/<runId>/report.json`：

```json
{
  "runId": "2026-02-09T08-31-04Z",
  "startedAt": "…", "finishedAt": "…",
  "environment": { "backend": true, "preview": true, "db": true, "adb": ["emulator-5554"], "apk": true },
  "summary": { "pass": 0, "fail": 0, "skip": 0 },
  "suites": [
    { "layer": "ui", "name": "e2e:parent", "status": "PASS", "count": 109, "expected": null,
      "durationMs": 214000, "log": "…/e2e-parent.log", "failures": [], "notes": [] }
  ]
}
```

`summary.md` 是给人看的一页纸：每层一行、失败行贴命令、跳过行贴原因。

`expected: null` 表示这套**没有基线**（项数随数据变化），只要套件自报「全部通过」就算 PASS ——
不要为了填满这个字段去猜一个数字，那正是假红的来源。

---

## 4. 用例清单

用例 ID 规则：`L0-*` 静态、`C-*` 契约、`UI-P-*` 家长端、`UI-A-*` 后台、`D-*` 设备端、
`X-*` 跨端。**新增功能的 PR 必须至少补一条对应的 `UI-*` 或 `C-*`**（见 §10）。

**覆盖现状（先说清楚哪些今天就已经能跑）**

| 组 | 已经写进套件 | 本文档新增、还没写进套件 |
| --- | --- | --- |
| L0 静态 | 6 条闸门 | — |
| L1 契约 | 19 套（smoke + 18 个 `server:e2e:*`） | — |
| L2 家长端 | 9 页有真实点击（UI-P-01/02/03/06/24/25/26/27/28） | **19 页只有「能渲染」**（§4.3 标「必补」） |
| L2 后台 | 20 页（`e2e:admin` 80 项） | — |
| L3 设备端 | 4 套（主链路 86 项 + gaps/mode/screen） | **D-30 … D-43 共 14 条** |
| L4 跨端 | 无 | **X-01 … X-10 共 10 条剧本** |

所以：**执行器今天能跑通的是 L0/L1/L2 的全部 + L3 的四套**；标「必补」「新增」的条目是这份
文档作为待办清单的部分，不是已完成项的装饰。评审时说「已覆盖」之前，先看这一列。

### 4.1 L0 静态闸门

| ID | 命令 | 通过判据 |
| --- | --- | --- |
| L0-01 | `npm run build` | 退出 0（`tsc -b` + vite 产物） |
| L0-02 | `npm run lint` | 退出 0；**当前基线是 23 个 error**（见 §9.3），执行器用基线比对，不允许增长 |
| L0-03 | `npm run i18n:coverage` | 输出「缺失 0 条」，退出 0（`en.ts` 缺任何一条即退出 1，它就是 i18n 的验收闸门） |
| L0-04 | `npm run server:typecheck` | 退出 0 |
| L0-05 | `npm --prefix server run lint` | 退出 0 |
| L0-06 | `npm run android:crosstest` | 输出「不一致：0 个」（真 `ScheduleEngine.java` × 后端 `evaluateSchedule`，2016 个采样点） |

### 4.2 L1 服务端契约（19 套，按域分组）

「自起后端」= 套件自己 spawn 一个后端，端口不冲突；否则要求 :4000 在跑。

| ID | 命令 | 断言数 | 端口 | 证明的关键不变量 |
| --- | --- | --- | --- | --- |
| C-01 | `server:smoke` | 167 | :4000 | 认证、越权、多用户隔离、设备绑定、指令队列闭环、后台鉴权隔离与审计 |
| C-02 | `server:e2e:device-members` | 67 | :4000 | 角色 owner/admin/viewer；viewer 写入口全 403；admin 不能解绑；成员数上限 5→409 |
| C-03 | `server:e2e:children` | 74 | :4000 | 孩子档案（年龄由出生年计算）、三档上限、跨账号 404、设备整组替换、任务完成 `doneAt` |
| C-04 | `server:e2e:privacy` | 76 | :4000 | 同意书版本化、撤回/注销**删设备行与文件**而不是置空 userId、导出仅元数据 |
| C-05 | `server:e2e:payments` | 82 | :4102 自起（假渠道） | 验签/幂等/金额不符/渠道不符/退款窗口/发票互斥/后台统计 |
| C-06 | `server:e2e:flags` | 45 | :4103 自起 | 缺行=代码默认、稳定散列、白名单优先、支付与自助退款真实接线 |
| C-07 | `server:e2e:alerts` | 65 | :4104 自起 | 分母 0 → `null` 而非 0%、确认不改数字、不出站、规则可改 |
| C-08 | `server:e2e:tickets` | 69 | :4105 自起 | 跨账号 404、回复即认领、关闭后双方拒绝、入口开关只挡新增 |
| C-09 | `server:e2e:notifications` | 69 | :4000 | 七个生产点、`(userId,dedupeKey)` 幂等、关分类在源头停止写行 |
| C-10 | `server:e2e:health` | 91 | :4000 | 未上报=「还没检查」、`unknown` 不猜、四档在线分级、`self_check` 走命令队列 |
| C-11 | `server:e2e:time-requests` | 73 | :4000 | 审批真的入队 `temp_unlock`、只能批更少、重复审批 409 |
| C-12 | `server:e2e:child-home` | 43 | :4000 | 未认领设备 SOS 不写任何行、同分钟不重复通知、跨账号隔离 |
| C-13 | `server:e2e:membership` | 180 | :4000 | 动态报价独立复算、三种周期、续费/升级语义、CAS 自动续费、全部门禁 403 |
| C-14 | `server:e2e:referral` | 159 | :4000 | 邀请码注册前校验、首购/续费返现、次月结算、提现四闸、优惠券抵扣 |
| C-15 | `server:e2e:icons` | 32 | :4000 | 签名 iconUrl、不传字节、篡改/跨应用/过期 403、重报不抹图标 |
| C-16 | `server:e2e:wechat` | 52 | :4100 mock + :4101 自起 | 无凭据不发、`40001` 重取 token 重试一次、3 次上限、未绑定留 pending |
| C-17 | `server:e2e:mode` | — | :4000 | 学习/普通模式切换与时间表命中的服务端判定 |
| C-18 | `server:e2e:insights` | — | :4000 | 屏幕洞察采样入库、批次与 AI 结论链路 |
| C-19 | `server:e2e:ai` | — | :4001 | AI 分析任务（配 `server:mock:ai` 时不需要真模型） |

> C-17/18/19 没有在文档里固定断言数，执行器只要求退出 0 并记录实际数量（不设下限），
> 但一旦有人在 `EXPECTED` 表里补了基线，就会按 §1 第 2 条执行。

### 4.3 L2 家长端界面（28 个路由逐页）

家长端一共 30 个路由：`/login`、`/onboarding`、27 个进 `RESPONSIVE_ROUTES` 的页面，外加 `/app-plugins/:packageName` 与 `*` 兜底。下表 28 行 = 27 个响应式路由 + `/login`；`/app-plugins/:packageName` 归在 UI-P-13 里一起验（从列表点进去）。

「现有覆盖」列说明这一页今天被谁证明过：
- **深** = `e2e:parent` 有专门小节（真实点击 + 落库核对）；
- **浅** = 只在 `e2e:responsive` 里验「渲染出来 + 无横向溢出」；
- **无** = 目前只有 L1 契约，界面没人点过 → 本计划标为**必补**。

| ID | 路由 | 页面 | 现有覆盖 | 必测交互与断言 | 状态 |
| --- | --- | --- | --- | --- | --- |
| UI-P-01 | `/login` | 登录 | 深（父 1/2） | 三种登录方式渲染、错误密码给中文提示、注册入口可达 | ✅ |
| UI-P-02 | `/onboarding` | 新手引导 | 深（UX 四步） | 四步可前进/回退、第 3 步「设备管理器」是必选项、下载二维码可解码 | ✅ |
| UI-P-03 | `/` | 首页 | 深（父 3/4/5c） | 设备卡、一键锁屏、网址拦截真实读写、安全区开关落库 | ✅ |
| UI-P-04 | `/location` | 位置 | 浅 | 地图占位、轨迹列表、安全区增删 | **必补** |
| UI-P-05 | `/profile` | 我的 | 浅 | 账号信息、设备列表、入口可达（含帮助与反馈） | **必补** |
| UI-P-06 | `/devices` | 设备管理 | 深（父 5h） | 绑定对话框含下载入口 + 二维码 + 绑定码不被挤出首屏、解绑二次确认 | ✅ |
| UI-P-07 | `/schedule` | 锁屏时间表 | 浅 | 新增时段、按天选择、保存后回读、非法时间被拦 | **必补** |
| UI-P-08 | `/insights` | 屏幕洞察 | 浅 | 采样列表、AI 结论卡片、分页 | **必补** |
| UI-P-09 | `/insights/config` | 洞察配置 | 浅 | 采样间隔/开关保存并回读 | **必补** |
| UI-P-10 | `/mode` | 模式 | 浅 | 普通/学习切换、当前命中状态 | **必补** |
| UI-P-11 | `/mode/schedule` | 模式时段 | 浅 | 时段增删、保存回读 | **必补** |
| UI-P-12 | `/mode/apps` | 模式应用 | 浅 | 应用清单、加白/移除落库、图标真实 `<img>` 解码 | **必补** |
| UI-P-13 | `/app-plugins` | 应用插件 | 浅 | 插件启停、图标解码、`/app-plugins/:packageName` 跳转 | **必补** |
| UI-P-14 | `/app-audit` | 安装审批 | 浅 | 待审批列表、批准/拒绝落库、空态文案 | **必补** |
| UI-P-15 | `/eye-care` | 护眼 | 浅 | 开关、参数保存回读 | **必补** |
| UI-P-16 | `/device-health` | 设备健康 | 浅 | 9 项检查项渲染、按品牌给修复步骤、`self_check` 按钮触发指令 | **必补** |
| UI-P-17 | `/call-sms` | 通话与短信 | 浅 | 两个 Tab、号码脱敏、空态 | **必补** |
| UI-P-18 | `/remote-help` | 远程协助 | 浅 | 发起协助、状态回显 | **必补** |
| UI-P-19 | `/quiz-unlock` | 答题解锁 | 浅 | 题库配置、场次统计、记录、题面渲染 | **必补** |
| UI-P-20 | `/media` | 媒体 | 浅 | 三 Tab、签名 URL 真实 `<img>`/`<video>` 加载、分页 | **必补** |
| UI-P-21 | `/notifications` | 消息中心 | 浅 | 未读徽标、已读/全部已读、删除、跳转来源页 | **必补** |
| UI-P-22 | `/notifications/settings` | 通知设置 | 浅 | 分类开关落库、关掉后不产生新行、微信开关只在有凭据+绑定时出现 | **必补** |
| UI-P-23 | `/time-requests` | 孩子的申请 | 浅 | 列表、批准更少时长、批准后指令入队 | **必补** |
| UI-P-24 | `/children` | 孩子档案 | 深（父 5d） | 增改删、绑定设备整组替换、今日任务完成打勾 | ✅ |
| UI-P-25 | `/privacy` | 合规与隐私 | 深（父 5e） | 两份文档、同意留痕（版本+时间）、撤回同意、导出、注销 | ✅ |
| UI-P-26 | `/support` | 帮助与反馈 | 深（父 5g） | 分类/上限来自服务端、无附件入口、提交→后台回复→关闭后不可回 | ✅ |
| UI-P-27 | `/membership` | 会员中心 | 深（父 5f）+ `/referral` 深 | 渠道实况来自 catalog、未配置不画二维码、退款/开票 | ✅ |
| UI-P-28 | `/referral` | 邀请返现 | 深（父 5） | 邀请码/链接/二维码、返现阶梯、提现申请 | ✅ |

> 「必补」19 页是本计划最大的增量：它们目前只有「能渲染」的证据。每一页的补法固定：
> 进页面 → 点一个真实写操作 → 用 `parentApi()` 回读接口核对落库 → 再断言界面回显。
> 具体断言分三档写（文案在、写操作落库、错误路径给中文提示），不允许只断言「有文字」。

### 4.4 L2 管理后台（20 个路由）

| ID | 路由 | 断言要点 |
| --- | --- | --- |
| UI-A-01..03 | `/admin/login`、未登录守卫、运营账号权限差异 | 未登录跳登录页；运营能进但超管专属页被拒；失败登录也进审计 |
| UI-A-04 | `/admin` 大盘 | KPI 有数字、趋势图渲染、分布条 |
| UI-A-05..10 | `users` / `devices` / `commands` / `questions` / `quiz-records` / `sms-codes` | 列表分页、筛选、详情弹窗；**不含任何孩子的照片/轨迹** |
| UI-A-11 | `/admin/membership` | 会员五页 + 试算 |
| UI-A-12 | `/admin/payments` | 支付四页：收款统计（含渠道体检）、订单流水、人工退款、发票（无号不可开具） |
| UI-A-13 | `/admin/referral` | 分享提成八页 |
| UI-A-14 | `/admin/alerts` | 告警三 Tab：率类分母 0 显示「—」、确认后数字不变 |
| UI-A-15 | `/admin/flags` | 灰度：试算（同对象两次一致）、reset 回默认 |
| UI-A-16 | `/admin/tickets` | 工单：筛选、详情、回复推进、关闭 |
| UI-A-17..19 | `/admin/admins`、`/admin/logs`、`/admin/settings` | 超管专属、审计列表、改自己密码 |
| UI-A-20 | 深层路由刷新 | 直接访问 `/admin/payments` 等不 404（history fallback） |

现有覆盖：`e2e:admin` 80 项覆盖上表全部（浅深混合，见 `scripts/browser-e2e.mjs` 的
「后台 1..10」小节）；新增页要同步加断言。

### 4.5 L3 孩子端（设备端）四套脚本的步骤清单

设备端不是一个页面，是一个**受管的 Android 应用**。四套脚本各管一片：

**(1) `android:e2e` — 主链路（27 步 / 86 条断言）**

后端连通 → 等模拟器 → 安装 APK + `pm clear` → 授予权限 → **通过界面点「启动守护」**
（`AgentService` 未导出，shell 拉不起来是刻意的安全边界）→ 读设备自生成绑定码 →
家长登录认领 → 心跳写回电量/在线 → **指令闭环**（入队 → `dispatchedAt` → `succeeded` →
状态落地 → 反向解锁）→ 设备管理器 `systemLock` → 远程拍照（Camera2 → 上传 → 签名 URL
下载 → JPEG `FFD8` 魔数）→ 远程录音（M4A 非空）→ 屏幕截图（自动点掉系统授权框 →
MediaProjection）→ 位置上报 + 服务被杀自愈 → 幂等 `noop` → 强管控（设备所有者 →
禁卸载 / 强停无效）→ 定时锁屏 4 分钟后 → 倒计时悬浮窗 → Kiosk
`mLockTaskModeState=LOCKED` → 设备回报实际锁定 → 远程解锁 → `password` 最高档随机改写
系统锁屏密码 + 应急密码离线解锁 → `kill -9` 后保活恢复（PID 变化）→ 解绑后自动重新注册 →
清理设备与注册记录。

**(2) `android:e2e:gaps` — 差异功能（16 步）**

前置检查 → 环境准备 → 隐藏图标 → 安全区进出 → 安装审核（`OwnerHardening`）→
逐应用限时 → 通话记录 + 短信上传 → 环境监听 → 无障碍截图 → 连续录像
（`startVideo/stopVideo`）→ 屏幕洞察周期采样 → 网址拦截（`DomainBlocker` / DNS VPN）→
局数/集数预算 → 远程协助 → 长活与防卸载（受保护包 / 卸载被拒 / 强停无效 / 杀进程自愈 /
无障碍失效上报）→ 收尾。

**(3) `android:e2e:mode` — 模式与护眼（8 步）**：基线（靶子应用可开）→ 手动切学习模式被
拦回 → 按时间命中即拦 → 白名单放行 → 切回普通 + 清白名单 → 护眼与插件规则落盘 → 清理。

**(4) `android:e2e:screen` — 屏幕采样（9 步）**：安装配对 → 开周期截屏（10 秒/张、2 张/包）
→ **人工点一次系统采集授权** → 等上传 → 服务端结论 → 最弱路径（无悬浮窗/无设备管理器）
→ 接入强手段后锁屏期亮屏重新置前 → 清理。

**本计划新增的设备端用例（当前四套都没有覆盖，按优先级排）**

| ID | 用例 | 操作 | 断言 | 为什么重要 |
| --- | --- | --- | --- | --- |
| D-30 | 覆盖安装（升级） | `adb install -r` 新 APK | 设备身份不变（`deviceCode` 相同）、已绑定关系不丢、守护自动恢复 | 用户升级一次就掉绑定是高频投诉 |
| D-31 | 飞行模式 → 恢复 | `svc wifi disable` + `svc data disable`，等 60s，再恢复 | 指令不丢（排队重发）、上报带重试、界面显示离线而非丢失 | 网络抖动是最常见的现场 |
| D-32 | 系统时间回拨 | `adb shell date` 往前拨 1 小时 | 限时/预算不因时钟跳变而提前解禁；服务端以自身时间为准 | 孩子改时间是真实绕过手段 |
| D-33 | 权限被回收 | 运行中 `pm revoke` 无障碍/USAGE | 健康快照 3 分钟内变 `warn/danger`、家长端看到具体缺哪项、修复步骤按品牌给 | 国产 ROM 会静默回收权限 |
| D-34 | 低电量与省电模式 | `dumpsys battery set level 5` + `set ac 0` | 守护不被系统杀；被杀后 5 分钟内自愈 | 后台存活的核心场景 |
| D-35 | 分屏 / 多窗口逃逸 | 长按最近任务开分屏 | 锁定态下另一个窗口不可用，或家长端看到「疑似绕过」事件 | 孩子绕过锁屏的常见手法 |
| D-36 | 返回键/主页键逃逸 | Kiosk 下连按 back/home/recents | 仍在 `LOCKED`，截图前后帧一致 | Kiosk 是否真的顶得住 |
| D-37 | VPN 被系统关闭 | 关闭 VPN（含「始终开启」被撤） | 网址拦截降级可感知：健康快照报 `vpnConsent` 缺口，而不是静默失效 | 静默失效最危险 |
| D-38 | 多孩子 × 多设备 | 一个家长 2 孩子 3 设备 | 设备切换不串数据；家长端每页都带正确 `deviceId` | 多设备家庭是主流 |
| D-39 | 解绑 → 换绑 | 家长解绑，另一账号绑同一台 | 前一家照片/轨迹不可见（按 `deviceId` 归档） | 隐私红线 |
| D-40 | 卸载尝试 | 设备所有者下点卸载 | 系统拒绝卸载、家长端记一条事件 | 防卸载承诺 |
| D-41 | 厂商品牌识别 | 设备上报 `Xiaomi/HUAWEI/OPPO/vivo/Samsung` 型号串 | 健康修复步骤按品牌给（`brandOf` 包含匹配） | 9 个检查项里 4 个要靠品牌路径 |
| D-42 | 指令超时 | 家长发指令后杀掉设备进程 30s | 指令进 `expired`，家长端给「设备没响应」而非「成功」 | 不许服务端替设备宣布成功 |
| D-43 | 长轮询断线重连 | `adb shell am force-stop` 后重启 | 25s 长轮询自动重连，指令不重复执行（幂等） | 队列契约的边界 |

### 4.6 L4 跨端串联剧本

这些是「一条断言跨两个端」的剧本，任何一层单独跑都证明不了。建议每个发版跑一遍。

| ID | 剧本 | 家长端断言 | 孩子端断言 |
| --- | --- | --- | --- |
| X-01 | 绑定新设备 | 对话框里二维码可解码 → 填绑定码 → 设备出现在列表 | 孩子端首页显示绑定码；绑定后收到 `config` |
| X-02 | 一键锁屏 | 点锁屏 → 状态变「已锁」 | 屏幕锁；`dumpsys` 报 `LOCKED`；回报成功 |
| X-03 | 远程拍照 | 媒体页出现新照片且能打开 | 相机被调用；上传走 multipart；服务端签名 URL 可下载 |
| X-04 | 加时申请 | 家长在 `/time-requests` 批 30 分钟 | 孩子端解锁 30 分钟；指令 `temp_unlock` 走队列 |
| X-05 | 家庭成员 | 邀请 viewer → 他能看不能写 | 设备侧无感（仍用 owner 电话） |
| X-06 | 会员门禁 | 免费账号绑第二台设备 → 403 引导开通 | 设备侧不注册成功 |
| X-07 | 帮助与反馈 | 家长提工单 → 后台回复 → 家长看到 | — |
| X-08 | 告警大盘 | 后台大盘里失联数 +1（回拨 `lastActiveAt`） | 设备心跳中断 |
| X-09 | 注销账号 | 家长注销 → 7 天冷静期 → 设备行删除 | 设备 token 401，自动重新注册成未认领态 |
| X-10 | 升级保绑定 | — | `adb install -r` 后仍在线、仍锁定 |

---

## 5. 机型与系统矩阵

### 5.1 三个轴，不要一个轴拉满

设备端问题几乎都来自这三件事的组合，而不是「Android 版本」本身：

1. **系统版本**（API 26 / 28 / 30 / 31 / 33 / 34 / 35）：影响前台服务类型、精确闹钟、
   `MediaProjection` 授权流程、后台启动限制、Kiosk API 行为。
2. **ROM 家族**（AOSP / 小米 HyperOS / 华为 HarmonyOS / OPPO ColorOS / vivo OriginOS /
   三星 OneUI / 通用）：影响**自启动、后台限制、权限静默回收、悬浮窗、设备管理器策略、
   电池白名单入口**。这些恰恰是本产品最容易被「静默失效」的地方。
3. **形态与能力**：屏幕尺寸/密度（横竖屏、小屏）、是否可设设备所有者、是否有前置相机、
   是否支持 VPN、是否平板。

**覆盖策略：版本轴用模拟器全覆盖，ROM 轴必须真机。** 模拟器可以证明「协议 + 逻辑 +
界面」，但证明不了「HyperOS 会不会 5 分钟杀掉守护」。评审时不许拿模拟器的绿灯替代真机结论。

### 5.2 模拟器矩阵（可自动跑，`--boot` 自动起停）

| profile id | 系统 | API | ABI | 用途 | 本机是否已装 |
| --- | --- | --- | --- | --- | --- |
| `avd-33-aosp-arm64` | Android 13 | 33 | arm64-v8a | **主力档**，当前唯一已装镜像 | ✅ |
| `avd-28-aosp-x86_64` | Android 9 | 28 | x86_64 | 旧机型基线（前台服务、权限模型差异） | ❌ 需 `sdkmanager` 装 |
| `avd-31-aosp-arm64` | Android 12 | 31 | arm64-v8a | 精确闹钟 / 前台服务类型分水岭 | ❌ |
| `avd-34-aosp-arm64` | Android 14 | 34 | arm64-v8a | 前台服务类型强制声明、`MediaProjection` 收紧 | ❌ |
| `avd-35-aosp-arm64` | Android 15 | 35 | arm64-v8a | 最新行为变更提前预警 | ❌ |
| `avd-33-small-720p` | Android 13 | 33 | arm64-v8a | 720×1280 小屏，验证 Kiosk 倒计时/悬浮窗不遮挡关键按钮 | ❌（可改 AVD 配置） |
| `avd-33-tablet` | Android 13 | 33 | arm64-v8a | 平板 1280×800，验证响应式与横屏锁屏 | ❌ |

> 本机现有的 AVD 是 `bd-verify`（API 33）、`bd-user`、`bd-hide`；机型档里的 `avd` 字段是
> 本机约定的名字，换一台机器用 `--avd=<name>` 覆盖，不要为了对齐文档去改别人的 AVD。

装镜像与建 AVD（模拟器矩阵的前置，一次性）：

```bash
sdkmanager "system-images;android-34;google_apis;arm64-v8a"
avdmanager create avd -n avd-34-aosp-arm64 -k "system-images;android-34;google_apis;arm64-v8a" \
  -d pixel_6 --force
```

### 5.3 真机矩阵（必须人工预置，每台打一次勾）

| profile id | 机型示例 | ROM | 版本 | 关键验证点 | 预置 |
| --- | --- | --- | --- | --- | --- |
| `real-xiaomi-hyperos` | Redmi Note 13 / 小米 14 | HyperOS 1.x | 14 | 自启动白名单、后台弹出界面、`dpm` 是否被 MIUI 拦 | 关 MIUI 优化？**不要关**，要在默认状态下验 |
| `real-huawei-harmony` | 华为 P40 / nova 12 | HarmonyOS 4 | 12 | 无 GMS 下的网络、设备管理器、后台清理 | 允许「关联启动」 |
| `real-oppo-coloros` | OPPO A57 / Reno 11 | ColorOS 14 | 14 | 省电模式下杀进程、悬浮窗权限 | 关闭「智能省电」前后各跑一次 |
| `real-vivo-originos` | vivo Y36 / iQOO Z9 | OriginOS 4 | 14 | 后台高耗电、自启动、i管家拦截 | — |
| `real-samsung-oneui` | Galaxy A54 | OneUI 6 | 14 | 设备所有者、Kiosk、Knox 影响 | 无 Samsung 账号 |
| `real-generic-old` | 任意 8.1 老机 | AOSP-like | 27/28 | 低版本前台服务与权限模型 | — |
| `real-lowend` | 2GB RAM / 32GB | 任意国产 | 11/12 | 内存压力下守护存活、相机降级 | 开「内存扩展」 |

**每台真机的一次性预置清单（agent 可以自动做，除了登录厂商账号）**

1. `adb devices` 能看到；`ro.product.manufacturer/model` 记录下来（喂给 `brandOf` 断言）。
2. `dpm set-device-owner com.balloondog.agent/.capability.AgentAdminReceiver` 成功（失败则
   在报告里如实记 `SKIP:device-owner`，并标记该机型的强管控结论「未验证」）。
3. 关闭动画三件套（§2.3）、关闭锁屏密码自动超时、关闭 Play Protect 实时扫描。
4. 打开「USB 调试（安全设置）」允许模拟点击。
5. 记下**厂商设置路径**：自启动、后台高耗电、悬浮窗、电池优化白名单——这些是 `brandOf`
   修复步骤文案要对应的真实路径（脚本只验文案按品牌分支，不验路径在每台机器上都对）。

### 5.4 每档能证明什么（写进报告，不许糊）

| 档 | 能证明 | 不能证明 |
| --- | --- | --- |
| `avd-33-aosp-arm64` | 全链路功能、指令闭环、Kiosk、媒体上传、模式/护眼/插件逻辑 | 任何厂商后台策略、真实 Doze 深度休眠、真实相机质量 |
| `avd-28` | 低版本权限模型、前台服务行为 | Android 14 的前台服务类型强制、15 的行为变更 |
| `avd-34/35` | 新行为变更（前台服务类型、`MediaProjection` 收紧） | 厂商 ROM 的额外限制 |
| `real-xiaomi-hyperos` | 默认 HyperOS 下守护存活、自启动、悬浮窗、设备管理器可用性 | 其他厂商 |
| `real-oppo-coloros` | 省电模式下的存活边界 | 华为/小米策略 |
| `real-huawei-harmony` | 无 GMS 环境、HarmonyOS 后台策略 | Google 服务相关行为 |
| 平板/小屏档 | 布局与 Kiosk 覆盖层在极端尺寸下不挡关键操作 | 手机上的性能 |

### 5.5 家长端也要考虑「各种手机」——但那是浏览器矩阵，不是 ROM 矩阵

家长端是**移动端网页**，它的风险不在厂商后台策略，而在浏览器内核与下载行为。当前
`e2e:responsive` 用无头 Chrome 跑 5 档视口，只能证明「Chromium 内核下布局成立」，
**不能**证明 iOS Safari 的 `100vh`、`safe-area-inset-*`、`backdrop-filter`，也不能证明微信
内置浏览器的下载与存储行为。

| 环境 | 能不能自动化 | 验证点 | 现状 |
| --- | --- | --- | --- |
| Android Chrome（含 MIUI/华为内置浏览器） | 部分（CDP 可驱动 Chromium 系） | 视口、字体回退、`<a download>` 对 APK 的行为 | Chrome ✅；厂商内置浏览器 🟡 手工 |
| iOS Safari 15 / 16 / 17+ | ❌（需要 WebKit，本仓库没有 Playwright） | 地址栏收缩导致的 `100vh` 抖动、刘海安全区、`position: fixed` 底栏、`backdrop-filter` 降级 | 手工，必须真机 |
| 微信内置浏览器（Android / iOS） | ❌ | 下载 APK 在 iOS 上必然失败（这是产品边界，不是 bug）；`localStorage` 隔离导致换号后残留登录态；`X-Frame`/`window.open` 受限 | 手工，必须真机 |
| 小屏 320×568 / 大屏 430×932 | 部分（视口档已覆盖 320/375/414/768/1280） | 首屏不被底部导航挡住、绑定对话框不用滚动就能看到绑定码 | 视口档 ✅ |
| 平板 / 横屏 | 部分（`e2e:responsive` 有 768/1280） | 内容列居中限宽、侧栏导航形态 | ✅ |

**iOS/微信手工清单（发版前 5 分钟，不写进自动化）**

1. 打开 `/`，横竖屏切换各一次：底栏不遮住「一键锁屏」按钮，吸底不跳。
2. `/devices` → 绑定对话框：iOS 上不出现「页面被键盘顶飞后关不掉」；二维码可被微信扫。
3. 微信里点「下载孩子端」：iOS 必须**明确告知不能装**（而不是给一个死链）。
4. 微信里退出登录再登录另一个账号：不能看到上一个账号的缓存数据。
5. 深色模式切一次：文字不能变成浅灰底上的浅灰。
6. 低电量模式 / 弱网（3G）下首页 3 秒内出骨架或空态，而不是白屏。

这些是**真机人工**，报告里只能记「已人工验证 / 未验证」，不许引用 `e2e:responsive` 的绿灯。

### 5.6 跑哪些、多久跑一次

| 频率 | 跑什么 | 时长量级 |
| --- | --- | --- |
| 每次 PR | `static` + `ui`（parent/admin）+ 受影响域的 1-3 个 `contract` 套件 | 6-10 分钟 |
| 每天 | `static` + `contract`（19 套）+ `ui`（四套） | 25-40 分钟 |
| 每周 | `device` 全矩阵（模拟器 7 档）+ 真机 7 台各一轮 | 3-6 小时（可并行 2-3 台/主机） |
| 发版前 | 全金字塔 + `X-*` 十条跨端剧本 + 真机矩阵全绿 | 1-2 天 |

---

## 6. 设备预置手册（可复制的命令）

```bash
# 0) 选设备：永远显式指定 serial，防止多设备时串台
export ANDROID_SERIAL=emulator-5554
export API_BASE=http://localhost:4000/api
export ADB=$HOME/Library/Android/sdk/platform-tools/adb

# 1) 记录机型（喂给 brandOf 断言的原始值）
"$ADB" shell getprop ro.product.manufacturer
"$ADB" shell getprop ro.product.model
"$ADB" shell getprop ro.build.version.release
"$ADB" shell getprop ro.build.version.sdk

# 2) 装 APK（首次或改代码后）
npm run android:build
"$ADB" install -r android/app/build/outputs/apk/debug/app-debug.apk

# 3) 设备所有者（强管控档必需）
"$ADB" shell dpm set-device-owner com.balloondog.agent/.capability.AgentAdminReceiver

# 4) 无头 AVD（CI）
$HOME/Library/Android/sdk/emulator/emulator -avd avd-33-aosp-arm64 \
  -no-window -no-audio -no-snapshot -gpu swiftshader_indirect &
$HOME/Library/Android/sdk/platform-tools/adb wait-for-device
until [ "$("$ADB" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ]; do sleep 2; done
```

**锁屏相关注意**：锁屏会关屏，`uiautomator dump` 拿不到 root node，所以每次 dump 前先
`adb shell input keyevent KEYCODE_WAKEUP`（四套脚本里已封装，自己写新脚本时必须遵守）。

**重置应用数据用 `pm clear`，不要卸载重装**：设备管理器激活后系统会拒绝卸载，
静默失败会泄漏设备身份，下一次运行就绑到一台「幽灵设备」上。

---

## 7. 自动化 agent 执行契约（不许做的事）

1. **一台主机同一时间只跑一个「会动设备或浏览器」的套件。** 两个套件抢 CDP / adb，
   产出的红色全是假的。`e2e-matrix.mjs` 强制串行，不要绕过去手动并发。
2. **永远显式 `-s "$ANDROID_SERIAL"` / `ANDROID_SERIAL=`。** 多设备时默认会串台，
   而且症状是「另一台设备上的旧 App 报错」。
3. **失败先看四件事，再怀疑代码**：① 后端是不是用放宽的限流跑的；② 上一次是不是中断了
   并留下未关闭的工单/未复位的活动配置；③ 有没有残留的无头 Chrome 或 AVD（`ps aux |
   grep -E 'Chrome|emulator'`）；④ 报告里该套件的**断言数**有没有变化（数变了通常是被删
   或提前退出）。
4. **不许把 `SKIP` 记成 `PASS`。** 设备所有者没设、采集授权没人点，结论必须是「未验证」。
5. **不许修改被测试数据来凑绿。** 需要特定状态就用 API/数据库造（例如回拨
   `lastActiveAt`、写 `PaymentEvent`）；改生产代码让它「配合测试」是禁止的。
6. **跑完必须复位**：活动配置与返现阶梯回默认（referral 套件自己做）、五条告警规则回默认、
   五个灰度开关回默认、工单关掉自己造的那张、测试账号删掉。
7. **日志归档。** 每个套件的完整输出进 `artifacts/e2e/<runId>/`，报告里只留摘要与失败行。

---

### 7.1 给自动化 agent 的可复制指令

把下面这段原样交给一个执行型 agent（它按顺序做完即可，不需要理解全文）：

```text
目标是跑通 balloon-dog 的端到端验收并给出可判定的结论。按顺序执行：

1) 前置：npm run db:up && npm run db:seed && npm run server:dev（后台常驻）
   另开一个终端：npm run build && npm run preview
   确认：curl -s localhost:4000/health 与 curl -s -o /dev/null -w '%{http_code}' localhost:2727/
2) 不需要手机的层：npm run e2e:matrix:ci -- --artifacts=artifacts/e2e
   —— 任何 FAIL 都先看 artifacts/e2e/<runId>/report.json 的 failures 与对应 *.log，
      不要重跑整层来"试试看"。
3) 设备层：先 adb devices 确认恰好一台；Android API 必须是 33（avd-33-aosp-arm64 档）。
   npm run e2e:matrix -- --only=device --profile=avd-33-aosp-arm64 --device-suites=agent
   然后分别跑 --device-suites=gaps / mode / screen（串行，不要同时跑）。
4) 汇报格式：每层一行（通过/失败/跳过 + 断言数 + 基线），失败逐条给"断言文字 + 日志文件:行号"，
   跳过逐条给原因；最后附上 artifacts 目录路径。
5) 禁止：并发跑两套浏览器或两套设备套件；把 SKIP 计为 PASS；为凑绿改生产代码或改断言。
```

## 8. 产物与判定

```
artifacts/e2e/<runId>/
├── report.json            # 机器读（schema 见 §3.4）
├── summary.md             # 人读一页纸
├── static-build.log
├── contract-payments.log
├── ui-parent.log
├── device-agent-avd-33-aosp-arm64.log
└── screenshots/            # 失败时的关键帧（浏览器与设备端）
```

状态只有四个：`PASS` / `FAIL` / `SKIP`（预期内跳过，带原因）/ `BLOCKED`（前置不满足）。
**只有 `PASS` 计入绿；`SKIP` 与 `BLOCKED` 必须在 summary 顶部列出，发版评审时逐条过。**

---

## 9. 诚实边界（这些永远不会绿，别写进验收）

1. **真实支付渠道**：没有商户号，微信/支付宝只验了「未配置时如实报缺哪个变量」；
   真实扣款、真实退款到账、真实发票抬头校验都没跑过（`server:e2e:payments` 用的是假渠道）。
2. **微信模板消息**：用 mock 上游验了重试与渲染，真实公众号推送没有凭据。
3. **AI 分析**：`server:e2e:ai` 打的是 mock 模型；真实模型效果不是自动化能判的。
4. **厂商 ROM 的「自启动/后台被杀」**：只能在一台真机上得出「这一台、这一版」的结论，
   不能推广到同品牌其他型号。报告必须写机型与版本号。
5. **真实孩子绕过行为**（改时间、分屏、辅助功能劫持）只覆盖已知手法；未知手法靠现场反馈。
6. **相机/录音质量**：只验「有帧、能解码、能下载」，不验画质与噪点。
7. **前端 lint 基线 23 个 error**：它们是历史遗留（`src/admin/hooks/useAsyncData.ts` 的
   `react-hooks/refs` / `set-state-in-effect` 等），本计划不把它们清零，只保证**不增长**。
8. **`PUBLIC_BASE_URL` 指向公网时，本地取媒体字节是改过源站的**（见 §2.2）。这条边界写在这里，
   是因为它决定了 L3 的媒体断言能证明什么、不能证明什么。

---

## 10. 维护规则（新增功能必须做的事）

1. **新增一个家长端页面** → 加进 `scripts/browser-e2e.mjs` 的 `RESPONSIVE_ROUTES`
   （否则响应式断言数不会变，等于没验过），并在 `e2e:parent` 里加一条真实点击 + 回读。
2. **新增一个接口** → 在对应 `server:e2e:*` 里加断言；新域就新开一个套件、自起后端（端口
   4106 起），并进 `package.json` 与 `AGENTS.md` / `CLAUDE.md` 的测试清单。
3. **新增一条孩子端指令** → 至少补：入队 → 设备领取 → 执行 → 回报 → 家长端状态收敛，
   以及「设备不响应时进 `expired` 而不是成功」。
4. **改任何计数**（页面数、断言数、视口数）→ 同步改 `README.md` / `AGENTS.md` /
   `CLAUDE.md` / `docs/RESPONSIVE.md` / `docs/FEATURE-STATUS.md` / `docs/PARENT-UX.md`，
   以及本章与 `scripts/e2e-matrix.mjs` 的 `EXPECTED` 表。**计数漂移就是文档失信的开始。**
5. **新增机型档** → 在 `scripts/device-matrix.json` 加一条（含 `expectedSkips` 与
   `capabilities`），并在 §5.3 表格登记「能证明/不能证明」。

---

## 附：现有套件与本文档的关系

- 本文档**不替换** `AGENTS.md` / `CLAUDE.md` 里的测试条目，它们是「有什么」；
  本文档是「怎么把它们按层、按机型、按证据等级跑成一次可归档的验收」。
- 单套件仍可独立运行（`npm run server:e2e:payments`、`npm run e2e:parent`、
  `ANDROID_SERIAL=emulator-5554 npm run android:e2e`），执行器只是编排它们。
- 已有详细口径见：`docs/FEATURE-STATUS.md`（每功能的验证等级与诚实边界）、
  `docs/PARENT-UX.md`（家长端文案与交互锚点）、`docs/RESPONSIVE.md`（视口与路由）、
  `android/README.md`（设备端协议、预置、强管控边界）、`server/README.md`（接口契约）。

---

## 附录 A：本机验证记录（2026-10-19，macOS + emulator-5554 / API 33）

执行器不是「写完就交」的脚本，下面每一行都是真的跑过、真的看过产物的记录。复跑时按这个格式
追加，不要覆盖旧记录 —— 一次通过和十次通过的区别，只有历史记录能证明。

| 层 | 命令 | 结果 |
| --- | --- | --- |
| L0 | `npm run e2e:matrix -- --only=static` | **6/6 PASS**：`build` ✓、`lint` 23 个 error 与基线持平（eslint 永远退出 1，只看是否增长）、`i18n:coverage` ✓、`server:typecheck` ✓、`server lint` ✓、`android:crosstest` 采到 198 个点且调度引擎与后端逐点一致 |
| L1 | `npm run e2e:matrix -- --only=contract --filter=payments,flags` | **82/82、45/45 PASS**（两套都自己起后端，证明 `spawnsBackend` 分支可用） |
| L2 首跑 | `--only=ui --filter=ux,parent` | `e2e:ux` **134/134 PASS**；`e2e:parent` **109/109 PASS**（它自报「全部通过」）。**这一跑发现了一个设计错误**：家长端套件的项数随数据变化（干净库 109、有已绑定设备 120），把 120 当硬基线会假红，已改为不设基线 |
| L2 | `npm run e2e:matrix -- --only=ui` | **4/4 PASS，全套串起来跑通**：`e2e:ux` 134/134（96s）、`e2e:responsive` 4 项聚合结论（49s，5 档视口 × 27 页）、`e2e:parent` 109/109（90s）、`e2e:admin` 80/80（146s）。注意 `responsive` 与 `parent` 的 `expected` 是 `null`（无基线，见 §1 第 2 条） |
| L3 第 1 跑 | `--only=device --profile=avd-33-aosp-arm64 --device-suites=agent` | 78 通过 / 5 失败：**5 条全是媒体下载断言**，根因是 §2.2 的 `PUBLIC_BASE_URL` 假红，不是产品坏了 |
| L3 第 2 跑 | 同上（修 `fetchMediaBytes` 之后） | 媒体 5 条全绿（日志打一行「签名 URL 指向 X，本地取字节改走 Y」）；83 通过 / 1 失败：`应急解锁` 断言输在「系统 keyguard 盖住应用锁屏，点击落空」，失败信息又只有一句「没看到日志」 |
| L3 第 3 跑 | 同上（补「先收掉系统 keyguard + 等「应急解锁」入口出现 + 失败时打 UI 摘要」之后） | **86/86 PASS**：三次跑的是同一台模拟器、同一份产品代码，中间只改了测试脚本对环境的处理（改源站取字节、收 keyguard、等入口），现在失败信息自带屏幕摘要 |

两次失败暴露的是**同一类问题**：套件把「环境差异」报成了「产品坏了」，而失败信息不带现场。
这也是本计划第一条硬规矩的来源 —— 失败必须能归因，否则重跑只是掷骰子。
