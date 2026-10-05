# 孩子端补齐功能的接口契约（施工基准）

本文是「把孩子端没真正实现的功能补齐」这一轮的**唯一契约来源**。
三端（server / web / android）必须严格按此实现，不要各自发明字段名。

范围见 [`FEATURE-STATUS.md`](FEATURE-STATUS.md) §3。共 9 项。

> **施工中出现过三处「契约与代码不一致」，已按下表落定。以「实际落定」列为准**，
> 下面各节的字段名若与本表冲突，以本表为准。

| # | 契约原文 | 实际落定 | 为什么 |
|---|---|---|---|
| 1 | §2 要求「安全区只下发 `enabled` 的」 | `SafeZone` 原本**没有** `enabled` 列，已在迁移 `20261004063411_agent_gaps` 补上 `enabled Boolean @default(true)`；`agent.controller.ts:242` 的查询带 `where: { deviceId, enabled: true }` | 契约写了过滤条件但 schema 里根本没有这个字段，locations 域 0 处引用，不补就是空条件 |
| 2 | §4 只说了「设备端要能显示今日已用」 | 家长端 `/api/features` 的 `appLimit.apps` 值类型由 `number` 改为 `{ dailyLimit, usedTodaySeconds }`。**设备端不受影响**——设备端拿的是 `appLimits` 数组（`{appName, packageName, dailyLimitMinutes}`），不是这个 `apps` 对象 | 只有上限不足以显示「今日已用 / 上限」 |
| 3 | §8 提到 `sync_calls_sms`，但没写进 §0.4 的指令清单 | 已进 `COMMAND_TYPES`；**Android `CommandExecutor` 必须同时处理它，否则静默不执行**（截稿时 Android 侧只有 `Constants.java:83` 的常量，switch 分支待补） | 契约漏写导致「家长端点刷新、接口返回成功、设备端什么也没做」的假成功风险 |

另外两处实现细节（契约没规定，子代理自主决定，已核准）：

- 设备端上报接口（`/api/agent/app-usage`、`/api/agent/calls`、`/api/agent/sms` 等）**空数组一律 422**，
  因为它们都是**全量替换**语义。设备端查到 0 条时应当**跳过上报**，不要发空数组。
- `installApprovalUntil` 由**服务端时钟**判定过期后置 `null`，设备端不要再拿本机时钟判断——
  「客户端时钟准不准」不该成为安全边界。
- `limitMinutes === 0` 表示**不限**（`appLimit.unlimited`），设备端 §1 的「`limit <= 0` 视为不限」与此一致，不要做成两套。

---

## 0. 贯穿原则

1. **离线优先**：所有管控规则随 `/api/agent/config` 下发并落盘，设备端本地判定，断网照常生效。
2. **不伪造**：做不到就如实降级并在界面写明，**绝不返回假的成功**。
3. **配置项命名**：新增一律小写驼峰，与现有 `screenMonitor` / `mode` / `eyeCare` 风格一致。
4. **指令类型**：新增指令必须同时改 `server/src/features/devices/devices.constants.ts` 的 `COMMAND_TYPES`
   与 Android `CommandExecutor` 的 `switch`（**漏一处就是静默不执行**）。

---

## 1. 局数 / 集数预算的设备端离线兜底

**现状**：只有服务端强制（超限下发 `lock`）。`LockState.Inputs` 无对应项。

**契约**：无需新增接口。`/agent/config` 已有的 `screenMonitor.usageBudget.{gameRounds,videoEpisodes}`
`{enabled, dailyLimit, usedToday, remaining, exceeded}` 就是权威数据（计数来自服务端 AI 分析）。

**Android**：`LockState.Inputs` 新增 `budgetLockReason`(String|null)，`isLockedAt` 里作为锁定来源之一
（优先级排在「家长远程锁定」之后、「作息时间表」之前）；`Reason` 新增 `BUDGET`。
`LockEnforcer.buildInputs` 从 `store.getGameRounds*/getVideoEpisodes*` 组装原因文案
（例：`今日游戏局数已用完（3/3 局）`）。服务端置 `exceeded=true` 后由 config 下发，设备端即使断网也已落盘。

---

## 2. 安全区设备端围栏

**服务端**
- `/api/agent/config` 新增 `safeZones: [{ id, name, latitude, longitude, radiusMeters }]`（只发 `enabled` 的）
- 新增事件类型：`geofence_enter` / `geofence_exit`（复用现有 `POST /api/agent/events`，**无需新接口**）
- 家长端已有 `/api/safe-zones` 读写，不改

