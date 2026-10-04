# 屏幕行为 AI 洞察 —— 实现计划

> 本文档是「周期截屏 → 打包上传 → AI 分析 → 家长端洞察与限制」整套功能的实施计划。
> 三端（Android Agent / server / 家长 web）共用同一份契约，改契约时三处一起改。

---

## 0. 需求拆解与对应实现

| # | 需求 | 实现位置 |
| --- | --- | --- |
| 1 | 服务每几秒核实锁屏状态；锁定时若屏幕被点亮就再锁一次 | Android `LockReassertor` + `AgentService` ticker（3 秒） |
| 2 | 周期截屏 → 降分辨率压缩 → 每 10 张打一个包 → 上传 | Android `ScreenSampler` + `FrameBatchUploader` |
| 3 | 服务端接收打包截图的 API | `POST /api/agent/screen-batches` |
| 4 | AI 分析图片：在用什么 app、做了什么、游戏进度与结算画面 | `server/src/features/insights/`（AI provider 可插拔） |
| 5 | AI 总结详细记录，用于整体行为分析 | `ScreenInsight` 表 + 家长端时间线 |
| 6 | 家长端可设置异常提醒（未成年内容/被骗/情绪/沉迷/高额消费） | `ScreenMonitorConfig.alerts` + `/api/alerts` |
| 7 | 玩几局 / 看几集 → 到量锁屏 | `UsageBudget` + `UsageEpisode` + 超限下发锁屏指令 |
| 8 | 屏幕答题：按屏幕内容 + 年级实时出题 | `ScreenQuizQuestion` + `/api/agent/screen-quiz/*` |

**非目标（本轮不做，但已在计划里标出）**：图像 OCR 的本地离线模型、家长端播放原图（隐私上刻意不做）、
多设备横向对比报表。

---

## 1. 数据模型（Prisma）

```
ScreenMonitorConfig   每台设备一份：截屏开关/间隔、每包张数、AI 开关与采样数、留档天数、5 类异常提醒开关、屏幕答题开关
ScreenBatch           一个上传包：设备、起止时间、期望张数/实际张数、状态(pending/analyzing/done/failed/skipped)、
                      字节数、磁盘相对路径、失败原因、AI 供应商与模型、耗时
ScreenFrame           包内单张：batchId、序号、抓取时间、前台包名(设备端尽力上报)、磁盘路径、字节数
ScreenInsight         AI 对一个包的结论：summary、activities[]、games[]、videos[]、contentFlags、riskLevel、
                      provider、model、tokens、rawJson
UsageAlert            异常提醒：设备、类型、严重度、标题、依据、关联 insight、已读时间
UsageEpisode          用量片段：kind(game_round/video_episode)、应用名、计数、置信度、发生时间、证据、关联 insight
UsageBudget           家长设的上限：kind、应用名(可空=全部)、每日上限、是否启用
ScreenQuizQuestion    由屏幕内容生成的题：题干、选项、答案、解析、年级、主题、来源 insight、是否已被使用
```

设计要点：

- **批次是分析的最小单位**。「这段时间孩子在干什么」需要连续的几张图才能判断，
  单张图既贵又不准。所以 AI 按包分析，`ScreenInsight` 挂在 batch 上。
- **`UsageEpisode` 与 `UsageInsight` 分开**。局数/集数是**可计数的结构化事实**，
  而总结是给人看的文本。计数要能被打平、按天聚合、做预算，不能被一段自然语言绑死。
- **`ScreenMonitorConfig` 独立于 `LockPolicy`**：锁屏强度与「要不要截屏分析」是两件事，
  家长可能只想锁屏、不想被截屏。

---

## 2. API 契约

### 2.1 设备端（`/api/agent/*`，设备令牌）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/agent/screen-batches` | 上传一个包（`multipart/form-data`：`file`=zip、`startedAt`、`endedAt`、`frames`=JSON 元数据、`agentVersion`） |
| GET | `/api/agent/screen-quiz/next` | 取一道**基于屏幕内容**的题（无屏幕题时服务端回退到普通题库） |
| POST | `/api/agent/screen-quiz/answer` | 交卷（复用现有判定与奖励逻辑） |

