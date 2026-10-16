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
| 孩子的申请（加时 / 延后锁屏） | ✅ | ✅ | 🟡 **已实现，设备级未验证** | 锁屏页选时长+理由 → `TimeRequest` → 家长审批；**批准即下发 `temp_unlock` 指令**（服务端不自己宣布已解锁）。孩子端只用 `extend_time`，见 §3D |
| 孩子端主页（今天还剩多少 / 求助家长） | ✅ | ✅ | 🟡 **已实现，设备级未验证** | 只读主页：剩余时长与「接下来会怎样」都在**本机**算（与锁定判定同一组输入）；求助走 `POST /api/agent/sos` → 动态 + **danger 级**通知（一分钟幂等）。入口是常驻通知上的按钮。同一页还有家长布置的「今日任务」，可以勾选，见 §3J |
| 知情与同意（本设备如何被守护） | ✅ | ✅ | 🟡 **已实现，设备级未验证** | 孩子端说明页（`GuardianInfoActivity`，入口在孩子端主页底部）：顶部「现在正在发生什么」按本机真实开关生成，下面七节静态说明。文案来自纯 Java 的 `GuardianNotice`，**且与 `AndroidManifest.xml` 机械对照**（crosstest 第 7 步）。家长侧同意留痕已在 §5.3 交付（家长端 `/privacy`），见 §3K |
| 模式切换（学习模式） | ✅ | ✅ | ✅ **真实执行** | 无障碍 + 前台包名白名单，**本地求值** |
| 护眼设置 | ✅ | ✅ | ✅ **真实执行** | 连续用眼计时 → 注入锁定源 → **真锁屏** |
| 微信 / QQ 功能管控 | ✅ | ✅ | ✅ **真实执行** | 无障碍 + 界面文本关键词匹配 → 弹「应用已被禁止使用」说明页（原来只是静默按返回，孩子以为手机坏了） |
| 周期截屏 + AI 洞察 | ✅ | ✅ | ✅ **真实执行** | 无障碍免授权截图优先（`AccessibilityScreenCapture`，API 30+）→ 打包上传 → 服务端分析，拿不到才回退常驻 MediaProjection。已上机验证：`ScreenFrame` 真的有行（20 秒内 14→16），采样全程 0 次授权页。`e2e-gaps` 第 10 节把它做成 8 项永久断言（配置回读、`pref capture_enabled=true`、logcat「已上传截屏包」、`GET /api/insights` 出现新行、路径日志「周期采样截图走无障碍免授权路径」、无「采样截图失败」、无系统授权页），2026-10-11 全绿 |
| 局数 / 集数预算 | ✅ | ✅ | 🟡 **部分执行** | 服务端 AI 计数 + **设备端本地兜底**（`UsageBudget` 参与 `LockState` 判定）。配置下发已上机验证；**「离线兜底锁屏」只有编译/JVM 级**（构造不出 `used >= limit`，见 §3A） |
| 应用审核 | ✅ | ✅ | 🟡 **部分执行** | 安装器识别 → 上报审批 → `DISALLOW_INSTALL_APPS` + 10 分钟批准窗口。`no_install_apps` 真的生效（孩子侧装不了）、审批链路真的通；但**走的是卸载确认页**，真安装页无法从 adb 构造（§3A） |
| 应用限制（逐应用限时） | ✅ | ✅ | ✅ **真实执行** | `UsageStatsManager` 累计前台时长 → 超限弹「应用已被禁止使用」说明页。**已修复并上机验证**：家长端从设备清单选应用（必须带 `packageName`）→ 设备拦截规则表真的落进带包名的规则 → 真的拦到了（logcat `看门狗：拦截 com.google.android.deskclock —— Clock 今日 1 分钟已用完`）、家长端「已用 529 秒」不再恒为 0。原先的「三层静默丢弃」见 §4.5 缺陷 1/2 |
| 网址拦截 | ✅ | ✅ | 🟡 **两层拦截，设备级未验证** | R3 起是两层：①DNS 命中回 NXDOMAIN；②**把被拦域名的地址变成隧道 /32 路由**（`addRoute`），于是「已缓存的 IP」「家长名单里的 IP/网段」「853 端口的加密 DNS」都会进 tun 被丢掉（TCP 额外回 RST，立刻失败而不是转圈）。规则现在接受域名 / IP / IP 段。**仍拦不到**：换一个没被拦的加密解析器问到 IP、应用自己写死且不属于被拦域名的 IP、已建立的连接；VPN 没跑两层都不生效。设备级仍未验证（详见 §3G） |
| 学习模式专用桌面 | ✅ | ✅ | 🟡 **已实现，设备级未验证** | 学习模式 + 设备所有者时把 HOME 钉到 `StudyHomeActivity`（`addPersistentPreferredActivity`），桌面上只列家长允许的应用 + 安全底线的系统应用，返回键被吃掉；结束学习模式/解绑立刻还回去。没有设备所有者时接管失败会在页面与动态里如实说明（不装成功）。设备级未验证（详见 §3H） |
| 家庭成员与角色 | ✅ | ✅ | ✅ **真实执行**（服务端 + 家长端，无设备端部分） | 一台设备可以邀请最多 5 个家长账号共同看护：`DeviceMember` 表 + `owner`/`admin`/`viewer` 三档。**主人仍是 `ChildDevice.userId`**（唯一、不写成员行、不占名额）；写接口逐条过 `requireWritableDevice`，解绑与成员管理只有主人能做（`requireOwnerDevice`）；邀请只认已注册手机号，手机号一律打码。明细见 §3I |
| 孩子档案与今日任务 | ✅ | ✅ | 🟡 **已实现，设备级未验证**（孩子端可勾选；编译 + JVM 级已过，`adb devices` 为空没上过真机） | 新增「孩子」实体（姓名 / 出生年份 / 学校 / 头像）与「今日任务」：档案是**家长账号级**的，一台设备可挂到一个孩子名下，任务跟着孩子走。年龄由出生年份现算（不存年龄），日期存 `YYYY-MM-DD` 字符串；设备归属是**整组替换**（一台设备只能属于一个孩子，换孩子自动从原档案移走，同一事务）；**删档案不删设备**（`onDelete: SetNull`）；上限 5 份档案 / 10 台设备 / 20 条任务一天。孩子端勾掉一条任务 → 家长收到一条 `child_task` 通知（模板 + 参数，重复勾选只发一次）。明细见 §3J |
| 合规留痕、导出与注销 | ✅ | ✅ | ✅ **真实执行**（服务端 + 家长端，无设备端部分） | `ConsentRecord` 留同意版本（文本一改就变「需要重新同意」，不静默续期）；最小必要采集清单是**代码里的表**，每项的用途/保存期限/存放位置必须与实现对得上；`GET /api/privacy/export` 一次导出元数据（含 `truncated` 标记）；注销分两段 —— 申请时**立刻停监控并删设备记录（含磁盘文件）**，账号数据 7 天冷静期后由定时任务真删。**撤回同意也是删设备记录，不是把 `userId` 置空**（否则下一个绑定该设备的家庭会看到上一家的照片）。明细见 §3K |
| 帮助与反馈（客服工单 + 运营后台） | — | ✅ | ✅ **真实执行**（服务端 + 家长端 + 后台，无设备端部分） | 家长按 6 类提交工单（正文 2000 字上限、最多 5 张未关闭），客服在后台回复即认领并推进状态，**家长看不到客服是谁**（也不下发管理员登录 id）；关闭后双方都不能再回，历史记录不随入口开关消失；越权读写一律 404。运营侧另有**告警大盘**（五条内置规则，分母为 0 显示「—」而不是 0%；确认只记录「谁看过」，不改变数字、不出站）与**灰度开关**（数据库无行 = 用代码默认值，放量用稳定哈希）。明细见 §3M |
| 远程拍照 | ✅ | ✅ | ✅ **真实执行** | Camera2 拍照 → 上传 → 回填 `mediaId` |
| 屏幕截图 | ✅ | ✅ | ✅ **真实执行** | 优先无障碍 `takeScreenshot`（免授权，API 30+）→ 上传，拿不到才回退 MediaProjection。已上机验证（Android 13 模拟器，**全程无人点屏幕**）：指令 `succeeded`、68469 B JPEG 可下载、`MediaAsset.kind='screenshot'` 新增、授权框 0 次。`e2e-gaps` 第 8 节 9 项永久断言（`capabilities=129` 含 `CAPABILITY_CAN_TAKE_SCREENSHOT`、**关掉「屏幕洞察」也能截**、`succeeded`、走免授权路径、无「等待屏幕共享授权超时」、无系统授权页、媒体新增、102212 B 可下载、首两字节 `FFD8`）2026-10-11 全绿 |
| 连续录像 | ✅ | ✅ | ✅ **真实执行** | MediaProjection 持续录 → 上传。已上机验证：11 秒 → 138824 B `ISO Media, MP4 v2` |
| 远程录音 | ✅ | ✅ | ✅ **真实执行** | MediaRecorder 录一段 → 上传 |
| 定位上报 | ✅ | ✅ | ✅ **真实执行** | 首次启动 + 每 5 分钟自动上报，`fetch_location` 也可触发 |
| 安全区 | ✅ | ✅ | ✅ **真实执行** | 设备端 `Geofence` 本地判定进出 → 上报事件（不依赖服务端往返）。已上机验证：真实坐标 → `geofence_enter` → 移走中心 → `geofence_exit` |
| 同屏监控（实时） | — | ✅ 入口 | ⛔ **明确不做** | 没有实时投屏能力，首页入口实为「屏幕洞察」 |
| 远程协助 | ✅ 键 | ✅ 入口 | ✅ **真实执行** | 无障碍静态桥执行预设动作；未连无障碍时**如实失败**。已上机验证：`home` 后前台真的回桌面、`open_app` 后前台真是它 |
| 电话短信 | ✅ 键 | ✅ 入口 | ✅ **真实执行** | `CallLog`/`Sms` 读取 → 上报；未授权时**如实跳过**。已上机验证：造真数据 → 上报 → 服务端 `GET /api/calls|sms` 读到 |
| 环境监听 | ✅ 键 | ✅ 键 | ✅ **真实执行** | `MediaRecorder` 5 分钟分段循环录音上传（1 小时安全阀）。已上机验证：录到 135159 字节 audio/mp4 且可下载。**但首次下发可能丢，见下方 ⚠️** |
| 隐藏图标 | — | ✅ | ✅ **真实执行** | `activity-alias` 切换图标可见性，**默认就是隐藏**（`ChildDevice.hideIcon` 建表默认 `true` + 迁移 `20261013214520_hide_icon_default_true` 回填存量设备）；本机入口是拨号暗码 `*#*#2887#*#*`（`SecretCodeReceiver`），另有家长端远程恢复与 adb 两条兜底。已上机验证：置 `false` 后桌面入口 30 秒内可解析、置回 `true` 后入口消失、拨号广播 `经拨号入口（*#*#2887#*#*）打开主界面` 且 `MainActivity` 真的回到前台 |
| 设备健康可见性 | ✅ | ✅ | ✅ **真实执行** | 设备端把 `LongevityGuard` 每 5 分钟就知道的那些缺口（设备所有者 / 无障碍 / 悬浮窗 / 电池白名单 / VPN 常驻 / 使用情况访问 / 加固项）整体上报 → 家长端 `/device-health` 显示「管控正常 / 部分能力降级 / 已实质失效」。缺口文案由**设备端原文透传**，没上报过的开关显示**未知**而不是猜一个绿灯；「重新检测」走 `self_check` 指令队列（服务端不能替设备看系统开关）。**验证等级：服务端 91/91 + 家长端 UI 全绿；设备端只有编译 + JVM 级**（本轮无可用设备，详见 §3B） |
| 站内通知 | — | ✅ | ✅ **真实执行** | 四类事件（设备失联 / 管控失效 / 安全区进出 / 申请装应用）、会员到期提醒与「今日任务」完成真的写进 `Notification` 表：未读角标、消息中心、逐类开关。**关掉某一类之后服务端就不再产生它**（写入侧过滤，不是前端隐藏），所以角标与列表永远一致。微信服务号模板消息**已真的能发**（`NotificationDelivery` 投递表 + 重试上限 3 + 令牌失效重取；四个环境变量齐了才 `configured`、微信扫码登录过一次才 `bound`，没配好时只是静默待发而非丢失）；厂商推送**不适用**（家长端是网页，没有原生 SDK 可接）并如实带原因。验证：`server:e2e:notifications` 69/69 + `server:e2e:wechat` 52/52 + 家长端 UI 全绿 |
| 家庭成员 | — | ✅ 占位 | ⚪ **未实现** | 家长端显示为「未开放」灰态 |
| 防杀 / 保活 | — | — | ✅ **真实执行** | 前台服务 + `START_STICKY` + `stopWithTask=false` + 双闹钟 + 持久化 Job + `LongevityGuard` 自愈；实测 `kill -9` 后 10 秒恢复 |
| 防卸载 / 防恢复出厂 | ✅ | ✅ | ✅ **真实执行** | `setUninstallBlocked` + 受保护包（`setUserControlDisabledPackages`，API 30+）+ 20 条 `UserManager` 限制；实测三个系统按钮变灰、`pm uninstall`/`pm disable-user` 均被拒 |

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

