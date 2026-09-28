# 气球狗 · 孩子设备端 Agent（Android）

这是气球狗项目的**孩子设备端**原生 Android 客户端。

家长端（React 移动网页）负责「看」和「管」；真正的**锁屏、拍照、截屏、录像、录音、定位**
必须由孩子手机上装着的这个东西执行。它对应后端 `server/README.md`
「设备端 Agent 协议」一节，是把 `server/scripts/device-agent-example.mjs`
那份 Node 模拟实现换成真实系统 API 的版本。

```
家长端 (React)         后端 (Express + Prisma)         本工程 (Android Agent)
     │                        │                              │
     │  POST /api/device/lock │                              │
     ├───────────────────────►│  指令入队 (pending)           │
     │                        │◄───── GET /agent/commands/next?wait=25
     │                        │      长轮询领走 (dispatched)  │
     │                        │                              ├─► DevicePolicyManager.lockNow()
     │                        │◄───── POST /agent/commands/:id/result
     │                        │      收敛为 succeeded          │
```

---

## 1. 它做了什么

### 1.1 完整实现设备端协议（8 组接口）

| 方法 | 路径 | 本工程中的实现 |
| --- | --- | --- |
| POST | `/api/agent/register` | `AgentApi.register()` — 本机生成 `deviceCode`/`deviceSecret` 并持久化，换取 `deviceToken`；重复调用幂等，用于重装 / 重启后恢复身份 |
| POST | `/api/agent/heartbeat` | `AgentService.doHeartbeat()` — 每 15 秒上报真实电量、网络类型、版本 |
| GET | `/api/agent/config` | `AgentService.applyConfig()` — 每 60 秒拉取管控策略并在本地强制执行 |
| GET | `/api/agent/commands/next?wait=25` | `AgentApi.nextCommand()` — OkHttp 长轮询（独立 45 秒读超时），家长一点锁屏孩子手机立刻响应 |
| POST | `/api/agent/commands/:id/result` | `AgentService.flushPendingReports()` — 带重试队列（见 §4.1） |
| POST | `/api/agent/locations` | 首次启动 + 每 5 分钟自动上报；`fetch_location` 指令也会触发一次 |
| POST | `/api/agent/media` | `ApiClient.uploadMedia()` — `multipart/form-data` 上传并把 `mediaId` 回填进指令结果 |
| GET/POST | `/api/agent/quiz/{question,answer}` | `QuizActivity` + `AgentApi` — 答题换使用时长 |

错误体（`{title,status,message,detail,errors,request_id}`）被翻译成 `ApiException`，
`userMessage()` 就是后端给的那句中文，直接展示，不自己拼「HTTP 400」。

### 1.2 把每条指令真正执行掉

| 指令 | 真实动作 | 回报结果 |
| --- | --- | --- |
| `lock` | `DevicePolicyManager.lockNow()` | `{locked:true, systemLock:true}` |
| `unlock` | 设备所有者：`setKeyguardDisabled(true)`；并收起应用内遮罩 | `{locked:false, deviceOwner}` |
| `temp_unlock` | 本地放开 N 分钟，到期自动回锁 | `{until, minutes}` |
| `cancel_temp_unlock` | 立刻恢复锁定 + 恢复系统锁屏 | `{locked:true}` |
| `remote_photo` | **Camera2** 前置（可回退后置）拍 JPEG → 上传 | `{mediaId, sizeBytes}` |
| `screenshot` | **MediaProjection** + ImageReader(RGBA_8888) → JPEG → 上传 | `{mediaId, sizeBytes}` |
| `start_recording` / `stop_recording` | **MediaProjection + MediaRecorder** 录 H.264/MP4 → 上传 | `{recordingId}` / `{mediaId, recordingId, durationSeconds}` |
| `start_audio` / `stop_audio` | **MediaRecorder**(MIC) 录 AAC/M4A → 上传 | `{recordingId}` / `{mediaId, recordingId, durationSeconds}` |
| `fetch_location` | **LocationManager** 取点（含逆地理编码）→ 上报 | `{reported, latitude, longitude, accuracy, address}` |
| `sync_config` | 立即重新拉取并应用管控策略 | `{synced, bound, locked, features}` |

失败一律带可读中文原因（如「相机权限未授予」「屏幕共享授权被拒绝」）回报，
**绝不静默吞掉** —— 否则家长端会显示「已下发」而设备毫无反应。

### 1.3 本地强制执行

- **锁屏遮罩**（`LockScreenActivity`）：设备管理器未激活时退化为全屏遮罩，
  吃掉返回键、常亮、不进最近任务；开启答题解锁时给出「答题换取时长」的出口。
- **每日时长上限**：本地统计可用时长，超出后自动锁定（间隔 30 秒复查）。
- **答题解锁**（`QuizActivity`）：取题 → 选择 → 交卷，判定完全在服务端做，
  客户端拿不到正确答案，改本地状态也没用，下一轮 `config` 就会把真实状态同步回来。
- **开机自启**（`BootReceiver`）：重启后自动恢复守护，否则家长端只会看到设备永久离线。

---

## 2. 强管控体系

上面那一节讲的是「协议通不通」。这一节讲的是需求里真正难的部分：
**锁得住、退不掉、按时锁、解得开**。

### 2.1 锁屏手段全景对比：为什么最终选这套

「锁屏」在 Android 上有很多种做法，但它们的**可绕过程度差别极大**。
下表是实测/推演后的结论，也是本工程分层的依据：

| 手段 | 按 Home | 下拉通知栏 | 最近任务 | 强行停止/撤销权限 | 前提 | 评价 |
| --- | --- | --- | --- | --- | --- | --- |
| **Lock Task（kiosk）** | 挡 | **挡** | 挡 | 挡（配合加固） | 设备所有者 | **系统级，唯一没有绕法的方案** |
| **全屏 `TYPE_APPLICATION_OVERLAY` 悬浮窗** | **挡** | 挡不住 | **挡** | 挡不住 | 悬浮窗权限 | 无设备所有者时的**最强档** |
| Activity 全屏遮罩 | **挡不住** | 挡不住 | 挡不住 | 挡不住 | 无 | 按 Home 就回桌面，**等于没锁** |
| 无障碍服务看门狗 | 挡（有缝隙） | 挡不住 | 挡（有缝隙） | 挡不住 | 无障碍权限 | 可与悬浮窗组合，压小逃逸窗口 |
| 自建 Launcher（HOME intent） | 挡 | 挡不住 | 挡 | 挡不住 | 被设为默认桌面 | 孩子可在设置里改回默认桌面 |
| 随机改系统锁屏密码 | — | — | — | — | 设备所有者 + API 26 | 走系统 keyguard，不依赖任何窗口；风险最高 |

