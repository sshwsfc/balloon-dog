# 功能实现状态与实现原理

本文逐项盘点气球狗**所有功能**的实现状态与落地方式，重点是
**孩子端（`android/` 原生 Agent）到底有没有真正执行**。

> 这份文档的目的不是"报菜名"，而是回答一个问题：
> **家长在网页上点了这个开关，孩子手机上到底会不会真的发生什么？**
>
> **读之前先看 §0 的 🔵 标记。** 本轮把原先 9 项"家长端能用、孩子端零动作"的功能全部补齐了，
> 但它们**只在编译层与 JVM 纯逻辑层验证过，没有一台真机或模拟器跑过**。
> 把这件事说清楚，比多说一句"已完成"重要得多。

---

## 0. 怎么读这份文档

### 三列的含义

| 列 | 含义 |
| --- | --- |
| **服务端** | `server/` 是否有数据模型与接口，能否把策略下发到设备 |
| **家长端** | `src/` 是否有可用的页面/入口 |
| **孩子端** | **`android/` 是否有代码真正落实** —— 这是本表最关键的一列 |

### 状态标记

| 标记 | 含义 |
| --- | --- |
| ✅ **真实执行** | 设备端有代码真正落实，且**经过端到端验证**（真机/模拟器跑过，有可观察的副作用作为证据） |
| 🟡 **部分执行** | 做了其中一部分：要么只验证到链路的一半，要么走了近似的验证路径；文档里逐条写明缺什么 |
| 🔵 **已实现·未上机** | 设备端代码真正落地、编译进 APK，纯逻辑经 **JVM 交叉测试**逐点验证；但**没有在真机或模拟器上跑过**，因此涉及系统授权、真实网络、真实传感器的那部分**未经验证** |
| ❌ **链路失效** | 代码在，也上机跑过了，但**端到端跑不通** —— 配置能下发、能落库，设备端却拿不到或判定不出来 |
| 📦 **仅存储** | 三端数据流通（能配、能存、能下发、能显示），但**设备端不做任何动作** |
| 🖥️ **仅服务端** | 服务端计算/判定，设备端不参与执行 |
| ⚪ **未实现** | 只有功能键或入口，没有实现 |
| ⛔ **明确不做** | 有意识地不做，且界面上如实说明 |

> **为什么要有 🔵 这一档**：把「编译过了」说成「功能做好了」是最容易发生的自我欺骗。
> 一个只在 JVM 上跑过纯函数的 `VpnService`，和真的拦住了 DNS 请求，是两件完全不同的事。
> 这一档明确标注了哪些结论**只到编译与算法层**。
>
> **为什么还要有 ❌ 这一档**：`android/scripts/e2e-gaps.mjs` 上机后才发现，
> 「代码写了、编译过了、单测过了、JVM 纯逻辑也过了」仍然可能**整条链路跑不通** ——
> 逐应用限时就是这样：引擎是好的，但家长端设的规则在**三层**各自被静默丢弃，端到端拦截率是 0。
> 这一类缺陷只有真机端到端才能暴露，见 §4.5。

---

## 1. 总览

| 功能 | 服务端 | 家长端 | **孩子端** | 一句话原理 |
| --- | --- | --- | --- | --- |
| 一键锁屏 / 解锁 | ✅ | ✅ | ✅ **真实执行** | `DevicePolicyManager.lockNow()` + 应用内锁定页 |
| 临时可用 | ✅ | ✅ | ✅ **真实执行** | 本地放行截止时间戳，压过一切锁定来源 |
| 定时锁屏 / 定时解锁 | ✅ | ✅ | ✅ **真实执行** | 规则原样下发，`ScheduleEngine` **本地**求值 |
| 屏幕时间（每日时长） | ✅ | ✅ | ✅ **真实执行** | 本地按 1:1 实时消耗推算耗尽时刻并锁屏 |
| 锁屏强度分档 | ✅ | ✅ | ✅ **真实执行** | Kiosk / 悬浮窗 / 锁定页 / 随机密码 四档自动降级 |
| 答题解锁 | ✅ | ✅ | ✅ **真实执行** | 服务端出题（题库或屏幕题）→ 设备端锁定页答题 |
| 模式切换（学习模式） | ✅ | ✅ | ✅ **真实执行** | 无障碍 + 前台包名白名单，**本地求值** |
| 护眼设置 | ✅ | ✅ | ✅ **真实执行** | 连续用眼计时 → 注入锁定源 → **真锁屏** |
| 微信 / QQ 功能管控 | ✅ | ✅ | ✅ **真实执行** | 无障碍 + 界面文本关键词匹配 → 按返回推走 |
| 周期截屏 + AI 洞察 | ✅ | ✅ | ✅ **真实执行** | MediaProjection 常驻投影 → 打包上传 → 服务端分析 |
| 局数 / 集数预算 | ✅ | ✅ | 🟡 **部分执行** | 服务端 AI 计数 + **设备端本地兜底**（`UsageBudget` 参与 `LockState` 判定）。配置下发已上机验证；**「离线兜底锁屏」只有编译/JVM 级**（构造不出 `used >= limit`，见 §3A） |
| 应用审核 | ✅ | ✅ | 🟡 **部分执行** | 安装器识别 → 上报审批 → `DISALLOW_INSTALL_APPS` + 10 分钟批准窗口。`no_install_apps` 真的生效（孩子侧装不了）、审批链路真的通；但**走的是卸载确认页**，真安装页无法从 adb 构造（§3A） |
| 应用限制（逐应用限时） | ✅ | ✅ | ✅ **真实执行** | `UsageStatsManager` 累计前台时长 → 超限按返回推走。**已修复并上机验证**：家长端从设备清单选应用（必须带 `packageName`）→ 设备拦截规则表真的落进带包名的规则 → 真的拦到了（logcat `看门狗：拦截 com.google.android.deskclock —— Clock 今日 1 分钟已用完`）、家长端「已用 529 秒」不再恒为 0。原先的「三层静默丢弃」见 §4.5 缺陷 1/2 |
| 网址拦截 | ✅ | ✅ | 🟡 **部分执行** | `VpnService` 只接管 DNS：解析命中即回 NXDOMAIN。tun **真的建立**、系统 DNS 真的指向它；但**「某域名真被拦」无法在设备上断言**（隧道存在时所有域名都解析失败，区分不出「被拦」与「隧道不通」），解析逻辑只有 JVM 级证据（§3A） |
| 远程拍照 | ✅ | ✅ | ✅ **真实执行** | Camera2 拍照 → 上传 → 回填 `mediaId` |
| 屏幕截图 | ✅ | ✅ | ✅ **真实执行** | MediaProjection 截一张 → 上传 |
| 连续录像 | ✅ | ✅ | ✅ **真实执行** | MediaProjection 持续录 → 上传 |
| 远程录音 | ✅ | ✅ | ✅ **真实执行** | MediaRecorder 录一段 → 上传 |
| 定位上报 | ✅ | ✅ | ✅ **真实执行** | 首次启动 + 每 5 分钟自动上报，`fetch_location` 也可触发 |
| 安全区 | ✅ | ✅ | ✅ **真实执行** | 设备端 `Geofence` 本地判定进出 → 上报事件（不依赖服务端往返）。已上机验证：真实坐标 → `geofence_enter` → 移走中心 → `geofence_exit` |
| 同屏监控（实时） | — | ✅ 入口 | ⛔ **明确不做** | 没有实时投屏能力，首页入口实为「屏幕洞察」 |
| 远程协助 | ✅ 键 | ✅ 入口 | ✅ **真实执行** | 无障碍静态桥执行预设动作；未连无障碍时**如实失败**。已上机验证：`home` 后前台真的回桌面、`open_app` 后前台真是它 |
| 电话短信 | ✅ 键 | ✅ 入口 | ✅ **真实执行** | `CallLog`/`Sms` 读取 → 上报；未授权时**如实跳过**。已上机验证：造真数据 → 上报 → 服务端 `GET /api/calls|sms` 读到 |
| 环境监听 | ✅ 键 | ✅ 键 | ✅ **真实执行** | `MediaRecorder` 5 分钟分段循环录音上传（1 小时安全阀）。已上机验证：录到 135159 字节 audio/mp4 且可下载。**但首次下发可能丢，见下方 ⚠️** |
| 隐藏图标 | — | ✅ | ✅ **真实执行** | `activity-alias` 切换图标可见性；设置页给出恢复路径。已上机验证：入口真的不可解析、别名 `disabled`、关掉后恢复 |
| 家庭成员 | — | ✅ 占位 | ⚪ **未实现** | 家长端显示为「未开放」灰态 |
| 防杀 / 保活 | — | — | ✅ **真实执行** | 前台服务 + START_STICKY + 三重看门狗 + DO 限制 |
| 防卸载 / 防恢复出厂 | ✅ | ✅ | ✅ **真实执行** | 设备所有者 7 条 `UserManager` 限制 |