**Android**：`DeviceConfig` 解析 `safeZones` → `AgentStore` 落盘（新增 `KEY_SAFE_ZONES`）；
每次定位上报后本地算 haversine，与上次所在区比对，进出时 `recordEvent(geofence_enter/exit, "进入/离开 <名称>")`。
新增 `capability/Geofence.java`（纯函数：`haversineMeters` + `insideAny`，无 Android 依赖，便于 crosstest）。

---

## 3. 应用审核（设备所有者禁装 + 无障碍上报 + 限时放开）

**服务端**
- `ChildDevice` 新增 `installApprovalUntil DateTime?`（批准后设备可安装的时间窗截止）
- 复用已有 `AppAuditRequest` 表与家长端 `/app-audit` 页面
- 设备端新增 `POST /api/agent/audit-requests`，body `{ appName, packageName }`
  → 服务端 upsert 一条 `pending`（同 device+package 已有 pending 则返回既有 id，幂等）
  → 返回 `{ id, status }`
- 设备端新增 `GET /api/agent/audit-requests/:id` → `{ status }`（`pending|approved|rejected`）
- 家长批准时（已有接口）服务端**额外**把 `installApprovalUntil` 设为 `now + 30 分钟`
  并在 `/agent/config` 下发 `installApprovalUntil`（ISO 字符串或 null）

**Android**
- `appAudit` 特性开启且 `installApprovalUntil` 未到 → `OwnerHardening` 里
  `addUserRestriction(UserManager.DISALLOW_INSTALL_APPS)`；窗口生效或特性关闭 → `clearUserRestriction`
- 无障碍服务在 `onAccessibilityEvent` 里检测到包安装器
  （`com.android.packageinstaller` / `com.google.android.packageinstaller`）
  → 从窗口文本里尽力取应用名（取不到就用包名）→ 上报一次（**同一包名 10 分钟内只报一次**）
  → 显示一层说明（复用 `LockOverlayWindow` 的说明模式或简化 Toast）告知「已请求家长批准」
- **不做**「拦截安装」以外的假动作；安装本身由系统限制挡住

---

## 4. 应用限制（逐应用限时）

**服务端**
- `/agent/config` 的 `appLimits` 已含 `packageName`，**保持不变**
- 新增 `POST /api/agent/app-usage`，body `{ usage: [{ packageName, appName, seconds }] }`
  （设备端上报今日逐应用秒数，全量替换当日数据）
- `AppLimit` 表新增 `usedTodaySeconds Int @default(0)` 与 `usageDay String @default("")`
  （服务端只做存与展示，不参与判定）
- 家长端 `/api/features` 已有 `appLimit` 读写；`GET /api/features` 返回的 `appLimit.apps`
  增加每应用的 `usedTodaySeconds`

**Android**
- 新增 `capability/AppUsageTracker.java`：用 `UsageStatsManager.queryUsageStats(INTERVAL_DAILY)` 累计
  当日各应用前台秒数（需要 `android.permission.PACKAGE_USAGE_STATS`，
  引导页 `Settings.ACTION_USAGE_ACCESS_SETTINGS` 让家长授权；**没授权就如实记日志并跳过**）
- 超限判定放进 `GuardRules.matchAppLimit(limits, usage, pkg)`（纯函数），
  在 `AccessibilityGuard.check` 里排在学习模式之后
- 拦截动作：与学习模式一致（`GLOBAL_ACTION_BACK` + 事件 `app_blocked`，原因写「今日 XX 分钟已用完」）
- 上报：每 30 分钟或配置刷新时上报一次

---

## 5. 网址拦截（VpnService DNS 层过滤）

**服务端**：`/agent/config` 的 `blockedUrls` 已存在，**不改**。

**Android**
- 新增 `service/DnsFilterVpnService.java`（`VpnService`）：
  建立 tun（`addAddress("10.111.222.1", 32)` + `addRoute("0.0.0.0", 0)` + `addDnsServer("10.111.222.1")`），
  读 IP 包 → 解析 UDP:53 → 域名匹配 `store.getBlockedUrls()`（支持后缀匹配）
  → 命中返回 `NXDOMAIN`（或 `0.0.0.0` 的 A 记录），未命中则**转发到上游 DNS** 并回写
- 家长端 `webBlock` 特性开启且 `blockedUrls` 非空时自动建立；关闭时 `stopSelf`
- **必须在界面上如实说明**：只覆盖 **DNS 解析**层；直连 IP、DoH/DoT、已缓存域名可绕过。
  这句话既要写进 `android/README.md`，也要写进家长端「网址拦截」弹窗

> ⚠️ 这一项工程量最大、风险最高。若最终无法在模拟器上验证通过，
> **必须如实标注「已实现但未端到端验证」**，不得声称已验证。

---

