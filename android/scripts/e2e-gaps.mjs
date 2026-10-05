#!/usr/bin/env node
/**
 * 气球狗 · 设备端 E2E「缺口补测」脚本（e2e-gaps）。
 *
 * e2e-agent.mjs 覆盖的是锁屏/截屏/录音这条主干闭环。本脚本专门补另一批
 * <b>只编译过、从未在设备上跑过</b>的功能，用真实设备断言把它们钉死：
 *
 *   1. 隐藏图标（IconHider：启动别名组件的 enable 状态 + 桌面入口可能否解析）
 *   2. 安全区 / 电子围栏（Geofence：设备本地判定并上报 geofence_enter / exit）
 *   3. 应用安装审核（LockWatchdogService.maybeReportInstallAttempt + OwnerHardening）
 *   4. 逐应用限时（AppLimitRule / AppUsageTracker / AppUsageReporter）
 *   5. 通话记录 + 短信上传（CallLogReader / SmsReader / CallsSmsUploader）
 *   6. 环境监听（AmbientRecorder：指令闭环 + 媒体真的出现在家长端）
 *   7. 网址拦截（DomainBlocker / DnsFilterVpnService：VPN 授权 + 服务真的在跑）
 *   8. 局数 / 集数预算（配置下发到设备的那一半）
 *   9. 远程协助（CommandExecutor.doRemoteAction：前台真的被切走）
 *
 * 三条硬规矩：
 *   - 每条断言都必须先立住「前提」再断言结果 —— 比如「前台不是桌面」在启动
 *     失败时也成立，是典型的假通过，所以必须先断言靶子真的起来了。
 *   - 占位/未覆盖的项显式打印 `⏭ 跳过（原因）`，绝不写成通过。
 *   - 发现的产品缺陷如实打 ✗，这正是本脚本存在的意义。
 *
 * 依赖：已启动的后端（server/，http://localhost:4000）、已启动的模拟器
 * （adb devices 能看到）、以及构建产物 android/app/build/outputs/apk/debug/app-debug.apk。
 * 强管控相关的断言需要设备所有者，脚本会自己尝试设置（要求设备 0 账号）。
 *
 * 用法：
 *   npm run android:e2e:gaps
 *   API_BASE=http://localhost:4000/api node android/scripts/e2e-gaps.mjs
 *   ADB=~/Library/Android/sdk/platform-tools/adb node android/scripts/e2e-gaps.mjs
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ANDROID_DIR = resolve(HERE, '..')
const APK = resolve(ANDROID_DIR, 'app/build/outputs/apk/debug/app-debug.apk')

const API_BASE = process.env.API_BASE || 'http://localhost:4000/api'
const PKG = 'com.balloondog.agent'
const HOME = process.env.HOME || ''
const ADB = process.env.ADB || `${HOME}/Library/Android/sdk/platform-tools/adb`

const PARENT_PHONE = process.env.PARENT_PHONE || '13800138000'
const PARENT_PASSWORD = process.env.PARENT_PASSWORD || 'balloon123'

// 管理后台账号，仅用于最后清理本轮联调留下的模拟器设备（见步骤 19）
const ADMIN_USER = process.env.ADMIN_USER || 'admin'
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'balloon-admin-2026'

// ---------------- 极简断言 ----------------
let passed = 0
let failed = 0
const ok = (label) => {
  passed++
  console.log(`  \x1b[32m✓\x1b[0m ${label}`)
}
const bad = (label, extra = '') => {
  failed++
  console.log(`  \x1b[31m✗\x1b[0m ${label}${extra ? ` — ${extra}` : ''}`)
}
const check = (cond, label, extra = '') => (cond ? ok(label) : bad(label, extra))
const step = (title) => console.log(`\n\x1b[1m${title}\x1b[0m`)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------------- adb ----------------
/**
 * 解析要操作的设备序列号。
 *
 * 这一步是安全措施，不是可选项：开发机上常常同时插着真机与模拟器，
 * 一条不带 -s 的 `adb install` / `pm clear` 会随机落到其中一台上 ——
 * 落到用户的真机上就意味着清数据、装调试包。所以本脚本永远显式指定目标：
 *   1. 优先用环境变量 ANDROID_SERIAL（标准做法，adb 自己也认）；
 *   2. 只有一台设备时用它；
 *   3. 多台时优先选 emulator-*，并把跳过真机这件事打印出来。
 */
function resolveSerial() {
  if (process.env.ANDROID_SERIAL) return process.env.ANDROID_SERIAL
  const out = spawnSync(ADB, ['devices'], { encoding: 'utf8' }).stdout || ''
  const serials = out
    .split('\n')
    .slice(1)
    .map((line) => line.trim().split(/\s+/))
    .filter((parts) => parts[1] === 'device')
    .map((parts) => parts[0])
  if (serials.length === 0) return null
  if (serials.length === 1) return serials[0]
  const emulator = serials.find((s) => s.startsWith('emulator-'))
  if (emulator) {
    const skipped = serials.filter((s) => s !== emulator)
    console.log(`  [注意] 检测到多台设备，本次只操作 ${emulator}，不动：${skipped.join('、')}`)
    return emulator
  }
  return serials[0]
}

/**
 * 某个悬浮窗是否<b>真的</b>挂在那儿。
 *
 * 不能直接对整个 dumpsys 输出做 grep：里面混着历史记录，例如
 *   mLastDisplayFreezeDuration=+1s125ms due to Window{238b2b4 u0 balloon-lock-overlay}
 * 窗口早就没了，这行还在。实测被它误导过一次（判定为「已锁定」，截图里却是桌面）。
 * 所以只认两种当前状态：
 *   1. mCurrentFocus=Window{... <title> ...}  —— 可聚焦的悬浮窗会成为焦点；
 *   2. Window #N Window{... <title> ...}      —— 活跃窗口列表里的条目。
 */
function windowAttached(title) {
  // 注意是 .out 不是 .text —— adb() 返回的是 { code, out, err }。
  // 写成 .text 会永远拿到 undefined → 这个判定恒为 false，
  // 「倒计时悬浮窗弹出了没有」这条断言就变成了永远失败的摆设。
  const out = adb('shell', 'dumpsys', 'window', 'windows').out || ''
  const focused = new RegExp(`mCurrentFocus=Window\\{[^}]*${title}[^}]*\\}`).test(out)
  const active = new RegExp(`Window #[0-9]+ Window\\{[^}]*${title}[^}]*\\}`).test(out)
  return focused || active
}

const SERIAL = resolveSerial()

function adb(...args) {
  // 永远带 -s：绝不把命令落到用户可能插着的真机上
  const result = spawnSync(ADB, SERIAL ? ['-s', SERIAL, ...args] : args, { encoding: 'utf8' })
  if (result.error) throw new Error(`adb 执行失败：${result.error.message}`)
  return { code: result.status, out: (result.stdout || '').trim(), err: (result.stderr || '').trim() }
}

function adbOrThrow(...args) {
  const { code, out, err } = adb(...args)
  if (code !== 0) throw new Error(`adb ${args.join(' ')} 失败：${err || out}`)
  return out
}

/** 以 shell 身份执行命令（用于读取设备上应用私有目录里的首选项文件） */
function shell(cmd) {
  return adbOrThrow('shell', cmd)
}

/**
 * 确保 adbd 处于 root。
 *
 * <p>必须每次要用之前都确认：**设备一重启，adbd 就退回非 root**。
 * 不确认的话 `kill -9 <pid>` 会以「Operation not permitted」静默失败
 * （adb() 不看退出码），于是「进程被杀后自动恢复」这条断言永远等不到新进程 ——
 * 看起来像保活失效，其实是测试根本没杀掉进程。这个坑真实踩过一整轮。
 */
async function ensureRoot() {
  const before = adb('shell', 'id').out || ''
  if (before.includes('uid=0')) return true
  adb('root')
  adb('wait-for-device')
  await sleep(2000)
  const after = adb('shell', 'id').out || ''
  return after.includes('uid=0')
}

/**
 * 杀掉应用进程，并确认真的杀掉了。
 *
 * @return true 表示进程确实没了（或杀掉后立刻以新 PID 回来）
 */
async function killAgentProcess() {
  const target = (adb('shell', 'pidof', PKG).out || '').trim()
  if (!target) return true
  adb('shell', 'kill', '-9', target)
  await sleep(1500)
  const still = (adb('shell', 'pidof', PKG).out || '').trim()
  return still !== target
}

/**
 * 以 root 身份读一个文件；拿不到 root 时返回 null（调用方据此跳过而不是误判失败）。
 *
 * <p>设备加密存储（{@code /data/user_de/0/...}）不在 run-as 的作用范围内，
 * 只有 root 读得到 —— 安全阀的证据恰好在那里。
 */
function rootCat(path) {
  adb('root')
  const out = adb('shell', 'cat', path)
  if (out.code !== 0 || /Permission denied|No such file/.test(out.err || '')) return null
  return out.out || ''
}

/**
 * dump 一次当前界面（uiautomator），返回 XML 文本；失败时返回空串。
 *
 * 关键点：每次都先删掉上一次的 dump 文件。uiautomator 在界面不空闲时会 dump 失败，
 * 如果直接 cat 就会读到<b>上一次的残留文件</b>，让断言基于过期界面得出结论 ——
 * 这是自动化测试里最隐蔽的一类假阳性。
 */
async function dumpUi() {
  // 必须先唤醒屏幕：本应用锁定时会调用 lockNow()（关屏），
  // 而屏幕处于 Asleep 时 uiautomator 拿不到 root node，
  // dump 会静默失败 —— 所有基于界面文本的断言就会莫名其妙地失败。
  adb('shell', 'input', 'keyevent', 'KEYCODE_WAKEUP')
  adb('shell', 'wm', 'dismiss-keyguard')
  // 重试要真的等：本应用有一个 2 秒一次的界面刷新 ticker，
  // 窗口因此经常进不了 uiautomator 要求的 idle 状态，dump 会失败或拿到残缺的层级。
  // （原来的实现用空循环「等」700 毫秒 —— 那是个忙等，一秒都没等，
  //   于是这类断言会随机失败，看起来像产品问题，其实是测试夹具的问题。）
  for (let attempt = 0; attempt < 5; attempt++) {
    adb('shell', 'rm', '-f', '/sdcard/balloon_ui.xml')
    adb('shell', 'uiautomator', 'dump', '/sdcard/balloon_ui.xml')
    const out = adb('shell', 'cat', '/sdcard/balloon_ui.xml').out || ''
    if (out.includes('<hierarchy')) return out
    await sleep(1500)
  }
  return ''
}

