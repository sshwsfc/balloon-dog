# 分析报告：孩子端能不能做 iOS 版，能做哪些功能

> 结论（一句话）：**能做一个 iOS 孩子端，但它不是 Android 孩子端的移植，而是另一个产品。**
> Android 那 17 个功能键里，iOS 原生能对齐 2 个、降级可实现 5 个、完全做不到 10 个；
> 18 条指令里 4 条原样可用、3 条语义降级、11 条不可用。
> iOS 上的主战场是**「应用/网站限制 + 时间表 + 使用时长 + 位置围栏 + 答题与任务 + 知情透明」**，
> 而不是「截图、看聊天、远程拍照、远程锁屏、远程控制」。
> 建议按 **App Store + Screen Time API（FamilyControls）** 走主线，把「监督机 + MDM」作为可选增值档，
> 把「不装孩子端、只引导用系统屏幕使用时间」作为过渡降级方案；企业签/越狱/TestFlight 长线一律排除。

- 报告版本：v0.1（调研稿，2026-10-26）
- 分析对象：`server/` 后端 + `src/` 家长端 + `android/` 孩子端（既有的三端契约）
- 证据分级：**【仓】** = 在本仓库代码/文档里核实过；**【平】** = 来自 Apple 平台机制/官方条款/同行实测；**【验】** = 必须在真机上验证后才能对外承诺
- 判定口径：✅ 原生可用 ｜ 🟡 降级可实现（功能名要改、语义要变）｜ 🔬 仅「监督机 + MDM」路径 ｜ ❌ 不可实现

---

## 0. 结论速览

### 0.1 先分清两件事（很容易混）

| 问题 | 答案 | 说明 |
| --- | --- | --- |
| 家长端能不能在 iPhone 上用？ | **已经可以** | 家长端是 Web（React + Vite），Safari 直接打开 `bdog.gtsiot.cn` 就能用，**不需要** iOS 版 |
| 缺的是什么？ | **孩子端的 iOS Agent** | 现在孩子端只有 Android APK（`android/`），iPhone 上的孩子装不了，所以「iPhone 孩子」这个客群根本没有数据 |
| 有没有必要单独做一个家长 iOS 原生 App？ | **可选，优先级低于孩子端** | 收益主要是 APNs 推送与体验；约 6–8 周。不做也不影响孩子端落地 |

本报告讨论的是**孩子端 iOS Agent**。

### 0.2 一句话的能力结论

```
Android：锁屏、时长、应用限时、截图、录屏、录音、远程拍照、通话短信、应用内插件管控
iOS   ：应用/分类/网站限制、时间表、使用时长、位置围栏、SOS、任务、答题解锁
```

iOS 把「**限制**」给了第三方（Screen Time API），把「**监控与取证**」全部收回去了。
这不是「审批没过」，是**能力层没有这个 API**：没有任何合法的 iOS 第三方 App 能截屏、读短信、看聊天、后台开麦。

### 0.3 三条必须先接受的前提（不可绕过）

1. 孩子 iPhone 必须登录一个**儿童 Apple ID**，并加入家庭的「家人共享」，然后在孩子设备上同意屏幕使用时间授权。
2. 家长**不能**远程从自己手机上改孩子手机上的屏蔽规则——规则必须由**孩子那台设备上的 App/扩展**落地；家长端下发的是「意图」，设备端执行的是「事实」。
3. 孩子在手机上**长按删除**了这个 App，所有管控立即消失。iOS 不给第三方「防卸载」API（只有监督机 MDM 有 `allowAppRemoval`）。

如果产品不能接受这三条，iOS 版就不该做——不是技术问题，是平台规则问题。

---

## 1. 项目现状盘点

### 1.1 三端架构

```
家长端 Web (React19/Vite7/Tailwind4, src/)  ──┐
管理后台 /admin (src/admin/)               ──┼─ HTTPS ─> server/ (Express5 + Prisma + PG16, :4000)
孩子端 Android APK (android/, Java)        ──┘              │
                                                            ├─ 设备侧 18 组 /api/agent/* 接口
                                                            └─ 家长侧 /api/device/* 指令队列
```

### 1.2 孩子端 Android 的能力底账【仓】

`android/README.md` 记的是「18 组接口 + 18 条指令 + 本地强制执行」。三件事要分开看：

- **接口**：`register / heartbeat / config / commands/next / commands/:id/result / locations / media / quiz / screen-batches / screen-quiz / health / apps / events / audit-requests / app-usage / calls / sms / child-home / sos / tasks/:taskId`
- **指令**（`server/src/features/devices/devices.constants.ts` 的 `COMMAND_TYPES`，共 18 条）：
  `lock` `unlock` `temp_unlock` `cancel_temp_unlock` `remote_photo` `screenshot` `start_recording` `stop_recording` `start_audio` `stop_audio` `fetch_location` `sync_config` `sync_apps` `start_ambient` `stop_ambient` `remote_action` `sync_calls_sms` `self_check`
