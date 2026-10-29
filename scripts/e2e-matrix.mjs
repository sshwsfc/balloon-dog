#!/usr/bin/env node
/**
 * 端到端自动化测试执行器（总纲见 docs/PLAN-e2e-automation.md）。
 *
 * 它只做四件事：按层串行编排已有套件、准备各层需要的环境变量、核对每个套件的断言数
 * 不低于基线、把结果写成 report.json + summary.md。它不复刻任何一条断言 —— 每个用例
 * 仍然落在 `npm run server:e2e:*` / `npm run e2e:*` / `npm run android:e2e*` 上，
 * 这样单套件照样可以被人手工复跑、出问题时能原地调试。
 *
 * 用法：
 *   node scripts/e2e-matrix.mjs --list
 *   node scripts/e2e-matrix.mjs --dry-run --only=contract
 *   node scripts/e2e-matrix.mjs --only=static,ui
 *   node scripts/e2e-matrix.mjs --only=contract --filter=payments,tickets
 *   node scripts/e2e-matrix.mjs --only=device --serial=emulator-5554
 *   node scripts/e2e-matrix.mjs --only=matrix --boot --keep-emulator
 *
 * 退出码：0 全绿；1 有失败（含断言数低于基线）；2 前置不满足（什么都没跑）。
 *
 * ⚠️ 串行是刻意的：四套浏览器套件共用一个 CDP 端口，设备套件会抢 adb 与前台，
 * 并发跑出来的红色几乎都是假的（见总纲 §2.2 与 §7）。
 */
import { spawn } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const MATRIX_FILE = join(ROOT, 'scripts/device-matrix.json')

// ── 参数 ────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = { only: null, filter: null, profile: null, serial: null, artifacts: null }
  for (const arg of argv) {
    if (arg === '--list') out.list = true
    else if (arg === '--dry-run') out.dryRun = true
    else if (arg === '--boot') out.boot = true
    else if (arg === '--keep-emulator') out.keepEmulator = true
    else if (arg === '--skip-preflight') out.skipPreflight = true
    else if (arg.startsWith('--only=')) out.only = arg.slice(7)
    else if (arg.startsWith('--filter=')) out.filter = arg.slice(9)
    else if (arg.startsWith('--profile=')) out.profile = arg.slice(10)
    else if (arg.startsWith('--serial=')) out.serial = arg.slice(9)
    else if (arg.startsWith('--device-suites=')) out.deviceSuites = arg.slice(16)
    else if (arg.startsWith('--avd=')) out.avd = arg.slice(6)
    else if (arg.startsWith('--artifacts=')) out.artifacts = arg.slice(12)
    else if (arg.startsWith('--timeout=')) out.timeout = Number(arg.slice(10))
    else if (arg === '--help' || arg === '-h') out.help = true
    else {
      console.error(`未知参数：${arg}（用 --help 看用法）`)
      process.exit(2)
    }
  }
  return out
}

const args = parseArgs(process.argv.slice(2))

function usage() {
  console.log(`端到端自动化测试执行器

  --list                 列出所有层、套件与机型档
  --dry-run              只打印将要执行的命令与需要的环境变量
  --only=a,b,c           只跑指定层：static / contract / ui / device / matrix
  --filter=x,y           只跑名字里包含这些词的套件（配合 --only）
  --profile=<id>         device/matrix 层只跑指定机型档（见 device-matrix.json）
  --device-suites=a,b    设备层只跑这些套件：agent / gaps / mode / screen
  --avd=<name>           --boot 时用这个 AVD 名（覆盖机型档里的 avd）
  --serial=<serial>      指定 adb 设备（等价于 ANDROID_SERIAL）
  --boot                 需要起 AVD 时自动 boot（跑完 adb emu kill，除非 --keep-emulator）
  --keep-emulator        跑完不关 AVD
  --skip-preflight       跳过前置检查（不推荐：会让失败归因失真）
  --artifacts=<dir>      产物根目录，默认 artifacts/e2e
  --timeout=<ms>         单个套件超时，默认 1200000（20 分钟）

环境变量：APP_URL / CHROME_PATH / API_BASE / ADB / ANDROID_SERIAL /
         PARENT_PHONE / PARENT_PASSWORD / ADMIN_USER / ADMIN_PASS
`)
}

