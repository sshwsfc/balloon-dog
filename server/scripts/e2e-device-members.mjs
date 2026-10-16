#!/usr/bin/env node
/**
 * 家庭成员端到端验证（规划 §5.1）。
 *
 * §5.1 要的是「一台设备不只一个家长能看」：妈妈、外婆都能在自己的账号里看到这台设备。
 * 但这个功能真正的风险不在「能不能看到」，而在**看到之后能做什么** —— 共同守护
 * 一旦没有角色边界，任何一个被拉进来的账号都能改孩子的作息、解绑设备、再把设备
 * 转给第四个人，而设备主人对此毫不知情。
 *
 * 所以这个脚本验的是四条边界，每一条都能单独把功能变成事故：
 *
 *   1. **只读成员真的改不动**。不能只在前端把按钮藏起来 —— 直接发请求也必须 403。
 *      这里对三组不同的写入口（设备改名 / 下发锁屏指令 / 改功能设置）各打一次，
 *      因为「哪个接口忘了收紧」正是最容易出的错。
 *   2. **只有所有者能管成员**。admin 成员能改设置，但**不能**再邀请第四个人、
 *      也不能移除别人 —— 权限如果能自己复制自己，主人就会在不知情的情况下
 *      多出几个能看他孩子数据的人。
 *   3. **被移除就立刻看不见**。移除必须同时收回读权限（列表里消失、按 id 直连 403），
 *      否则「移除」只是前端不显示，对方收藏的 URL 照样能打开。
 *   4. **邀请是告知，不是静默操作**。被邀请人必须收到一条 `device_shared` 通知，
 *      而且标题/正文必须是**模板 + 参数**（英文界面靠它翻译），不能是拼好的中文句子；
 *      改角色不重发通知，重复邀请不新增第二条。
 *
 * 另外验了名单本身的几件小事：主人永远排第一（他不在 DeviceMember 表里）、
 * 手机号打码、空名单不该出现「设备没有主人」、以及 5 人上限。
 *
 * 用法：node scripts/e2e-device-members.mjs   （默认 http://localhost:4000/api）
 *
 * 需要跑着的后端 + 已 seed 的库。脚本自己注册一次性家长账号与一次性设备，
 * 结束全部删除（设备先删，再让管理员删账号）。
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
  const phone = `136${String(Date.now()).slice(-8)}${Math.floor(Math.random() * 10)}`.slice(0, 11)
  const sent = await must('POST', '/auth/send-code', { body: { phone, purpose: 'register' } })
  const reg = await must('POST', '/auth/register', {
    body: { phone, password: 'e2e-members-123', code: sent.devCode, nickname: tag },
  })
  return { token: reg.token, userId: reg.user?.id ?? null, phone }
}

async function registerDevice(prefix, name) {
  const suffix = Date.now().toString(36).toUpperCase().slice(-5)
  const deviceCode = `${prefix}${suffix}`.slice(0, 12)
  const reg = await must('POST', '/agent/register', {
    body: {
      deviceCode,
      deviceSecret: `e2e-members-secret-${suffix}`,
      model: 'E2E Members Device',
      os: 'Android',
      osVersion: '14',
    },
  })
  return { deviceCode, deviceToken: reg.deviceToken, name }
}

const members = (token, deviceId) => api('GET', `/devices/${deviceId}/members`, { token })
const invite = (token, deviceId, body) => api('POST', `/devices/${deviceId}/members`, { token, body })
const patchMember = (token, deviceId, memberId, body) =>
  api('PATCH', `/devices/${deviceId}/members/${memberId}`, { token, body })
const dropMember = (token, deviceId, memberId) =>
  api('DELETE', `/devices/${deviceId}/members/${memberId}`, { token })

/** 家长端站内通知（只看家庭邀请这一类，避免被别的生产者干扰）。 */
const sharedNotes = async (token) =>
  (await must('GET', '/notifications?pageSize=50', { token })).items.filter((n) => n.type === 'device_shared')

/** 账号能看到的设备列表里，这台设备是什么角色。 */
const viewOf = async (token, deviceId) =>
  (await must('GET', '/devices', { token })).devices.find((d) => d.id === deviceId) || null

const MASK = /^\d{3}\*{4}\d{4}$/

