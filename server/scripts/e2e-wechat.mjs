#!/usr/bin/env node
/**
 * 微信模板消息的端到端验证（规划 §2.1 第二档：站内之外的「再发一条」）。
 *
 * 这一档要回答的不是「能不能发」(真发要公众号 appid/secret 和家长真的关注，
 * 本地发不了),而是这条链路里真正会写错的几件事：
 *
 *   1. 默认**不发** —— 新通道必须家长显式打开，否则就是半夜手机响；
 *   2. 三个前提（服务端配好 / 家长绑过微信 / 这一类打开了微信）缺一不可，
 *      缺任何一条**连投递行都不该建**（建了不发 = 库里堆僵尸记录）；
 *   3. 派发是惰性的（挂在「家长打开消息中心」上），发出去的内容是**渲染过**的，
 *      页面上不会残留 `{{v0}}`；
 *   4. 微信把令牌提前判失效时，服务端要丢掉缓存重取一次再发；
 *   5. 发失败要留下微信的 errcode 原文，并且重试到上限就停（`lastError` 可查）；
 *   6. 家长还没绑微信时不把待发项标成失败（那是「还没到时候」，不是失败）；
 *   7. 通道是**逐用户**的：这个家长打开消息中心不会把别人的待发项发出去。
 *
 * 为了不碰正在跑的后端，这个脚本自己拉起两个进程（都在本地、跑完就杀）：
 *   - `server/scripts/mock-wechat-server.mjs`（假微信，:4100，严格校验模板字段名）
 *   - 一个带 `WECHAT_*` 环境变量的后端实例（:4101，与 :4000 共用同一个库）
 * 所以它**不需要** `npm run server:dev` 在跑，只需要数据库可用。
 *
 * 用法：node server/scripts/e2e-wechat.mjs
 */

import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SERVER_DIR = path.resolve(HERE, '..')

const MOCK_PORT = Number(process.env.MOCK_WECHAT_PORT || 4100)
const APP_PORT = Number(process.env.WECHAT_E2E_PORT || 4101)
const API = `http://127.0.0.1:${APP_PORT}/api`
const MOCK = `http://127.0.0.1:${MOCK_PORT}`
const MOCK_OPENID_A = 'o_e2e_wechat_parent_a'
const MOCK_OPENID_B = 'o_e2e_wechat_parent_b'
const ADMIN_USER = process.env.ADMIN_USER || 'admin'
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'balloon-admin-2026'

let passed = 0
let failed = 0
let skipped = 0
const ok = (m) => { passed++; console.log(`  \x1b[32m✓\x1b[0m ${m}`) }
const bad = (m, extra = '') => { failed++; console.log(`  \x1b[31m✗\x1b[0m ${m}${extra ? ` — ${extra}` : ''}`) }
const check = (c, m, extra = '') => (c ? ok(m) : bad(m, extra))
const skip = (m) => { skipped++; console.log(`  \x1b[33m•\x1b[0m ${m}（跳过：拿不到数据库）`) }
const step = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`)

async function api(method, p, { body, token, base = API } = {}) {
  const headers = {}
  if (token) headers.Authorization = `Bearer ${token}`
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  const res = await fetch(`${base}${p}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let parsed = null
  try { parsed = text ? JSON.parse(text) : null } catch { parsed = text }
  return { ok: res.ok, status: res.status, body: parsed, text }
}

const must = async (method, p, options) => {
  const r = await api(method, p, options)
  if (!r.ok) throw new Error(`${method} ${p} → ${r.status} ${r.body?.message || r.text}`)
  return r.body
}

/** 假微信的测试专用端点。 */
const mockState = () => must('GET', '/__mock/messages', { base: MOCK })
const mockReset = () => must('POST', '/__mock/reset', { base: MOCK, body: {} })
const mockInvalidate = () => must('POST', '/__mock/invalidate-token', { base: MOCK, body: {} })

async function registerParent(tag) {
  const phone = `137${String(Date.now()).slice(-8)}`
  const sent = await must('POST', '/auth/send-code', { body: { phone, purpose: 'register' } })
  const reg = await must('POST', '/auth/register', {
    body: { phone, password: 'e2e-wechat-123', code: sent.devCode, nickname: tag },
  })
  return { token: reg.token, userId: reg.user?.id ?? null, phone }
}