// ── 套件清单 ────────────────────────────────────────────────────────────

/**
 * expected 是断言数基线：实际数低于它判 FAIL —— 「数字不涨就是跌」，
 * 通常是有人删了断言或提前退出，而不是真的修好了。没有基线的套件只要求退出 0。
 */
const STATIC_SUITES = [
  { name: 'build', cmd: ['npm', 'run', 'build'], timeoutMs: 300_000 },
  { name: 'lint', cmd: ['npm', 'run', 'lint'], timeoutMs: 300_000, expect: /(\d+) problems/ },
  { name: 'i18n:coverage', cmd: ['npm', 'run', 'i18n:coverage'], timeoutMs: 180_000 },
  { name: 'server:typecheck', cmd: ['npm', 'run', 'server:typecheck'], timeoutMs: 300_000 },
  { name: 'server-lint', cmd: ['npm', '--prefix', 'server', 'run', 'lint'], timeoutMs: 300_000 },
  { name: 'android:crosstest', cmd: ['npm', 'run', 'android:crosstest'], timeoutMs: 600_000 },
]

const CONTRACT_SUITES = [
  { name: 'server:smoke', expected: 167, needsBackend: true, timeoutMs: 900_000 },
  { name: 'server:e2e:device-members', expected: 67, needsBackend: true },
  { name: 'server:e2e:children', expected: 74, needsBackend: true },
  { name: 'server:e2e:privacy', expected: 76, needsBackend: true },
  { name: 'server:e2e:notifications', expected: 69, needsBackend: true },
  { name: 'server:e2e:health', expected: 91, needsBackend: true },
  { name: 'server:e2e:time-requests', expected: 73, needsBackend: true },
  { name: 'server:e2e:child-home', expected: 43, needsBackend: true },
  { name: 'server:e2e:membership', expected: 180, needsBackend: true },
  { name: 'server:e2e:referral', expected: 159, needsBackend: true },
  { name: 'server:e2e:icons', expected: 32, needsBackend: true },
  { name: 'server:e2e:mode', needsBackend: true },
  { name: 'server:e2e:insights', needsBackend: true },
  { name: 'server:e2e:ai', needsBackend: true },
  // 以下四套自己 spawn 后端（端口 4102/4103/4104/4105），不需要 :4000 在跑。
  { name: 'server:e2e:payments', expected: 82, spawnsBackend: 4102 },
  { name: 'server:e2e:flags', expected: 45, spawnsBackend: 4103 },
  { name: 'server:e2e:alerts', expected: 65, spawnsBackend: 4104 },
  { name: 'server:e2e:tickets', expected: 69, spawnsBackend: 4105 },
  { name: 'server:e2e:wechat', expected: 52, spawnsBackend: 4101 },
]

const UI_SUITES = [
  { name: 'e2e:ux', expected: 134, needsBackend: true, needsPreview: true },
  // 响应式套件是把 5 档视口 × 27 个页面的检查聚合成一条总结，没有稳定的「项数」基线，
  // 所以只要求退出 0；它需要后端放宽限流（RATE_LIMIT_MAX），否则会假红。
  { name: 'e2e:responsive', needsBackend: true, needsPreview: true, needsRateLimit: true },
  // 家长端套件的项数**随数据变化**：数据库里没有已绑定设备时是 109 项，有设备时 120 项
  // （依赖设备的小节会少掉几条）。所以这里不设硬基线，只以「套件自己报全部通过」为准；
  // 设成 120 会在干净库上假红 —— 实测踩过。
  { name: 'e2e:parent', needsBackend: true, needsPreview: true },
  { name: 'e2e:admin', expected: 80, needsBackend: true, needsPreview: true },
]

const DEVICE_SUITES = [
  { key: 'agent', script: 'android:e2e', label: '主链路', expected: 86 },
  { key: 'gaps', script: 'android:e2e:gaps', label: '差异功能' },
  { key: 'mode', script: 'android:e2e:mode', label: '模式与护眼' },
  { key: 'screen', script: 'android:e2e:screen', label: '屏幕采样' },
]

// ── 小工具 ──────────────────────────────────────────────────────────────

