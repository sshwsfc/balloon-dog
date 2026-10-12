# 实现记录：截图链路修复 · 长活加固 · 防卸载与绕过面收口

对应需求（2026-10-11）：

> 1. 截图指令貌似不好用，在媒体中看不到截图，跟截图相关的功能也都不好用。
> 2. 要确保自己这个应用不能被杀死，被关闭，要保持长活状态。
> 3. 要确保自己这个应用不能被卸载，还要再充分考虑还有哪些方式可以让孩子绕过管控的，都要堵死。

结论：三项诉求都落地并**在设备上跑过**（Android 13 arm64 模拟器 `emulator-5554`）。
设备级套件 `npm run android:e2e:gaps` = **131 项通过 / 0 项失败 / 2 项跳过**，`EXIT_GAPS=0`。
凡没测到的地方，本文件第五节逐条写明，不含推测性结论。

---

## 一、诉求 1：截图链路（两个真根因，不是一个）

### 根因 A —— 服务端把截图挂在了一个不相干的功能键下

`POST /api/device/screenshot` 在没开「屏幕洞察」时被 400 挡回：

```
{"title":"BAD_REQUEST","message":"请先开启「屏幕洞察」功能"}
```

`server/src/features/devices/devices.service.ts` 的 `requestCapture()` 里，功能键是这么选的：

```ts
const featureKey = type === 'remote_photo' ? 'remotePhoto'
                 : type === 'screenshot'   ? 'screenMonitor'   // ← 错挂
                 : type === 'start_recording' ? 'videoRecord' : 'remoteRecord';
```

截图是「按一次看一次」，和「周期性采集屏幕 + 送 AI 分析」不是同一件事，家长不开屏幕洞察并不代表不能手动拍一张。

**修法**：`devices.service.ts:550` 改成 `if (type !== 'screenshot')` 才做功能门禁，注释写清「`FEATURE_DEFS` 里根本没有截图开关，能不能截由设备端能力决定」。家长端同步撤掉镜像门禁：`src/pages/HomePage.tsx:231` 的 `CAPTURE_FEATURE` 不再含 `screenshot`，`src/pages/InsightsPage.tsx`、`src/pages/RemoteHelpPage.tsx` 也不再为截图拦一道。

这里还有一个**只改了一半**的尾巴，本轮补掉：`src/pages/InsightsPage.tsx` 的「立即截图」区块代码注释已经写明「手动截图不再要求「屏幕洞察」开关」，但 JSX 条件仍然是 `config?.captureEnabled &&` —— 即注释在说谎，从这一页根本点不到手动截图。已改成只判 `config` 是否加载完（旁边那条「周期采集隐私说明」仍然正确地跟着 `captureEnabled` 走）。

### 根因 B（真凶）—— MediaProjection 要求**孩子**点系统授权框

撤掉门禁后指令确实下发并被领取，但设备端报：

```
E BalloonDog: 屏幕截图执行失败：等待屏幕共享授权超时，请在设备上点击「立即开始」
```

`ScreenCapturer` 走的是 `MediaProjection`，而 Android 要求每次授权都必须有人在**那台设备上**点系统弹框「Start recording or casting with 气球狗守护?」。没人点就 20 秒超时失败。更糟的是当时的应用文案（`ProjectionConsentActivity.java:77`）写着：

```
家长正在查看这台设备的屏幕
请在系统弹框中选择「立即开始」以授权
```

即**让被监控的孩子去批准自己被监控**。这个根因同时打死了「连续录像」和「屏幕洞察周期采样」——两者共用同一个 `ScreenCapturer`（`CommandExecutor.java:290/310/330`、`ScreenSampler.java:102`，全工程恰好这 4 处调用）。所以「跟截图相关的功能也都不好用」是同一个病。

**修法：改用无障碍服务截图**（API 30+，**不需要任何授权弹框**）

- `android/app/src/main/res/xml/accessibility_watchdog.xml:30` 加 `android:canTakeScreenshot="true"`。加之前 `dumpsys accessibility` 报 `capabilities=1`，加完是 **129**。
  - 注意：`CAPABILITY_CAN_TAKE_SCREENSHOT` 是 **`1<<7 = 128`**（`javap -constants` 复核），不是 64；`129 = 128 + FEEDBACK_GENERIC(1)`。