- **功能键**（`FEATURE_DEFS`，共 17 个）：
  基础 —— `lockScreen` `tempUnlock` `timePlan` `appLimit` `appAudit` `webBlock` `modeSwitch` `eyeCare` `appPlugin`
  高级 —— `quizUnlock` `screenMonitor` `remoteHelp` `callSms` `remotePhoto` `remoteRecord` `videoRecord` `audioRecord`

### 1.3 关键判断：这些能力全部建立在 7 类 Android 特权上

| Android 特权 | 用来做什么（代码位置） | iOS 上有对应物吗 |
| --- | --- | --- |
| 设备管理器（Device Admin）+ 悬浮窗 | 锁屏遮罩 `LockEnforcer`、`DISALLOW_INSTALL_APPS` 应用审核、防卸载 | ❌ 无（只有监督机 MDM 的 `DeviceLock` / 安装限制） |
| 无障碍服务（AccessibilityService） | `remote_action` 模拟点击、看门狗保活、学习模式插件管控、免授权截图 | ❌ 无（iOS 不开放辅助功能模拟） |
| 使用情况访问（UsageStatsManager） | 逐应用使用时长、`appLimit` 到点屏蔽 | 🟡 Screen Time 阈值事件（15 秒粒度，需扩展上报） |
| MediaProjection / 无障碍截图 | `screenMonitor` 周期截屏 → AI、`screenshot` | ❌ 无 |
| 相机 / 麦克风后台权限 | `remotePhoto`、`remoteRecord`、`videoRecord`、`audioRecord` | ❌ 无（前台且用户可见） |
| `DEFAULT_HOME` + 隐藏图标 + `BOOT_COMPLETED` | 替换桌面、隐藏图标、开机自启、常驻 | ❌ 无（不能替换桌面、不能自启） |
| `VpnService` | DNS 层网址拦截 `DnsFilterVpnService` | 🟡 系统级 Web 过滤（ManagedSettings）；或 Network Extension DNS 代理 |

**这张表就是整份报告的底层逻辑**：功能键是表面，特权才是根。iOS 恰好把这 7 类特权里的 5 类整类收走，
只留下「使用时长」和「网络过滤」两条残脉，再额外给了「应用/分类屏蔽」这一个全新能力。

### 1.4 服务端现在怎么理解「锁」【仓】

一个很值得沿用的设计：服务端区分 `locked`（家长期望）与 `effectiveLocked`（设备实际），
`lockReason` 说明为什么，`tempUnlockUntil` 说明临时放开到几点；`/agent/config` 把
`lockPolicy`（`strength / countdownSeconds / scheduleEnabled / schedule[]`）、`timePlan`、`appLimits`、
`safeZones` 原样下发，**由设备端本地求值**，断网也能锁。

这套「**规则下发 + 本地求值 + 事后对账**」的骨架在 iOS 上完全成立，而且比 Android 更必要——
iOS 的扩展进程随时可能不被调度，规则必须能在设备本地独立生效。**所以后端的数据模型不需要推翻，
只需要给「能力」加一维**（见 §5.1）。

---

## 2. iOS 到底给了什么

### 2.1 沙箱与后台模型（先理解为什么做不到）

- App 不能长期在后台跑；后台只有三类：`BGTaskScheduler`（机会式，不保证时间）、静默推送（App 被强杀后不达）、后台定位（`Always` 授权 + 区域监听）。
- 没有「另一个 App 正在干什么」的可见性：读不到前台应用、读不到其他 App 的界面、读不到文件系统。
- 没有「替用户操作」的通道：不能模拟点击、不能注入、不能换桌面。
- 所以 Android 那套「在本机常驻一个管家，随时弹遮罩」的架构，在 iOS 上**从根上不成立**。

### 2.2 Screen Time API：iOS 上唯一官方的管控通道

Apple 在 iOS 15 开放了 Screen Time 框架，由四个可组合的部分 + 一个报表扩展组成【平】：

| 框架 | 作用 | 关键约束 |
| --- | --- | --- |
| `FamilyControls` | 申请授权、弹出应用/分类/网站选择器（`FamilyActivityPicker`） | 需要 entitlement `com.apple.developer.family-controls`；只能在**孩子的设备**上以 `.child` 授权，前提是该设备登录了「家人共享」里的儿童 Apple ID |
| `ManagedSettings` | 给应用/分类/网站加「盾牌」（屏蔽），也可全局禁止某些设置 | 盾牌只挡「打开」，不锁屏、不断电、不影响电话与紧急呼叫 |
| `DeviceActivity` | 注册时间表（`DeviceActivitySchedule`）与阈值事件（`DeviceActivityEvent`），由系统在扩展里回调 | 最短时间表 15 分钟；阈值粒度可到 15 秒；App 不在前台也执行 |
| `ManagedSettingsUI` | 定制盾牌文案与按钮（`ShieldConfigurationDataSource` / `ShieldActionDelegate`） | 盾牌上的按钮**不能打开宿主 App**，只能关闭盾牌或写共享状态 |
| `DeviceActivityReport`（扩展） | 渲染系统提供的使用时长报表 | 数据在扩展内取，取出到主 App/服务端需要自建聚合，属 PoC 项【验】 |

**授权与选择器的真实工作方式**（这一条决定产品形态）【平】：