设备端用无障碍读当前界面的可见文本与控件描述，命中关键词就弹一页「应用已被禁止使用」说明
（`AppBlockedActivity`：应用名 + 原因 + 「返回桌面」；唯一出口是回桌面，不会被扔回被禁的应用）。
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
ScreenSampler 走 ScreenCapturer：优先无障碍免授权截图，拿不到才回退常驻 MediaProjection
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
| 前台服务 | 常驻通知，`START_STICKY`，`android:stopWithTask="false"` |
| 任务被划掉 | `onTaskRemoved` 立刻重新拉起 |
| 进程被杀 | `AlarmManager` 自续期看门狗（60 秒）+ **精确备用闹钟**（15 分钟，`setExactAndAllowWhileIdle`）+ 持久化 `JobScheduler`（15 分钟） |
| 开机自启 | `BootReceiver`（含 `LOCKED_BOOT_COMPLETED`，解锁前就跑） |
| 防卸载/强停 | 设备所有者：`setUninstallBlocked` + **受保护包 `setUserControlDisabledPackages`（API 30+）** + 20 条 `UserManager` 限制（`DISALLOW_APPS_CONTROL` / `UNINSTALL_APPS` / `FACTORY_RESET` / `SAFE_BOOT` / `ADD_USER` / `USER_SWITCH` / `CONFIG_DATE_TIME` / `CONFIG_LOCALE` / `CONFIG_PRIVATE_DNS` / `CONFIG_VPN` / `AIRPLANE_MODE` …） |
| 改系统时间绕过作息 | 同上（`DISALLOW_CONFIG_DATE_TIME`；**不存在 `DISALLOW_CONFIG_TIMEZONE`**，时区与日期共用这一个 key） |
| 锁定复核 | 每 3 秒核实"实际锁住了没"；**亮屏广播**立即把锁定界面重新摆到最前 |
| 加固自检与自愈 | `OwnerHardening.apply()/audit()` 可枚举逐项清单（28 项，本轮实测 `26/28 项生效`）+ `LongevityGuard` 服务启动/每 5 分钟巡检/家长手动自检三次重新施加，缺口变化时发 `tamper` 事件 |
| 无障碍被关 | **堵不掉**：DO 也无法强制开启（实测 `Permission denial: Device owners cannot update enabled_accessibility_services`）。**加固开启时会把「无障碍设置页」推走**（`LockWatchdogService.isAccessibilitySettingsPage()` → `GLOBAL_ACTION_BACK`，实测 `am start -a android.settings.ACCESSIBILITY_SETTINGS` 2 秒内被弹回桌面并留下 `tamper`；关掉加固后同一命令能正常进入 = 家长逃生通道）。**唯一的放行口是「家长从应用内点『去开启』」**（`SensitiveScreens.allowTemporarily(…, HINT_ACCESSIBILITY)`，45 秒窗口）—— 不加这条会自锁死：加固默认开、无障碍一旦被关就再也进不去设置页重开。**检测是秒级的**（`onUnbind` 一次性信号，实测同一秒 16:37:14.128），5 分钟巡检只是兜底；自愈做不到 → 上报 `tamper` → 悬浮窗兜底 |
| 进系统设置 / 应用管理 / 卸载界面 | **加固开启时「应用信息页 / 卸载界面」一进去就退回桌面**（`SensitiveScreens` + `LockWatchdogService.blockSensitiveScreen()`，按 `GLOBAL_ACTION_HOME`）。**设置首页是放行的** —— 第一版把 `com.android.settings` 整包封，结果本应用自己的授权引导页（无障碍/电池优化/悬浮窗/使用情况访问/应用详情）全长在设置包里，家长点「去开启」被自己推走，用户实测推翻后收窄。平台**没有**「禁止打开系统设置」的 DO 限制（逐条核对过 android-33 的 `UserManager`），所以这是拦截级而非限制级：**有约 0.1 秒延迟**，真正保证「卸不掉」的仍是上一行的 `setUninstallBlocked` + 受保护包。整包封：`packageinstaller` ×4、各 ROM 安全中心（小米/华为/OPPO/vivo/三星/一加）；设置包**只封应用信息页**，判据必须是**窗口文字**（实测 `event.getClassName()` 就是 `android.widget.FrameLayout`，不是页面名）：类名含 `appinfo`/`uninstall`、或文字里有「应用信息/应用详情」、或同时出现「强行停止」与「卸载」；`permissioncontroller` **只按类名封**（它同时承载权限对话框，整包封会把家长点「允许」的框推走）。放行窗口 45 秒 + 要求「进系统页面那一刻上一个前台还是本应用」，7 个授权入口各开一张。动作节流 800ms、日志 2s、上报 60s。**上机验证**（Android 13 模拟器）：设置首页停在 `SettingsHomepageActivity`、应用信息页与 `ACTION_DELETE` 都回到桌面，日志 `敏感界面封锁：拦截「应用信息」（android.widget.FrameLayout），已退回桌面`。**诚实边界**：放行窗口不校验身份（应用内没有可靠的「家长已认证」信号），而且它**不区分页面** —— 只要「进系统页那一刻上一个前台还是本应用」，应用信息页也会被放行（实测：先从应用内拉起再开应用信息页 → 页面留在前台；直接从桌面拉起 → 被拦下并回到桌面）。所以孩子点应用内的「去开启 / 应用详情」一样能走到应用信息页；但那页上的「强行停止 / 卸载 / 清除数据」由受保护包与设备所有者限制挡着 —— 放行的是「看这一页」，不是「改这一页」 |
| 网址拦截 VPN 被断开 | 设备所有者把本应用钉成永久 VPN：`setAlwaysOnVpnPackage(admin, pkg, /* lockdown */ false)` + `no_config_vpn`。实测：开启 `webBlock` 后 41 秒 `always_on_vpn_app=com.balloondog.agent`、`mAlwaysOnVpnLockdown=false`、VPN 设置页被 `Blocked by your IT admin` 挡死；关闭后 10 秒 `已解除永久 VPN`。**不开 lockdown**（理由见 `android/README.md` §7.3）；**「下拉快捷开关的 VPN 磁贴能否断开」本机没有磁贴、未验证** |
| 使用情况访问被关 | **授不了也补不回**（appop 型），但已接进巡检：限时功能在用时会发 `tamper` |

实测（Android 13 / emulator-5554）：受保护包生效 —— `Uninstall`/`Force stop`/`Clear storage` 三个按钮 `enabled="false"`、`pm disable-user` 报 `Cannot disable a protected package`、`am force-stop` 后 PID 不变（同一命令杀系统时钟立刻生效）；`pm uninstall` → 普通状态 `Failure [DELETE_FAILED_USER_RESTRICTED]`（4 条变体实测同码），**锁屏（lock task）状态**下同一条命令变成 `Failure [DELETE_FAILED_APP_PINNED]`——两条独立拦截路径，两种状态都 exit 1；`pm hide` 回显 `Package com.balloondog.agent new hidden state: false`（exit 0 但没隐藏成功，PID/DO/无障碍全不变）；`pm clear` **本轮未实测**（会清掉绑定与授权、无法回滚，为不污染后续 agent 的验证刻意跳过）；`dpm remove-active-admin` → `SecurityException: Attempt to remove non-test admin`；`kill -9` 后自愈**必发生但耗时不是固定值**：实测 2 / 4 / 10 / 16 / 64 秒（连续被杀时 AMS 对 `START_STICKY` 服务做重启退避，60 秒主看门狗闹钟兜底）——只承诺「分钟级以内」，不承诺毫秒级（16:13:21 杀、16:13:31 `Agent 服务已启动`）。加固自检汇总：`26/28 项生效（2 项本机不支持）`（不支持的是模拟器跳过的 `no_debugging_features` 与 DO 写不进的 `app_auto_restriction_enabled`）；唯一持久缺口是电池优化白名单（无 DPM 静默 API）。**本轮另测**：`adb reboot` 后 `boot_completed=1` 与 agent pid 同在 **+21 秒**，DO 仍 `DeviceOwner,Affiliated`、受保护包与限制项都在、`PROJECT_MEDIA: allow` 跨重启保留；撤销「使用情况访问」的检测与恢复各 **T+284 秒**（`appops set GET_USAGE_STATS ignore` → tamper；`allow` → `管控已恢复正常`）；电池白名单缺口保持 10 分钟**没有**被反复当「新增」上报（此前那 13 条来自引入集合差分之前的旧构建）。**诚实边界**：`hardening_enabled` 目前**没有 UI 入口**（`AgentStore.setHardeningEnabled` 无调用者），家长逃生通道只在代码层成立。详见 `android/README.md` §2.5 / §2.10。

### 2.8 会员体系（三档 + 动态定价）

| 项 | 实现 |
| --- | --- |
| 三档 | `ordinary` / `member` / `super`，字段在 `User.membershipTier` + `membershipExpiresAt` |
| 权益划分 | 会员 = `quizUnlock`（答题解锁）+ `remoteMonitor`（远程拍照/录像/录音/协助/通话短信/截屏）+ `multiDevice`（绑 >1 台）；超级会员 = 会员全部 + `aiInsight`（屏幕洞察 + AI 洞察 + 洞察配置页）。`ENTITLEMENTS` / `FEATURE_ENTITLEMENTS` 在 `server/src/features/membership/membership.constants.ts` |
| 计费周期 | `monthly` / `yearly` / `auto_monthly`；同档续费**顺延**、升级**重新起算**、降级立即生效 |
| 金额 | **不是写死的价目表**：`MembershipPlan.basePriceCents` × 后台可管的 `MembershipPricingRule`，按账号画像（首单/同档续费/设备数/注册天数/升级来源档位）实时算；纯函数引擎 `membership.pricing.ts`，折扣按**原价**算再相加，不可叠加的规则同单只取优先级最高一条，兜底 1 元 |
| 受邀用户定价 | 会员价格与「买家是否被邀请注册」关联：邀请人拿到的返现是平台成本，所以**被邀请注册的账号价格更高**。常规定价算完后，把每条命中的 `MembershipReferralPriceRule`（后台 `/admin/membership/referral-rules` 可维护）各算一个价，**取两者中更高的**；`percent` 表示「在常规定价实付之上上浮 v%」、`amount` 加收固定金额、`fixed` 一口价（低于常规定价时不生效）；`firstPurchaseOnly` / `requireActiveReferral` 两个开关；**对家长端完全隐蔽** —— 接口不下发规则名 / 上浮额 / 命中条数，受邀价生效时连优惠明细和原价一起压平（否则 `15 − 3.75 ≠ 22.5` 会自相矛盾），规则名与理由只在后台试算里出现；订单存 `referralRuleId`/`referralRuleName`/`referralSurchargeCents` 快照（同样不下发家长端） |
| 支付 | **真实渠道管线已落地**（§5.4）：`POST /api/payments/orders/:orderNo/pay` 按渠道取 provider —— 微信（有 openid 走 JSAPI、否则 Native 扫码）与支付宝（`alipay.trade.wap.pay` 跳转）；**回调在最前面挂 `express.raw()` 验签**，坏签 `401` 且订单一动不动；渠道**按各自配置位分别判断**（支付宝配好了、微信还在等审核也能收钱），缺哪个变量由 `GET /api/payments/catalog` 原样下发。`MEMBERSHIP_MOCK_PAY=true`（默认）时仍是模拟支付，只有 `PAYMENT_FAKE_PROVIDER`（仅非生产）走测试渠道；两者都关且渠道未配置时 `payOrder` 如实回 `503` |
| 门禁 | 服务端 `membership.guard.ts` 的 `entitlementGate(key)` / `requireEntitlement` → **403 `MEMBERSHIP_REQUIRED`**（`detail` 带 `requiredTier`/`entitlement`/`currentTier`）；家长端据此渲染升级卡片而不是错误 toast |
| 家长端 | [`/membership`](../src/pages/MembershipPage.tsx) 会员中心（状态卡、三周期报价、规则明细、收银台、充值记录、连续包月开关）；**能不能真付钱只信 `GET /api/payments/catalog`** —— 未配置的渠道如实显示「缺哪个环境变量」，绝不画扫不出来的二维码；已支付订单可自助退款（窗口内）、可申请开票（抬头/税号/邮箱），退款单号与发票状态都从服务端读；`MembershipGate` / `MemberOnlyPage` 负责锁住的功能；「我的」页有入口 |
| 后台 | `/admin/membership` 五页：统计 / 套餐 / 定价规则（含试算）/ 受邀用户定价（含试算）/ 订单；`/admin/payments` 四页：收款统计（含逐渠道配置体检与坏签名计数）/ 订单（查看流水、人工退款）/ 退款 / 发票（开具必须填发票号） |