- 新增 `android/app/src/main/java/com/balloondog/agent/capability/AccessibilityScreenCapture.java`（214 行）：`takeScreenshotBlocking(long[,int])` 用 `CountDownLatch` 等 `AccessibilityService.takeScreenshot()` 回调，`Bitmap.wrapHardwareBuffer` 转 software bitmap，`finally` 里同时 `recycle()` 与 `buffer.close()`（HardwareBuffer 数量有限，必须关）；`API < 30` 直接返回 `null`；服务未连 / `SecurityException` / 超时一律返回 `null` **不抛异常**；回调跑在守护线程 `balloon-a11y-screenshot`，不占主线程。
- `ScreenCapturer.capture()`（`ScreenCapturer.java:142`）改成**先试无障碍、拿不到再回退 MediaProjection**；新增 `CapturePath` 枚举（`:78`）与 `lastCapturePath()`（`:92`）让上层能如实说明走的是哪条路。`captureScreenshot` / `captureScreenshotLowRes` 的签名不变，所以采样路径自动受益；录像仍只能靠 MediaProjection（**未动**）。

**设备实测（全程无人点屏幕）**：

```
I/BalloonDog: 开始执行：屏幕截图（screenshot）
I/BalloonDog: 已通过无障碍接口截屏（免授权），66 KB          # 约 270 ms
I/BalloonDog: 屏幕截图完成并已上传
I/BalloonDog: 已回报结果：succeeded
```

全日志里 `MediaProjectionPermissionActivity|ProjectionConsentActivity` **0 条**。数据库里第一次出现了截图行（此前历史累计为 0）：

```
        id                  |    kind    | mimeType  | sizeBytes |       createdAt
 cmv3ncazw0b4mxrrpobo02n2q  | screenshot |image/jpeg |    102212 | 2026-10-11 09:54:26.348
 cmv3ncjpq0b58xrrpfr1zz1qo  | video      | video/mp4 |    111617 | 2026-10-11 09:54:37.646
```

截图行下载下来是 `JPEG image data, JFIF standard 1.01 … 1080x2340`，肉眼确认是真实画面（不是黑图）。周期采样也从 0 帧变成有帧（`ScreenFrame` 0 → 2 → 14 → 16），同一窗口内授权页 0 次，`GET /api/insights` 出现新行。

### 我在这一段的两个误判（已被实测纠正，记录备查）

1. 我最初推断能力位是 `1<<6 = 64`。实际是 `1<<7 = 128`。
2. 我推断「`appops get PROJECT_MEDIA` 变成 `ignore` 后系统再也不弹授权框，截图永久失败」。**在 Android 13 模拟器上不成立**：`ignore` 只是「上次授权被划掉/超时」留下的记录，弹框照常出现，点了就成功。`allow` 的真正价值是让系统在约 700 ms 内自动放行、**免去人工点击**，所以它依然是 provisioning 的必做步骤，但产品报错文案没有写「再也不会弹框」。

### 免 adb 的兜底与它的边界

- **provisioning 必做**（`android/README.md` §3.4）：`adb shell appops set com.balloondog.agent PROJECT_MEDIA allow`，紧邻 `dpm set-device-owner`，并要求改完 `adb reboot` 复验仍为 `allow`。已实测跨重启保留。
- 无障碍路径不可用时（服务被关/被杀）才回退 MediaProjection，那条路**必须有人点一次授权框**。
- **已知系统副作用（会表现为「更新完截图就不好用了」）**：装 APK 前若无障碍已启用，装包杀进程会让系统把服务记进 `Crashed services`，此后 `takeScreenshot` 持续回**错误码 1**，截图静默退化到 MediaProjection。判据是 `dumpsys accessibility` 同时出现 `Bound services` 与 `Crashed services:{{…LockWatchdogService}}`；重写一次 `enabled_accessibility_services` 即恢复（恢复后立刻 `已通过无障碍接口截屏（免授权），171 KB`，129 ms）。这是系统行为、不是本工程缺陷，已写进 `android/README.md` §10.5。

---

## 二、诉求 2：长活