**几个容易踩错的认知**（也是本工程改过一遍的地方）：

1. **全屏悬浮窗确实挡得住 Home 键**，因为 `TYPE_APPLICATION_OVERLAY` 的窗口
   **不属于任何任务栈**，按 Home 只是把任务切到前台，悬浮窗仍在最上层。
   真正会被 Home 切走的是 **Activity** —— 本工程早期版本用的就是 Activity 遮罩，
   那是个实打实的缺陷，现在已改为「无设备所有者时走全屏悬浮窗」。
2. **通知栏是物理上限**。它由 SystemUI 绘制，层级高于任何应用窗口。
   想堵住它只有两条路：设备所有者的 `setStatusBarDisabled`，
   或者……没有别的办法。所以无设备所有者时，孩子下拉通知栏 → 进设置 → 撤销悬浮窗权限，
   这条路径**堵不死**，文档与界面都如实写明。
3. **「取消不掉」这个目标本身有边界**：任何应用层方案都挡不住
   「撤销权限 / 强行停止 / 卸载」。这些只有设备所有者能锁死。

上面这张表不是推演，是在 Android 13 模拟器上逐条实测的（`adb shell input keyevent` +
`dumpsys window` 看焦点窗口）：

```
按 Home 前：mCurrentFocus=Window{454c40 u0 balloon-lock-overlay}
按 Home 后：mCurrentFocus=Window{454c40 u0 balloon-lock-overlay}   ← 没被切走
按最近任务：mCurrentFocus=Window{454c40 u0 balloon-lock-overlay}   ← 没被切走
按返回键：  mCurrentFocus=Window{454c40 u0 balloon-lock-overlay}   ← 没被切走
下拉通知栏：mCurrentFocus=Window{b42f2f7 u0 NotificationShade}      ← 盖住了，符合上表
```

> 顺带一提，验证过程本身也踩了个坑：一开始我用 `dumpsys window windows | grep 标题`
> 判断窗口在不在，结果被 dumpsys 里的<b>历史记录</b>骗了 ——
> `mLastDisplayFreezeDuration=... due to Window{... balloon-lock-overlay}` 这行
> 在窗口早已移除后依然存在，于是脚本判定「已锁定」，截图里却是桌面。
> 现在改成只认 `mCurrentFocus` 与活跃的 `Window #N` 条目。
4. **两条腿走路**：本工程同时支持「不依赖窗口」的随机密码档，
   它的强度来自系统 keyguard 而不是悬浮窗，适合把设备管得最死的场景。

---

### 2.2 无障碍看门狗：把「锁不住的那几百毫秒」压下去

没有设备所有者时，锁定界面是全屏悬浮窗。它挡得住 Home 与最近任务，
但还有一条路能逃出去：**进系统设置撤销悬浮窗权限，或关掉应用本身**。
`LockWatchdogService`（无障碍服务）就是堵这条路的。

它监听前台窗口变化，一旦发现锁定界面被抢走就立刻处理：

| 检测到 | 动作 | 效果 |
| --- | --- | --- |
| 系统设置 / 权限控制器 / 应用安装器 | 持续按返回**逐层推出**，并重新挂上锁定界面 | 撤销权限、关闭服务这条路被堵死 |
| 桌面、其它任何应用 | 重新挂上锁定界面 | 露头即被盖住 |
| 通知栏 / 状态栏 | 仅记日志 | **盖不住**（见下方实测结论） |

**实测结果**（Android 13 模拟器，非设备所有者）：

```
打开「应用详情」页（撤销权限的入口）后：
  2 秒后前台: balloon-lock-overlay
  4 秒后前台: balloon-lock-overlay
  8 秒后前台: balloon-lock-overlay
  12 秒后前台: balloon-lock-overlay      ← 设置界面被逐层推出去了

日志：看门狗：正在把设置类界面「com.android.settings」逐层推出
```

> 刻意<b>不</b>做「同一个包只按一次返回」的去重：设置页是一层套一层
> （应用详情 → 应用列表 → 设置首页），只按一次只是退了一层。
> 节流由 400ms 的最小间隔兜住，不会疯狂按键。

#### 试过但平台不允许的一条路：`TYPE_ACCESSIBILITY_OVERLAY`

理论上无障碍服务可以用 `TYPE_ACCESSIBILITY_OVERLAY` 这个窗口层级，
官方定义是「displayed on top of all other windows, **including the status bar**」——
如果可用，通知栏就再也盖不住锁定界面了。

**实测在 Android 13 上拿不到**，即使用无障碍服务自身的 Context 也失败：

```
BadTokenException: Unable to add window -- token null is not valid; is your activity running?
→ 无障碍层级窗口被系统拒绝，已退回普通悬浮窗
```

代码里保留了「先试强层级、失败自动退回」的逻辑：换到允许它的系统上会自动升级，
不允许则退回并**明确记日志说明能力降级**，不制造「还锁得一样死」的假象。

#### 仍然堵不住的两件事（如实写明）

1. **通知栏**。窗口 Z 序实测：
   `NotificationShade(#3) > StatusBar(#4) > balloon-lock-overlay(#6)`。
   通知栏是 SystemUI 绘制的系统窗口，层级天然高于任何应用悬浮窗；
   也试过用 `GLOBAL_ACTION_BACK` 收起来，**在 Android 13 上根本收不动**。
   要堵住它只有设备所有者的 `setStatusBarDisabled`。