```swift
// 孩子设备上的主 App：以「孩子」身份申请
try await AuthorizationCenter.shared.requestAuthorization(for: .child)

// 孩子设备上选择要管控的对象，选择结果是一组「不透明令牌」
FamilyActivityPicker(selection: $selection)   // ApplicationToken / ActivityCategoryToken / WebDomainToken
```

- 令牌是**不透明**的：第三方拿不到应用名、拿不到 Bundle ID。
- 应用名只在盾牌扩展里通过 `Application.localizedDisplayName` 可见。
- **推论**：家长端的「按应用包名配置限额、展示应用图标清单」在 iOS 上不成立；必须改成「**孩子在自己手机上选，家长只看到类别/数量/时长**」。

**时间表与阈值**（决定「定时锁」能不能做）【平】：

```swift
let center = DeviceActivityCenter()
let schedule = DeviceActivitySchedule(intervalStart: start, intervalEnd: end, repeats: true)
try center.startMonitoring(.studyTime, during: schedule)          // 到点由系统回调扩展

let limit = DeviceActivityEvent(applications: sel.applicationTokens,
                                categories: sel.categoryTokens,
                                threshold: .init(minute: 30))
try center.startMonitoring(.dailyLimit, during: schedule, events: [.limitReached: limit])
```

同名 Activity 重复 `startMonitoring` 会失败；`intervalStart` 设成「此刻」会被排到明天；
`stopMonitoring` 会触发 `intervalDidEnd`；iOS 26 上有「幻影阈值」与阈值丢失的已知问题，
需要 PoC 一遍再承诺「限时准确」。**【验】**

**盾牌能做到什么程度**（决定「学习模式/白名单」能不能做）【平】：

```swift
let store = ManagedSettingsStore()
store.shield.applicationCategories = .all(except: allowedTokens)   // 白名单式屏蔽
store.shield.webDomainCategories    = .all()
store.shield.webDomains             = blockedDomains
```

- 「全部屏蔽、只放行 N 个应用」可以做 → 这就是 iOS 版的「学习模式/专注模式」。
- 「到点锁死整台手机」做不到 → 只能做到「所有应用都打不开，但电话能用、设置还能进」。

**权限清单**（孩子端要申请的）【仓】+【平】：屏幕使用时间授权（必须）、定位 `Always` + 后台定位、
通知、`NSFamilyControlsUsageDescription`、`NSLocationAlwaysAndWhenInUseUsageDescription`；
若要读通讯录/相册，还要对应 usage description——**且会显著提高审核风险，不建议**。

### 2.3 MDM（监督机）：能力最强，门槛也最高

只有「监督（supervised）」设备才能接受这些命令【平】：

| 能力 | 监督机 MDM | 普通 App Store 孩子端 |
| --- | --- | --- |
| 真·锁屏 / 清除密码 | ✅ `DeviceLock` / `ClearPasscode` | ❌ |
| 禁止安装 / 禁止删除 App | ✅ `allowAppInstallation` / `allowAppRemoval` | ❌ |
| 已安装应用清单 | ✅ `InstalledApplicationList` | ❌ |
| 系统级 Web 内容过滤、限制相机 | ✅ | 🟡 只能过滤网站，不能禁相机 |
| Lost Mode 定位 / 抹除 | ✅ | ❌（只有自家 App 的定位） |
| 实时画面 / 短信 / 通话内容 | ❌ | ❌ |

- 监督方式：Mac + Apple Configurator（USB 线 + **抹机**）或 ABM/ASM 自动注册。这是消费级市场的硬门槛。
- App Store 审核指南 **5.5** 对 MDM / 配置描述文件类 App 有额外限制：不得用第三方分析 SDK 收集设备、用户、其他 App 的数据。
- 2019 年 Apple 曾一次性下架多款 MDM 类家长控制 App，同年因反垄断压力恢复（OurPact 案）——说明这条路**可行但脆弱**，不要把它当主路径。

### 2.4 三条硬约束（产品必须写进文案）

1. **令牌在本机**：家长网页上不能「选孩子手机里的微信」，只能在孩子手机上选。
2. **远程改盾牌没有官方 API**：家长点「立即限制」→ 服务端记意图 → 孩子端 App 收到（需在线/推送）→ 落到 App Group → 由扩展/主 App 应用。孩子手机没网、App 被挂起时只能等下次打开。
3. **删 App 即失效**：这是 iOS 家长控制类产品的共同软肋，行业做法是「家长端告警：孩子设备已卸载」而不是「阻止卸载」。

### 2.5 审核与合规

- **不能宣传「监控」**：截图、偷拍、看聊天在 iOS 上既做不到也违规；App 描述里出现这类词大概率被拒。
- **孩子端必须知情**：盾牌、定位、SOS 都要有可见的说明页。项目已有现成实现（`docs/PLAN-roadmap.md`
  §3.4「知情与同意」：孩子端 `GuardianInfoActivity` + `GuardianNotice`，家长端 `/privacy`）和
  `ConsentRecord` / `PrivacyRequest` 合规模块（`server/prisma/schema.prisma:1663` / `:1683`），可直接复用。