> ⚠️ **一个曾经横跨所有指令型功能的缺陷（已修）**：设备端 E2E 发现，
> **任意指令都可能被一条已经断开的旧长轮询连接抢领，然后永久卡在 `dispatched`** ——
> 此时家长端界面显示「已下发」，孩子端却从没收到。详见 §4.5 缺陷 3。
> 它不影响上面各功能**代码本身**的有效性，但会让「家长点了没反应」变成一件**看不出原因**的事。
> **根因**：旧 `waitForDevice` 只把 `finish` 塞进 Set，没有任何人监听 `req`/`res` 的 close 事件
> （服务端其实约 1.5s 内就收到了 `aborted`/`close`），死连接的 resolver 一直挂到自己的定时器到期。
> **修法**：`AbortController` 接线 `close` + 单飞顶替同设备旧等待者 + 兜底重投递
> （`commands.service.ts` 的 `STALE_DISPATCH_SECONDS = 240`、`MAX_REDELIVERIES = 2`）。
> 修复后复现两次均正常（`pending` → `succeeded`，设备只收到 **1** 次指令）；`server:smoke` 158/158。

---

## 2. 逐项原理

### 2.1 锁屏体系（唯一入口 `LockEnforcer`）

**判定与执行分离**，这是整套体系的地基：

```
LockState.compute(Inputs)      ← 纯函数：只回答"此刻该不该锁、为什么"
        ↓
LockEnforcer.apply(...)        ← 唯一落地入口：进入/退出锁定、切换强度
```

`LockState.Inputs` 里的**锁定来源按优先级**（顺序即优先级，写在 `isLockedAt` 里）：

1. **护眼**（强制休息 / 夜间）→ 最高，家长临时解锁也不能绕过
2. **放行期**（临时可用 / 答题奖励 / 手动解锁）→ 直接返回不锁
3. **家长远程锁定**
4. **作息时间表**（`ScheduleEngine` 本地求值）
5. **每日时长耗尽**

**为什么不把判定散在各处**：`LockEnforcer.buildInputs()` 是"服务端状态 → 判定输入"的
**唯一转换点**，服务每秒调一次，锁定页自己也调一次（`LockScreenActivity` 靠它自救：
服务被杀时锁定页仍要能判断该不该解锁，否则孩子会被永久困住）。

**四种强度，按设备实际权限自动降级**：

| 档位 | 触发条件 | 实现 |
| --- | --- | --- |
| `OWNER` | 设备所有者 | `startLockTask()` + `setLockTaskFeatures(0)`，系统级，无绕法 |
| 悬浮窗 | 有 `SYSTEM_ALERT_WINDOW` | `TYPE_APPLICATION_OVERLAY` 全屏窗，挡得住 Home / 最近任务 |
| 锁定页 | 都没有 | `LockScreenActivity` + 无障碍持续拉回 |
| `password` | 家长显式选最高档 | `resetPasswordWithToken` 随机改写系统锁屏密码 |

### 2.2 定时锁屏 / 定时解锁 —— 离线优先的范式

规则**原样下发**（`schedule` 数组），Android 用 `ScheduleEngine` 本地求值。
服务端 `evaluateSchedule` 那份**只用于家长端预览**。

> 两套实现必须一致，否则会出现"家长端显示已解锁、孩子手机却锁着"这种最难查的错位。
> 所以有 `npm run android:crosstest` 逐点比对：**2016 个采样点，零差异**。
> 同样的做法也用在了学习模式求值上（3024 个采样点）。

### 2.3 模式切换（学习模式）

**判据是"这个包是不是可启动的普通应用"**，不是包名黑名单：

```java
if (!isLaunchable(pkg)) return null;   // 系统组件一律放行
if (isHome(pkg)) return null;          // 桌面绝不能被拦
if (ALWAYS_ALLOWED.contains(pkg)) return null;
if (config.studyApps.contains(pkg)) return null;
```

这是**安全的一侧**：一旦把桌面、systemui、输入法拦掉，手机立刻变砖、连紧急电话都打不出去。

拦截动作是 `GLOBAL_ACTION_BACK`（推回上一层），**不是盖遮罩** —— 遮罩会被应用的下一次重绘
盖过去，而且孩子会以为手机坏了。

> ⚠️ 必须声明 `QUERY_ALL_PACKAGES`。Android 11 起有软件包可见性限制，不声明时
> `queryIntentActivities` 只返回极少数包（实测 1 个），于是 `isLaunchable()` 一律为 false ——
> **拦截静默失效，家长设了却完全不起作用且没有任何报错**。

### 2.4 微信 / QQ 功能管控

服务端只下发**被家长改动过**的项，且**连同匹配关键词一起下发** ——
所以设备端不需要内置一份插件目录，也就不存在"服务端加了插件、设备端还不知道"这种静默失效。

设备端用无障碍读当前界面的可见文本与控件描述，命中关键词就按返回推走。
关键词刻意选**页面级**的串（「确认支付」「收付款」而不是「支付」）以压低误伤。

判定抽成了无 Android 依赖的 `GuardRules`，用合成界面文本逐条测试
（`GuardCheck`，16 项）—— 因为模拟器里没装微信，端到端复现不出"朋友圈被打开"。

### 2.5 护眼设置

三件事，三种做法：

| 项 | 做法 |
| --- | --- |
| 连续用眼强制休息 | 屏幕亮着就累计 → 到点写一个"休息截止时刻"到 `LockState.Inputs.eyeLockUntil` → **真锁屏**，休息结束自动解锁 |
| 夜间护眼 | 落在时段内就持续提供锁定原因（家长开了"夜间锁定"才锁） |
| 亮度上限 | `Settings.System.SCREEN_BRIGHTNESS`，需要 `WRITE_SETTINGS`；**拿不到就如实记一条警告，不假装已限** |

用"屏幕亮着"而不是"在用某个应用"来计时：看视频、看小说、刷网页都属于用眼，
而用前台应用计时会漏掉"一直停在同一个应用里"这种最典型的长时间用眼场景。

### 2.6 周期截屏 + AI 洞察