async function main() {
  console.log('\x1b[1m气球狗 · 家庭成员端到端验证（§5.1）\x1b[0m')
  console.log(`  API ${API}`)

  const devicesToClean = []
  const userIds = []

  const owner = await registerParent('成员E2E主人')
  const viewer = await registerParent('成员E2E只读')
  const stranger = await registerParent('成员E2E无关')
  userIds.push(owner.userId, viewer.userId, stranger.userId)

  try {
    // ----------------------------------------------------------
    step('1. 名单：主人排在第一位，他不在 DeviceMember 表里')
    const reg = await registerDevice('ME2E', 'E2E 成员验证机')
    const bound = await must('POST', '/devices/bind', {
      token: owner.token,
      body: { deviceCode: reg.deviceCode, name: 'E2E 成员验证机' },
    })
    const deviceId = bound.device.id
    devicesToClean.push({ token: owner.token, id: deviceId })
    ok(`设备已就绪（deviceId=${deviceId}）`)

    const solo = await must('GET', `/devices/${deviceId}/members`, { token: owner.token })
    check(solo.members?.length === 1, '刚绑定的设备名单里只有一行', String(solo.members?.length))
    check(solo.members?.[0]?.id === 'owner', '那一行是所有者（id=owner，不是成员记录）', String(solo.members?.[0]?.id))
    check(solo.members?.[0]?.isOwner === true, '标了 isOwner，前端据此不给「移除主人」的按钮')
    check(solo.members?.[0]?.roleLabel === '设备主人', '角色文案是「设备主人」', String(solo.members?.[0]?.roleLabel))
    check(MASK.test(solo.members?.[0]?.phone || ''), '主人手机号也打码（名单是共享的，谁也拿不到完整号码）', String(solo.members?.[0]?.phone))
    check(solo.limit === 5, '名单回上限（前端据此禁用「邀请」按钮）', String(solo.limit))
    check(solo.roleLabels?.admin === '管理员' && solo.roleLabels?.viewer === '只读', '两档角色文案都在（放在响应里，前端不再自己编一套）', JSON.stringify(solo.roleLabels))

    const ownerView = await viewOf(owner.token, deviceId)
    check(ownerView?.role === 'owner' && ownerView?.canWrite === true, '设备列表里自己是 owner / canWrite:true', JSON.stringify([ownerView?.role, ownerView?.canWrite]))
    check(ownerView?.canManageMembers === true, 'canManageMembers:true —— 只有主人能管成员')

    // ----------------------------------------------------------
    step('2. 邀请：写一条通知告诉对方，而不是静默把他加进来')
    const invited = await invite(owner.token, deviceId, { phone: viewer.phone, nickname: '外婆' })
    check(invited.status === 201, '邀请返回 201', String(invited.status))
    check(invited.body?.role === 'viewer', '默认角色是只读（不传 role 时）', String(invited.body?.role))
    check(invited.body?.nickname === '外婆', '称呼照回（列表里显示「外婆」而不是账号昵称）', String(invited.body?.nickname))
    check(MASK.test(invited.body?.phone || ''), '成员的手机号也是打码的', String(invited.body?.phone))

    const afterInvite = await must('GET', `/devices/${deviceId}/members`, { token: owner.token })
    check(afterInvite.members?.length === 2, '名单变成两行', String(afterInvite.members?.length))

    const notes = await sharedNotes(viewer.token)
    check(notes.length === 1, '被邀请人收到一条家庭成员邀请通知', String(notes.length))
    check(notes[0]?.title === '{{v0}} 邀请你一起守护「{{v1}}」', '标题是模板 + 参数，不是拼好的中文句子', String(notes[0]?.title))
    check(Boolean(notes[0]?.titleParams?.v0) && notes[0]?.titleParams?.v1 === 'E2E 成员验证机', '参数里带着邀请人和设备名', JSON.stringify(notes[0]?.titleParams))
    check(notes[0]?.body === '你的角色是 {{v0}}，{{v1}}。', '正文同样是模板 + 参数', String(notes[0]?.body))
    check(notes[0]?.type === 'device_shared', '类型是 device_shared（前端据此跳 /devices）', String(notes[0]?.type))
    check(notes[0]?.linkPath === '/devices', '通知自带跳转路径', String(notes[0]?.linkPath))

    const dup = await invite(owner.token, deviceId, { phone: viewer.phone })
    check(dup.status === 409, '重复邀请同一个人 → 409（不是静默成功）', String(dup.status))
    const self = await invite(owner.token, deviceId, { phone: owner.phone })
    check(self.status === 409, '邀请设备主人自己 → 409', String(self.status))
    const ghost = await invite(owner.token, deviceId, { phone: '13900000001' })
    check(ghost.status === 404, '邀请一个还没注册的手机号 → 404（邀请的前提是对方有账号）', String(ghost.status))
    const malformed = await invite(owner.token, deviceId, { phone: '12345' })
    check(malformed.status === 422, '手机号格式不对 → 422', String(malformed.status))

    // ----------------------------------------------------------
    step('3. 只读成员：看得到，但一个写入口都过不去')
    const viewerView = await viewOf(viewer.token, deviceId)
    check(viewerView !== null, '共享设备出现在只读成员的设备列表里')
    check(viewerView?.role === 'viewer' && viewerView?.canWrite === false, '列表里标 viewer / canWrite:false', JSON.stringify([viewerView?.role, viewerView?.canWrite]))
    check(viewerView?.canManageMembers === false, 'canManageMembers:false（前端不画「管成员」入口）')

    const viewerMembers = await members(viewer.token, deviceId)
    check(viewerMembers.status === 200, '只读成员能看成员名单（知道还有谁在看这台设备）', String(viewerMembers.status))
    const viewerFeatures = await api('GET', `/features?deviceId=${deviceId}`, { token: viewer.token })
    check(viewerFeatures.status === 200, '只读成员能读功能设置', String(viewerFeatures.status))

    const lockWrite = await api('POST', `/device/lock?deviceId=${deviceId}`, { token: viewer.token, body: { locked: true } })
    check(lockWrite.status === 403, '只读成员下发锁屏指令 → 403', String(lockWrite.status))
    check(String(lockWrite.body?.message || '').includes('只读'), '403 的文案说清是「只读成员」，不是含糊的「无权限」', String(lockWrite.body?.message))

    const renameWrite = await api('PUT', `/devices/${deviceId}`, { token: viewer.token, body: { name: '只读成员改的名字' } })
    check(renameWrite.status === 403, '只读成员改设备名 → 403', String(renameWrite.status))

    const featureWrite = await api('PUT', `/features?deviceId=${deviceId}`, {
      token: viewer.token,
      body: { feature: 'webBlock', enabled: true },
    })
    check(featureWrite.status === 403, '只读成员改功能设置 → 403', String(featureWrite.status))

    const unbind = await api('DELETE', `/devices/${deviceId}`, { token: viewer.token })
    check(unbind.status === 403, '只读成员解绑设备 → 403', String(unbind.status))
    check(String(unbind.body?.message || '').includes('主人'), '解绑被拒时说明「只有设备的主人可以」，而不是「无权限」', String(unbind.body?.message))

    const viewerInvite = await invite(viewer.token, deviceId, { phone: stranger.phone })
    check(viewerInvite.status === 403, '只读成员不能邀请别人 → 403', String(viewerInvite.status))
    const viewerPatch = await patchMember(viewer.token, deviceId, invited.body.id, { role: 'admin' })
    check(viewerPatch.status === 403, '只读成员不能给自己升权限 → 403', String(viewerPatch.status))
    const viewerDrop = await dropMember(viewer.token, deviceId, invited.body.id)
    check(viewerDrop.status === 403, '只读成员不能移除别人 → 403', String(viewerDrop.status))

    // ----------------------------------------------------------
    step('4. 无关家长：连设备存在都不该知道')
    const strangerView = await viewOf(stranger.token, deviceId)
    check(strangerView === null, '这台设备不在无关家长的列表里')
    const strangerMembers = await members(stranger.token, deviceId)
    check(strangerMembers.status === 403, '拿 deviceId 直连成员名单 → 403', String(strangerMembers.status))
    const strangerLock = await api('POST', `/device/lock?deviceId=${deviceId}`, { token: stranger.token, body: { locked: true } })
    check(strangerLock.status === 403, '拿 deviceId 直连下发指令 → 403', String(strangerLock.status))

    // ----------------------------------------------------------
    step('5. 升为管理员：能改设置，但还是管不了成员、解绑不了')
    const promoted = await patchMember(owner.token, deviceId, invited.body.id, { role: 'admin' })
    check(promoted.status === 200 && promoted.body?.role === 'admin', '改成 admin 成功', String(promoted.status))
    check(promoted.body?.roleLabel === '管理员', '角色文案跟着变', String(promoted.body?.roleLabel))
    check((await sharedNotes(viewer.token)).length === 1, '改角色不重发邀请通知（否则家长会以为又被拉了一次）')

    const adminView = await viewOf(viewer.token, deviceId)
    check(adminView?.role === 'admin' && adminView?.canWrite === true, '设备列表里 role:admin / canWrite:true', JSON.stringify([adminView?.role, adminView?.canWrite]))

    const adminRename = await api('PUT', `/devices/${deviceId}`, { token: viewer.token, body: { name: '管理员改的名字' } })
    check(adminRename.status === 200, '管理员能改设备名 → 200', String(adminRename.status))
    const adminLock = await api('POST', `/device/lock?deviceId=${deviceId}`, { token: viewer.token, body: { locked: true } })
    check(adminLock.status === 200, '管理员能下发锁屏指令 → 200（进指令队列）', String(adminLock.status))
    const adminFeature = await api('PUT', `/features?deviceId=${deviceId}`, {
      token: viewer.token,
      body: { feature: 'webBlock', enabled: true },
    })
    check(adminFeature.status === 200, '管理员能改功能设置 → 200', String(adminFeature.status))

    const adminUnbind = await api('DELETE', `/devices/${deviceId}`, { token: viewer.token })
    check(adminUnbind.status === 403, '管理员仍然不能解绑设备 → 403', String(adminUnbind.status))
    const adminInvite = await invite(viewer.token, deviceId, { phone: stranger.phone })
    check(adminInvite.status === 403, '管理员不能再邀请第四个人 → 403（权限不自我复制）', String(adminInvite.status))
    const adminDrop = await dropMember(viewer.token, deviceId, invited.body.id)
    check(adminDrop.status === 403, '管理员不能移除成员 → 403', String(adminDrop.status))

    const renamed = await must('PUT', `/devices/${deviceId}`, { token: owner.token, body: { name: 'E2E 成员验证机' } })
    check(renamed.device?.name === 'E2E 成员验证机', '主人改回原名（后续断言依赖它）')

    // ----------------------------------------------------------
    step('6. 移除：读权限当场收回，不是前端不显示')
    const removed = await dropMember(owner.token, deviceId, invited.body.id)
    check(removed.status === 200, '移除成员成功', String(removed.status))
    const left = await must('GET', `/devices/${deviceId}/members`, { token: owner.token })
    check(left.members?.length === 1, '名单回到只剩主人', String(left.members?.length))
    check((await viewOf(viewer.token, deviceId)) === null, '被移除后设备从他的列表里消失')
    const afterRemove = await members(viewer.token, deviceId)
    check(afterRemove.status === 403, '被移除后拿 deviceId 直连 → 403（收藏的链接也进不去）', String(afterRemove.status))
    const again = await dropMember(owner.token, deviceId, invited.body.id)
    check(again.status === 404, '再删一次同一条成员记录 → 404', String(again.status))

    // ----------------------------------------------------------
    step('7. 上限 5 人：第 6 个被挡住，腾出一个名额后又能加')
    const fillers = []
    for (let i = 0; i < 4; i++) {
      const p = await registerParent(`成员E2E填充${i}`)
      userIds.push(p.userId)
      const r = await invite(owner.token, deviceId, { phone: p.phone })
      if (r.status !== 201) bad(`第 ${i + 2} 位成员应该能加进来`, String(r.status))
      fillers.push({ ...p, memberId: r.body?.id })
    }
    // 上限算的是**成员数**（主人不在 DeviceMember 表里，不占名额）
    const atLimit = await invite(owner.token, deviceId, { phone: stranger.phone })
    check(atLimit.status === 201, '第 5 位成员刚好还能加（上限是成员数，主人不占名额）', String(atLimit.status))

    const full = await must('GET', `/devices/${deviceId}/members`, { token: owner.token })
    check(full.members?.length === 6, '现在 1 位主人 + 5 位成员', String(full.members?.length))
    check(full.members?.filter((m) => MASK.test(m.phone || '')).length === full.members.length, '名单里每个手机号都是打码的')

    const overflowParent = await registerParent('成员E2E超限')
    userIds.push(overflowParent.userId)
    const overflow = await invite(owner.token, deviceId, { phone: overflowParent.phone })
    check(overflow.status === 409, '第 6 位成员 → 409', String(overflow.status))
    check(String(overflow.body?.message || '').includes('5'), '错误文案说清上限是 5', String(overflow.body?.message))

    await dropMember(owner.token, deviceId, fillers[0].memberId)
    const freed = await invite(owner.token, deviceId, { phone: overflowParent.phone })
    check(freed.status === 201, '腾出一个名额后，之前被拒的邀请能成功', String(freed.status))

    // ----------------------------------------------------------
    step('8. 设备端不受影响：这一切只发生在家长侧')
    const agentHome = await api('GET', '/agent/child-home', { token: reg.deviceToken })
    check(agentHome.status === 200, '设备端 child-home 照常 200', String(agentHome.status))
    check(agentHome.body?.parentPhone === owner.phone, '设备端看到的仍是设备主人的手机号（不是成员里随便谁的）', String(agentHome.body?.parentPhone))
  } finally {
    console.log('\n\x1b[1m清理\x1b[0m')
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
    ok('清理完成（测试设备与家长账号都已删除）')
  }

  console.log(`\n\x1b[1m结果：${passed} 项通过 / ${failed} 项失败\x1b[0m`)
  if (failed > 0) process.exit(1)
}

main().catch((err) => {
  console.error(`\n\x1b[31m脚本中断：${err.message}\x1b[0m`)
  process.exit(1)
})