| 机制 | 位置 | 说明 |
|---|---|---|
| `START_STICKY` | `AgentService.java:328` | 只有家长显式停止（`Constants.ACTION_STOP_AGENT`）才返回 `START_NOT_STICKY`（`:297`），语义正确 |
| 三重冗余唤醒 | `service/WatchdogScheduler.java` | 主 `AlarmManager` 每 60 s 自排下一次（`setAndAllowWhileIdle`，**刻意不用 `setRepeating`**）+ 15 min 备用 `setExactAndAllowWhileIdle` + 15 min `JobScheduler` |
| 周期巡检**并当场自愈** | `service/LongevityGuard.java:353-369` | 每 5 min `tick()`；健康时只读巡检，发现缺口起守护线程 `selfHeal()`（`OwnerHardening.apply` → 权限代授 → 重开无障碍 → 重绑 always-on VPN → 重排闹钟） |
| 加固自检 | 同上 `problems()` | 设备上汇总 `气球狗加固自检…26/28 项生效（2 项本机不支持）` |

`tick()` 的注释写明为什么自愈放在心跳里而不是只靠闹钟：**Doze 下闹钟可能被推迟到 15 分钟以上**。

实测 `kill -9` 后的恢复耗时：**2 / 4 / 10 / 16 / 64 秒**（e2e §14 那轮 56 秒）。不是固定值——AMS 对反复被杀的 `START_STICKY` 服务做重启退避，60 秒主看门狗是兜底。**只承诺「分钟级以内」**，不承诺秒级。

---

## 三、诉求 3：防卸载与绕过面收口

### 3.1 受保护包 —— 真堵死（含 shell UID，无需 root）

| 手段 | 设备原始输出 |
|---|---|
| `pm uninstall` | 普通状态 `Failure [DELETE_FAILED_USER_RESTRICTED]` exit=1（`pm uninstall` / `--user 0` / `-k --user 0` / `cmd package uninstall` 四条变体同码）；**锁屏（lock task）状态**下同一条命令变成 `Failure [DELETE_FAILED_APP_PINNED]` exit=1 |
| `pm disable-user --user 0` | `java.lang.SecurityException: Cannot disable a protected package: com.balloondog.agent` exit=255 |
| `dpm remove-active-admin` | `java.lang.SecurityException: Attempt to remove non-test admin ComponentInfo{…AgentAdminReceiver} 0` exit=255 |
| `am force-stop` | exit=0 但 **PID 不变**（对照：同一命令杀 `com.android.deskclock` 立刻生效）；`stopped=false`、本包 12 条闹钟仍在 |
| `pm hide` | 回显 `Package com.balloondog.agent new hidden state: false` exit=0 —— **exit=0 很容易被误读成成功**，实际 `hidden=false`、PID/DO/无障碍全不变 |
| 设置页按钮 | `Uninstall` / `Force stop` / `Clear storage` 节点 `enabled="false"`（`Open` / `Clear cache` 仍 `true`） |

`pm uninstall` 的两种错误码不是矛盾：**同一命令在两种设备状态下都被拒，只是当时哪条防线先命中**。`APP_PINNED` = 被 lock task 固定，`USER_RESTRICTED` = 设备策略（`DISALLOW_UNINSTALL_APPS` / `setUninstallBlocked`）。两种状态都复现过。

### 3.2 本轮新堵的三个绕过面

**① 无障碍设置页**（孩子进去关掉「气球狗守护」= 一次性废掉锁定、学习模式、插件拦截、应用限时）

`service/LockWatchdogService.java:310` 在原本的锁定判定之前插入窄判定：`com.android.settings` + **类名**含 `Accessibility`（用类名而非文本，换语言不变，且能一并拦掉单服务详情页 `…AccessibilityDetailsSettingsActivity`）→ `GLOBAL_ACTION_BACK`。三条约束都守住了：

- 只在 `store.isHardeningEnabled()` 时拦（`:311`）；关掉加固则**放行并留一条 30 秒节流的日志**。
- **只拦这一页**，不动 `GuardRules.ALWAYS_ALLOWED` 对 `settings` 包的放行（紧急呼叫/电话/systemui 一个都没碰）。
- **拦不住时不装成功**：同一类名 3 秒内反复出现则记「未能阻止进入无障碍设置页：连续按返回无效…」，而不是继续报「已阻止」。