```
ForegroundAppTracker 记录前台包名
   ↓
ScreenSampler 复用常驻 MediaProjection（不重复弹授权框）
   ↓ 长边 ≤480px + JPEG q=45（单张 15–30KB）
FrameBatchArchiver 攒够 N 张打成 zip（stored 模式，JPEG 已压过，再 deflate 是浪费电）
   ↓
FrameBatchUploader POST /api/agent/screen-batches
   ↓
服务端解包落盘 → AI 视觉分析（可插拔 provider）→ 结构化结论
   ↓
抽取异常提醒 / 局数集数 → 超限则下发锁屏指令
```

- **没配 AI key 就不伪造结论**：批次标 `skipped`，或降级为 `provider=heuristic`
  并明确标注「不是 AI」。启发式**判断不了**"结算画面是否出现""这一集是否看完"。
- **锁定期间不采样、也不申请授权**。后者不是多余的：进程重启后投影会丢，
  采样器会去重新拉起 `ProjectionConsentActivity`，而那是**系统弹框**，
  会直接盖在锁定页上 —— 等于帮孩子把锁屏顶掉。

### 2.7 保活与防绕过

| 手段 | 实现 |
| --- | --- |
| 前台服务 | 常驻通知，`START_STICKY` |
| 任务被划掉 | `onTaskRemoved` 立刻重新拉起 |
| 进程被杀 | `AlarmManager` 自续期看门狗（60 秒）+ 持久化 `JobScheduler`（15 分钟） |
| 开机自启 | `BootReceiver`（含 `LOCKED_BOOT_COMPLETED`，解锁前就跑） |
| 防卸载/强停 | 设备所有者 7 条限制：`DISALLOW_APPS_CONTROL` / `UNINSTALL_APPS` / `FACTORY_RESET` / `SAFE_BOOT` / `ADD_USER` / `CONFIG_DATE_TIME` |
| 改系统时间绕过作息 | 同上（`DISALLOW_CONFIG_DATE_TIME`） |
| 锁定复核 | 每 3 秒核实"实际锁住了没"；**亮屏广播**立即把锁定界面重新摆到最前 |
| 无障碍被关 | 看门狗 + DO 限制挡回去 |

实测：`kill -9` 后 **3 秒**恢复。设备所有者应用**杀不掉**（`am force-stop` 无效，PID 不变）。

---

## 3. 原先的「只存不用」缺口 —— 本轮补齐情况

这一节是本文档存在的意义。原先有 9 项功能**家长端看起来是能用的，但孩子手机上不会发生任何事**；
本轮把它们全部补齐，并**逐个上机验证**。下面每项都注明验证到了哪一层 ——
「编译过 + 纯逻辑测过」与「真机跑过」是两件事，而**「真机跑过」也未必等于「端到端能用」**：
逐应用限时就是反例，规则在服务端与设备端被三层静默丢弃，只有设备级端到端才暴露出来（见 §4.5）。

### 3.1 🟡 网址拦截 —— 用 `VpnService` 接管 DNS

**原状**：设备端只把黑名单存进 prefs + 设置页显示 + 打一行日志，拦截为零。

**现在**：[`DnsFilterVpnService.java`](../android/app/src/main/java/com/balloondog/agent/service/DnsFilterVpnService.java)（529 行）
建立 tun 接口，只做一件事：**解析 DNS 查询，命中黑名单就回一个 NXDOMAIN 应答，否则转发给上游 DNS**。

一个**刻意的取舍**：只 `addAddress(10.111.222.1/32)` + `addDnsServer(...)` + `addRoute(10.111.222.1/32)`，
**不加** `addRoute("0.0.0.0", 0)`。因为本实现没有用户态 TCP/UDP 转发，一旦把全部流量路由进 tun，
结果是**既拦不住（非 53 端口的流量没人处理）又直接断网**。只路由 DNS 地址才能既拦域名、又不断网。
代价写在明处：**靠 IP 直连、DoH/DoT、或在应用内自己写死 IP 的请求，拦不到**。

- 匹配规则：`DomainBlocker` 做后缀 + **点边界**匹配，`notexample.com` 不会被 `example.com` 误伤
- 黑名单里写 IP 的条目不参与 DNS 层拦截（DNS 层拿不到 IP 目标）
- **验证**：编译 ✅ / `PureLogicCheck` 19 项（DNS 报文构造、EDNS 的 `ARCOUNT` 清零、事务 ID 保留）✅ / **真机 🟡 只到基础设施层**
  —— 已证屏蔽域名落盘、服务在跑、**tun 真建立**（`tun0` + `DnsAddresses: [/10.111.222.1]`）；
  **「某个域名真被拦」做不出设备级断言**（隧道一存在，`adb shell` 对所有域名一律 `unknown host`，
  区分不出「被拦」与「隧道不通」）。详见 §3A 的 §3.1 行与两条显式跳过。

### 3.2 ✅ 应用限制（逐应用限时）—— `UsageStatsManager` 累计前台时长

**原状**：设备端只记录 + 显示，不按应用计时。

**现在**：`AppUsageTracker` 用 `PACKAGE_USAGE_STATS` 权限按应用累计前台时长，
`AppUsageReporter` 定期上报服务端；判定规则抽在 `GuardRules.matchAppLimit`，**排在学习模式之后**，
拦截动作与学习模式一致（`GLOBAL_ACTION_BACK` 推走，而不是盖遮罩）。

- 服务端契约里 **`limitMinutes === 0` 表示不限**，设备端按同口径处理
- 结构化规则存 `AgentStore.KEY_APP_LIMIT_RULES`（旧的无包名展示串 `KEY_APP_LIMITS` 保留未删，避免升级丢数据）
- **家长端选应用的方式**：`PUT /api/features/app-limit` 现在**必须**带 `packageName`，且该包必须在设备上报的
  清单里、必须 `isLaunchable`。UI 用 `getDeviceApps({ includeSystem: true })` 拉清单
  （**必须含系统应用** —— 时钟、浏览器这些恰恰是真正会沉迷的），按包名去重合并后供选择。
  这同时解决了旧 UI 的「鸡生蛋」：旧弹窗只列已有额度的应用，没有任何入口建第一条。
- **验证**：编译 ✅ / `PureLogicCheck` 覆盖 3599/3600 秒边界 ✅ / **上机 ✅**（`android:e2e:gaps` 85 通过
  0 失败 2 跳过；设备 prefs 真的落进带包名的规则、logcat 真的有拦截记录、家长端「已用」不再为 0）/
  **家长端 UI ✅**（`e2e:parent` 第 5b 节：真实点开弹窗 → 选应用 → 保存 → 回接口核对落库的 `packageName`）
- ⚠️ **曾经的缺陷**：修好之前这条链路 100% 失效（规则被三层静默丢弃），详见 §4.5 缺陷 1/2

### 3.3 🟡 应用审核 —— `DISALLOW_INSTALL_APPS` + 批准窗口

**原状**：Android 端搜 `appAudit` / `AppInstall` 零命中。

**现在**：`OwnerHardening.syncInstallRestriction` 用设备所有者权限设 `DISALLOW_INSTALL_APPS`
（非设备所有者时只记 `warn`，不假装成功）；`AccessibilityGuard` 识别安装器界面 →
后台线程上报 `POST /api/agent/audit-requests`（**幂等**，重复上报返回同一 id）→ 提示「已请求家长批准」。

- 批准结果**不由设备端轮询**，而是随下一次 `/api/agent/config` 的 `installApprovalUntil` 带下来
  （少一条常驻轮询链路）。服务端在 `agent.controller.ts:254` 已用**服务端时钟**把过期项置 null
- `AgentStore.isInstallWindowOpen()` **只判断 `> 0`，不拿本机时钟比大小** ——
  否则孩子把系统时间往回调就能无限延长批准窗口
