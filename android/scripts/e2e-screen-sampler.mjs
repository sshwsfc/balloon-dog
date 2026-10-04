#!/usr/bin/env node
/**
 * Android 端「屏幕采样」与「锁定复核」的端到端验证。
 *
 * 覆盖两件在服务端无法验证的事：
 *   A. 周期截屏 → 低分辨率压缩 → 打包 → 上传，最终在服务端出现洞察记录；
 *   B. 锁定复核 —— 锁定界面被弄掉之后，服务在 3 秒内发现并重新锁定。
 *      （B 用撤销悬浮窗权限来模拟「锁定界面被弄掉」，
 *       这是无设备所有者时孩子真实可用的绕过手段之一。）
 *
 * 用法：node android/scripts/e2e-screen-sampler.mjs
 * 前提：后端在跑、模拟器在跑、APK 已构建。
 */

import { spawnSync } from 'node:child_process'
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
const PARENT_PHONE = '13800138000'
const PARENT_PASSWORD = 'balloon123'

let passed = 0, failed = 0
const ok = (m) => { passed++; console.log(`  \x1b[32m✓\x1b[0m ${m}`) }
const bad = (m, x = '') => { failed++; console.log(`  \x1b[31m✗\x1b[0m ${m}${x ? ` — ${x}` : ''}`) }
const check = (c, m, x = '') => (c ? ok(m) : bad(m, x))
const step = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 解析目标设备：开发机上可能同时插着真机，绝不能误伤。 */
function resolveSerial() {
  if (process.env.ANDROID_SERIAL) return process.env.ANDROID_SERIAL
  const out = spawnSync(ADB, ['devices'], { encoding: 'utf8' }).stdout || ''
  const serials = out.split('\n').slice(1)
    .map((l) => l.trim().split(/\s+/)).filter((p) => p[1] === 'device').map((p) => p[0])
  if (serials.length === 1) return serials[0]
  const emulator = serials.find((s) => s.startsWith('emulator-'))
  if (emulator) {
    const skipped = serials.filter((s) => s !== emulator)
    console.log(`  [注意] 检测到多台设备，本次只操作 ${emulator}，不动：${skipped.join('、')}`)
    return emulator
  }
  return serials[0] || null
}
const SERIAL = resolveSerial()

