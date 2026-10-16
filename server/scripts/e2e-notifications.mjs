#!/usr/bin/env node
/**
 * 家长端站内通知的端到端验证（规划 §2.1 第一档）。
 *
 * 这个特性解决的是「家长根本不知道」：设备失联、管控能力失效、孩子进了/出了
 * 安全区、孩子申请装应用 —— 这些事以前只躺在一个「要主动去翻」的动态流里。
 *
 * 这里逐条验证的是「推得到」与「不刷屏」这两件同样重要的事：
 *
 *   1. 关键缺口会推，普通缺口不推（推错一次，家长就会开始忽略所有通知）；
 *   2. 幂等：设备每 3 分钟上报一次，重复上报不能变成一屏重复通知；
 *   3. 设备未认领时没有可通知的家长（不能因为「没人可发」而报错）；
 *   4. 家长关掉某一类之后，服务端**就不写了**（而不是前端过滤，
 *      否则未读角标会一直亮着、家长会以为坏了）；
 *   5. 通知天然按用户隔离：另一个家长既看不到也标不了别人的通知；
 *   6. 未读角标、单条已读、全部已读、删除的行为与计数一致；
 *   7. 偏好页把「微信/推送通道还没接入」如实说出来（configured: false），
 *      而不是让家长填一个永远不会生效的开关。
 *
 * 用法：node scripts/e2e-notifications.mjs   （默认 http://localhost:4000/api）
 *
 * 需要跑着的后端 + 已 seed 的库。脚本自己注册一次性家长账号与一次性设备，
 * 结束全部删除。其中「失联」与「会员到期」两组断言需要直接改库
 * （45 分钟前的心跳、3 天后的到期时间，都没法通过 API 造出来），
 * 拿不到数据库时这几条会**明确跳过并标注**，不会伪装成通过。
 */