- **子代理自查出的真 bug**（已修）：上报原先写在 `onAccessibilityEvent` 里**同步发网络请求**，
  真机上必然抛 `NetworkOnMainThreadException`，又被 catch 成「联系不上家长端」，
  表现是**家长永远收不到安装申请**。已改为后台线程上报 + 主线程 `Handler` 回显。
- **验证**：编译 ✅ / **真机 🟡 6/6，但走的是卸载确认页**。已证：`no_install_apps` 真的生效（孩子侧装不了）、
  审批链路真的通（`pendingApps` 非空 + pref 落盘 + 日志）。
  ⚠️ **真安装窗口无法从 adb 构造**：安装器只声明 `content` scheme 的 filter，`file://` 解析不到，
  `content://` 被 URI 权限挡住（`SecurityException: UID 10065 does not have permission to
  content://com.android.externalstorage.documents/...`）。卸载确认页走同一条 `INSTALLER_PACKAGES` 判定路径，
  所以**判定逻辑**被覆盖了，但「真实安装流程被拦」这一步**没有设备级证据**。

### 3.4 🟡 局数 / 集数预算 —— 补上设备端本地兜底

**原状**：服务端 AI 分析出「又打完一局」→ 累加 → 超限 → 下发 `lock`。**这条是真的**。
但设备端只 `setGameRoundsBudget(...)` 存下来 + 主页展示，`LockState.Inputs` 里没有对应项，
所以**离线时孩子可以一直玩到服务端重新连上为止**。

**现在**：设备端把预算计入 `LockState` 判定，离线也照样受限。

> 先前那句失实注释「设备端拿到的是权威计数，用于离线兜底锁屏与界面展示」已改写为如实表述
> （`server/src/features/devices/agent.controller.ts:284`）。

### 3.5 ✅ 环境监听（`audioRecord`）—— 从死键接上

**原状**：`FEATURE_DEFS` 里有 `audioRecord`，但全仓库除定义外**无任何引用**，是死键。

**现在**：`AmbientRecorder` 用 `MediaRecorder` 按 **5 分钟分段**循环录音并上传，
带 **1 小时安全阀**（防止无限录音把电量/存储吃光）、有可见通知、**不自恢复**
（进程被杀后不会自己爬起来继续录 —— 这是有意的，环境监听不该比保活服务更顽强）。

`CommandExecutor.java:463` 现在真读 `store.isFeatureEnabled("audioRecord")`。

> 注意区分：家长端首页叫「远程录音」的磁贴走的是 `remoteRecord` → `start_audio` 指令，
> **那条一直是真实实现的**（录一段就停）。`audioRecord` 是「持续采集」的另一个键，本轮才接上。

### 3.6 ✅ 远程协助 / 电话短信

**原状**：两个功能键存在、家长端有开关，Android 端零代码。

**现在**：
- **远程协助**：`LockWatchdogService` 暴露静态桥，`remote_action` 指令驱动。**无障碍服务没连上时如实失败**，不返回假成功。
- **电话短信**：`CallLogReader` / `SmsReader` / `CallsSmsUploader` + `sync_calls_sms` 指令 + **6 小时周期**上报；
  `READ_SMS` / `READ_CALL_LOG` 未授权时**如实跳过**，不报空数组充数
  （服务端四个上报接口对空数组一律 422，所以「本次 0 条」直接跳过上报）。
- 家长端 `commandApi.syncCallsSms`（`src/services/api.ts:444`）返回 `CommandDispatchResult`，
  把真实队列结果（`noop`/`warning`/`error`）暴露给界面，**不伪造成功**。
- **验证**：编译 ✅ / **真机 ✅ 9/9**（`content insert` 造真通话记录 + `adb emu sms send` 造真短信 → 上报 → `GET /api/calls|sms` 读到）。
  ⚠️ `READ_SMS`/`READ_CALL_LOG` 是应用商店严格管控的权限，真机上还有一道运行时授权要过 ——
  本轮已补 `PermissionGranter` 让设备所有者静默自授（见 §4.2），但**该授权路径本身仍未经上机验证**。

### 3.7 ✅ 安全区 —— 判定搬到设备端

**原状**：只有服务端 `haversineMeters`（`server/src/features/locations/locations.service.ts:15`）算距离，
设备端无围栏；离线时安全区形同虚设，提醒也依赖位置上报周期、不实时。

**现在**：设备端 `Geofence` + `model/SafeZone` 本地判定**进入 / 离开 / 换区**三种事件，
自动位置上报与 `fetch_location` 两条路径都会判定，判定后上报 `/api/agent/events`。

- 服务端仍保留自己那份 haversine（用于家长端地图展示），但**判定权在设备端**
- 契约里给 `SafeZone` 补了 `enabled` 字段，`agent.controller.ts:242` 带 `where: { enabled: true }` 只下发启用的
- **家长端启停开关（本轮补齐）**：原先 `src/types/index.ts` 的 `SafeZone` 没有 `enabled`、`src/pages/LocationPage.tsx` 零命中 —— 服务端支持过滤，界面却做不到「停用某条围栏」。现已在每行加 `ToggleSwitch`（`aria-label` = 停用/启用 + 名字），停用态整行降透明度并显示「已停用」，**停用后仍留在列表里**（否则家长再也没法启回来）
- **绕过启停开关的一个悬挂状态（本轮修掉）**：`AgentService.evaluateGeofence` 原来第一句是 `if (zones.isEmpty()) return;`。孩子在围栏内时 `lastSafeZoneId` 已写上；家长一停用，服务端不再下发它，列表变空直接早退 ⇒ `lastSafeZoneId` **永远停在一条已不存在的围栏上**。后果是家长日后重新启用时，孩子其实早已离开，却会在那一刻补发一条假的「离开 X」。现在在早退之前先做一次失效检查并**只清状态、不发事件**（孩子没有离开，是家长关掉了围栏，报「离开」是陈述一件没发生过的事）
- **验证**：编译 ✅ / `PureLogicCheck` 覆盖 haversine 与边界 ✅ / **真机 ✅ 7/7**（设备真实上报坐标 → 建区后本地判定「在区内」发 `geofence_enter` → 移走中心 → 判区外发 `geofence_exit` → pref `lastSafeZoneId` 同步清空）+ **真机 ✅ 新增 2 条**（搬回来重新进入 → 停用该围栏 → 断言 pref 已清空**且** `geofence_exit` 条数没变，即没有编造事件）。注意：这是靠**服务端改坐标 / 改开关**造出的进出，不是人真的走出去
- 家长端启停 UI 另有 `scripts/browser-e2e.mjs` 第 5c 节 **9 条浏览器断言**（真实点开关 → 回接口核对 `enabled=false` → 界面出现「已停用」→ 再点回 `true` → 断言停用后仍列在家长端）

### 3.8 ✅ 隐藏图标

**原状**：家长端灰色「未开放」。

**现在**：`activity-alias` + `IconHider` 切换启动器图标可见性（`DONT_KILL_APP`），
设置页给出**恢复方式**（防止家长自己也找不到入口）。debug merged manifest 已确认
`com.balloondog.agent.MainActivityLauncher` 存在。

### 3.9 ⛔ 同屏监控（实时投屏）—— 仍然明确不做

- 首页「同屏监控」磁贴实际跳 `/insights`（**屏幕洞察**），不是实时画面。
- 真正的实时同屏需要常驻投屏 + 持续推流，本项目**没有**做，也不打算做。
- `src/pages/HomePage.tsx:112` 已加注释说明命名问题。

### 3.10 ⚪ 仍然没实现的