- **后台定位**要有醒目提示，且用途写清楚；被拒的常见理由是「用途描述与实际行为不符」。
- **中国区**：App Store 中国区上架需要工信部**APP 备案**（2023 年起）；另有未成年人模式、儿童个人信息保护规定。备案是排期项，不是上线前一周能补的。
- **Apple Developer Program** 是前提（个人/公司 $99/年，公司还需 D-U-N-S）。

---

## 3. 功能可行性矩阵

### 3.1 家长端 17 个功能键

判定、理由、iOS 上长什么样：

| # | 功能键 | 家长现在看到的 | Android 怎么做 | iOS 方案 | 判定 |
| --- | --- | --- | --- | --- | --- |
| 1 | `lockScreen` | 「一键锁屏」 | 悬浮窗全屏遮罩 + 设备管理器 `lockNow` | 把所有应用打盾牌；**不能断电式锁屏**，电话/设置可用 | 🟡 |
| 2 | `tempUnlock` | 「临时可用 N 分钟」 | 撤销遮罩，定时回锁 | 移除盾牌 + 本地计时，到点由**系统时间表**恢复 | ✅ |
| 3 | `timePlan` | 「每日可用时长 / 作息」 | 本地累计 + 到点遮罩 | 只能限「应用使用」，不能锁整机；到点全屏蔽 | 🟡 |
| 4 | `appLimit` | 「逐应用限时」 | `UsageStatsManager` 累计 | 令牌/分类 + 阈值事件（15 秒粒度），**必须孩子设备上选** | 🟡 |
| 5 | `appAudit` | 「新装应用审核 / 批准窗口」 | `DISALLOW_INSTALL_APPS` + 家长批准 | **无 API 感知安装**；监督机只能「禁止安装」，没有「申请-批准」 | ❌ / 🔬 |
| 6 | `webBlock` | 「网址拦截」 | `VpnService` DNS 层 NXDOMAIN | 系统级 `webContentFilter`（自动成人内容/黑名单）；可加 DNS 代理扩展 | 🟡 |
| 7 | `modeSwitch` | 「学习模式」 | 白名单 + 替换桌面 + 无障碍插件 | 白名单盾牌（all except）；**无专用桌面、不能拦应用内功能** | 🟡 |
| 8 | `eyeCare` | 「护眼提醒 / 时长提醒」 | 悬浮窗强制休息、距离/姿势 | 只能发本地通知提醒；**不能强制休息、不能测距离姿势** | ❌ |
| 9 | `appPlugin` | 「微信/QQ 功能管控」 | 无障碍读界面 + 拦控件 | **无无障碍，做不到** | ❌ |
| 10 | `quizUnlock` | 「答题换取使用」 | 服务端判题 → 撤遮罩 | 服务端判题 → 撤盾牌；盾牌按钮打不开 App，需「通知兜底 + 回 App 领奖」 | ✅ |
| 11 | `screenMonitor` | 「屏幕洞察（AI 画面分析）」 | 周期截屏 → 上传 → AI | **完全不可能**（无截屏 API）。替代：Screen Time 使用报表 | ❌ |
| 12 | `remoteHelp` | 「远程协助（返回/主页/打开 App）」 | 无障碍模拟操作 | 只能「发指引 + 一键打开某 App（URL scheme，需前台）」 | ❌ |
| 13 | `callSms` | 「通话/短信记录」 | 读取系统库 | **无 API** | ❌ |
| 14 | `remotePhoto` | 「远程拍照」 | 后台 Camera2 | **无后台相机**；前台拍照要孩子配合 | ❌ |
| 15 | `remoteRecord` | 「一次性录音」 | 后台麦克风 | **无后台麦克风**，且审核不允许 | ❌ |
| 16 | `videoRecord` | 「连续录像」 | MediaProjection | **无录屏 API** | ❌ |
| 17 | `audioRecord` | 「环境监听」 | 麦克风分片上传 | **同上** | ❌ |

**小结：✅ 2 项、🟡 5 项、❌ 10 项。**（`appAudit` 在监督机档可部分做到，普通档为 ❌）

### 3.2 18 条指令

| 分组 | 指令 | iOS | 说明 |
| --- | --- | --- | --- |
| 锁控 | `lock` | 🟡 | 语义变「全应用屏蔽」，不是锁屏；`lockReason` 文案要改 |
| 锁控 | `unlock` | 🟡 | 撤盾；但「屏幕已解锁」不再是同一个事实 |
| 锁控 | `temp_unlock` | ✅ | 撤盾 + 由系统扩展在到期时恢复（不依赖本地计时器，需 PoC） |
| 锁控 | `cancel_temp_unlock` | ✅ | 立即恢复屏蔽 |
| 定位 | `fetch_location` | ✅ | 前后台定位都可用 |
| 配置 | `sync_config` | ✅ | 骨架不变，payload 加 iOS 段（见 §5.1） |
| 自检 | `self_check` | 🟡 | 只能**报告**授权/权限/低电量/后台刷新状态，不能自愈；可深链到系统设置 |
| 应用 | `sync_apps` | ❌ | 无法枚举已安装应用、无法抓图标 |
| 屏幕 | `screenshot` | ❌ | 无 API |
| 相机 | `remote_photo` | ❌ | 无后台相机 |
| 录音 | `start_audio` / `stop_audio` | ❌ | 无后台麦克风 |
| 录像 | `start_recording` / `stop_recording` | ❌ | 无录屏 |
| 监听 | `start_ambient` / `stop_ambient` | ❌ | 同录音 |
| 通话短信 | `sync_calls_sms` | ❌ | 无 API |
| 操作 | `remote_action` | ❌ | 无无障碍 |

