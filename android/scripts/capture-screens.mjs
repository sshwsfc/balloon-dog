#!/usr/bin/env node
/**
 * 把关键界面截成图片，用于人工确认视觉效果。
 *
 * 联调脚本（e2e-agent.mjs）回答的是「功能对不对」，这个脚本回答的是「看起来对不对」——
 * 倒计时悬浮窗、锁定页这类界面光靠断言看不出好坏，必须真的看一眼。
 *
 * 用法：
 *   node android/scripts/capture-screens.mjs
 * 产物：
 *   android/docs/screenshots/*.png
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ANDROID_DIR = resolve(HERE, '..')
const OUT_DIR = resolve(ANDROID_DIR, 'docs/screenshots')

const API_BASE = process.env.API_BASE || 'http://localhost:4000/api'
const PKG = 'com.balloondog.agent'
const HOME = process.env.HOME || ''
const ADB = process.env.ADB || `${HOME}/Library/Android/sdk/platform-tools/adb`

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

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
  const out = adb('shell', 'dumpsys', 'window', 'windows').text || ''
  const focused = new RegExp(`mCurrentFocus=Window\\{[^}]*${title}[^}]*\\}`).test(out)
  const active = new RegExp(`Window #[0-9]+ Window\\{[^}]*${title}[^}]*\\}`).test(out)
  return focused || active
}

const SERIAL = resolveSerial()

function adb(...args) {
  const r = spawnSync(ADB, SERIAL ? ['-s', SERIAL, ...args] : args,
    { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 })
  return { code: r.status, out: (r.stdout || Buffer.alloc(0)), text: (r.stdout || Buffer.alloc(0)).toString('utf8') }
}

function shell(cmd) {
  return adb('shell', cmd).text.trim()
}

/** 截一张图存成 PNG。必须先唤醒屏幕：关屏时 screencap 只能拿到黑图/失败。 */
function screenshot(name) {
  adb('shell', 'input', 'keyevent', 'KEYCODE_WAKEUP')
  const result = adb('exec-out', 'screencap', '-p')
  const buffer = result.out
  // 校验 PNG 魔数，避免把错误信息当成图片存下来
  const isPng = buffer.length > 8 && buffer[0] === 0x89 && buffer[1] === 0x50
  if (!isPng) {
    console.log(`  ✗ ${name}：截图失败（未拿到 PNG 数据）`)
    return false
  }
  const file = resolve(OUT_DIR, `${name}.png`)
  writeFileSync(file, buffer)
  console.log(`  ✓ ${name}.png  (${Math.round(buffer.length / 1024)} KB)`)
  return true
}