**验证**：`npm run server:e2e:membership`（180 项，真实库、真算金额）+ `npm run server:e2e:payments`（82 项，
假渠道走通「下单 → 扫码 → 回调验签 → 幂等 → 退款 → 开票」全链，见 §3L）+ 浏览器探针（家长端 120 项、
管理后台 80 项，含会员中心五页、支付管线第 5f 节与后台支付四页）。**诚实边界**：真实商户号没有，网络里跑的是
`PAYMENT_FAKE_PROVIDER`（生产硬拒）；未配置的渠道在界面上如实显示「缺哪个环境变量」，不假装能付。

### 2.9 分享提成（邀请返现）

| 项 | 实现 |
| --- | --- |
| 邀请码 | 每个账号自动生成 8 位码（字符集 `23456789ABCDEFGHJKMNPQRSTUVWXYZ`，去掉 `0/O/1/I/L` 便于口述与手抄）；`User.inviteCode` 唯一，`backfillInviteCodes()` 给老账号补发 |
| 分享入口 | 邀请链接 `/login?mode=register&invite=CODE`（后端 `linkPath` + `publicBaseUrl()`）；家长端 `/referral` 给复制链接、微信/朋友圈分享文案、**当面扫码二维码**（复用 `QrBlock`）。**纯网页没有微信 JS-SDK 授权，分享按钮的真实行为是复制邀请文案**，不做点了没反应的按钮 |
| 绑定 | 注册 / 短信登录都可带 `inviteCode`，**在建号之前校验**：码不存在、邀请人非 active、自己邀请自己 → 400，**不会先建出账号再报错**。活动暂停时**忽略邀请码照常注册**（一条过期的分享链接不该把好友的注册一起挡掉） |
| 首充返现 | 按**有效充值人数**选档：0-3 人 50% / 4-9 人 40% / ≥10 人 20%（截图原文是「邀请人数 = 3 名」，实现成 0-3 人：只邀请 1 人的家长也该拿到返现）；月卡/季卡再保底 50%，年卡套单笔上限 75 元；基数是订单**实付**（含券抵扣后的金额），不是原价 |
| 续费返现 | 被邀请好友后续每次付费都算续费奖励，比例**夹在 [20%, 50%]** 且单笔封顶 75 元 |
| 券里程碑 | 邀请满 3 / 10 / 20 人各发 5 / 30 / 60 元券，超过 30 人**每满 30 人** 100 元；幂等靠 `(userId, sourceRef)` 唯一约束，可用于会员下单抵扣（券在**支付成功**时核销，押在待支付订单上时仍是未使用，同一张券不能同时押两笔订单） |
| 结算 | 返现先落 `pending`，按**当月统计、次月 10-15 日发放**（`settleMonth` + `settleForUser` 惰性收敛，不依赖定时任务）；未结算金额**不计入**提现门槛 |
| 提现 | 四道门槛：≥3 名有效充值好友 + 完成实名认证 + 已结算累计返现 ≥50 元 + 有可提现余额；`availableCents = 已结算 − 已提现 − 审核中`，申请后立刻冻结；提现单状态机单向 `pending → approved → paid` 或 `pending → rejected`，**后台人工审核** |
| 实名 | 只存 `HMAC-SHA256(JWT_SECRET, 'id-card:' + 号码)` 与后 4 位，**不存明文**；校验 GB 11643 校验位与出生日期；同一证件不能实名第二个账号（409） |
| 反作弊 | 自买自返、双方共用同一实名证件、1 小时内绑定 ≥5 人、提现审核超 3 天未处理，在后台「风险排查」里**只列出不自动处罚**（误伤正常家长的代价更大）；充值后退款走 `onOrderReversed` 取消或追回 |
| 家长端 | [`/referral`](../src/pages/ReferralPage.tsx)：收益卡（总收益 / 待发放 / 已提现 / 待提现 / 邀请人数 / 已充值人数）、返现档位与「还差几人到下一档」、提现门槛逐条、邀请记录 / 返现明细 / 提现记录 / 我的优惠券四个 tab、实名与提现弹层、活动说明逐条；「我的」页有入口 |
| 后台 | `/admin/referral` 八页：统计概览 / 提现审核 / 邀请记录 / 返现明细 / 优惠券 / 活动配置 / 规则与阶梯 / 风险排查；阶梯与券规则是**整表替换**（逐条改容易留下自相矛盾的表），保存时校验「必须有一档从 0 人开始」且区间不重叠 |

**验证**：`npm run server:e2e:referral`（159 项，真实库、真算金额、真状态机；脚本开头与结尾都把
活动配置与规则复位成平台默认值，避免一次中断污染下一轮）。**诚实边界**：返现与提现是**站内记账**，
真实打款仍需人工在站外汇出；后台的提现「打款」只改状态，不调用任何支付渠道；风控只做提示，不做自动封禁。

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
代价写在明处：**靠 IP 直连、DoH/DoT、或在应用内自己写死 IP 的请求，拦不到**。（**R3 的 §4.1 之后这一层之上又加了一层**：被拦域名的地址会被 `addRoute` 进隧道丢掉，见 §3G —— 上面这段描述的是 §4.1 之前的真实状态。）

- 匹配规则：`DomainBlocker` 做后缀 + **点边界**匹配，`notexample.com` 不会被 `example.com` 误伤
- 黑名单里写 IP 的条目不参与 DNS 层拦截（DNS 层拿不到 IP 目标）—— 它们走的是 §4.1 的隧道路由层
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
设置页给出**恢复方式**（防止家长自己也找不到入口）。

- **默认就是隐藏**（`ChildDevice.hideIcon` 默认 `true`，迁移 `20261013214520_hide_icon_default_true`
  同时把历史设备回填成 `true`）。孩子端设置页会写「桌面图标：已隐藏（拨号暗码可进入；家长端远程恢复
  或 adb 可重新显示）」，家长端的隐藏/恢复弹窗里写明暗码。
- 隐藏后本机入口是**拨号盘暗码 `*#*#2887#*#*`**（`capability/SecretCodeReceiver` +
  `AndroidManifest.xml` 的 `android.provider.Telephony.SECRET_CODE` / host `2887`），
  孩子端设置页也会显示这行提示。
  ⚠️ 这个广播本身**没有发送方限制**，任何应用都能伪造，所以它只是「不显示在桌面上的入口」
  这种便利性，**不是安全边界** —— 孩子打开主界面不等于绕过管控：真正的执行体是常驻服务 +
  设备所有者策略，主界面只展示状态与自检。文档与家长端文案都已按这个口径改写。
- ⚠️ 改 `schema.prisma` 的默认值后**必须 `npx prisma generate` 并重启后端**：否则运行时用的
  还是旧 client 里内嵌的 schema，新设备照样拿到旧默认值（本轮真的踩到了 —— 改了 schema、
  迁移也跑了，新注册设备的 `hideIcon` 却仍是 `false`，就是漏了这一步）。

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
`PureLogicCheck` **198 项**全通过 —— 其中 20 项是 §1.6 的抗篡改时钟、8 项是 §3.3 的自动解锁时刻探测、15 项是 §3.2 的孩子端剩余时长、17 项是 §3.4 的知情说明、**41 项是 §4.1 的地址规则 / 从 DNS 应答学地址 / TCP RST**、**14 项是 §4.4 的学习模式专用桌面**、**15 项是 §5.2 的孩子端今日任务**，另有第 7 步把说明页与 `AndroidManifest.xml` 逐条对照）。EXIT=0 有意义，因为
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

## 3B. 设备健康可见性（R1）：验证等级一览

同一套「诚实边界」的写法。这一轮**没有可用设备**（`adb devices` 为空列表），
所以设备端那一列只有编译级与 JVM 级证据，**一条设备级断言都没有**。

| 层 | 证据 | 说明 |
| --- | --- | --- |
| 服务端契约 | **✅ 91/91**（`npm run server:e2e:health`） | 未上报过 → 读作「尚未检测」而不是「一切正常」；缺口原文逐字透传；少发的开关是 `unknown` 不是 `false`；设备端自己的 `level` 压过服务端兜底；快照是**整份覆盖**不是累加；四档在线分级；`agent_offline` 去重；`self_check` 走完整指令队列（enqueue → claim → report → 快照刷新） |
| 家长端页面 | **✅ 浏览器 e2e + `e2e:ux` 128/128 + `e2e:responsive` 4/4** | `/device-health`、首页健康条与设备列表健康点在 5 档视口、中英双语下都渲染正确；**英文界面中文泄露检查**（`e2e:ux` 现在把 `/device-health`、`/notifications`、`/notifications/settings` 也一起扫）先后挡下两批**服务端拼好的中文**：先是 `小时前 / 已失联 / 最后一次心跳是`，补完键后又揪出 `HEALTH_CHECK_DEFS` 的 9 条 `why` 长句 —— `i18n:coverage` **扫不到它们**（那些字符串不在 `src/` 里），只有这条浏览器断言能兜住 |
| 分机型修复步骤 | **✅ 服务端 91/91 里的 6 条** | e2e 用两台设备对比：型号 `Xiaomi 2211133C` 走 MIUI 路径、认不出的 `E2E Health Device` 走通用步骤，断言两套文案不同；能自动修的缺口**不给**手动步骤。普通账号绑不了两台设备（多设备是会员权益），所以测试**先解绑再绑第二台** |
| 设备列表健康点 | **✅ 浏览器 e2e** | `GET /api/devices` 一次批量带 `healthLevel` / `openGaps`（不 N+1）；点健康点先 `selectDevice` 再进健康页 —— 健康接口是**按当前设备**取的，直接带 `?deviceId=` 会看到另一台设备的开关 |
| 时钟可信（规划 §1.6） | **✅ JVM 20/20**（`android:crosstest` 里的 `TrustedClock` 用例） / **🟡 设备级未做** | 用例逐条钉死：未锚定退回墙钟、锚定后跟着开机时长走、**把墙钟调回一天前后 `now()` 一步都不动**、调快一小时同样检出、60 秒以内的抖动不报警（别把 NTP 微调当恶意）、设备重启后锚点作废、`serverTime` 为 null/空串/非 ISO 时不崩且不破坏已有锚点、不带毫秒的 ISO 也认。**没跑过的**：`adb shell date` 改时间的设备级验证（`adb devices` 为空） |
| 孩子端 | **🟡 只有编译 + JVM 级** | `HealthReporter.java`、`TrustedClock.java`、`LongevityGuard.Gap`/`gaps()`、`CommandExecutor` 的 `self_check` 分支、`AgentService.reportHealthIfChanged` 都**编进 APK 并编译通过**，但没有在真机/模拟器上跑过一次。`./gradlew :app:compileDebugJavaWithJavac` = EXIT 0 **不等于**它能上报成功 |