const ANSI = /\u001b\[[0-9;]*m/g
const stripAnsi = (s) => s.replace(ANSI, '')

const c = {
  gray: (s) => `\u001b[90m${s}\u001b[0m`,
  green: (s) => `\u001b[32m${s}\u001b[0m`,
  red: (s) => `\u001b[31m${s}\u001b[0m`,
  yellow: (s) => `\u001b[33m${s}\u001b[0m`,
  bold: (s) => `\u001b[1m${s}\u001b[0m`,
}

function section(title) {
  console.log('\n' + c.bold('── ' + title + ' ' + '─'.repeat(Math.max(0, 60 - title.length))))
}

function nodeBin() {
  return process.execPath
}

function npmCmd() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm'
}

function resolveCmd(cmd) {
  const [bin, ...rest] = cmd
  if (bin === 'npm') return [npmCmd(), ...rest]
  if (bin === 'node') return [nodeBin(), ...rest]
  return [bin, ...rest]
}

function runId() {
  return new Date().toISOString().replace(/[:.]/g, '-').replace('T', 'T')
}

function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

function httpOk(url, timeoutMs = 3000) {
  return fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
    .then((r) => r.ok)
    .catch(() => false)
}

function tcpOk(host, port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const socket = connect({ host, port })
    const done = (ok) => {
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })
}