**小结：✅ 4 条、🟡 3 条、❌ 11 条。**

> ⚠️ 这意味着一件事：服务端 `commands.service` 必须**在入队前**按设备平台拒绝不支持的指令。
> 否则家长点「截屏」，指令进队列 → iOS 设备领取 → 一定失败 → 家长看到的是一条无意义的失败记录，
> 而不是「这个功能在你的孩子设备上不可用」。现在 `requireFeatureEnabled`（`devices.service.ts:1723`）
> 只校验功能键开关、`commands.service.ts:77` 的 `enqueue` 是纯插入，两者都不看设备平台，
> 这是必须补的一刀（见 §5.1）。

### 3.3 数据通道与页面

| 页面 / 数据 | iOS | 说明 |
| --- | --- | --- |
| 孩子端主页（今天剩多少、被限制原因、SOS、找家长） | ✅ | 项目已实现「计算在设备端」的设计，正好适配 iOS |
| 位置与安全区（`LocationPage`） | ✅ | `Always` 定位 + `CLCircularRegion` + 逆地理 |
| 今日任务（`ChildrenPage`） | ✅ | 与 Android 完全同构 |
| 通知中心（站内） | ✅ | 服务端能力，天然复用 |
| 答题（`QuizUnlockPage`） | ✅ | 判题在服务端 |
| 设备健康（`DeviceHealthPage`） | 🟡 | 检查项要换：屏幕使用时间授权、定位、通知、后台刷新、低电量 |
| 使用时长报表 | 🟡 | `DeviceActivityReport` 扩展自建聚合，PoC 后承诺 |
| 屏幕洞察 / 媒体库 | ❌ | iOS 没有「素材来源」；只能显示空状态并说明「Android 专属」 |
| 通话短信（`CallSmsPage`） | ❌ | 同上 |
| 应用审核 / 应用插件（`AppAuditPage` / `AppPluginsPage`） | ❌ | 同上 |
| 应用清单与图标 | ❌ | 令牌不可命名，拿不到图标 |
| 实时同屏（§3.9 已声明不做） | ❌ | 本就没有 |
| 多孩子档案 / 家庭成员 / 会员 / 支付 / 客服 | ✅ | 纯服务端能力，iOS 白拿 |

### 3.4 覆盖率怎么算才诚实

- **按功能键**：7 / 17（41%）
- **按「家长每天真正会点的动作」**：约 **65–70%**（锁/临时放开/时长/位置/答题/通知/任务都在）
- **按「监控取证类」**：0 / 6（截图、录屏、拍照、录音、通话短信、应用内插件）
- **按「跨平台家庭」**：Android 孩子 + iOS 孩子混用，家长端能力是**并集**，这正是我们的差异化

所以对外表述建议是：「**iOS 版做的是习惯与边界；证据与监控是 Android 专属**」，而不是「iOS 版功能少几个」。

---

## 4. 方案对比

### 4.1 方案 A：App Store 孩子端 + Screen Time API（主线，推荐）

```
家长端 Web ──HTTPS──> bdog-server ──┬─ /agent/config（规则）
                                    ├─ /agent/commands/*（指令队列）
                                    └─ APNs（新增，推送）
                                            │
                                            ▼
                                  孩子 iPhone
┌──────────────────────────────────────────────────┐
│ 孩子端 App (SwiftUI)                              │
│  · 绑定 / 心跳 / 配置缓存（App Group 共享容器）    │
│  · FamilyActivityPicker 选应用 → 存 tokens        │
│  · 定位 / 围栏 / SOS / 任务 / 孩子主页            │
├──────────────────────────────────────────────────┤
│ DeviceActivityMonitor 扩展   ← 系统调度，App 不在前台也跑 │
│  · 时间表到点 → 写 shield                        │
│  · 阈值事件 → 屏蔽 + 上报（15s 粒度）             │
├──────────────────────────────────────────────────┤
│ ShieldConfiguration / ShieldAction 扩展  ← 盾牌文案与按钮 │
│ DeviceActivityReport 扩展               ← 使用报表       │
└──────────────────────────────────────────────────┘
```

- **门槛**：Apple Developer + 4 份 entitlement（主 App + 3 个扩展，逐个 bundle ID 审批，常需数周）+ 中国区备案。
- **优点**：合规、可分发给所有 iPhone 用户、无需抹机、扩展由系统调度（比 Android 更省电更稳）。
- **缺点**：能力只到「限制」；实时性差；孩子删 App 即失效；令牌导致家长端 UX 要重设计。

### 4.2 方案 B：监督机 + MDM（强管控增值档）