2. **手速**。看门狗有 ~100ms 的事件延迟 + 400ms 节流，
   理论上存在抢在前面关掉它的窗口。要真正没有绕法，只有设备所有者 + Lock Task。

#### 安全底线：紧急呼叫与来电永远放行

`ALLOWED_WHILE_LOCKED` 里的包（紧急呼叫、来电/通话界面）不仅放行，
看门狗还会**主动把锁定界面撤掉**（`LockOverlayWindow.setSuspended(true)`），
否则锁定界面会盖在拨号盘上，孩子照样按不到「拨打」和「接听」。

这是不可关闭的底线：一个能把孩子与紧急呼叫隔开的管控工具是不可接受的。
通话结束后摄像头重新挂上，管控自动恢复。

> 诚实说明：这条路径的代码很简单（白名单 + 让位），但**没有做端到端实测**
> （需要真实来电或真实紧急呼叫），只在代码层面保证。

#### 开启方式与一个现实门槛

开启入口在主界面「防护与保活 → 开启无障碍看门狗」。系统不允许应用自行开启，
必须家长手动去系统设置里打开。

**Android 13 及以上有额外门槛**：侧载安装的应用默认处于「受限设置」状态，
无障碍开关是灰的。需要先：
「应用信息 → 右上角 ⋮ → 允许受限设置」，然后才能打开无障碍开关。
界面上已经把这一步写进提示，否则家长会以为是应用坏了。

---

### 2.3 锁屏强度分四档，按设备实际权限自动分级

家长在家长端选的是「期望强度」，设备端结合自己拿到的权限算出「实际强度」，
并把降级原因如实显示在界面上 —— **绝不允许出现「家长以为锁死了、其实只是个能划走的遮罩」**。

| 实际档位 | 前提 | 能做到 | 孩子能不能绕过 |
| --- | --- | --- | --- |
| `password` | 设备所有者 + Android 8.0+ | 锁定瞬间把**系统锁屏密码**改成随机值 | 不能（连系统锁屏都进不去） |
| `kiosk` | 设备所有者 | Lock Task 把设备钉在锁定页；Home / 最近任务 / 通知栏 / 电源菜单全禁用 | 不能 |
| `admin` | 仅设备管理器 | 能调系统锁屏，但孩子用自己的锁屏密码解锁后就能继续用 | 能 |
| `overlay` | 仅悬浮窗权限 | 全屏锁定页 | 能（Home 键、通知栏） |

实现见 `LockCapability`（分级）与 `LockEnforcer`（落地）：

- 设备所有者 → `LockScreenActivity` + **Lock Task**（`KioskController`）
- 无设备所有者 → **全屏悬浮窗** `LockOverlayWindow`（按 Home 也切不走）
- 两者都会自己每秒复核一次锁定状态并自行退出，**不依赖 Agent 服务存活** ——
  服务被系统杀掉时，孩子不该被永久困在锁定界面上。

**`kiosk` 是默认档，也是推荐档。** 它锁得足够死，同时家长随时能远程解锁，
不存在「拿不回自己孩子手机」的风险。

### 2.4 `password` 最高强度档的三条安全阀

随机改写系统锁屏密码是这套方案里**唯一可能造成不可逆后果**的操作：
一旦网络或后端不可用，手机就再也进不去了，连紧急电话都打不出去。
所以这一档强制三条安全阀，缺一不可（见 `PasswordLockController`）：

1. **必须先在本机设置应急解锁密码**。没设置时 `engage()` 直接拒绝执行，
   由 `LockEnforcer` 降级为 Kiosk，并在日志里写明原因。
   应急密码用 PBKDF2 加盐哈希后**只存本机、绝不上传** ——
   它的用途恰恰是「服务端不可用」，上传就自相矛盾了。
2. **重启后自动清除随机密码**（默认开）。这是有意的取舍：
   孩子重启一次确实能短暂拿回手机，但 Agent 的开机自启会立刻按策略重新锁上；
   而家长在断网时至少有一条确定的复位路径。
3. **锁定页永远保留「应急解锁」入口**，完全离线校验，不依赖 Agent 服务、不发任何网络请求。

此外 Android 8.0 起改写已有密码必须先用 `setResetPasswordToken` 预置令牌，
所以设置应急密码时会顺手把令牌装好（`ensureResetToken`）。

### 2.5 保活：先说清楚它做不到什么

需求是「完全禁止被杀死、被退出、不能被孩子删除停止」。这里必须把边界讲明白：

**用户在系统设置里点「强行停止」后，应用进入 stopped 状态，任何 AlarmManager、
JobScheduler、广播都无法再把它唤醒。** 另一个进程也不行 —— 强停会杀掉该应用
的**所有**进程，所以「双进程互相拉起」在这个场景下是无效的表演，本工程刻意没有做。

唯一可靠的解法是**设备所有者 + 用户限制**（见 `OwnerHardening`），让那个按钮直接变灰：

| 限制项 | 作用 |
| --- | --- |
| `setUninstallBlocked` | 禁止卸载本应用 |
| `DISALLOW_APPS_CONTROL` | 禁止「强行停止 / 清除数据 / 停用应用」 |
| `DISALLOW_FACTORY_RESET` | 禁止恢复出厂设置 |
| `DISALLOW_SAFE_BOOT` | 禁止进入安全模式（安全模式下管控全失效） |
| `DISALLOW_ADD_USER` | 禁止新建用户/访客绕过 |
| `DISALLOW_CONFIG_DATE_TIME` | 禁止改系统时间（否则改时间就能绕过作息表） |

已被实测验证：**设备所有者状态下 `adb shell am force-stop` 杀不掉本应用，PID 不变。**

对「非强停」的进程死亡，则用三层看门狗兜住（`WatchdogScheduler`）：

| 机制 | 周期 | 覆盖场景 |
| --- | --- | --- |
| 前台服务 + `START_STICKY` | 实时 | 低内存回收；系统重建服务 |
| `AlarmManager` 自续期闹钟 | 60 秒 | 厂商 ROM 的后台清理、Doze |
| `JobScheduler`（`setPersisted`） | 15 分钟 | 上述两条都被限制时的兜底 |
| `onTaskRemoved` | 事件 | 用户从最近任务划掉 |
| `BootReceiver` | 事件 | 重启后恢复守护 |