**三条 e2e 断言的实现方式要说明白**：四档在线分级里有三条必须让设备「很久没心跳」，
测试是**直接 `prisma.childDevice.update` 把 `lastActiveAt` 改到过去**（`server/scripts/e2e-health.mjs` 的
`SKIP_PRISMA` 分支）—— 拿不到 `@prisma/client` 时它们**显式 `⏭` 跳过并计入跳过数**，
不会假装通过。这与 §3A 那两条跳过的原则一致。

> ⚠️ **`self_check` 必须同时在三个地方出现**：`server/src/features/devices/devices.constants.ts` 的
> `COMMAND_TYPES`、`android/.../CommandExecutor.java` 的 switch、以及设备端常量表。
> 漏掉设备端那一半，症状是「家长端显示已下发、设备毫无反应」——
> 这类「服务端以为发出去了」的假成功，正是本项目反复出现的一类缺陷（见 §4.5 缺陷 3）。

---

## 3C. 站内通知 + 微信推送（R1 的 §2.1 第一档、R2 的第二档）：验证等级一览

| 层 | 证据 | 说明 |
| --- | --- | --- |
| 服务端契约 | **✅ 69/69**（`npm run server:e2e:notifications`） | 四个生产点都真的写进库：设备失联、关键管控失效、安全区进出、孩子申请装应用；**幂等去重**（同一天同一条只写一次）；关掉某一类之后服务端**不再产生**它（不是前端过滤）；未读数、单条/全部已读、删除；偏好是 `(userId, type)` 唯一 |
| 家长端页面 | **✅ 浏览器 e2e + `e2e:ux` 128/128 + `e2e:responsive` 4/4** | `/notifications`（未读角标 + 只看未读 + 全部已读 + 删除 + 点进来源页先标已读）与 `/notifications/settings`（逐类开关 + 微信开关**仅在服务端已配置且该家长已绑定微信时**才出现 + 「发一条测试消息」 + 厂商推送如实标注「不适用」）在两档语言、5 档视口下渲染正确；英文扫描覆盖 `/device-health`、`/notifications`、`/notifications/settings`、`/time-requests` 四条路由 |
| 微信服务号消息 | **✅ 52/52**（`npm run server:e2e:wechat`） | 假微信上游（`server/scripts/mock-wechat-server.mjs`）验证：默认关 → 逐类开关 → `NotificationDelivery` 入队 → 懒投递（点开消息中心或调未读数时补发）→ 渲染后的中文模板内容与跳转 url → 令牌失效（40001）后重取令牌重试 → 失败留 `lastError` 且重试上限 3 → 未绑定微信时 **pending 而非 failed**（绑定后照发）→ 用户间隔离 |
| 厂商推送 | **⛔ 不适用（不是未接入）** | 小米/华为/OPPO 的推送都需要原生 App 的推送 SDK，家长端是移动网页。接口回 `configured: false` 并带一句原因，界面显示「不适用」。**不给一个存下来却永远不会生效的开关** —— 那是在骗家长 |

**通知文案存的是模板，不是拼好的句子**：`Notification.title` / `body` 里存 key 形状的模板
（`{{v0}} 已失联`），变量放在 `titleParams` / `bodyParams` 两个 JSONB 列里，前端渲染时把模板与每个
字符串参数都过一遍 `t()`。**为什么**：生产者若把 `` `${device.name} 已失联` `` 拼好再落库，整句就
不是一条 i18n key，切到英文必然露出中文 —— 这个缺陷被 `e2e:ux` 的英文扫描抓到过一次
（报 `/notifications: 18 个中文字`）。同批还回填了改造前的历史行（迁移
`20261016161000_notification_template_backfill`，认不出的行原样保留）。

**微信通道的设计取舍**：`channels.wechat` 的 `configured` 由环境变量
（`WECHAT_LOGIN_APP_ID` / `SECRET` + `WECHAT_TEMPLATE_ID`）决定，`bound` 看 `User.wechatOpenid`。
没有凭据时投递记录停在 `pending` —— 配好之后同一条会照发，不会因为当时没配就丢掉；
`WECHAT_API_BASE_URL` 只是为了本地对着假上游联调（生产走 `api.weixin.qq.com`）。
**微信消息本身是中文的**：公众号模板消息的文案在微信后台维护，服务端并不知道「家长选了哪种语言」，
硬翻只会让后台配置与代码里的两套文案互相矛盾（这条规则的边界只到家长端界面）。

**一处刻意的产品决定**：提醒写入侧就按偏好拦截，而不是「都写进去、前端不显示」。
家长关掉「安全区进出」之后，未读角标也会跟着干净；否则他会看到角标亮了、点进去却什么都没有。

---

## 3D. 孩子的申请（R2 的 §3.1 / §3.3）：验证等级一览

| 层 | 证据 | 说明 |
| --- | --- | --- |
| 服务端契约 | **✅ 73/73**（`npm run server:e2e:time-requests`） | 12 节覆盖完整链路：孩子提交（201/pending/中文类型名/理由透传）→ 通知 `child_request` 一条（带设备、可跳回 `/time-requests`）→ **幂等**（内容没变不刷 `createdAt`、不新增通知；改时长仍是同一条）→ 参数校验（<5 / >240 / 未知类型 → 422，未认证 401）→ 孩子端轮询 → **隔离三档**（别人的设备 403 / 自己的设备但没有这条申请 404 / 自己的设备确实没有 200 空列表）→ **批准真的下发指令**（`temp_unlock` + 设备 claim + 回报 succeeded 后 `locked=false`）→ 只能改小（申请 30 时批 240 仍给 30）→ 已处理再改 409 → 拒绝→不下发指令 + 家长批注透传 |
| 家长端页面 | **✅ 浏览器 e2e + `e2e:ux` + `e2e:responsive`** | `/time-requests`（待审批 / 已处理两页签、批准弹窗可选时长或全额、拒绝可留言）已加进 responsive 的路由清单与英文界面扫描；首页在有待审批时显示绿色横幅（不是红色告警 —— 这是**孩子在开口**，不是出事） |
| 孩子端锁屏页 | **🟡 只有编译 + JVM 级** | `LockState.probeAutoUnlockAt()` 8 项 JVM 断言（作息锁定探出次日起床时刻、远程锁定/额度耗尽**不编时间**、护眼 `eyeLockUntil` 等于探测值、没锁时返回 now）；`LockScreenActivity` 的申请/轮询/落盘代码编进 APK 并编译通过。**没跑过的**：真机上那句话显示对不对、申请真的发得出去（`adb devices` 为空） |
| 设备级 | **⛔ 未做** | 与 §3B、§1.6 同一处境：模拟器/真机不可用。孩子端「申请 → 家长批准 → 屏幕解锁」这条最有说服力的现场验证**一次都没跑过** |

**两处刻意的产品决定**（都有断言钉着）：

1. **批准不等于解锁**。服务端批准时只下发 `temp_unlock` 指令，`locked` 由**设备回报**收敛。
   如果服务端自己把状态改成 false，家长端会显示「已解锁」而孩子手机上还是锁的 —— 这种
   「服务端以为成功了」的假成功是本项目反复出现的一类缺陷（见 §4.5 缺陷 3）。
2. **家长只能改小**。`grantedMinutes = Math.min(家长给的, 孩子申请的)`。孩子申请 120 分钟、
   家长给 30 是常态；反过来只可能是误触或改包。

> ⚠️ **`delay_lock`（申请延后锁屏）目前孩子端没有入口**：服务端、家长端、e2e 都支持，
> 但锁屏页只用了 `extend_time`。这个类型留给规划 §3.2 的锁屏预告一起做 ——
> 已文档化，不假装孩子已经能用。


## 3E. 孩子端主页（R3 的 §3.2）：验证等级一览

| 层 | 证据 | 说明 |
| --- | --- | --- |
| 服务端契约 | **✅ 43/43**（`npm run server:e2e:child-home`） | 9 节：未认领的设备读 `bound:false` 且求助返回 `success:false / reason:"unbound"` **一个字都不写**（没有收件人的通知不该存在）→ 认领后 `child-home` 回家长称呼与手机号 → 求助同时落一条 `sos` 动态与一条 `child_sos` 通知（命中模板 `'{{v0}} 发起了求助'` 与参数）→ 一分钟内连点第二次**不新增通知但新增动态** → 解绑后 `reason=unbound` → 201 字正文 422 / 无 token 401 → 另一个家长设备的求助不进我的消息中心 → 清理时每台设备各用自己的家长令牌删 |
| 家长端收到求助 | **✅ 走既有通知套件** | `child_sos` 是 `NOTIFICATION_TYPE_DEFS` 的第 7 类（`defaultLevel: 'danger'`，可跳 `/notifications`）；`notificationApi`/偏好页合计 10 类（第 8 类是 §5.1 的家庭成员邀请，第 10 类是 §5.2 的「今日任务」），`server:e2e:notifications` 69/69 与 `i18n:coverage` 0 缺失都覆盖到它 |
| 孩子端主页 | **🟡 只有编译 + JVM 级** | `ChildStatus` 15 项 JVM 断言（crosstest 96 → **111**）：额度 0 / 负数算「没设」而不是「已用完」、已用正好等于额度算用完、剩余 30 秒说「不到 1 分钟」而不是「还剩 0分钟」、已用秒数为负按 0 处理、进度条按剩余百分比且四舍五入；`ChildHomeActivity` + 布局 + 常驻通知按钮编进 APK 并编译通过 |
| 设备级 | **⛔ 未做** | 与 §3B/§3D 同一处境（无可用设备）：真机上主页显示对不对、求助真的弹到家长手机、拨号盘真的打开 —— 都没跑过 |

**两处刻意的设计**（都有断言或代码结构钉着）：

1. **剩余时间必须与锁定判定同一个口径**。两边都读 `store.getDailyLimitMinutes()` 与
   `store.getUsageSecondsToday()`，且都不自己再折算一遍。孩子端主页说「还剩 5 分钟」、
   而锁定判定认为已经用完，比什么都不显示更伤信任 —— 这是本项目里「两个地方各算一遍就一定会漂移」
   的同一类问题（另见 §4.5 缺陷 3）。
2. **「没设额度」与「额度用完」是两句不同的话**。合并成「剩余 0 分钟」会让孩子以为家长刚刚改了设置，
   于是反复刷新、反复问 —— 而实际上他今天本来就可以随便玩。没设额度时说「家长没有设置每日使用时长」。

**后来补上的**：家长给孩子布置的「今日任务」原先排在 R3-f 的 §5.2 之后，现已在 §5.2 交付 ——
同一个 `child-home` 多返回 `childName` 与 `tasks`，孩子端这一页就能勾选（见 §3J）。

## 3F. 知情与同意（R3 的 §3.4）：验证等级一览

| 层 | 证据 | 说明 |
| --- | --- | --- |
| 说明文案本身 | **✅ 169 项里的 17 项** | `GuardianNotice` 是纯 Java：13 类敏感数据逐条断言「有明确结论」（收 8 类 / 不收 5 类），已采集项不会被「不采集 / 不读 / 不上报」否定（但允许交代边界，例如「通话记录会上报、但不含通话录音」），通话与短信两个权限**半授权时不糊成一句「已授权」**，顶部状态行按真实开关生成，紧急呼叫永远放行 |
| 文案与权限是否一致 | **✅ crosstest 第 7 步（机械对照）** | `topics()` 里每一项都带「对应哪个系统权限 + 采不采集」，脚本与 `AndroidManifest.xml` 逐条比对；反向还检查清单里的敏感权限有没有哪一项在说明页里只字不提。**已反证**：把「相机」改成「不采集」→ 第 6 步 128/0 仍全绿、第 7 步立刻失败 |
| 孩子端页面 | **🟡 只有编译级** | `GuardianInfoActivity` + `activity_guardian_info.xml` + 清单条目 + 孩子端主页入口全部编进 APK 并通过 `./gradlew :app:compileDebugJavaWithJavac` |
| 设备级 | **⛔ 未做** | 真机上打开这一页、顶部状态与真实开关是否一致（例如开了周期截屏后这一页是否真的显示「已开启（约每 N 秒一张）」）没跑过 |
| 家长侧同意留痕 | **✅ 服务端 76 项 + 浏览器 10 项** | R4 的 §5.3 已交付（见 §3K）：家长端 `/privacy` 页 + `ConsentRecord` 留同意版本（文本一改就变「需要重新同意」），撤回要密码 + 手打确认词、且立刻停监控并删设备记录。R3 当时刻意不做，是因为「没有同意记录的同意页」比没有更糟 |