| 项 | 状态 | 说明 |
| --- | --- | --- |
| 家庭成员 | ⚪ 未实现 | 家长端灰色「未开放」，界面诚实 |
| 同屏监控 | ⛔ 明确不做 | 见 §3.9 |
| 实时投屏 / 推流 | ⛔ 明确不做 | 同上 |

---

## 3A. 本轮补的 9 项：验证等级一览（诚实边界）

**这一节是全文最该被认真读的部分。** 最初版本里这 9 项只有「编译 + JVM 纯逻辑」，没有任何设备级证据；
后来真的把模拟器跑起来（见 §4.4 的环境攻坚），才拿到下面这张表。

**新增的设备端套件**：`android/scripts/e2e-gaps.mjs`（1644 行，`npm run android:e2e:gaps`），
在 emulator-5554（Android 13 arm64、**已设设备所有者**、后端 4000）上跑。
最近一次完整运行：**85 项通过 / 0 项失败 / 2 项显式跳过**（exit 0）。
最初那一轮是 **77 通过 / 3 失败**，**3 条失败全部是真实产品缺陷**（见 §4.5），修完后全部转绿。
2 条跳过是原有的设备级不可断言项（DNS 层拦截、局数预算离线锁），**没有被算成通过**。

| 项 | 编译进 APK | JVM 纯逻辑 | 端到端（真机/模拟器） | 设备级证据 / 没验证到的部分 |
| --- | --- | --- | --- | --- |
| §3.8 隐藏图标 | ✅ | — | **✅ 8/8** | 隐藏前桌面入口能被 `cmd package resolve-activity` 解析 → 下发开关 → 入口不可解析 + `dumpsys` 里启动别名 `disabled` + 日志「桌面图标已隐藏」→ 关掉后全部恢复 |
| §3.7 安全区 | ✅ | ✅ 边界 | **✅ 7/7** | 设备**真实上报坐标** `39.9087,116.3974983333333` → 建区后设备本地判定「在区内」并发 `geofence_enter`（家长端 `device-events` 可读）→ 移走中心 → 判区外发 `geofence_exit` → pref `lastSafeZoneId` 同步清空 |
| §3.6 电话短信 | ✅ | — | **✅ 9/9** | `content insert` 造真通话记录 + `adb emu sms send` 造真短信 → `sync-calls-sms` succeeded → 设备如实回报「通话记录：6 条；短信：5 条」→ `GET /api/calls` 读到 `13800138999`/type=incoming/30s、`GET /api/sms` 读到 body 含 `E2E_SMS_PROBE_9527` |
| §3.5 环境监听 | ✅ | — | **✅ 7/7**（首次下发除外，见 §4.5 缺陷 3） | 启动 succeeded + `chunkSeconds=300` + 日志「环境监听已开始」→ 停 9 秒后停止 succeeded → `GET /api/media?kind=audio` 出现新音频且**真能下载**（135159 字节 audio/mp4） |
| §3.6 远程协助 | ✅ | — | **✅ 8/8** | 前置断言「前台不是桌面」→ `home` succeeded → 前台**真的**回到 launcher → `open_app com.android.settings` succeeded → 前台真的是它 → 关开关后服务端 HTTP 400 拒绝 |
| §3.3 应用审核 | ✅ | — | **🟡 6/6，但走的是卸载确认页** | 开审核 → 设备所有者施加 `no_install_apps`（`dumpsys user` 可查，孩子侧**真的装不了**）→ 拉起 `UninstallerActivity` → `GET /api/features` 的 `appAudit.pendingApps` 非空 + pref `install_audit_last_at` 落盘 + 日志「安装审核申请已提交」。**真安装窗口无法从 adb 构造**：安装器只声明 `content` scheme 的 filter，`file://` 解析不到，`content://` 被 URI 权限挡住（`SecurityException: UID 10065 does not have permission to content://com.android.externalstorage.documents/...`）。卸载确认页走同一条 `INSTALLER_PACKAGES` 判定路径，所以**判定逻辑**被覆盖了，但「真实安装流程被拦」这一步**没有设备级证据** |
| §3.2 应用限制 | ✅ | ✅ 边界 | **✅ 修复后全绿 + 家长端 UI 已点过** | 设备端：家长端真实路径建规则 → pref `app_limit_rules` 落进**带正确包名**的规则 → 时钟累计 530s ≥ 60s → logcat `看门狗：拦截 com.google.android.deskclock —— Clock 今日 1 分钟已用完`，8 次采样前台从未停在时钟；家长端 `usedTodaySeconds` 从恒为 0 变成 **529**。家长端：`e2e:parent` 第 5b 节真实点开弹窗 → 选 Clock → 填 7 → 保存 → 回接口核对 `packageName === com.google.android.deskclock`。原先的「家长端链路 100% 失效」见 §4.5 缺陷 1/2 |
| §3.1 网址拦截 | ✅ | ✅ 19 项 | **🟡 只到基础设施层** | 已证：屏蔽域名落盘、服务在跑、日志「网址拦截已启动：上游 DNS fec0::3,10.0.2.3,223.5.5.5,119.29.29.29,8.8.8.8」、**tun 真建立**（`dumpsys connectivity` 里 `InterfaceName: tun0` + `DnsAddresses: [ /10.111.222.1 ]`）。**「某个域名真被拦」做不出设备级断言**：隧道一存在，`adb shell` 对**所有**域名（含未屏蔽的 bing.com/wikipedia.org）一律 `unknown host`，无法区分「被拦」和「隧道不通」，且期间 logcat 里没有任何「已拦截 <域名>」——shell 的查询压根没走到拦截器。DNS 解析逻辑只有 JVM 级证据（`PureLogicCheck` 覆盖 `DnsMessage`/`DomainBlocker`） |
| §3.4 局数预算 | ✅ | — | **🟡 只到一半** | 已证：家长端 API 建预算 HTTP 200 → pref `game_rounds_limit=3`/`game_rounds_enabled=true` → 权威计数 `used=0/3` → 未达上限时 `mLockTaskModeState=NONE`。**「离线兜底锁屏」只有编译/JVM 级**（`LockEnforcer.java:103` 的 `budgetLockReason` → `LockState.Reason.BUDGET`）：`used` 只能由服务端 AI 推算（`insights.service.ts:827`），家长 API（`upsertBudgetSchema`）只收 `dailyLimit`（最小 1），构造不出 `used >= limit` |
| §3.9 同屏监控 | — | — | — | 明确不做 |

**两条显式跳过（不是通过，也不是失败）** —— 套件里的 `⏭` 是刻意设计的，文件注释写着：
「把没跑过的断言写成通过，比没有测试更糟 —— 后面的人会以为这条链路上已经有设备级证据了」：
1. **DNS 层拦截对「被拦域名 vs 放行域名」的实际效果** —— 原因见上表 §3.1 行；
2. **局数预算的「离线兜底锁屏」** —— 原因见上表 §3.4 行。

**APK 本身是真的**：`npm run android:build` → BUILD SUCCESSFUL，
产物 [app-debug.apk](../android/app/build/outputs/apk/debug/app-debug.apk) = **7,251,147 字节**（含本轮权限修复）；
合并后的 debug 清单里 `PACKAGE_USAGE_STATS`、`READ_CALL_LOG`、`READ_SMS`、`BIND_VPN_SERVICE`、
`DnsFilterVpnService`、`MainActivityLauncher` **都在**（声明了权限 ≠ 拿到了权限）。

> ⚠️ **查合并清单要用显式路径** `android/app/build/intermediates/merged_manifest/debug/processDebugMainManifest/AndroidManifest.xml`。
> 用 `find android/app/build/intermediates/merged_manifest -name AndroidManifest.xml | head -1` 会拿到 **release** 那一份，
> 上面这些权限全是 0 —— 这个陷阱本轮踩了两次。