三条链路互相独立：厂商 ROM 通常只限制其中一条，全断的概率低得多。

### 2.6 定时锁屏 / 定时解锁

时间表以**每台设备**为单位存在服务端的 `ScheduleRule` 表里，随 `/agent/config`
下发到设备后**落盘到本机**，之后完全由设备本地时钟驱动 ——
孩子关掉 WiFi、或者后端挂了，作息表照常生效。

规则语义（三端共用一套，见下表后的「为什么只有一处实现」）：

| 字段 | 含义 |
| --- | --- |
| `action` | `lock` 该时段锁定；`unlock` 该时段允许使用 |
| `daysOfWeek` | `0`=周日 … `6`=周六（与 JS `Date.getDay()` 一致） |
| `startMinute` | 从 00:00 起的分钟数，`0..1439`（22:00 = 1320） |
| `endMinute` | `1..1440`；`1440` 表示当天 24:00 |
| 跨天 | `endMinute < startMinute`，例如 `22:00 → 07:00` = 当天 22:00 到**次日** 07:00 |

求值优先级：命中 `unlock` → 允许使用；否则命中 `lock` → 锁定；都没命中 → 不因时间表锁定。
**`unlock` 优先于 `lock`**，所以「整晚锁定 + 中午放行」可以直接叠加表达。

### 2.7 锁定优先级：谁压过谁

`LockState` 是整个 Agent 里**唯一**决定「此刻该不该锁」的地方，
`AgentService` 每秒调它一次。优先级从高到低：

1. **放行期**（家长临时解锁 / 答题奖励 / 家长手动解锁）—— 显式授权压过一切，
   包括时间表与每日额度。否则「家长刚点了临时使用、却被作息表立刻锁回去」会很荒谬。
2. **家长远程锁定** —— 显式指令，压过时间表。
3. **作息时间表** —— 按设备本地时钟求值。
4. **每日可用时长耗尽** —— 本地统计。

> 这里踩过一个真实的坑并已修正：家长先点「解锁」会留下宽限状态，
> 如果之后点「锁定」时不清掉它，远程锁定就会被本地宽限静默压住、根本锁不上。
> 现在 `lock` 指令与 `applyConfig`（当服务端 `locked=true`）都会强制清空本地宽限。

远程「解锁」的宽限被精确设为**下一次本会锁定的时刻**（复用 `LockState.findNextLockAt`，
而不是拍一个「30 分钟」）：这样 22:30 点解锁不会被 22:00→07:00 的作息立刻锁回去，
而如果未来 7 天内都不会锁，就完全不设宽限。

### 2.8 倒计时预告 + 答题解锁（需求 4、5）

锁屏前 N 秒（家长可配，0..600，默认 30）会用**透明悬浮窗**预告，
让孩子知道「马上要锁了，现在还可以去答题换时间」，而不是毫无预警地黑屏。
它是一条半透明的窄条、不抢焦点也不打断操作 —— 真正挡住屏幕的是锁定页。

答题入口在两处都有：**倒计时悬浮窗内**与**锁定页上**。
答对后服务端会延长可用时长，设备端随即解锁；
**倒计时会自动重置** —— 因为 `nextLockAt` 是每秒重算的纯计算结果，
奖励把放行截止时间往后推之后，那个时刻自然变成「奖励到期的那一刻」，
倒计时会在到期前 N 秒重新出现。不需要单独维护一个计时器，也就不会出现
「计时器和实际锁定时间对不上」这类经典 bug。

---

## 3. 构建与安装

### 3.1 环境要求

| 项 | 要求 |
| --- | --- |
| JDK | 17（`JAVA_HOME` 指向 JDK 17） |
| Android SDK | `compileSdk 33` + `build-tools` 任一 ≥ 34 的版本 |
| Gradle | 无需预装，用仓库自带的 `./gradlew`（8.11.1） |

> 本工程刻意锁定 `compileSdk 33`：这是 AGP 8.7 与本机已安装 SDK 组合下最稳的一档。
> 想升到 `compileSdk 35 / targetSdk 34` 见 §6.1。

### 3.2 构建

```bash
cd android

# 指定 SDK 位置（只写一次，local.properties 已在 .gitignore 里）
echo "sdk.dir=$HOME/Library/Android/sdk" > local.properties

./gradlew :app:assembleDebug      # 调试包
./gradlew :app:assembleRelease    # 发布包
./gradlew :app:lint               # 静态检查

# 产物
# app/build/outputs/apk/debug/app-debug.apk
# app/build/outputs/apk/release/app-release.apk
```

调试签名固定放在 `android/keystore/debug.keystore`（密码 `android`，别名 `androiddebugkey`），
不依赖 `~/.android/debug.keystore`，因此任何机器 / CI 上都能直接构建。

### 3.3 安装与首次配置

```bash
adb install -r -g app/build/outputs/apk/debug/app-debug.apk
```

`-g` 会一次性授予全部运行时权限，省去逐个点弹框。装好后：

1. 打开「气球狗守护」，界面顶部会显示 **8 位绑定码**（例如 `RS4B63PG`）；
2. 点「申请采集权限」授予相机 / 麦克风 / 位置 / 通知；
3. 点「激活设备管理器」（**必须**，否则 `lockNow()` 调不动，锁屏会退化成应用内遮罩）；
4. 点「授予悬浮窗权限」（Android 10+ 后台弹锁定页需要它）；
5. 点「忽略电池优化」（否则息屏后长轮询会被 Doze 冻结，表现为「点了锁屏半天没反应」）；
6. 点 **「启动守护」**；
7. 在家长端「设备管理 → 绑定设备」里输入那个绑定码完成配对。

> **后端地址**：默认 `http://10.0.2.2:4000/api`（模拟器访问宿主机的固定别名）。
> 真机请到「设置」里改成开发机的局域网地址，例如 `http://192.168.1.10:4000/api`。
> 输入时不用带 `/api`，会自动补全。

### 3.4 要最强管控就设为 Device Owner

