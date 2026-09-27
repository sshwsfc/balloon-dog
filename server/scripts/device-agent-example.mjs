#!/usr/bin/env node
/**
 * 设备端 Agent 示例实现（模拟一台"孩子手机"）。
 *
 * 用途：在没有真机的情况下，验证「后端下发 → 设备领取 → 执行 → 回报」的完整闭环，
 * 也作为接入真实客户端时的参考实现。
 *
 * 运行：
 *   node scripts/device-agent-example.mjs                 # 新注册一台设备并打印绑定码
 *   node scripts/device-agent-example.mjs --code ABC12345 # 复用已有设备码（需带 --secret）
 *   node scripts/device-agent-example.mjs --battery 50    # 指定上报电量
 *
 * 拿到绑定码后，在家长端「设备管理 → 绑定设备」里输入它完成认领，
 * 之后在首页点击锁屏/拍照，就能看到本进程打印指令并回报执行结果。
 *
 * 环境变量：API_BASE（默认 http://localhost:4000/api）
 */
import { randomBytes } from 'node:crypto'

const API_BASE = process.env.API_BASE || 'http://localhost:4000/api'
const argv = process.argv.slice(2)
const argOf = (name) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? argv[i + 1] : undefined
}

// ---------------- 设备身份（真实客户端应持久化到本地） ----------------
const deviceCode = (argOf('code') || randomBytes(4).toString('hex').toUpperCase().slice(0, 8))
const deviceSecret = argOf('secret') || randomBytes(24).toString('hex')
let deviceToken = null

const log = (...args) => console.log(`[agent]`, ...args)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

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
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = text
  }
  if (!res.ok) {
    const msg = parsed?.message || `HTTP ${res.status}`
    throw new Error(`${method} ${path} 失败：${msg}`)
  }
  return parsed
}

// ---------------- 1. 注册 / 续订令牌 ----------------
async function register() {
  const res = await api('POST', '/agent/register', {
    body: {
      deviceCode,
      deviceSecret,
      name: '示例设备',
      model: 'Example Phone',
      os: 'Android',
      osVersion: '14',
      agentVersion: '1.0.0-example',
    },
  })
  deviceToken = res.deviceToken
  log(`注册${res.created ? '成功（新设备）' : '成功（已存在，令牌已续订）'}`)
  log(`deviceId = ${res.deviceId}`)
  log(`\n  ┌─────────────────────────────────────────┐`)
  log(`  │  请在家长端输入绑定码： ${deviceCode.padEnd(16)}│`)
  log(`  └─────────────────────────────────────────┘\n`)
  if (res.bound) log('该设备已被家长绑定，可直接接收指令')
  else log('尚未绑定：可以正常心跳与领指令渠道，但不会有家长下发指令')
}

// ---------------- 2. 心跳 + 拉取管控策略 ----------------
async function heartbeatLoop() {
  let battery = Number(argOf('battery')) || 80
  for (;;) {
    try {
      const hb = await api('POST', '/agent/heartbeat', {
        token: deviceToken,
        body: { battery, network: 'wifi', agentVersion: '1.0.0-example' },
      })
      battery = Math.max(5, battery - 1)

      if (hb.bound) {
        const cfg = await api('GET', '/agent/config', { token: deviceToken })
        const parts = [
          `锁定=${cfg.locked}`,
          cfg.timePlan.unlimited
            ? '时长不限'
            : `剩余 ${cfg.timePlan.remainingMinutes} 分钟`,
          `应用限额 ${cfg.appLimits.length} 个`,
          `黑名单 ${cfg.blockedUrls.length} 个`,
          cfg.quiz.enabled ? `答题奖励 ${cfg.quiz.rewardMinutes} 分钟` : '答题关闭',
        ]
        log(`心跳: 电量 ${battery}% · ${parts.join(' · ')}`)
      }
    } catch (err) {
      log(`心跳失败：${err.message}`)
    }
    await sleep(15_000)
  }
}

// ---------------- 3. 长轮询领指令并"执行" ----------------
async function commandLoop() {
  for (;;) {
    try {
      // 长轮询：最多挂起 25 秒，有指令会被服务端立即唤醒
      const { command } = await api('GET', '/agent/commands/next?wait=25', { token: deviceToken })
      if (!command) continue

      log(`\n收到指令 [${command.type}] ${command.label}  (id=${command.id})`)
      const result = await execute(command)

      const report = await api('POST', `/agent/commands/${command.id}/result`, {
        token: deviceToken,
        body: result,
      })
      log(`已回报：${report.command.status}${result.error ? ` (${result.error})` : ''}`)
    } catch (err) {
      log(`领指令失败：${err.message}`)
      await sleep(5_000)
    }
  }
}