**两条刻意的设计**：

1. **文案与页面分离**：正文只在 `GuardianNotice` 里写一遍，Activity 只渲染。否则「断言的文本」
   与「孩子看到的文本」会各自漂移，测试全绿而页面在说别的话。
2. **知情页不联网、也不依赖绑定状态**：它是告知，不是功能。断网或未认领时必须能读完 ——
   一个打不开的知情页等于没有知情页。

**还没做的**：设备级验证；「不同意会怎样」的交互（管控是家长单方生效的，这一页只做告知，
不假装能协商）。家长侧的同意记录与撤回已在 §5.3 交付（家长端 `/privacy`，见 §3K）。

## 3G. 网址拦截补强（R3 的 §4.1）：验证等级一览

| 层 | 证据 | 说明 |
| --- | --- | --- |
| 地址规则与匹配 | **✅ JVM 17 项** | `BlockedAddresses`：IPv4 字面量、CIDR 主机位清零（`10.1.2.3/8` 与 `10.0.0.0/8` 是同一个键，否则会被当成两条路由）、IPv6 字面量、通配与非法输入、`routeFor()` 的路由键去重排序、加密 DNS 解析器清单（1.1.1.1 / 8.8.8.8 / 223.5.5.5 …）与 853 / 784 / 8853 端口判定 |
| DNS 报文处理 | **✅ JVM 20 项** | `DnsMessage.buildQuery`（RD=1、QTYPE=A、QCLASS=IN）与 `parseIpv4Answers`（跳过问题、跟压缩指针走答案、只收 TYPE=A/CLASS=IN/RDLENGTH=4、截断就返回已解析的部分、QDCOUNT/ANCOUNT 有上限） |
| TCP RST 构造 | **✅ JVM 14 项** | `IpPackets.buildTcpReset`：SYN→`RST|ACK`（`ack = seq+1`）、其余→`RST`（`seq = 对方 ack`）、地址与端口对调、IP 与 TCP 校验和都真的重算 —— 十项，逐字段钉死 |
| 设备端接线 | **🟡 只有编译级** | `DnsFilterVpnService` 的地址学习循环（受保护 UDP 直查上游）、`rebuildTunnel()`（新增路由要重建 tun，`generation` 计数保证读包循环不串）、`collectSinkholeRules()`（刻意用 `DomainBlocker.splitEntries` 而不是 `parseList` —— 后者是域名后缀表，会把 IP 丢掉）、`logDroppedConnection()`（每 IP 60 秒限流，写 `web_blocked` 动态）全部编进 APK 并通过 `./gradlew :app:compileDebugJavaWithJavac` |
| 服务端规则归一化 | **✅ smoke 5 项** | `normalizeBlockedEntry`：`https://Gambling.com/lobby?x=1` → `gambling.com`；`1.2.3.4` 与 `10.0.0.0/8` 原样接受；既不是域名也不是 IP 的输入 → **400**。写与删同一套归一化，所以菜单里 `10.0.0.0/8` 那条删得掉（斜杠要转义） |
| 设备级 | **⛔ 未做** | 真机/模拟器上「拦下一条直连」「拦下 853 的连接」的端到端链路没验。模拟器能做的已知办法（DNS 隧道）也不能断言「某个域名真被拦」（§3.1 已记录：隧道一存在所有域名都解析失败，区分不出「被拦」与「隧道不通」） |

**三条刻意的设计**：

1. **只有被拦域名的地址进隧道，不接管全部流量**。全量路由（`addRoute("0.0.0.0", 0)`）意味着
   所有 TCP/UDP 都要自己转发 —— 本实现没有用户态转发栈，结果会是「网站照样能开、整个网络
   又慢又断」。现在的做法是**只路由已知该拦的 /32**，其余流量碰都不碰。
2. **TCP 回 RST 而不是静默丢包**。静默丢包会让浏览器转圈到超时（孩子以为「网卡了」，
   还会反复重试）；一个合法的 RST 让它立刻失败，与「服务器拒绝」无法区分。
3. **边界写在家长看得见的地方**。家长端「网址拦截」弹窗逐条列出拦不到的四类情形，
   而不是笼统说「已开启拦截」。

**还没做的**：设备级验证；家长端**「加密 DNS 解析器」是否要一并拦**目前是隐式的
（清单里的解析器一旦被孩子用上就会计数，但家长不能自己编辑这份清单）；
「已建立的连接不会被打断」是设计而非缺陷，但界面上必须一直写着。

## 3H. 学习模式专用桌面（R3 的 §4.4）：验证等级一览

| 层 | 验证等级 | 证据 |
| --- | --- | --- |
| 该不该接管 / 显示哪些应用 | **✅ JVM 14 项** | `PureLogicCheck.checkStudyLauncher()`：接管条件（学习模式 + 设备所有者，缺一不可）；白名单之外不显示；安全底线的拨号显示、游戏不显示；按名字排序（同名按包名兜底）；配置为空时只剩安全底线；名单里没安装的应用不凭空出现；重复包名只出现一次；空包名 / null 跳过；一个应用都查不到时返回空清单而不是 null；两句文案必须说清「学习模式」「几个应用」「找家长」 |
| 钉住 / 还回桌面 | **✅ 编译级** | `android/app/src/main/java/com/balloondog/agent/capability/StudyHomeController.java`（`addPersistentPreferredActivity` + `clearPackagePersistentPreferredActivities`，只在状态翻转时调用），`LockWatchdogService.syncStudyHome()` 负责翻转，`AgentStore.healStalePolicyCache()` 在换绑时兜底释放；`./gradlew :app:compileDebugJavaWithJavac` 通过 |
| 学习桌面的页面本身 | **✅ 编译级** | `android/app/src/main/java/com/balloondog/agent/ui/StudyHomeActivity.java` + `res/layout/activity_study_home.xml`；每次 `onResume()` 重新求值，不在学习模式就释放并跳回系统桌面；桌面不联网 |
| 设备级 | **⛔ 未做** | 没有真机/模拟器（`adb devices` 为空）：「HOME 真的被钉住」「孩子按 home 出不去」「拨号还能打」都只能上机验证 |

**两条刻意的设计**：

1. **安全底线复用同一份清单**：`StudyLauncher.entries()` 与 `GuardRules.matchStudyMode()` 都用
   `GuardRules.alwaysAllowedPackages()`。两处各写一份迟早漂移成「拦截放行了、桌面却不显示」——
   孩子看得见电话图标却打不出去，或者反过来。
2. **失败不装成功**：`StudyHomeController.hold()` 在不是设备所有者时返回 false，页面顶部与动态里
   都写「桌面没有被接管」。一个看起来接管了、实际没接管的桌面比不接管更糟。

**还没做的**：设备级验证；学习桌面上的「今日任务」卡片（§5.2 的任务模型已经有了，但还没搬到
学习桌面 —— 现在要看清单得走常驻通知进孩子端主页）；
家长端「学习模式下允许哪些应用」仍然走既有的白名单入口（本轮没有新增界面）。

## 3I. 家庭成员与角色（R3 的 §5.1）：验证等级一览

| 层 | 验证等级 | 证据 |
| --- | --- | --- |
| 角色与作用域 | **✅ 服务端 67 项** | `server/src/shared/deviceScope.ts`：`DeviceRole = 'owner' \| 'admin' \| 'viewer'`、`canWrite()`、`requireDeviceAccess` / `requireWritableDevice` / `requireOwnerDevice`；**42 个写接口**从 `resolveDevice` 切到 `resolveWritableDevice`（devices 23 / schedule 4 / mode 7 / quiz 2 / locations 3 / insights 6），`media.routes.ts:28` 是读接口保持不动 |
| 成员 CRUD | **✅ 服务端 67 项** | 邀请（查不到手机号 → 404；已是主人 / 已是成员 / 超上限 → 409）、改角色与备注、移出（读权限**当场**收回）、上限 5 人且**主人不占名额**（第 6 个 409）、手机号打码（`138****8000`）、邀请成功写一条 `device_shared` 通知（模板 + 参数，不是拼好的句子） |
| 家长端界面 | **✅ 浏览器 5 项** | `家长端 5a. 家庭成员（主人视角）`：`/api/devices` 带 `role` / `canWrite` / `canManageMembers`；点「家庭成员」真的开弹窗；第一行是设备主人；手机号形如 `\d{3}\*{4}\d{4}`；邀请表单（手机号 + 备注 + 两档角色 + 邀请加入）。非主人看到的是一句「只有设备主人能邀请或移出家庭成员」，而不是随时会 403 的按钮 |
| 设备级 | **➖ 不适用** | 家庭成员是纯服务端 + 家长端能力，孩子设备侧没有对应实现也不需要：`child-home` 仍然返回**主人**的名字与电话 |

**三个刻意的设计**：

1. **角色只有两档**（`admin` / `viewer`），不做细粒度权限矩阵。真正的分歧是「谁有权改设置」；
   细粒度矩阵必然在某个新加的写接口上漏一格，而漏掉的那一格就是越权。
2. **主人不写进 `DeviceMember`**：主人的身份由 `ChildDevice.userId` 表达，再写一行「主人成员」
   就会冒出「这一行被删掉了怎么办」这种自相矛盾的状态。
3. **界面隐藏不算权限**：家长端只负责不给按钮，服务端每个写接口都自己重新判一次角色 ——
   `e2e-device-members` 里 viewer 的**每一个**写入口都是单独一条断言。

**还没做的**：转让设备主人（`ChildDevice.userId` 现在不可转让）；邀请还没注册的家长（要真实
短信通道 + 待接受状态机，现在做只会做出一个发不出去的假入口）；成员内部的权限细分（要等 §5.2
的孩子档案把「看什么」这件事说清楚）。

## 3J. 孩子档案与今日任务（R3 的 §5.2）：验证等级一览