**交叉测试是真的**：`bash android/scripts/crosstest/run.sh` → 真实 EXIT=0
（作息 2016 点零差异、学习模式 3024 点 / 9 组配置零差异、`GuardCheck` 16 项、
新增 `PureLogicCheck` 63 项全通过）。EXIT=0 有意义，因为
`PureLogicCheck.java:49` 与 `GuardCheck.java:95` 都是 `System.exit(failed > 0 ? 1 : 0)`，
`compare.mjs:67` / `compare-mode.mjs:14,48` 都是 `process.exit(1)`，`run.sh` 用 `set -euo pipefail`。

> ⚠️ **这条曾经被打破过一次，值得记下来**：本轮给 `AppLimitRule.java` 加「丢弃限额规则时打日志」的
> `android.util.Log` 调用后，交叉测试**编译失败**（`程序包android.util不存在`，EXIT=1）——
> 因为 `run.sh` 第 5、6 步会刻意把 `AppLimitRule.java` 拉进 JVM 编译（`GuardRules` 引用它）。
> 修法是加一个 `android/scripts/crosstest/stubs/android/util/Log.java` 桩。
> **它不同于 `org/json` 那两个桩**：那两个必须抛异常，因为它们的**返回值会被业务逻辑消费**；
> 而 `Log` 的方法全部返回 `void`、没有任何逻辑读它，所以空实现掩盖不了差异，抛异常反而会误伤
> （「丢弃一条规则」这条路径在交叉验证里是会被正常走到的）。
> **教训**：给被测代码加一句日志，也可能把交叉测试打挂 —— 改完要真的重跑，不能凭上一轮的记忆。

---

## 4. 代码与文档不一致 / 遗留问题

### 4.1 已修（盘点后当场改掉）

| 位置 | 问题 | 现在的状态 |
| --- | --- | --- |
| `server/src/features/devices/agent.controller.ts:284` | 注释称局数/集数预算"设备端离线兜底锁屏"，实际没有 | ✅ 注释已改写，如实承认原先没有兜底；§3.4 现已真的补上兜底 |
| `src/pages/HomePage.tsx:112` | 「同屏监控」磁贴跳到屏幕洞察页，名不副实 | ✅ 已加注释说明不是实时画面，不再叫同屏监控 |
| `android/.../capability/CommandExecutor.java:463` | `audioRecord` 是死键 | ✅ 现已真读 `store.isFeatureEnabled("audioRecord")`，不再死 |

### 4.2 本轮新发现（逐条标状态：已修 / 未修）

| 位置 | 问题 | 影响 |
| --- | --- | --- |
| **已修：Android 运行时权限（本轮最重要的新发现）** | **App 从不申请运行时权限。** 全仓库 `grep -rn "requestPermissions\|setPermissionGrantState" android/app/src/main/java` **零命中**。`READ_CALL_LOG` / `READ_SMS` 只在 `CallLogReader.java:38`、`SmsReader.java:36` 被 `checkSelfPermission` **读取状态**，`MainActivity.java:489-495` 也只是**显示**状态；`SettingsActivity.java:81-88` 会把通话记录/短信写成「未授权（上报时会跳过并记日志）」，**却不给任何授权按钮**（设置页只有 `buttonUsageAccess` 与 `buttonVpn` 两个授权入口）。 | **三个 E2E 脚本都用 `adb install -r -g` 装包**（`e2e-agent.mjs:521`、`e2e-mode.mjs:174`、`e2e-screen-sampler.mjs:212`），`-g` 一次性授予全部运行时权限；`android/README.md:566-569` 给用户的安装命令**也带 `-g`**，并自述「省去逐个点弹框」——**这正好掩盖了缺陷**。孩子/家长按普通方式点 APK 安装时，`ACCESS_FINE_LOCATION`、`CAMERA`、`RECORD_AUDIO`、`READ_CALL_LOG`、`READ_SMS`、`POST_NOTIFICATIONS` **全部为拒绝**，于是定位上报、远程拍照、远程录音、通话与短信上报**静默失效**。测试之所以全绿，只是因为 `-g`。**修法**：新增 `capability/PermissionGranter`，设备所有者时用 `DevicePolicyManager.setPermissionGrantState(..., PERMISSION_GRANT_STATE_GRANTED)` 静默自授，非设备所有者时回退到 `ActivityCompat.requestPermissions`；设置页加「一键授权」并把每个权限的实际状态列出来。**已实现并编译通过**（APK 7,251,147 字节）：`PermissionGranter.grantAsDeviceOwner()` 挂在 `LockEnforcer` 的 `isHardeningEnabled()` 分支与 `MainActivity.selfCheckAndHeal()` 两处，**每次锁定与自检都会重授** —— 否则孩子只要去系统设置里关掉定位，安全区就彻底失灵。`android/README.md` §3.3 同时改掉：安装命令去掉 `-g`（并注明「开发时可用 `-g`，但**不要用它判断功能是否真能用**」）、把「申请采集权限」纠正为只授予**屏幕采集（MediaProjection）**。⚠️ **仍未上机验证**：没有跑「不带 `-g` 安装 + 设为设备所有者 + 断言权限被静默授予」的用例。 |
| **已修：`SafeZone.enabled` 没有 UI 入口** | **服务端支持 `SafeZone.enabled`**（`locations.dto.ts:20` 接受、`agent.controller.ts:242` 按它过滤下发），但家长端**既没有这个类型字段、也没有任何 UI 能改它**（`grep enabled src/pages/LocationPage.tsx` 零命中）。安全区的增删改 UI 早就有，**唯独「停用某个围栏」没有入口** —— 默认 `true` 所以行为看起来正常，但「能停用围栏」是个假印象 | ✅ **已补齐**：`src/types/index.ts` 的 `SafeZone` 加 `enabled: boolean`；`src/pages/LocationPage.tsx` 每行加 `ToggleSwitch`（带 `aria-label`「停用/启用 <名字>」）、停用态整行 `opacity-50` + 「已停用」Badge，走已有的 `api.updateSafeZone`。服务端 `updateSafeZoneSchema = createSafeZoneSchema.partial()`，所以只发 `{enabled}` 是合法的（`prisma.update({data: patch})` 只动传入字段）。**已由 `e2e:parent` 第 5c 节 9 条断言覆盖**（真实点开关 → 回接口核对 `enabled=false` → 界面显示「已停用」→ 再点回 `true` → 停用后仍列在家长端） |
| 已修：`src/pages/HomePage.tsx` 应用限制弹窗 | 该弹窗的 React 逻辑（候选合并、按包名选中、未选时禁用确认）**曾经没有任何自动化测试** —— 子代理重写完只验到「typecheck + build 通过 + 它调用的服务端契约被 e2e 覆盖」 | ✅ 已在 `scripts/browser-e2e.mjs` 家长端套件新增第 5b 节：挑一台真有应用清单的设备 → 真实点开弹窗 → 断言候选都带合法包名 → 断言未选时「确认」disabled → 选应用 → 断言输入框才出现 → 填 0 断言被拒且弹窗不关 → 填 7 保存 → **回接口核对落库的 `packageName` 与 UI 选中的包一致** → 收尾删规则并切回设备。家长端套件由 25 项增至 **37 项，全绿**（随后第 5c 节的安全区启停又加了 9 条，现共 **46 项**） |
| 已修：`src/pages/LocationPage.tsx` 的 `SafeZone.enabled` | 同上一行 | ✅ 已补开关 + 9 条浏览器断言（见上一行）。家长端套件由 37 项增至 **46 项，全绿** |
| 已修：`android/scripts/crosstest/run.sh` | 步骤编号本来就不一致（`1/3`、`2/3`、`3/4`、`4/4`、`5/5`），新加的第 6 步也只写了 `6/6` | ✅ 已统一为 `1/6`…`6/6`。只影响日志可读性，不影响断言 |
| `android/.../data/AgentStore.java` | `KEY_APP_LIMITS` 是**无包名**的展示串（形如 `抖音=60`），无法支撑逐应用限时判定 | 已新增结构化 `KEY_APP_LIMIT_RULES`；旧键**保留未删**，避免升级丢数据 |
| 已修：`.gitignore` | `android/scripts/crosstest/.work/` 下 **22 个编译产物被 git 跟踪** | ✅ 已加 ignore 规则并 `git rm -r --cached`（**只动索引不删文件**）。现 crosstest 下被跟踪的只剩 12 个源文件 |
| 已修：`android/README.md` §1.1 | 原文写「11 组接口」，漏了 `/agent/apps` 与 `/agent/events` | ✅ 已补齐为 17 组 |

