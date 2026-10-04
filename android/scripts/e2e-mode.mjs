#!/usr/bin/env node
/**
 * 模式切换 / 护眼 / 应用插件 的**设备端**端到端验证。
 *
 * 它回答一个别处回答不了的问题：家长在网页上把「学习模式」打开之后，
 * 孩子手机上是不是**真的用不了**那些应用。
 *
 * 覆盖：
 *   1. 设备上报已安装应用清单 → 家长端能看到（选择应用/功能管控的数据来源）；
 *   2. 家长开启手动学习模式 → 启动一个不在白名单的应用 → 被拦回；
 *   3. 把该应用加入白名单 → 再启动 → 这次能正常留在前台（证明拦截不是「什么都拦」）；
 *   4. 切回普通模式 → 该应用恢复可用；
 *   5. 按时段模式：把当前小时设为学习时段 → 同样被拦；
 *   6. 护眼开启后配置能下发到设备并被持久化；
 *   7. 插件规则能下发并持久化（模拟器上没装微信，所以这里只验证「规则到达设备」，
 *      关键词匹配本身由 android:crosstest 的 GuardCheck 逐条覆盖）。
 *
 * 用法：node android/scripts/e2e-mode.mjs
 *      API_BASE=http://localhost:4002/api node android/scripts/e2e-mode.mjs
 */

import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const HERE = dirname(fileURLToPath(import.meta.url))
const ANDROID_DIR = resolve(HERE, '..')
const APK = resolve(ANDROID_DIR, 'app/build/outputs/apk/debug/app-debug.apk')

const API_BASE = process.env.API_BASE || 'http://localhost:4000/api'
const PKG = 'com.balloondog.agent'
const HOME = process.env.HOME || ''
const ADB = process.env.ADB || `${HOME}/Library/Android/sdk/platform-tools/adb`
const PARENT_PHONE = '13800138000'
const PARENT_PASSWORD = 'balloon123'

/** 用来被拦的靶子应用：系统自带、可启动、不在任何白名单里。 */
const TARGET_PKG = 'com.google.android.deskclock'
const TARGET_NAME = '时钟'

let passed = 0
let failed = 0
const ok = (m) => { passed++; console.log(`  \x1b[32m✓\x1b[0m ${m}`) }
const bad = (m, x = '') => { failed++; console.log(`  \x1b[31m✗\x1b[0m ${m}${x ? ` — ${x}` : ''}`) }
const check = (c, m, x = '') => (c ? ok(m) : bad(m, x))
const step = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function resolveSerial() {
  const out = spawnSync(ADB, ['devices'], { encoding: 'utf8' }).stdout || ''
  const serials = out.split('\n').slice(1).map((l) => l.split('\t')[0].trim()).filter(Boolean)
  const emulator = serials.find((s) => s.startsWith('emulator-'))
  // 永远优先模拟器：用户可能插着真机，绝不能把测试跑到它上面去
  return emulator || (process.env.ANDROID_SERIAL && serials.includes(process.env.ANDROID_SERIAL)
    ? process.env.ANDROID_SERIAL : '')
}
const SERIAL = resolveSerial()

function adb(...args) {
  const r = spawnSync(ADB, SERIAL ? ['-s', SERIAL, ...args] : args, { encoding: 'utf8' })
  return { code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() }
}
const shell = (cmd) => adb('shell', cmd)
const agentLog = (n = 120) =>
  (adb('shell', 'logcat', '-d', '-s', 'BalloonDog').out || '').split('\n').slice(-n).join('\n')

async function waitFor(probe, timeoutMs = 60_000, intervalMs = 2000) {
  const t0 = Date.now()
  for (;;) {
    let v = false
    try { v = await probe() } catch { v = false }
    if (v) return v
    if (Date.now() - t0 > timeoutMs) return false
    await sleep(intervalMs)
  }
}

/** 当前前台包名（用 dumpsys，不用 uiautomator —— 后者会把无障碍服务顶掉重连）。 */
function foregroundPackage() {
  const out = adb('shell', 'dumpsys', 'activity', 'activities').out || ''
  for (const line of out.split('\n')) {
    if (!line.includes('topResumedActivity')) continue
    const m = line.match(/([A-Za-z0-9_.]+)\/[A-Za-z0-9_.$]+/)
    if (m) return m[1]
  }
  return ''
}

