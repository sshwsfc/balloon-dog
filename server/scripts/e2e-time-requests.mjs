#!/usr/bin/env node
/**
 * 孩子的申请（加时 / 延后锁屏）端到端验证（规划 §3.1）。
 *
 * 这个特性解决的是：孩子被锁住时除了「等」什么也做不了 —— 那正是亲子冲突的来源。
 * 所以这里要验证的不只是「接口能通」，而是三件更要命的事：
 *
 *   1. **批准 = 真的下发指令**。服务端不能自己宣布「已解锁」：家长点了批准之后，
 *      设备必须从指令队列里领到一条 temp_unlock，并在它回报成功之后
 *      `locked`/`tempUnlockUntil` 才落地。这条链路断了，孩子会看到
 *      「家长已同意」但屏幕仍然锁着 —— 比不做这个功能更伤信任。
 *   2. **幂等但不刷屏**。孩子盯着锁屏页会反复点「申请」；服务端按
 *      (设备, 类型, pending) 收敛成一条，且内容没变时**不刷新 createdAt**
 *      —— 否则「等了多久」每点一次就重置一次，家长的待办列表也跟着乱跳。
 *   3. **家长只能改小、不能改大**。孩子申请 120 分钟、家长给 30 分钟是常态；
 *      反过来（批准 300 分钟）只可能是误触或改包，必须在服务端夹住。
 *
 * 另外两条同样重要的否定断言：
 *   - 另一个家长既看不到、也批不了别人的申请（隔离）；
 *   - 已处理过的申请不能再改（审批是一次性决定，允许翻案的话设备端那条
 *     「已批准」的轮询结果就成了假的）。
 *
 * 用法：node scripts/e2e-time-requests.mjs   （默认 http://localhost:4000/api）
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
    body: { phone, password: 'e2e-time-123', code: sent.devCode, nickname: tag },
  })
  return { token: reg.token, userId: reg.user?.id ?? null, phone }
}

/** 家长端列表（默认待审批）。 */
const list = (token, deviceId, extra = '') =>
  must('GET', `/device/time-requests?deviceId=${deviceId}${extra}`, { token })

/** 孩子端提交。 */
const submit = (deviceToken, body) =>
  api('POST', '/agent/time-requests', { token: deviceToken, body })

/** 孩子端轮询。 */
const poll = (deviceToken, id) =>
  must('GET', `/agent/time-requests/${id}`, { token: deviceToken })