| 层 | 验证等级 | 证据 |
| --- | --- | --- |
| 档案 CRUD 与作用域 | **✅ 服务端 74 项** | `server/src/features/children/`：`GET/POST /api/children`、`PATCH/DELETE /api/children/:childId`、`PUT /:childId/devices`、`GET/POST /:childId/tasks`、`PATCH/DELETE /:childId/tasks/:taskId`。年龄由出生年份**现算**（没填出生年份就是 `null`，不是 0）；上限 `CHILD_LIMIT = 5` / `CHILD_DEVICE_LIMIT = 10` / `CHILD_TASK_LIMIT = 20`，超了一律 `409`；**越权一律 `404`**（不泄漏「这个 id 存不存在」）—— 连 §5.1 的 `admin` 家庭成员都读不到主人家的孩子档案，但他对设备的写权限完全不受影响 |
| 设备归属 | **✅ 服务端 74 项** | `PUT /api/children/:childId/devices` 是**整组替换**：重复 id 去重、没列出的自动摘掉、跨孩子转移自动从原档案移走；挂一台不存在的设备 → `404` 且**事务回滚**（原来的归属没被清掉）；挂别人家的设备 → `403` |
| 今日任务 | **✅ 服务端 74 项** | 不传日期就是服务器本地日（`YYYY-MM-DD` 字符串，不接受 `2026/01/01`）；按日期查询只返回那一天；完成 → 落 `doneAt`，**重复勾选不会把时间刷成现在**，取消完成会清空 `doneAt`；删掉的任务再查/再改 → `404` |
| 孩子端联动 | **✅ 服务端 74 项** | `GET /api/agent/child-home` 多返回 `childName`（没挂档案就是 `null`）与 `tasks`（今天的清单）；孩子端 `POST /api/agent/tasks/:taskId` 勾完成 → 家长收到一条 `child_task` 通知（标题模板 `'{{v0}} 完成了「{{v1}}」'`、`level: 'info'`、`linkPath: '/children'`、带 `deviceId`），`dedupeKey` 是 `child_task:<taskId>` 所以**同一条重复勾选只发一条**；家长自己代勾**不打扰自己**；没挂档案的设备来勾 → `404` |
| 孩子端界面 | **🟡 只有编译 + JVM 级** | `ChildTasks` **15 项** JVM 断言（crosstest 183 → **198**）：没任务时整块不显示、标题带/不带孩子的名字（空白名字退回「今天的任务」，不出现空的引号对）、已完成数只数勾上的且混进 `null` 也不跑偏、进度三种说法（「家长还没有布置任务」/「已完成 1/3」/全做完换一句夸奖，4/3 不说成 4/3）、勾上/取消与失败各有两句不同的话；`AgentApi`（`ChildHomeResult` 多解析 `childName`/`tasks`、`TaskAck setTaskDone(...)`、缺 id 或缺标题的行丢掉）、`item_child_task.xml`、`activity_child_home.xml` 的任务区、`ChildHomeActivity.renderTasks()/onTaskToggled()`（乐观勾选 + 失败退回 + 请求离开主线程）全部编进 APK 并通过 `./gradlew :app:compileDebugJavaWithJavac`。**没跑过的**：真机上勾一下家长真的收到通知（`adb devices` 为空） |
| 家长端界面 | **✅ 浏览器 10 项** | `家长端 5d. 孩子档案与今日任务（界面增改删）`：档案列出、年龄现算显示「9 岁」、空态文案、界面输入框加一条任务并**回接口核对落库**、点一下勾选完成进度变「已完成 1/1」、设备归属整组替换后设备出现在档案里、删档案后列表不再有它**且设备还在（`childId` 清空）** |
| 响应式 | **✅ 浏览器** | `/children` 已进入 `RESPONSIVE_ROUTES`，跟着 5 档视口 × 27 个页面一起回归 |
| 设备级 | **⛔ 未做** | 与 §3B、§3E 同一处境：模拟器/真机不可用（`adb devices` 为空）。孩子端「勾一条任务 → 家长收到通知」这条链路的**现场**验证一次都没跑过；服务端那一半由 `server:e2e:children` 的 74 项钉死 |

**四个刻意的设计**：

1. **档案是家长账号级的**（`Child.userId`），不是设备级的：一个还没绑设备的家长也要能先把孩子建起来，
   否则「先绑设备才能建档案」会变成一个说不通的顺序要求。
2. **存出生年份、不存年龄**：年龄每次现算。存下来的年龄每年都会悄悄过期一次，而「孩子几岁」
   直接影响家长看到的每一句文案。
3. **设备归属是整组替换**：勾选框就是最终状态，一次请求定下来；做成增删两个接口就会出现
   「加了新设备但旧设备没摘掉」这种半截状态。
4. **删档案不删设备**（`onDelete: SetNull`）：整理档案最怕的是「顺手把孩子的手机也删了」，
   所以确认弹窗里也把这句话写明白。

**还没做的**：按孩子的**年龄适配**（不同年龄给不同的默认管控强度）与**周报**（现在有了实体，
但还没写报表）；孩子端**只能勾**（改「做完了没有」这一个布尔值）：不能自己加、不能删、不能改标题 —— 清单是家长的工具，不是孩子的待办 App。

## 3K. 合规留痕、导出与注销（R4 的 §5.3）：验证等级一览

| 层 | 验证等级 | 证据 |
| --- | --- | --- |
| 同意留痕 | **✅ 服务端 76 项** | `server/src/features/privacy/`：`GET /api/privacy/docs` 给出当前版本与两份必读文档（`guardian_agreement` 家长监护授权与隐私说明、`minor_data_notice` 未成年人个人信息处理告知）+ 代码里的最小必要采集清单；`GET/POST /api/privacy/consents` 记一条同意（`ConsentRecord`：`docType` + `docVersion` + `acceptedAt` + IP + UA）。**版本是文本的指纹**：`PRIVACY_DOC_VERSION` 一改，旧记录仍留着但 `needsReaccept` 变 true —— 不静默续期，也不删旧记录假装从未同意过；同一个版本重复同意是幂等的（不刷时间、不造第二条）；未知 `docType` → `404` |
| 撤回同意 | **✅ 服务端 76 项** | `POST /api/privacy/consents/:consentId/revoke` 要**密码 + 手打确认词**（`撤回同意`），撤回后**立刻**：停监控 + **删除该账号下的设备记录**（含磁盘上的照片与截屏文件）。为什么是删而不是把 `userId` 置空 —— 设备记录（`DeviceEvent`/`MediaAsset`/`ScreenBatch`）按 `deviceId` 归档，设备行还在，下一个绑定它的家庭就可能读到上一家的照片。撤回不动账号、孩子档案与订单 |
| 注销与冷静期 | **✅ 服务端 76 项** | `POST /api/privacy/deletion`：同样要密码 + 手打确认词（`删除我的账号`），当场停监控、删设备记录，并把 `User.deletionScheduledAt` 写到 **7 天后**；`DELETE` 撤销注销（账号救回来，但设备记录已删，要重新绑定设备才能恢复监控）；到期由 `server.ts` 的 `privacyTimer`（每小时 + 启动时）调 `sweepExpiredDeletions()` 真删：**先删磁盘文件，再 `user.delete`** 走外键级联清掉孩子档案、任务、订单与同意记录；撤销后没有可撤销的注销 → `409`，密码错 → `401` |
| 数据导出 | **✅ 服务端 76 项** | `GET /api/privacy/export` 一次给出账号 / 设备 / 孩子 / 任务 / 同意记录 / 通知 / 加时申请 / 指令 / 位置 / 设备事件 / 媒体 / 答题 / 订单 / 返现的**元数据**（每个列表上限 `EXPORT_ROW_LIMIT = 500`，超了把 `truncated` 置 true）；照片与录屏的**文件本身**不在里面；导出成功会写一条 `export` 的 `PrivacyRequest` 留痕 |
| 家长端界面 | **✅ 浏览器 10 项** | `家长端 5e. 合规与隐私（授权 / 采集说明 / 导出 / 注销界面）`：目录接口两份文档 + 清单 ≥10 项、四件事都摆在页面上、采集清单展开后逐项写清用途/保存期限/存放位置、撤回入口在、点「阅读并同意」先给全文再「我已阅读并同意」→ **回接口核对同意记录带版本与时间**、注销确认框要密码 + 手打确认词且写清「立刻做什么 / 7 天后做什么」、关掉确认框**不会**真的排期、导出接口给出账号与清单 |
| 响应式 | **✅ 浏览器** | `/privacy` 已进入 `RESPONSIVE_ROUTES`，跟着 5 档视口一起回归 |
| 设备级 | **➖ 不适用** | 这是纯服务端 + 家长端能力；孩子端「知情与同意」那一半在 §3.4（设备侧），本轮没有新增设备端行为 |

**四个刻意的设计**：

1. **停止监控 = 删设备记录**，不是把 `userId` 置空：置空只会留下一条没有主人的设备行，
   而它名下的照片与事件还在，下一个绑定它的家庭就看得见。这是真实越权路径，不是洁癖。
2. **注销分两段**：申请当场停监控 + 删设备记录，账号数据进 7 天冷静期，到期真的删。
   撤销能救回账号，救不回已删的设备记录 —— 确认框把这句话写明了，而不是让家长以为自己撤销了就回到原样。
3. **同意不是一次性的**：文本一改就换版本号，旧同意自动变「需要重新同意」。
4. **导出给元数据**：JSON 里是「有哪些照片、什么时候拍的」，不是照片本身。

**还没做的**：**管理后台的 `forceUnbindDevice` 只置空 `userId`**，被强制解绑后又被另一家绑定的设备
仍可能读到上一家的历史数据（见 §4）；同意撤回后没有「再同意一次就恢复监控」的直达入口（要重新走绑定流程）；
导出没有「按孩子筛」的细粒度选项。

## 3L. 真实支付渠道（R4 的 §5.4）：验证等级一览

| 层 | 验证等级 | 证据 |
| --- | --- | --- |
| 渠道目录与配置位 | **✅ 服务端 82 项** | `server/src/features/payments/payments.constants.ts` 的 `PROVIDERS` 逐渠道列出必需配置项（微信 7 个：`WECHAT_PAY_MCH_ID` / `WECHAT_PAY_APP_ID` / `WECHAT_PAY_API_V3_KEY` / `WECHAT_PAY_SERIAL_NO` / `WECHAT_PAY_PRIVATE_KEY` / `WECHAT_PAY_PLATFORM_CERT` / `WECHAT_PAY_NOTIFY_URL`；支付宝 4 个：`ALIPAY_APP_ID` / `ALIPAY_PRIVATE_KEY` / `ALIPAY_PUBLIC_KEY` / `ALIPAY_NOTIFY_URL`）。**按渠道各自判断，不做「支付总开关」**——现实里常见「支付宝配好了、微信还在等审核」，一刀切会让能收的钱也收不了。`GET /api/payments/catalog` 原样下发「哪个渠道可用、缺哪个变量、退款窗口几天、提示文案」，前端一个字符串都不自己编 |
| 下单与支付 | **✅ 服务端 82 项** | `payments.provider.ts` 是注册表：配置齐全才拿得到 provider，缺配置抛 `ServiceUnavailableError`（`503`，`message` 点名缺哪个变量）；微信有 `wechatOpenid` 走 JSAPI、否则 Native 扫码，支付宝走 `alipay.trade.wap.pay` 跳转 |
| 回调验签与幂等 | **✅ 服务端 82 项** | `POST /api/payments/notify/:channel` 在 `express.json()` **之前**挂 `express.raw({ type: '*/*', limit: '256kb' })`（验签必须拿到原始报文）。坏签 → `401`，**订单一动不动、且该订单上不产生任何 `kind:'notify' && result:'ok'` 的流水**（只写一条 `bad_signature`，`orderNo` 留空 —— 单号取自未验签的报文、不可信，只把「回调自述单号」记进 `detail`）；未知单 `404`、金额不符 `400`、渠道不符 `400`、未配置渠道 `503`、未知渠道 `404`。成功回调把会员写实（`tier` + `transactionId` + `refundDeadline`），**重投同一笔是幂等的**（`200` 且 `expiresAt` 不变、流水记 `duplicate`） |
| 退款 | **✅ 服务端 82 项** | 自助退款 `POST /api/payments/refunds`：窗口内（`PAYMENT_REFUND_WINDOW_DAYS`，默认 7 天）→ 订单 `refunded` + 会员**按档位收回**（免费档在会员体系里叫 `ordinary`，不是 `free`）+ `refundNo`（`RF<orderNo>`，退款失败后重试复用同一个号，不会重复退款；`REFUND_RETRY_AFTER_MS = 10 分钟` 内不接受重复申请）；二次退款 `409`、超窗口 `403`、**已申请或已开具发票的订单不能自助退款**（先冲红，`409`「这张订单已经申请过发票，退款需要先冲红，请联系客服处理」）；后台人工退款 `POST /api/admin/payments/refunds` 走同一条 `settleRefund`，退失败只记流水、不改状态 |
| 发票 | **✅ 服务端 82 项** | `POST /api/payments/invoices`：未支付 `409`、公司抬头缺税号 `400`、重复申请 `409`、有退款申请/已退款 `409`、超过 `INVOICE_LIMIT_PER_USER = 20` 条 `409`；后台 `PATCH /api/admin/payments/invoices/:invoiceId` 标 `issued` 必须填发票号（否则 `422`），家长端能看到状态与发票号 |
| 后台 | **✅ 浏览器 80 项** | `/admin/payments` 四页（收款统计 / 订单 / 退款 / 发票）：统计页的渠道配置卡与家长端目录**同一个来源**；订单页「查看流水」把坏签名标红、`amount_mismatch`/`channel_mismatch`/`duplicate` 给中文释义；发票页空号码时前端拦下不发请求 |
| 家长端界面 | **✅ 浏览器 120 项（其中支付 5f 节 11 项）** | `家长端 5f. 会员中心与支付管线`：目录接口给出渠道实况与退款窗口、未配置的渠道如实列出缺哪个环境变量、测试渠道只在测试环境出现且写明「不联网、不扣款」、页面把服务端那句实况**原样**显示、充值记录区块在位、收银台给出支付方式与应付金额、只点开收银台不会凭空多出订单、订单接口未登录 `401` |
| 设备级 | **➖ 不适用** | 纯服务端 + 家长端 + 后台能力 |
| 真实渠道 | **⚠️ 无端到端证据** | 支付宝/微信的报文按公开文档实现（v3 签名、AES-256-GCM 回调解密、RSA2 验签与 form-urlencoded 回调），但仓库里**没有商户号**，`server:e2e:payments` 跑的是 `PAYMENT_FAKE_PROVIDER`（`NODE_ENV=production` 时硬拒，生产环境永远不可能走假渠道）。真实渠道能不能收钱，完全取决于部署时那组环境变量 |