`/api/agent/config` 新增 `screenMonitor` 段：

```json
{
  "screenMonitor": {
    "captureEnabled": true,
    "captureIntervalSeconds": 30,
    "framesPerBatch": 10,
    "quizFromScreen": true,
    "usageBudget": {
      "gameRounds": { "enabled": true, "dailyLimit": 3, "usedToday": 1 },
      "videoEpisodes": { "enabled": false, "dailyLimit": 2, "usedToday": 0 }
    }
  }
}
```

### 2.2 家长端（家长令牌）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/insights` | 时间线（`deviceId` / `from` / `to` / `limit` / `onlyAlerts`），每条含总结、应用、局数/集数、风险等级 |
| GET | `/api/insights/:insightId` | 详情（含该包的帧时间线与签名 URL、原始 AI 输出） |
| GET | `/api/alerts` | 异常提醒列表（`type` / `unreadOnly` / 分页） |
| POST | `/api/alerts/:alertId/read` · `/api/alerts/read-all` | 标记已读 |
| GET/PUT | `/api/screen-monitor` | 截屏与 AI 设置 + 5 类提醒开关 + 留档天数 |
| GET/PUT | `/api/usage-budgets` | 玩几局 / 看几集上限 |
| GET | `/api/usage-summary` | 今日已玩几局 / 已看几集、剩余额度 |
| POST | `/api/insights/:insightId/reanalyze` | 手动重跑 AI（换模型或补跑失败批次） |

**统一的分页结构**沿用 `parsePagination`：`{ page, pageSize, total, totalPages, items }`。

---

## 3. AI 分析设计

### 3.1 可插拔 provider

```
AI_ENABLED=false              总开关
AI_BASE_URL=                  任何 OpenAI 兼容的 /v1（DeepSeek、DashScope 兼容模式、智谱、本地 Ollama/vLLM）
AI_API_KEY=
AI_VISION_MODEL=              例如 qwen-vl-max / glm-4v / gpt-4o-mini
AI_TEXT_MODEL=                用于出题与二次归纳
AI_MAX_FRAMES_PER_BATCH=      成本控制：每包最多送几张（默认 6，均匀采样）
AI_TIMEOUT_MS=
```

**没有配置 key 时绝不伪造分析结果。** 批次会被标成 `skipped`，`ScreenInsight.provider = 'disabled'`，
并在家长端明确显示「未配置 AI，无法分析」。这是本工程一以贯之的原则。

### 3.2 降级：启发式分析器（明确标注非 AI）

为了让整条链路在没有 key 的环境里也能被**完整验证**，提供一个确定性降级器：

- 输入：每张帧的**前台包名**（设备端尽力上报）+ 图像的亮度/色彩统计（服务端用零依赖的 JPEG 尺寸+采样近似）
- 输出：`provider = 'heuristic'`，summary 形如「这段时间主要停留在 com.tencent.tmgp.sgame（约 8 分钟）」，
  `activities[]` 按包名推断类别（游戏/视频/社交/学习/浏览器/其它）
- **明确标注**：家长端会显示「启发式推断，非 AI 分析」，绝不与 AI 结果混淆

### 3.3 结构化输出

要求模型返回**严格 JSON**，用 zod 校验；校验失败重试一次，再失败则该批次 `failed` 并记录原始响应：