设备管理器只能锁屏。若要做到「临时解锁屏幕」「真正禁用被限制的应用」「锁定时禁止下拉状态栏」，
需要把本应用设为**设备所有者**（只能在设备未添加任何账号时通过 adb 设置）：

```bash
adb shell dpm set-device-owner com.balloondog.agent/.capability.AgentAdminReceiver
```

设置成功后，「锁屏能力」一栏会显示 *设备所有者（最强…）*。

---

## 4. 端到端联调（真机 / 模拟器）

工程自带一份把**真实 APK** 和**真实后端**串起来的联调脚本：

```bash# 前置：后端已启动（npm run server:dev）、模拟器已启动（adb devices 能看到）
# 后端地址可用 API_BASE 覆盖，adb 路径可用 ADB 覆盖
node android/scripts/e2e-agent.mjs
```

它做了 59 项断言，覆盖：

| 阶段 | 验证内容 |
| --- | --- |
| 0–3 | 后端可达、模拟器就绪、安装 APK、清空数据、授予权限 |
| 4 | **通过真实界面**点「启动守护」（`AgentService` 是 `exported=false`，shell 拉不起来，这本身就是正确的安全边界） |
| 5–6 | 设备自助注册、本机生成绑定码、拿到 `deviceToken`；家长登录并用该码完成认领 |
| 7 | 心跳把真实电量与在线状态写回后端 |
| 8–10 | **完整指令闭环**：入队 → `dispatchedAt` 落实 → `succeeded` → 状态落地 → 反向解锁 |
| 11 | 激活设备管理器后回报 `systemLock=true`（真的调了 `lockNow()`） |
| 12 | **远程拍照**：Camera2 出图 → 上传 → 家长端媒体列表可见 → 签名 URL 下载 → **JPEG 魔数 `FFD8` 校验** |
| 13 | **远程录音**：起录 / 停止 / 上传 M4A，文件非空可下载 |
| 14 | **屏幕截图**：自动点掉系统授权框 → MediaProjection 出图 → 下载校验 |
| 15 | **服务被系统杀死后的自愈**：`force-stop` 模拟回收 → 重开界面自动恢复守护 |
| 16 | 幂等：状态未变化时服务端返回 `noop`，不下发冗余指令 |
| 17 | **解绑后令牌失效自愈**：设备用本地密钥自动重新注册，同一绑定码可再次认领 |
| 18–19 | **强管控阶段**：识别设备所有者 → 验证最强防护（禁卸载 / 强制停止无效）→ 建一条 4 分钟后的作息规则 → 等倒计时悬浮窗出现 → 到点进入 **Kiosk 锁定**（`mLockTaskModeState=LOCKED`）→ 验证设备把「实际已锁定」回报给家长端 |
| 20 | **远程解锁**：退出 Kiosk 并关闭锁定页，倒计时悬浮窗同步收起 |
| 21 | **最高强度档**：在设备上设置应急密码 → 切到 `password` 档 → 验证随机改写系统锁屏密码 → 用应急密码**离线**解锁 |
| 22 | **保活**：`kill -9` 杀进程后由 START_STICKY / 看门狗自动恢复（PID 变化） |
| 18 | 清理测试设备 |

> 脚本用 `pm clear` 而不是「卸载 + 安装」来重置状态：设备管理器一旦激活，
> 系统会拒绝卸载，卸载静默失败会让上一轮的设备身份泄漏到下一轮，测试结果就不可信了。

脚本从冷启动开始就是安全的：它会自己等 `adb devices` 出现、等 `sys.boot_completed=1`，
所以模拟器刚敲下启动命令就可以直接跑，不必手动等开机。

**跑之前先设好设备所有者**，否则强管控阶段会明确跳过（不会假装通过）：

```bash
adb shell dpm set-device-owner com.balloondog.agent/.capability.AgentAdminReceiver
```

两个容易被忽略的坑，脚本里已经处理：
- **锁屏会关屏，而关屏时 `uiautomator dump` 拿不到 root node**，所有基于界面文本的
  断言都会莫名失败。所以每次 dump 前都会先 `KEYCODE_WAKEUP`。
- **设备所有者应用无法被 `pm clear`，也无法被 `am force-stop`**（这正是需求 1 的效果）。
  脚本因此改用 `adb root` + `kill -9` + 删 `shared_prefs` 来重置状态。

### 4.1 准备一台模拟器（可选，真机可跳过）

如果本机还没有可用的模拟器，按下面做一次即可。**注意**：`avdmanager create avd` 在
「AVD 目录不可写」的环境（例如受限沙箱、CI）里会失败并提示
`Can't locate Android SDK installation directory for the AVD .ini file`，
这时直接手写 AVD 配置更省事，也更容易复现：

```bash
export ANDROID_HOME=$HOME/Library/Android/sdk
export ANDROID_AVD_HOME=$PWD/android/.android-home/avd      # 把 AVD 与缓存都放工程内
export ANDROID_USER_HOME=$PWD/android/.android-home
mkdir -p "$ANDROID_AVD_HOME/balloon_test.avd"

cat > "$ANDROID_AVD_HOME/balloon_test.ini" <<EOF
avd.ini.encoding=UTF-8
path=$ANDROID_AVD_HOME/balloon_test.avd
path.rel=avd/balloon_test.avd
target=android-33
EOF

cat > "$ANDROID_AVD_HOME/balloon_test.avd/config.ini" <<'EOF'
avd.ini.encoding=UTF-8
AvdId=balloon_test
abi.type=arm64-v8a
hw.cpu.arch=arm64
hw.cpu.ncore=4
hw.ramSize=2048
disk.dataPartition.size=4G
hw.lcd.density=440
hw.lcd.width=1080
hw.lcd.height=2340
hw.keyboard=yes
hw.gpu.enabled=yes
hw.gpu.mode=swiftshader_indirect
hw.camera.back=emulated
hw.camera.front=emulated
hw.audioInput=yes
image.sysdir.1=system-images/android-33/google_apis/arm64-v8a/
tag.id=google_apis
PlayStore.enabled=false
EOF

# 启动（无窗口、无声、每次全新启动）
"$ANDROID_HOME/emulator/emulator" -avd balloon_test \
  -no-window -no-audio -no-boot-anim -no-snapshot \
  -gpu swiftshader_indirect &
```