**三个刻意的设计**：

1. **渠道实况由服务端下发**：可用性、缺哪个变量、退款窗口都是接口给的，前端不写死 —— 否则界面会说
   「可支付」而接口回 `503`。
2. **坏签的回调不挂单号**：单号取自未验签的报文，不可信；验签失败只写一条 `bad_signature` 流水，
   伪造报文因此无法往某笔真实订单的流水里塞数据。
3. **退款与发票互斥**：已申请（`pending`）/已开具（`issued`）发票就不能自助退款，否则会出现「票已开、钱已退」。
   只拦 `issued` 是不够的 —— 家长刚提交的开票申请拦不住，后台可能已经拿着它去开票了。

**还没做的**：真实商户号接入与对账（需要外部凭据）；部分退款（现在只能整单退）；退款失败的自动重试
（`sweep()` 只负责记录，真正重试要人工再点一次）。

## 3M. 后台运营（R4 的 §5.5）：验证等级一览

| 层面 | 等级 | 证据与边界 |
| --- | --- | --- |
| 契约 | **✅** | [`docs/PLAN-admin-ops.md`](PLAN-admin-ops.md) 是本轮唯一口径：告警是**读时计算**（没有后台扫描任务）、灰度**缺行回落代码默认**、工单**不出站**；三条口径都写清分母、非目标与「不做什么」 |
| 数据模型 | **✅** | 迁移 `20261020000000_admin_ops`（`AlertRule` / `AlertAck` / `SupportTicket` / `RuntimeFlag`）与 `20261020010000_ticket_cascade`（删账号级联删工单 —— 留着工单正文就是「删了账号还留着用户内容」）；`npx prisma migrate status` = up to date |
| 告警大盘 | **✅ 服务端 65 项** | `server/src/features/opsalert/`：五条内置规则（设备失联率 / 管控失效率 / 指令失败率 / 支付异常 / 通知投递失败），阈值、窗口、单位、分母文案可改，且**改动只影响触发、不改指标**；**分母为 0 的比率类是 `null`（界面显示「—」）而不是 `0%`**；样本最多 5 条但事故规模按真实分子条数；确认告警只记录「谁在什么时候看到的」，不改变任何指标、**不写任何家长通知** |
| 灰度开关 | **✅ 服务端 45 项** | `server/src/features/flags/`：数据库**没有这一行 = 用代码默认值**（运维删行不会让功能消失，`usingDefaults` 如实返回）；百分比放量是**稳定哈希**（同一个用户永远落在同一侧），`0%` 全不中、`100%` 全中、白名单压过关闭；五个开关真的接在代码路径上：`pay.channel.wechat` / `pay.channel.alipay`（家长端目录与下单）、`pay.refund.selfservice`（家长自助退款 `403`，后台人工退款不受影响）、`notify.wechat.dispatch`（站内照写，只在投递微信时拦）、`support.ticket.entry`（工单入口） |
| 客服工单 | **✅ 服务端 69 项** | `server/src/features/support/`：分类 / 未关闭上限 / 正文长度全部由服务端下发（前端不写死）；家长视图**不含** `adminId` / `adminName` / `userId` / 优先级；越权读写一律 404；客服回复即认领并推进 `open → waiting`，家长回话 `waiting → processing`；关闭写 `closedAt`、改回 `processing` 时清空；入口开关关掉后**历史工单仍可读**；工单**不支持附件**（不放假按钮） |
| 后台界面 | **✅ 浏览器 80 项（其中 §5.5 的 5c 节 22 项）** | `/admin/alerts`（总览 / 规则 / 确认记录三个视图）、`/admin/flags`（列表 + 白名单 + 稳定哈希预览）、`/admin/tickets`（筛选 / 详情 / 分派 / 回复 / 关闭）—— 都走 `useAsyncData` + `useFilters`，无新依赖、`src/admin/**` 不引用 `@/services/api` |
| 家长端界面 | **✅ 浏览器 120 项（其中 §5.5 的 5g 节 28 项）** | 「我的 → 帮助与反馈」：分类按钮、提示语、正文上限全部来自服务端；**页面上没有任何附件上传入口**；提交后真的落库且家长视图不含客服账号名；能看客服回复、已关闭的工单连输入框都不渲染；入口开关关掉后如实说明且不再给「新建工单」按钮 |
| 还没做的 | — | 告警**不出站**（没有短信 / 电话 / 微信升级，也没有值班与升级策略）；没有告警历史趋势；灰度开关只有 reset 到代码默认，没有审计式回滚；工单没有附件、模板与机器人；`SUPPORT_CONTACT` 没配时家长端只显示「在工单里回复你」 |

## 4. 缺陷与诚实边界（历史记录：修了什么、还剩什么）

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
| 已修：`src/pages/HomePage.tsx` 应用限制弹窗 | 该弹窗的 React 逻辑（候选合并、按包名选中、未选时禁用确认）**曾经没有任何自动化测试** —— 子代理重写完只验到「typecheck + build 通过 + 它调用的服务端契约被 e2e 覆盖」 | ✅ 已在 `scripts/browser-e2e.mjs` 家长端套件新增第 5b 节：挑一台真有应用清单的设备 → 真实点开弹窗 → 断言候选都带合法包名 → 断言未选时「确认」disabled → 选应用 → 断言输入框才出现 → 填 0 断言被拒且弹窗不关 → 填 7 保存 → **回接口核对落库的 `packageName` 与 UI 选中的包一致** → 收尾删规则并切回设备。家长端套件由 25 项增至 **37 项，全绿**（随后第 5c 节的安全区启停又加了 9 条，§5.1 的家庭成员第 5a 节再加 5 条，§5.2 的孩子档案第 5d 节再加 10 条，§5.3 的合规与隐私第 5e 节再加 10 条，§5.4 的会员中心与支付管线第 5f 节再加 11 条，现共 **82 项**） |
| 已修：`src/pages/LocationPage.tsx` 的 `SafeZone.enabled` | 同上一行 | ✅ 已补开关 + 9 条浏览器断言（见上一行）。家长端套件由 37 项增至 **46 项，全绿** |
| 已修：`android/scripts/crosstest/run.sh` | 步骤编号本来就不一致（`1/3`、`2/3`、`3/4`、`4/4`、`5/5`），新加的第 6 步也只写了 `6/6` | ✅ 已统一为 `1/6`…`6/6`；R3 又加了第 7 步（知情说明与清单对照）并同步改成 `1/7`…`7/7`。只影响日志可读性，不影响断言 |
| `android/.../data/AgentStore.java` | `KEY_APP_LIMITS` 是**无包名**的展示串（形如 `抖音=60`），无法支撑逐应用限时判定 | 已新增结构化 `KEY_APP_LIMIT_RULES`；旧键**保留未删**，避免升级丢数据 |
| 已修：`.gitignore` | `android/scripts/crosstest/.work/` 下 **22 个编译产物被 git 跟踪** | ✅ 已加 ignore 规则并 `git rm -r --cached`（**只动索引不删文件**）。现 crosstest 下被跟踪的只剩 12 个源文件 |
| 已修：`android/README.md` §1.1 | 原文写「11 组接口」，漏了 `/agent/apps` 与 `/agent/events` | ✅ 已补齐为 17 组 |
| 已修：截图「不好用」的两层根因（本轮的第 2 个重要新发现） | **缺陷 1（服务端门禁错挂）**：`server/src/features/devices/devices.service.ts` 的 `requestCapture()` 把 `screenshot` 挂到 `screenMonitor`（屏幕洞察，语义是「周期采集 + AI 分析」）上，家长按一次截图会被 400 挡回「请先开启「屏幕洞察」功能」；`FEATURE_DEFS`（`devices.constants.ts`）里**根本没有截图专用键**。家长端还有两处镜像门禁（`src/pages/HomePage.tsx` 的 `CAPTURE_FEATURE`、`src/pages/RemoteHelpPage.tsx` 与 `src/pages/InsightsPage.tsx` 的 `FeatureGate`）。**缺陷 2（设备端真正根因）**：`ScreenCapturer` 只有 MediaProjection 一条路，必须在孩子设备上点系统弹框「Start recording or casting with 气球狗守护?」，没人点就 20 秒超时（logcat `屏幕截图执行失败：等待屏幕共享授权超时，请在设备上点击「立即开始」`）；同一根因也打死了「屏幕洞察」的周期采样（`ScreenSampler.java` 调的就是 `ScreenCapturer.captureScreenshotLowRes`）。授权框被划掉后系统把 appop `PROJECT_MEDIA` 记成 `ignore`，家长侧表现就是「截图一直失败」。 | ✅ **已修并上机验证**：①服务端不再给截图加门禁（注释写清「FEATURE_DEFS 里没有截图开关，能不能截由设备端能力决定」，`remote_photo`/`start_recording`/`start_audio` 的映射未动），家长端 3 处镜像门禁一并撤掉；②新增 `capability/AccessibilityScreenCapture.java`（`AccessibilityService.takeScreenshot`，免授权）+ `accessibility_watchdog.xml` 加 `android:canTakeScreenshot="true"`，`ScreenCapturer.captureScreenshot*` 改为**先试无障碍、拿不到再回退 MediaProjection**；③`e2e-gaps` 新增「8. 屏幕截图」一节做永久回归。**实测（Android 13 模拟器，全程无人点屏幕）**：指令 `succeeded`、68469 B JPEG 可下载、`MediaAsset.kind='screenshot'` 新增、授权页 0 次（logcat `已通过无障碍接口截屏（免授权），66 KB`，耗时 ~270ms）；`ScreenFrame` 20 秒内 14→16。**诚实边界**：无障碍被系统记入 `Crashed services`（装包杀了服务进程）时 `takeScreenshot` 会持续回错误码 1，需重开一次无障碍开关；关掉无障碍就退回要点弹框的 MediaProjection；API 30 以下不可用。**全量回归（2026-10-11）**：`npm run android:e2e:gaps` → **131 通过 / 0 失败 / 2 跳过**（`EXIT_GAPS=0`），第 8 节截图 9 项、第 9 节录像 7 项、第 10 节周期采样 8 项全绿；跑测凭据 APK md5 `7c65b24b28e034b26250621dbc5a36fb`、脚本 md5 `6551098b84a72dac572360e88f25fe9a`、android 子树指纹 `1764100902f6cfee5cd35652e985b9cd4b5eddbf`（跑前跑后一致）。详见 `android/README.md` §10.5 |
| **已修：绑定码每次重装都变，家长的绑定被清掉（本轮新发现）** | `AgentStore.ensureIdentity()` 用 `SecureRandom` **随机**生成 `deviceCode`（`CODE_ALPHABET` 里取 8 位）与 `deviceSecret`（两个 UUID），只存在 SharedPreferences 里。而服务端 `devicesService.registerAgent()`（`server/src/features/devices/devices.service.ts`）是按 `deviceCode` 找记录 + `bcrypt.compare(deviceSecret, existing.deviceSecretHash)` **认设备**，认出来就保留 `userId`（绑定不动）。于是设备端换个随机码 = 服务端当新设备 → 家长端多一台永远离线的幽灵设备，孩子手里这台要重新配对一次。 | ✅ **已修**：绑定码改为**按设备标识推导**（`seed = Settings.Secure.ANDROID_ID + "|" + 本地盐`，`sha256("balloondog/device-code\|"+seed)` 前 8 字节 % 32 映射到去混淆字母表，密钥取 `sha256("balloondog/device-secret\|"+seed)` 的 64 位十六进制；`ANDROID_ID` 在 Android 8+ 按签名+用户+设备作用域，重装与 OTA 都不变）。`resetIdentity()` 先换一个新盐，否则「重置设备身份」推出来的码与原来一样、等于没做；取不到 `ANDROID_ID` 的 ROM 退回随机实现并记日志。**上机验证（Android 13 模拟器）**：删掉 `device_code`/`device_secret`/`device_token`/`device_id`/`bound`/`identity_salt`/`agent_enabled` 七个键（等于全新安装）→ 进程重载后推出同一个码 `GYD6ZLW9` 与同一份密钥；用 Python 按公式外部复算（应用作用域的 SSAID `a90da458651b3fcb`，**不是** `settings get secure android_id` 的 `cc936b75408c48f`）逐位一致；服务端返回 `created:false`、`deviceId` 与 `userId=1`、`boundAt` **全部不变**。详见 `android/README.md` §5.5.1 |
| **已修：全新安装不会自动连服务器注册，必须进一次设置页点保存（本轮新发现，最严重）** | `AgentStore.isAgentEnabled()` 原来默认 `false`（`prefs.getBoolean(KEY_AGENT_ENABLED, false)`），而 `MainActivity.selfHealIfServiceDied()` 只在它为真时才 `AgentService.start()`。全新安装时这个键**根本不存在** → 服务永不启动 → 不注册 → 家长端永远看不到设备。唯一能写入 `true` 的地方是 `SettingsActivity.save()`，所以「装上就是死的，进设置页点一次保存才活」。 | ✅ **已修**：`isAgentEnabled()` 缺省值改为 **`true`**（该键唯一的存在意义是「家长显式停止过」，显式停止会写 `false`）；`AgentApp.onCreate()` 先 `ensureIdentity()`，让设备码在任何界面出现之前就确定。**上机验证**：同上「全新安装」状态下**只**拉起 `MainActivity`（不碰设置页）→ logcat `检测到守护服务未在运行，正在自动恢复` → `Agent 服务已启动` → `注册成功（设备已存在，令牌已续订）`，`agent_enabled` 被写回 `true`。详见 `android/README.md` §5.4 / §5.5.1 |
| 已修：`server/prisma/schema.prisma` 改了默认值但运行时 client 是旧的 | `hideIcon` 由 `@default(false)` 改成 `@default(true)` 后**只跑了迁移、没有重新生成 Prisma client、后端也没重启**，于是 `node_modules/.prisma/client/index.js` 里内嵌的 schema 仍是 `@default(false)`，Prisma 在 create 时显式发 `false`，新注册设备的图标依然不隐藏。 | ✅ 已 `npx prisma generate` + 触发后端重启；用一次性设备码走 `POST /api/agent/register` 实测新建记录 `hideIcon=true`（探针行已删）。**教训**：改 `schema.prisma` 的默认值 = 迁移 + `generate` + 重启，三件事缺一不可 |