```json
{
  "summary": "这段时间在玩《王者荣耀》，进行到对局结算界面，情绪平稳",
  "activities": [{ "app": "王者荣耀", "packageName": "com.tencent.tmgp.sgame",
                   "category": "game", "description": "进行对局", "frameFrom": 0, "frameTo": 7 }],
  "games": [{ "name": "王者荣耀", "scene": "result", "roundCompleted": true,
              "confidence": 0.86, "evidence": "屏幕中央出现「胜利」与战绩面板" }],
  "videos": [{ "name": "小猪佩奇", "episodeCompleted": false, "confidence": 0.7, "evidence": "片头曲刚刚开始" }],
  "contentFlags": {
    "minorContent": false, "scamSuspect": { "detected": false, "evidence": "" },
    "emotionalIssue": { "detected": false, "evidence": "" },
    "gameAddiction": { "detected": true, "evidence": "连续 3 局未中断" },
    "highSpending": { "detected": false, "evidence": "" }
  },
  "riskLevel": "low",
  "keywords": ["pig", "佩奇", "英语"],
  "topics": [{ "subject": "english", "term": "pig", "meaning": "猪" }]
}
```

`keywords` / `topics` 就是需求 8「屏幕答题」的原料。

---

## 4. Android 端设计

### 4.1 锁定状态复核（需求 1）

新增 `LockReassertor`，由 `AgentService` 的 1 秒 ticker 驱动，**每 3 秒**做一次「实际情况核实」。
两条触发路径，语义不同，不要混为一谈：

**路径 A —— 周期复核（每 3 秒，`force=false`）**

```
若策略要求锁定：
  kiosk 档：ActivityManager.getLockTaskModeState() == LOCKED
  悬浮窗档：LockOverlayWindow.isShowing()
  密码/Activity 档：LockScreenActivity.isShowing()
  实际没锁 → 立即重新进入锁定
```

**路径 B —— 亮屏即重锁（`ACTION_SCREEN_ON` / `ACTION_USER_PRESENT`，`force=true`）**

需求原话是「**如果在锁屏状态，但是屏幕被打开了，就再锁一次**」——注意这里的前提是
「屏幕被打开」，不是「没锁住」。所以路径 B **不检查实际锁定状态**，只要策略要求锁定且屏幕
一亮，就直接重新锁定（`lockNow()` 会把屏幕重新关掉）。孩子靠任何办法点亮屏幕，
几秒内就会被打回熄屏，看不见也操作不了任何东西。

两条路径都走 `LockEnforcer.showLockUi()` 这唯一入口，并有 `MIN_REASSERT_INTERVAL_MS` 节流
（`ACTION_SCREEN_ON` 与 `ACTION_USER_PRESENT` 可能几乎同时到达）。

> **为什么路径 B 要 `force`**：若照路径 A 的逻辑「已经锁着就不动」，孩子点亮屏幕后看到的是
> 锁定界面 —— 界面还在，但屏幕是亮的，屏幕内容（时间、通知、被锁定页挡不住的任何东西）
> 就暴露了。需求要的是「再锁一次」，即把屏幕关回去。

#### 降级路径的一个真实陷阱（实测确认）

悬浮窗权限被撤销时，`LockEnforcer.showLockUi()` 会退回 `LockScreenActivity`。但 Android 10 起
**禁止后台应用自行启动 Activity**，而常用的豁免恰好就是 `SYSTEM_ALERT_WINDOW` ——
权限一撤，「退回 Activity」这条路被系统同时堵死，**锁定彻底失效**（模拟器实测：无任何界面出现）。

修法：`AccessibilityService` 是另一条合法豁免。看门狗服务在 `onServiceConnected` 里通过
`LockWatchdogBridge.installActivityStarter()` 注入「用无障碍服务上下文启动 Activity」的能力，
`LockScreenActivity.show()` 在无悬浮窗权限时优先走它。这样降级路径才真的可用。

### 4.2 周期截屏与打包（需求 2）

`ScreenSampler`：

- 复用 `ScreenCapturer` 的常驻 MediaProjection（**不重复弹授权框**）
- 每 `captureIntervalSeconds` 截一张，缩放长边 ≤ 480px + JPEG q=45（约 15–30 KB）
- 落盘到 `cache/screen-frames/`，攒够 `framesPerBatch`（默认 10）张 → 交给 `FrameBatchUploader`
- **磁盘配额**：目录超过 50 MB 或 200 张时丢弃最旧的；上传成功后立即删除
- 授权失效（Android 14 每次新会话需重授权）→ 记日志并在配置页提示，不静默失败