function adb(...args) {
  const r = spawnSync(ADB, SERIAL ? ['-s', SERIAL, ...args] : args,
    { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  return { code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() }
}
const shell = (cmd) => adb('shell', cmd).out
const must = (...args) => {
  const r = adb(...args)
  if (r.code !== 0) throw new Error(`adb ${args.join(' ')} 失败：${r.err || r.out}`)
  return r.out
}

/** 唤醒屏幕后 dump 界面 —— 关屏时 uiautomator 拿不到 root node。 */
function dumpUi() {
  adb('shell', 'input', 'keyevent', 'KEYCODE_WAKEUP')
  for (let i = 0; i < 3; i++) {
    adb('shell', 'rm', '-f', '/sdcard/e2e.xml')
    adb('shell', 'uiautomator', 'dump', '/sdcard/e2e.xml')
    const out = adb('shell', 'cat', '/sdcard/e2e.xml').out || ''
    if (out.includes('<hierarchy')) return out
    spawnSync('sleep', ['0.7'])
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

/**
 * 在界面里按文本找元素，必要时向上滚动。
 *
 * 主界面很长，「授权屏幕采集」在靠下的「防护与保活」区，
 * 不滚动的话 uiautomator 根本不会把它放进 dump（不可见节点会被跳过），
 * 于是「找不到按钮 → 没点 → 弹不出授权框」。
 */
async function findAndTapByText(text, maxScrolls = 6) {
  for (let i = 0; i <= maxScrolls; i++) {
    const center = findNodeCenter(dumpUi(), text)
    if (center) {
      adb('shell', 'input', 'tap', String(center.x), String(center.y))
      return true
    }
    adb('shell', 'input', 'swipe', '540', '1800', '540', '700', '300')
    await sleep(900)
  }
  return false
}

/** 点掉屏幕共享授权框（中英文都认）。 */
async function tapConsent() {
  const xml = dumpUi()
  for (const label of ['立即开始', '开始录制', 'Start now', 'Start recording', '允许', 'Allow']) {
    const c = findNodeCenter(xml, label)
    if (c) {
      adb('shell', 'input', 'tap', String(c.x), String(c.y))
      return label
    }
  }
  return false
}

async function waitFor(probe, timeoutMs, intervalMs = 2000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const r = await probe()
    if (r) return r
    await sleep(intervalMs)
  }
  return null
}

const agentLog = (n = 60) => (adb('shell', 'logcat', '-d', '-s', 'BalloonDog').out || '').split('\n').slice(-n).join('\n')
const prefValue = (k) => (adb('shell', 'run-as', PKG, 'cat', 'shared_prefs/balloon_dog_agent_prefs.xml').out || '')
  .match(new RegExp(`name="${k}">([^<]*)<`))?.[1] ?? null

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
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${parsed?.message || ''}`)
  return parsed
}

function wakefulness() {
  const out = shell('dumpsys power | grep mWakefulness=')
  const m = /mWakefulness=(\w+)/.exec(out || '')
  return m ? m[1] : 'Unknown'
}

/**
 * 本机是否已设为设备所有者。
 *
 * 这个区分对本脚本很关键：设备所有者档下锁定走的是 Kiosk + 锁定页，
 * 压根不会用到全屏悬浮窗，「只剩 Activity 锁定页」那条最弱路径也不存在。
 * 所以各阶段的断言必须按实际能力档来选，否则换台机器跑就会得到假的失败。
 */
function deviceOwner() {
  const out = shell('dumpsys device_policy')
  return /Device Owner|deviceOwner/i.test(out) && /balloondog/.test(out)
}

/**
 * 锁定界面是否已经就位 —— 与能力档无关。
 *
 * Kiosk 档看系统的 Lock Task 状态，其余档看全屏悬浮窗是否挂着。
 * 各阶段统一用它，换一台机器跑（设备所有者 / 非设备所有者）都不会误判。
 */
function lockUiUp(isOwner) {
  return isOwner ? lockTaskState() === 'LOCKED' : overlayAttached()
}

function lockTaskState() {
  const out = shell('dumpsys activity activities')
  return out.match(/mLockTaskModeState=(\w+)/)?.[1] ?? 'UNKNOWN'
}
function overlayAttached() {
  const out = shell('dumpsys window windows')
  return /Window #[0-9]+ Window\{[^}]*balloon-lock-overlay[^}]*\}/.test(out)
    || /mCurrentFocus=Window\{[^}]*balloon-lock-overlay[^}]*\}/.test(out)
}

/**
 * 系统接受过多少次「启动锁定页」。
 *
 * 阶段 8 只能靠日志判定，不能靠窗口焦点：设备管理器一激活，lockNow() 就会把<b>系统锁屏</b>
 * 拉出来盖在我们的锁定页上面，mCurrentFocus 落在 Keyguard 上，看焦点永远看不到我们的页面。
 * 而「ActivityTaskManager 接受了启动请求」这件事是确定无疑的，且能区分
 * 「只是发了个 Intent」和「系统真的把页面起来了」。
 */
function lockStartCount() {
  const out = shell('logcat -d -s ActivityTaskManager:I | grep START')
  return (out.match(/START u0 \{[^}]*LockScreenActivity/g) || []).length
}


async function main() {
  console.log('\x1b[1m气球狗 · 屏幕采样与锁定复核端到端验证\x1b[0m')
  console.log(`  设备 ${SERIAL}`)
  console.log(`  API  ${API_BASE}`)
  if (!existsSync(APK)) { console.error('找不到 APK，请先 ./gradlew :app:assembleDebug'); process.exit(1) }
  if (!SERIAL) { console.error('没有可用设备'); process.exit(1) }

  step('0. 安装并准备')
  adb('install', '-r', '-g', APK)
  // 后面的判定大量依赖日志（锁定页启动计数、复核器判定），
  // 不清空的话会把上一轮的日志算进来，出现「假通过」。
  adb('shell', 'logcat', '-c')
  check(shell(`pm list packages ${PKG}`).includes(PKG), '应用已安装')

  // 无障碍看门狗负责记录前台应用（给每张截图标注包名），这里一并开启
  must('shell', 'settings', 'put', 'secure', 'enabled_accessibility_services',
    `${PKG}/${PKG}.service.LockWatchdogService`)
  must('shell', 'settings', 'put', 'secure', 'accessibility_enabled', '1')
  ok('已启用无障碍看门狗（用于记录前台应用）')

  // 重置本地状态，保证从干净状态开始
  const oldPid = shell(`pidof ${PKG}`)
  if (oldPid) adb('shell', 'kill', '-9', oldPid)
  await sleep(1500)
  adb('shell', 'rm', '-rf', `/data/data/${PKG}/shared_prefs`, `/data/data/${PKG}/cache`)
  adb('shell', 'appops', 'set', PKG, 'SYSTEM_ALERT_WINDOW', 'allow')

  step('1. 启动守护并配对')
  adb('shell', 'input', 'keyevent', 'KEYCODE_WAKEUP')
  adb('shell', 'wm', 'dismiss-keyguard')
  adb('shell', 'am', 'start', '-n', `${PKG}/.ui.MainActivity`)
  await sleep(5000)
  const mainUi = dumpUi()
  if (!mainUi.includes('text="停止守护"') && !mainUi.includes('text="守护运行中"')) {
    const btn = findNodeCenter(mainUi, '启动守护')
    if (btn) { adb('shell', 'input', 'tap', String(btn.x), String(btn.y)); console.log('    已点「启动守护」') }
  }
  await sleep(8000)
  const code = prefValue('device_code')
  check(/^[A-Z0-9]{6,12}$/.test(code || ''), `设备已注册（绑定码 ${code}）`)
  check(agentLog().includes('看门狗已连接') || agentLog().includes('守护服务已启动'),
    '守护服务与看门狗均已启动')

  const login = await api('POST', '/auth/login', { body: { phone: PARENT_PHONE, password: PARENT_PASSWORD } })
  const token = login.token
  const device = await api('POST', '/devices/bind', { token, body: { deviceCode: code, name: '采样与复核验证' } })
  const deviceId = device.device.id
  ok(`家长已认领（deviceId=${deviceId}）`)

  step('2. 【A】家长开启周期截屏（10 秒一张、2 张一包，便于快速验证）')
  await api('PUT', `/screen-monitor?deviceId=${deviceId}`, {
    token, body: { captureEnabled: true, captureIntervalSeconds: 10, framesPerBatch: 2, analyzeEnabled: true },
  })
  ok('已在家长端开启截屏')

  // 让设备立刻拉到新配置：杀掉进程，START_STICKY 会把它拉回来并重新拉配置
  const pid = shell(`pidof ${PKG}`)
  if (pid) adb('shell', 'kill', '-9', pid)
  await waitFor(async () => shell(`pidof ${PKG}`), 60_000)
  await sleep(6000)
  // 布尔型偏好存的是 <boolean name="capture_enabled" value="true" />，
  // 不能拿仅匹配 <string> 的 prefValue 去读。
  const prefsXml = () => adb('shell', 'run-as', PKG, 'cat', 'shared_prefs/balloon_dog_agent_prefs.xml').out || ''
  const captureOn = await waitFor(async () =>
    /name="capture_enabled" value="true"/.test(prefsXml()) && 'on', 60_000, 3000)
  check(Boolean(captureOn), '设备已收到「开启截屏」配置')

  step('3. 【A】授予屏幕采集权限（系统弹框需人工点一次）')
  adb('shell', 'am', 'start', '-n', `${PKG}/.ui.MainActivity`)
  await sleep(3000)

  // 主动点一次按钮触发授权框；找不到也没关系 ——
  // 采样器每次失败都会重新拉起授权 Activity，所以下面还会持续等它出现。
  const pressed = await findAndTapByText('授权屏幕采集')
  if (pressed) console.log('    已点击「授权屏幕采集」')

  // 持续尝试点掉系统弹框。给足 90 秒：采样失败会周期性重弹，
  // 而每次 dump + tap 本身要 1~2 秒，太短的窗口容易整段错过。
  const tapped = await waitFor(async () => {
    const label = await tapConsent()
    return label ? label : false
  }, 90_000, 2500)
  check(Boolean(tapped), '已授予屏幕采集权限', '未在 90 秒内点到系统授权框')

  step('4. 【A】等采样与上传完成')
  const uploadSeen = await waitFor(async () => {
    const log = agentLog()
    return log.includes('已上传截屏包') && '已上传'
  }, 180_000, 3000)
  check(Boolean(uploadSeen), '设备端完成了「打包 + 上传」', agentLog().slice(-400))

  const sampled = /已上传截屏包 (\d+) 张/.exec(agentLog())
  check(Boolean(sampled), `日志显示上传了 ${sampled?.[1] ?? '?'} 张低分辨率截图`)

  step('5. 【A】服务端确实收到了这批截图并给出结论')
  const insights = await waitFor(async () => {
    const r = await api('GET', `/insights?deviceId=${deviceId}`, { token })
    return r.items?.length > 0 ? r : null
  }, 120_000, 4000)
  check(Boolean(insights), '服务端生成了洞察记录')
  if (insights) {
    const insight = insights.items[0]
    console.log(`    provider=${insight.provider}  summary=${insight.summary}`)
    check(insight.frameCount >= 2, `该批包含 ${insight.frameCount} 帧`)
    check(String(insight.summary).length > 0, '有中文总结')
    check(insight.activities?.length > 0, '识别出活动片段')
  }

  // ---------- B. 锁定复核 ----------
  // 需求原话：「每隔几秒钟核实一下锁屏状态，如果在锁屏状态但屏幕被打开了，
  // 就再锁一次」。分三段测，顺序是**由弱到强**：
  //   6) 最弱：没有悬浮窗权限、也没有设备管理器 —— 只剩一个 Activity 锁定页
  //   7) 恢复悬浮窗权限并激活设备管理器 —— 升级为按 Home 也切不走的全屏悬浮窗
  //   8) 锁定期间点亮屏幕 —— 必须被立刻重新锁上
  //
  // 顺序不能反：设备管理器一激活，lockNow() 就会把屏幕关掉，
  // 那时候再按 Home 是落在熄屏上的，什么都不会发生（实测踩过）。
  const isOwner = deviceOwner()
  const tier = isOwner ? '设备所有者（Kiosk）' : '普通应用（悬浮窗 / 锁定页）'
  console.log(`  能力档 ${tier}`)

  step('6. 【B】最弱路径：没有悬浮窗权限，也没有设备管理器')
  if (isOwner) {
    ok('跳过：本机已设为设备所有者，Kiosk 档下不存在「只剩 Activity 锁定页」这条最弱路径')
  } else {
    must('shell', 'appops', 'set', PKG, 'SYSTEM_ALERT_WINDOW', 'deny')
    ok('已撤销悬浮窗权限（模拟孩子收走了这个权限）')

    await api('PUT', `/lock-policy?deviceId=${deviceId}`, {
      token, body: { strength: 'kiosk', countdownSeconds: 0, scheduleEnabled: false },
    })
    await api('POST', `/device/lock?deviceId=${deviceId}`, { token, body: { locked: true } })

    // 判定只用日志，不用窗口焦点：没有设备管理器时锁定页确实是唯一的前台界面，
    // 但焦点判断会被「锁屏页刚好在重启」这类瞬间状态干扰，日志更确定。
    const startedAtAll = await waitFor(async () => lockStartCount() > 0 && 'started', 60_000, 2500)
    check(Boolean(startedAtAll),
      '无悬浮窗权限时，系统确实受理了锁定页的启动（不是被后台启动限制静默丢弃）',
      agentLog(30).slice(-300))
    check(/经无障碍服务拉起锁定页/.test(agentLog(200)),
      '日志证明走的是无障碍服务降级路径（不是应用上下文硬起）')

    const startsBefore = lockStartCount()
    must('shell', 'input', 'keyevent', 'KEYCODE_HOME')

    // 两条腿都算数，而且通常是无障碍看门狗先出手：
    //   看门狗走无障碍事件（几十毫秒级），复核器走 3 秒周期 —— 前者快得多。
    // 所以断言「至少有一条腿发现并把页面拉回来」，而不是硬要求是复核器干的。
    // 只要有一条出手，锁定就没有被真的绕开。
    const escapedThenRecovered = await waitFor(async () => {
      const log = agentLog(300)
      const noticed = /策略要求锁定，但实际未锁住/.test(log)
          || /看门狗：检测到「[^」]*」抢到前台，正在把锁定界面拉回来/.test(log)
      if (!noticed) return false
      return lockStartCount() > startsBefore && 'recovered'
    }, 45_000, 2000)
    const logNow = agentLog(300)
    const byWatchdog = /看门狗：检测到「[^」]*」抢到前台，正在把锁定界面拉回来/.test(logNow)
    const byReassertor = /策略要求锁定，但实际未锁住/.test(logNow)
    check(Boolean(escapedThenRecovered),
      `Home 把锁定页切走后又被拉了回来（${byWatchdog ? '无障碍看门狗' : ''}`
      + `${byWatchdog && byReassertor ? ' + ' : ''}${byReassertor ? '周期复核器' : ''}出手）`,
      agentLog(40).slice(-400))
    check(byWatchdog || byReassertor,
      '确实打出了「锁定界面被抢走」的判定日志（不是靠巧合）')
  }

  step('7. 【B】接入最强手段：悬浮窗权限 / 设备所有者')
  await api('POST', `/device/temp-unlock?deviceId=${deviceId}`, { token, body: { minutes: 30 } })
  await sleep(5000)
  must('shell', 'appops', 'set', PKG, 'SYSTEM_ALERT_WINDOW', 'allow')
  if (!isOwner) {
    must('shell', 'dpm', 'set-active-admin', `${PKG}/.capability.AgentAdminReceiver`)
  }
  ok(`已恢复悬浮窗权限${isOwner ? '' : '并激活设备管理器'}`)

  await api('POST', `/device/lock?deviceId=${deviceId}`, { token, body: { locked: true } })
  const lockedNow = await waitFor(async () => lockUiUp(isOwner) && 'locked', 90_000, 3000)
  check(Boolean(lockedNow),
    isOwner
      ? '已进入 Kiosk 锁定（Lock Task，系统级，没有绕法）'
      : '已进入全屏悬浮窗锁定（按 Home 与最近任务都切不走）',
    agentLog(30).slice(-300))

  step('8. 【B】锁屏期间点亮屏幕，锁定界面必须被立刻重新摆到最前')
  must('shell', 'input', 'keyevent', 'KEYCODE_SLEEP')
  await sleep(2500)

  must('shell', 'input', 'keyevent', 'KEYCODE_WAKEUP')
  // 亮屏这一刻复核器必须出手：无条件把锁定界面重新摆到最前。
  // 这里刻意不断言「屏幕又被关掉」—— 关屏会让孩子连「为什么被锁」和答题入口都看不到，
  // 属于自伤（详见 LockReassertor 里的注释）。要断言的是「锁定界面在，且复核器确实出手了」。
  const reassertedOnWake = await waitFor(async () =>
    /锁定复核（[^）]*）：屏幕被点亮，重新把锁定界面摆回最前/.test(agentLog(200)) && 'reasserted',
  40_000, 2000)
  check(Boolean(reassertedOnWake), '复核器在亮屏那一刻出手了', agentLog(30).slice(-300))
  check(lockUiUp(isOwner), '锁定界面仍然挂在最前（亮屏没有让它失效）')
  check(wakefulness() === 'Awake', '屏幕保持点亮 —— 孩子能看到被锁的原因和答题入口')

  step('9. 清理')
  // 清理失败不该把前面几十项结果一起吞掉，所以逐条容错并说清哪一步没做成
  let cleanupFailures = 0
  for (const [label, fn] of [
    ['关闭截屏', () => api('PUT', `/screen-monitor?deviceId=${deviceId}`,
      { token, body: { captureEnabled: false } })],
    ['临时解锁 120 分钟', () => api('POST', `/device/temp-unlock?deviceId=${deviceId}`,
      { token, body: { minutes: 120 } })],
    ['删除验证设备', () => api('DELETE', `/devices/${deviceId}`, { token })],
  ]) {
    try {
      await fn()
    } catch (e) {
      cleanupFailures++
      bad(`清理步骤「${label}」失败`, e.message)
    }
  }
  must('shell', 'appops', 'set', PKG, 'SYSTEM_ALERT_WINDOW', 'allow')
  adb('shell', 'rm', '-rf', `/data/data/${PKG}/cache`)
  // 把屏幕采集的系统授权框关掉再走：它是 systemui 的界面，
  // 会一直留到下一轮联调、盖住应用主界面，让「主界面已渲染」这类断言稳定失败。
  for (let i = 0; i < 3; i++) {
    const out = shell('dumpsys activity activities') || ''
    const top = out.split('\n').find((l) => l.includes('topResumedActivity')) || ''
    if (!/systemui|MediaProjection|ProjectionConsentActivity/i.test(top)) break
    adb('shell', 'input', 'keyevent', 'KEYCODE_BACK')
    await sleep(800)
  }
  if (cleanupFailures === 0) ok('已关闭截屏、解锁并删除验证设备，悬浮窗权限已恢复')

  console.log(`\n\x1b[1m结果：${passed} 项通过，${failed} 项失败\x1b[0m`)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error(`\n\x1b[31m验证中断：${e.message}\x1b[0m`)
  process.exit(1)
})
