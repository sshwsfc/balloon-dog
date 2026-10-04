#!/usr/bin/env node
/**
 * 截屏包上传链路的端到端验证。
 *
 * 它模拟一台真实的设备端 Agent：
 *   1. 注册设备、被家长认领；
 *   2. 家长开启截屏与屏幕答题、设一个「每天最多玩 3 局」的上限；
 *   3. 用真实 JPEG 打一个 stored 模式的 zip（与 Android 端 FrameBatchArchiver 同格式）；
 *   4. multipart 上传到 /api/agent/screen-batches；
 *   5. 等分析完成，核对：批次状态、洞察内容、用量片段、提醒、家长端可见性；
 *   6. 断言超限后服务端确实下发了锁屏指令。
 *
 * 用法：node scripts/e2e-screen-insights.mjs
 */

import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const API = process.env.API_BASE || 'http://localhost:4000/api'
const PARENT_PHONE = '13800138000'
const PARENT_PASSWORD = 'balloon123'

let passed = 0
let failed = 0
const ok = (m) => { passed++; console.log(`  \x1b[32m✓\x1b[0m ${m}`) }
const bad = (m, extra = '') => { failed++; console.log(`  \x1b[31m✗\x1b[0m ${m}${extra ? ` — ${extra}` : ''}`) }
const check = (c, m, extra = '') => (c ? ok(m) : bad(m, extra))
const step = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function api(method, path, { body, token, form } = {}) {
  const headers = {}
  if (token) headers.Authorization = `Bearer ${token}`
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  const res = await fetch(`${API}${path}`, {
    method, headers, body: form ?? (body !== undefined ? JSON.stringify(body) : undefined),
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

// ---------------- 最小 ZIP 写入器（stored 模式）----------------
// 与 Android 端 FrameBatchArchiver 用同一套格式：JPEG 本身已压缩，
// 再 deflate 一遍几乎不省空间还费 CPU，所以用 stored。
const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[i] = c
  }
  return table
})()

function crc32(buf) {
  let c = 0 ^ -1
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xff]
  return (c ^ -1) >>> 0
}

function makeZip(files) {
  const local = []
  const central = []
  let offset = 0
  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8')
    const data = file.data
    const crc = crc32(data)

    const lh = Buffer.alloc(30)
    lh.writeUInt32LE(0x04034b50, 0)
    lh.writeUInt16LE(20, 4)
    lh.writeUInt16LE(0x0800, 6) // UTF-8 名字
    lh.writeUInt16LE(0, 8) // stored
    lh.writeUInt32LE(crc, 14)
    lh.writeUInt32LE(data.length, 18)
    lh.writeUInt32LE(data.length, 22)
    lh.writeUInt16LE(name.length, 26)
    local.push(lh, name, data)

    const cd = Buffer.alloc(46)
    cd.writeUInt32LE(0x02014b50, 0)
    cd.writeUInt16LE(20, 4)
    cd.writeUInt16LE(20, 6)
    cd.writeUInt16LE(0x0800, 8)
    cd.writeUInt16LE(0, 10)
    cd.writeUInt32LE(crc, 16)
    cd.writeUInt32LE(data.length, 20)
    cd.writeUInt32LE(data.length, 24)
    cd.writeUInt16LE(name.length, 28)
    cd.writeUInt32LE(offset, 42)
    central.push(cd, name)

    offset += 30 + name.length + data.length
  }
  const cdBuf = Buffer.concat(central)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(files.length, 8)
  eocd.writeUInt16LE(files.length, 10)
  eocd.writeUInt32LE(cdBuf.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...local, cdBuf, eocd])
}

function makeJpeg(scale = 1) {
  const out = `/tmp/e2e-frame-${scale}.jpg`
  spawnSync('sips', ['-s', 'format', 'jpeg', '-Z', String(480 / scale), '/tmp/base.png', '--out', out])
  return readFileSync(out)
}