`FrameBatchUploader`：

- 打成 zip（`java.util.zip`，零依赖），内含 `frames/*.jpg` + `manifest.json`
- `POST /api/agent/screen-batches`，失败按 5s/15s/60s 退避重试，超过 3 次保留在本地等下一轮
- 上传成功后按服务端返回的 `analysis.status` 记日志

### 4.3 用量预算与屏幕答题（需求 7、8）

- 从 `/api/agent/config` 读 `usageBudget`，本地缓存；超限时**本地立即锁屏**（不等服务端指令）
- 屏幕答题：优先 `GET /api/agent/screen-quiz/next`（服务端给屏幕相关题），
  失败或没有屏幕题时回退到现有题库

---

## 5. 家长端设计

### 5.1 新页面 `/insights`（AI 洞察）

- **顶部**：今日概览（已玩几局 / 已看几集 / 剩余额度、未读提醒数、AI 是否可用）
- **异常提醒卡**：按严重度排序，可标记已读；无 AI 时明确显示「未配置 AI」
- **时间线**：每条 = 一个批次。显示时间段、AI 总结、涉及应用标签、游戏/动画进度徽章、
  风险等级色条；点击展开详情（帧时间线 + 原始 AI 输出）
- **设置区**：截屏开关与频率、AI 分析开关与采样数、留档天数、5 类提醒开关、玩几局/看几集上限

### 5.2 入口

放在首页「基础功能」列表（与「锁屏设置」并列），图标 `Sparkles`，名称「AI 洞察」。

---

## 6. 隐私与安全（必须写进文档与界面）

- 截屏是**最高敏感度**的数据。默认**关闭**，必须家长在设备上显式开启并授予屏幕录制授权。
- 图片只保留 `retentionDays` 天，之后由定时任务清理磁盘与数据库。
- **家长端不提供原图浏览**，只展示 AI 结构化结论与帧时间线（时间点 + 应用名）。
  确需看图时走单独的一次性签名 URL，且该行为会写入操作记录。
- 管理后台**一律看不到**这些帧与总结里的儿童内容，只看计数（沿用现有约定）。
- AI 请求会把截图发给第三方模型服务。这一点在界面上要明确告知家长（「图片将发送至 AI 服务用于分析」）。
- 全部内容仅用于家长监护，不做跨账号聚合与营销。

---

## 7. 分期与验收

| 阶段 | 内容 | 验收方式 |
| --- | --- | --- |
| P1 | Prisma 模型 + 迁移 | `prisma migrate dev` 通过 |
| P2 | 设备端上传 API + 家长端全部 API | curl 全量打通，含鉴权、归属校验、分页 |
| P3 | AI provider + 启发式降级 + 结构化校验 | 单测式脚本：喂样例 JSON 校验、无 key 时降级路径 |
| P4 | Android：复核 + 采样 + 打包上传 + 预算 + 屏幕答题 | 真机/模拟器实测上传成功、包内容正确 |
| P5 | 家长端洞察页与设置 | `npm run build` + `lint` + 真实浏览器联调 |
| P6 | 端到端：设备产生包 → 服务端分析 → 家长端可见 → 超限锁屏 | 扩展 `e2e-agent.mjs` |
| P7 | 文档 | `README`、`server/README.md`、`android/README.md`、本文件补「实现结果」 |

---

## 8. 实现结果

计划里的 P1–P7 全部落地。这一节记录**实际做出来的东西**与**验证到哪一步**，
以及几处与计划不同、或计划时没想到的地方。

### 8.1 交付物