## 6. 环境监听（分片连续录音）

**服务端**
- 把死键 `audioRecord` 接上线：`COMMAND_TYPES` 新增 `start_ambient` / `stop_ambient`
- 权限映射：这两个指令要求特性 `audioRecord`（不是 `remoteRecord`）
- 家长端：`HomePage` 的「环境监听」入口（若没有就加）→ 下发 `start_ambient`，可停止

**Android**
- `CommandExecutor` 处理 `start_ambient`：启动循环录音，每片 **5 分钟**（或配置值），
  录完立刻 `uploadMedia(kind='audio')`，然后开始下一片，直到 `stop_ambient`
- 复用 `AudioRecorder`；用前台服务通知写明「家长开启了环境监听」（**不做隐蔽录音**）
- 进程被杀后不自动恢复（避免家长已关掉却还在录）

---

## 7. 远程协助（有限但真实）

**服务端**
- `COMMAND_TYPES` 新增 `remote_action`，payload `{ action: 'back'|'home'|'recents'|'notifications'|'open_app', packageName?: string }`
- 要求特性 `remoteHelp`
- 家长端：把 `HomePage` 的「远程协助」入口做成一个操作面板（返回/主页/最近任务/通知栏/打开应用）
  + 「截取当前画面」按钮（下发已有 `screenshot`）

**Android**
- `CommandExecutor` 处理 `remote_action` → 通过 `LockWatchdogService` 的静态桥执行
  `performGlobalAction(GLOBAL_ACTION_BACK/HOME/RECENTS/NOTIFICATIONS)`
  或 `startActivity(launchIntentForPackage)`；无障碍未连接时如实失败
- **如实声明**：这是「远程操作 + 取屏」，**不是实时投屏 / 不是远程控制**（不做 WebRTC）

---

## 8. 电话短信

**服务端**
- 新模型 `CallLogEntry`（deviceId, phoneNumber, name, type(incoming/outgoing/missed), durationSeconds, occurredAt）
  与 `SmsMessage`（deviceId, address, body, type(inbox/sent), occurredAt）
- `POST /api/agent/calls`、`POST /api/agent/sms`（批量，全量替换最近 N 条）
- 家长端 `GET /api/calls`、`GET /api/sms`（分页）
- 新增家长端页面 `/call-sms`
- **管理后台一律不看内容**（沿用「不向管理员暴露孩子内容」的约定，只给计数）

**Android**
- 新增 `capability/CallLogReader.java`（`READ_CALL_LOG`）、`capability/SmsReader.java`（`READ_SMS`）
- 列出权限时如实标注这两个是**敏感权限**，需家长在设备上手动授予；未授予则跳过并记日志
- 上报周期：每 6 小时一次 + 家长点「刷新」时下发 `sync_calls_sms` 指令

**必须记录的问题**：`READ_SMS` / `READ_CALL_LOG` 属于 Google Play **受限权限**，
上架需申报并被审核（通话记录权限在 Android 10+ 更严）。这不影响本项目自用/侧载，但要在文档写明。

---

## 9. 隐藏图标

**服务端**：`ChildDevice` 新增 `hideIcon Boolean @default(false)`；`/agent/config` 下发 `hideIcon`；
家长端 `/api/device` 或 `/api/features` 提供读写（建议挂在现有设备设置接口上）。

**Android**
- `AndroidManifest.xml` 增加一个 `activity-alias`（`MainActivityLauncher`）指向 `MainActivity`，
  原有的 `MAIN`/`LAUNCHER` intent-filter 移到 alias 上
- 按 `hideIcon` 用 `PackageManager.setComponentEnabledSetting(alias, ENABLED/DISABLED, DONT_KILL_APP)`
  切换图标；**隐藏后仍可通过拨打 `*#*#气球狗设备码#*#*` 之类的入口重新打开**（简化：隐藏时在设置页
  明确提示「图标已隐藏，可通过 ADB 或家长端远程恢复」）
- ⚠️ 隐藏自己的图标会让家长在设备上也找不到入口 —— 必须在家长端界面上明确警告这一点

---

## 10. 不做的（写清原因）

| 项 | 原因 |
| --- | --- |
| **家庭成员** | 这是家长端的多家长协作概念，孩子设备无需参与；不需要「实现」 |
| **同屏监控（实时投屏）** | 需要常驻推流 + 信令服务，是另一个产品量级；首页磁贴应改名或去掉 |
| **真正的远程控制（注入触摸）** | 需要 DO + 无障碍手势注入 + 低延迟双向通道；本轮只做 §7 的有限版本 |
| **护眼距离/姿势提醒** | 前置摄像头持续取帧，隐私与误报代价过高 |