/**
 * 关掉可能残留的系统弹框。
 *
 * 屏幕共享授权框是 SystemUI 的窗口，一旦上一次运行没点掉，它会一直盖在最上层 ——
 * 后果不只是挡住界面：uiautomator 会因为拿不到稳定的 root node 而 dump 失败
 * （`ERROR: null root node returned by UiTestAutomationBridge`），
 * 于是所有基于界面文本的断言都会莫名其妙地失败。所以每轮 UI 操作前先清一次。
 */
async function clearSystemDialogs() {
  // 通知栏也要收起来：联调过程中会反复测试「锁定期间能不能下拉通知栏」，
  // 一旦有一轮把通知栏留在展开状态，焦点就落在 NotificationShade 上，
  // 后面所有界面断言都会看到一个空界面（实测踩过，现象极像产品起不来）。
  adb('shell', 'cmd', 'statusbar', 'collapse')
  await sleep(400)

  // 屏幕采集授权框（systemui 的 MediaProjectionPermissionActivity）是最麻烦的一个：
  // 它是系统界面，不清掉会一直盖在最上层，**而且能跨应用数据清空活到下一轮联调**。
  // 症状是「主界面已渲染」这类断言稳定失败，但手动看界面一切正常 —— 非常误导人。
  // 所以这里先看顶层活动，确认是系统弹框才按返回，按到它消失为止。
  const systemDialog = () => {
    const out = adb('shell', 'dumpsys', 'activity', 'activities').out || ''
    const top = out.split('\n').find((l) => l.includes('topResumedActivity')) || ''
    // 也包括本应用自己的「屏幕共享授权页」：它是个一次性的中转页，
    // 正常流程会自己关掉，但被中断时会留在最前面挡住主界面。
    return /systemui|permissioncontroller|MediaProjection|android\.packageinstaller|ProjectionConsentActivity/i.test(top)
  }
  for (let i = 0; i < 5; i++) {
    if (!systemDialog()) break
    adb('shell', 'input', 'keyevent', 'KEYCODE_BACK')
    await sleep(900)
  }
  // 兜底：还有些系统弹框不吃返回键，再用两次盲按
  for (let i = 0; i < 2; i++) {
    adb('shell', 'input', 'keyevent', 'KEYCODE_BACK')
    await sleep(600)
  }
  // 某些弹框被关掉后会留下一个空白的 recents，回桌面再继续更稳
  adb('shell', 'am', 'start', '-a', 'android.intent.action.MAIN',
    '-c', 'android.intent.category.HOME')
  await sleep(800)
}

/** 统计一段 shell 输出里的非空行数（避免 `grep -c` 计数为 0 时退出码非 0） */
function countLines(cmd) {
  const out = adb('shell', cmd).out || ''
  return out.split('\n').filter((line) => line.trim().length > 0).length
}

/**
 * 列出 dump 里出现的所有文本。
 *
 * <p>界面断言失败时把当时的屏幕内容打进失败信息 —— 否则只能看到「没找到某段文字」，
 * 完全不知道那一刻屏幕上到底是什么，排查全靠猜。
 */
function visibleTexts(xml) {
  return Array.from(new Set((xml.match(/text="[^"]+"/g) || []).map((t) => t.slice(6, -1))))
}

/** 在界面里按文本找一个节点的中心坐标；找不到返回 null */
function findNodeCenter(xml, text) {
  for (const node of xml.split('>')) {
    if (!node.includes(`text="${text}"`)) continue
    const match = node.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/)
    if (!match) continue
    const [, x1, y1, x2, y2] = match.map(Number)
    return { x: Math.round((x1 + x2) / 2), y: Math.round((y1 + y2) / 2) }
  }
  return null
}

/**
 * 按文本点击界面元素（必要时先向上滚动若干次把元素滚进可视区）。
 *
 * AgentService 刻意声明为 exported=false（shell 用户不能直接拉起它，
 * 这是正确的安全边界），所以联调必须像真人一样从界面点「启动守护」。
 */
async function tapByText(text, maxScrolls = 4) {
  for (let i = 0; i <= maxScrolls; i++) {
    const center = findNodeCenter(await dumpUi(), text)
    if (center) {
      adb('shell', 'input', 'tap', String(center.x), String(center.y))
      return true
    }
    adb('shell', 'input', 'swipe', '540', '1800', '540', '700', '300')
    await sleep(800)
  }
  return false
}

/** 当前界面上是否出现了某段文本 */
async function uiHasText(text) {
  return (await dumpUi()).includes(`text="${text}"`)
}

/**
 * 点掉系统弹出的授权框（屏幕共享 / 权限确认）。
 * 系统弹框不属于本应用的窗口，但 uiautomator dump 会把它一起 dump 出来。
 */
async function tapSystemConsent() {
  const ui = await dumpUi()
  // 系统弹框的按钮文案跟随系统语言：中文机是「立即开始」，英文机是「Start now」。
  // 这里两种都认，否则在 en-US 的测试机上会一直等不到点击而超时。
  const labels = [
    '立即开始', '开始录制', '开始共享', '允许', '确定',
    'Start now', 'Start recording', 'Start sharing', 'Allow', 'OK',
  ]
  for (const label of labels) {
    const center = findNodeCenter(ui, label)
    if (center) {
      adb('shell', 'input', 'tap', String(center.x), String(center.y))
      return label
    }
  }
  return null
}

/** 下发一条指令并等它结算；onPending 每轮轮询时调用一次（用于点授权框） */
async function dispatchAndWait(token, deviceId, path, body, options = {}) {
  const { timeoutMs = 90_000, onPending = null } = options
  const queued = await apiOrThrow('POST', `${path}?deviceId=${deviceId}`, { token, body })
  const commandId = queued.command?.id
  if (!commandId) return { queued, command: null }

  const deadline = Date.now() + timeoutMs
  let last = null
  let sawDispatched = false
  while (Date.now() < deadline) {
    const history = await apiOrThrow('GET', `/device/commands?deviceId=${deviceId}&limit=10`, { token })
    const command = history.commands?.find((c) => c.id === commandId)
    if (command) {
      last = command
      if (command.status === 'dispatched') sawDispatched = true
      if (['succeeded', 'failed', 'expired', 'cancelled'].includes(command.status)) {
        return { queued, command, sawDispatched }
      }
    }
    if (onPending) await onPending()
    await sleep(1500)
  }
  return { queued, command: last, sawDispatched }
}

/**
 * 下发一条指令，并容忍「被已断开的连接抢领」这一已知缺陷。
 *
 * 刚 kill 掉 Agent 进程时，服务端那条死掉的长轮询仍挂在 notifier 里；
 * notifyDevice 会把新旧两个等待者一起唤醒，谁先抢到谁把指令标成 dispatched，
 * 抢到的是死连接时响应就写进空气，指令永久卡在 dispatched（claimNext 只认
 * pending，没有重投递）。这里在卡住时重发一次，并把「第一次丢了」如实报出来。
 */
async function dispatchResilient(token, deviceId, path, body, options = {}) {
  const first = await dispatchAndWait(token, deviceId, path, body, options)
  if (first.command?.status !== 'dispatched') return { ...first, attempts: 1, lostFirst: false }
  await sleep(3000)
  const second = await dispatchAndWait(token, deviceId, path, body, options)
  return { ...second, attempts: 2, lostFirst: true, lostCommandId: first.command?.id }
}

/**
 * 轮询等待某个条件成立。
 *
 * @param probe 返回 true 表示条件已满足；也可以返回字符串作为「已满足」的说明
 * @returns { ok, detail, elapsedMs }
 */
async function waitFor(probe, { timeoutMs = 120_000, intervalMs = 3000, label = '条件' } = {}) {
  const start = Date.now()
  let last = null
  while (Date.now() - start < timeoutMs) {
    last = await probe()
    if (last === true || typeof last === 'string') {
      return { ok: true, detail: typeof last === 'string' ? last : '', elapsedMs: Date.now() - start }
    }
    await sleep(intervalMs)
  }
  return { ok: false, detail: '', elapsedMs: Date.now() - start, last }
}

/** Lock Task 状态：NONE / PINNED / LOCKED。LOCKED 才算真正锁死。 */
function lockTaskState() {
  const out = adb('shell', 'dumpsys', 'activity', 'activities').out || ''
  const match = out.match(/mLockTaskModeState=(\w+)/)
  return match ? match[1] : 'UNKNOWN'
}

/**
 * 当前处于前台的 Activity 名字。
 *
 * 刻意用 dumpsys 而不是 uiautomator：锁定动作会关屏，关屏时 uiautomator 拿不到 root node，
 * 而 dumpsys 不受影响 —— 判断「锁定页是否已关闭」必须用可靠的那条路。
 */
function resumedActivityName() {
  const out = adb('shell', 'dumpsys', 'activity', 'activities').out || ''
  const line = out.split('\n').find((l) => l.includes('topResumedActivity='))
  if (!line) return ''
  const match = line.match(/([A-Za-z0-9_.]+\/[A-Za-z0-9_.$]+)/)
  return match ? match[1] : ''
}

/** 锁定页是否仍在前台。 */
function lockPageShowing() {
  return resumedActivityName().includes('LockScreenActivity')
}

/** 倒计时悬浮窗是否已挂到 WindowManager 上。 */
function overlayAttached() {
  return windowAttached('balloon-countdown')
}

/** 全屏锁定悬浮窗（无设备所有者时的锁定手段）是否真的挂着。 */
function lockOverlayAttached() {
  return windowAttached('balloon-lock-overlay')
}

/** 取设备端最近的应用内日志（与界面上的「运行日志」是同一份）。 */
function agentLog(lines = 40) {
  return adb('shell', 'logcat', '-d', '-s', 'BalloonDog').out || ''
}

/** 读取设备首选项里的某个字符串值。 */
function prefValue(key) {
  const out = adb('shell', 'run-as', PKG, 'cat', 'shared_prefs/balloon_dog_agent_prefs.xml').out || ''
  const match = out.match(new RegExp(`name="${key}">([^<]*)<`))
  return match ? match[1] : null
}

/** 读取设备首选项里的某个布尔值。 */
function prefBool(key) {
  const out = adb('shell', 'run-as', PKG, 'cat', 'shared_prefs/balloon_dog_agent_prefs.xml').out || ''
  const match = out.match(new RegExp(`name="${key}" value="(true|false)"`))
  return match ? match[1] === 'true' : null
}

/**
 * 读任意类型的首选项（int/long/boolean 存的是 XML 属性，string 存的是文本节点）。
 *
 * prefValue/prefBool 只认其中一种 —— 预算那几个 key 用的是 putInt，
 * 用 prefValue 去读会永远拿到 null，然后「断言」看起来像产品没下发。
 */
function prefTyped(key) {
  const out = adb('shell', 'run-as', PKG, 'cat', 'shared_prefs/balloon_dog_agent_prefs.xml').out || ''
  const match = out.match(new RegExp(`<(?:string|int|long|boolean|float) name="${key}"(?: value="([^"]*)")?[^>]*>?([^<]*)`))
  if (!match) return null
  return match[1] !== undefined ? match[1] : (match[2] || '')
}

/** 分钟数 → "22:00" */
function fmtMinute(minute) {
  const clamped = Math.max(0, Math.min(1440, minute))
  if (clamped === 1440) return '24:00'
  return `${String(Math.floor(clamped / 60)).padStart(2, '0')}:${String(clamped % 60).padStart(2, '0')}`
}

/** 读取媒体原始字节（用后端返回的短时效签名 URL） */
async function fetchMediaBytes(relativeUrl) {
  const origin = API_BASE.replace(/\/api$/, '')
  const res = await fetch(origin + relativeUrl)
  const buffer = Buffer.from(await res.arrayBuffer())
  return { status: res.status, contentType: res.headers.get('content-type'), bytes: buffer }
}

async function waitForDevice(timeoutMs = 240_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const { out } = adb('devices')
    if (/emulator-\d+\s+device/.test(out) || /\tdevice$/.test(out)) return true
    await sleep(3000)
  }
  return false
}

async function waitForBoot(timeoutMs = 300_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const out = shell('getprop sys.boot_completed')
    if (String(out).trim() === '1') return true
    await sleep(3000)
  }
  return false
}