function healthyBody(overrides = {}) {
  return {
    level: 'ok',
    gaps: [],
    checks: { deviceOwner: true, accessibility: true, overlay: true },
    permissions: { location: 'granted', camera: 'granted' },
    restrictions: [],
    serviceRunning: true,
    clockSkewSeconds: 0,
    healCount: 0,
    ...overrides,
  }
}

const GAP_CRITICAL = {
  id: 'accessibility',
  label: '无障碍看门狗',
  detail: '无障碍看门狗已被关闭：孩子可下拉通知栏、进设置、按最近任务绕过锁定',
  importance: 'critical',
  fixability: 'auto',
  fixHint: '',
}
const GAP_MAJOR = {
  id: 'batteryWhitelist',
  label: '电池优化白名单',
  detail: '未加入电池优化白名单：息屏后可能被 Doze 冻结',
  importance: 'major',
  fixability: 'manual',
  fixHint: '设置 → 电池 → 电池优化',
}

/** 等一个 HTTP 端点开始响应（拉起子进程之后用）。 */
async function waitFor(url, label, timeoutMs = 40_000) {
  const deadline = Date.now() + timeoutMs
  let lastError = ''
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url)
      if (res.ok) return
      lastError = `HTTP ${res.status}`
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
    await new Promise((r) => setTimeout(r, 300))
  }
  throw new Error(`${label} 在 ${timeoutMs / 1000}s 内没有就绪（${lastError}）`)
}

const children = []
/** 被 spawn 的后端日志（断言失败时打出来，省得靠猜） */
const appLogRef = { value: '' }
function shutdown() {
  for (const child of children) {
    try { child.kill('SIGTERM') } catch { /* 已经退了 */ }
  }
}