/** 从 server/.env 的 DATABASE_URL 里取 host/port，用来判断库在不在。 */
function databaseTarget() {
  const envFile = join(ROOT, 'server/.env')
  const fallback = { host: '127.0.0.1', port: 5433 }
  if (!existsSync(envFile)) return fallback
  const line = readFileSync(envFile, 'utf8')
    .split('\n')
    .find((l) => l.trim().startsWith('DATABASE_URL='))
  if (!line) return fallback
  const url = line.slice('DATABASE_URL='.length).trim().replace(/^["']|["']$/g, '')
  try {
    const parsed = new URL(url)
    return { host: parsed.hostname || fallback.host, port: Number(parsed.port) || 5432 }
  } catch {
    return fallback
  }
}

function adbPath() {
  return process.env.ADB || join(process.env.HOME || '', 'Library/Android/sdk/platform-tools/adb')
}

function adbDevices() {
  return new Promise((resolve) => {
    if (!existsSync(adbPath())) return resolve([])
    const child = spawn(adbPath(), ['devices'], { stdio: ['ignore', 'pipe', 'ignore'] })
    let buf = ''
    child.stdout.on('data', (d) => (buf += String(d)))
    child.on('close', () => {
      const list = buf
        .split('\n')
        .slice(1)
        .map((l) => l.trim().split(/\s+/))
        .filter((p) => p[0] && p[1] === 'device')
        .map((p) => p[0])
      resolve(list)
    })
    child.on('error', () => resolve([]))
  })
}

function emulatorPath() {
  const candidates = [
    process.env.EMULATOR,
    process.env.ANDROID_HOME && join(process.env.ANDROID_HOME, 'emulator/emulator'),
    process.env.ANDROID_SDK_ROOT && join(process.env.ANDROID_SDK_ROOT, 'emulator/emulator'),
    join(process.env.HOME || '', 'Library/Android/sdk/emulator/emulator'),
  ].filter(Boolean)
  return candidates.find((p) => existsSync(p)) || null
}

/** 解析各套件的「通过数」。四套脚本的输出格式不同，但都带百分比式总结。 */
function parseCounts(text) {
  const clean = stripAnsi(text)
  // 同一个脚本可能打多段总结（例如交叉测试逐节汇报），取**最后一段**才是总数。
  const last = (re, pick) => {
    const all = [...clean.matchAll(re)]
    if (!all.length) return null
    return pick(all[all.length - 1])
  }
  const passFail = last(/(\d+)\s*项通过\s*[ /，,]\s*(\d+)\s*项失败/g, (m) => ({
    pass: Number(m[1]),
    fail: Number(m[2]),
  }))
  if (passFail) return passFail
  const failPass = last(/失败\s*(\d+)\s*项\s*[·,，]\s*通过\s*(\d+)\s*项/g, (m) => ({
    pass: Number(m[2]),
    fail: Number(m[1]),
  }))
  if (failPass) return failPass
  const allPass = last(/全部通过\s*[：:（(]\s*(\d+)\s*项/g, (m) => ({ pass: Number(m[1]), fail: 0 }))
  if (allPass) return allPass
  return { pass: null, fail: null }
}

/** 静态层的 lint 有 23 个 error 的历史基线：只允许持平，不允许增长。 */
const LINT_BASELINE = 23

function lintProblems(text) {
  const m = stripAnsi(text).match(/(\d+)\s+problems?\s*\((\d+)\s+errors?/)
  return m ? { problems: Number(m[1]), errors: Number(m[2]) } : null
}

// ── 执行 ────────────────────────────────────────────────────────────────

async function runSuite(suite, logDir, extraEnv = {}) {
  const name = suite.name
  const cmd = suite.cmd ?? [npmCmd(), 'run', name]
  const [bin, ...rest] = resolveCmd(cmd)
  const logPath = join(logDir, (suite.layer || 'suite') + '-' + name.replace(/[^a-z0-9]+/gi, '-') + '.log')
  const log = createWriteStream(logPath)
  const env = { ...process.env, ...(suite.env || {}), ...extraEnv }
  const timeoutMs = suite.timeoutMs ?? args.timeout ?? 1_200_000

  const startedAt = Date.now()
  const result = await new Promise((resolve) => {
    const child = spawn(bin, rest, { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    const onData = (d) => {
      const text = String(d)
      out += text
      log.write(text)
      if (out.length > 400_000) out = out.slice(-300_000)
      process.stdout.write(text)
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      resolve({ code: 124, out, timeout: true })
    }, timeoutMs)
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code: code ?? 1, out })
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ code: 127, out: out + '\n' + error.message })
    })
  })
  log.end()

  const counts = parseCounts(result.out)
  const durationMs = Date.now() - startedAt
  const failures = stripAnsi(result.out)
    .split('\n')
    .filter((l) => /失败|FAIL|✗|Error:|异常中断|未捕获/.test(l) && !/0\s*项失败/.test(l))
    .slice(0, 12)

  let status = result.code === 0 ? 'PASS' : 'FAIL'
  const notes = []
  if (result.timeout) notes.push(`超时（${Math.round(timeoutMs / 1000)}s）`)

  if (suite.layer === 'static' && name === 'lint') {
    // 前端 lint 有 23 个历史遗留 error，`eslint .` 永远退出 1，所以这里不看退出码，
    // 只看「有没有比基线更多」——基线只许持平，不许增长（总纲 §9.3）。
    const lintCounts = lintProblems(result.out)
    if (lintCounts) {
      counts.pass = lintCounts.problems
      if (lintCounts.problems > LINT_BASELINE) {
        status = 'FAIL'
        notes.push(`lint 从基线 ${LINT_BASELINE} 增长到 ${lintCounts.problems}`)
      } else {
        status = 'PASS'
        notes.push(`基线 ${LINT_BASELINE} 个 error（历史遗留，只允许持平）`)
      }
    } else {
      status = 'FAIL'
      notes.push('没解析出 lint 的 problems 计数，无法判断是否增长')
    }
  }
  if (status === 'PASS' && suite.expected && counts.pass != null && counts.pass < suite.expected) {
    status = 'FAIL'
    notes.push(`断言数 ${counts.pass} 低于基线 ${suite.expected}（被删断言或提前退出？）`)
  }

  const entry = {
    layer: suite.layer,
    name,
    status,
    count: counts.pass,
    expected: suite.expected ?? null,
    durationMs,
    log: logPath,
    failures: status === 'FAIL' ? failures : [],
    notes,
  }
  const icon = status === 'PASS' ? c.green('✓') : c.red('✗')
  const countText = counts.pass != null ? ` · ${counts.pass} 项` : ''
  console.log(`${icon} ${name}${countText} ${c.gray(`(${(durationMs / 1000).toFixed(1)}s)`)}`)
  for (const note of notes) console.log(`   ${c.yellow('· ' + note)}`)
  return entry
}

// ── 前置检查 ────────────────────────────────────────────────────────────