需要 `system-images;android-33;google_apis;arm64-v8a`（x86_64 主机换成对应 ABI）。
没有的话用 sdkmanager 装，或直接从
`https://dl.google.com/android/repository/sys-img/google_apis/` 取对应 zip 解压到
`$ANDROID_HOME/system-images/android-33/google_apis/<abi>/`。

> `hw.camera.front=emulated` 是必须的：远程拍照与截图这两项断言依赖模拟摄像头出图。
> `-no-snapshot` 保证每次都从干净状态启动，避免上一轮的授权状态影响结果。

联调结束后关掉模拟器：

```bash
adb emu kill
```

### 4.2 作息求值的交叉验证（跑完联调建议再跑一次）

「此刻该不该锁」这套语义被实现了两遍：后端用来给家长端做预览，Android 用来在本地强制执行。
两份实现一旦漂移，就会出现「家长端显示已解锁、孩子手机却锁着」这类最难排查的问题。
跨天区间（22:00→次日 07:00）与 unlock 优先于 lock 这两处极易写错，所以单独做了逐点比对：

```bash
bash android/scripts/crosstest/run.sh
# 比对采样点：2016 个    不一致：0 个
# ✅ Android ScheduleEngine 与后端 evaluateSchedule 结果完全一致
```

它用 6 组刁钻规则（跨天单日、整天 00:00→24:00、unlock 覆盖 lock 等）
在 7 天里每 30 分钟采一个点，直接跑**真实的** `ScheduleEngine.java`
（用最小 `androidx` / `org.json` 桩类在普通 JVM 上编译），不复制逻辑。

---

## 5. 几个值得说明的设计决定

### 5.1 指令结果必须**可靠**送达（重试队列）

服务端只有在收到设备回报时才会把指令从 `dispatched` 推到 `succeeded`。
如果这一瞬间网络抖动导致回报失败、而客户端只 try/catch 一次就放弃，
家长端会一直停在「执行中」，直到 `COMMAND_TTL_SECONDS`（默认 300 秒）被清理成 `expired`
并回滚状态 —— **明明已经锁屏了，家长看到的却是「设备超时未响应」**。

所以 `AgentService` 把没送出去的结果放进 `pendingReports` 队列，
之后每轮主循环重试一次（最多 20 次）。这是本工程里最重要的一处可靠性设计。

### 5.2 MediaProjection 那套绕不开的顺序

平台同时要求三件事，缺一不可：

1. **先有前台服务**：Android 14 要求先以 `mediaProjection` 类型进入前台，
   才能调用 `getMediaProjection()` —— 由 `ScreenCaptureService` 承担；
2. **先有用户授权**：授权令牌只能由 Activity 通过 `startActivityForResult` 拿到 ——
   由透明的 `ProjectionConsentActivity` 承担；
3. **复用投影实例**：Android 14 起一份授权只能换一次 `MediaProjection`，
   `ScreenCapturer` 把它缓存在静态字段里反复使用，「连截两张图」不会弹两次授权框。

截图用 `RGBA_8888` 而非 YUV，省掉色彩转换、不容易出色偏，但**必须处理 `rowStride` padding**，
否则画面会斜切（见 `ScreenCapturer.toBitmap()`）。

### 5.3 前台服务类型按「实际拿到的权限」动态决定

Android 14 规定：声明了 `camera` / `microphone` 类型的服务若缺少对应运行时权限，
`startForeground()` 会直接抛 `SecurityException`。所以 `AgentService` 只挑**已经授权**的类型
参与 `startForeground`（`startForegroundCompat()`），能起来是第一位的。

### 5.4 「守护在跑」用进程内静态标志判断，而不是时间窗口

只看 SharedPreferences 里的 `agent_enabled` 是不够的：进程被系统回收、被用户在系统设置里
「强行停止」、被 ROM 后台清理时，`onDestroy` 根本不会执行，那个布尔值会一直停在 `true`。
于是界面显示「守护运行中」，而家长端看到设备一直离线 —— 用户完全被蒙在鼓里。

也不用「最后活跃时间 + 时间窗口」推断：窗口取小了会把正在长轮询（最长挂起 25 秒）的服务
误判成已死，取大了又会在服务刚被杀掉的那几十秒里继续报「运行中」。
`MainActivity` 与 `AgentService` 同进程，**直接读静态标志 `AgentService.isRunning()` 最准**。

配套的 `MainActivity.selfHealIfServiceDied()`：界面一打开发现「开过守护但服务没在跑」，
就自动把它拉起来 —— 用户明明授权过，不该因为一次系统回收就永久失效。

### 5.5 设备被解绑后自动重新注册

解绑会删掉服务端的设备行，设备令牌随即 401。协议没有「设备申诉」接口，
但设备本地保存着 `deviceCode + deviceSecret`，而 `POST /agent/register` 对
**同一对密钥是幂等的**。因此设备会自己重新注册成一台新设备（沿用原绑定码），
家长用同一个绑定码就能再次认领 —— 重装、长期离线、令牌过期都能自愈。

> 唯一的例外：如果设备码被别人抢先注册、密钥对不上，服务端返回 403。
> 这时客户端**不会**自动换身份（那会让家长端留下一台永远离线的幽灵设备），
> 而是明确提示去「设置 → 重置设备身份」，由人决定。

### 5.6 儿童隐私的基本尊重

执行采集类指令前，先发一条「家长操作：远程拍照」的本机通知。
这不是技术必需，但让孩子的设备不悄悄变成监控工具，是产品该有的底线。

---

## 6. 目录结构