| 端 | 内容 |
| --- | --- |
| 数据层 | 8 张新表：`ScreenMonitorConfig` / `ScreenBatch` / `ScreenFrame` / `ScreenInsight` / `UsageAlert` / `UsageEpisode` / `UsageBudget` / `ScreenQuizQuestion`，3 个迁移 |
| 服务端 | `server/src/features/insights/`（dto / controller / service / storage / ai.provider / ai.heuristic），家长端 11 个接口 + 设备端 3 个接口 |
| 服务端脚本 | `mock-ai-server.mjs`（OpenAI 兼容假视觉服务，可切场景）、`e2e-screen-insights.mjs`、`e2e-ai-analysis.mjs` |
| Android | `ScreenSampler` / `FrameBatchArchiver` / `FrameBatchUploader` / `ForegroundAppTracker` / `LockReassertor` / `ScreenStateReceiver`；`ScreenCapturer` 增加低分辨率采样能力（复用常驻投影） |
| 家长端 | `/insights` 页（洞察时间线 / 异常提醒 / 用量预算 / 截屏设置 / 隐私说明），首页新增「AI 洞察」入口 |
| 联调脚本 | `android/scripts/e2e-screen-sampler.mjs`（真机/模拟器全链路） |

### 8.2 验证结果

| 验证 | 结果 |
| --- | --- |
| 后端屏幕洞察全链路 `server:e2e:insights` | **28 项通过，0 失败** |
| AI 分析全链路 `server:e2e:ai`（对着假视觉服务跑真实 provider 分支） | **28 项通过，0 失败** |
| Android Agent 主链路 `android:e2e` | **83 项通过，0 失败**（真实模拟器 + 真实后端） |
| Android 截屏 + 锁定复核 `android:e2e:screen` | **21 项通过，0 失败** |
| 作息求值交叉验证 `android:crosstest` | 2016 个采样点，零差异 |
| 前端 `npm run build` / `npm run lint` | 通过 |
| 后端 `npm run typecheck` / `npm run lint` | 通过 |

主链路 E2E 比上一轮多出的 6 项，全部是本轮新加的回归断言（见 8.3 第 1、4、7 条）——
不是把断言改松，而是把踩过的坑固化成检查。

关键的一条真实验证：模拟器上跑完整链路后，服务端数据库里确实躺着 **2 张真实 JPEG 帧**
和一条 `provider=heuristic` 的洞察记录（本机没有 AI key，所以如实降级并标注，没有伪造）。

### 8.3 计划外发现并修掉的真问题

这三个都是**真机实测才暴露**的，纯看代码推不出来：

1. **撤销悬浮窗权限会同时废掉降级路径。** Android 10 起禁止后台应用自行启动 Activity，
   而最常用的豁免就是 `SYSTEM_ALERT_WINDOW`。权限一撤，「退回锁定页 Activity」也被系统堵死，
   锁定**彻底失效**。修法：借 `AccessibilityService` 这条合法豁免启动锁定页。

2. **截屏授权弹框会把锁屏顶掉。** 进程重启后投影丢失，采样器会去重新申请 MediaProjection，
   而 `ProjectionConsentActivity` 是个系统弹框，直接盖在锁定页上面 —— 等于帮孩子解锁。
   修法：采样器与授权页都加锁定门禁（`LockState.locked` 时既不采样也不申请授权）。

3. **`ACTION_USER_PRESENT` 被系统丢弃。** targetSdk 33+ 动态注册必须声明导出标志，
   用 `RECEIVER_NOT_EXPORTED` 会被判 `Exported Denial`（实测日志可见），
   也就是「解锁完成」这一刻根本收不到。修法：改用 `RECEIVER_EXPORTED`
   （该接收器只会触发锁定复核，只会让设备更锁，伪造风险可接受）。

4. **远程解锁退不出 Kiosk。** 日志打了「解除锁定」、家长端也显示已解锁，设备却仍停在
   Lock Task 里。原因是系统拆 Lock Task 是异步的，`stopLockTask()` 之后立刻 `finish()`
   会被 ActivityTaskManager 拒绝（实测日志 `Not finishing task in lock task mode`）。
   修法两条：设备所有者档下再把 Lock Task 白名单清空（这条一定生效，进入时重写回来），
   并且等状态真的离开 Lock Task 再关页面（最多重试 3 秒）。这属于需求 3
   「远程解锁必须可靠」里最不能容忍的静默失效。