/**
 * 「执行」指令。
 * 真实客户端在这里调用系统 API：DevicePolicyManager.lockNow()、Camera2 拍照、
 * MediaProjection 截屏、MediaRecorder 录音……示例里只打印并返回成功。
 */
async function execute(command) {
  const type = command.type

  // 演示一下失败路径：把 payload 里带 __fail 的指令当作执行失败
  if (command.payload && command.payload.__fail) {
    return { status: 'failed', error: '系统权限被拒绝（示例）' }
  }

  switch (type) {
    case 'lock':
      log('  → 调用 lockNow() 立刻锁屏')
      return { status: 'succeeded', result: { locked: true } }

    case 'unlock':
      log('  → 解除本地锁屏限制')
      return { status: 'succeeded', result: { locked: false } }

    case 'temp_unlock':
      log(`  → 临时放开 ${command.payload?.minutes} 分钟，到期时间 ${command.payload?.until}`)
      return { status: 'succeeded', result: { until: command.payload?.until } }

    case 'cancel_temp_unlock':
      log('  → 立即恢复锁定')
      return { status: 'succeeded', result: { locked: true } }

    case 'remote_photo':
    case 'screenshot': {
      const kind = type === 'remote_photo' ? 'photo' : 'screenshot'
      log(`  → 采集${kind === 'photo' ? '照片' : '屏幕截图'}（示例生成一张 1x1 PNG）`)
      // 真实客户端：把采集到的字节流作为 multipart 上传，并把 mediaId 回填到指令结果
      const mediaId = await uploadDemoMedia(kind, command.id)
      return { status: 'succeeded', result: { mediaId, note: '示例媒体已上传' } }
    }

    case 'start_recording': {
      const recordingId = `rec-${Date.now()}`
      log(`  → 开始录像，recordingId=${recordingId}`)
      return { status: 'succeeded', result: { recordingId } }
    }

    case 'stop_recording':
      log(`  → 停止录像 ${command.payload?.recordingId}`)
      return { status: 'succeeded', result: { videoUrl: '/media/demo.mp4' } }

    case 'start_audio': {
      const recordingId = `audio-${Date.now()}`
      log(`  → 开始录音，recordingId=${recordingId}`)
      return { status: 'succeeded', result: { recordingId } }
    }

    case 'stop_audio':
      log(`  → 停止录音 ${command.payload?.recordingId}`)
      return { status: 'succeeded', result: { audioUrl: '/media/demo.m4a' } }

    case 'fetch_location':
      log('  → 读取 GPS 并上报')
      await api('POST', '/agent/locations', {
        token: deviceToken,
        body: { latitude: 39.9955, longitude: 116.4709, accuracy: 20, address: '北京市朝阳区望京西园四区' },
      })
      return { status: 'succeeded', result: { reported: true } }

    case 'sync_config':
      log('  → 重新拉取并应用管控策略')
      return { status: 'succeeded', result: { synced: true } }

    default:
      log(`  → 未知指令类型 ${type}，回报失败`)
      return { status: 'failed', error: `不支持的指令类型：${type}` }
  }
}

/** 上传一张示例 PNG，演示媒体回传链路。 */
async function uploadDemoMedia(kind, commandId) {
  // 最小的合法 PNG（1x1 透明像素）
  const pngBase64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
  const bytes = Buffer.from(pngBase64, 'base64')

  const form = new FormData()
  form.append('file', new Blob([bytes], { type: 'image/png' }), 'demo.png')
  form.append('kind', kind)
  form.append('commandId', commandId)

  const res = await fetch(`${API_BASE}/agent/media`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${deviceToken}` },
    body: form,
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data?.message || '媒体上传失败')
  log(`  → 媒体已上传：${data.media.id}`)
  return data.media.id
}

// ---------------- 主流程 ----------------
async function main() {
  log(`后端地址：${API_BASE}`)
  log(`设备码：${deviceCode}`)
  await register()

  // 首次运行会把 secret 打印出来 —— 真实客户端应写入本地存储供下次续订使用
  log(`设备密钥（请妥善保存，重启时用 --secret 传入）：${deviceSecret}`)
  log('\n开始心跳与指令轮询，Ctrl+C 退出\n')

  await Promise.all([heartbeatLoop(), commandLoop()])
}

main().catch((err) => {
  console.error(`\n[agent] 启动失败：${err.message}`)
  console.error('请确认后端已启动（cd server && npm run dev）')
  process.exit(1)
})