// ---------------- HTTP ----------------
async function api(method, path, { body, token } = {}) {
  const headers = {}
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  if (token) headers.Authorization = `Bearer ${token}`
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let parsed = null
  try {
    parsed = text ? JSON.parse(text) : null
  } catch {
    parsed = text
  }
  return { status: res.status, ok: res.ok, body: parsed }
}

async function apiOrThrow(method, path, options) {
  const res = await api(method, path, options)
  if (!res.ok) {
    const message = res.body?.message || `HTTP ${res.status}`
    throw new Error(`${method} ${path} 失败：${message}`)
  }
  return res.body
}

/**
 * 清掉本机型号下遗留的设备记录。
 *
 * <p>为什么必须在**开跑之前**也清一次：每跑一次都会 register 出一台新设备，
 * 中途失败的运行会留下孤儿行。更要紧的是，这些遗留行可能停在「已绑定 + 已锁定」，
 * 而 Agent 重装、清空数据后会重新注册并认出同一台设备 —— 于是**一开机就是锁定页**，
 * 后面的界面断言全部作废（实测踩到：阶段 4「主界面已渲染」连续失败，
 * 手动确认首屏就是锁定页）。测试必须从已知的干净状态开始，否则结论不可信。
 *
 * <p>家长端没有删除未认领设备的接口，所以走管理后台的处置接口
 * （这正是那个接口存在的意义）。只删「型号等于本机型号」的记录，不误伤演示数据。
 */
async function purgeLeftoverDevices(model, keepIds = []) {
  let purged = 0
  try {
    const adminLogin = await apiOrThrow('POST', '/admin/login', {
      body: { username: ADMIN_USER, password: ADMIN_PASSWORD },
    })
    const adminToken = adminLogin.token
    // 后台列表统一返回 { page, pageSize, total, totalPages, items }（见 server 的 parsePagination）
    const list = await apiOrThrow(
      'GET', `/admin/devices?q=${encodeURIComponent(model)}&pageSize=100`, { token: adminToken })
    for (const device of list.items ?? []) {
      if (device.model !== model) continue
      if (keepIds.includes(device.id)) continue
      const res = await api('DELETE', `/admin/devices/${device.id}`, { token: adminToken })
      if (res.ok) purged++
    }
  } catch (error) {
    bad('清理遗留设备失败', error.message)
    return -1
  }
  return purged
}

/** 本机型号（Agent 注册时上报的是「厂商 + 机型」，见 AgentApi.register）。 */
function deviceModel() {
  const manufacturer = shell('getprop ro.product.manufacturer').trim()
  const productModel = shell('getprop ro.product.model').trim()
  return `${manufacturer} ${productModel}`.trim()
}

// ============================================================
// 缺口补测专用辅助
// ============================================================

let skipped = 0
const SKIPS = []

/**
 * 本轮被测的那台设备。
 *
 * 家长侧接口（/features、/safe-zones、/device-events、/calls、/sms、/media …）
 * 都用 server 的 `resolveDevice()` 决定「操作哪台设备」：请求里不显式带 deviceId 时，
 * 它会退化成「该家长最早绑定的那台」—— 同一账号下还有别的历史设备时，
 * 不带这个参数测的根本不是被测设备。所以本轮一律显式指定。
 */
let ACTIVE_DEVICE_ID = ''
const dq = (path) => `${path}${path.includes('?') ? '&' : '?'}deviceId=${ACTIVE_DEVICE_ID}`
/**
 * 明确记录「本轮没有在设备上验证到」的项。
 *
 * <p>跳过必须是显式的：把没跑过的断言写成通过，比没有测试更糟 ——
 * 后面的人会以为这条链路上已经有设备级证据了。
 */
const skip = (label, reason) => {
  skipped++
  SKIPS.push({ label, reason })
  console.log(`  \x1b[33m⏭\x1b[0m 跳过：${label} — ${reason}`)
}

/** 让 Agent 进程重启一次：新进程第一轮循环会立刻 applyConfig + 上报位置 + flush 事件。 */
async function restartAgent(timeoutMs = 90_000) {
  const before = (adb('shell', 'pidof', PKG).out || '').trim()
  if (before) adb('shell', 'kill', '-9', before)
  let revived = await waitFor(() => {
    const pid = (adb('shell', 'pidof', PKG).out || '').trim()
    return pid && pid !== before ? `新进程 ${pid}` : false
  }, { timeoutMs: Math.min(timeoutMs, 30_000), intervalMs: 2500, label: 'Agent 进程重启' })
  if (!revived.ok) {
    // 前台服务被系统回收后不一定自动回来（尤其是刚设完设备所有者的那几次），
    // 显式拉一次主界面，避免后面的用例因为「进程不在」而集体假失败。
    adb('shell', 'am', 'start', '-n', `${PKG}/.ui.MainActivity`)
    revived = await waitFor(() => {
      const pid = (adb('shell', 'pidof', PKG).out || '').trim()
      return pid ? `新进程 ${pid}` : false
    }, { timeoutMs: 60_000, intervalMs: 2500, label: 'Agent 进程重启' })
  }
  if (revived.ok) await sleep(5000) // 让第一轮循环跑完（applyConfig → 定位 → 事件 flush）
  return revived
}

async function setFeature(token, feature, enabled) {
  return apiOrThrow('PUT', dq('/features'), { token, body: { feature, enabled } })
}

/** prefs 里某个字符串值是否包含指定片段（JSON 被 XML 转义过，只能做子串判断） */
function prefContains(key, needle) {
  const value = prefValue(key)
  return typeof value === 'string' && value.includes(needle)
}

/** prefs 里某个 JSON 数组出现了几次某字段（用来数规则条数） */
function prefCount(key, field) {
  const raw = prefValue(key)
  if (!raw) return 0
  const match = raw.match(new RegExp(field, 'g'))
  return match ? match.length : 0
}