```
android/
├─ settings.gradle / build.gradle / gradle.properties
├─ gradlew / gradle/wrapper/            # Gradle 8.11.1 wrapper
├─ keystore/debug.keystore              # 工程内调试签名，保证任何机器都能构建
├─ docs/screenshots/                    # 界面效果截图（node scripts/capture-screens.mjs）
├─ scripts/
│  ├─ capture-screens.mjs               # 把倒计时悬浮窗 / 锁定界面截成图片，并实测 Home 键行为
│  ├─ e2e-agent.mjs                     # 端到端联调（真机/模拟器 + 真实后端）
│  └─ crosstest/                        # 交叉验证：Android 与后端的作息求值是否一致
│     ├─ run.sh                         #   bash android/scripts/crosstest/run.sh
│     ├─ reference.ts                   #   用后端实现生成参考结果
│     ├─ CrossCheck.java                #   用真实 ScheduleEngine 复算
│     ├─ compare.mjs                    #   逐点比对，不一致则退出码非 0
│     └─ stubs/                         #   最小 androidx / org.json 桩类
└─ app/src/main/
   ├─ AndroidManifest.xml               # 权限、前台服务类型、组件声明
   ├─ java/com/balloondog/agent/
   │  ├─ AgentApp.java                  # 注册令牌供给（含 401 自动续订）
   │  ├─ data/
   │  │  ├─ AgentStore.java             # 设备身份 / 锁定态 / 用量 / 配置缓存
   │  │  ├─ Constants.java              # 协议路径、节奏参数、Prefs 键
   │  │  └─ EventLog.java               # 进程内运行日志环（界面上直接看）
   │  ├─ model/                         # AgentCommand / DeviceConfig / RemoteQuestion / MediaRef
   │  ├─ net/
   │  │  ├─ ApiClient.java              # OkHttp：普通 / 长轮询 / 上传三套超时 + 错误体翻译
   │  │  └─ AgentApi.java               # /api/agent/* 的类型化封装
   │  ├─ capability/
   │  │  ├─ CommandExecutor.java        # 指令 → 真实系统动作 + 结果回填
   │  │  ├─ LockState.java              # 「此刻该不该锁」的唯一判定处（纯计算）
   │  │  ├─ LockEnforcer.java           # 把判定落地成设备行为（锁屏/解锁/悬浮窗）
   │  │  ├─ LockCapability.java         # 强度分级：期望强度 → 实际生效 + 降级原因
   │  │  ├─ KioskController.java        # Lock Task（kiosk）：真正退不出去的锁定
   │  │  ├─ OwnerHardening.java         # 设备所有者加固：禁卸载/强停/恢复出厂/安全模式
   │  │  ├─ PasswordLockController.java # 最高强度档：随机改系统锁屏密码 + 应急密码
   │  │  ├─ ScheduleEngine.java         # 作息求值（与后端同语义，已交叉验证 2016 点）
   │  │  ├─ LockController.java         # 锁屏原语：lockNow / 状态栏 / keyguard
   │  │  ├─ PhotoCapturer.java          # Camera2 拍照
   │  │  ├─ ScreenCapturer.java         # MediaProjection 截图 / 录像
   │  │  ├─ ProjectionConsentActivity.java
   │  │  ├─ AudioRecorder.java          # MediaRecorder 录音
   │  │  ├─ LocationReader.java         # 定位 + 逆地理编码
   │  │  └─ AgentAdminReceiver.java     # 设备管理器接收器
   │  ├─ service/
   │  │  ├─ AgentService.java           # 前台服务 + 网络主循环 + 1 秒锁屏 ticker
   │  │  ├─ WatchdogScheduler.java      # 保活：AlarmManager 自续期 + JobScheduler
   │  │  ├─ LockWatchdogService.java    # 无障碍看门狗：推走设置界面、拉回锁定界面
│  │  ├─ WatchdogReceiver.java       # 保活看门狗与作息边界的接收器
   │  │  ├─ AgentJobService.java        # JobScheduler 兜底任务
   │  │  ├─ ScreenCaptureService.java   # mediaProjection 类型前台服务外壳
   │  │  ├─ AgentNotifications.java     # 通知渠道与常驻通知
   │  │  ├─ ForegroundCompat.java       # startForeground 跨版本兼容
   │  │  └─ BootReceiver.java           # 开机自启
   │  └─ ui/
   │     ├─ MainActivity.java           # 绑定码 / 状态 / 权限 / 防护保活 / 运行日志
   │     ├─ SettingsActivity.java       # 后端地址、设备名、重置身份
   │     ├─ LockScreenActivity.java     # 锁定页（kiosk + 答题 + 应急解锁 + 自行复核）
   │     ├─ CountdownOverlay.java       # 锁屏前透明倒计时悬浮窗
│     ├─ LockOverlayWindow.java      # 全屏锁定悬浮窗（按 Home 切不走）
│     ├─ EmergencyUnlockActivity.java # 从悬浮窗打开的离线应急解锁页
│     ├─ LockWatchdogBridge.java     # ui ↔ service 的窄接口，避免包间循环依赖
   │     └─ QuizActivity.java           # 答题解锁
   └─ res/                              # 中文文案、主题、矢量图标、布局
```

---

## 7. 已知边界

**这一节请务必读。** 下面这些不是「没做完」，而是受平台或协议限制、
必须在文档里讲清楚的地方 —— 否则就会出现「家长以为在管，其实没管」的静默失败，
这正是后端 README 反复强调要避免的问题。

### 7.1 后端协议层面的缺口（客户端无法绕过）

1. **`usedTodayMinutes` 没有设备端写入接口。**
   `/api/agent/config` 只读 `timePlan.usedTodayMinutes`，设备端无法上报已用时长。
   因此「每日时长上限」目前**只在设备本地统计与执行**，家长端看到的
   `usedTodayMinutes` 始终是 0。要修需要后端新增一个上报接口。

2. **`fetch_location` 与 `sync_config` 没有家长端触发入口。**
   指令白名单里有这两个类型，但家长端 `/api/device/*` 没有任何接口能把它们入队。
   本工程仍然实现了它们的执行逻辑（`fetch_location` 也用于自动位置上报），
   但家长无法主动触发「立即获取位置」。

3. **`callSms`（通话短信）在同屏、远程协助一样只有开关，没有协议。**
   设备端拿不到「取通话记录 / 短信」的指令，因此本工程没有实现这部分 ——
   真要做，需要先在后端定义指令类型与返回结构。

### 7.2 做不到的事（说清楚，比假装做到重要）