async function preflight(layers, profiles) {
  const env = {}
  let blocked = false

  const needsDb = ['contract', 'ui', 'device', 'matrix'].some((l) => layers.has(l))
  if (needsDb) {
    const db = databaseTarget()
    env.db = await tcpOk(db.host, db.port)
    if (!env.db) {
      console.log(c.red(`✗ 数据库连不上：${db.host}:${db.port}（npm run db:up）`))
      blocked = true
    } else {
      console.log(c.gray(`· 数据库 ${db.host}:${db.port} 可达`))
    }
  }

  env.backend = await httpOk('http://127.0.0.1:4000/health')
  if (layers.has('contract') || layers.has('ui') || layers.has('device') || layers.has('matrix')) {
    if (!env.backend) {
      console.log(c.red('✗ 后端 :4000 不可用（npm run server:dev）'))
      blocked = true
    } else console.log(c.gray('· 后端 :4000 可用'))
  }

  if (layers.has('ui')) {
    env.preview = await httpOk('http://127.0.0.1:2727/')
    if (!env.preview) {
      console.log(c.red('✗ 前端 :2727 不可用（npm run build && npm run preview）'))
      blocked = true
    } else console.log(c.gray('· 前端 :2727 可用'))
  }

  if (layers.has('device') || layers.has('matrix')) {
    env.devices = await adbDevices()
    env.apk = existsSync(join(ROOT, 'android/app/build/outputs/apk/debug/app-debug.apk'))
    if (!env.devices.length && !args.boot) {
      console.log(c.red('✗ 没有可用的 adb 设备（起模拟器，或用 --boot 自动起 AVD）'))
      blocked = true
    } else if (env.devices.length) {
      console.log(c.gray(`· adb 设备：${env.devices.join(', ')}`))
    }
    if (!env.apk) {
      console.log(c.red('✗ APK 不存在（npm run android:build）'))
      blocked = true
    } else console.log(c.gray('· APK 已构建'))
  }

  if (layers.has('ui')) {
    console.log(
      c.yellow(
        '· 提醒：e2e:responsive 会做 90 次整页刷新，限流太紧（RATE_LIMIT_MAX < 1000）时 429 会伪装成「已登出」；本机 3000 实测够用',
      ),
    )
  }

  if (profiles?.length) {
    for (const p of profiles) {
      if (p.kind === 'physical') {
        console.log(c.yellow(`· 机型 ${p.id} 是真机档：确认已连着 adb、已设设备所有者（见总纲 §6）`))
      }
    }
  }

  return { env, blocked }
}

// ── AVD 起停 ────────────────────────────────────────────────────────────