/** prefs 文件是 XML，`prefValue` 拿到的是转义后的文本；还原成原始字符串。 */
function unescapeXml(text) {
  return String(text || '')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

/** 读一个 JSON 型 prefs 值并解析；读不到或解析不了返回 null。 */
function prefJson(key) {
  const raw = prefValue(key)
  if (!raw) return null
  try {
    return JSON.parse(unescapeXml(raw))
  } catch {
    return null
  }
}

/**
 * `dumpsys user` 里「Device policy local restrictions」这一段是否含某条限制。
 *
 * <p>为什么不用 `dumpsys device_policy`：那里根本没有用户限制清单，
 * `userRestrictions: none` 是 device-admin 自己的块。设备所有者经 `dpm.addUserRestriction`
 * 施加的限制（如 no_install_apps）只出现在 `dumpsys user` 的这两段里。
 */
function localUserRestriction(name) {
  const out = adb('shell', 'dumpsys', 'user').out || ''
  const after = out.split('Device policy local restrictions:')[1] || ''
  const local = after.split('Effective restrictions:')[0] || ''
  return new RegExp(`\\b${name}\\b`).test(local)
}

/** 今天某个包的前台秒数（设备端缓存的 app_usage_json） */
function usageSecondsFor(pkg) {
  const parsed = prefJson('app_usage_json')
  const usage = parsed?.usage || {}
  return typeof usage[pkg] === 'number' ? usage[pkg] : 0
}

/**
 * 拉起床「包安装器」的窗口。
 *
 * <p>为什么用 ACTION_DELETE（卸载确认页）而不是「安装页」：Android 13 的
 * `com.android.packageinstaller.InstallStart` 只声明了 `content://` 的 filter，
 * 而从 adb 拿不到任何它有权读的 APK URI —— `externalstorage` provider 对 uid 0 / 2000
 * 都抛 `SecurityException: UID ... does not have permission ...`（实测）。
 * 卸载确认页属于同一个包（`com.google.android.packageinstaller`），
 * 而设备端的判定入口 `LockWatchdogService.maybeReportInstallAttempt` 认的就是这个包名白名单。
 */
function raiseInstallerWindow(targetPkg) {
  return adb('shell', 'am', 'start', '-a', 'android.intent.action.DELETE', '-d', `package:${targetPkg}`)
}

/** 挑一个已安装的包当卸载确认页的靶子（只弹窗，绝不点确定） */
function pickUninstallTargets() {
  const installed = adb('shell', 'pm', 'list', 'packages').out || ''
  const candidates = [
    'com.google.android.apps.maps',
    'com.google.android.apps.photos',
    'com.google.android.deskclock',
    'com.android.settings',
  ]
  const usable = candidates.filter((pkg) => installed.includes(`package:${pkg}`))
  return usable.length > 0 ? usable : ['com.android.settings']
}

/**
 * 逐个候选包尝试拉起「卸载确认页」，直到顶层窗口真的是包安装器。
 *
 * 单次 `am start` 的成败不能只看返回码：解析失败时 am 会把
 * `Error: Activity not started, unable to resolve Intent` 写在 stderr 上，
 * 而 stdout 仍然是空的。所以这里既看 stderr，也复核顶层窗口 —— 后者才是
 * 无障碍服务真正会看到的「安装器窗口」。
 *
 * ★必须在非 root 的 shell（uid 2000）下发起：`adb root` 之后 am 的调用者变成
 * uid 0，UninstallerActivity 会打印 `Package not found for originating uid 0`
 * 并立刻自尽，顶层窗口纹丝不动（实测踩到，整整一轮第 4 步假失败）。
 * 因此这里临时 unroot，结束后恢复 root（后续 restartAgent 要 root 才能 kill）。
 */
async function raiseAnyInstallerWindow() {
  const wasRoot = (adb('shell', 'id').out || '').includes('uid=0')
  if (wasRoot) {
    adb('unroot')
    adb('wait-for-device')
    await sleep(3000)
  }
  const targets = pickUninstallTargets()
  const tried = []
  try {
    for (const pkg of targets) {
      adb('shell', 'input', 'keyevent', 'KEYCODE_BACK')
      await sleep(1200)
      const res = raiseInstallerWindow(pkg)
      const err = (res.err || '').trim()
      const top = await waitFor(() => {
        const now = resumedActivityName()
        return /packageinstaller|PackageInstaller/i.test(now) ? now : false
      }, { timeoutMs: 12_000, intervalMs: 1500 })
      tried.push({ pkg, err, top: top.detail || resumedActivityName() })
      if (top.ok) return { ok: true, pkg, top: top.detail, tried, wasRoot }
    }
    return { ok: false, pkg: null, top: null, tried, wasRoot }
  } finally {
    if (wasRoot) await ensureRoot()
  }
}

/**
 * 桌面入口此刻是否可被系统解析。
 *
 * 「隐藏图标」的产品语义就是「桌面上点不进去」，所以直接问 PackageManager
 * 能不能解析 LAUNCHER Intent —— 比读组件状态更贴近用户可观察的事实。
 */
function launcherResolvable() {
  const res = adb('shell', 'cmd', 'package', 'resolve-activity', '--brief',
    '-a', 'android.intent.action.MAIN', '-c', 'android.intent.category.LAUNCHER', PKG)
  return /MainActivityLauncher/.test(res.out || '')
}

/** dumpsys package 里那个启动别名组件当前被设成什么状态 */
function aliasComponentState() {
  const out = adb('shell', 'dumpsys', 'package', PKG).out || ''
  if (/disabledComponents:\s*\n\s*com\.balloondog\.agent\.MainActivityLauncher/.test(out)) return 'disabled'
  if (/enabledComponents:\s*\n\s*com\.balloondog\.agent\.MainActivityLauncher/.test(out)) return 'enabled'
  return 'unknown'
}

function vpnServiceRunning() {
  return /DnsFilterVpnService/.test(adb('shell', 'dumpsys', 'activity', 'services').out || '')
}

/** 取设备端最近的应用内日志（agentLog 已经把整个 buffer 拉回来了，这里只做匹配） */
function logOf(pattern) {
  return new RegExp(pattern).test(agentLog())
}

/**
 * 把当前 logcat 里匹配的行取出来。
 *
 * 模拟器的 2 MiB 环形缓冲在「已同步 N 条应用限额」这类周期日志下滚得很快，
 * 长等待之后再用 logOf 判定会因为日志被挤掉而假失败 —— 需要在等待的每个
 * 节点立刻把命中的行抓进变量。
 */
function logLines(pattern) {
  return (agentLog().match(new RegExp(pattern, 'g')) || [])
}

async function listDeviceEvents(token, type, pageSize = 30) {
  const query = type ? `type=${encodeURIComponent(type)}&pageSize=${pageSize}` : `pageSize=${pageSize}`
  const res = await api('GET', dq(`/device-events?${query}`), { token })
  return res.ok ? (res.body?.items ?? []) : []
}

async function listMedia(token, kind) {
  const res = await api('GET', dq(`/media?kind=${kind}`), { token })
  return res.ok ? (res.body?.media ?? []) : []
}

// ============================================================
// 主流程
// ============================================================
async function main() {
  console.log('\x1b[1m气球狗 · 设备端 E2E 缺口补测（e2e-gaps）\x1b[0m')
  console.log('  目标：给一批「只编译过、从未上机」的功能补真实设备断言\n')
  console.log(`  APK      ${APK}`)
  console.log(`  API      ${API_BASE}`)
  console.log(`  设备     ${SERIAL || '(未检测到)'}`)

  // ---------------- 0. 前置 ----------------
  step('0. 前置检查')
  if (!SERIAL) throw new Error('没有可用设备（adb devices 为空）')
  const origin = API_BASE.replace(/\/api$/, '')
  const health = await fetch(`${origin}/health`).then((r) => r.status).catch(() => 0)
  check(health > 0, `后端可连接（/health → HTTP ${health}）`)
  if (!(await waitForDevice(60_000))) throw new Error('设备未就绪')
  await waitForBoot(180_000)
  check(existsSync(APK), `APK 构建产物存在（${APK}）`)
  if (!existsSync(APK)) throw new Error('APK 不存在')

  // ---------------- 1. 环境准备 ----------------
  step('1. 环境准备：安装 / 清数据 / 权限 / 设备所有者 / 启动守护 / 绑定')
  const model = deviceModel()
  const purged = await purgeLeftoverDevices(model)
  if (purged >= 0) ok(`清理了 ${purged} 台同型号的遗留设备记录`)

  adbOrThrow('install', '-r', '-g', APK)
  ok('APK 安装成功（-r -g）')

  await ensureRoot()
  shell('settings put secure enabled_accessibility_services null')
  await killAgentProcess()
  shell(`rm -rf /data/data/${PKG}/shared_prefs /data/data/${PKG}/cache /data/user_de/0/${PKG}/shared_prefs`)
  ok('已清空应用数据（测试从确定状态开始）')

  // 与本轮功能直接相关的权限全部显式授予，避免「测的其实是权限没给」
  const permissions = [
    'android.permission.CAMERA',
    'android.permission.RECORD_AUDIO',
    'android.permission.ACCESS_FINE_LOCATION',
    'android.permission.ACCESS_COARSE_LOCATION',
    'android.permission.POST_NOTIFICATIONS',
    'android.permission.READ_CALL_LOG',
    'android.permission.READ_SMS',
  ]
  for (const permission of permissions) adb('shell', 'pm', 'grant', PKG, permission)
  adb('shell', 'appops', 'set', PKG, 'SYSTEM_ALERT_WINDOW', 'allow')
  // 逐应用限时依赖「使用情况访问」这个特殊权限（AppUsageTracker.hasPermission 查的正是它）
  adb('shell', 'appops', 'set', PKG, 'GET_USAGE_STATS', 'allow')

  const usageOp = shell(`appops get ${PKG} GET_USAGE_STATS`)
  check(/allow/i.test(usageOp), '「使用情况访问」权限已授予（逐应用限时的前提）', usageOp)

  shell(`settings put secure enabled_accessibility_services ${PKG}/${PKG}.service.LockWatchdogService`)
  shell('settings put secure accessibility_enabled 1')
  await sleep(1500)

  // 设备所有者：安装审核的「真的拦得住」与系统级用户限制都需要它
  let isDeviceOwner = shell('dpm list-owners').includes(PKG)
  if (!isDeviceOwner) {
    const accounts = countLines('dumpsys account | grep "Account {"')
    const res = adb('shell', 'dpm', 'set-device-owner', `${PKG}/.capability.AgentAdminReceiver`)
    isDeviceOwner = shell('dpm list-owners').includes(PKG)
    if (!isDeviceOwner) {
      bad('设置设备所有者失败',
        `accounts=${accounts} code=${res.code} ${(res.out || res.err || '').slice(0, 160)}`)
    }
  }
  check(isDeviceOwner, isDeviceOwner
    ? '本机已设为设备所有者（强管控断言的前提具备）'
    : '本机未设为设备所有者：依赖它的断言会降级为跳过')

  adb('logcat', '-c')
  await clearSystemDialogs()
  adb('shell', 'input', 'keyevent', 'KEYCODE_WAKEUP')
  adb('shell', 'wm', 'dismiss-keyguard')
  adbOrThrow('shell', 'am', 'start', '-n', `${PKG}/.ui.MainActivity`)
  const mainRendered = await waitFor(async () =>
    (await dumpUi()).includes('text="运行状态"') && '主界面已渲染',
  { timeoutMs: 60_000, intervalMs: 2000 })
  check(mainRendered.ok, '主界面已渲染')

  const mainUi = await dumpUi()
  if (mainUi.includes('text="停止守护"') || mainUi.includes('text="守护运行中"')) {
    ok('守护服务原本已在运行')
  } else {
    check(await tapByText('启动守护'), '已在界面上点击「启动守护」')
    await sleep(7000)
  }

  let deviceCode = ''
  for (let i = 0; i < 10 && !deviceCode; i++) {
    const xml = adb('shell', 'run-as', PKG, 'cat', 'shared_prefs/balloon_dog_agent_prefs.xml')
    if (xml.code === 0) {
      const match = xml.out.match(/name="device_code">([^<]+)</)
      if (match) deviceCode = match[1]
    }
    if (!deviceCode) await sleep(2000)
  }
  check(/^[A-Z0-9]{6,12}$/.test(deviceCode), `绑定码已生成：${deviceCode}`)
  if (!deviceCode) throw new Error('拿不到绑定码，后续无法进行')

  const login = await apiOrThrow('POST', '/auth/login', {
    body: { phone: PARENT_PHONE, password: PARENT_PASSWORD },
  })
  const token = login.token
  check(Boolean(token), `家长 ${PARENT_PHONE} 登录成功`)

  const bind = await apiOrThrow('POST', '/devices/bind', {
    token, body: { deviceCode, name: 'E2E 缺口补测设备' },
  })
  const deviceId = bind.device?.id
  ACTIVE_DEVICE_ID = deviceId
  check(Boolean(deviceId), `设备已认领（deviceId=${deviceId}）`)

  const online = await waitFor(async () => {
    const d = await apiOrThrow('GET', `/device?deviceId=${deviceId}`, { token })
    return d.status === 'online' ? `在线（电量 ${d.battery}%）` : false
  }, { timeoutMs: 60_000, intervalMs: 3000 })
  check(online.ok, '设备心跳已把在线状态写回后端')

  // ============================================================
  // 2. 隐藏图标
  // ============================================================
  step('2. 隐藏图标（capability/IconHider.java）')
  try {
    const baseline = launcherResolvable()
    // 前提必须先立住：如果基线本来就解析不到，后面的「隐藏成功」就是假通过
    check(baseline, '前提：隐藏前桌面入口可被 PackageManager 解析（基线）',
      `alias 组件状态=${aliasComponentState()}`)
    if (baseline) {
      adb('logcat', '-c')
      await apiOrThrow('PUT', `/devices/${deviceId}`, { token, body: { hideIcon: true } })
      const r1 = await restartAgent()
      check(r1.ok, '改完设备字段后 Agent 重启（新进程立刻拉取 config）', r1.detail)

      const gotSwitch = await waitFor(() => prefBool('hide_icon') === true && 'hide_icon=true',
        { timeoutMs: 60_000, intervalMs: 2000 })
      check(gotSwitch.ok, '设备端确实收到了隐藏开关（pref hide_icon=true）')

      const hidden = await waitFor(() => !launcherResolvable() && 'launcher 不可解析',
        { timeoutMs: 30_000, intervalMs: 2000 })
      check(hidden.ok, '桌面入口已不可解析 —— 图标真的被隐藏了')

      check(aliasComponentState() === 'disabled',
        `dumpsys 里启动别名组件为 disabled（实际 ${aliasComponentState()}）`)
      check(logOf('桌面图标已隐藏'), '设备端日志确认「桌面图标已隐藏」')

      // 反向：必须可逆，否则这是「销毁入口」而不是「隐藏入口」
      await apiOrThrow('PUT', `/devices/${deviceId}`, { token, body: { hideIcon: false } })
      await restartAgent()
      const shown = await waitFor(() => launcherResolvable() && 'launcher 恢复可解析',
        { timeoutMs: 60_000, intervalMs: 2000 })
      check(shown.ok, '关掉开关后桌面入口恢复可解析（可逆）')
      check(aliasComponentState() === 'enabled',
        `dumpsys 里启动别名组件恢复 enabled（实际 ${aliasComponentState()}）`)
    }
  } catch (error) {
    bad('隐藏图标验证异常中断', error.message)
  }

  // ============================================================
  // 3. 安全区 / 电子围栏
  // ============================================================
  step('3. 安全区 / 电子围栏（capability/Geofence.java）')
  let zoneId = null
  try {
    // 灌一个确定的 GPS 坐标，再让 Agent 重启去读它。
    // 中心点用「设备真实上报的坐标」，这样「区内/区外」的判定不依赖模拟器是否
    // 真的把 geo fix 写进了 last known location（e2e-agent 里已记录过这个坑）。
    adb('emu', 'geo', 'fix', '116.3975', '39.9087')
    await sleep(2000)
    await restartAgent()

    let center = null
    const located = await waitFor(async () => {
      const res = await api('GET', `/locations/latest?deviceId=${deviceId}`, { token })
      const loc = res.ok ? res.body?.location : null
      if (loc && typeof loc.latitude === 'number' && typeof loc.longitude === 'number') {
        center = loc
        return `设备上报坐标 ${loc.latitude}, ${loc.longitude}`
      }
      return false
    }, { timeoutMs: 120_000, intervalMs: 4000 })
    check(located.ok, `前提：设备真的上报了定位（${located.detail}）`)

    if (located.ok && center) {
      const { latitude: lat0, longitude: lon0 } = center
      const zoneName = 'E2E 安全区'
      const created = await api('POST', dq('/safe-zones'), {
        token,
        body: { name: zoneName, latitude: lat0, longitude: lon0, radiusMeters: 1000, type: 'other' },
      })
      zoneId = created.body?.safeZone?.id ?? null
      check(created.status === 201 && Boolean(zoneId),
        `安全区已创建（中心=${lat0}, ${lon0}，半径 1000m，id=${zoneId}）`)

      await restartAgent()
      const onDevice = await waitFor(() => prefContains('safe_zones', zoneId) && 'safe_zones 已落盘',
        { timeoutMs: 60_000, intervalMs: 2000 })
      check(onDevice.ok, '安全区配置已下发并落盘到设备（pref safe_zones 含该区 id）')

      const enter = await waitFor(async () => {
        const events = await listDeviceEvents(token, 'geofence_enter')
        const hit = events.find((e) => String(e.detail || '').includes(zoneName))
        return hit ? `事件 #${hit.id}：${hit.detail}` : false
      }, { timeoutMs: 120_000, intervalMs: 5000 })
      check(enter.ok, '设备本地判定「在安全区内」并上报 geofence_enter（家长端动态可读）',
        enter.detail)
      check(prefValue('last_safe_zone_id') === zoneId,
        `设备记录的「当前所在安全区」= 刚建的那个（实际 ${prefValue('last_safe_zone_id')}）`)

      // 把安全区搬到 2 个纬度（≈222 公里）之外，设备坐标不动 → 必须切到「区外」
      await api('PUT', dq(`/safe-zones/${zoneId}`), {
        token,
        body: {
          name: zoneName, latitude: lat0 + 2, longitude: lon0,
          radiusMeters: 1000, type: 'other', enabled: true,
        },
      })
      await restartAgent()
      const exit = await waitFor(async () => {
        const events = await listDeviceEvents(token, 'geofence_exit')
        const hit = events.find((e) => String(e.detail || '').includes(zoneName))
        return hit ? `事件 #${hit.id}：${hit.detail}` : false
      }, { timeoutMs: 120_000, intervalMs: 5000 })
      check(exit.ok, '把安全区移走后，设备判定「在区外」并上报 geofence_exit', exit.detail)
      check(!prefValue('last_safe_zone_id'),
        '设备已清空「当前所在安全区」（离开后不再记录在区内）',
        `实际 last_safe_zone_id=${prefValue('last_safe_zone_id')}`)

      // ---- 停用（而不是删除/搬走）围栏 ----
      // 家长端新加的启停开关会产生这条路径：服务端一旦不下发该围栏，设备侧
      // 「上次所在区」就成了指向不存在对象的悬挂状态。不修的话症状很隐蔽 ——
      // 家长某天重新启用，孩子早已离开，却会在那一刻收到一条假的「离开 X」。
      await api('PUT', dq(`/safe-zones/${zoneId}`), {
        token,
        body: {
          name: zoneName, latitude: lat0, longitude: lon0,
          radiusMeters: 1000, type: 'other', enabled: true,
        },
      })
      await restartAgent()
      const reenter = await waitFor(
        () => (prefValue('last_safe_zone_id') === zoneId ? `last_safe_zone_id=${zoneId}` : false),
        { timeoutMs: 120_000, intervalMs: 5000 })
      check(reenter.ok, '把安全区搬回来后重新进入区内（last_safe_zone_id 重新写上）', reenter.detail)

      const countExits = async () =>
        (await listDeviceEvents(token, 'geofence_exit'))
          .filter((e) => String(e.detail || '').includes(zoneName)).length
      const exitsBefore = await countExits()

      await api('PUT', dq(`/safe-zones/${zoneId}`), { token, body: { enabled: false } })
      await restartAgent()
      const cleared = await waitFor(
        () => (!prefValue('last_safe_zone_id') ? 'last_safe_zone_id 已清空' : false),
        { timeoutMs: 120_000, intervalMs: 5000 })
      check(cleared.ok,
        '停用围栏后设备清掉了「当前所在安全区」（否则重新启用时会补发一条假「离开」）',
        cleared.detail)

      const exitsAfter = await countExits()
      check(exitsAfter === exitsBefore,
        '停用围栏不会编造 geofence_exit（孩子没离开，是家长关掉了围栏）',
        `停用前 ${exitsBefore} 条，停用后 ${exitsAfter} 条`)
    }
  } catch (error) {
    bad('安全区验证异常中断', error.message)
  } finally {
    if (zoneId) await api('DELETE', dq(`/safe-zones/${zoneId}`), { token })
  }

  // ============================================================
  // 4. 应用安装审核
  // ============================================================
  step('4. 应用安装审核（LockWatchdogService.maybeReportInstallAttempt + OwnerHardening）')
  // 供第 5 步复用：待审核的应用名，以及「卸载确认页」的靶子包
  let auditAppName = null
  let uninstallTarget = null
  try {
    await setFeature(token, 'appAudit', true)
    await restartAgent()
    const gotFeature = await waitFor(() => prefContains('features', 'appAudit') && 'features 含 appAudit',
      { timeoutMs: 60_000, intervalMs: 2000 })
    check(gotFeature.ok, '设备端已收到「应用审核」开关（pref features 含 appAudit）')

    if (isDeviceOwner) {
      const restricted = await waitFor(() => localUserRestriction('no_install_apps') && 'no_install_apps 已施加',
        { timeoutMs: 60_000, intervalMs: 3000 })
      check(restricted.ok,
        '设备所有者已施加 no_install_apps 用户限制（dumpsys user；孩子侧真的装不了应用）')
    } else {
      skip('安装审核的系统级拦截', '本机不是设备所有者，no_install_apps 无法施加')
    }

    // 让「包安装器」界面真的出现 —— 无障碍服务只在安装器窗口里才会判为安装尝试
    adb('shell', 'input', 'keyevent', 'KEYCODE_BACK')
    await sleep(1500)
    adb('logcat', '-c')
    const installer = await raiseAnyInstallerWindow()
    uninstallTarget = installer.pkg

    check(installer.ok,
      `前提：包安装器界面真的起来了（靶子 ${installer.pkg}，顶层 ${installer.top}）`,
      installer.ok ? null : `逐个候选包都没拉起安装器：${JSON.stringify(installer.tried)}`)

    // 留给第 5 步用：批准这条申请是唯一能把「带 packageName 的限额规则」下发到设备的路径
    if (installer.ok) {
      let pendingSeen = []
      const auditSeen = await waitFor(async () => {
        const features = await api('GET', dq('/features'), { token })
        pendingSeen = features.body?.appAudit?.pendingApps ?? []
        return pendingSeen.length > 0 ? `pendingApps=${JSON.stringify(pendingSeen)}` : false
      }, { timeoutMs: 90_000, intervalMs: 4000 })
      check(auditSeen.ok, '家长端真的收到了安装审核申请（GET /api/features → appAudit.pendingApps 非空）',
        auditSeen.detail || '超时仍未收到申请')
      auditAppName = pendingSeen[0] ?? null
      // 这个键是 putLong 写进去的，prefValue（只认 <string>）会永远读到 null，
      // 必须用 prefTyped。
      const lastAuditAt = Number(prefTyped('install_audit_last_at') || 0)
      check(lastAuditAt > 0,
        `设备端记录了最近一次审核上报时间（pref install_audit_last_at=${lastAuditAt}）`)
      check(Boolean(logOf('安装审核申请已提交')), '设备端日志确认审核申请真的提交给了家长端')
    } else {
      skip('安装审核申请上报',
        `模拟器上拉不起包安装器界面（am start ACTION_DELETE 后顶层是 ${resumedActivityName() || '未知'}），`
        + '无法触发无障碍的安装尝试判定')
    }

    // 刻意不关 appAudit：第 5 步要用这条待审核申请走「批准 → 限额规则」的链路，
    // 批准后的「临时放开安装限制」也只有在开关仍开着时才有意义。
    adb('shell', 'input', 'keyevent', 'KEYCODE_BACK')
    await sleep(1000)
  } catch (error) {
    bad('安装审核验证异常中断', error.message)
  }

  // ============================================================
  // 5. 逐应用限时
  // ============================================================
  step('5. 逐应用限时（AppUsageTracker / AppUsageReporter / AppLimitRule）')
  const installerPkg = 'com.google.android.packageinstaller'
  const clockPkg = 'com.google.android.deskclock'
  let clockLabel = 'Clock'
  try {
    // ---------------------------------------------------------------
    // 5a 家长端「应用限时」真实路径：从孩子设备上报的应用清单里选应用（拿真实包名）
    //
    // 这条路径过去 100% 失效：家长端只发 appName → 服务端存成 packageName='' →
    // 设备端 DeviceConfig.appLimitRules() 直接丢弃 → 规则表永远为空 →
    // AppUsageReporter 顺手清空用量缓存 → 家长端「已用 0 分钟」永远是 0。
    // 现在家长端从 GET /api/device-apps?includeSystem=true 里选**可启动**的应用，
    // PUT 带上 packageName；服务端校验「这个包确实在设备清单里且能被启动」才落库。
    // ---------------------------------------------------------------
    // 设备 12 小时才自动上报一次清单（apps_reported_at 跨轮次保留在 prefs 里），
    // 所以先主动触发一次同步，否则新绑定的设备上清单可能是空的。
    await apiOrThrow('POST', dq('/device-apps/refresh'), { token, body: {} })
    const inventoryOk = await waitFor(async () => {
      const inv = await apiOrThrow('GET', dq('/device-apps?includeSystem=true'), { token })
      const hit = (inv?.apps ?? []).find((a) => a.packageName === clockPkg)
      if (!hit || !hit.isLaunchable) return null
      clockLabel = hit.appName || clockPkg
      return `清单含可启动的 ${clockPkg}（appName=${clockLabel}，共 ${inv.total} 个）`
    }, { timeoutMs: 120_000, intervalMs: 5_000 })
    check(inventoryOk.ok,
      '设备上报的应用清单里有可启动的「时钟」—— 家长端选应用的真实来源',
      inventoryOk.detail || inventoryOk.last || `等待 ${inventoryOk.elapsedMs}ms 仍未上报`)

    // 家长端 UI 现在就是这么调的：选中清单里的「时钟」→ 带 appName + packageName + limit
    await apiOrThrow('PUT', dq('/features/app-limit'), {
      token, body: { appName: clockLabel, packageName: clockPkg, limit: 1 },
    })
    const served = await apiOrThrow('GET', dq('/features'), { token })
    const servedEntry = served?.appLimit?.apps?.[clockLabel]
    check(servedEntry?.packageName === clockPkg,
      `家长端设的限额已写到服务端并带上真实包名（${clockLabel} → ${clockPkg}）`,
      `appLimit.apps=${JSON.stringify(served?.appLimit?.apps ?? {})}`)

    // 反向断言：服务端不再接受「没有包名」的限额（旧契约就是从这里静默写空包名废行的）
    const noPkg = await api('PUT', dq('/features/app-limit'), {
      token, body: { appName: 'E2E 无包名应用', limit: 1 },
    })
    check(!noPkg.ok && noPkg.status === 400,
      '家长端不带 packageName 设限额被服务端拒绝（不再静默写入空包名废行）',
      `HTTP ${noPkg.status} ${JSON.stringify(noPkg.body)}`)

    // 反向断言：不可启动的包（安装器）也拒绝 —— 给它设限就是留一条永不触发的假规则
    const deadPkg = await api('PUT', dq('/features/app-limit'), {
      token, body: { appName: 'Package installer', packageName: installerPkg, limit: 30 },
    })
    check(!deadPkg.ok && deadPkg.status === 400,
      '给没有桌面入口的包（安装器）设限额被服务端拒绝（不留永不触发的假规则）',
      `HTTP ${deadPkg.status} ${JSON.stringify(deadPkg.body)}`)

    await restartAgent()

    check(prefContains('app_limits', clockLabel),
      '限额的展示串已下发到设备（pref app_limits 含该应用名）—— 说明「配置送不到设备」不是原因',
      `实际 app_limits=${prefValue('app_limits')}`)

    // 这条是「应该成立」的断言：不成立就是产品缺陷，如实打 ✗，不要改写成跳过
    const plainRules = prefJson('app_limit_rules') ?? []
    const clockRule = plainRules.find((rule) => rule.packageName === clockPkg)
    check(Boolean(clockRule) && clockRule.dailyLimitMinutes === 1,
      '家长端设的应用限时真的进了设备的拦截规则表（pref app_limit_rules 含带正确包名的规则）',
      `实际 app_limit_rules=${prefValue('app_limit_rules')}；同刻 app_usage_json=${prefValue('app_usage_json')}`
      + '（规则表为空时 AppUsageReporter.refresh 直接把用量缓存清空，所以家长端「已用 X 分钟」也永远是 0）')
    const emptyPkgRules = plainRules.filter((rule) => !rule.packageName)
    check(emptyPkgRules.length === 0,
      '设备规则表里没有任何空包名的废规则（历史缺陷的残留已被清掉）',
      `空包名规则=${JSON.stringify(emptyPkgRules)}；实际 app_limit_rules=${prefValue('app_limit_rules')}`)

    // 用量上报：家长改了限额时 applyConfig() 会把上报时间戳清零，下一次 tick 立刻上报。
    // **必须在这里等**：5b 会清一次 logcat，而那之后要再等 30 分钟才有下一次上报
    // （APP_USAGE_REPORT_INTERVAL_MS = 30 min），旧写法把这条断言放在 5b 里就会误报 ✗。
    const reported = await waitFor(
      () => logOf('应用使用时长已上报') && '日志出现「应用使用时长已上报」',
      { timeoutMs: 180_000, intervalMs: 5000 })
    check(reported.ok, '设备端采样并上报了逐应用用量（logcat：应用使用时长已上报）', reported.detail)

    // ---------------------------------------------------------------
    // 5b 缺陷 2 回归：批准安装审核不再生出一条作用在**安装器**上的废规则
    //
    // 旧实现拿设备上报的 packageName（其实是安装器自己的包名）建了条 60 分钟限额。
    // 安装器没有 LAUNCHER 入口 ⇒ AppInventory.isLaunchable=false ⇒
    // GuardRules.matchAppLimit 第一道闸门 `if (!isLaunchable) return null;` 永远返回 null，
    // 规则永不触发；家长端却显示「已设限」。现在批准只开「允许安装」窗口，不建限额，
    // 并在设备上报清单时顺手清掉历史留下的这类死规则。
    // ---------------------------------------------------------------
    const pending = (await apiOrThrow('GET', dq('/features'), { token }))?.appAudit?.pendingApps ?? []
    if (pending.length === 0) {
      skip('批准安装审核不再生成作用在安装器上的废规则',
        '本轮没有待审核的安装申请（先看 4 号用例）')
    } else {
      const approveName = auditAppName || pending[0]
      await apiOrThrow('POST', dq('/features/app-audit'), {
        token, body: { appName: approveName, approved: true },
      })
      await restartAgent()

      const afterApprove = prefJson('app_limit_rules') ?? []
      const installerRule = afterApprove.find((rule) => rule.packageName === installerPkg)
      check(!installerRule,
        '批准安装审核后设备规则表里没有作用在安装器（无桌面入口）上的废规则',
        `实际 app_limit_rules=${prefValue('app_limit_rules')}`)

      // 更强的一条：规则表里**每一条**规则都要能解析到桌面入口，
      // 否则 GuardRules.matchAppLimit 的 `if (!isLaunchable) return null;` 会让它永不触发。
      const deadRules = afterApprove.filter((rule) => {
        const out = adb('shell', 'cmd', 'package', 'resolve-activity', '--brief',
          '-a', 'android.intent.action.MAIN', '-c', 'android.intent.category.LAUNCHER', rule.packageName).out || ''
        return !out.includes('/')
      })
      check(deadRules.length === 0,
        '设备规则表里每一条限额规则都作用在有桌面入口的包上（不存在永不触发的假规则）',
        `解析不到桌面入口的规则=${JSON.stringify(deadRules)}；`
        + `实际 app_limit_rules=${prefValue('app_limit_rules')}`)

      const after = await apiOrThrow('GET', dq('/features'), { token })
      const apps = after?.appLimit?.apps ?? {}
      const withUsage = Object.entries(apps)
        .filter(([, v]) => typeof v?.usedTodaySeconds === 'number' && v.usedTodaySeconds > 0)
        .map(([k, v]) => `${k}=${v.usedTodaySeconds}s`)
      check(withUsage.length > 0,
        `服务端读到了逐应用用量数字，家长端「已用 X 分钟」有真实数据（${withUsage.join('、')}）`,
        `appLimit.apps=${JSON.stringify(apps)}`)
    }

    // ---------------------------------------------------------------
    // 5c 终点证明：5a 已经用**家长端真实路径**把规则送进了设备规则表，
    // 这一段验证它真的能拦：用量采样 → 超限判定 → 看门狗拦截 → 前台被推走，
    // 以及家长端「已用 X 分钟」读到的是真实秒数。
    //
    // 旧版本这里要「以设备身份注入审核申请」才能拿到带包名的规则 —— 那是在给坏掉的
    // 包名供给链打补丁。现在家长端自己就能送对包名，注入路径不再需要。
    // ---------------------------------------------------------------
    const currentRules = prefJson('app_limit_rules') ?? []
    const liveClockRule = currentRules.find((rule) => rule.packageName === clockPkg)
    if (!liveClockRule) {
      skip('时钟超限后被设备端拦截',
        `设备规则表里没有 ${clockPkg} 的限额规则（5a 未通过），没有可验证的拦截输入`)
    } else {
      const clockActivity = (adb('shell', 'cmd', 'package', 'resolve-activity', '--brief',
        '-a', 'android.intent.action.MAIN', '-c', 'android.intent.category.LAUNCHER', clockPkg).out || '')
        .split('\n').map((line) => line.trim()).filter((line) => line.includes('/')).pop()

      if (!clockActivity) {
        skip('时钟超限后被设备端拦截', `解析不到 ${clockPkg} 的桌面入口，无法把它挂到前台攒用量`)
      } else {
        adb('logcat', '-c')
        // AppUsageReporter 每 60 秒才刷新一次用量，所以这里必须真的让时钟在前台待够 60 秒以上；
        // 拦截一旦发生，设备端会按返回键把时钟推走，于是循环会再次把它拉起并再次触发判定。
        const deadline = Date.now() + 170_000
        let intercepted = false
        while (Date.now() < deadline) {
          if (!resumedActivityName().includes(clockPkg)) adb('shell', 'am', 'start', '-n', clockActivity)
          await sleep(8000)
          if (logOf('看门狗：拦截')) { intercepted = true; break }
        }
        const clockSeconds = usageSecondsFor(clockPkg)
        check(clockSeconds >= 60,
          `时钟今日前台用量真的攒过了限额（${clockSeconds} 秒 ≥ 60 秒，来自设备端 app_usage_json）`)
        check(intercepted,
          '时钟超限后被设备端真的拦截了（logcat：看门狗：拦截 + 前台被按返回键推走）',
          `拦截日志原文：${(agentLog().match(/看门狗：拦截[^\n]*/) || ['(无)'])[0]}；`
          + `当前前台=${resumedActivityName() || '(空)'}`)

        // 家长端「已用 X 分钟」= 设备上报的真实秒数（旧链路里规则表为空 → 用量缓存被清 → 永远 0）
        const usedOk = await waitFor(async () => {
          const f = await apiOrThrow('GET', dq('/features'), { token })
          const used = f?.appLimit?.apps?.[clockLabel]?.usedTodaySeconds
          return typeof used === 'number' && used > 0 ? `${clockLabel} 今日已用 ${used} 秒` : null
        }, { timeoutMs: 120_000, intervalMs: 10_000 })
        check(usedOk.ok,
          '家长端「已用 X 分钟」不再是 0（服务端读到了设备上报的真实用量）',
          usedOk.detail || `appLimit.apps=${JSON.stringify((await apiOrThrow('GET', dq('/features'), { token }))?.appLimit?.apps ?? {})}`)
      }
    }
  } catch (error) {
    bad('逐应用限时验证异常中断', error.message)
  }

  // ============================================================
  // 6. 通话记录 + 短信
  // ============================================================
  step('6. 通话记录 + 短信上传（CallLogReader / SmsReader / CallsSmsUploader）')
  try {
    await setFeature(token, 'callSms', true)
    await restartAgent()

    const probeNumber = '13800138999'
    const smsBody = 'E2E_SMS_PROBE_9527'
    const nowMs = Date.now()
    // 造通话记录（shell 在 userdebug 模拟器上有写 call_log 的权限）
    adb('shell', 'content', 'insert', '--uri', 'content://call_log/calls',
      '--bind', `number:s:${probeNumber}`, '--bind', `date:l:${nowMs}`,
      '--bind', 'duration:l:30', '--bind', 'type:i:1')
    // 造一条收到的短信
    adb('emu', 'sms', 'send', probeNumber, smsBody)
    await sleep(5000)

    // 前提断言：数据必须真的在设备上，否则「服务端读到了」无从谈起
    const callOnDevice = countLines(`content query --uri content://call_log/calls | grep ${probeNumber}`)
    check(callOnDevice > 0, '前提：造的通话记录真的写进了设备通话记录库')
    const smsOnDevice = countLines(`content query --uri content://sms | grep ${smsBody}`)
    check(smsOnDevice > 0, '前提：造的短信真的落进了设备短信库')

    const cmd = await dispatchAndWait(token, deviceId, '/device/sync-calls-sms', {}, { timeoutMs: 120_000 })
    check(cmd.command?.status === 'succeeded',
      `通话/短信同步指令执行成功（status=${cmd.command?.status}）`,
      JSON.stringify(cmd.command?.result ?? {}))
    const summary = String(cmd.command?.result?.summary ?? '')
    check(/通话记录|短信/.test(summary) && /条/.test(summary),
      `设备如实回报了上传条数：${summary}`)

    const calls = await apiOrThrow('GET', dq('/calls?pageSize=50'), { token })
    const callHit = (calls.items ?? []).find((c) => c.phoneNumber === probeNumber)
    check(Boolean(callHit), `GET /api/calls 读到了刚造的那条通话（${probeNumber}）`)
    if (callHit) {
      check(callHit.type === 'incoming', `通话类型映射正确（${callHit.type}）`)
      check(callHit.durationSeconds === 30, `通话时长映射正确（${callHit.durationSeconds}s）`)
    }

    const sms = await apiOrThrow('GET', dq('/sms?pageSize=50'), { token })
    const smsHit = (sms.items ?? []).find((m) => String(m.body ?? '').includes(smsBody))
    check(Boolean(smsHit), `GET /api/sms 读到了刚造的那条短信（body 含 ${smsBody}）`)
    if (smsHit) check(smsHit.type === 'inbox', `短信类型映射正确（${smsHit.type}）`)
  } catch (error) {
    bad('通话/短信验证异常中断', error.message)
  }

  // ============================================================
  // 7. 环境监听
  // ============================================================
  step('7. 环境监听（capability/AmbientRecorder.java）')
  try {
    await setFeature(token, 'audioRecord', true)
    await restartAgent()
    const before = await listMedia(token, 'audio')
    adb('logcat', '-c')

    // 已知产品缺陷：Agent 进程刚被 kill 掉时，服务端那条「死掉的长轮询连接」
    // 可能抢先把指令标成 dispatched，而响应写进空气 —— 指令会永久卡在 dispatched
    // （claimNext 只认 status='pending'，没有任何重投递）。这里如实记一条 ✗，
    // 然后重发一次，好让后面的断言仍能跑完并给出结论。
    let start = await dispatchAndWait(token, deviceId, '/device/start-ambient', {}, { timeoutMs: 45_000 })
    const ambientLogs = logLines('环境监听[^\\n]*|收到指令 \\[开始环境监听\\][^\\n]*')
    if (start.command?.status === 'dispatched') {
      bad('首次下发「开始环境监听」被卡在 dispatched（疑似缺陷：指令被已断开的连接抢领后无重投递）',
        `command=${start.command?.id} status=${start.command?.status}；设备端日志：${ambientLogs.slice(-2).join(' | ') || '(无)'}`)
      await sleep(3000)
      start = await dispatchAndWait(token, deviceId, '/device/start-ambient', {}, { timeoutMs: 45_000 })
      ambientLogs.push(...logLines('环境监听[^\\n]*|收到指令 \\[开始环境监听\\][^\\n]*'))
    }
    check(start.command?.status === 'succeeded',
      `环境监听启动指令成功（status=${start.command?.status}）`,
      JSON.stringify(start.command?.result ?? {}))
    check(Number(start.command?.result?.chunkSeconds) >= 60,
      `设备回报了分段秒数（chunkSeconds=${start.command?.result?.chunkSeconds}）`)
    check(ambientLogs.some((l) => /环境监听已开始/.test(l)),
      '设备端日志确认环境监听已开始',
      ambientLogs.length ? `命中：${ambientLogs.slice(-2).join(' | ')}` : '未在 logcat 里看到「环境监听已开始」')

    await sleep(9000) // 攒一点真实音频，停止时当前分段会收尾上传
    const stop = await dispatchAndWait(token, deviceId, '/device/stop-ambient', {}, { timeoutMs: 150_000 })
    check(stop.command?.status === 'succeeded',
      `环境监听停止指令成功（status=${stop.command?.status}）`,
      JSON.stringify(stop.command?.result ?? {}))
    ambientLogs.push(...logLines('环境监听[^\\n]*'))

    // waitFor 只在探针返回 true 或字符串时才算成功（返回数组会被当成「没成功」），
    // 所以这里用字符串回报进度，数组另外存起来。
    let freshMedia = []
    const fresh = await waitFor(async () => {
      const now = await listMedia(token, 'audio')
      const added = now.filter((m) => !before.some((b) => b.id === m.id))
      if (added.length === 0) return false
      freshMedia = added
      return `新增 ${added.length} 条（${added.map((m) => `${m.sizeBytes ?? '?'}B`).join('、')}）`
    }, { timeoutMs: 150_000, intervalMs: 5000 })
    check(fresh.ok, '停止后有一段音频出现在家长端媒体列表（GET /api/media?kind=audio）',
      fresh.ok ? fresh.detail : `未观察到新音频；设备端日志：${ambientLogs.slice(-3).join(' | ') || '(无)'}`)

    if (fresh.ok) {
      const asset = freshMedia[0]
      const bytes = await fetchMediaBytes(asset.url)
      check(bytes.status === 200 && bytes.bytes.length > 0,
        `音频文件可下载且非空（${bytes.bytes.length} 字节，${bytes.contentType}）`)
    }
    check(ambientLogs.some((l) => /环境监听已停止/.test(l)),
      '设备端日志确认环境监听已停止（没有留后台录音）',
      ambientLogs.length ? `命中：${ambientLogs.slice(-2).join(' | ')}` : '未在 logcat 里看到「环境监听已停止」')
  } catch (error) {
    bad('环境监听验证异常中断', error.message)
  }

  // ============================================================
  // 8. 网址拦截 / DNS 过滤
  // ============================================================
  step('8. 网址拦截（DomainBlocker / DnsFilterVpnService）')
  // 用真实可解析的域名做靶子：被拦的那个本来是能解析出来的，
  // 这样「解析失败」才归因于拦截而不是「本来就没这个域名」。
  const blockedHost = 'example.com'
  try {
    adb('logcat', '-c')
    await apiOrThrow('POST', dq('/features/web-block'), { token, body: { url: blockedHost } })
    await restartAgent()
    const listOnDevice = await waitFor(() => prefContains('blocked_urls', blockedHost) && 'blocked_urls 已落盘',
      { timeoutMs: 60_000, intervalMs: 2000 })
    check(listOnDevice.ok, '屏蔽域名已下发并落盘到设备（pref blocked_urls）')

    if (vpnServiceRunning()) {
      ok('DnsFilterVpnService 已在运行（本机此前已授权 VPN）')
    } else {
      check(logOf('系统尚未授权 VPN'),
        '未授权时设备端只提示家长、不硬起 VPN 服务（logcat 留痕）',
        `logcat 尾部：${(agentLog().match(/网址拦截[^\n]*/g) || ['(无网址拦截相关日志)']).slice(-2).join(' | ')}`)
      // 授权只能由有界面的设置页发起：Service 里拿到的 Intent 弹不出来
      adbOrThrow('shell', 'am', 'start', '-n', `${PKG}/.ui.SettingsActivity`)
      await sleep(3000)
      const tapped = await tapByText('启用网址拦截（VPN 授权）')
      check(tapped, '已在设置页点到「启用网址拦截（VPN 授权）」')
      let consent = null
      for (let i = 0; i < 10 && !consent; i++) {
        consent = await tapSystemConsent()
        if (!consent) await sleep(2000)
      }
      check(Boolean(consent), `已点掉系统 VPN 授权框（识别按钮：${consent}）`)
    }

    const running = await waitFor(() => vpnServiceRunning() && 'DnsFilterVpnService 在运行',
      { timeoutMs: 90_000, intervalMs: 3000 })
    check(running.ok, 'DnsFilterVpnService 真的在运行（dumpsys activity services）')
    const started = await waitFor(
      () => logOf('网址拦截已启动') && (agentLog().match(/网址拦截已启动[^\n]*/) || [''])[0],
      { timeoutMs: 30_000, intervalMs: 2000 })
    check(started.ok, '设备端日志确认「网址拦截已启动」并给出了上游 DNS 链', started.detail)

    // 隧道只接管「发往 10.111.222.1:53」的查询（addRoute(TUN_ADDRESS,32) + addDnsServer），
    // 所以「系统真的把域名解析交给了这个地址」才是拦截进到数据路径里的证据。
    const tunnel = await waitFor(() => {
      const dump = adb('shell', 'dumpsys', 'connectivity').out || ''
      const hasTun = /InterfaceName: tun0/.test(dump)
      // dumpsys 里的真实排版是 `DnsAddresses: [ /10.111.222.1 ]`（方括号内侧有空格），
      // 早先写成 `\[\/10\.111\.222\.1\]` 会永远匹配不上（实测踩到）。
      const dnsOnTun = /InterfaceName: tun0[\s\S]{0,400}?DnsAddresses:\s*\[\s*\/10\.111\.222\.1\s*\]/.test(dump)
      if (hasTun && dnsOnTun) return 'tun0 已建立且系统 DNS=DnsAddresses:[/10.111.222.1]'
      return false
    }, { timeoutMs: 60_000, intervalMs: 3000 })
    check(tunnel.ok,
      'VPN 隧道真的建立起来了，且系统的域名解析被指向隧道地址 10.111.222.1',
      await (async () => {
        const dump = adb('shell', 'dumpsys', 'connectivity').out || ''
        const line = dump.split('\n').find((l) => l.includes('InterfaceName: tun0')) || '(没有 tun0)'
        return line.trim().slice(0, 300)
      })())

    // 被拦域名 vs 放行域名的解析对照 —— 本轮实测这条**无法在模拟器上成立**，如实跳过：
    //  · 隧道建立后 adb shell 的域名解析对本轮试过的**所有**域名都失败
    //    （example.com/bing.com/cloudflare.com/wikipedia.org/neverssl.com 全 unknown host），
    //    而把屏蔽项删掉、隧道消失后这些域名全部恢复解析 —— 也就是说「解析失败」在这个环境下
    //    不能归因于屏蔽列表；三次 A/B 都是这个结果（详见报告里的「观察到的异常」）。
    //  · 隧道建立期间设备端**完全没有**「已拦截 <域名>」日志，说明 adb shell 的查询没有被
    //    拦截器读到（`logcat -d | grep -i balloon` 在 ping 之后为空），所以 shell 层的 ping
    //    本来就测不到 DNS 判定。
    //  · DnsMessage / DomainBlocker 的解析与匹配逻辑已由 android/scripts/crosstest/PureLogicCheck.java 覆盖。
    skip('DNS 层拦截对「被拦域名 vs 放行域名」的实际效果',
      '设备级无法断言：隧道建立后 adb shell 的解析对所有域名一律失败，无法区分「被拦」与「隧道不通」；'
      + '且隧道期间 logcat 里没有任何「已拦截 <域名>」记录，shell 的查询没有被拦截器读到。'
      + 'DnsMessage/DomainBlocker 的解析逻辑由 android/scripts/crosstest/PureLogicCheck.java 覆盖。')

    await api('DELETE', dq(`/features/web-block/${encodeURIComponent(blockedHost)}`), { token })
  } catch (error) {
    bad('网址拦截验证异常中断', error.message)
  }

  // ============================================================
  // 9. 局数 / 集数预算
  // ============================================================
  step('9. 局数 / 集数预算（LockState.Reason.BUDGET / LockEnforcer.budgetLockReason）')
  let budgetId = null
  try {
    const created = await api('PUT', dq('/usage-budgets'), {
      token, body: { kind: 'game_round', appName: '', dailyLimit: 3, enabled: true },
    })
    check(created.ok, `已通过家长端 API 设置今日游戏局数上限（HTTP ${created.status}）`)
    budgetId = created.body?.budget?.id ?? created.body?.id ?? null
    await restartAgent()
    const stored = await waitFor(() => prefTyped('game_rounds_limit') === '3' && 'game_rounds_limit=3 已落盘',
      { timeoutMs: 60_000, intervalMs: 2000 })
    check(stored.ok, '预算随 /api/agent/config 下发并落盘到设备（pref game_rounds_limit=3）',
      `实际 game_rounds_limit=${prefTyped('game_rounds_limit')}`)
    const used = prefTyped('game_rounds_used')
    const enabledPref = prefTyped('game_rounds_enabled') === 'true'
    check(enabledPref === true && used === '0',
      `设备端拿到的是服务端算好的权威计数（enabled=${enabledPref}, used=${used}/3）`)
    check(lockTaskState() === 'NONE',
      `未达上限时设备没有被预算锁住（mLockTaskModeState=${lockTaskState()}）`)

    skip('局数/集数预算的「离线兜底锁屏」设备级验证',
      '无法通过家长端 API 构造 used >= limit：usedToday 由服务端 AI 分析推算（insights.service.ts:827），'
      + 'upsertBudgetSchema 只接受 dailyLimit（最小 1），因此 used 恒为 0。'
      + '设备端确实实现了兜底判定（LockEnforcer.java:103 budgetLockReason → LockState.Reason.BUDGET），'
      + '本轮只验证到「配置真的下发到设备」这一半。')
    await api('POST', `/device/lock?deviceId=${deviceId}`, { token, body: { locked: false } })
  } catch (error) {
    bad('局数/集数预算验证异常中断', error.message)
  } finally {
    const list = await api('GET', dq('/usage-budgets'), { token })
    const rows = list.body?.budgets ?? list.body?.items ?? (Array.isArray(list.body) ? list.body : [])
    for (const row of rows) {
      if (row.kind === 'game_round') await api('DELETE', dq(`/usage-budgets/${row.id}`), { token })
    }
  }

  // ============================================================
  // 10. 远程协助
  // ============================================================
  step('10. 远程协助（CommandExecutor.doRemoteAction / remoteHelp）')
  try {
    await setFeature(token, 'remoteHelp', true)
    // 设备端每 60 秒才拉一次配置（CONFIG_REFRESH_INTERVAL_MS），
    // 所以必须重启一次 Agent 让它立刻拿到 remoteHelp=true，否则指令会被
    // 「家长端未开启『远程协助』，该指令不执行」挡掉（上一轮实测踩到）。
    await restartAgent()

    // 前提：把前台切到一个「不是桌面」的界面，否则「回到桌面」这条断言是假通过
    adbOrThrow('shell', 'am', 'start', '-n', `${PKG}/.ui.SettingsActivity`)
    await sleep(3000)
    const topBefore = resumedActivityName()
    check(Boolean(topBefore) && !/launcher|Launcher/i.test(topBefore),
      `前提：远程操作前前台不是桌面（实际 ${topBefore}）`)

    const home = await dispatchResilient(token, deviceId, '/device/remote-action',
      { action: 'home' }, { timeoutMs: 60_000 })
    if (home.lostFirst) {
      bad('首次下发「回主页」被卡在 dispatched（疑似缺陷：指令被已断开的连接抢领后无重投递）',
        `lostCommand=${home.lostCommandId}`)
    }
    check(home.command?.status === 'succeeded',
      `远程「回主页」指令成功（status=${home.command?.status}）`,
      JSON.stringify(home.command?.result ?? {}))
    check(home.command?.result?.performed === true, '设备回报 performed=true')
    const wentHome = await waitFor(() =>
      /launcher|Launcher/i.test(resumedActivityName()) && `前台已回到桌面（${resumedActivityName()}）`,
    { timeoutMs: 30_000, intervalMs: 2000 })
    check(wentHome.ok, '设备前台真的被切回桌面 —— 不是「只回报成功」', wentHome.detail)

    // open_app：打开一个第三方应用
    const targetPkg = 'com.android.settings'
    const resolved = adb('shell', 'cmd', 'package', 'resolve-activity', '--brief',
      '-a', 'android.intent.action.MAIN', '-c', 'android.intent.category.LAUNCHER', targetPkg)
    check(Boolean(resolved.out) && !/No activity found/i.test(resolved.out),
      `前提：${targetPkg} 有可启动的桌面入口（${(resolved.out || '').trim()}）`)
    const open = await dispatchResilient(token, deviceId, '/device/remote-action',
      { action: 'open_app', packageName: targetPkg }, { timeoutMs: 60_000 })
    check(open.command?.status === 'succeeded',
      `远程「打开指定应用」指令成功（status=${open.command?.status}）`,
      JSON.stringify(open.command?.result ?? {}))
    const opened = await waitFor(() =>
      resumedActivityName().startsWith(`${targetPkg}/`) && `前台已是 ${resumedActivityName()}`,
    { timeoutMs: 30_000, intervalMs: 2000 })
    check(opened.ok, `设备真的打开了 ${targetPkg}`, opened.ok ? '' : `实际前台 ${resumedActivityName()}`)

    // 关掉开关后，服务端必须拒绝下发（家长端开关是有牙齿的）
    await setFeature(token, 'remoteHelp', false)
    const denied = await api('POST', `/device/remote-action?deviceId=${deviceId}`,
      { token, body: { action: 'home' } })
    check(!denied.ok, `关掉「远程协助」后服务端拒绝下发指令（HTTP ${denied.status}）`)
  } catch (error) {
    bad('远程协助验证异常中断', error.message)
  }

  // ============================================================
  // 收尾
  // ============================================================
  step('11. 收尾')
  adbOrThrow('shell', 'am', 'start', '-n', `${PKG}/.ui.MainActivity`).toString()
  await sleep(2000)
  const purgedEnd = await purgeLeftoverDevices(deviceModel(), [deviceId])
  if (purgedEnd >= 0) ok(`已清理 ${purgedEnd} 台遗留设备记录`)

  if (SKIPS.length > 0) {
    console.log(`\n\x1b[1m本轮明确未验证的项（${SKIPS.length}）：\x1b[0m`)
    for (const item of SKIPS) console.log(`  \x1b[33m⏭\x1b[0m ${item.label}\n     原因：${item.reason}`)
  }

  console.log(`\n\x1b[1m结果：${passed} 项通过，${failed} 项失败，${skipped} 项跳过\x1b[0m`)
  if (failed > 0) {
    console.log('\n设备端最近日志（仅本应用进程）：')
    try {
      const pid = shell(`pidof ${PKG}`).trim()
      if (pid) {
        console.log(shell(`logcat -d --pid=${pid} -v brief | tail -60`))
      } else {
        console.log('（应用进程已退出）')
      }
      console.log('\n崩溃记录：')
      console.log(shell('logcat -d -v brief | grep -E "AndroidRuntime|FATAL EXCEPTION" | tail -30'))
    } catch {
      // logcat 不可用时忽略
    }
    process.exit(1)
  }
}

main().catch((error) => {
  console.error(`\n\x1b[31m联调中断：${error.message}\x1b[0m`)
  process.exit(1)
})