### 4.3 设备端能力的诚实边界（不是 bug，是方案的天花板）

这几条**写进文档而不是藏起来**，因为它们决定了功能的实际强度：

- **学习模式与插件管控靠无障碍**（按界面可见文本匹配），不是系统 API：
  应用改版换文案会漏拦；看不见 WebView 内容与游戏画布；有几百毫秒延迟；关掉无障碍权限即失效。
- **插件关键词匹配没有端到端验证**：模拟器里没装微信/QQ，端到端复现不出来，
  由 `GuardCheck` 的 16 项覆盖判定逻辑。
- **网址拦截只拦 DNS**：靠 IP 直连、DoH/DoT、应用内写死 IP 的请求拦不到（原因见 §3.1）。
- **护眼「距离 / 姿势提醒」没做**：「学习模式专用桌面」没做。
- **应用审核不是系统级审批**：它是「无障碍识别 + 设备所有者限制」的近似。

### 4.4 环境攻坚：模拟器一开始为什么起不来、后来怎么起起来的

**真正的约束**：emulator 启动时要 **7372.8 MB 空闲磁盘**现建数据分区，而这是一个
**与分区大小无关的写死常数**。三条证据：

- `config.ini` 里把 `disk.dataPartition.size` 设成 `3G` 会被**静默钳制回 `6442450944`（6 GiB）**；
- 设成 `10G` 则被保留，此时 need 变成 12288 MB —— 说明 need 是从分区大小**算出来的**，
  但算式的下限锁在 6 GiB 那一档；
- 直接改 emulator 生成的 `hardware-qemu.ini` 成 `3g`，这个值**被保留**了，
  可 need **仍然是 7372.800000 MB**。

原始报错逐字：

```
Not enough space to create userdata partition.
Available: 5782.101562 MB at .../balloon_test.avd, need 7372.800000 MB.
```

试过并全部失败的绕行（连同失败原因）：

| 路子 | 结果 |
| --- | --- |
| 改 `config.ini` 的 `disk.dataPartition.size` | 被静默钳制回 6 GiB |
| 改 `hardware-qemu.ini` | 值被保留，但 need 不变 |
| `-data <稀疏 raw 文件>` | `Could not open backing file: Image is not in qcow2 format` |
| `-data <空 qcow2>` | 越过空间检查，但没有文件系统，guest 起不来 |
| `qemu-img create -f qcow2 -b <SYS>/userdata.img -F raw` | **boot loop**（`init second stage started` 出现 24 次） |
| 预建 6 GiB 稀疏 raw + `dd` 写模板 | 卡死：11 分钟只占 4.9% CPU，`userdata-qemu.img` 只写了 1.0M |
| APFS / HFS+ 稀疏磁盘映像 | `df` 报的是**容器**可用空间（5.6Gi / 5.5Gi），没用 |
| `-partition-size` | 只管 system 分区，不改 data 需求 |
| 删 APFS 快照 | `Failed to delete all Time Machine local snapshots`（需 root） |

**解套**：清掉 `~/Library/Caches/ms-playwright`（2.1 GB）后可用空间到 **24 GiB**，模拟器正常启动。
清之前已核实本项目**确实用不到**它：`scripts/browser-e2e.mjs:32-33` 用的是系统 Chrome
（`/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`），三个 `package.json` 都不依赖 playwright。

**起模拟器的正确姿势**（env 必须齐，否则读不到 AVD）：

```bash
export ANDROID_HOME="$HOME/Library/Android/sdk"
export ANDROID_AVD_HOME="$PWD/android/.android-home/avd"
export ANDROID_USER_HOME="$PWD/android/.android-home"
"$ANDROID_HOME/emulator/emulator" -avd balloon_test \
  -no-window -no-audio -no-boot-anim -no-snapshot -gpu swiftshader_indirect
```

若之前手工造过残留镜像（`userdata-qemu.img*`、`cache.img*`、`encryptionkey.img*`、
`hardware-qemu.ini*`）必须先删掉，并把 `config.ini` 的 `disk.dataPartition.size` 设回 `6G`，
让 emulator 走正常流程。

**顺带踩到的坑**：macOS **没有 `timeout` 命令**（`bash: line 8: timeout: command not found`）。
我因此在某次探测中得出过错误结论（以为 `3G` 被接受了，其实是那次模拟器压根没起来）。

另一个环境陷阱：**端口 5173 上跑的不是本项目**，而是 `/Users/tianmiao/workspaces/kesi/projects/smart-caigou`
的 Vite（只绑 `[::1]:5173`，且对本项目 `/api/*` 返回 `index.html`）。
第一次跑响应式套件时测的其实是别人家的 SPA，所有断言失败都是假的。本项目前端改用 **5180**。

### 4.5 设备端 E2E 跑出来的 3 个真实产品缺陷 —— **三个都已修复**

`android/scripts/e2e-gaps.mjs` 那一轮 **77 通过 / 3 失败**，3 条失败**全都是真缺陷**，没有一条是脚本自己的问题。
这 3 条覆盖了 `docs/PLAN-agent-gaps.md` 里 §4 与「指令投递」两条主线。

> **修复后的最终状态**：`android:e2e:gaps` → **85 通过 / 0 失败 / 2 跳过**（2 条跳过是原有的设备级不可断言项：
> DNS 层拦截、局数预算离线锁）。下面每个缺陷都补了「修法 + 修后证据」。
>
> 三个缺陷的**共同教训**：它们没有一个是靠读代码发现的，全都是「把断言写到真的会失败的地方」才暴露出来的。
> 尤其缺陷 1 —— 服务端返回 `{"success":true}`、数据库里有一行记录、类型检查与构建全绿，
> **每一层看起来都正常，合起来却 100% 无效**。

#### 缺陷 1（最严重）：「逐应用限时」家长端链路 100% 失效

**现象**：家长端给「抖音」设 60 分钟，孩子端永远不拦；家长端「已用 X 分钟」永远显示 0。

**根因链**（三层各自独立地把规则吃掉）：

| # | 位置 | 做了什么 |
| --- | --- | --- |
| ① | `src/services/api.ts`（`updateAppLimit` 附近，约 `:476`） | 家长端只发 `{appName, limit}`，**不带 `packageName`** |
| ② | `server/src/features/devices/devices.controller.ts:253-260` | 只读 `appName`/`limit`，**丢弃 `packageName`** |
| ③ | `server/src/features/devices/devices.repository.ts:117-137` | 建行时 `packageName: data.packageName ?? ''` ⇒ 库里存的是**空包名** |
| ④ | `android/.../model/AppLimitRule.java:39-49` | `parseAll` 里 `if (pkg.isEmpty() \|\| minutes <= 0) continue;` ⇒ **家长端设的规则 100% 被丢** |
| ⑤ | `android/.../capability/GuardRules.java:113` | `matchAppLimit` 第二道闸门 `if (!isLaunchable) return null;` |