/** 读设备的 API 级别（机型档的核心语义：系统版本，而不是本地 AVD 名字）。 */
function deviceApi(serial) {
  return new Promise((resolve) => {
    const child = spawn(adbPath(), ['-s', serial, 'shell', 'getprop', 'ro.build.version.sdk'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    let buf = ''
    child.stdout.on('data', (d) => (buf += String(d)))
    child.on('close', () => resolve(buf.trim()))
    child.on('error', () => resolve(''))
  })
}

async function waitBoot(serial, timeoutMs = 180_000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const ok = await new Promise((resolve) => {
      const child = spawn(adbPath(), ['-s', serial, 'shell', 'getprop', 'sys.boot_completed'], {
        stdio: ['ignore', 'pipe', 'ignore'],
      })
      let buf = ''
      child.stdout.on('data', (d) => (buf += String(d)))
      child.on('close', () => resolve(buf.trim() === '1'))
      child.on('error', () => resolve(false))
    })
    if (ok) return true
    await new Promise((r) => setTimeout(r, 2500))
  }
  return false
}

async function bootAvd(profile) {
  const emulator = emulatorPath()
  if (!emulator) {
    console.log(c.red('✗ 找不到 emulator 可执行文件（设 ANDROID_HOME 或 EMULATOR）'))
    return null
  }
  const existing = await adbDevices()
  if (existing.length) {
    console.log(c.gray(`· 已连着的设备：${existing.join(', ')}，不再起新 AVD`))
    return existing.find((s) => s.startsWith('emulator-')) || existing[0]
  }
  const avd = args.avd || profile.avd
  if (!avd) {
    console.log(c.red(`✗ 机型档 ${profile.id} 没有配置 AVD 名字（用 --avd=<name> 指定）`))
    return null
  }
  console.log(c.gray(`· 起 AVD ${avd}（无头）…`))
  const child = spawn(
    emulator,
    [
      '-avd',
      avd,
      '-no-window',
      '-no-audio',
      '-no-snapshot',
      '-gpu',
      'swiftshader_indirect',
      '-no-boot-anim',
    ],
    { detached: true, stdio: 'ignore' },
  )
  child.unref()
  const serial = 'emulator-5554'
  const booted = await waitBoot(serial)
  if (!booted) {
    console.log(c.red('✗ AVD 在 3 分钟内没 boot 完成'))
    return null
  }
  console.log(c.gray(`· ${serial} 已就绪`))
  return serial
}

function killEmulator(serial) {
  return new Promise((resolve) => {
    const child = spawn(adbPath(), ['-s', serial, 'emu', 'kill'], { stdio: 'ignore' })
    child.on('close', () => resolve())
    child.on('error', () => resolve())
  })
}

// ── 主流程 ──────────────────────────────────────────────────────────────

function loadMatrix() {
  if (!existsSync(MATRIX_FILE)) return []
  const raw = JSON.parse(readFileSync(MATRIX_FILE, 'utf8'))
  return raw.profiles || []
}

function selectedLayers() {
  if (!args.only) return ['static', 'contract', 'ui', 'device']
  return args.only
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

function filterSuites(list) {
  if (!args.filter) return list
  const words = args.filter.split(',').map((s) => s.trim().toLowerCase())
  return list.filter((s) => words.some((w) => s.name.toLowerCase().includes(w)))
}

function printList() {
  const layers = [
    ['static', STATIC_SUITES.map((s) => s.name)],
    ['contract', CONTRACT_SUITES.map((s) => s.name)],
    ['ui', UI_SUITES.map((s) => s.name)],
    ['device', DEVICE_SUITES.map((s) => `${s.script}（${s.label}）`)],
  ]
  for (const [layer, items] of layers) {
    console.log(c.bold(`\n${layer}`) + c.gray(`  ${items.length} 个`))
    for (const item of items) console.log('  ' + item)
  }
  console.log(c.bold('\n机型档') + c.gray('（scripts/device-matrix.json）'))
  for (const p of loadMatrix()) {
    console.log(`  ${p.id}  ${c.gray(`${p.kind} · Android ${p.release} · ${p.label}`)}`)
  }
  console.log('')
}

async function runDeviceLayer(profileList, logDir, results) {
  for (const profile of profileList) {
    section(`设备层 · ${profile.id} · ${profile.label}`)
    let serial = args.serial || process.env.ANDROID_SERIAL
    if (profile.kind === 'emulator' && args.boot && !serial) {
      serial = await bootAvd(profile)
      if (!serial) {
        results.push({
          layer: 'device',
          profile: profile.id,
          name: 'boot',
          status: 'BLOCKED',
          count: null,
          expected: null,
          durationMs: 0,
          log: null,
          failures: [],
          notes: ['AVD 起不来'],
        })
        continue
      }
    }
    if (!serial) {
      const devices = await adbDevices()
      serial = devices.find((s) => s.startsWith('emulator-')) || devices[0]
    }
    // 机型档必须真的是那个档：拿一台 Android 13 的模拟器去跑「Android 14 档」，
    // 报告会写着一份它根本没验证过的结论。所以核对的是 API 级别（profile 的语义），
    // 不是本地的 AVD 名字（那是每台开发机自己的命名习惯）。
    if (profile.kind === 'emulator' && !serial?.startsWith('emulator-')) {
      console.log(c.yellow(`· ${serial} 不是模拟器，跳过模拟器档 ${profile.id}`))
      results.push({
        layer: 'device',
        profile: profile.id,
        name: 'wrong-kind',
        status: 'BLOCKED',
        count: null,
        expected: null,
        durationMs: 0,
        log: null,
        failures: [],
        notes: [`${serial} 是真机，与模拟器档不符`],
      })
      continue
    }
    if (profile.kind === 'emulator' && serial) {
      const actualApi = await deviceApi(serial)
      if (actualApi && profile.apiLevel && Number(actualApi) !== profile.apiLevel) {
        console.log(c.yellow(`· 设备 API ${actualApi}，档位 ${profile.id} 要求 API ${profile.apiLevel}`))
        results.push({
          layer: 'device',
          profile: profile.id,
          name: 'api-mismatch',
          status: 'BLOCKED',
          count: null,
          expected: null,
          durationMs: 0,
          log: null,
          failures: [],
          notes: [`设备 API ${actualApi} 与档位要求的 API ${profile.apiLevel} 不符`],
        })
        continue
      }
    }

    const onlyThese = args.deviceSuites ? args.deviceSuites.split(',').map((x) => x.trim()) : null
    const wanted = DEVICE_SUITES.filter(
      (s) => (profile.suites || ['agent']).includes(s.key) && (!onlyThese || onlyThese.includes(s.key)),
    )
    for (const suite of wanted) {
      const entry = await runSuite(
        {
          name: suite.script,
          cmd: [npmCmd(), 'run', suite.script],
          layer: 'device',
          expected: suite.expected,
          env: {
            ...(serial ? { ANDROID_SERIAL: serial } : {}),
            API_BASE: profile.env?.API_BASE || process.env.API_BASE || 'http://localhost:4000/api',
          },
        },
        logDir,
      )
      entry.profile = profile.id
      if (entry.status === 'PASS' && profile.expectedSkips?.length) {
        entry.notes = [...(entry.notes || []), `预期跳过：${profile.expectedSkips.join('；')}`]
      }
      results.push(entry)
    }

    if (profile.kind === 'emulator' && args.boot && !args.keepEmulator) {
      console.log(c.gray(`· 关闭 ${serial}`))
      await killEmulator(serial)
    }
  }
}

async function main() {
  if (args.help) return usage()
  if (args.list) return printList()

  const id = runId()
  const artifactsRoot = args.artifacts ? join(args.artifacts) : join(ROOT, 'artifacts/e2e')
  const logDir = join(artifactsRoot, id)
  const layers = new Set(selectedLayers().flatMap((l) => (l === 'all' ? ['static', 'contract', 'ui', 'device'] : [l])))
  const matrix = loadMatrix()
  const profiles = matrix.filter((p) => (args.profile ? p.id === args.profile : true))

  for (const layer of selectedLayers()) {
    if (!['static', 'contract', 'ui', 'device', 'matrix', 'all'].includes(layer)) {
      console.error(`未知层：${layer}（可选 static / contract / ui / device / matrix）`)
      process.exit(2)
    }
  }
  if (args.only && selectedLayers().includes('matrix')) {
    layers.delete('matrix')
    layers.add('device')
  }

  if (args.dryRun) {
    section('将要执行（dry-run，不真的跑）')
    const printSuites = (layer, list) => {
      if (!layers.has(layer)) return
      for (const suite of filterSuites(list)) {
        const cmd = (suite.cmd ?? ['npm', 'run', suite.name]).join(' ')
        const expect = suite.expected ? `  基线 ${suite.expected} 项` : ''
        console.log(`  [${layer}] ${cmd}${expect}`)
      }
    }
    printSuites('static', STATIC_SUITES)
    printSuites('contract', CONTRACT_SUITES)
    printSuites('ui', UI_SUITES)
    if (layers.has('device')) {
      const runProfiles = args.profile ? profiles : profiles.filter((p) => p.kind === 'emulator').slice(0, 1)
      for (const profile of runProfiles) {
        const onlyThese = args.deviceSuites ? args.deviceSuites.split(',').map((x) => x.trim()) : null
        const wanted = DEVICE_SUITES.filter(
          (suite) =>
            (profile.suites || ['agent']).includes(suite.key) && (!onlyThese || onlyThese.includes(suite.key)),
        )
        for (const suite of wanted) {
          console.log(
            `  [device] ${profile.id} → npm run ${suite.script}（ANDROID_SERIAL=${args.serial || '自动选一台'}）`,
          )
        }
      }
      if (!runProfiles.length) console.log('  [device] （没有匹配的机型档）')
    }
    console.log(
      c.gray(
        '\n  需要的环境：:4000 后端 · :2727 前端 · 数据库 · adb 设备与 APK；responsive 需限流放宽到千级（本机 3000 够）',
      ),
    )
    return
  }

  if (!args.dryRun) ensureDir(logDir)

  section('前置检查')
  let preflightResult = { env: {}, blocked: false }
  if (!args.skipPreflight) {
    preflightResult = await preflight(layers, layers.has('device') ? profiles : [])
  }
  const { env } = preflightResult
  if (preflightResult.blocked && !args.dryRun) {
    console.log('\n' + c.red('前置不满足，未执行任何套件。'))
    writeFileSync(
      join(logDir, 'report.json'),
      JSON.stringify({ runId: id, blocked: true, environment: env, suites: [] }, null, 2),
    )
    process.exit(2)
  }

  const results = []
  const startedAt = new Date().toISOString()

  if (layers.has('static')) {
    section('L0 静态闸门')
    for (const suite of filterSuites(STATIC_SUITES)) {
      results.push(await runSuite({ ...suite, layer: 'static' }, logDir))
    }
  }

  if (layers.has('contract')) {
    section('L1 服务端契约')
    for (const suite of filterSuites(CONTRACT_SUITES)) {
      // 自己起后端的套件不需要 :4000，但要避开端口占用：串行天然安全。
      results.push(await runSuite({ ...suite, layer: 'contract' }, logDir))
    }
  }

  if (layers.has('ui')) {
    section('L2 界面（浏览器）')
    for (const suite of filterSuites(UI_SUITES)) {
      results.push(await runSuite({ ...suite, layer: 'ui' }, logDir))
    }
  }

  if (layers.has('device')) {
    section('L3 设备端')
    const runProfiles = args.profile
      ? profiles
      : profiles.filter((p) => p.kind === 'emulator').slice(0, 1)
    if (!args.profile) {
      console.log(c.gray(`· 未指定 --profile，默认跑第一档模拟器（可控时长）；全矩阵用 --only=matrix`))
    }
    await runDeviceLayer(runProfiles, logDir, results)
  }

  // 报告
  const passed = results.filter((r) => r.status === 'PASS').length
  const failed = results.filter((r) => r.status === 'FAIL').length
  const skipped = results.filter((r) => r.status === 'SKIP' || r.status === 'BLOCKED').length
  const report = {
    runId: id,
    startedAt,
    finishedAt: new Date().toISOString(),
    command: process.argv.slice(2).join(' '),
    environment: env,
    summary: { pass: passed, fail: failed, skip: skipped },
    suites: results,
  }
  if (!args.dryRun) {
    writeFileSync(join(logDir, 'report.json'), JSON.stringify(report, null, 2))
    const lines = [
      `# E2E 报告 ${id}`,
      '',
      `- 通过 ${passed} · 失败 ${failed} · 跳过/阻塞 ${skipped}`,
      `- 环境：数据库 ${env.db ? '✓' : '✗'} · 后端 ${env.backend ? '✓' : '✗'} · 前端 ${env.preview ? '✓' : '✗'} · adb ${(env.devices || []).join(', ') || '—'}`,
      '',
      '| 层 | 套件 | 状态 | 断言 | 基线 | 耗时 |',
      '| --- | --- | --- | --- | --- | --- |',
      ...results.map(
        (r) =>
          `| ${r.layer} | ${r.name}${r.profile ? `（${r.profile}）` : ''} | ${r.status} | ${r.count ?? '—'} | ${r.expected ?? '—'} | ${(r.durationMs / 1000).toFixed(1)}s |`,
      ),
      '',
    ]
    if (failed) {
      lines.push('## 失败', '')
      for (const r of results.filter((x) => x.status === 'FAIL')) {
        lines.push(`### ${r.name}${r.profile ? `（${r.profile}）` : ''}`, '', '```')
        lines.push(...(r.failures.length ? r.failures : ['（日志里没有识别出失败行，看 ' + r.log + '）']))
        lines.push('```', '')
      }
    }
    if (skipped) {
      lines.push('## 跳过/阻塞', '')
      for (const r of results.filter((x) => x.status !== 'PASS' && x.status !== 'FAIL')) {
        lines.push(`- ${r.name}${r.profile ? `（${r.profile}）` : ''}：${(r.notes || []).join('；') || '—'}`)
      }
      lines.push('')
    }
    writeFileSync(join(logDir, 'summary.md'), lines.join('\n'))
  }

  console.log('\n' + '═'.repeat(64))
  console.log(c.bold(`通过 ${passed} · 失败 ${failed} · 跳过 ${skipped}`))
  console.log(c.gray(`产物：${logDir}`))
  console.log('═'.repeat(64) + '\n')
  process.exit(failed ? 1 : 0)
}

main().catch((error) => {
  console.error(c.red('\n执行器异常中断：') + (error?.message || error))
  process.exit(1)
})