- 适用：愿意用 Mac + 数据线 + 抹机的家长；学校/机构批量。
- 可补上 A 做不到的：**真锁屏、禁止安装/删除、应用清单、系统级 Web 过滤、Lost Mode、抹除**。
- 仍做不到：截图、短信、通话、实时画面、后台录音。
- 成本：另需 MDM 服务端方案（自建或接 Jamf/Kandji 之类）、APNs 证书、一对一客服。**6–10 周**，且运营重。
- 结论：**不建议首发做**，可作为「iPhone 强管控版」的后续档位。

### 4.3 方案 C：不装孩子端，只引导用系统「屏幕使用时间」（过渡/降级）

- iOS 系统的「家人共享 + 屏幕使用时间」本身就能做应用限额、停用时间、内容限制，而且是苹果官方、孩子绕不过。
- 我们做一个「配置向导 + 家长端记录 + 提醒」，零审核风险、零 iOS 开发。
- 缺点：没有数据闭环（服务端拿不到孩子时长），不算真正的「孩子端」。适合作为 iOS 正式版上线前的降级路径。

### 4.4 方案 D：企业签 / 越狱 / TestFlight 长线（排除）

- 企业签（`apple-developer-enterprise`）分发=违反协议，封号即全线失效；
- TestFlight 构建 90 天过期，无法长线；
- 越狱市场 <1% 且损害品牌。
- 结论：**不做**。这是「看起来能拿到 Android 能力」的陷阱，代价是不可运营。

### 4.5 推荐组合

1. **首发**：A（App Store + Screen Time），文案定位「iOS 专注与边界」；
2. **同时**：C 作为「还没装/没授权」时的降级引导，避免家长打开 App 一片空白；
3. **后续**：B 作为付费增值档（iPhone 强管控），前提是先跑通 A 的客服与授权漏斗；
4. **永不**：D。

**一个战略提醒**：iPhone 上「限制应用」这件核心事，苹果自己（家人共享）已经免费给了。
如果 iOS 孩子端只是「再做一个限制器」，价值有限。真正的差异化在
**「家长期望 → 设备执行 → 事后对账」的闭环**：多孩子统一视图、任务与答题、位置围栏与 SOS、
跨 Android/iOS 的混用家庭、使用报表聚合。这也正是本项目后端已经具备的东西。

---

## 5. 落地改造清单

### 5.1 后端（`server/`）

| # | 改动 | 位置 | 为什么必须 |
| --- | --- | --- | --- |
| 1 | `FEATURE_DEFS` 增加 `platforms`（如 `['Android','iOS']`）与 `unavailableReason` | `server/src/features/devices/devices.constants.ts` | 现在 17 个键不分平台，家长端会照单全收 |
| 2 | `GET /api/features` 按 `device.os` 过滤 + 返回 `capabilities` | `devices.routes.ts:55` / `devices.service.ts` | 家长端据此隐藏/改名按钮 |
| 3 | `ChildDevice` 增加 `capabilities Json?`，注册时由设备声明 | `prisma/schema.prisma` + `devices.service.ts` 的 `registerAgent` | 同 OS 不同版本能力也不同（iOS 15/17/26 的阈值行为不一样） |
| 4 | 平台校验：iOS 上 `screenshot/remote_photo/start_recording/...` 直接 **409 `COMMAND_NOT_SUPPORTED_IN_OS`**，附 `reason` | `devices.service.ts:1723` 的 `requireFeatureEnabled`（或 `commands.service.ts:77` 的 `enqueue`） | 现状 `requireFeatureEnabled` 只校验功能键开关，`enqueue` 是纯插入不做校验，**都不校验平台** → 必然产生「排队后失败」的脏记录 |
| 5 | `/agent/config` 增加 `platform` 与 iOS 段：`shield { mode: 'all'|'allowlist', allowedTokens? }`、`webFilter`、`usage { reportEnabled }` | `agent.controller.ts:266` 的 `getConfig` | 规则原样下发、本地求值（骨架已具备） |
| 6 | 用量上报：复用 `POST /api/agent/app-usage` 通道，但 iOS 上报「分类/令牌摘要 + 秒数」，落新表 `DeviceUsageDaily` | `agentGaps.routes.ts:33` + `devices.service.ts:1345` 的 `reportAppUsage` | 现有实现把用量写进 `AppLimit.usedTodaySeconds` 并按 `packageName` 匹配限额行；iOS 没有包名/应用名，硬塞会写空 |
| 7 | `effectiveLocked` 语义扩展：iOS 上表示「盾牌生效中」，`lockReason` 用 iOS 文案（如 `shield_active`） | `devices.service.toDeviceView` | 家长端要能区分「没锁上」和「锁不了」 |
| 8 | 新增 APNs 通道：`PushToken` 表 + 发送服务；推翻「vendor push 不适用」的旧结论 | 新 `features/push/` + README/AGENTS 更新 | iOS 孩子端没有长轮询常驻的便利，SOS/围栏/指令需要推送 |
| 9 | 屏幕洞察/媒体/通话短信/应用审核等接口，对 `os=iOS` 的设备返回**空 + 原因**而不是空数组 | 各 controller | 避免家长端「永远没数据」的困惑 |

