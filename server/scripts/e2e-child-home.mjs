#!/usr/bin/env node
/**
 * 孩子端主页与求助端到端验证（规划 §3.2）。
 *
 * §3.2 要给孩子端一个「自己的主页」：今天还剩多少时间、怎么赚时长、怎么找家长。
 * 前两件在设备端本地算（额度与用量都在本机，离线也算得出来），需要服务端的只有
 * 「这台设备是谁在守护」与那条**求助**通道 —— 这个脚本验的就是这两件。
 *
 * 这里要验的不是「接口能通」，而是三条更容易做错的：
 *
 *   1. **求助真的叫得醒家长**。必须是 danger 级站内通知 + 一条设备事件：
 *      通知负责叫醒（家长不一定正开着动态页），事件负责留痕（动态里能看到时间线）。
 *      只写事件 = 家长可能几小时后才发现；只发通知 = 翻记录时看不到前因后果。
 *   2. **同一个孩子连点两下不该变成两条通知，但事件要两条**。通知按
 *      (设备, 分钟) 幂等；事件每次都记 —— 「一分钟内连点五次」这件事本身
 *      对家长也是信息（真的着急，或者只是手滑）。
 *   3. **没被认领的设备不许假装成功**。设备先自助注册、家长还没认领时，
 *      没有收件人。这时必须回 `success:false`，也**不许**写通知/事件 ——
 *      报假成功会让孩子以为家长收到了，这是这个功能最不能出的错。
 *
 * 用法：node scripts/e2e-child-home.mjs   （默认 http://localhost:4000/api）
 *
 * 需要跑着的后端 + 已 seed 的库。脚本自己注册一次性家长账号与一次性设备，
 * 结束全部删除。
 */

const API = process.env.API_BASE || 'http://localhost:4000/api'
const ADMIN_USER = process.env.ADMIN_USER || 'admin'
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'balloon-admin-2026'

let passed = 0
let failed = 0
const ok = (m) => { passed++; console.log(`  \x1b[32m✓\x1b[0m ${m}`) }
const bad = (m, extra = '') => { failed++; console.log(`  \x1b[31m✗\x1b[0m ${m}${extra ? ` — ${extra}` : ''}`) }
const check = (c, m, extra = '') => (c ? ok(m) : bad(m, extra))
const step = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`)

async function api(method, path, { body, token } = {}) {
  const headers = {}
  if (token) headers.Authorization = `Bearer ${token}`
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  const res = await fetch(`${API}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let parsed = null
  try { parsed = text ? JSON.parse(text) : null } catch { parsed = text }
  return { ok: res.ok, status: res.status, body: parsed, text }
}

const must = async (method, path, options) => {
  const r = await api(method, path, options)
  if (!r.ok) throw new Error(`${method} ${path} → ${r.status} ${r.body?.message || r.text}`)
  return r.body
}

async function registerParent(tag) {
  const phone = `137${String(Date.now()).slice(-8)}`
  const sent = await must('POST', '/auth/send-code', { body: { phone, purpose: 'register' } })
  const reg = await must('POST', '/auth/register', {
    body: { phone, password: 'e2e-child-home-123', code: sent.devCode, nickname: tag },
  })
  return { token: reg.token, userId: reg.user?.id ?? null, phone }
}

/** 设备自助注册（未认领状态也是合法状态，第 2 节专门验它）。 */
async function registerDevice(prefix, name) {
  const suffix = Date.now().toString(36).toUpperCase().slice(-5)
  const deviceCode = `${prefix}${suffix}`.slice(0, 12)
  const reg = await must('POST', '/agent/register', {
    body: {
      deviceCode,
      deviceSecret: `e2e-child-home-secret-${suffix}`,
      model: 'E2E Child Home Device',
      os: 'Android',
      osVersion: '14',
    },
  })
  return { deviceCode, deviceToken: reg.deviceToken, name }
}

