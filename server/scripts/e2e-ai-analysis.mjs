#!/usr/bin/env node
/**
 * **AI 代码路径**的端到端验证。
 *
 * 与 `e2e-screen-insights.mjs` 的分工：
 *   - 那个脚本验证「截屏包 → 服务端 → 启发式降级 → 家长端」这条不需要 key 的链路；
 *   - 本脚本专门验证**有 AI 时**才会走到的那部分：
 *     多模态请求构造、结构化输出校验、局数/集数落库、异常提醒生成、
 *     预算超限真的下发锁屏、以及屏幕答题。
 *
 * 它自己拉起一个 mock 的 OpenAI 兼容服务，因此不需要任何真实 API key。
 *
 * 用法（需要先起一个指向 mock 的后端，见脚本末尾的提示）：
 *   node scripts/e2e-ai-analysis.mjs
 * 环境变量：
 *   API_BASE   默认 http://localhost:4001/api（刻意用 4001，避免打扰正在跑的 4000）
 */

const API = process.env.API_BASE || 'http://localhost:4001/api'
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

// —— 与设备端同格式的最小 zip（stored）——
const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let i = 0; i < 256; i++) { let c = i; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[i] = c }
  return t
})()
const crc32 = (buf) => { let c = -1; for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xff]; return (c ^ -1) >>> 0 }
function makeZip(files) {
  const local = []; const central = []; let offset = 0
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8'); const data = f.data; const crc = crc32(data)
    const lh = Buffer.alloc(30)
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6)
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22)
    lh.writeUInt16LE(name.length, 26)
    local.push(lh, name, data)
    const cd = Buffer.alloc(46)
    cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6)
    cd.writeUInt16LE(0x0800, 8); cd.writeUInt32LE(crc, 16)
    cd.writeUInt32LE(data.length, 20); cd.writeUInt32LE(data.length, 24)
    cd.writeUInt16LE(name.length, 28); cd.writeUInt32LE(offset, 42)
    central.push(cd, name)
    offset += 30 + name.length + data.length
  }
  const cdBuf = Buffer.concat(central)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(files.length, 8)
  eocd.writeUInt16LE(files.length, 10); eocd.writeUInt32LE(cdBuf.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...local, cdBuf, eocd])
}

/** 复用上一轮脚本生成的那张 JPEG；没有就现场用 sips 造一张。 */
async function tinyJpeg() {
  // ESM 里没有 require，用动态 import
  const fs = await import('node:fs')
  const { spawnSync } = await import('node:child_process')
  if (!fs.existsSync('/tmp/base.png')) {
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAGQAAABkCAYAAABw4pVUAAAAWklEQVR42u3QMQEAAAgDoJnc6BpjDyQgd5cKBAgQIECAAAECBAgQIECAAAECBAgQIECAAAECBAgQIECAAAECBAgQIECAAAECBAgQIECAAAECBAgQIEBA4Fe7AAGx6yq5AAAAAElFTkSuQmCC',
      'base64',
    )
    fs.writeFileSync('/tmp/base.png', png)
  }
  spawnSync('sips', ['-s', 'format', 'jpeg', '-Z', '480', '/tmp/base.png', '--out', '/tmp/base-ai.jpg'])
  return fs.readFileSync('/tmp/base-ai.jpg')
}