设备实测：加固开 → 2 秒内 `mCurrentFocus` 回到桌面 + `看门狗：拦截无障碍设置页（按返回推走…）`，40 秒内服务端同句 tamper；加固关 → 页面留住 + `看门狗：管控加固已关闭，放行无障碍设置页（家长逃生通道）`。

**② 无障碍总开关被关后家长完全不知情**（此前全工程 `accessibility_disabled` / `guard_disabled` 这类上报**零命中**，而锁定/限时/拦截/免授权截图全都以无障碍为执行通道）

现在同一秒检测到并上报两条 tamper，中间**没有**假的「已恢复」：

```
无障碍守护已被关闭…正在尝试自救
无法自动恢复无障碍守护…            # 与上一条相差 3 毫秒
```

**③ 使用情况访问被撤销**（逐应用限时静默失效）与 **always-on VPN 未绑定**（孩子可从快捷开关断开网址拦截）

`LongevityGuard.problems()` 新增两条判定，且刻意**只在家长真在用需要它的功能时**才报，避免假警报；VPN 那条每次自愈会重新绑定（设备实测 41 秒绑定成功，`mAlwaysOnVpnLockdown=false`）。

### 3.3 本轮修掉的一个「谎报」

`LongevityGuard.tryReEnableAccessibility()` 原来第一行是 `isAccessibilityListed()`，而它**只读** `Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES`、完全不看 `ACCESSIBILITY_ENABLED`。数据库里的铁证是两条相邻事件：

```
无障碍守护已自动恢复，管控功能重新生效     ← 12 毫秒后又来一条
管控自检发现缺口…
```

12 毫秒不可能完成「重新绑定无障碍服务」。修法：改用 `accessibilityHealthy()` = `LockWatchdogService.isEnabledInSettings()`（权威判据，走 `AccessibilityManager.getEnabledAccessibilityServiceList`）**且** `isConnected()`；写回后每 200 ms 轮询（系统重新绑定有延迟，立刻回读必然假阴性）。设备上复验：假「已恢复」消失。

另修：`problems()` 在 `detail` 为空时产出「禁止修改语言/区域（）」的空括号；以及电池白名单这一条**长期缺口被反复当成「新增」上报 13 次**（根因是早前用整串签名比对、天然非空会盖掉「已恢复正常」；改成集合差分 `added`/`fixed` 后，当前构建 10 分钟 0 次重复）。

---

## 四、验证汇总（本轮真实数字）

| 项目 | 结果 |
|---|---|
| `npm run android:e2e:gaps` | **131 通过 / 0 失败 / 2 跳过**，`EXIT_GAPS=0`（基线 85/0/2 未退化；新增 §8 截图 9 项、§9 录像 7 项、§10 周期采样 8 项、§14 长活与防卸载 22 项全绿） |
| `npm run android:build` | `BUILD SUCCESSFUL in 1s`，APK `11022834` 字节 md5 `7c65b24b28e034b26250621dbc5a36fb` |
| `bash android/scripts/crosstest/run.sh` | `EXIT_CROSSTEST=0`（63 通过 / 0 失败） |
| `npm run server:typecheck` / `npm --prefix server run lint` / `npm run lint` / `npm run build` / `npm run i18n:coverage` | 退出码全 0（lint 只剩既有 warning `src/pages/QuizUnlockPage.tsx:38:6`；词典缺失 0 条） |
| `npm run e2e`（浏览器，打 `:2727` 的构建产物） | 家长端 **46/46**、管理后台 **31/31**，退出码 0 |
| 跑测完整性凭据 | 脚本 md5 `6551098b84a72dac572360e88f25fe9a`（2221 行，运行期间未变）；`git status --porcelain -- android` 指纹 `1764100902f6cfee5cd35652e985b9cd4b5eddbf` **跑前跑后一致** |

那 2 项跳过是原有的、不是本轮引入，原因已写在套件末尾：① DNS 层拦截对「被拦域名 vs 放行域名」的实际效果设备级无法断言（隧道建立后 shell 的解析对所有域名一律失败，无法区分「被拦」与「隧道不通」），由 `android/scripts/crosstest/PureLogicCheck.java` 覆盖；② 局数/集数预算的离线兜底锁屏无法构造 `used >= limit`（`usedToday` 由服务端 AI 分析推算，`upsertBudgetSchema` 只接受 `dailyLimit`），只验证到「配置真的下发到设备」。