async function main() {
  console.log('\x1b[1m气球狗 · 孩子的申请端到端验证（§3.1）\x1b[0m')
  console.log(`  API ${API}`)

  // 每台设备记下「用哪个家长的令牌删」—— 旁观家长那台必须由它自己删（别人删是 403）
  const devicesToClean = []
  const userIds = []
  const parent = await registerParent('申请E2E')
  userIds.push(parent.userId)
  const other = await registerParent('申请E2E旁观')
  userIds.push(other.userId)

  try {
    // ----------------------------------------------------------
    step('1. 准备：注册设备并认领')
    const suffix = Date.now().toString(36).toUpperCase().slice(-6)
    const deviceCode = `TREQ${suffix}`.slice(0, 12)
    const reg = await must('POST', '/agent/register', {
      body: {
        deviceCode,
        deviceSecret: 'e2e-time-request-secret-0123456789',
        model: 'E2E Time Request Device',
        os: 'Android',
        osVersion: '14',
      },
    })
    const deviceToken = reg.deviceToken
    const bound = await must('POST', '/devices/bind', {
      token: parent.token,
      body: { deviceCode, name: 'E2E 申请验证机' },
    })
    const deviceId = bound.device.id
    devicesToClean.push({ token: parent.token, id: deviceId })
    ok(`设备已注册并认领（deviceId=${deviceId}）`)

    // ----------------------------------------------------------
    step('2. 一开始：没有申请，角标为 0')
    const empty = await list(parent.token, deviceId)
    check(empty.items.length === 0, '还没有任何申请', String(empty.items.length))
    const dev0 = await must('GET', `/device?deviceId=${deviceId}`, { token: parent.token })
    check(dev0.pendingTimeRequests === 0, '设备视图里的待审批角标为 0', String(dev0.pendingTimeRequests))

    // ----------------------------------------------------------
    step('3. 孩子提交申请：落在待审批，带中文类型名')
    const first = await submit(deviceToken, {
      kind: 'extend_time',
      minutes: 60,
      reason: '作业写完了，想玩一会儿',
    })
    check(first.status === 201, '新建申请返回 201', String(first.status))
    check(first.body?.status === 'pending', '状态为 pending', String(first.body?.status))
    check(first.body?.minutes === 60, '分钟数为申请值', String(first.body?.minutes))
    const firstId = first.body?.id

    let pending = await list(parent.token, deviceId)
    check(pending.items.length === 1, '家长端看到 1 条待审批', String(pending.items.length))
    const item = pending.items[0]
    check(item.id === firstId, '就是刚提交的那条')
    check(item.kind === 'extend_time', '类型是加时', String(item.kind))
    check(item.kindLabel === '申请加时', '带中文类型名「申请加时」', String(item.kindLabel))
    check(item.reason === '作业写完了，想玩一会儿', '理由原文透传给家长', String(item.reason))
    check(item.grantedMinutes === null, '未审批时没有「实际批了多少」', String(item.grantedMinutes))

    const dev1 = await must('GET', `/device?deviceId=${deviceId}`, { token: parent.token })
    check(dev1.pendingTimeRequests === 1, '设备视图角标变成 1', String(dev1.pendingTimeRequests))
    const devices = await must('GET', '/devices', { token: parent.token })
    check(
      devices.devices.find((d) => d.id === deviceId)?.pendingTimeRequests === 1,
      '设备列表也带角标（首页/我的靠它显示）',
    )

    // ----------------------------------------------------------
    step('4. 通知：孩子开口了，家长必须知道')
    const notes = await must('GET', '/notifications?pageSize=50', { token: parent.token })
    const reqNotes = notes.items.filter((n) => n.type === 'child_request')
    check(reqNotes.length === 1, '产生 1 条「孩子的申请」通知', String(reqNotes.length))
    check(reqNotes[0]?.typeLabel === '孩子的申请', '通知类型名正确', String(reqNotes[0]?.typeLabel))
    check(reqNotes[0]?.linkPath === '/time-requests', '通知能跳回申请页', String(reqNotes[0]?.linkPath))
    check(reqNotes[0]?.deviceId === deviceId, '通知指明是哪台设备', String(reqNotes[0]?.deviceId))
    // 标题是模板 + 参数：v0 是申请种类（它本身是一条 en 词典里的 key），v1 是分钟数
    check(
      reqNotes[0]?.title === '{{v0}}：{{v1}} 分钟' &&
        reqNotes[0]?.titleParams?.v0 === '申请加时' &&
        reqNotes[0]?.titleParams?.v1 === 60,
      '标题是模板 + 「种类 + 时长」参数',
      `${String(reqNotes[0]?.title)} / ${JSON.stringify(reqNotes[0]?.titleParams)}`,
    )

    // ----------------------------------------------------------
    step('5. 幂等：孩子反复点「申请」不会刷屏，也不会重置等待时长')
    const again = await submit(deviceToken, {
      kind: 'extend_time',
      minutes: 60,
      reason: '作业写完了，想玩一会儿',
    })
    check(again.status === 200, '内容没变的重复提交返回 200', String(again.status))
    check(again.body?.id === firstId, '收敛回同一条申请', String(again.body?.id))
    const stillOne = await list(parent.token, deviceId)
    check(stillOne.items.length === 1, '仍然只有 1 条待审批', String(stillOne.items.length))
    check(
      stillOne.items[0].createdAt === item.createdAt,
      'createdAt 没被刷新（否则「已经等了多久」每点一次就重置）',
    )
    const notes2 = await must('GET', '/notifications?pageSize=50', { token: parent.token })
    check(
      notes2.items.filter((n) => n.type === 'child_request').length === 1,
      '重复提交不产生第二条通知',
    )

    // 改了时长就不算「同一份申请」：内容要跟着变，但仍是同一条 pending
    const changed = await submit(deviceToken, {
      kind: 'extend_time',
      minutes: 30,
      reason: '作业写完了，想玩一会儿',
    })
    check(changed.body?.id === firstId, '改时长仍是同一条（按设备+类型收敛）', String(changed.body?.id))
    pending = await list(parent.token, deviceId)
    check(pending.items[0].minutes === 30, '家长端看到的是改后的 30 分钟', String(pending.items[0].minutes))

    // 不同类型是两条：加时与延后锁屏解决的不是同一件事
    const delay = await submit(deviceToken, { kind: 'delay_lock', minutes: 15, reason: '这一局还没打完' })
    check(delay.status === 201, '另一种类型可以同时存在', String(delay.status))
    const both = await list(parent.token, deviceId)
    check(both.items.length === 2, '两种类型各占一条待审批', String(both.items.length))
    check(
      both.items.find((i) => i.kind === 'delay_lock')?.kindLabel === '申请延后锁屏',
      '「延后锁屏」有自己的中文类型名（和加时不是一件事）',
      String(both.items.find((i) => i.kind === 'delay_lock')?.kindLabel),
    )

    // ----------------------------------------------------------
    step('6. 参数校验：越界与非法的都挡在门外')
    const tooShort = await submit(deviceToken, { kind: 'extend_time', minutes: 3 })
    check(tooShort.status === 422, '少于 5 分钟被拒', String(tooShort.status))
    const tooLong = await submit(deviceToken, { kind: 'extend_time', minutes: 300 })
    check(tooLong.status === 422, '超过 240 分钟被拒', String(tooLong.status))
    const badKind = await submit(deviceToken, { kind: 'free_forever', minutes: 30 })
    check(badKind.status === 422, '未知类型被拒', String(badKind.status))
    const anon = await api('POST', '/agent/time-requests', {
      body: { kind: 'extend_time', minutes: 30 },
    })
    check(anon.status === 401, '设备未认证提交 → 401', String(anon.status))

    // ----------------------------------------------------------
    step('7. 孩子端轮询：待审批时说「还没人回」，不编结果')
    const polled = await poll(deviceToken, firstId)
    check(polled.status === 'pending', '待审批状态原样返回', String(polled.status))
    check(polled.minutes === 30, '回的是孩子申请的那个分钟数', String(polled.minutes))
    check(!polled.note, '还没有家长的话', String(polled.note))
    const missing = await api('GET', '/agent/time-requests/not-a-real-id', { token: deviceToken })
    check(missing.status === 404, '查不存在的申请 → 404', String(missing.status))

    // ----------------------------------------------------------
    step('8. 隔离：另一个家长看不到也批不了')
    // 三个层次要分清楚，混成一个「看不到」就说不清到底哪里被拦住了：
    //   不是你的设备        → 403（直接拒，不装作「就是没申请」）
    //   你的设备、没有这条申请 → 404（不泄漏别处是否存在这个 id）
    //   你自己的设备、确实没申请 → 200 + 空列表
    const otherList = await api('GET', `/device/time-requests?deviceId=${deviceId}`, { token: other.token })
    check(otherList.status === 403, '另一个家长查别人的设备 → 403', String(otherList.status))
    const missingDevice = await api('GET', '/device/time-requests?deviceId=no-such-device', {
      token: parent.token,
    })
    check(missingDevice.status === 404, '设备不存在 → 404（和「不是你的」区分开）', String(missingDevice.status))

    // 给旁观家长也绑一台设备，这样「批别人的申请」走到的是申请归属校验，
    // 而不是「你名下根本没有设备」——后者测不出隔离本身。
    const otherReg = await must('POST', '/agent/register', {
      body: {
        deviceCode: `TREQO${suffix}`.slice(0, 12),
        deviceSecret: 'e2e-time-request-other-secret-0123456789',
        model: 'E2E Bystander Device',
        os: 'Android',
        osVersion: '14',
      },
    })
    const otherBound = await must('POST', '/devices/bind', {
      token: other.token,
      body: { deviceCode: `TREQO${suffix}`.slice(0, 12), name: 'E2E 旁观机' },
    })
    const otherDeviceId = otherBound.device.id
    devicesToClean.push({ token: other.token, id: otherDeviceId })
    const ownEmpty = await list(other.token, otherDeviceId)
    check(ownEmpty.items.length === 0, '换成自己的设备查询 → 200 且确实为空', String(ownEmpty.items.length))
    const stolen = await api('POST', `/device/time-requests/${firstId}/review`, {
      token: other.token,
      body: { status: 'approved', minutes: 60, deviceId: otherDeviceId },
    })
    check(stolen.status === 404, '拿自己另一台设备去批别人的申请 → 404', String(stolen.status))
    const stillPending = await list(parent.token, deviceId)
    check(
      stillPending.items.find((i) => i.id === firstId)?.status === 'pending',
      '那条申请没有被别人改动',
      String(stillPending.items.find((i) => i.id === firstId)?.status),
    )

    // ----------------------------------------------------------
    step('9. 批准：真的下发指令，且家长只能改小不能改大')
    const overGrant = await api('POST', `/device/time-requests/${firstId}/review`, {
      token: parent.token,
      body: { status: 'approved', minutes: 240 },
    })
    check(overGrant.status === 200, '批准成功', String(overGrant.status))
    check(
      overGrant.body?.grantedMinutes === 30,
      '申请 30 分钟时批 240 分钟被夹到 30（只能改小）',
      String(overGrant.body?.grantedMinutes),
    )
    check(Boolean(overGrant.body?.command?.id), '批准同时产生了一条指令（服务端不自己宣布解锁）')
    check(
      overGrant.body?.command?.type === 'temp_unlock',
      '指令类型是 temp_unlock',
      String(overGrant.body?.command?.type),
    )
    check(
      overGrant.body?.command?.payload?.minutes === 30,
      '指令里的分钟数是夹住之后的值',
      String(overGrant.body?.command?.payload?.minutes),
    )

    // 设备真的领到它
    const claimed = await must('GET', '/agent/commands/next?wait=0', { token: deviceToken })
    check(claimed.command?.type === 'temp_unlock', '设备领到了临时解锁指令', String(claimed.command?.type))
    check(claimed.command?.id === overGrant.body?.command?.id, '就是刚下发的那一条')
    const reported = await must('POST', `/agent/commands/${claimed.command.id}/result`, {
      token: deviceToken,
      body: { status: 'succeeded', result: { unlocked: true } },
    })
    check(reported.command?.status === 'succeeded', '设备回报成功后指令终结', String(reported.command?.status))
    const devAfter = await must('GET', `/device?deviceId=${deviceId}`, { token: parent.token })
    check(devAfter.locked === false, '设备状态变成未锁定（真的落地了）', String(devAfter.locked))
    check(
      typeof devAfter.tempUnlock === 'string',
      '带上临时解锁到期时间',
      String(devAfter.tempUnlock),
    )

    // 已处理过的不能再改
    const reReview = await api('POST', `/device/time-requests/${firstId}/review`, {
      token: parent.token,
      body: { status: 'rejected' },
    })
    check(reReview.status === 409, '改已处理的申请 → 409', String(reReview.status))
    check(
      reReview.body?.message === '这条申请已经处理过了',
      '给出可直接展示的中文原因',
      String(reReview.body?.message),
    )

    // 设备端能看到结果，且拿到的是「家长实际给的」
    const polledAfter = await poll(deviceToken, firstId)
    check(polledAfter.status === 'approved', '设备轮询到「已批准」', String(polledAfter.status))
    check(polledAfter.minutes === 30, '设备拿到的是家长实际给的分钟数', String(polledAfter.minutes))

    // ----------------------------------------------------------
    step('10. 拒绝：带上家长的话，不产生任何指令')
    const delayItem = (await list(parent.token, deviceId)).items.find((i) => i.kind === 'delay_lock')
    const rejected = await api('POST', `/device/time-requests/${delayItem.id}/review`, {
      token: parent.token,
      body: { status: 'rejected', note: '先把作业做完' },
    })
    check(rejected.status === 200, '拒绝成功', String(rejected.status))
    check(rejected.body?.grantedMinutes === 0, '拒绝不批准任何时长', String(rejected.body?.grantedMinutes))
    check(!rejected.body?.command, '拒绝不下发指令（孩子端不会被解锁）')
    const polledReject = await poll(deviceToken, delayItem.id)
    check(polledReject.status === 'rejected', '设备轮询到「已拒绝」', String(polledReject.status))
    check(polledReject.note === '先把作业做完', '家长的话透传到设备端', String(polledReject.note))

    const badStatus = await api('POST', `/device/time-requests/${delayItem.id}/review`, {
      token: parent.token,
      body: { status: 'pending' },
    })
    check(badStatus.status === 422, '把状态改回 pending → 422', String(badStatus.status))

    // ----------------------------------------------------------
    step('11. 处理完：待审批清零，历史仍在')
    const pendingAfter = await list(parent.token, deviceId)
    check(pendingAfter.items.length === 0, '待审批列表清空', String(pendingAfter.items.length))
    const all = await list(parent.token, deviceId, '&status=all')
    check(all.items.length === 2, '历史里仍有两条', String(all.items.length))
    check(
      all.items.every((i) => i.status !== 'pending'),
      '历史里没有残留的 pending',
      all.items.map((i) => i.status).join(','),
    )
    check(
      all.items.find((i) => i.id === firstId)?.grantedMinutes === 30,
      '历史里记下实际批了多少分钟',
      String(all.items.find((i) => i.id === firstId)?.grantedMinutes),
    )
    const devFinal = await must('GET', `/device?deviceId=${deviceId}`, { token: parent.token })
    check(devFinal.pendingTimeRequests === 0, '设备视图角标归零', String(devFinal.pendingTimeRequests))
    const unknownStatus = await api('GET', `/device/time-requests?deviceId=${deviceId}&status=made_up`, {
      token: parent.token,
    })
    check(unknownStatus.status === 422, '未知的状态筛选被拒', String(unknownStatus.status))
    const anonList = await api('GET', `/device/time-requests?deviceId=${deviceId}`)
    check(anonList.status === 401, '未登录看申请列表 → 401', String(anonList.status))
  } finally {
    // ----------------------------------------------------------
    step('12. 清理')
    for (const { token, id } of devicesToClean) {
      const r = await api('DELETE', `/devices/${id}`, { token })
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
  }

  console.log('\n' + '═'.repeat(54))
  if (failed === 0) console.log(`\x1b[32m孩子的申请：全部通过（${passed} 项）\x1b[0m`)
  else console.log(`\x1b[31m孩子的申请：${passed} 项通过，${failed} 项失败\x1b[0m`)
  console.log('═'.repeat(54))
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('\x1b[31m验证中断：\x1b[0m', err.message)
  process.exit(1)
})