**设备级证据原文**：
```
✗ 家长端设的应用限时真的进了设备的拦截规则表（pref app_limit_rules 含该应用）
   — 实际 app_limit_rules=[]；同刻 app_usage_json={"day":"2026-10-04","usage":{}}
```
规则表为空时 `AppUsageReporter.refresh` 会把用量缓存**直接清空**，所以家长端「已用 X 分钟」也永远是 0。

**已证实「拦截引擎本身是好的」**：套件用设备自己的令牌
`POST /api/agent/audit-requests {appName:'时钟',packageName:'com.google.android.deskclock'}` 注入审核申请 →
家长批准 → 拿到**带可启动包名**的 1 分钟规则 → 起时钟累计 527s ≥ 60s →
logcat 里 `看门狗：拦截` **真的出现**且前台被返回键推走。
⇒ 「引擎 / 规则下发 / 用量采样 / 上报 / 家长端可读」这条**后端到设备**的链路是真的，
坏的只是「家长端拿不到、也传不对包名」这一段。

#### 缺陷 2（与缺陷 1 同源）：批准安装审核后建出的限额规则作用在错误的包上

- `android/.../service/LockWatchdogService.java:346` 把**安装器自己的包名**（`com.google.android.packageinstaller`）当 `packageName` 上报；
- `server/src/features/devices/devices.service.ts:354` 拿它建 `AppLimit`；
- `cmd package resolve-activity --brief -a MAIN -c LAUNCHER com.google.android.packageinstaller` → `No activity found`
  ⇒ `AppInventory.isLaunchable=false` ⇒ 叠加缺陷 1 的第 ⑤ 步，这条规则**永不触发**。
- 家长端 UI 注释 `src/pages/HomePage.tsx:1291-1293` 写「**孩子在设备上安装应用后会自动出现在这里**」——
  设计上就依赖这条坏掉的路。
- **可用件**：孩子端已有 `capability/AppInventory.java`，通过 `POST /api/agent/apps` 上报到服务端 `DeviceApp` 表
  （含 **packageName / 应用名 / 是否可启动**），家长端有 `GET /api/device-apps`（还有 `/refresh`）。
  **这才是家长端拿到真实包名的正道。**

#### 缺陷 3：指令被「已断开的长轮询连接」抢领后永久卡在 `dispatched`

**现象**：杀掉 Agent 进程后**立刻**下发任意指令，家长端一直显示「已下发」，孩子端毫无反应；
`GET /api/device/commands` 里该指令**永远** `status=dispatched`，设备 logcat 里没有「收到指令」。

**根因**：
1. `server/src/features/devices/devices.notifier.ts` 的 `notifyDevice(deviceId)`
   **一次唤醒该设备的全部等待者**（`for (const resolve of set) { resolve() }`）再 `waiters.delete(deviceId)`；
   被 `kill -9` 掉的旧进程那次长轮询的 resolver 仍挂在 set 里 —— **服务端不感知客户端已断开** ——
   于是新旧两个等待者被同时唤醒、同时去 `claimNext`。
2. `server/src/features/devices/commands.service.ts:126-146` 的 `claimNext` 用 `updateMany(...status:'dispatched')` 做 CAS 抢占。
   **抢到的是那条已经死掉的连接时，响应写进了空气，指令再也不会被投递。**
3. 没有任何重投递：`claimNext` 只匹配 `status:'pending'`（约 `:129`/`:135`），
   全仓库唯一碰 `dispatched` 的地方是 `:199` 的过期清理 —— 只能干等它过期。

**复现步骤**：
1. 确保 Agent 在跑并处于长轮询；
2. `adb -s emulator-5554 shell "kill -9 $(pidof com.balloondog.agent)"`
   （设为设备所有者后 `am force-stop` 对它无效，必须 `kill -9`）；
3. 等新进程起来；
4. `POST /api/device/start-ambient?deviceId=<id>`；
5. `GET /api/device/commands?deviceId=<id>&limit=10` 看它永远 `dispatched`，`logcat -s BalloonDog` 里没有「收到指令」。

**影响面比前两条大**：它不是「某个功能没实现」，而是**任意指令都可能丢**，
并且家长端会一直显示「已下发」——**这是 UI 在撒谎**，用户没有任何办法知道指令其实没送到。

---

## 5. 这些结论是怎么得出的

不是靠回忆，而是逐个查了引用关系：

```bash
# 1. 指令层：服务端定义 vs Android 的 switch
grep "COMMAND_TYPES = \[" -A 20 server/src/features/devices/devices.constants.ts
grep "case Constants.CMD_" android/.../capability/CommandExecutor.java
#   → 现在 18 种指令，Android 全部有 case（含本轮新增 sync_calls_sms）

# 2. 配置层：每个存储项的设备端读取方（沿 getter 调用点追）
grep -rl "\.isTimePlanEnabled()" --include=*.java android/
#   → 只被 ui/SettingsActivity 读 = 仅展示；被 capability/service 读 = 真实执行

# 3. 功能键层：全仓库引用
grep -rn "audioRecord\|remoteHelp\|callSms" --include=*.ts --include=*.tsx --include=*.java .
#   → 除定义外零引用 = 死键 / 未实现（本轮已全部接上）
```

**判据**：一个配置项如果只被 `ui/` 下的界面类读取，说明它只用于**显示**；
只有被 `capability/` 或 `service/` 下的类读取，才可能在**真正执行**。

> ⚠️ 这条判据的必要性也说明了一件事：**"配置成功下发并落盘"不等于"功能生效"**。

### 已有的验证覆盖

| 套件 | 覆盖 | 状态 |
| --- | --- | --- |
| `android:e2e`（83 项） | 协议闭环、锁定、Kiosk、倒计时、最高强度档、保活、重启安全阀 | 上机跑过 |
| `android:e2e:mode`（23 项） | **学习模式真的拦住应用**、护眼/插件配置下发落盘 | 上机跑过 |
| `android:e2e:screen`（21 项） | 截屏采集→上传→AI 分析→锁定复核 | 上机跑过 |
| `android:crosstest` | 作息 2016 点、模式 3024 点、`GuardCheck` 16 项、**`PureLogicCheck` 63 项** | 本轮 EXIT=0 |
| `server:smoke`（158 项） | 服务端全接口 | 本轮 158/158 |
| `server:e2e:mode`（64 项） | 模式/护眼/插件/事件/越权 | 上机跑过 |
| `server:e2e:insights` + `:ai`（各 28 项） | 屏幕洞察与 AI 全链路 | 上机跑过 |
| `e2e:parent` / `e2e:admin`（25 + 30 项） | 家长端与管理后台 | 本轮全绿 |
| `e2e:responsive`（5 视口 × **16 页**，各 79 项） | 响应式布局 | 本轮全绿 |

**教训**：§3.1 / §3.2 这类"仅存储"的功能，**端到端测试抓不到** ——
因为断言的是"配置能下发、能落盘"，那确实通过了。
要抓住它们，必须断言"设备端产生了拦截动作"，而这类断言目前只覆盖了
学习模式与插件管控（因为那两个功能真的实现了）。

**本轮的同类教训**：新补的 9 项同样**只有编译与纯逻辑测试**，没有一条端到端断言 ——
所以 `§3A` 那张表必须留着。**没有它，这份文档就会从"如实盘点"退化成"报菜名"。**