| 想做的事 | 能不能做到 | 说明 |
| --- | --- | --- |
| 阻止孩子「强行停止」 | ✅ 设备所有者下可以 | `DISALLOW_APPS_CONTROL` 会让那个按钮变灰。**已实测**：`am force-stop` 杀不掉，PID 不变。非设备所有者时做不到，因为强停会杀掉该应用的所有进程，任何保活手段（含双进程互拉）都无效 |
| 阻止孩子卸载 | ✅ 设备所有者下可以 | `setUninstallBlocked`。非设备所有者时做不到 |
| 阻止孩子在设置里恢复出厂 | ✅ 可以挡住菜单路径 | `DISALLOW_FACTORY_RESET`。但**挡不住 Recovery 模式下的恢复出厂**（硬件按键组合），这是平台边界 |
| 阻止孩子关机 / 长按电源键强制重启 | ❌ 做不到 | Android 没有给应用这个权限。重启后由 `BootReceiver` 立刻恢复守护，管控会重新生效 |
| 绕过后台启动限制弹锁定页 | ⚠️ 需要悬浮窗权限 | Android 10+ 限制后台启动 Activity；`SYSTEM_ALERT_WINDOW` 是标准豁免路径 |
| 锁定期间下拉通知栏 | ❌ 非设备所有者时做不到 | 通知栏层级天然高于应用悬浮窗；`TYPE_ACCESSIBILITY_OVERLAY` 实测被系统拒绝，`GLOBAL_ACTION_BACK` 也收不动。只有设备所有者的 `setStatusBarDisabled` 能堵住 |
| 锁定期间进设置撤销权限 | ✅ 无障碍看门狗可以 | 持续按返回逐层推出设置界面，并重新挂上锁定界面（已实测） |
| 息屏后保持长轮询 | ⚠️ 需要电池优化白名单 | 引导页有「忽略电池优化」按钮；三层看门狗进一步兜底 |
| 网址拦截 | ⚠️ 已同步未拦截 | 需要 `VpnService`（全局）或设备所有者策略。当前只做到「同步到本地 + 可查询」 |
| 应用限额 / 按应用限时 | ⚠️ 已同步未限时 | `LockController.setApplicationHidden` 已实现，但未接入 `PACKAGE_USAGE_STATS`（需用户在系统设置里单独授权「使用情况访问」） |
| 防止孩子改系统时间绕过作息 | ✅ 设备所有者下可以 | `DISALLOW_CONFIG_DATE_TIME`。否则改时间确实能绕过时间表 |
| 屏幕截图 / 录像 | ✅ 可用，但每次新会话要授权 | 系统强制每次新的 MediaProjection 会话都要用户点一次授权框，无法绕过（Android 14 起更严格） |
| 解除系统锁屏密码 | ✅ 最高强度档下可以 | 通过预置的重置令牌清除被改写的密码。注意：不清除就无法解除，这正是该档位强度的来源 |

### 7.3 本工程自身的取舍

- **指令串行执行**：拍照 / 录像 / 录音共用相机、麦克风与投影，并发只会互相抢占，
  因此 `AgentService` 用单线程顺序执行指令。代价是一次慢采集会推迟下一条指令的领取。
- **录屏分辨率上限 1280 长边**：全分辨率录制在部分机型上 `MediaRecorder.prepare()` 会直接失败，
  且家长端只需看清画面。截图仍按屏幕原始分辨率。
- **拍摄固定用前置摄像头**（无前置自动回退后置）：远程拍照的意图通常是「看看孩子现在在干什么」。
- **未做混淆**：release 包 `minifyEnabled false`，便于排查线上问题；要上架请自行开启并补 keep 规则。
- **锁定期间禁用状态栏**（设备所有者）：这是堵住「下拉通知栏绕过」的必要手段，
  但也意味着锁定期间孩子看不到通知。解除锁定会自动恢复。
- **锁屏强度降级只提示、不阻断**：家长选了 Kiosk 但设备只是设备管理器时，
  设备端会在界面上写明「已降级为中：能调系统锁屏，但孩子用自己的密码解锁后就能继续用」，
  而不是拒绝工作。家长需要看到真实强度，而不是一个失败弹窗。

---

## 8. 常见问题排查

界面上的「运行日志」会实时显示注册、心跳、领指令、执行结果的完整过程 —— **先看它**。

| 现象 | 原因与处理 |
| --- | --- |
| 一直显示「等待绑定」 | 家长还没在家长端输入绑定码；或「设置」里的后端地址不对（注意真机不能用 `10.0.2.2`） |
| 点「启动守护」没反应 | 通知权限被拒时前台服务仍会运行但不出通知；若服务反复被杀，请检查电池优化白名单 |
| 家长点了锁屏，孩子手机没锁 | 设备管理器没激活 → 只弹了应用内遮罩；界面「锁屏能力」一栏会如实写明当前强度 |
| 截图/录像指令失败 | 系统授权框被拒绝或没点到；Android 14 起每次新会话都要重新授权。日志里会写明「屏幕共享授权被拒绝」 |
| 拍照失败 | 相机权限未授予，或相机被其它应用占用（日志会写明） |
| 提示「设备密钥不匹配」 | 设备码被别人抢先注册，或服务端数据库被重置。到「设置 → 重置设备身份」，用**新的**绑定码重新配对 |
| 家长端显示设备「离线」 | 心跳超过 3 分钟没到。检查网络、电池优化白名单，以及后端是否在跑 |
| `uiautomator dump` 报 `null root node` | 有残留的系统弹框盖在最上层（联调脚本会自动清理）；重启模拟器可彻底恢复 |

---

## 9. 与仓库其余部分的接口

- **只依赖** `/api/agent/*`，不碰任何家长端接口，也不碰管理后台。
- 设备令牌（`kind: 'device'`）与家长令牌、管理员令牌互不通用 —— 这是后端
  `middleware/auth.ts` 里的严格 `kind` 断言，本工程不做也不应做任何绕行。
- 媒体只能以「设备令牌上传、家长令牌 / 短时效签名下载」两条路径访问，
  本工程仅使用上传路径。