const API = process.env.API_BASE || 'http://localhost:4000/api'
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
  const phone = `136${String(Date.now()).slice(-8)}`
  const sent = await must('POST', '/auth/send-code', { body: { phone, purpose: 'register' } })
  const reg = await must('POST', '/auth/register', {
    body: { phone, password: 'e2e-notify-123', code: sent.devCode, nickname: tag },
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

/** 读一页通知（默认全部 + 大页），返回 items。 */
async function listAll(token, extra = '') {
  const r = await must('GET', `/notifications?pageSize=50${extra}`, { token })
  return r
}

async function main() {
  console.log('\x1b[1m气球狗 · 站内通知端到端验证\x1b[0m')
  console.log(`  API ${API}`)

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
  const parent = await registerParent('通知E2E')
  userIds.push(parent.userId)
  const other = await registerParent('通知E2E旁观')
  userIds.push(other.userId)

  try {
    // ----------------------------------------------------------
    step('1. 准备：注册设备并认领')
    const suffix = Date.now().toString(36).toUpperCase().slice(-6)
    const deviceCode = `NTFY${suffix}`.slice(0, 12)
    const reg = await must('POST', '/agent/register', {
      body: {
        deviceCode,
        deviceSecret: 'e2e-notify-secret-0123456789abcdef',
        model: 'E2E Notify Device',
        os: 'Android',
        osVersion: '14',
      },
    })
    const deviceToken = reg.deviceToken
    const bound = await must('POST', '/devices/bind', {
      token: parent.token,
      body: { deviceCode, name: 'E2E 通知验证机' },
    })
    const deviceId = bound.device.id
    deviceIds.push(deviceId)
    ok(`设备已注册并认领（deviceId=${deviceId}）`)

    // ----------------------------------------------------------
    step('2. 全新的家长：空列表 + 未读 0 + 偏好默认值')
    const empty = await listAll(parent.token)
    check(empty.total === 0 && empty.items.length === 0, '一开始没有任何通知', String(empty.total))
    check(empty.unreadCount === 0, '未读角标为 0', String(empty.unreadCount))
    const unread0 = await must('GET', '/notifications/unread-count', { token: parent.token })
    check(unread0.unreadCount === 0, '未读角标接口一致', String(unread0.unreadCount))

    const prefs = await must('GET', '/notifications/preferences', { token: parent.token })
    // 10 类：设备失联 / 管控能力失效 / 进入安全区 / 离开安全区 / 应用安装申请 / 孩子的申请 /
    //        孩子的求助 / 家庭成员邀请（规划 §5.1）/ 今日任务（规划 §5.2）/ 会员到期
    check(prefs.items.length === 10, '偏好页列出全部 10 类事件', String(prefs.items.length))
    check(
      prefs.items.some((i) => i.label === '家庭成员邀请'),
      '家庭成员邀请也在偏好页里（可以关掉）',
    )
    check(
      prefs.items.some((i) => i.label === '今日任务'),
      '今日任务也在偏好页里（可以关掉）',
    )
    check(
      prefs.items.every((i) => i.inApp === true),
      '默认全部开启站内通知',
    )
    check(prefs.channels.wechat.configured === false, '微信通道如实标注「未接入」')
    check(prefs.channels.push.configured === false, '厂商推送通道如实标注「未接入」')

    // ----------------------------------------------------------
    step('3. 关键缺口：必须推给家长')
    const gapNames = (items) => items.filter((i) => i.type === 'health_danger').length
    await must('POST', '/agent/health', { token: deviceToken, body: healthyBody({ gaps: [GAP_CRITICAL] }) })
    let list = await listAll(parent.token)
    check(gapNames(list.items) === 1, '关键缺口产生 1 条通知', String(gapNames(list.items)))
    const healthNote = list.items.find((i) => i.type === 'health_danger')
    check(healthNote?.level === 'danger', '级别是 danger', String(healthNote?.level))
    check(healthNote?.typeLabel === '管控能力失效', '带中文类型名', String(healthNote?.typeLabel))
    check(healthNote?.linkPath === '/device-health', '带跳转路径 /device-health', String(healthNote?.linkPath))
    check(healthNote?.deviceId === deviceId, '带上是哪台设备', String(healthNote?.deviceId))
    // 正文是模板 + 参数：缺口的详情是设备端拼的中文长句，没法当 i18n key，
    // 所以只把缺口名（en 词典里有）当参数带上，详情留给设备健康页。
    check(
      healthNote?.body === '{{v0}}' && healthNote?.bodyParams?.v0 === '无障碍看门狗',
      '正文是模板 + 缺口名参数（英文界面查得到译文）',
      `${String(healthNote?.body)} / ${JSON.stringify(healthNote?.bodyParams)}`,
    )
    check(list.unreadCount === 1, '未读角标变成 1', String(list.unreadCount))

    // 设备每 3 分钟就会上报一次同一个缺口 —— 不能变成刷屏
    await must('POST', '/agent/health', { token: deviceToken, body: healthyBody({ gaps: [GAP_CRITICAL] }) })
    await must('POST', '/agent/health', { token: deviceToken, body: healthyBody({ gaps: [GAP_CRITICAL] }) })
    list = await listAll(parent.token)
    check(gapNames(list.items) === 1, '重复上报同一个缺口不产生新通知（幂等）', String(gapNames(list.items)))

    // ----------------------------------------------------------
    step('4. 普通缺口：不打扰家长')
    await must('POST', '/agent/health', { token: deviceToken, body: healthyBody({ gaps: [GAP_MAJOR] }) })
    list = await listAll(parent.token)
    check(gapNames(list.items) === 1, '非关键缺口不产生通知', String(gapNames(list.items)))

    // ----------------------------------------------------------
    step('5. 设备失联：读取健康页时补记并推送')
    if (!prisma) {
      skip('设备失联补记通知')
    } else {
      await must('POST', '/agent/health', { token: deviceToken, body: healthyBody() })
      await prisma.childDevice.update({
        where: { id: deviceId },
        data: { lastActiveAt: new Date(Date.now() - 45 * 60 * 1000) },
      })
      await must('GET', `/device/health?deviceId=${deviceId}`, { token: parent.token })
      list = await listAll(parent.token)
      const offline = list.items.filter((i) => i.type === 'agent_offline')
      check(offline.length === 1, '失联产生 1 条通知', String(offline.length))
      check(offline[0]?.level === 'warn', '45 分钟属于「失联（可挽回）」→ warn', String(offline[0]?.level))
      check(
        offline[0]?.title === '{{v0}} 已失联' && offline[0]?.titleParams?.v0 === 'E2E 通知验证机',
        '标题是模板 + 设备名参数（家长有多台设备时知道是哪台）',
        `${String(offline[0]?.title)} / ${JSON.stringify(offline[0]?.titleParams)}`,
      )
      // 反复刷新健康页不能刷出一屏重复
      await must('GET', `/device/health?deviceId=${deviceId}`, { token: parent.token })
      await must('GET', `/device/health?deviceId=${deviceId}`, { token: parent.token })
      list = await listAll(parent.token)
      check(
        list.items.filter((i) => i.type === 'agent_offline').length === 1,
        '反复刷新不重复推送',
        String(list.items.filter((i) => i.type === 'agent_offline').length),
      )
      // 设备回来之后，健康页不再补记
      await must('POST', '/agent/heartbeat', {
        token: deviceToken,
        body: { status: 'online', battery: 66, network: 'wifi' },
      })
      const back = await must('GET', `/device/health?deviceId=${deviceId}`, { token: parent.token })
      check(back.liveness === 'online' || back.liveness === 'delayed', '设备恢复心跳后在线分级回升', String(back.liveness))
    }

    // ----------------------------------------------------------
    step('6. 会员到期：家长不点开也要能看到')
    if (!prisma) {
      skip('会员到期提醒')
    } else {
      const before = (await listAll(parent.token)).items.filter((i) => i.type === 'membership_expiring').length
      await prisma.user.update({
        where: { id: parent.userId },
        data: {
          membershipTier: 'member',
          membershipExpiresAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
        },
      })
      const after = await listAll(parent.token)
      const notes = after.items.filter((i) => i.type === 'membership_expiring')
      check(notes.length === before + 1, '3 天后到期 → 产生 1 条提醒', String(notes.length))
      check(
        notes[0]?.title === '会员将在 {{v0}} 天后到期' && notes[0]?.titleParams?.v0 === 3,
        '标题说清还剩几天（模板 + 天数参数）',
        `${String(notes[0]?.title)} / ${JSON.stringify(notes[0]?.titleParams)}`,
      )
      check(notes[0]?.level === 'warn', '级别 warn（不是危险）', String(notes[0]?.level))
      check(notes[0]?.linkPath === '/membership', '跳转到会员页', String(notes[0]?.linkPath))
      // 同一天反复刷新只有一条
      await listAll(parent.token)
      const again = (await listAll(parent.token)).items.filter((i) => i.type === 'membership_expiring')
      check(again.length === before + 1, '同一天不重复提醒', String(again.length))
      // 到期时间还早就不提醒
      await prisma.user.update({
        where: { id: parent.userId },
        data: { membershipExpiresAt: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000) },
      })
      await listAll(parent.token)
      const far = (await listAll(parent.token)).items.filter((i) => i.type === 'membership_expiring')
      check(far.length === before + 1, '到期还早（60 天）不提醒', String(far.length))
      // 复原：后面不再用到会员状态
      await prisma.user.update({
        where: { id: parent.userId },
        data: { membershipTier: 'ordinary', membershipExpiresAt: null },
      })
    }

    // ----------------------------------------------------------
    step('7. 进出安全区：推送，重传不重复')
    const now = Date.now()
    await must('POST', '/agent/events', {
      token: deviceToken,
      body: {
        events: [
          { type: 'geofence_enter', detail: '进入 学校', at: now - 60_000 },
          { type: 'geofence_exit', detail: '离开 学校', at: now - 30_000 },
        ],
      },
    })
    list = await listAll(parent.token)
    const enters = list.items.filter((i) => i.type === 'geofence_enter')
    const exits = list.items.filter((i) => i.type === 'geofence_exit')
    check(enters.length === 1, '进入安全区产生 1 条通知', String(enters.length))
    check(exits.length === 1, '离开安全区产生 1 条通知', String(exits.length))
    check(
      enters[0]?.body === '进入了 {{v0}}' && enters[0]?.bodyParams?.v0 === '学校',
      '正文是模板 + 安全区名参数（设备端原文「进入 学校」被拆成方向 + 地点）',
      `${String(enters[0]?.body)} / ${JSON.stringify(enters[0]?.bodyParams)}`,
    )
    check(enters[0]?.level === 'info', '进出安全区是 info（不惊动家长）', String(enters[0]?.level))
    check(enters[0]?.linkPath === '/location', '跳转到位置页', String(enters[0]?.linkPath))

    // 设备重传同一批事件（网络重试）不能变成第二条通知
    await must('POST', '/agent/events', {
      token: deviceToken,
      body: { events: [{ type: 'geofence_enter', detail: '进入 学校', at: now - 60_000 }] },
    })
    list = await listAll(parent.token)
    check(
      list.items.filter((i) => i.type === 'geofence_enter').length === 1,
      '同一时刻的事件重传不产生新通知',
      String(list.items.filter((i) => i.type === 'geofence_enter').length),
    )
    // 真的又进了一次（新的时刻）应该再推一条
    await must('POST', '/agent/events', {
      token: deviceToken,
      body: { events: [{ type: 'geofence_enter', detail: '进入 学校', at: now }] },
    })
    list = await listAll(parent.token)
    check(
      list.items.filter((i) => i.type === 'geofence_enter').length === 2,
      '下一次真的进入会再推一条（不是永久压制）',
      String(list.items.filter((i) => i.type === 'geofence_enter').length),
    )

    // ----------------------------------------------------------
    step('8. 孩子申请装应用：家长得知道才会批')
    // 新建返回 201、命中既有 pending 返回 200 —— 「是不是新的」由状态码表达
    const audit1 = await api('POST', '/agent/audit-requests', {
      token: deviceToken,
      body: { appName: '抖音', packageName: 'com.ss.android.ugc.aweme' },
    })
    check(audit1.status === 201, '新的审核申请返回 201', String(audit1.status))
    list = await listAll(parent.token)
    const audits = list.items.filter((i) => i.type === 'app_audit')
    check(audits.length === 1, '产生 1 条通知', String(audits.length))
    check(
      audits[0]?.title === '{{v0}} 安装申请' && audits[0]?.titleParams?.v0 === '抖音',
      '标题是模板 + 应用名参数',
      `${String(audits[0]?.title)} / ${JSON.stringify(audits[0]?.titleParams)}`,
    )
    check(audits[0]?.level === 'warn', '级别 warn', String(audits[0]?.level))
    check(audits[0]?.linkPath === '/app-audit', '跳转到应用审核页', String(audits[0]?.linkPath))

    const audit2 = await api('POST', '/agent/audit-requests', {
      token: deviceToken,
      body: { appName: '抖音', packageName: 'com.ss.android.ugc.aweme' },
    })
    check(audit2.status === 200, '同一应用的重复申请命中已有单（200）', String(audit2.status))
    check(audit2.body?.id === audit1.body?.id, '重复申请返回同一条审核单', String(audit2.body?.id))
    list = await listAll(parent.token)
    check(list.items.filter((i) => i.type === 'app_audit').length === 1, '重复申请不再推一条', String(list.items.filter((i) => i.type === 'app_audit').length))

    // ----------------------------------------------------------
    step('9. 偏好：关掉之后服务端就不再写')
    const put = await must('PUT', '/notifications/preferences', {
      token: parent.token,
      body: { preferences: [{ type: 'geofence_enter', inApp: false, wechat: true }] },
    })
    check(put.items.find((i) => i.type === 'geofence_enter')?.inApp === false, '偏好已落盘')
    check(
      put.items.find((i) => i.type === 'geofence_exit')?.inApp === true,
      '只改了那一类，其它不受影响',
    )
    await must('POST', '/agent/events', {
      token: deviceToken,
      body: { events: [{ type: 'geofence_enter', detail: '进入 奶奶家', at: now + 60_000 }] },
    })
    list = await listAll(parent.token)
    check(
      list.items.filter((i) => i.type === 'geofence_enter').length === 2,
      '关掉的那一类不再产生通知',
      String(list.items.filter((i) => i.type === 'geofence_enter').length),
    )
    await must('PUT', '/notifications/preferences', {
      token: parent.token,
      body: { preferences: [{ type: 'geofence_enter', inApp: true }] },
    })
    await must('POST', '/agent/events', {
      token: deviceToken,
      body: { events: [{ type: 'geofence_enter', detail: '进入 学校', at: now + 120_000 }] },
    })
    list = await listAll(parent.token)
    check(
      list.items.filter((i) => i.type === 'geofence_enter').length === 3,
      '重新打开后恢复推送',
      String(list.items.filter((i) => i.type === 'geofence_enter').length),
    )

    // ----------------------------------------------------------
    step('10. 已读 / 全部已读 / 删除')
    const before = await listAll(parent.token)
    check(before.unreadCount > 0, '当前有未读', String(before.unreadCount))
    const target = before.items[0]
    const readOne = await must('POST', `/notifications/${target.id}/read`, { token: parent.token })
    check(readOne.unreadCount === before.unreadCount - 1, '单条已读后未读减 1', String(readOne.unreadCount))
    const afterOne = await listAll(parent.token)
    check(afterOne.items.find((i) => i.id === target.id)?.read === true, '该条标记为已读')
    check(Boolean(afterOne.items.find((i) => i.id === target.id)?.readAt), '已读时间已落盘')

    const unreadOnly = await must('GET', '/notifications?unreadOnly=true&pageSize=50', { token: parent.token })
    check(
      unreadOnly.items.every((i) => i.read === false),
      'unreadOnly 过滤只剩未读',
    )
    const filtered = await must('GET', '/notifications?type=health_danger&pageSize=50', { token: parent.token })
    check(
      filtered.items.length > 0 && filtered.items.every((i) => i.type === 'health_danger'),
      '按类型筛选生效',
      String(filtered.items.length),
    )

    const readAll = await must('POST', '/notifications/read-all', { token: parent.token })
    check(readAll.unreadCount === 0, '全部已读后未读归零', String(readAll.unreadCount))
    const afterAll = await must('GET', '/notifications/unread-count', { token: parent.token })
    check(afterAll.unreadCount === 0, '未读角标接口也归零', String(afterAll.unreadCount))

    const delCount = (await listAll(parent.token)).total
    await must('DELETE', `/notifications/${target.id}`, { token: parent.token })
    const afterDel = await listAll(parent.token)
    check(afterDel.total === delCount - 1, '删除后总数减 1', `${delCount} → ${afterDel.total}`)
    const delAgain = await api('DELETE', `/notifications/${target.id}`, { token: parent.token })
    check(delAgain.status === 404, '删除不存在的通知返回 404', String(delAgain.status))

    // ----------------------------------------------------------
    step('11. 隔离：另一个家长看不到也改不了')
    const otherList = await listAll(other.token)
    check(otherList.total === 0, '另一个家长看不到这些通知', String(otherList.total))
    const stolenRead = await api('POST', `/notifications/${before.items[1].id}/read`, { token: other.token })
    check(stolenRead.status === 404, '标别人的通知为已读 → 404', String(stolenRead.status))
    const stolenDel = await api('DELETE', `/notifications/${before.items[1].id}`, { token: other.token })
    check(stolenDel.status === 404, '删别人的通知 → 404', String(stolenDel.status))
    const anon = await api('GET', '/notifications')
    check(anon.status === 401, '未登录读通知 → 401', String(anon.status))

    // ----------------------------------------------------------
    step('12. 参数校验')
    const badType = await api('PUT', '/notifications/preferences', {
      token: parent.token,
      body: { preferences: [{ type: 'made_up_type', inApp: true }] },
    })
    check(badType.status === 422, '未知通知类型被拒（白名单）', String(badType.status))
    const badFilter = await api('GET', '/notifications?type=made_up_type', { token: parent.token })
    check(badFilter.status === 422, '未知类型筛选被拒', String(badFilter.status))
    const badPage = await api('GET', '/notifications?pageSize=999', { token: parent.token })
    check(badPage.status === 422, '超大分页被拒', String(badPage.status))
  } finally {
    // ----------------------------------------------------------
    step('13. 清理')
    for (const id of deviceIds) {
      const r = await api('DELETE', `/devices/${id}`, { token: parent.token })
      if (r.ok || r.status === 404) ok(`已删除验证设备 ${id}`)
      else bad(`删除验证设备失败 ${id}`, String(r.status))
    }
    const adminLogin = await api('POST', '/admin/login', {
      body: { username: ADMIN_USER, password: ADMIN_PASSWORD },
    })
    if (adminLogin.ok) {
      for (const userId of userIds) {
        if (!userId) continue
        const r = await api('DELETE', `/admin/users/${userId}`, { token: adminLogin.body.token })
        if (r.ok || r.status === 404) ok(`已删除一次性家长账号 #${userId}`)
        else bad(`删除家长账号失败 #${userId}`, String(r.status))
      }
    } else {
      bad('管理员登录失败，临时家长账号未清理', String(adminLogin.status))
    }
    if (prisma) await prisma.$disconnect()
  }

  console.log('\n' + '═'.repeat(54))
  if (failed === 0) console.log(`\x1b[32m站内通知：全部通过（${passed} 项${skipped ? `，跳过 ${skipped} 项` : ''}）\x1b[0m`)
  else console.log(`\x1b[31m站内通知：${passed} 项通过，${failed} 项失败${skipped ? `，跳过 ${skipped} 项` : ''}\x1b[0m`)
  console.log('═'.repeat(54))
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('\x1b[31m验证中断：\x1b[0m', err.message)
  process.exit(1)
})