---

## 五、没堵掉的 / 没验证的（诚实清单）

**堵不掉**

1. **无障碍服务被系统关掉**：DO 没有任何 API 能强制打开（实测 `Permission denial: Device owners cannot update enabled_accessibility_services`）。做得到的是同秒检测 + 上报 + 加固期间把设置页推走 + 悬浮窗兜底，**做不到自动恢复**。
2. **电池优化白名单**：DO 没有静默写入的 API（`dpm.setGlobalSetting` 写 `app_auto_restriction_enabled` 被拒，shell 能写）。唯一长期缺口，靠每 5 分钟巡检如实上报。
3. **进程被杀/强停后的空窗**：几秒到 60 秒，期间靠系统级 `LockTask` 与悬浮窗兜底，不是无缝。
4. **关机 / Recovery / 拔电池**：无解。
5. **`pm clear`**：**未验证**——跑它会清掉绑定与授权且设备上无法回滚，为不污染验证刻意跳过。「设置页 `Clear storage` 按钮 disabled」是 UI 层证据，不等于命令级验证过。
6. **VPN 磁贴**：这台镜像的快速设置里**根本没有 VPN 磁贴**（`add-tile` / 改 `sysui_qs_tiles` + 重启 SystemUI 都造不出）⇒ 归未验证，**不写成已堵死**。`lockdown=true` 刻意没做（DNS 过滤型 VPN 在 lockdown 下起不来 = 整机断网，回滚只能在设备上做）。
7. **恢复出厂 / 安全模式 / 多用户 / 改时间**：**未实测**，只在 `dumpsys user` 的 `Effective restrictions`（21 条）里看到 `no_factory_reset`/`no_safe_boot`/`no_add_user`/`no_config_date_time` 等确实生效。另：`DISALLOW_CONFIG_TIMEZONE` 这个常量在 API 33 的 `UserManager` 里**不存在**，时区与日期共用 `no_config_date_time`。

**未验证**

8. **全部设备级证据都来自 Android 13 arm64 模拟器，没有真机验证**。国产 ROM 杀无障碍的频率、`takeScreenshot` 是否被厂商阉割、低端机 HardwareBuffer 表现都未知。
9. **API 24–29 未上机**（`minSdk 24`），只有代码级判断：`SDK_INT < R` 直接返回 `null` 回退 MediaProjection。API 33 以外的版本也没测。
10. **`hardening_enabled` 没有 UI 入口**：`AgentStore.setHardeningEnabled()` 全仓库零调用者，四处 `isHardeningEnabled()` 分支在真实设备上恒定走 true 分支。⇒ `android/README.md:1196` 已写明「接 UI 或家长端开关之前，**不要对外宣称「家长可以随时关掉加固」**」。**建议**：家长端加一个「管控加固」开关。好消息是它不是陷阱——拦截逻辑本身住在无障碍服务里，无障碍一旦掉线（含装包后的 `Crashed services`）拦截随之失效，家长照样能进设置页把服务开回来。
11. **没有推送通道，也没有「设备离线/守护停摆」这一类告警**：`server/src/` 里 FCM/webpush 零命中；`insights.service.ts` 的 `ALERT_TYPE_LABELS` 只有五类内容向告警（`minor_content`/`scam_suspect`/`emotional_issue`/`game_addiction`/`high_spending`）；`devices.service.ts:193-200` 只在设备详情里拼一句被动的 `warning`。⇒ 孩子关机、断网或彻底杀掉进程后，家长端不会收到任何主动提醒。

**排查噪声（写给后续维护者）**

- `adb shell uiautomator dump`（UiAutomation）**会把我们的无障碍服务挤掉**，制造一对**假** tamper（`无障碍守护已被关闭` + `无法自动恢复`），几秒后自动重连。设备端套件里的 `dumpUi()` 就是这种写法，查服务端事件列表时要认得这个噪声。
- 本地 `vite`（5180）看媒体图片会裂图：服务端按 `PUBLIC_BASE_URL` 签发**绝对** URL，而 helmet 的 `cross-origin-resource-policy: same-origin` 会拦掉跨源图片。**dev-only 现象，不是功能缺陷**（同源部署站正常）。