| **已修：撤回同意 / 注销把设备行留成孤儿（§5.3 本轮新发现）** | 「停止监控」原来的实现是把 `ChildDevice.userId` **置空**，设备行本身留着。而设备归属的数据（`DeviceEvent`、`MediaAsset`、`ScreenBatch`）是**按 `deviceId` 归档**的 —— 设备行还在，照片、事件、帧图就都还在，只是没有主人。**影响是真实的越权路径**：这台设备（带同一份设备令牌）随后被另一个家庭绑定，新家长的洞察页、媒体库里就会出现上一家的记录；更直接的是，孤儿设备上的设备令牌仍然能通过 `authenticate`，`child-home` 照样返回 200。`server:e2e:privacy` 首跑 72/2 就是被这两条抓住的。 | ✅ **已修**：`privacy.service.ts` 的 `stopMonitoring(userId)` 改成**删除设备行**（先 `purgeDeviceFiles()` 删掉磁盘上的媒体与帧图文件，再在同一个事务里 `childDevice.deleteMany({ id: { in: deviceIds } })` + 把 `activeDeviceId` 清空），返回删除台数并写进 `PrivacyRequest.note`；`hardDeleteUser` 保留 `deleteMany` 作为兜底并改正了错误注释（可空外键不是 SetNull —— schema 里显式写了 `onDelete: Cascade`，孤儿是**先被置空**才没被级联覆盖）。`server:e2e:privacy` 复跑 **76/76**；撤回后设备令牌访问 `child-home` 由 `200 bound:false` 变成 **`401`**（设备不存在了），并新增两条直接查库的断言（`childDevice.findUnique` 为 null、该设备的 `deviceEvent.count` 为 0） |
| **未修：`admin.forceUnbindDevice` 仍只置空 `userId`** | 上面那条越权路径在**管理后台强制解绑**这条路上依然存在：`server/src/features/admin/` 的强制解绑把 `ChildDevice.userId` 置空，设备行与它名下的照片/事件都留着。同一台设备被另一个家庭重新绑定后，新家长可能看到上一家的历史数据。 | ⚠️ **本轮不修**（已记入 `docs/PLAN-roadmap.md` §5.3 的已知缺口）：正确的修法不只是删设备行，而是一套「按设备清数据 + 重置设备侧设置」的动作——强制解绑的语义是**把设备还给它的物理持有者**，不是把设备删掉；删行会让设备端下次注册变成全新设备（绑定码是按 `ANDROID_ID` 推导的，本可以回来），但设备端的本地设置、模式、限额也得一起清，否则等于把上一家的管控留给下一家。这属于独立一轮的工作，先如实标注 |

### 4.3 设备端能力的诚实边界（不是 bug，是方案的天花板）

这几条**写进文档而不是藏起来**，因为它们决定了功能的实际强度：

- **学习模式与插件管控靠无障碍**（按界面可见文本匹配），不是系统 API：
  应用改版换文案会漏拦；看不见 WebView 内容与游戏画布；有几百毫秒延迟；关掉无障碍权限即失效。
- **插件关键词匹配没有端到端验证**：模拟器里没装微信/QQ，端到端复现不出来，
  由 `GuardCheck` 的 16 项覆盖判定逻辑。
- **网址拦截曾经只拦 DNS**（R3 §4.1 之前）：IP 直连、已缓存 IP、DoH/DoT 都拦不到。R3 起地址层已补上（见 §3G），仍未覆盖「换一个没被拦的加密解析器、应用自己写死的无关 IP、已建立的连接」。
- **护眼「距离 / 姿势提醒」没做**：「学习模式专用桌面」没做。
- **应用审核不是系统级审批**：它是「无障碍识别 + 设备所有者限制」的近似。
- **免授权截图靠无障碍**：关掉无障碍就退回「要在孩子设备上点系统弹框」的 MediaProjection
  （没人点即失败）；API 30 以下（`minSdk 24`）不可用；装包更新后无障碍服务可能被系统记进
  `Crashed services`，此时 `takeScreenshot` 会一直回错误码 1，需重开一次无障碍开关才恢复。
  详见 `android/README.md` §10.5。

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
| `android:crosstest` | 作息 2016 点、模式 3024 点、`GuardCheck` 16 项、**`PureLogicCheck` 198 项**（含抗篡改时钟 20 项、自动解锁探测 8 项、孩子端剩余时长 15 项、知情说明 17 项、网址拦截 41 项、学习模式专用桌面 14 项、孩子端今日任务 15 项）+ **第 7 步说明页与清单逐条对照** | 本轮 EXIT=0 |
| `server:smoke`（167 项） | 服务端全接口 | 本轮 167/167 |
| `server:e2e:mode`（64 项） | 模式/护眼/插件/事件/越权 | 上机跑过 |
| `server:e2e:insights` + `:ai`（各 28 项） | 屏幕洞察与 AI 全链路 | 上机跑过 |
| `server:e2e:icons`（32 项） | 应用图标上报→嗅探→签名 URL→缓存与鉴权 | 本轮 32/32 |
| `server:e2e:membership`（180 项） | 动态定价、订单快照、三种周期、续费/升级、自动续费 CAS、门禁 403、受邀用户定价（含取最高价、后台 CRUD 与试算、家长端隐蔽性） | 本轮 180/180 |
| `server:e2e:referral`（159 项） | 邀请码与绑定、首充阶梯、续费返现、券里程碑与幂等、实名哈希、次月结算、提现门槛与审核状态机、券抵扣、后台统计/规则/配置/风控 | 本轮 159/159 |
| `e2e:parent` / `e2e:admin`（120 + 80 项） | 家长端与管理后台 | 本轮全绿 |
| `e2e:ux`（128 项） | 首次引导三步、功能提示、英文界面、登录态健壮性 | 本轮全绿 |
| `server:e2e:health`（91 项） | 健康快照契约、在线分级、分机型修复步骤 | 本轮 91/91 |
| `server:e2e:notifications`（69 项） | 站内通知的生产点（家庭成员邀请归 `device-members`、任务完成归 `children`）、幂等去重、写入侧过滤、模板+参数 | 本轮 69/69 |
| `server:e2e:device-members`（67 项） | 角色分离（owner/admin/viewer）、每个写接口重校验、上限与打码、解绑与成员管理仅主人 | 本轮 67/67 |
| `server:e2e:children`（74 项） | 孩子档案 CRUD / 年龄现算 / 设备整组替换与事务 / 今日任务 / 孩子端勾完成→通知 | 本轮 74/74 |
| `server:e2e:privacy`（76 项） | 同意版本与重签、撤回即停监控并删设备记录（含磁盘文件）、注销冷静期与到期真删、导出元数据与截断 | 本轮 76/76 |
| `server:e2e:payments`（82 项） | 假渠道（仅非生产）走通下单 → 扫码 → 回调验签 → 幂等 → 退款 → 开票：坏签 401 且订单一动不动、未知单 404、金额/渠道不符 400、未配置渠道 503、越权读退 404、退款收回会员且二次 409、超窗口 403、有发票不能自助退款、开具必须填发票号 422、后台统计与流水 | 本轮 82/82 |
| `server:e2e:flags`（45 项） | 运行时灰度开关：代码默认值 / 稳定哈希放量 / 白名单 / 接进支付与退款路径 / reset / 留痕（自带 :4103 后端） | 本轮 45/45 |
| `server:e2e:alerts`（65 项） | 后台告警大盘：五条规则 / 分母为 0 是 null / 三值一致 / 改阈值只影响触发 / 确认不放行也不出站（自带 :4104 后端） | 本轮 65/65 |
| `server:e2e:tickets`（69 项） | 客服工单：提交 → 越权 404 → 分派与回复 → 关闭后不可回 → 入口开关 → 删账号级联（自带 :4105 后端） | 本轮 69/69 |
| `server:e2e:time-requests`（73 项） | 孩子申请→家长审批→真的下发 `temp_unlock` | 本轮 73/73 |
| `server:e2e:wechat`（52 项） | 微信模板消息：配置门禁、懒投递、令牌失效重取、重试上限（自带假上游） | 本轮 52/52 |
| `e2e:responsive`（5 视口 × **27 页**，各 134 项） | 响应式布局 | 本轮全绿 |

**教训**：§3.1 / §3.2 这类"仅存储"的功能，**端到端测试抓不到** ——
因为断言的是"配置能下发、能落盘"，那确实通过了。
要抓住它们，必须断言"设备端产生了拦截动作"，而这类断言目前只覆盖了
学习模式与插件管控（因为那两个功能真的实现了）。

**本轮的同类教训**：新补的 9 项同样**只有编译与纯逻辑测试**，没有一条端到端断言 ——
所以 `§3A` 那张表必须留着。**没有它，这份文档就会从"如实盘点"退化成"报菜名"。**