**注册协议**：`POST /api/agent/register` 已经收 `os` 字段（`devices.dto.ts:87`，schema 注释里约定
`Android | iOS | HarmonyOS`）【仓】，无需改协议，
只需在返回里带上 `capabilities` 与 `config` 的 iOS 版本。这一点很关键——**孩子端换平台不需要改绑定链路**。

### 5.2 家长端（`src/`）

- **引导流程分叉**：`OnboardingPage.tsx` 的四步（下载 APK + 授权清单）在 iOS 上完全不同：
  App Store 下载 → 加入家人共享 → 打开 App 同意屏幕使用时间授权 → 选择要管控的应用。
  组件 `InstallGuide` / `AgentInstallCard` / `AuthorizeGuide` / `NoDeviceState` 都需要 `platform` 分支。
- **按钮改名**：`HomePage.tsx` 的「一键锁屏」→ iOS 显示「限制使用」；「临时可用」→「临时放开」。
  说明文案要提前写死差异，别等用户点完发现「屏幕没黑」。
- **不可用项的统一空状态**：`AppAuditPage` / `AppPluginsPage` / `CallSmsPage` / `InsightsPage` / `MediaPage`
  在 iOS 设备下展示「该能力仅 Android 支持」+ 升级引导，而不是空列表。
- **设备健康页换检查项**：`DeviceHealthPage` 的 gap 列表要按 OS 切换（屏幕使用时间授权是 iOS 的第一公民）。
- **多孩子混合视图**：`ChildrenPage` 里 Android/iOS 孩子并列时，能力徽标要可见（这是卖点，不是缺陷）。

### 5.3 孩子端 iOS 工程

```
BalloonDogAgent/
├── BalloonDogAgent/            # 主 App（SwiftUI）
│   ├── Enrollment/             # 绑定、设备身份（Keychain）、心跳、配置同步
│   ├── ScreenTime/             # AuthorizationCenter、FamilyActivityPicker、盾牌落地
│   ├── Location/               # CoreLocation Always + 区域监听 + 逆地理
│   ├── ChildHome/              # 孩子主页、SOS、任务、今日剩余
│   └── Shared/                 # App Group：规则 JSON、令牌、上次同步时间
├── DeviceActivityMonitor/      # 扩展：时间表、阈值事件
├── ShieldConfiguration/        # 扩展：盾牌文案（含「找家长」「去答题」按钮）
├── ShieldAction/               # 扩展：按钮动作（只能写共享状态/调 API，不能开 App）
└── DeviceActivityReport/       # 扩展：使用报表（PoC）
```

- 所有扩展与主 App 通过 **App Group** 共享（唯一通道，已由社区实测确认）。
- 盾牌按钮不能开 App 是硬限制，所以「去答题」「再给 5 分钟」的交互要重新设计（通知兜底 / 家长端代操作）。
- 时间表恢复要**不依赖主 App 存活**：到点由 `DeviceActivityMonitor` 写盾牌，这是 iOS 比 Android 更可靠的地方。
- 工程化：Xcode Cloud 或 Fastlane + TestFlight；`Info.plist` 的用途描述要逐条对应真实行为。

### 5.4 推送

现在的「实时」是靠 Android 的 25 秒长轮询 + 后台服务。iOS 上：
- SOS、围栏进出、指令到达、超时提醒 → **APNs**（静默推送做配置同步，普通推送做家长提醒）。
- APNs 需要 `p8` 密钥、`PushToken` 注册接口、失败重试与清理；这是后端**新增子系统**，不是改造。
- 不要指望静默推送唤醒被强杀的 App（系统不保证）——这与 Android 的「常驻活着」是两种世界观。

### 5.5 运维与发布

- Apple Developer 账号、`p8` 推送密钥、4 份 entitlement 审批、中国区 APP 备案。
- iOS 版没有「APK sha256」这类部署校验，改用 TestFlight + App Store Connect 版本管理。
- 现有 `npm run deploy` / `docker compose` 链路不变（后端仍是那一个服务）。

---

## 6. 风险

| 风险 | 概率 | 影响 | 缓解 |
| --- | --- | --- | --- |
| Family Controls entitlement 审批被拒或拖 4–8 周 | 中 | 直接卡住排期 | 立项第一周就提交；先做不依赖 entitlement 的部分（定位/任务/SOS/通知） |
| 家长预期落差：「为什么不能看聊天/截图」 | **高** | 差评、退款、投诉 | 上线前把能力矩阵写进 App 描述、引导页、对比页；客服话术统一 |
| iOS 阈值事件不准（iOS 26 幻影阈值/丢失） | 中 | 「限时」争议 | 真机 PoC 一轮再承诺；兜底用时间表而非阈值 |
| 孩子删除 App 即失效 | **高** | 管控中断 | 家长端「已卸载」告警 + 重装引导；不要承诺防卸载 |
| 审核被拒（后台定位/儿童数据/描述用词） | 中 | 上线延迟 | 用途描述逐条对应；不出现「监控/录屏」类文案；复用既有合规模块 |
| 令牌不透明导致家长端 UX 难懂 | 中 | 转化率 | 用「类别 + 数量 + 时长」呈现，不追求逐应用命名 |
| MDM 档的合规与运营成本 | 高 | 拖累主线 | 首发不做（§4.2） |
| Android 与 iOS 功能不对等引发客诉 | 高 | 商业 | 定价分档 + 明确「iOS 专注版」定位 |