async function api(method, path, { body, token } = {}) {
  const headers = {}
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  if (token) headers.Authorization = `Bearer ${token}`
  const res = await fetch(`${API_BASE}${path}`, {
    method, headers, body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let parsed = null
  try { parsed = text ? JSON.parse(text) : null } catch { parsed = text }
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${parsed?.message || ''}`)
  return parsed
}

function prefValue(key) {
  const out = adb('shell', 'run-as', PKG, 'cat', 'shared_prefs/balloon_dog_agent_prefs.xml').text
  const m = out.match(new RegExp(`name="${key}">([^<]*)<`))
  return m ? m[1] : null
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

const fmtMinute = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`

async function main() {
  mkdirSync(OUT_DIR, { recursive: true })
  console.log('气球狗 · 界面效果截图\n')

  // ---- 1. 设备就绪 ----
  const code = prefValue('device_code')
  if (!code) {
    console.error('设备尚未注册。请先打开一次 App 并点「启动守护」。')
    process.exit(1)
  }
  console.log(`设备码 ${code}`)

  const login = await api('POST', '/auth/login', {
    body: { phone: '13800138000', password: 'balloon123' },
  })
  const token = login.token
  const devices = await api('GET', '/devices', { token })
  let device = devices.devices.find((d) => d.deviceCode === code)
  if (!device) {
    const bound = await api('POST', '/devices/bind', {
      token, body: { deviceCode: code, name: '界面截图设备' },
    })
    device = bound.device
  }
  console.log(`deviceId ${device.id}\n`)

  // ---- 2. 主界面 ----
  console.log('截图中：')
  adb('shell', 'am', 'start', '-n', `${PKG}/.ui.MainActivity`)
  await sleep(3500)
  screenshot('01-main')

  // ---- 3. 倒计时悬浮窗 ----
  // 预告 120 秒、规则设在 3 分钟后，这样有充足时间拍到悬浮窗
  await api('PUT', `/lock-policy?deviceId=${device.id}`, {
    token, body: { strength: 'kiosk', countdownSeconds: 120, scheduleEnabled: true },
  })
  // 先清空既有规则，避免干扰
  const existing = await api('GET', `/schedules?deviceId=${device.id}`, { token })
  for (const r of existing.schedules) {
    await api('DELETE', `/schedules/${r.id}?deviceId=${device.id}`, { token })
  }
  await api('POST', `/device/lock?deviceId=${device.id}`, { token, body: { locked: false } })

  const now = new Date()
  const nowMinute = now.getHours() * 60 + now.getMinutes()
  const rule = await api('POST', `/schedules?deviceId=${device.id}`, {
    token,
    body: {
      name: '睡觉时间', action: 'lock', daysOfWeek: [now.getDay()],
      startMinute: nowMinute + 3, endMinute: Math.min(1440, nowMinute + 15),
    },
  })
  console.log(`  已建规则 ${fmtMinute(rule.schedule.startMinute)} 起锁定，预告 120 秒`)

  // 重启一次让设备立刻取到新规则（否则要等 60 秒的配置轮询）
  const pid = shell(`pidof ${PKG}`)
  if (pid) adb('shell', 'kill', '-9', pid)
  await waitFor(async () => shell(`pidof ${PKG}`), 60_000)

  const overlayWindow = () => windowAttached('balloon-countdown')
  const lockOverlayWindow = () => windowAttached('balloon-lock-overlay')
  const lockTaskState = () => {
    const m = adb('shell', 'dumpsys', 'activity', 'activities').text.match(/mLockTaskModeState=(\w+)/)
    return m ? m[1] : 'UNKNOWN'
  }
  /** 是否处于锁定：设备所有者走 kiosk，其余走全屏悬浮窗，两条都要认 */
  const isLockedNow = () => lockTaskState() === 'LOCKED' || lockOverlayWindow()

  const gotOverlay = await waitFor(async () => overlayWindow(), 300_000, 2500)
  if (gotOverlay) {
    // 悬浮窗刚出现时先拍一张，过一会儿再拍一张，展示倒计时在走
    await sleep(1500)
    screenshot('02-countdown-overlay')
    await sleep(20_000)
    screenshot('03-countdown-overlay-counting')
  } else {
    console.log('  ✗ 未观察到倒计时悬浮窗')
  }

  // ---- 4. 锁定页 ----
  const locked = await waitFor(async () => isLockedNow(), 240_000, 2500)
  if (locked) {
    await sleep(2500)
    screenshot('04-kiosk-lock-screen')
  } else {
    console.log('  ✗ 未进入锁定')
  }

  // ---- 5. 关键行为：按 Home 键能不能把锁定界面切走？----
  //    这正是「全屏悬浮窗」与「Activity 遮罩」的分水岭，必须实测而不是靠推理。
  if (locked) {
    adb('shell', 'input', 'keyevent', 'KEYCODE_HOME')
    await sleep(3000)
    const stillKiosk = lockTaskState() === 'LOCKED'
    const overlayAttached = lockOverlayWindow()
    const lockPageOnTop = (adb('shell', 'dumpsys', 'activity', 'activities').text || '').includes('LockScreenActivity')
    const held = stillKiosk || overlayAttached || lockPageOnTop
    console.log(`  按 Home 后：kiosk=${lockTaskState()} 悬浮窗=${overlayAttached ? '在' : '无'} 锁定页=${lockPageOnTop ? '在' : '无'}`)
    if (overlayAttached || stillKiosk) {
      console.log('  ✓ 锁定界面仍在最前（Home 键切不走）')
      screenshot('05-lock-survives-home')
    } else if (lockPageOnTop) {
      console.log('  ⚠ 锁定页仍在，但它只是 Activity：换成无设备所有者环境时会退化为全屏悬浮窗')
      screenshot('05-lock-survives-home')
    } else {
      console.log('  ✗ 锁定界面被 Home 键切走了')
    }
  }

  // ---- 6. 解锁并清理 ----
  await api('POST', `/device/temp-unlock?deviceId=${device.id}`, { token, body: { minutes: 120 } })
  await waitFor(async () => !isLockedNow(), 90_000, 2500)
  await api('DELETE', `/schedules/${rule.schedule.id}?deviceId=${device.id}`, { token })
  await api('PUT', `/lock-policy?deviceId=${device.id}`, {
    token, body: { strength: 'kiosk', countdownSeconds: 30, scheduleEnabled: false },
  })
  await api('DELETE', `/devices/${device.id}`, { token })
  console.log('\n已解锁并清理测试设备。')

  // ---- 7. 界面树（悬浮窗的文字内容，便于核对文案） ----
  console.log('\n提示：悬浮窗期间可用以下命令查看它的实际文字：')
  console.log(`  adb shell uiautomator dump /sdcard/ui.xml && adb shell cat /sdcard/ui.xml | tr '>' '\\n' | grep 锁定`)
}

main().catch((e) => {
  console.error(`\n截图失败：${e.message}`)
  process.exit(1)
})