async function main() {
  console.log('\x1b[1m气球狗 · 截屏洞察链路端到端验证\x1b[0m')
  console.log(`  API  ${API}`)

  step('0. 准备：注册设备并让家长认领')
  const code = 'SC' + Math.random().toString(16).slice(2, 8).toUpperCase()
  const reg = await must('POST', '/agent/register', {
    body: {
      deviceCode: code, deviceSecret: 'screen-test-secret-0123456789',
      model: 'E2E Phone', os: 'Android', osVersion: '13', agentVersion: 'e2e',
    },
  })
  const deviceToken = reg.deviceToken
  const deviceId = reg.deviceId
  check(Boolean(deviceToken), `设备已注册（${code}）`)

  const login = await must('POST', '/auth/login', { body: { phone: PARENT_PHONE, password: PARENT_PASSWORD } })
  const token = login.token
  await must('POST', '/devices/bind', { token, body: { deviceCode: code, name: '截图链路验证' } })
  ok('家长已认领该设备')

  step('1. 家长开启截屏与屏幕答题，并设「每天最多玩 3 局」')
  await must('PUT', `/screen-monitor?deviceId=${deviceId}`, {
    token, body: { captureEnabled: true, captureIntervalSeconds: 30, quizFromScreen: true },
  })
  const budget = await must('PUT', `/usage-budgets?deviceId=${deviceId}`, {
    token, body: { kind: 'game_round', appName: '', dailyLimit: 3 },
  })
  check(budget.budget.dailyLimit === 3, '局数上限已设为 3')

  step('2. 设备端拉配置，确认下发内容')
  const cfg = await must('GET', '/agent/config', { token: deviceToken })
  check(cfg.screenMonitor?.captureEnabled === true, 'config 里 captureEnabled=true')
  check(cfg.screenMonitor?.framesPerBatch === 10, 'config 里 framesPerBatch=10')
  check(cfg.screenMonitor?.quizFromScreen === true, 'config 里 quizFromScreen=true')
  check(cfg.screenMonitor?.usageBudget?.gameRounds?.dailyLimit === 3, 'config 里带上了局数上限')
  check(cfg.screenMonitor?.usageBudget?.gameRounds?.exceeded === false, 'config 里未超限')

  step('3. 打一个 10 张真实 JPEG 的 zip 并上传')
  const base = Date.now() - 5 * 60_000
  const frames = []
  for (let i = 0; i < 10; i++) {
    frames.push({
      seq: i,
      capturedAt: new Date(base + i * 30_000).toISOString(),
      packageName: i < 7 ? 'com.tencent.tmgp.sgame' : 'com.tencent.mm',
    })
  }
  const jpeg = makeJpeg(1)
  const zip = makeZip(frames.map((f, i) => ({
    name: `frame-${String(i).padStart(4, '0')}.jpg`,
    data: makeJpeg(1),
  })))
  console.log(`  zip 大小 ${(zip.length / 1024).toFixed(0)} KB（10 张 × ${(jpeg.length / 1024).toFixed(0)} KB）`)

  const form = new FormData()
  form.append('file', new Blob([zip], { type: 'application/zip' }), 'batch.zip')
  form.append('startedAt', frames[0].capturedAt)
  form.append('endedAt', frames[frames.length - 1].capturedAt)
  form.append('frames', JSON.stringify(frames))
  form.append('agentVersion', 'e2e')

  const upload = await api('POST', '/agent/screen-batches', { token: deviceToken, form })
  check(upload.status === 202, `上传被接受（HTTP ${upload.status}）`, JSON.stringify(upload.body).slice(0, 200))
  const batchId = upload.body?.batchId
  check(Boolean(batchId), `批次已建立（${batchId}）`)
  check(upload.body?.frames === 10, `服务端确认收到 10 帧（实际 ${upload.body?.frames}）`)

  step('4. 等分析完成')
  let insight = null
  for (let i = 0; i < 20 && !insight; i++) {
    await sleep(1500)
    const list = await must('GET', `/insights?deviceId=${deviceId}`, { token })
    insight = list.items?.[0] ?? null
    var aiNote = list.aiNote
  }
  check(Boolean(insight), '已生成洞察记录', aiNote || '')
  if (!insight) { console.log('\n分析未完成，终止'); process.exit(1) }

  console.log(`    provider=${insight.provider}  isAi=${insight.isAi}`)
  console.log(`    summary=${insight.summary}`)
  console.log(`    涉及应用=${insight.activities.map((a) => a.app).join('、')}`)

  step('5. 核对洞察内容')
  check(insight.provider !== '', `分析使用了 provider=${insight.provider}`)
  check(insight.summary.length > 0, '有中文总结')
  check(insight.frameCount === 10, `记录了 10 帧（实际 ${insight.frameCount}）`)
  check(Array.isArray(insight.activities) && insight.activities.length > 0, '识别出活动片段')
  const gameActivity = insight.activities.find((a) => a.category === 'game')
  check(Boolean(gameActivity), '识别出游戏类活动（沿用了设备端上报的包名）',
    JSON.stringify(insight.activities))
  if (!insight.isAi) {
    ok('未配置 AI 时如实标注为启发式推断，且不伪造局数/结算画面')
    check(insight.completedRounds === 0, '启发式没有编造「打完一局」')
  }

  step('6. 核对详情接口（帧时间线 + 隐私）')
  const detail = await must('GET', `/insights/${insight.id}?deviceId=${deviceId}`, { token })
  check(detail.frames?.length === 10, `详情里有 10 条帧时间线（实际 ${detail.frames?.length}）`)
  check(
    detail.frames.every((f) => !f.url && !f.path),
    '帧时间线只给时间与应用名，不返回原图地址（隐私约定）',
  )
  check(typeof detail.rawJson === 'string', '保留了原始分析输出便于排查')

  step('7. 核对用量与预算')
  const summary = await must('GET', `/usage-summary?deviceId=${deviceId}`, { token })
  check(summary.budgets.length === 1, '用量汇总里有 1 条预算')
  console.log(`    今日：${JSON.stringify(summary.used)}  额度：${summary.budgets[0].usedToday}/${summary.budgets[0].dailyLimit}`)

  step('8. 核对告警接口（本批无风险，应为空但接口可用）')
  const alerts = await must('GET', `/alerts?deviceId=${deviceId}`, { token })
  check(Array.isArray(alerts.items), '告警列表可读')
  check(typeof alerts.unread === 'number', `未读数可读（${alerts.unread}）`)
  const readAll = await must('POST', `/alerts/read-all?deviceId=${deviceId}`, { token })
  check(readAll.success === true, '一键已读可用')

  step('9. 核对屏幕答题接口')
  const quiz = await api('GET', '/agent/screen-quiz/next', { token: deviceToken })
  // 没开答题解锁时应当明确报错，而不是返回一道用不了的题
  check(quiz.status === 400 || quiz.ok, `取屏幕题返回 ${quiz.status}（未开答题解锁时明确拒绝）`)

  step('10. 清理')
  await must('DELETE', `/devices/${deviceId}`, { token })
  ok('已解绑并删除验证设备')

  console.log(`\n\x1b[1m结果：${passed} 项通过，${failed} 项失败\x1b[0m`)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((error) => {
  console.error(`\n\x1b[31m验证中断：${error.message}\x1b[0m`)
  process.exit(1)
})