async function main() {
  console.log('\x1b[1m气球狗 · 微信模板消息端到端验证\x1b[0m')
  console.log(`  后端 ${API}  假微信 ${MOCK}`)

  // ---- 拉起「假微信」+ 一个带 WECHAT_* 配置的后端实例 --------------------
  const mockChild = spawn('node', [path.join(HERE, 'mock-wechat-server.mjs')], {
    env: { ...process.env, MOCK_WECHAT_PORT: String(MOCK_PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  children.push(mockChild)
  const appChild = spawn('npx', ['tsx', 'src/server.ts'], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      PORT: String(APP_PORT),
      WECHAT_LOGIN_APP_ID: 'mock-appid',
      WECHAT_LOGIN_APP_SECRET: 'mock-appsecret-0123456789',
      WECHAT_TEMPLATE_ID: 'mock-template-1',
      WECHAT_API_BASE_URL: MOCK,
      WECHAT_TEMPLATE_LINK_BASE: 'http://localhost:2727',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  children.push(appChild)
  appChild.stdout.on('data', (d) => { appLogRef.value += String(d) })
  appChild.stderr.on('data', (d) => { appLogRef.value += String(d) })
  let mockLog = ''
  mockChild.stderr.on('data', (d) => { mockLog += String(d) })

  try {
    await waitFor(`${MOCK}/__mock/messages`, '假微信')
    ok(`假微信已就绪（${MOCK}）`)
    await waitFor(`http://127.0.0.1:${APP_PORT}/health`, '带微信配置的后端')
    ok(`后端实例已就绪（:${APP_PORT}，共用同一个库）`)
  } catch (error) {
    console.error(`\x1b[31m拉起失败：\x1b[0m ${error.message}`)
    if (appLogRef.value) console.error(appLogRef.value.split('\n').slice(-15).join('\n'))
    if (mockLog) console.error(mockLog)
    shutdown()
    process.exit(1)
  }

  let prisma = null
  try {
    const mod = await import('@prisma/client')
    prisma = new mod.PrismaClient()
    await prisma.$queryRaw`SELECT 1`
  } catch {
    prisma = null
  }

  const deviceIds = []
  const userIds = []
  const parent = await registerParent('微信E2E')
  userIds.push(parent.userId)
  const other = await registerParent('微信E2E旁观')
  userIds.push(other.userId)

  try {
    // ----------------------------------------------------------
    step('1. 准备：注册设备并认领')
    const suffix = Date.now().toString(36).toUpperCase().slice(-6)
    const deviceCode = `WXTE${suffix}`.slice(0, 12)
    const reg = await must('POST', '/agent/register', {
      body: {
        deviceCode,
        deviceSecret: 'e2e-wechat-secret-0123456789abcdef',
        model: 'E2E WeChat Device',
        os: 'Android',
        osVersion: '14',
      },
    })
    const deviceToken = reg.deviceToken
    const bound = await must('POST', '/devices/bind', {
      token: parent.token,
      body: { deviceCode, name: 'E2E 微信验证机' },
    })
    const deviceId = bound.device.id
    deviceIds.push(deviceId)
    ok(`设备已注册并认领（deviceId=${deviceId}）`)

    // ----------------------------------------------------------
    step('2. 通道状态：这台后端配好了公众号，但这个家长还没绑微信')
    let prefs = await must('GET', '/notifications/preferences', { token: parent.token })
    check(prefs.channels.wechat.configured === true, '微信通道 configured=true（环境变量齐了）')
    check(prefs.channels.wechat.bound === false, '这个账号还没绑定微信（bound=false）')
    check(
      typeof prefs.channels.wechat.hint === 'string' && prefs.channels.wechat.hint.includes('绑定'),
      '如实说明「还没绑定微信」而不是给一个假开关',
      String(prefs.channels.wechat.hint),
    )
    check(prefs.channels.wechat.lastDelivery === null, '还没有任何投递记录')
    check(
      prefs.items.every((i) => i.wechat === false),
      '微信通道默认全部关闭（新通道不能一上线就让手机响）',
    )
    check(prefs.channels.push.configured === false, '厂商推送仍然如实标注「不适用」')
    check(
      String(prefs.channels.push.reason || '').includes('移动网页'),
      '厂商推送给出不适用原因（不是「以后再说」）',
      String(prefs.channels.push.reason),
    )

    step('3. 没绑微信就点「发测试」：必须当场说清楚原因')
    const notBound = await api('POST', '/notifications/channels/wechat/test', {
      token: parent.token,
      body: {},
    })
    check(notBound.status === 400, '未绑定微信 → 400', String(notBound.status))
    check(
      String(notBound.body?.message || '').includes('还没有绑定微信'),
      '错误里说明了「还没有绑定微信」',
      String(notBound.body?.message),
    )

    step('4. 绑定微信（直接写 openid，网页授权回调没法在这条链路里造假）')
    if (!prisma) {
      skip('绑定微信之后的断言')
    } else {
      await prisma.user.update({ where: { id: parent.userId }, data: { wechatOpenid: MOCK_OPENID_A } })
      prefs = await must('GET', '/notifications/preferences', { token: parent.token })
      check(prefs.channels.wechat.bound === true, '绑定后 bound=true')
      check(prefs.channels.wechat.hint === '', '绑定后不再提示未绑定')
    }

    step('5. 通道开了、但这一类没打开：不该建投递行')
    await must('POST', '/agent/health', { token: deviceToken, body: healthyBody({ gaps: [GAP_CRITICAL] }) })
    let list = await must('GET', '/notifications?pageSize=50', { token: parent.token })
    const healthNote = list.items.find((i) => i.type === 'health_danger')
    check(Boolean(healthNote), '关键缺口产生了站内通知', String(list.total))
    if (prisma && healthNote) {
      const count = await prisma.notificationDelivery.count({ where: { notificationId: healthNote.id } })
      check(count === 0, '这一类没打开微信 → 连投递行都不建（不是建了不发）', String(count))
    } else {
      skip('「没打开微信时不建投递行」')
    }

    let auditNoteId = null

    step('6. 打开这一类的微信开关：新通知要入队并真的发出去')
    const allWechatOn = prefs.items.map((i) => ({
      type: i.type,
      inApp: i.inApp,
      wechat: true,
      push: false,
    }))
    const saved = await must('PUT', '/notifications/preferences', {
      token: parent.token,
      body: { preferences: allWechatOn },
    })
    check(saved.items.every((i) => i.wechat === true), '偏好已整份保存（全部打开微信）')
    // 造一条**新的**通知：孩子的装应用申请（普通缺口按设计不推，只有关键缺口才推）
    await must('POST', '/agent/audit-requests', {
      token: deviceToken,
      body: { appName: '抖音', packageName: 'com.ss.android.ugc.aweme' },
    })
    if (!prisma) {
      skip('投递行与派发')
    } else {
      // 注意顺序：**列表接口自己就会顺手派发**（`list` 里跑惰性检查），
      // 所以「刚入队是 pending」必须在调用列表接口之前看。
      const auditRow = await prisma.notification.findFirst({
        where: { userId: parent.userId, type: 'app_audit' },
        orderBy: { createdAt: 'desc' },
      })
      check(Boolean(auditRow), '孩子的装应用申请产生了通知')
      auditNoteId = auditRow?.id ?? null
      const delivery = auditRow
        ? await prisma.notificationDelivery.findUnique({
            where: { notificationId_channel: { notificationId: auditRow.id, channel: 'wechat' } },
          })
        : null
      check(Boolean(delivery), '打开了微信 → 入队了一条投递记录')
      check(delivery?.status === 'pending', '刚到队列里是 pending', String(delivery?.status))
      check(delivery?.attempts === 0, '还没尝试发送', String(delivery?.attempts))
      const beforeQueue = await mockState()
      check(beforeQueue.messages.length === 0, '还没发给微信（派发是惰性的）', String(beforeQueue.messages.length))
    }

    step('7. 惰性派发：家长打开消息中心时把它发出去')
    await must('GET', '/notifications/unread-count', { token: parent.token })
    const after = await mockState()
    check(after.messages.length === 1, '打开消息中心后假微信收到了 1 条', String(after.messages.length))
    const sent = after.messages[0] || {}
    check(sent.to === MOCK_OPENID_A, '发给了这个家长的 openid', String(sent.to))
    check(sent.templateId === 'mock-template-1', '用的是配置里的模板 ID', String(sent.templateId))
    check(
      sent.first === '抖音 安装申请' && sent.keyword1 === '抖音 安装申请',
      '标题渲染成了人话（不是模板原文）',
      `${String(sent.first)} / ${String(sent.keyword1)}`,
    )
    check(
      sent.keyword2 === '孩子想安装这个应用，需要你批准后才能在设备上安装。',
      '正文原样带上',
      String(sent.keyword2),
    )
    check(!`${sent.first}${sent.keyword1}${sent.keyword2}`.includes('{{'), '发出去的内容里没有残留 {{v0}}')
    check(sent.url === 'http://localhost:2727/app-audit', '跳转链接指向对应页面', String(sent.url))
    if (prisma && auditNoteId) {
      const delivery = await prisma.notificationDelivery.findUnique({
        where: { notificationId_channel: { notificationId: auditNoteId, channel: 'wechat' } },
      })
      check(delivery?.status === 'sent', '投递记录标成 sent', String(delivery?.status))
      check(delivery?.attempts === 1, '尝试次数记成 1', String(delivery?.attempts))
    }
    list = await must('GET', '/notifications?pageSize=50', { token: parent.token })
    const auditNote = list.items.find((i) => i.type === 'app_audit')
    check(
      auditNote?.title === '{{v0}} 安装申请' && auditNote?.titleParams?.v0 === '抖音',
      '站内那条也是「模板 + 应用名参数」（英文界面查得到译文）',
      `${String(auditNote?.title)} / ${JSON.stringify(auditNote?.titleParams)}`,
    )
    const prefsAfter = await must('GET', '/notifications/preferences', { token: parent.token })
    check(
      prefsAfter.channels.wechat.lastDelivery?.status === 'sent',
      '偏好页能看到最近一次投递成功',
      String(prefsAfter.channels.wechat.lastDelivery?.status),
    )

    step('8. 幂等：再打开一次消息中心不会重复发')
    await must('GET', '/notifications/unread-count', { token: parent.token })
    await must('GET', '/notifications/unread-count', { token: parent.token })
    const again = await mockState()
    check(again.messages.length === 1, '没有重复投递', String(again.messages.length))

    step('9. 令牌被提前判失效：丢掉缓存重取一次再发')
    await mockInvalidate()
    const testSend = await api('POST', '/notifications/channels/wechat/test', {
      token: parent.token,
      body: { notificationId: auditNoteId },
    })
    check(testSend.ok, '重取令牌之后测试发送成功', `${testSend.status} ${testSend.body?.message || ''}`)
    const afterRetry = await mockState()
    check(afterRetry.messages.length === 2, '假微信收到了第二条（测试消息）', String(afterRetry.messages.length))
    check(
      afterRetry.tokenFetches >= 2,
      '令牌确实被重取了一次（而不是一直用缓存里的旧令牌）',
      `tokenFetches=${afterRetry.tokenFetches}`,
    )

    step('10. 发失败：留下微信的 errcode 原文，并且重试到上限就停')
    if (!prisma) {
      skip('失败注入与重试上限')
    } else {
      const failNote = await prisma.notification.create({
        data: {
          userId: parent.userId,
          deviceId,
          type: 'health_danger',
          level: 'danger',
          title: '{{v0}}',
          titleParams: { v0: '测试失败' },
          body: '__mock_fail__',
          linkPath: '/device-health',
          dedupeKey: `wechat-e2e-fail:${suffix}`,
        },
      })
      const failRes = await api('POST', '/notifications/channels/wechat/test', {
        token: parent.token,
        body: { notificationId: failNote.id },
      })
      check(failRes.status === 503, '微信拒绝 → 503', String(failRes.status))
      check(
        String(failRes.body?.message || '').includes('47003'),
        '错误信息里带微信的 errcode 原文（排查模板问题全靠它）',
        String(failRes.body?.message),
      )
      const failDelivery = await prisma.notificationDelivery.findUnique({
        where: { notificationId_channel: { notificationId: failNote.id, channel: 'wechat' } },
      })
      check(failDelivery?.status === 'failed', '投递记录标成 failed', String(failDelivery?.status))
      check(
        String(failDelivery?.lastError || '').includes('47003'),
        'lastError 里留了微信原文',
        String(failDelivery?.lastError),
      )
      const failPrefs = await must('GET', '/notifications/preferences', { token: parent.token })
      check(
        String(failPrefs.channels.wechat.lastDelivery?.lastError || '').includes('47003'),
        '偏好页把失败原因显示出来（「为什么没收到」有据可查）',
        String(failPrefs.channels.wechat.lastDelivery?.lastError),
      )

      // 把尝试次数顶到上限：惰性派发不该再试
      const beforeCap = (await mockState()).messages.length
      await prisma.notificationDelivery.update({
        where: { notificationId_channel: { notificationId: failNote.id, channel: 'wechat' } },
        data: { attempts: 3, status: 'failed' },
      })
      await must('GET', '/notifications/unread-count', { token: parent.token })
      const afterCap = await mockState()
      check(afterCap.messages.length === beforeCap, '到重试上限后不再重试', `${beforeCap} → ${afterCap.messages.length}`)
    }

    step('11. 还没绑微信：待发项留在队列里，不算失败')
    if (!prisma) {
      skip('未绑定微信时的待发状态')
    } else {
      const waitNote = await prisma.notification.create({
        data: {
          userId: parent.userId,
          deviceId,
          type: 'health_danger',
          level: 'danger',
          title: '{{v0}}',
          titleParams: { v0: '等待绑定' },
          body: '等待绑定时不该被判失败',
          linkPath: '/device-health',
          dedupeKey: `wechat-e2e-wait:${suffix}`,
        },
      })
      await prisma.notificationDelivery.upsert({
        where: { notificationId_channel: { notificationId: waitNote.id, channel: 'wechat' } },
        create: { notificationId: waitNote.id, channel: 'wechat' },
        update: {},
      })
      await prisma.user.update({ where: { id: parent.userId }, data: { wechatOpenid: null } })
      await must('GET', '/notifications/unread-count', { token: parent.token })
      const waitDelivery = await prisma.notificationDelivery.findUnique({
        where: { notificationId_channel: { notificationId: waitNote.id, channel: 'wechat' } },
      })
      check(
        waitDelivery?.status === 'pending' && waitDelivery?.attempts === 0,
        '未绑定微信时待发项保持 pending、不消耗重试次数（那是「还没到时候」，不是失败）',
        `${waitDelivery?.status}/${waitDelivery?.attempts}`,
      )
      // 这里**不**把 openid 恢复回去：恢复了的话，下面 step 12 里家长自己的待发项
      // 会在「打开消息中心」时被顺手发出去，与「不碰别人的待发项」这条断言混在一起。
    }

    step('12. 通道是逐用户的：这个家长不会把别人的待发项发出去')
    if (!prisma) {
      skip('逐用户隔离')
    } else {
      await prisma.user.update({ where: { id: other.userId }, data: { wechatOpenid: MOCK_OPENID_B } })
      const otherNote = await prisma.notification.create({
        data: {
          userId: other.userId,
          type: 'health_danger',
          level: 'danger',
          title: '{{v0}}',
          titleParams: { v0: '别人的消息' },
          body: '旁观家长的通知',
          linkPath: '/device-health',
          dedupeKey: `wechat-e2e-other:${suffix}`,
        },
      })
      await prisma.notificationDelivery.upsert({
        where: { notificationId_channel: { notificationId: otherNote.id, channel: 'wechat' } },
        create: { notificationId: otherNote.id, channel: 'wechat' },
        update: {},
      })
      const beforeOther = (await mockState()).messages.length
      await must('GET', '/notifications/unread-count', { token: parent.token })
      const otherDelivery = await prisma.notificationDelivery.findUnique({
        where: { notificationId_channel: { notificationId: otherNote.id, channel: 'wechat' } },
      })
      check(
        otherDelivery?.status === 'pending',
        '别人的待发项没有被这个家长顺手发出去',
        String(otherDelivery?.status),
      )
      const afterOther = (await mockState()).messages.length
      check(afterOther === beforeOther, '假微信没有收到别人的消息', `${beforeOther} → ${afterOther}`)
      // 别人的通知也不能拿来测试发送。先把这个家长的 openid 挂回去，
      // 否则会先撞上「还没绑定微信」那条 400，测不到「按 userId 查」这一层。
      await prisma.user.update({ where: { id: parent.userId }, data: { wechatOpenid: MOCK_OPENID_A } })
      const crossSend = await api('POST', '/notifications/channels/wechat/test', {
        token: parent.token,
        body: { notificationId: otherNote.id },
      })
      check(crossSend.status === 404, '拿别人的通知去测试发送 → 404（按 userId 查）', String(crossSend.status))
      // 旁观家长自己打开消息中心时，就轮到它了
      await must('GET', '/notifications/unread-count', { token: other.token })
      const otherSent = await prisma.notificationDelivery.findUnique({
        where: { notificationId_channel: { notificationId: otherNote.id, channel: 'wechat' } },
      })
      check(otherSent?.status === 'sent', '旁观家长自己打开消息中心后它才发出去', String(otherSent?.status))
      const otherMessages = (await mockState()).messages.filter((m) => m.to === MOCK_OPENID_B)
      check(otherMessages.length === 1, '这条消息发给了旁观家长自己的 openid', String(otherMessages.length))
    }

    step('13. 收尾：清理')
    for (const deviceId_ of deviceIds) {
      const r = await api('DELETE', `/devices/${deviceId_}`, { token: parent.token })
      check(r.ok || r.status === 404, `已删除验证设备 ${deviceId_}`)
    }
    const adminLogin = await api('POST', '/admin/login', {
      body: { username: ADMIN_USER, password: ADMIN_PASSWORD },
    })
    if (adminLogin.ok) {
      for (const userId of userIds) {
        if (!userId) continue
        const r = await api('DELETE', `/admin/users/${userId}`, { token: adminLogin.body.token })
        check(r.ok || r.status === 404, `已删除一次性家长账号 #${userId}`)
      }
    } else {
      bad('管理员登录失败，临时家长账号未清理', String(adminLogin.status))
    }
    await mockReset()
  } finally {
    if (prisma) await prisma.$disconnect()
    shutdown()
  }

  console.log('\n' + '═'.repeat(54))
  if (failed === 0) {
    console.log(`\x1b[32m微信模板消息：全部通过（${passed} 项${skipped ? `，跳过 ${skipped} 项` : ''}）\x1b[0m`)
  } else {
    console.log(`\x1b[31m微信模板消息：${passed} 项通过，${failed} 项失败${skipped ? `，跳过 ${skipped} 项` : ''}\x1b[0m`)
  }
  console.log('═'.repeat(54))
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('\x1b[31m验证中断：\x1b[0m', err.message)
  shutdown()
  process.exit(1)
})

// 断言有失败时把子进程日志的尾巴打出来：这类问题多半出在被测后端的日志里
process.on('exit', (code) => {
  if (code === 0) return
  const tail = appLogRef.value.split('\n').filter(Boolean).slice(-25).join('\n')
  if (tail) console.error(`\n\x1b[33m后端日志（末尾 25 行）：\x1b[0m\n${tail}`)
})