async function main() {
  console.log('\x1b[1m气球狗 · AI 分析路径端到端验证\x1b[0m')
  console.log(`  API  ${API}`)
  console.log('  （需要后端以 AI_ENABLED=true 指向 mock 服务，见脚本说明）')

  // 0. 确认后端可达。刻意探 /health（不需要鉴权）——
  //    用 /screen-monitor 探会把「未登录的 401」误判成「后端没起来」。
  const origin = API.replace(/\/api$/, '')
  try {
    const probe = await fetch(`${origin}/health`)
    if (!probe.ok) throw new Error(`health ${probe.status}`)
  } catch (error) {
    console.error(`\n后端未就绪（${origin}/health 不可达）：${error.message}`)
    console.error('请先启动指向 mock 的实例：')
    console.error('  MOCK_AI_SCENARIO=game_result MOCK_AI_QUIZ=1 node scripts/mock-ai-server.mjs 4100 &')
    console.error('  PORT=4001 AI_ENABLED=true AI_BASE_URL=http://127.0.0.1:4100/v1 \\')
    console.error('    AI_API_KEY=mock AI_VISION_MODEL=mock-vl AI_TEXT_MODEL=mock-text npx tsx src/server.ts')
    process.exit(1)
  }

  // 再确认这个实例确实接了 AI（用家长令牌看 screen-monitor）
  {
    const login0 = await must('POST', '/auth/login', { body: { phone: PARENT_PHONE, password: PARENT_PASSWORD } })
    const dev0 = (await must('GET', '/devices', { token: login0.token })).devices?.[0]
    if (dev0) {
      const monitor = await must('GET', `/screen-monitor?deviceId=${dev0.id}`, { token: login0.token })
      if (monitor.analysisMode !== 'ai') {
        console.warn(`\n  [警告] 这个后端没有接入 AI（analysisMode=${monitor.analysisMode}），AI 路径断言会失败`)
      } else {
        console.log(`  后端已接入 AI：${monitor.analysisNote}`)
      }
    }
  }

  step('0. 注册设备 + 认领')
  const code = 'AI' + Math.random().toString(16).slice(2, 8).toUpperCase()
  const reg = await must('POST', '/agent/register', {
    body: {
      deviceCode: code, deviceSecret: 'ai-test-secret-0123456789',
      model: 'AI E2E Phone', os: 'Android', osVersion: '13', agentVersion: 'e2e',
    },
  })
  const deviceToken = reg.deviceToken
  const deviceId = reg.deviceId
  const login = await must('POST', '/auth/login', { body: { phone: PARENT_PHONE, password: PARENT_PASSWORD } })
  const token = login.token
  await must('POST', '/devices/bind', { token, body: { deviceCode: code, name: 'AI 路径验证' } })
  ok(`设备已注册并认领（${code}）`)

  step('1. 开启截屏/分析/屏幕答题，并把局数上限定为 1')
  const putResult = await must('PUT', `/screen-monitor?deviceId=${deviceId}`, {
    token,
    body: { captureEnabled: true, analyzeEnabled: true, analyzeSampleCount: 6, quizFromScreen: true },
  })
  // PUT 返回 { success, userId, config }，实际配置在 config 里
  const cfg = putResult.config
  check(cfg.analysisMode === 'ai', `家长端识别出「已接入 AI」（mode=${cfg.analysisMode}）`, cfg.analysisNote)
  await must('PUT', `/usage-budgets?deviceId=${deviceId}`, {
    token, body: { kind: 'game_round', appName: '', dailyLimit: 1 },
  })
  ok('局数上限 = 1（这一批打完会把额度用尽）')

  step('2. 上传一个 10 帧的包，走 AI 分析')
  const jpeg = await tinyJpeg()
  const base = Date.now() - 5 * 60_000
  const frames = Array.from({ length: 10 }, (_, i) => ({
    seq: i,
    capturedAt: new Date(base + i * 30_000).toISOString(),
    packageName: 'com.tencent.tmgp.sgame',
  }))
  const zip = makeZip(frames.map((_, i) => ({
    name: `frame-${String(i).padStart(4, '0')}.jpg`, data: jpeg,
  })))
  const form = new FormData()
  form.append('file', new Blob([zip], { type: 'application/zip' }), 'batch.zip')
  form.append('startedAt', frames[0].capturedAt)
  form.append('endedAt', frames[9].capturedAt)
  form.append('frames', JSON.stringify(frames))
  form.append('agentVersion', 'e2e')
  const upload = await api('POST', '/agent/screen-batches', { token: deviceToken, form })
  check(upload.status === 202, `上传被接受（HTTP ${upload.status}）`)
  check(upload.body?.analysis?.provider === 'openai-compatible',
    '设备端立刻拿到了「将由 AI 分析」的回执', JSON.stringify(upload.body?.analysis))

  step('3. 等 AI 分析完成')
  let insight = null
  for (let i = 0; i < 25 && !insight; i++) {
    await sleep(1500)
    const list = await must('GET', `/insights?deviceId=${deviceId}`, { token })
    insight = list.items?.[0] ?? null
  }
  check(Boolean(insight), '已生成洞察记录')
  if (!insight) { console.log('\n分析未完成'); process.exit(1) }
  console.log(`    provider=${insight.provider}  isAi=${insight.isAi}`)
  console.log(`    summary=${insight.summary}`)
  console.log(`    游戏=${JSON.stringify(insight.games)}`)

  step('4. 核对 AI 结论被正确解析')
  check(insight.isAi === true, '标记为真实 AI 分析（不是启发式）')
  check(insight.provider === 'openai-compatible', `provider=${insight.provider}`)
  check(insight.summary.includes('王者荣耀'), '总结来自模型返回的内容')
  check(insight.completedRounds === 1, `识别出「打完 1 局」（实际 ${insight.completedRounds}）`)
  check(insight.games[0]?.scene === 'result', `识别出结算画面（scene=${insight.games[0]?.scene}）`)
  check(insight.riskLevel === 'medium', `风险等级=${insight.riskLevel}`)
  check(insight.keywords?.includes('victory'), '抽取了屏幕关键词')

  step('5. 核对异常提醒已生成（游戏沉迷）')
  const alerts = await must('GET', `/alerts?deviceId=${deviceId}`, { token })
  const addiction = alerts.items.find((a) => a.type === 'game_addiction')
  check(Boolean(addiction), '生成了「游戏沉迷」提醒', JSON.stringify(alerts.items.map((a) => a.type)))
  check(addiction?.evidence?.includes('连续多局'), '提醒带上了模型给出的判定依据')
  check(addiction?.typeLabel === '游戏沉迷', '提醒有中文类型名')
  check(alerts.unread >= 1, `未读数 ${alerts.unread}`)

  step('6. 核对局数落成可计数事实 + 额度用尽触发锁屏')
  const summary = await must('GET', `/usage-summary?deviceId=${deviceId}`, { token })
  check(summary.used.game_round === 1, `今日已玩 ${summary.used.game_round} 局`)
  check(summary.budgets[0].exceeded === true, '额度判定为「已超限」')

  const device = await must('GET', `/device?deviceId=${deviceId}`, { token })
  check(device.locked === true, '服务端已把设备置为锁定')

  const commands = await must('GET', `/device/commands?deviceId=${deviceId}&limit=5`, { token })
  const lockCommand = commands.commands.find((c) => c.type === 'lock')
  check(Boolean(lockCommand), '确实下发了一条 lock 指令（而不是只改状态）',
    JSON.stringify(commands.commands.map((c) => c.type)))
  check(lockCommand?.payload?.reason === 'usage_budget', '指令里注明了原因是额度用尽')

  step('7. 核对设备端能从 config 看到额度用尽')
  const agentCfg = await must('GET', '/agent/config', { token: deviceToken })
  check(agentCfg.screenMonitor.usageBudget.gameRounds.exceeded === true,
    'config 里 gameRounds.exceeded=true')
  check(agentCfg.screenMonitor.usageBudget.gameRounds.remaining === 0, '剩余额度 0')

  step('8. 核对屏幕答题（由 AI 抽取的知识点生成）')
  // 答题解锁需要开着才取得到题
  await must('PUT', `/quiz/config?deviceId=${deviceId}`, { token, body: { enabled: true, grade: 'grade3' } })
  // 触发一次重新分析以生成题目（题目在分析完成时生成）
  await must('POST', `/insights/${insight.id}/reanalyze?deviceId=${deviceId}`, { token })
  await sleep(4000)

  const question = await api('GET', '/agent/screen-quiz/next', { token: deviceToken })
  check(question.ok, `取题成功（HTTP ${question.status}）`, JSON.stringify(question.body).slice(0, 200))
  if (question.ok) {
    console.log(`    source=${question.body.source} 题目=${question.body.question?.question}`)
    check(question.body.source === 'screen', '出的是「基于屏幕内容」的题，而不是普通题库题')
    check(
      String(question.body.question?.question || '').includes('victory'),
      '题目直接来自屏幕上出现的单词',
    )
  }

  step('9. 清理')
  await must('DELETE', `/devices/${deviceId}`, { token })
  ok('已解绑并删除验证设备')

  console.log(`\n\x1b[1m结果：${passed} 项通过，${failed} 项失败\x1b[0m`)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error(`\n\x1b[31m验证中断：${e.message}\x1b[0m`)
  process.exit(1)
})