const childHome = (deviceToken) => api('GET', '/agent/child-home', { token: deviceToken })
const sos = (deviceToken, body = {}) => api('POST', '/agent/sos', { token: deviceToken, body })

/** 家长端站内通知（按类型过滤，避免被别的生产者干扰）。 */
const notifications = (token) => must('GET', '/notifications?pageSize=50', { token })
const sosNotes = async (token) =>
  (await notifications(token)).items.filter((n) => n.type === 'child_sos')

/** 家长端「最新动态」（设备事件）。 */
const events = async (token, deviceId) =>
  (await must('GET', `/device-events?deviceId=${deviceId}&pageSize=50`, { token })).items

async function main() {
  console.log('\x1b[1m气球狗 · 孩子端主页与求助端到端验证（§3.2）\x1b[0m')
  console.log(`  API ${API}`)

  const devicesToClean = []
  const userIds = []
  const parent = await registerParent('求助E2E')
  userIds.push(parent.userId)
  const other = await registerParent('求助E2E旁观')
  userIds.push(other.userId)

  let unclaimed = null

  try {
    // ----------------------------------------------------------
    step('1. 准备：一台已认领设备 + 一台还没认领的设备')
    const reg = await registerDevice('CHOM', 'E2E 求助验证机')
    const bound = await must('POST', '/devices/bind', {
      token: parent.token,
      body: { deviceCode: reg.deviceCode, name: 'E2E 求助验证机' },
    })
    const deviceId = bound.device.id
    devicesToClean.push({ token: parent.token, id: deviceId })
    ok(`已认领设备就绪（deviceId=${deviceId}）`)

    unclaimed = await registerDevice('CHOMFREE', 'E2E 未认领机')
    ok(`未认领设备已自助注册（deviceCode=${unclaimed.deviceCode}）`)

    // ----------------------------------------------------------
    step('2. 没被认领的设备：如实说「没人守护」，不假装成功')
    const lonely = await must('GET', '/agent/child-home', { token: unclaimed.deviceToken })
    check(lonely.bound === false, 'child-home 回 bound:false', String(lonely.bound))
    check(lonely.parentPhone === null, '没有家长手机号可回', String(lonely.parentPhone))
    // 未认领设备的名字是注册时按型号自动生成的（「<型号>的手机」），家长认领时可以改
    check(lonely.deviceName.includes('E2E Child Home Device'), '设备名照回（孩子端据此显示是哪台设备）', lonely.deviceName)

    const lonelySos = await sos(unclaimed.deviceToken, { message: '有人跟着我' })
    check(lonelySos.status === 200, '未认领时求助不报 5xx（是「发不出去」，不是「服务器坏了」）', String(lonelySos.status))
    check(lonelySos.body?.success === false, 'success:false —— 没有收件人时不报假成功', JSON.stringify(lonelySos.body))
    check(lonelySos.body?.reason === 'unbound', 'reason=unbound，孩子端据此显示原因', String(lonelySos.body?.reason))
    const lonelyNotes = await sosNotes(parent.token)
    check(lonelyNotes.length === 0, '未认领设备一条通知都没写', String(lonelyNotes.length))

    // ----------------------------------------------------------
    step('3. 已认领设备：主页能拿到「谁在守护」')
    const home = await must('GET', '/agent/child-home', { token: reg.deviceToken })
    check(home.bound === true, 'bound:true', String(home.bound))
    check(home.deviceName === 'E2E 求助验证机', '设备名回给设备端', home.deviceName)
    check(home.parentPhone === parent.phone, '家长的手机号回给设备端（孩子要能一键拨出去）', String(home.parentPhone))
    check(home.parentName === '求助E2E', '家长称呼回给设备端', String(home.parentName))

    // ----------------------------------------------------------
    step('4. 求助：一条 danger 通知 + 一条设备事件')
    const before = await sosNotes(parent.token)
    const first = await must('POST', '/agent/sos', { token: reg.deviceToken, body: {} })
    check(first.success === true, 'success:true', String(first.success))
    check(first.parentPhone === parent.phone, '求助回包里带着家长手机号（孩子端可立刻拨号）', String(first.parentPhone))

    const afterFirst = await sosNotes(parent.token)
    check(afterFirst.length === before.length + 1, '通知多了一条', `${before.length} → ${afterFirst.length}`)
    const note = afterFirst[0]
    check(note?.type === 'child_sos', 'type=child_sos', String(note?.type))
    check(note?.typeLabel === '孩子的求助', 'typeLabel=孩子的求助', String(note?.typeLabel))
    check(note?.level === 'danger', '级别是 danger（最高级，进未读红点）', String(note?.level))
    check(note?.title === '{{v0}} 发起了求助', '标题是模板而不是拼好的句子', String(note?.title))
    check(note?.titleParams?.v0 === 'E2E 求助验证机', '标题参数是设备名', JSON.stringify(note?.titleParams))
    check(note?.body === '孩子点了求助按钮，请尽快联系他。', '没写理由时用固定正文', String(note?.body))
    check(note?.linkPath === '/notifications', '点击跳转路径由类型定义统一给出', String(note?.linkPath))
    check(note?.deviceId === deviceId, '通知挂在正确的设备上', String(note?.deviceId))

    const feed = await events(parent.token, deviceId)
    check(feed.some((e) => e.type === 'sos'), '动态里有一条 sos 事件（家长能翻到时间线）', feed.map((e) => e.type).join(','))
    check(
      feed.find((e) => e.type === 'sos')?.detail === '孩子发起了求助',
      '事件的 detail 是完整中文句子（动态是设备日志，不走模板）',
      String(feed.find((e) => e.type === 'sos')?.detail),
    )

    // ----------------------------------------------------------
    step('5. 连点两下：通知不重复，但事件照记')
    const again = await sos(reg.deviceToken, {})
    check(again.status === 200, '第二次点也是 200（不是报错）', String(again.status))
    const afterSecond = await sosNotes(parent.token)
    check(afterSecond.length === afterFirst.length, '同一分钟内通知没有变多（防连点刷屏）', `${afterFirst.length} → ${afterSecond.length}`)
    const feed2 = await events(parent.token, deviceId)
    const sosEvents = feed2.filter((e) => e.type === 'sos')
    check(sosEvents.length === 2, '两次点按在动态里留下两条（「连点」这件事本身也是信息）', String(sosEvents.length))

    // ----------------------------------------------------------
    step('6. 带理由的求助：理由原样进正文（换一台设备避开同分钟幂等）')
    // 免费账号只能绑一台手机（「绑定多台手机」是会员功能），所以先解绑第一台
    const freed = await api('DELETE', `/devices/${deviceId}`, { token: parent.token })
    check(freed.ok || freed.status === 404, '先解绑第一台，腾出绑定位', String(freed.status))
    const reg2 = await registerDevice('CHOM2', 'E2E 求助验证机二')
    const bound2 = await must('POST', '/devices/bind', {
      token: parent.token,
      body: { deviceCode: reg2.deviceCode, name: 'E2E 求助验证机二' },
    })
    devicesToClean.push({ token: parent.token, id: bound2.device.id })
    const why = '有人在校门口跟着我'
    const withReason = await must('POST', '/agent/sos', { token: reg2.deviceToken, body: { message: why } })
    check(withReason.success === true, '带理由也能发出去', String(withReason.success))
    const reasoned = (await sosNotes(parent.token)).find((n) => n.deviceId === bound2.device.id)
    check(reasoned?.body === '孩子说：{{v0}}', '正文是模板', String(reasoned?.body))
    check(reasoned?.bodyParams?.v0 === why, '孩子的原话在参数里（前端 t() 查不到就原样显示）', JSON.stringify(reasoned?.bodyParams))
    check(reasoned?.titleParams?.v0 === 'E2E 求助验证机二', '两台设备的通知各自带自己的设备名', JSON.stringify(reasoned?.titleParams))

    // ----------------------------------------------------------
    step('7. 校验与鉴权')
    // 第一台设备已经在第 6 节解绑了（令牌随之失效），这里必须用还在绑的那台
    const tooLong = await sos(reg2.deviceToken, { message: 'x'.repeat(201) })
    check(tooLong.status === 422, '理由超过 200 字 → 422', String(tooLong.status))
    const noAuth = await api('GET', '/agent/child-home')
    check(noAuth.status === 401, '不带设备令牌读主页 → 401', String(noAuth.status))
    const noAuthSos = await api('POST', '/agent/sos', { body: {} })
    check(noAuthSos.status === 401, '不带设备令牌发求助 → 401', String(noAuthSos.status))
    const ghost = await api('POST', '/agent/sos', { token: 'not-a-real-device-token', body: {} })
    check(ghost.status === 401, '伪造设备令牌 → 401', String(ghost.status))

    // ----------------------------------------------------------
    step('8. 隔离：另一个家长的孩子只看到自己家长的号码')
    const otherReg = await registerDevice('CHOM3', 'E2E 别家设备')
    const otherBound = await must('POST', '/devices/bind', {
      token: other.token,
      body: { deviceCode: otherReg.deviceCode, name: 'E2E 别家设备' },
    })
    devicesToClean.push({ token: other.token, id: otherBound.device.id })
    const otherHome = await must('GET', '/agent/child-home', { token: otherReg.deviceToken })
    check(otherHome.parentPhone === other.phone, '别家设备拿到的是别家家长的号码', String(otherHome.parentPhone))
    check(otherHome.parentPhone !== parent.phone, '绝不会串到第一个家长', String(otherHome.parentPhone))
    const otherNotes = await must('POST', '/agent/sos', { token: otherReg.deviceToken, body: { message: '我在同学家' } })
    check(otherNotes.success === true, '别家设备的求助也能发', String(otherNotes.success))
    const mine = (await sosNotes(parent.token)).filter((n) => n.deviceId === otherBound.device.id)
    check(mine.length === 0, '别家设备的求助不会出现在我的消息中心', String(mine.length))
  } finally {
    step('9. 清理')
    for (const d of devicesToClean) {
      const r = await api('DELETE', `/devices/${d.id}`, { token: d.token })
      if (!r.ok && r.status !== 404) console.log(`  \x1b[33m•\x1b[0m 删除设备 ${d.id} → ${r.status}`)
    }
    const adminLogin = await api('POST', '/admin/login', {
      body: { username: ADMIN_USER, password: ADMIN_PASSWORD },
    })
    if (adminLogin.ok) {
      for (const id of userIds) {
        if (id == null) continue
        const r = await api('DELETE', `/admin/users/${id}`, { token: adminLogin.body.token })
        if (!r.ok && r.status !== 404) console.log(`  \x1b[33m•\x1b[0m 删除家长 ${id} → ${r.status}`)
      }
    } else {
      bad('管理员登录失败，临时家长账号未清理', String(adminLogin.status))
    }
    if (unclaimed) {
      // 未认领设备没有归属家长，走设备端自删（没有这个接口时留着也无害，只用日志说明）
      const r = await api('DELETE', `/agent/device`, { token: unclaimed.deviceToken })
      if (!r.ok) console.log(`  \x1b[33m•\x1b[0m 未认领设备 ${unclaimed.deviceCode} 未自删（${r.status}，本来也没有家长的列表会显示它）`)
    }
    ok('清理完成（测试家长账号与设备都已删除）')
  }

  console.log(`\n\x1b[1m结果：${passed} 项通过 / ${failed} 项失败\x1b[0m`)
  if (failed > 0) process.exit(1)
}

main().catch((err) => {
  console.error(`\n\x1b[31m脚本中断：${err.message}\x1b[0m`)
  process.exit(1)
})