---

## 7. 工作量与里程碑

假设：1 名资深 iOS 工程师 + 0.5 后端 + 0.5 前端/QA；**不含** entitlement 审批等待与 App Review 往返。

| 阶段 | 内容 | 工期 |
| --- | --- | --- |
| 阶段 0 | 立项、entitlement 提交、能力矩阵定稿、合规文案 | 1–2 周（审批并行 2–6 周） |
| 阶段 1 · MVP | 绑定/心跳/配置、盾牌（全屏蔽/白名单/分类）、时间表、临时放开、答题解锁、位置围栏、SOS、孩子主页、任务、通知 | 10–14 周（iOS）+ 2–3 周（后端）+ 2–3 周（家长端） |
| 阶段 2 | 使用时长报表（PoC→上线）、网址过滤、设备健康、多平台混合视图、APNs | 4–6 周 |
| 阶段 3（可选） | 监督机 + MDM 强管控档 | 6–10 周 |

- **到 MVP 约 3 个月**（并行），**到「完整版」约 4–5 个月**。
- 若只做「家长端原生 App」，约 6–8 周，但**不解决孩子端问题**，优先级应更低。

---

## 8. 需要产品决策的问题

1. **定位**：iOS 版是「对齐 Android」，还是明确做「iOS 专用 · 专注与边界」？（后者才成立）
2. **能不能接受三条前提**（§0.3）：孩子 Apple ID + 家人共享 + 允许孩子删 App？
3. **能不能接受「应用必须在孩子手机上选」**？这会改掉家长端「按应用配置」的核心交互。
4. **要不要做监督机 MDM 档**？做的话谁来做客服与抹机引导？
5. **市场**：只做中国区（需备案）还是国内外同发？儿童数据合规由谁签字？
6. **商业**：iOS 版单独定价、还是会员通用但能力列表不同？

---

## 附录 A：证据与验证状态

**仓库内已核实【仓】**

- `server/src/features/devices/devices.constants.ts`：`COMMAND_TYPES` 18 条、`FEATURE_DEFS` 17 个
- `server/prisma/schema.prisma`：`ChildDevice.os`（`Android | iOS | HarmonyOS`）、`effectiveLocked` / `lockReason` / `tempUnlockUntil`、`AppLimit.packageName` 注释已预留「iOS Bundle ID」
- `server/src/features/schedule/schedule.service.ts:252` `buildAgentPayload`：规则原样下发
- `android/README.md`：18 组接口 / 18 条指令 / 本地强制
- `docs/FEATURE-STATUS.md` §4.3：既有的诚实边界（无障碍依赖、DNS 拦截强度、护眼未做距离/姿势、学习模式专用桌面、免授权截图依赖无障碍）
- `docs/REPORT-capture-hardening.md`：截图链路真实根因（MediaProjection 需孩子点授权 → 改无障碍）

**平台机制与同行实测【平】**

- [Meet the Screen Time API（WWDC21-10123 笔记）](https://wwdcnotes.fline.dev/documentation/wwdc21-10123-meet-the-screen-time-api/)
- [HonorFit：Screen Time API 实战（entitlement 逐个 bundle ID 审批、令牌不透明、15 分钟最短窗口、iOS 26 幻影阈值、盾牌按钮无法开 App）](https://dev.to/thomaswillheim/building-a-parental-control-app-with-screen-time-api-2kcb)
- [Apple 开发者论坛：Screen Time / FamilyControls 讨论](https://developer.apple.com/forums/tags/screen-time)
- [Screenable：孩子设备上的授权步骤（家长不能在自己手机上授权孩子设备）](https://help.getscreenable.com/article/58-kid-device-screen-time-access)
- [Apple 审核指南 5.5（MDM / 配置描述文件类 App 的数据限制）](https://developer.apple.com/app-store/review/guidelines/)

**必须真机验证后才能对外承诺【验】**

- [ ] `.child` 授权在「未登录儿童 Apple ID / 未加入家人共享」时的具体报错与降级表现
- [ ] 应用选择器得到的 token 在**升级 App / 重装 App** 后是否仍然有效
- [ ] 阈值事件在 iOS 26/27 上的准确度、丢失率、「幻影阈值」复现
- [ ] 时间表跨天/跨时区/夏令时的行为
- [ ] `DeviceActivityReport` 数据能否稳定聚合出「每日总时长」并上传
- [ ] 盾牌按钮在扩展里调网络（记录答题/申请加时）的可用性
- [ ] App 被强杀后，已生效的盾牌是否仍然生效（预期：是，因为盾牌由系统持有）
- [ ] 定位围栏在低电量模式/后台刷新关闭时的到达率

---

## 附录 B：给非技术同事的一句话版

> iPhone 上我们能管「孩子能不能用、用多久、什么时候用、能不能上网、人在哪、有没有求助」，
> 管不了「孩子手机里的画面、聊天、短信、通话、摄像头和麦克风」。
> 前者我们做，后者在 iOS 上没有合法做法——谁承诺能做，都是在骗人或者要越狱。