5. **「亮屏即重锁」一开始实现成了无条件关屏。** 看着更狠，实际是自伤：孩子按一下电源键
   屏幕立刻又黑，既看不到「为什么被锁」，也点不到答题解锁入口 —— 家长设的锁屏说明等于白设，
   体验上还像设备坏了；而且安全上毫无增益（锁定界面本来就在最前）。
   修法：亮屏时**无条件把锁定界面重新摆到最前**，只有「实际没锁住」时才 `lockNow()` 关屏。

6. **测试脚本自身的一个老 bug。** `e2e-agent.mjs` 的 `windowAttached()` 读的是
   `adb(...).text`，而 `adb()` 返回的是 `{ code, out, err }` —— 这个属性不存在，
   于是「倒计时悬浮窗弹出了没有」这条断言**永远为 false**，从来没真正验证过任何东西。
   改成 `.out` 之后第一次跑就抓到了真问题（见第 5 条）。

7. **解绑后设备被「一台已经不存在的设备」永久锁死。** 解绑 → 设备端自动重新注册拿到新
   deviceId，但本地还留着上一台设备的 `locked=true`，本地判定又读的是独立的 `locked` 标志，
   于是新身份继续按旧策略锁着 —— 而服务端那条记录已经没了，家长端连入口都没有，**谁也解不开**。
   修法：注册时检测 deviceId 变化即丢弃旧策略，并加一条更强的自愈不变量
   （缓存配置的 deviceId ≠ 本机 deviceId 就整份丢掉），在服务启动与锁定页自检时都执行，
   已经卡死的设备也能自己恢复。这条也是主链路 E2E 之前那些「主界面没渲染」失败的真因。

8. **看门狗和系统锁屏互相打架。** `password` 档会锁系统锁屏，而看门狗把
   「systemui 抢到前台」当成绕过，于是每 400ms 拉一次锁定页又被压回去，形成死循环。
   后果之一是**家长连「应急解锁」入口都点不到** —— 那是需求 2 的最后一道保险。
   修法：用 `KeyguardManager.isKeyguardLocked()` 判断，系统锁屏在最上面时直接跳过。

### 8.4 与计划不同的一处语义

计划里 §4.1 写的是「屏幕亮着**但实际没锁**才重新锁定」。实现时按需求原话调整为两条独立路径：
**亮屏即重锁**（不看实际锁定状态）+ 周期复核（没锁住才补锁）。
理由：「界面还挂着」不等于「锁住了」—— 锁定页还在最前面但屏幕是亮的，时间和通知仍然暴露。
详见 §4.1。

### 8.5 诚实的边界

- **没有 AI key 时不会编造结论**。批次标 `skipped`，或降级为 `provider=heuristic`
  并明确标注「不是 AI」。启发式**判断不了**「结算画面是否出现」「这一集是否看完」，
  所以那些统计在启发式模式下不计入。
- **家长端看不到截图原图**（只能看帧时间线：时间 + 应用名），管理后台连帧都看不到，只有计数。
- 通知栏在非设备所有者时仍可下拉；Recovery 恢复出厂、长按电源键重启堵不住 —— 见
  [`android/README.md`](../android/README.md) §2.2。
- 本轮还查出一个**与本计划无关、但优先级更高**的设备端缺陷：`password` 档随机改写系统锁屏密码后，
  设备一旦重启就会卡在系统锁屏（Agent 不是 direct-boot 感知的，解锁前跑不起来，
  也就执行不了「重启清除随机密码」那条安全阀）。**已修复并纳入端到端回归** ——
  `directBootAware` + `LOCKED_BOOT_COMPLETED` + 设备加密存储，详见
  [`android/README.md`](../android/README.md) §2.4。