async function api(method, path, { body, token } = {}) {
  const headers = {}
  if (token) headers.Authorization = `Bearer ${token}`
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  const res = await fetch(`${API_BASE}${path}`, {
    method, headers, body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let parsed = null
  try { parsed = text ? JSON.parse(text) : null } catch { parsed = text }
  return { ok: res.ok, status: res.status, body: parsed }
}
const must = async (method, path, options) => {
  const r = await api(method, path, options)
  if (!r.ok) throw new Error(`${method} ${path} → ${r.status} ${r.body?.message || ''}`)
  return r.body
}

/** 用 monkey 启动一个应用（比 am start 稳：不需要知道具体 Activity 名）。 */
function launchApp(pkg) {
  adb('shell', 'monkey', '-p', pkg, '-c', 'android.intent.category.LAUNCHER', '1')
}

/**
 * 读界面层级。
 *
 * <p>注意它会把无障碍服务顶掉重连，所以**只在启动守护这一小段用**；
 * 后面所有拦截相关的判定一律走 dumpsys 与日志，不去碰 uiautomator。
 */
async function dumpUi() {
  adb('shell', 'input', 'keyevent', 'KEYCODE_WAKEUP')
  adb('shell', 'wm', 'dismiss-keyguard')
  for (let i = 0; i < 5; i++) {
    adb('shell', 'rm', '-f', '/sdcard/ui.xml')
    adb('shell', 'uiautomator', 'dump', '/sdcard/ui.xml')
    const out = adb('shell', 'cat', '/sdcard/ui.xml').out || ''
    if (out.includes('<hierarchy')) return out
    await sleep(1500)
  }
  return ''
}

function findNodeCenter(xml, text) {
  for (const node of xml.split('>')) {
    if (!node.includes(`text="${text}"`)) continue
    const m = node.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/)
    if (!m) continue
    const [, x1, y1, x2, y2] = m.map(Number)
    return { x: Math.round((x1 + x2) / 2), y: Math.round((y1 + y2) / 2) }
  }
  return null
}

/** 按文本点击（必要时滚动找）。 */
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

/** 设备当前存下来的模式/护眼/插件配置（直接读 prefs，验证「真的落盘了」）。 */
function prefsXml() {
  const file = adb('root').code === 0 ? `/data/data/${PKG}/shared_prefs/balloon_dog_agent_prefs.xml` : ''
  if (file) {
    const out = adb('shell', 'cat', file).out || ''
    if (out.includes('<map')) return out
  }
  return adb('shell', 'run-as', PKG, 'cat', 'shared_prefs/balloon_dog_agent_prefs.xml').out || ''
}

async function main() {
  console.log('\x1b[1m气球狗 · 学习模式 / 护眼 / 插件管控 设备端端到端验证\x1b[0m')
  console.log(`  设备 ${SERIAL}`)
  console.log(`  API  ${API_BASE}`)
  if (!existsSync(APK)) { console.error('找不到 APK，请先 ./gradlew :app:assembleDebug'); process.exit(1) }
  if (!SERIAL) { console.error('没有可用设备（优先模拟器）'); process.exit(1) }

  adb('install', '-r', '-g', APK)

  // ==========================================================
  step('0. 准备：清空应用数据并重启，保证从干净状态开始')
  adb('root')
  adb('wait-for-device')
  await sleep(1500)

  // 必须先停掉无障碍服务再杀进程：否则系统会在 1 秒内把进程重新拉起来，
  // 抢在 rm 之前把 shared_prefs 又写回去 —— 上一轮的绑定码会留下来，
  // 于是「设备已生成绑定码」「已进入学习模式」这些断言全部读到上一轮的日志而假通过。
  shell('settings put secure enabled_accessibility_services null')
  await sleep(2000)
  const pid = shell(`pidof ${PKG}`).out
  if (pid) adb('shell', 'kill', '-9', pid)
  await sleep(2500)
  adb('shell', 'rm', '-rf', `/data/data/${PKG}/shared_prefs`, `/data/data/${PKG}/cache`,
    `/data/user_de/0/${PKG}/shared_prefs`)
  await sleep(1500)

  const wiped = !(adb('shell', 'run-as', PKG, 'cat', 'shared_prefs/balloon_dog_agent_prefs.xml').out || '')
    .includes('device_code')
  check(wiped, '应用数据已清空（绑定码已消失，确认不是上一轮的残留）')

  // 清日志同样重要：本脚本大量靠日志判定，
  // 不清就会把上一轮的「已进入学习模式」当成这一轮的结论。
  adb('shell', 'logcat', '-c')

  adb('shell', 'input', 'keyevent', 'KEYCODE_WAKEUP')
  adb('shell', 'wm', 'dismiss-keyguard')

  step('1. 启动守护并配对')
  adb('shell', 'am', 'start', '-n', `${PKG}/.ui.MainActivity`)
  await sleep(5000)
  const mainReady = await waitFor(async () => (await dumpUi()).includes('text="运行状态"'), 60_000, 2500)
  check(Boolean(mainReady), '主界面已渲染')

  // 服务不会自己起来（AgentService 刻意声明为不导出），必须像真人一样从界面上点
  const alreadyRunning = (await dumpUi()).includes('text="停止守护"')
    || (await dumpUi()).includes('text="守护运行中"')
  if (alreadyRunning) {
    ok('守护服务原本就在运行')
  } else {
    const tapped = await tapByText('启动守护')
    check(tapped, '已在界面上点击「启动守护」')
  }
  await sleep(5000)

  // 注意 shell() 只接受**一个**命令串。写成两个参数的话第二个会被静默丢掉，
  // 于是命令退化成「settings put secure enabled_accessibility_services」——
  // 效果是把服务名清空，正好和本意相反（实测踩过：看门狗整轮都没被绑定）。
  shell(`settings put secure enabled_accessibility_services ${PKG}/${PKG}.service.LockWatchdogService`)
  shell('settings put secure accessibility_enabled 1')
  await sleep(3000)

  const watchdogUp = await waitFor(async () => /看门狗已连接/.test(agentLog(200)) && 'up', 30_000, 2500)
  check(Boolean(watchdogUp),
    '无障碍看门狗已连接（拦截能力的前提）', agentLog(20).slice(-200))

  const reg = await waitFor(async () => {
    const m = agentLog(200).match(/绑定码 ([A-Z0-9]{6,12})/)
    return m ? m[1] : false
  }, 90_000, 3000)
  check(Boolean(reg), `设备已生成绑定码 ${reg || ''}`)

  const login = await must('POST', '/auth/login', {
    body: { phone: PARENT_PHONE, password: PARENT_PASSWORD },
  })
  const token = login.token
  const bound = await must('POST', '/devices/bind', {
    token, body: { deviceCode: reg, name: 'E2E 学习模式验证机' },
  })
  const deviceId = bound.device.id
  const q = `deviceId=${deviceId}`
  ok(`家长已认领（deviceId=${deviceId}）`)

  // 让设备尽快拉到配置
  await must('PUT', `/features?${q}`, { token, body: { feature: 'modeSwitch', enabled: true } })
  await must('POST', `/device-apps/refresh?${q}`, { token })
  // 注意要带 includeSystem=true：模拟器上的「时钟」是系统应用，
  // 而家长端默认会把系统应用过滤掉 —— 不带这个参数会误判成「设备没上报」
  const appsSeen = await waitFor(async () => {
    const r = await api('GET', `/device-apps?${q}&includeSystem=true`, { token })
    return (r.body?.total ?? 0) > 50
  }, 120_000, 4000)
  check(Boolean(appsSeen), '设备已把已安装应用清单上报给家长端')

  const apps = await must('GET', `/device-apps?${q}&includeSystem=true`, { token })
  const target = apps.apps.find((a) => a.packageName === TARGET_PKG)
  check(Boolean(target), `清单里有靶子应用「${TARGET_NAME}」（${TARGET_PKG}）`,
    target ? '' : `实际拿到 ${apps.total} 个应用`)
  check(target?.isLaunchable === true,
    '靶子应用被标记为「可启动」—— 学习模式的拦截判据就靠它',
    target ? `isLaunchable=${target.isLaunchable}` : '')

  // ==========================================================
  step('2. 普通模式下：靶子应用可以正常打开（先证明基线是通的）')
  launchApp(TARGET_PKG)
  const baseline = await waitFor(async () => foregroundPackage() === TARGET_PKG && '前台', 20_000, 1500)
  check(Boolean(baseline), `普通模式下能打开「${TARGET_NAME}」`,
    `当前前台 ${foregroundPackage() || '未知'}`)

  // ==========================================================
  step('3. 手动切到学习模式 → 靶子应用被拦回')
  await must('PUT', `/device-mode?${q}`, { token, body: { manualMode: 'study', scheduleEnabled: false } })
  const modeApplied = await waitFor(async () =>
    /已进入学习模式/.test(agentLog(300)) && 'applied', 90_000, 3000)
  check(Boolean(modeApplied), '设备已收到并进入学习模式', agentLog(40).slice(-300))

  // 先回桌面，再启动靶子应用 —— 否则它还停在前台，分不清是「没被拦」还是「没动」
  adb('shell', 'input', 'keyevent', 'KEYCODE_HOME')
  await sleep(2500)
  launchApp(TARGET_PKG)
  const blocked = await waitFor(async () => {
    const fg = foregroundPackage()
    if (fg === TARGET_PKG) return false
    return /看门狗：拦截 .*不在允许清单/.test(agentLog(400)) && 'blocked'
  }, 45_000, 2000)
  // 两个条件缺一不可：前台确实不是靶子，而且日志里确实有拦截记录。
  // 只判前者会在「启动失败」时假通过。
  check(Boolean(blocked),
    `学习模式下「${TARGET_NAME}」被拦回（没留在前台）`,
    `当前前台 ${foregroundPackage() || '未知'}；最近日志：`
      + agentLog(12).replace(/\n/g, ' | ').slice(-400))
  check(foregroundPackage() !== TARGET_PKG,
    '被拦之后它确实不在前台（不是只打了一行日志）')

  // ==========================================================
  // ==========================================================
  step('4. 按时间设置：命中当前小时即进入学习模式 → 同样被拦')
  //
  // 顺序说明：这一步必须排在「加入白名单」之前。
  // 反过来的话，靶子应用还在白名单里，学习模式就**不该**拦它 ——
  // 那时测出来的失败是测试顺序的问题，不是产品的问题（实测踩过一整轮）。
  const now = new Date()
  await must('PUT', `/study-slots?${q}`, {
    token,
    body: { slots: [{ dayOfWeek: now.getDay(), hour: now.getHours() }] },
  })
  await must('PUT', `/device-mode?${q}`, { token, body: { manualMode: null, scheduleEnabled: true } })
  const scheduled = await waitFor(async () =>
    /已进入学习模式/.test(agentLog(300)) && 'ok', 150_000, 4000)
  check(Boolean(scheduled), '命中当前时段后自动进入学习模式', agentLog(30).slice(-300))

  adb('shell', 'input', 'keyevent', 'KEYCODE_HOME')
  await sleep(2500)
  launchApp(TARGET_PKG)
  // 必须同时满足「前台不是靶子」与「日志里确实有拦截」。
  // 只看前者会是假通过：启动失败（monkey 报错）时前台也不是靶子。
  const blockedBySchedule = await waitFor(async () =>
    foregroundPackage() !== TARGET_PKG
      && /看门狗：拦截 .*不在允许清单/.test(agentLog(400)) && 'blocked', 45_000, 2000)
  check(Boolean(blockedBySchedule), '按时段进入的学习模式同样能拦住应用',
    `当前前台 ${foregroundPackage() || '未知'}；日志：` + agentLog(10).slice(-300))

  // ==========================================================
  step('5. 把靶子应用加入白名单 → 同一个应用这次能正常打开')
  await must('POST', `/mode-apps?${q}`, {
    token, body: { packageName: TARGET_PKG, appName: TARGET_NAME, group: 'study' },
  })
  // 设备默认 60 秒拉一次配置，这里的等待窗口要盖住它
  const whitelisted = await waitFor(async () => {
    const p = prefsXml()
    return p.includes(TARGET_PKG) && 'in-prefs'
  }, 150_000, 5000)
  check(Boolean(whitelisted), '白名单已下发并落到设备本地',
    prefsXml().includes(TARGET_PKG) ? '' : '本地 prefs 里还没有这个包名')

  adb('shell', 'input', 'keyevent', 'KEYCODE_HOME')
  await sleep(2000)
  launchApp(TARGET_PKG)
  const allowed = await waitFor(async () => foregroundPackage() === TARGET_PKG && 'foreground', 30_000, 2000)
  check(Boolean(allowed), `加入白名单后「${TARGET_NAME}」可以正常打开（证明不是「什么都拦」）`,
    `当前前台 ${foregroundPackage() || '未知'}`)

  // ==========================================================
  step('6. 切回普通模式并清空白名单 → 限制解除')
  await must('PUT', `/device-mode?${q}`, { token, body: { manualMode: 'normal', scheduleEnabled: false } })
  await must('PUT', `/study-slots?${q}`, { token, body: { slots: [] } })
  const list = await must('GET', `/mode-apps?${q}`, { token })
  for (const app of list.study) {
    await must('DELETE', `/mode-apps/${app.id}?${q}`, { token })
  }
  await waitFor(async () => /已退出学习模式/.test(agentLog(300)) && 'ok', 90_000, 3000)
  adb('shell', 'input', 'keyevent', 'KEYCODE_HOME')
  await sleep(2500)
  launchApp(TARGET_PKG)
  const backToNormal = await waitFor(async () =>
    foregroundPackage() === TARGET_PKG && 'foreground', 30_000, 2000)
  check(Boolean(backToNormal), '普通模式下限制解除，应用恢复可用',
    `当前前台 ${foregroundPackage() || '未知'}`)

  // ==========================================================
  step('7. 护眼与插件规则能下发到设备并落盘')
  await must('PUT', `/eye-care?${q}`, {
    token, body: { enabled: true, continuousMinutes: 40, restMinutes: 10, maxBrightnessPercent: 0 },
  })
  await must('PUT', `/app-plugins?${q}`, {
    token, body: { items: [{ packageName: 'com.tencent.mm', pluginKey: 'mm_moments', enabled: false }] },
  })

  const eyeApplied = await waitFor(async () => prefsXml().includes('eye_care_json'), 150_000, 5000)
  check(Boolean(eyeApplied), '护眼设置已下发并落到设备本地')
  check(/&quot;enabled&quot;:true|"enabled":true/.test(prefsXml()),
    '护眼在设备上确实是「已开启」')

  const pluginApplied = await waitFor(async () => prefsXml().includes('mm_moments'), 150_000, 5000)
  check(Boolean(pluginApplied), '插件规则已下发并落到设备本地',
    '（模拟器没装微信，关键词匹配本身由 android:crosstest 的 GuardCheck 覆盖）')

  const wechatInstalled = (adb('shell', 'pm', 'list', 'packages', 'com.tencent.mm').out || '').includes('com.tencent.mm')
  if (wechatInstalled) {
    ok('本机装了微信，可以做真实的插件拦截验证')
  } else {
    ok('本机没有微信/QQ —— 插件关键词匹配不在这里验证（已由 crosstest 逐条覆盖）')
  }

  // ==========================================================
  step('8. 清理')
  await must('PUT', `/eye-care?${q}`, { token, body: { enabled: false } })
  await must('PUT', `/app-plugins?${q}`, {
    token, body: { items: [{ packageName: 'com.tencent.mm', pluginKey: 'mm_moments', enabled: true }] },
  })
  await must('PUT', `/study-slots?${q}`, { token, body: { slots: [] } })
  await must('DELETE', `/devices/${deviceId}`, { token })
  adb('shell', 'input', 'keyevent', 'KEYCODE_HOME')
  ok('已关闭模式/护眼/插件设置并解绑验证设备')

  console.log(`\n\x1b[1m结果：${passed} 项通过，${failed} 项失败\x1b[0m`)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error(`\n\x1b[31m验证中断：${e.message}\x1b[0m`)
  process.exit(1)
})
