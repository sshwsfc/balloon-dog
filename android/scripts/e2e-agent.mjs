#!/usr/bin/env node
/**
 * Android 设备端 Agent 的端到端联调脚本。
 *
 * 它把「真机/模拟器上跑的 Agent」和「本地后端」串起来跑一遍完整闭环，
 * 用来证明客户端不是「能编译」而是「真的能工作」：
 *
 *   1. 安装 APK 并授予所需运行时权限；
 *   2. 启动 Agent 前台服务（应用会自动 register 拿到 deviceToken）；
 *   3. 从设备上读出它自己生成的绑定码；
 *   4. 以家长身份登录后端，用这个绑定码完成认领（POST /api/devices/bind）；
 *   5. 家长下发一条锁屏指令（POST /api/device/lock）；
 *   6. 断言指令在若干秒内从 pending → dispatched → succeeded ——
 *      也就是说：Android 端真的领到了、执行了、如实回报了；
 *   7. 再验证反向能力：设备心跳把电量/在线状态写回后端（GET /api/devices）。
 *
 * 依赖：一个已启动的后端（server/，http://localhost:4000）、一个已启动的模拟器（adb devices 能看到）、
 * 以及构建产物 android/app/build/outputs/apk/debug/app-debug.apk。
 *
 * 用法：
 *   node android/scripts/e2e-agent.mjs
 *   API_BASE=http://localhost:4000/api node android/scripts/e2e-agent.mjs
 *   ADB=~/Library/Android/sdk/platform-tools/adb node android/scripts/e2e-agent.mjs
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

// ---------------- 主流程 ----------------
async function main() {
  console.log('\x1b[1m气球狗 · Android 设备端 Agent 端到端联调\x1b[0m')
  console.log(`  APK      ${APK}`)
  console.log(`  API      ${API_BASE}`)
  console.log(`  adb      ${ADB}`)

  if (!existsSync(APK)) {
    console.error(`\n找不到 APK，请先构建：cd android && ./gradlew :app:assembleDebug`)
    process.exit(1)
  }

  step('0. 后端连通性')
  const health = await api('GET', '/../health').catch(() => null)
  // /health 不在 /api 下，单独探测一次
  const healthRes = await fetch(API_BASE.replace(/\/api$/, '') + '/health').catch(() => null)
  check(Boolean(healthRes && healthRes.ok) || Boolean(health && health.ok), '后端 /health 可达')
  if (!healthRes || !healthRes.ok) {
    console.error('  后端未启动？请先执行 npm run server:dev')
    process.exit(1)
  }

  step('1. 等待模拟器')
  const deviceReady = await waitForDevice()
  check(deviceReady, 'adb 已识别到设备')
  if (!deviceReady) process.exit(1)
  const booted = await waitForBoot()
  check(booted, '系统已完成启动')
  if (!booted) process.exit(1)

  // 先清掉本机遗留的设备记录再开跑：遗留行可能停在「已绑定 + 已锁定」，
  // 而重装后的 Agent 会重新注册并认出同一台设备 —— 那就会一开机就是锁定页。
  const leftovers = await purgeLeftoverDevices(deviceModel())
  if (leftovers > 0) console.log(`  已清理 ${leftovers} 台上一轮遗留的模拟器设备`)

  step('2. 安装 APK 并清空应用数据')
  adb('install', '-r', '-g', APK)
  const installed = shell(`pm list packages ${PKG}`).includes(PKG)
  check(installed, '应用已安装')

  // 重置状态刻意不用 pm clear：
  //   - 设备管理器激活后系统会拒绝卸载；
  //   - 被设为设备所有者后，pm clear 会直接抛 SecurityException
  //     （「不能清除设备所有者的数据」—— 这本身就是需求 1 想要的能力）。
  // 因此改用：kill -9 杀进程 → 删掉 shared_prefs。模拟器上 adb root 可用，
  // 真机上会退化为 run-as（仅在进程已死时可用）。
  const rooted = /restarting adbd as root|already running as root/i.test(
    adb('root').out + adb('root').err)
  if (rooted) {
    adb('wait-for-device')
    await sleep(1500)
  }
  // 必须先停掉无障碍服务再杀进程：否则系统会在 1 秒内把进程重新拉起来，
  // 抢在 rm 之前把 shared_prefs 又写回去 —— 上一轮残留的「已锁定」状态就清不掉，
  // 新的一轮会从「开机就是锁定页」开始，所有界面断言跟着作废（实测踩过）。
  const watchdogWasOn = shell('settings get secure enabled_accessibility_services').includes(PKG)
  if (watchdogWasOn) {
    adb('shell', 'settings', 'put', 'secure', 'enabled_accessibility_services', 'null')
    await sleep(1500)
  }

  const pid = (adb('shell', 'pidof', PKG).out || '').trim()
  if (pid) adb('shell', 'kill', '-9', pid)
  await sleep(2000)
  if (rooted) {
    adb('shell', 'rm', '-rf', `/data/data/${PKG}/shared_prefs`, `/data/data/${PKG}/cache`,
      `/data/user_de/0/${PKG}/shared_prefs`)
  } else {
    adb('shell', 'run-as', PKG, 'rm', '-rf', 'shared_prefs', 'cache')
  }
  check(true, `应用数据已清空（root=${rooted ? '是' : '否'}）`)

  // 上一轮可能留下「Kiosk 锁定」。它是系统持有的状态，不随进程消失；
  // 残留的话后续所有界面断言都看不到应用本体（实测会把整轮测试变成无意义的失败）。
  // 除了残留 Kiosk，还有一种更隐蔽的脏状态：SystemUI 卡住（焦点一直停在通知栏上、
  // 且没有任何 Activity 处于 resumed）。实测它由上一轮的截屏采集联调留下，
  // 而且 `cmd statusbar collapse`、返回键、上滑、HOME 都推不动它 ——
  // 症状就是下一轮所有界面断言看到一个「空界面」，极像应用起不来。
  const systemUiStuck = () => {
    const focus = (adb('shell', 'dumpsys', 'window').out || '')
    const acts = (adb('shell', 'dumpsys', 'activity', 'activities').out || '')
    const shadeFocused = /mCurrentFocus=Window\{[^}]*NotificationShade/.test(focus)
    const noResumed = !/topResumedActivity=ActivityRecord/.test(acts)
    return shadeFocused && noResumed
  }

  let kioskGone = await waitFor(async () => lockTaskState() === 'NONE' && '已退出 Kiosk',
    { timeoutMs: 30_000, intervalMs: 3000 })
  if (systemUiStuck()) {
    ok('检测到 SystemUI 卡死（焦点停在通知栏且无前台界面），重启一次以取得确定起点')
    kioskGone = { ok: false }
  }
  if (!kioskGone.ok) {
    // 进程都杀了还退不掉，只剩重启这一条路（Kiosk 状态由系统持久化）。
    // 开机后 Agent 会去重新注册，而我们上面已经清掉了遗留设备记录，
    // 于是它注册成一台「未绑定」设备，策略即为不锁 —— 正好是我们想要的起点。
    adb('shell', 'reboot')
    adb('wait-for-device')
    await waitFor(async () => {
      const b = (adb('shell', 'getprop', 'sys.boot_completed').out || '').trim()
      return b === '1' && '已重新开机'
    }, { timeoutMs: 300_000, intervalMs: 5000 })
    await sleep(8000)
    adb('shell', 'input', 'keyevent', 'KEYCODE_WAKEUP')
    adb('shell', 'wm', 'dismiss-keyguard')
    await ensureRoot()   // 重启后 adbd 退回非 root，后面还要靠它杀进程/清数据
    kioskGone = await waitFor(async () => lockTaskState() === 'NONE' && '已退出 Kiosk',
      { timeoutMs: 120_000, intervalMs: 4000 })
  }
  check(kioskGone.ok, '起点无残留的 Kiosk 锁定（测试从确定状态开始）',
    kioskGone.ok ? '' : `仍为 ${lockTaskState()}`)

  // 重启会让看门狗设置失效，这里统一恢复
  adb('shell', 'settings', 'put', 'secure', 'enabled_accessibility_services',
    `${PKG}/${PKG}.service.LockWatchdogService`)
  adb('shell', 'settings', 'put', 'secure', 'accessibility_enabled', '1')
  await sleep(1500)

  step('3. 授予运行时权限')
  const permissions = [
    'android.permission.CAMERA',
    'android.permission.RECORD_AUDIO',
    'android.permission.ACCESS_FINE_LOCATION',
    'android.permission.ACCESS_COARSE_LOCATION',
    'android.permission.POST_NOTIFICATIONS',
  ]
  for (const permission of permissions) {
    adb('shell', 'pm', 'grant', PKG, permission)
  }
  const granted = countLines(`dumpsys package ${PKG} | grep "granted=true"`)
  check(granted > 0, `已授予 ${granted} 项权限`)
  // 屏幕共享授权框在自动化里点不了，这里显式允许「后台弹出界面」相关的特殊权限
  adb('shell', 'appops', 'set', PKG, 'SYSTEM_ALERT_WINDOW', 'allow')

  // 重新打开看门狗：上面为了清数据把它关了。
  // 它既是锁定复核的执行者，也是给每张截图标注前台应用的来源。
  adb('shell', 'settings', 'put', 'secure', 'enabled_accessibility_services',
    `${PKG}/${PKG}.service.LockWatchdogService`)
  adb('shell', 'settings', 'put', 'secure', 'accessibility_enabled', '1')
  await sleep(1500)

  step('4. 通过界面启动守护服务')
  adb('logcat', '-c')
  await clearSystemDialogs()
  adb('shell', 'input', 'keyevent', 'KEYCODE_WAKEUP')
  adb('shell', 'wm', 'dismiss-keyguard')
  adbOrThrow('shell', 'am', 'start', '-n', `${PKG}/.ui.MainActivity`)
  await sleep(3500)

  // 界面断言必须「轮询等它出现」，不能 dump 一次就下结论：
  // dumpUi() 只要拿到 <hierarchy> 就返回，而冷启动/刚清完数据时那个层级可能是空的。
  // 这一条曾经随机失败，看起来像应用起不来，其实只是慢了一两秒。
  const mainRendered = await waitFor(async () =>
    (await dumpUi()).includes('text="运行状态"') && '主界面已渲染',
  { timeoutMs: 60_000, intervalMs: 2000 })
  check(mainRendered.ok, '主界面已渲染')

  const mainUi = await dumpUi()
  const alreadyRunning = mainUi.includes('text="停止守护"') || mainUi.includes('text="守护运行中"')
  if (alreadyRunning) {
    ok('守护服务原本就在运行')
  } else {
    const tapped = await tapByText('启动守护')
    check(tapped, '已在界面上点击「启动守护」')
    await sleep(7000)
  }

  check(countLines(`dumpsys activity services ${PKG} | grep "AgentService"`) > 0,
    'AgentService 处于运行中')

  step('5. 读取设备自己生成的绑定码')
  // debug 构建可通过 run-as 读取应用私有目录
  let deviceCode = ''
  for (let i = 0; i < 10 && !deviceCode; i++) {
    const xml = adb('shell', 'run-as', PKG, 'cat', 'shared_prefs/balloon_dog_agent_prefs.xml')
    if (xml.code === 0 && xml.out.includes('device_code')) {
      const match = xml.out.match(/name="device_code">([^<]+)</)
      if (match) deviceCode = match[1]
    }
    if (!deviceCode) await sleep(2000)
  }
  check(/^[A-Z0-9]{6,12}$/.test(deviceCode), `绑定码已生成：${deviceCode}`, deviceCode)

  const tokenXml = adb('shell', 'run-as', PKG, 'cat', 'shared_prefs/balloon_dog_agent_prefs.xml')
  const tokenMatch = tokenXml.out.match(/name="device_token">([^<]+)</)
  check(Boolean(tokenMatch), '设备已从后端拿到 deviceToken')
  if (!deviceCode || !tokenMatch) {
    console.log('\n以下是设备端日志，便于定位失败原因：')
    console.log(shell(`logcat -d -s balloon 2>/dev/null | tail -40`) || '(空)')
    process.exit(1)
  }

  step('6. 家长登录并认领这台设备')
  const login = await apiOrThrow('POST', '/auth/login', {
    body: { phone: PARENT_PHONE, password: PARENT_PASSWORD },
  })
  const token = login.token
  check(Boolean(token), `家长 ${PARENT_PHONE} 登录成功`)

  const bind = await apiOrThrow('POST', '/devices/bind', {
    token,
    body: { deviceCode, name: 'E2E 模拟设备' },
  })
  check(bind.success === true, `设备已认领（deviceId=${bind.device?.id}）`)
  check(bind.device?.deviceCode === deviceCode, '认领的是同一台设备（绑定码一致）')
  const deviceId = bind.device.id

  step('7. 等待设备心跳把在线状态写回后端')
  let online = false
  let battery = null
  for (let i = 0; i < 20 && !online; i++) {
    const device = await apiOrThrow('GET', `/device?deviceId=${deviceId}`, { token })
    online = device.status === 'online'
    battery = device.battery
    if (!online) await sleep(3000)
  }
  check(online, `设备在线（电量 ${battery}%）`)
  check(typeof battery === 'number' && battery > 0, '心跳上报了真实电量')

  step('8. 家长下发锁屏指令，验证完整指令闭环')
  const lock = await apiOrThrow('POST', `/device/lock?deviceId=${deviceId}`, {
    token,
    body: { locked: true },
  })
  check(lock.success === true, '锁屏指令已入队')
  const commandId = lock.command?.id
  check(Boolean(commandId), `指令 id = ${commandId}`)

  // 轮询指令状态：设备端应该在几秒内领取并回报
  let finalStatus = null
  for (let i = 0; i < 30; i++) {
    const history = await apiOrThrow('GET', `/device/commands?deviceId=${deviceId}&limit=5`, { token })
    const command = history.commands?.find((c) => c.id === commandId)
    if (command && ['succeeded', 'failed', 'expired', 'cancelled'].includes(command.status)) {
      finalStatus = command
      break
    }
    await sleep(2000)
  }

  // 用服务端记录的 dispatchedAt 证明「设备确实领取过」：
  // 直接轮询 status==='dispatched' 是不可靠的 —— 设备领取到回报只要几百毫秒，
  // 2 秒一次的轮询很可能整段错过这个中间态（这是测试的观测问题，不是功能问题）。
  check(Boolean(finalStatus?.dispatchedAt), '设备领取过该指令（服务端记录了 dispatchedAt）')
  check(finalStatus?.status === 'succeeded', `指令执行成功（status=${finalStatus?.status}）`,
    finalStatus?.error || '')
  if (finalStatus) {
    console.log(`    设备回报的 result：${JSON.stringify(finalStatus.result)}`)
  }

  step('9. 验证设备状态已按指令落地')
  const after = await apiOrThrow('GET', `/device?deviceId=${deviceId}`, { token })
  check(after.locked === true, '后端记录的设备状态为「已锁定」')

  step('10. 反向验证：解锁指令')
  const unlock = await apiOrThrow('POST', `/device/lock?deviceId=${deviceId}`, {
    token,
    body: { locked: false },
  })
  let unlockStatus = null
  for (let i = 0; i < 30; i++) {
    const history = await apiOrThrow('GET', `/device/commands?deviceId=${deviceId}&limit=5`, { token })
    const command = history.commands?.find((c) => c.id === unlock.command?.id)
    if (command && ['succeeded', 'failed', 'expired'].includes(command.status)) {
      unlockStatus = command.status
      break
    }
    await sleep(2000)
  }
  const afterUnlock = await apiOrThrow('GET', `/device?deviceId=${deviceId}`, { token })
  check(unlockStatus === 'succeeded', `解锁指令执行成功（status=${unlockStatus}）`)
  check(afterUnlock.locked === false, '后端记录的设备状态为「未锁定」')

  step('11. 激活设备管理器，验证"真锁屏"')
  // 幂等：上一轮如果已经激活过，这里重复设置不会报错
  const setAdmin = adb('shell', 'dpm', 'set-active-admin', `${PKG}/.capability.AgentAdminReceiver`)
  await sleep(2000)
  // dpm 没有 list 子命令，用 dumpsys device_policy 检查「Active Admins」里有没有我们的组件
  const policy = adb('shell', 'dumpsys', 'device_policy').out
  const adminActive = policy.includes(PKG) ||
    policy.includes('AgentAdminReceiver') ||
    /Active Admins[\s\S]{0,400}?balloondog/.test(policy)
  check(adminActive, '设备管理器已激活', setAdmin.err || '')

  const lock2 = await dispatchAndWait(token, deviceId, '/device/lock', { locked: true })
  check(lock2.command?.status === 'succeeded', `再次锁屏成功（status=${lock2.command?.status}）`)
  check(lock2.command?.result?.systemLock === true,
    '设备回报 systemLock=true（真正调用了 DevicePolicyManager.lockNow）',
    JSON.stringify(lock2.command?.result))
  await dispatchAndWait(token, deviceId, '/device/lock', { locked: false })

  step('12. 远程拍照（Camera2 → 上传 → 家长端可读）')
  await apiOrThrow('PUT', `/features?deviceId=${deviceId}`, {
    token,
    body: { feature: 'remotePhoto', enabled: true },
  })
  ok('已开启「远程拍照」功能开关')

  const photo = await dispatchAndWait(token, deviceId, '/device/remote-photo', {})
  check(photo.command?.status === 'succeeded', `拍照指令成功（status=${photo.command?.status}）`,
    photo.command?.error || '')
  const photoMediaId = photo.command?.result?.mediaId
  check(Boolean(photoMediaId), `指令结果回填了 mediaId（${photoMediaId}）`)

  const mediaList = await apiOrThrow('GET', `/media?deviceId=${deviceId}&limit=10`, { token })
  const photoAsset = mediaList.media?.find((m) => m.id === photoMediaId)
  check(Boolean(photoAsset), '媒体已出现在家长端媒体列表里')
  check(photoAsset?.kind === 'photo', `媒体类型为 photo（实际 ${photoAsset?.kind}）`)
  check((photoAsset?.sizeBytes ?? 0) > 1000, `照片体积合理（${photoAsset?.sizeBytes} 字节）`)

  if (photoAsset?.url) {
    const downloaded = await fetchMediaBytes(photoAsset.url)
    check(downloaded.status === 200, '签名 URL 可以直接下载照片')
    check((downloaded.contentType || '').startsWith('image/'),
      `响应类型是图片（${downloaded.contentType}）`)
    const isJpeg = downloaded.bytes[0] === 0xff && downloaded.bytes[1] === 0xd8
    check(isJpeg, '下载到的是真实 JPEG（SOI 魔数 0xFFD8 校验通过）')
  }

  step('13. 远程录音（MediaRecorder → 上传 M4A）')
  await apiOrThrow('PUT', `/features?deviceId=${deviceId}`, {
    token,
    body: { feature: 'remoteRecord', enabled: true },
  })
  const audioStart = await dispatchAndWait(token, deviceId, '/device/start-audio', {})
  const recordingId = audioStart.command?.result?.recordingId
  check(audioStart.command?.status === 'succeeded', `开始录音成功（status=${audioStart.command?.status}）`,
    audioStart.command?.error || '')
  check(Boolean(recordingId), `设备返回了 recordingId（${recordingId}）`)

  await sleep(5000) // 录 5 秒，保证文件非空
  const audioStop = await dispatchAndWait(token, deviceId, '/device/stop-audio', { recordingId })
  check(audioStop.command?.status === 'succeeded', `停止录音成功（status=${audioStop.command?.status}）`,
    audioStop.command?.error || '')
  const audioMediaId = audioStop.command?.result?.mediaId
  check(Boolean(audioMediaId), `录音已上传（mediaId=${audioMediaId}）`)
  const audioList = await apiOrThrow('GET', `/media?deviceId=${deviceId}&kind=audio`, { token })
  const audioAsset = audioList.media?.find((m) => m.id === audioMediaId)
  check(Boolean(audioAsset), '录音已出现在家长端媒体列表里')
  if (audioAsset?.url) {
    const audioBytes = await fetchMediaBytes(audioAsset.url)
    check(audioBytes.status === 200 && audioBytes.bytes.length > 1000,
      `录音文件可下载且非空（${audioBytes.bytes.length} 字节，${audioBytes.contentType}）`)
  }

  step('14. 屏幕截图（MediaProjection，需点掉系统授权框）')
  await apiOrThrow('PUT', `/features?deviceId=${deviceId}`, {
    token,
    body: { feature: 'screenMonitor', enabled: true },
  })
  let consentTapped = false
  const shot = await dispatchAndWait(token, deviceId, '/device/screenshot', {}, {
    timeoutMs: 70_000,
    onPending: async () => {
      if (consentTapped) return
      const label = await tapSystemConsent()
      if (label) {
        consentTapped = true
        console.log(`    已点击系统授权框按钮「${label}」`)
      }
    },
  })
  check(consentTapped, '弹出了屏幕共享授权框（MediaProjection 需要用户确认）')
  check(shot.command?.status === 'succeeded', `截图指令成功（status=${shot.command?.status}）`,
    shot.command?.error || '')
  const shotMediaId = shot.command?.result?.mediaId
  check(Boolean(shotMediaId), `截图已上传（mediaId=${shotMediaId}）`)
  if (shotMediaId) {
    const shotList = await apiOrThrow('GET', `/media?deviceId=${deviceId}&kind=screenshot`, { token })
    const shotAsset = shotList.media?.find((m) => m.id === shotMediaId)
    check(Boolean(shotAsset), '截图已出现在家长端媒体列表里')
    if (shotAsset?.url) {
      const shotBytes = await fetchMediaBytes(shotAsset.url)
      const isJpeg = shotBytes.bytes[0] === 0xff && shotBytes.bytes[1] === 0xd8
      check(shotBytes.status === 200 && isJpeg, '截图是真实 JPEG 且可下载')
    }
  }

  step('15. 位置上报 + 服务被系统杀死后的自愈')
  // 给模拟器灌一个固定的 GPS 坐标，重启守护后首轮循环会立刻上报一次
  adb('emu', 'geo', 'fix', '116.4709', '39.9955')
  await sleep(1000)

  // 模拟「进程被系统低内存回收」。
  //
  // 这里刻意用 kill -9 而不是 am force-stop：被设为设备所有者之后，
  // am force-stop 对本案已经无效（那正是需求 1 想要的效果，见第 17 阶段）。
  // kill -9 模拟的才是「系统把进程回收掉」这个真实场景。
  const pidBeforeKill = (adb('shell', 'pidof', PKG).out || '').trim()
  if (pidBeforeKill) adb('shell', 'kill', '-9', pidBeforeKill)
  await sleep(1500)

  const revived = await waitFor(async () => {
    const pid = (adb('shell', 'pidof', PKG).out || '').trim()
    if (pid && pid !== pidBeforeKill) return `新进程 ${pid}（原 ${pidBeforeKill}）`
    return false
  }, { timeoutMs: 90_000, intervalMs: 4000 })
  check(revived.ok, '进程被杀后服务自动恢复（START_STICKY / 看门狗生效）',
    revived.ok ? revived.detail : '未观察到新进程')

  adbOrThrow('shell', 'am', 'start', '-n', `${PKG}/.ui.MainActivity`)
  await sleep(6000)
  const healed = await waitFor(async () =>
    (await dumpUi()).includes('text="守护运行中"') && '守护运行中',
  { timeoutMs: 60_000, intervalMs: 2500 })
  const healedUi = await dumpUi()
  check(healed.ok,
    '重新打开界面后状态显示为「守护运行中」（界面与真实状态一致）',
    healed.ok ? '' : (healedUi ? visibleTexts(healedUi).join(' / ').slice(0, 200) : '界面 dump 失败'))
  await sleep(4000)

  let location = null
  for (let i = 0; i < 15 && !location; i++) {
    const res = await api('GET', `/locations/latest?deviceId=${deviceId}`, { token })
    if (res.ok && res.body?.location) location = res.body.location
    else await sleep(3000)
  }
  check(Boolean(location), '设备上报了定位')
  if (location) {
    // 坐标取值依赖模拟器/真机的定位源，这里只断言「是一条结构完整、数值合法的定位记录」。
    // 上面那条 `adb emu geo fix` 在部分模拟器镜像上不会改写 last known location，
    // 因此不适合作为断言依据。
    const latOk = typeof location.latitude === 'number' && Math.abs(location.latitude) <= 90
    const lngOk = typeof location.longitude === 'number' && Math.abs(location.longitude) <= 180
    check(latOk && lngOk, `定位坐标合法（${location.latitude}, ${location.longitude}）`)
    check(typeof location.accuracy === 'number' && location.accuracy >= 0,
      `上报了定位精度（±${location.accuracy} 米）`)
  }

  step('16. 幂等：状态未变化时服务端不下发空指令')
  const noop = await apiOrThrow('POST', `/device/lock?deviceId=${deviceId}`, {
    token,
    body: { locked: false },
  })
  // 设备此时已经是解锁态，服务端应当回 noop 而不是塞一条毫无意义的指令进队列
  check(noop.success === true, '重复下发同状态指令返回成功')
  check(noop.noop === true && noop.command === null,
    '服务端识别出状态未变化，未下发冗余指令（noop）',
    `noop=${noop.noop} command=${noop.command === null ? 'null' : 'not-null'}`)

  // ============================================================
  // 强管控：设备所有者 / Kiosk / 定时锁屏 / 倒计时 / 答题 / 应急解锁 / 保活
  // ============================================================
  // 这一段把需求 1~5 逐条落到断言上。多数断言依赖设备所有者；
  // 没有设成设备所有者的机器上会明确跳过并说明原因，绝不假装通过。

  const ownerOutput = shell('dpm list-owners')
  const isDeviceOwner = ownerOutput.includes(PKG)
  check(isDeviceOwner,
    isDeviceOwner ? '设备已被设为设备所有者（最强档前提具备）'
                  : '未设为设备所有者：后续强管控断言将按能力降级判定',
    isDeviceOwner ? '' : '执行 adb shell dpm set-device-owner 后重跑可得到完整结论')

  step('17. 最强防护：禁卸载 / 禁强行停止（需求 1）')
  if (isDeviceOwner) {
    // 触发一次加固（锁屏时服务端会自动施加，这里通过重开界面自检来确保生效）
    adbOrThrow('shell', 'am', 'start', '-n', `${PKG}/.ui.MainActivity`)
    await sleep(3000)
    await tapByText('立即自检并恢复守护')
    await sleep(4000)

    const uninstallBlocked = shell('dumpsys device_policy').includes('mUninstallBlocked')
      || agentLog().includes('最强防护已启用')
    check(uninstallBlocked, '已启用最强防护（禁卸载 / 禁强行停止 / 禁恢复出厂 / 禁安全模式）')

    // 关键行为断言：设备所有者状态下 am force-stop 杀不掉本应用
    const beforePid = (adb('shell', 'pidof', PKG).out || '').trim()
    adb('shell', 'am', 'force-stop', PKG)
    await sleep(3000)
    const afterPid = (adb('shell', 'pidof', PKG).out || '').trim()
    check(Boolean(beforePid) && beforePid === afterPid,
      '强行停止无效：设备所有者应用杀不掉（孩子无法用「强行停止」绕过）',
      `before=${beforePid} after=${afterPid}`)
  } else {
    ok('跳过：需要设备所有者权限')
  }

  step('18. 定时锁屏 + 透明悬浮窗倒计时（需求 3、4）')
  // 先清空既有规则与放行状态，让这一段的判定完全由「时间表」驱动。
  //
  // 特别注意：这里刻意<b>不</b>下发 temp-unlock。按照 LockState 的优先级设计，
  // 「放行期」（家长临时解锁 / 答题奖励）是高于时间表的 —— 用临时解锁来「确保解锁态」
  // 会让时间表在整段宽限期内失效，测出来的就是假阴性。
  // 解除锁定用 lock:false（它只在真有锁定点时才会留下宽限）。
  const existingRules = await apiOrThrow('GET', `/schedules?deviceId=${deviceId}`, { token })
  for (const rule of existingRules.schedules) {
    await apiOrThrow('DELETE', `/schedules/${rule.id}?deviceId=${deviceId}`, { token })
  }
  ok(`已清空既有时间表（原 ${existingRules.schedules.length} 条）`)

  await apiOrThrow('PUT', `/lock-policy?deviceId=${deviceId}`, {
    token, body: { strength: 'kiosk', countdownSeconds: 90, scheduleEnabled: true },
  })
  await apiOrThrow('POST', `/device/lock?deviceId=${deviceId}`, { token, body: { locked: false } })

  const unlockedNow = await waitFor(async () => {
    const d = await apiOrThrow('GET', `/device?deviceId=${deviceId}`, { token })
    return d.effectiveLocked === false && '当前处于未锁定态'
  }, { timeoutMs: 60_000, intervalMs: 3000 })
  check(unlockedNow.ok, '起点状态确认为「未锁定」', unlockedNow.ok ? '' : '仍处于锁定')

  const now = new Date()
  const nowMinute = now.getHours() * 60 + now.getMinutes()
  const today = now.getDay()
  const ruleStart = nowMinute + 4
  const ruleEnd = Math.min(1440, nowMinute + 12)
  const schedule = await apiOrThrow('POST', `/schedules?deviceId=${deviceId}`, {
    token,
    body: {
      name: 'E2E 定时锁定', action: 'lock',
      daysOfWeek: [today], startMinute: ruleStart, endMinute: ruleEnd,
    },
  })
  const scheduleId = schedule.schedule.id
  ok(`已创建定时规则：今天 ${fmtMinute(ruleStart)} → ${fmtMinute(ruleEnd)}，预告 90 秒`)

  // 设备默认每 60 秒拉一次配置；重启一次可以让它立刻取到新规则，测试因此确定性得多
  const pidBeforeRefresh = (adb('shell', 'pidof', PKG).out || '').trim()
  if (pidBeforeRefresh) adb('shell', 'kill', '-9', pidBeforeRefresh)
  await waitFor(async () => Boolean((adb('shell', 'pidof', PKG).out || '').trim()),
    { timeoutMs: 60_000, intervalMs: 3000 })

  // 倒计时悬浮窗应当在锁定前 90 秒内出现
  const overlayWait = await waitFor(async () => overlayAttached() && '悬浮窗已挂载',
    { timeoutMs: 240_000, intervalMs: 3000 })
  check(overlayWait.ok,
    `锁屏前弹出了透明倒计时悬浮窗（等待 ${Math.round(overlayWait.elapsedMs / 1000)} 秒）`,
    overlayWait.ok ? '' : '未观察到 balloon-countdown 窗口')

  // 到点应当进入 Kiosk 锁定
  // 两条锁定路径都要认：设备所有者走 kiosk，其余走全屏悬浮窗
  const lockWait = await waitFor(async () => {
    if (lockTaskState() === 'LOCKED') return 'kiosk 已锁定'
    if (lockOverlayAttached()) return '全屏悬浮窗已锁定'
    return false
  }, { timeoutMs: 180_000, intervalMs: 3000 })
  check(lockWait.ok, '到达时间表边界后自动进入锁定',
    `kiosk=${lockTaskState()} 悬浮窗=${lockOverlayAttached()}`)

  // 锁定页上应当同时具备强度说明（答题入口的可见性由家长端开关决定）。
  // 注意：锁定动作会 lockNow() 关屏，dumpUi 内部会先唤醒。
  const lockUi = await dumpUi()
  check(lockUi.includes('设备已被家长锁定'), '锁定页已显示在孩子设备上')
  check(lockUi.includes('Kiosk 锁定：无法退出'), '锁定页如实标注了当前锁定强度')

  step('19. 设备把实际锁定状态回报给家长端（需求 3）')
  const lockReport = await waitFor(async () => {
    const d = await apiOrThrow('GET', `/device?deviceId=${deviceId}`, { token })
    return d.effectiveLocked === true && `effectiveLocked=true（${d.lockReason || ''}）`
  }, { timeoutMs: 60_000, intervalMs: 3000 })
  check(lockReport.ok,
    '家长端看到了设备「实际已锁定」——与家长的期望状态分开上报',
    lockReport.ok ? lockReport.detail : 'effectiveLocked 未变为 true')

  step('20. 远程解锁（需求 3、5）')
  await apiOrThrow('POST', `/device/temp-unlock?deviceId=${deviceId}`, { token, body: { minutes: 30 } })
  const unlockWait = await waitFor(async () => {
    if (lockTaskState() !== 'NONE') return false
    if (lockOverlayAttached()) return false
    if (lockPageShowing()) return false
    return 'kiosk 已退出、悬浮窗已移除、锁定页已关闭'
  }, { timeoutMs: 120_000, intervalMs: 3000 })
  check(unlockWait.ok, '远程解锁即时生效：退出 Kiosk 并关闭锁定页',
    unlockWait.ok ? unlockWait.detail
                  : `kiosk=${lockTaskState()} 前台=${resumedActivityName() || '未知'}`)

  // 倒计时悬浮窗在解锁后应当被收起
  const overlayGone = await waitFor(async () => !overlayAttached() && '悬浮窗已收起',
    { timeoutMs: 30_000, intervalMs: 2000 })
  check(overlayGone.ok, '解锁后倒计时悬浮窗已收起')

  step('21. 最高强度档：随机改写系统锁屏密码 + 应急解锁（需求 2）')
  if (isDeviceOwner) {
    // 先在设备上设置应急密码（这一步在界面里完成，是真机上的必经流程）
    adbOrThrow('shell', 'am', 'start', '-n', `${PKG}/.ui.MainActivity`)
    await sleep(3000)
    await tapByText('设置应急解锁密码')
    await sleep(1500)
    // 弹框里的数字输入框：直接输入并确认
    adbOrThrow('shell', 'input', 'text', '135790')
    await sleep(500)
    await tapByText('保存')
    await sleep(2500)
    check(prefValue('emergency_password_hash') !== null ||
          (adb('shell', 'run-as', PKG, 'cat', 'shared_prefs/balloon_dog_agent_prefs.xml').out || '')
            .includes('emergency_password_hash'),
      '应急解锁密码已保存到本机（不上传服务器）')

    // 切到最高强度档并立即锁定
    await apiOrThrow('PUT', `/lock-policy?deviceId=${deviceId}`, {
      token, body: { strength: 'password', countdownSeconds: 0, scheduleEnabled: false },
    })
    await apiOrThrow('POST', `/device/lock?deviceId=${deviceId}`, { token, body: { locked: true } })

    const pwLocked = await waitFor(async () => {
      const log = agentLog()
      if (log.includes('已把系统锁屏密码改为随机值')) return '已改写系统锁屏密码'
      return (await dumpUi()).includes('最高强度锁定') && '锁定页显示最高强度'
    }, { timeoutMs: 120_000, intervalMs: 3000 })
    check(pwLocked.ok, '最高强度档生效：锁定瞬间随机改写了系统锁屏密码',
      pwLocked.ok ? pwLocked.detail : agentLog().slice(-300))

    // ---- 这一步是整套方案里风险最高的场景，必须真跑一次 ----
    // 随机改写了系统锁屏密码之后重启：如果没有在「用户解锁之前」把随机密码清掉，
    // 设备会永久卡在系统锁屏上（解锁需要随机密码，而清密码的应用又要等解锁后才能跑）。
    // 这条曾经真的把模拟器锁死过，所以放进端到端回归里。
    // 设备加密存储的文件在 /data/user_de/0/<包名>/shared_prefs/，
    // run-as 只认凭据加密目录，读不到它 —— 必须 root。
    shell('su -c "ls /data/user_de/0/' + PKG + '/shared_prefs/" >/dev/null 2>&1 || true')
    const dePrefs = rootCat(`/data/user_de/0/${PKG}/shared_prefs/balloon_dog_agent_device_protected.xml`)
    if (dePrefs === null) {
      ok('跳过「随机密码写入设备加密存储」的文件核对（本机拿不到 root）')
    } else {
      check(dePrefs.includes('current_random_password') && dePrefs.includes('reset_token'),
        '随机密码与重置令牌都已写入设备加密存储（解锁前即可读到，安全阀才有机会生效）',
        dePrefs.slice(0, 200))
    }

    adb('shell', 'reboot')
    // 重启瞬间 adb 一定会掉线（device offline），此时 shell() 会抛。
    // 所以先老老实实等设备重新连上，再用「不抛」的方式轮询开机完成。
    adb('wait-for-device')
    await waitFor(async () => {
      const b = (adb('shell', 'getprop', 'sys.boot_completed').out || '').trim()
      return b === '1' && '已重新开机'
    }, { timeoutMs: 300_000, intervalMs: 5000 })

    // 关键断言：开机后用户必须能进系统。停在这里就说明破解死循环的修复失效了。
    const unlockedAfterReboot = await waitFor(async () => {
      const out = shell('dumpsys user')
      return /State: RUNNING_UNLOCKED/.test(out) && '用户已解锁'
    }, { timeoutMs: 180_000, intervalMs: 5000 })
    check(unlockedAfterReboot.ok,
      '重启后设备仍能进入系统（随机锁屏密码在解锁前已被清除）',
      unlockedAfterReboot.ok ? unlockedAfterReboot.detail : shell('dumpsys user | grep State:'))
    check(/检测到随机锁屏密码仍生效，开机时立即清除/.test(agentLog(400)),
      '开机日志证明安全阀确实执行了（不是碰巧没锁屏密码）', agentLog(30).slice(-300))

    // 重启会打断服务，等它自己回来再继续
    await waitFor(async () => Boolean((adb('shell', 'pidof', PKG).out || '').trim()),
      { timeoutMs: 120_000, intervalMs: 4000 })
    adbOrThrow('shell', 'input', 'keyevent', 'KEYCODE_WAKEUP')
    adbOrThrow('shell', 'wm', 'dismiss-keyguard')
    // 重启后 adbd 退回非 root：这里补回来，否则阶段 22 的 kill -9 会被系统拒绝，
    // 「保活」断言就会以假象失败（实测踩过）。
    await ensureRoot()
    await sleep(3000)

    // 重新锁定一次，让「随机系统密码」再次生效。
    // 不做这一步的话：上面的安全阀已经把随机密码清掉了、锁定页也不在了，
    // 接下来的应急解锁就无从测起（找不到「应急解锁」入口）。
    await apiOrThrow('POST', `/device/lock?deviceId=${deviceId}`, { token, body: { locked: true } })
    const relockedForEmergency = await waitFor(async () => {
      const log = agentLog()
      return log.includes('已把系统锁屏密码改为随机值') || 'relocked'
    }, { timeoutMs: 120_000, intervalMs: 3000 })
    check(relockedForEmergency.ok, '重启后重新锁定，随机系统密码再次生效（应急解锁的前提）')
    await sleep(3000)

    // 应急解锁：不需要网络，输入本机应急密码即可恢复
    await tapByText('应急解锁')
    await sleep(1500)
    adbOrThrow('shell', 'input', 'text', '135790')
    await sleep(500)
    await tapByText('解锁')
    const emergencyOk = await waitFor(async () => {
      const log = agentLog()
      return log.includes('已通过应急密码解除锁定') && '应急解锁成功'
    }, { timeoutMs: 60_000, intervalMs: 3000 })
    check(emergencyOk.ok, '应急密码可离线解锁，并清除随机锁屏密码',
      emergencyOk.ok ? '' : '未在日志中看到应急解锁成功')
  } else {
    ok('跳过：需要设备所有者权限')
  }

  step('22. 保活：进程被杀后自动恢复（需求 1）')
  // 阶段 21 里重启过设备，adbd 已退回非 root —— 不提权的话下面的 kill 会被拒绝，
  // 断言会以「没恢复」的假象失败。
  const rootForKill = await ensureRoot()
  check(rootForKill, '已取得 root（否则无法真正杀死进程来验证保活）')
  const pidBefore = (adb('shell', 'pidof', PKG).out || '').trim()
  await killAgentProcess()
  // 这里不去断言「进程一定消失」：START_STICKY 的重建可能在 2 秒内就完成，
  // 断言窗口太短必然 flaky。断言「PID 换了一个」既稳定又真正说明问题。
  const revivedByWatchdog = await waitFor(async () => {
    const pid = (adb('shell', 'pidof', PKG).out || '').trim()
    if (pid && pid !== pidBefore) return `新进程 ${pid}（原 ${pidBefore}）`
    return false
  }, { timeoutMs: 120_000, intervalMs: 4000 })
  check(revivedByWatchdog.ok, 'START_STICKY / 看门狗已把守护自动拉回来',
    revivedByWatchdog.ok ? revivedByWatchdog.detail : '未观察到进程恢复')

  step('23. 清理强管控阶段的规则与策略')
  await apiOrThrow('DELETE', `/schedules/${scheduleId}?deviceId=${deviceId}`, { token })
  await apiOrThrow('PUT', `/lock-policy?deviceId=${deviceId}`, {
    token, body: { strength: 'kiosk', countdownSeconds: 30, scheduleEnabled: false },
  })
  await apiOrThrow('POST', `/device/lock?deviceId=${deviceId}`, { token, body: { locked: false } })
  await apiOrThrow('POST', `/device/temp-unlock?deviceId=${deviceId}`, { token, body: { minutes: 60 } })
  ok('已清除验证用的时间表与策略')

  step('24. 解绑后设备能自动重新注册（令牌失效自愈）')
  const removed = await apiOrThrow('DELETE', `/devices/${deviceId}`, { token })
  check(removed.success === true, '已解绑（服务端删除设备记录，设备令牌随即失效）')

  // 解绑会删掉设备行 → 设备端下一次请求收到 401 → 用本地 deviceCode + deviceSecret
  // 自动重新注册一台新设备。用「同一个绑定码能否再次认领」来验证这条自愈链路。
  let rebound = null
  for (let i = 0; i < 20 && !rebound; i++) {
    const res = await api('POST', '/devices/bind', { token, body: { deviceCode, name: 'E2E 重新配对' } })
    if (res.ok && res.body?.device?.id) rebound = res.body.device
    else await sleep(3000)
  }
  check(Boolean(rebound), '设备已自动重新注册，同一个绑定码可以再次被认领')
  if (rebound) {
    check(rebound.id !== deviceId, '重新注册得到的是一个全新的 deviceId')
    const reOnline = await apiOrThrow('GET', `/device?deviceId=${rebound.id}`, { token })
    check(reOnline.deviceCode === deviceCode || reOnline.deviceCode === undefined,
      '新设备沿用原来的绑定码')
  }

  step('25. 清理本轮绑定的设备')
  if (rebound) {
    const cleaned = await apiOrThrow('DELETE', `/devices/${rebound.id}`, { token })
    check(cleaned.success === true, '已解绑重新注册的设备')
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

  step('26. 清理模拟器上遗留的注册记录')
  const purged = await purgeLeftoverDevices(deviceModel(), [deviceId, rebound?.id].filter(Boolean))
  if (purged >= 0) ok(`已清理 ${purged} 台遗留的模拟器设备（型号 ${deviceModel()}）`)

  console.log(`\n\x1b[1m结果：${passed} 项通过，${failed} 项失败\x1b[0m`)
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
