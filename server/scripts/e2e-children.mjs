#!/usr/bin/env node
/**
 * 孩子档案与「今日任务」端到端验证（规划 §5.2）。
 *
 * §5.2 要的是「孩子」这个实体本身：周报、年龄适配、多台设备属于同一个孩子
 * 都要有落脚点。此前系统里只有设备，于是双胞胎的两台手机毫无关联。
 *
 * 这个脚本验的不是「接口能通」，而是四条更容易做错的：
 *
 *   1. **别人家的孩子一律 404，不是 403**。403 等于承认「这个 id 存在，只是不归你」——
 *      遍历 childId 就能数出别家有几个孩子。所以越权读/改一律 404。
 *   2. **删档案不删设备**。`ChildDevice.childId` 是 `onDelete: SetNull`：
 *      家长整理档案不该把孩子的手机从系统里抹掉。
 *   3. **挂设备要求设备主人**，家庭成员（§5.1 的 admin 成员）**看不到也改不了**
 *      别人家孩子的档案 —— 被邀请来看设备，不等于获得「给这个孩子改名」的权力。
 *   4. **设备勾任务必须勾自己孩子的**，而且同一个任务只提醒家长一次
 *      （孩子反复勾上又取消不能变成对家长的轰炸）。
 *
 * 用法：node scripts/e2e-children.mjs   （默认 http://localhost:4000/api）
 *
 * 需要跑着的后端 + 已 seed 的库。脚本自己注册一次性家长账号与设备，结束全部删除。
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
    body: { phone, password: 'e2e-children-123', code: sent.devCode, nickname: tag },
  })
  return { token: reg.token, userId: reg.user?.id ?? null, phone }
}

async function registerDevice(prefix) {
  const suffix = Date.now().toString(36).toUpperCase().slice(-5)
  const deviceCode = `${prefix}${suffix}`.slice(0, 12)
  const reg = await must('POST', '/agent/register', {
    body: {
      deviceCode,
      deviceSecret: `e2e-children-secret-${suffix}`,
      model: 'E2E Children Device',
      os: 'Android',
      osVersion: '14',
    },
  })
  return { deviceCode, deviceToken: reg.deviceToken }
}

/** 家长 A 名下两台已认领设备 + 一台设备令牌。 */
async function bindDevice(token, prefix) {
  const reg = await registerDevice(prefix)
  const bound = await must('POST', '/devices/bind', {
    token,
    body: { deviceCode: reg.deviceCode, name: `E2E ${prefix}` },
  })
  return { id: bound.device.id, token: reg.deviceToken, deviceCode: reg.deviceCode }
}

const children = (token) => must('GET', '/children', { token })
const tasksOf = (token, childId, date) =>
  must('GET', `/children/${childId}/tasks${date ? `?date=${date}` : ''}`, { token })

const today = () => {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

const notificationOf = async (token, type) =>
  (await must('GET', '/notifications?pageSize=50', { token })).items.filter((n) => n.type === type)

async function main() {
  console.log('\x1b[1m气球狗 · 孩子档案与今日任务端到端验证（§5.2）\x1b[0m')
  console.log(`  API ${API}`)

  const devicesToClean = []
  const userIds = []

  const parent = await registerParent('孩子档案E2E')
  userIds.push(parent.userId)
  const stranger = await registerParent('孩子档案E2E旁观')
  userIds.push(stranger.userId)
  // 家庭成员 C：会被 A 邀请成设备的 admin 成员（验「成员看不到别人家孩子档案」）
  const member = await registerParent('孩子档案E2E成员')
  userIds.push(member.userId)

  try {
    // ----------------------------------------------------------
    step('1. 准备：一台设备 + 一个孩子档案')
    // 免费额度是 1 台设备（FREE_DEVICE_LIMIT），所以每个家长只绑一台 ——
    // 「一台设备属于哪个孩子」的整组替换用一台 + 空清单 + 重复 deviceId 同样验得出来。
    const studyPhone = await bindDevice(parent.token, 'CHLD1')
    devicesToClean.push({ token: parent.token, id: studyPhone.id })
    const created = await must('POST', '/children', {
      token: parent.token,
      body: { name: '小明', birthYear: new Date().getFullYear() - 9, school: '实验小学' },
    })
    const childId = created.child.id
    check(created.child.name === '小明', '创建孩子档案成功', created.child.name)
    check(created.child.userId === parent.userId, '档案归属创建它的家长账号', String(created.child.userId))
    check(created.child.avatar === '' && created.child.school === '实验小学', '未填字段有默认值', JSON.stringify(created.child.school))

    // ----------------------------------------------------------
    step('2. 列表：年龄现算，不落库')
    const list = await children(parent.token)
    check(list.children.length === 1, '列表里有 1 个孩子', String(list.children.length))
    check(list.children[0].age === 9, '年龄按出生年份现算（9 岁）', String(list.children[0].age))
    check(list.children[0].todayTasks.total === 0, '新档案今天没有任务', String(list.children[0].todayTasks.total))
    const noBirth = await must('POST', '/children', { token: parent.token, body: { name: '小红' } })
    const list2 = await children(parent.token)
    const hong = list2.children.find((c) => c.id === noBirth.child.id)
    check(hong.age === null && hong.birthYear === null, '没填出生年份时 age 是 null 而不是 0', String(hong.age))

    // ----------------------------------------------------------
    step('3. 校验：空名字 / 荒唐的出生年份 / 名额上限')
    const emptyName = await api('POST', '/children', { token: parent.token, body: { name: '   ' } })
    check(emptyName.status === 422, '空名字 → 422', String(emptyName.status))
    // 视图层校验的顶层 message 是笼统的「有 N 项未通过校验」，人话在 detail / errors 里
    // （前端表单要按字段显示，靠的是 errors[].path + message）
    check(
      String(emptyName.body?.detail).includes('请填写孩子的称呼') &&
        emptyName.body?.errors?.[0]?.path === 'name',
      '字段级文案是人话且带字段路径（前端直接展示）',
      `${emptyName.body?.detail} / ${JSON.stringify(emptyName.body?.errors?.[0]?.path)}`,
    )
    const futureYear = await api('POST', '/children', {
      token: parent.token,
      body: { name: '未来人', birthYear: new Date().getFullYear() + 1 },
    })
    check(futureYear.status === 422, '出生年份在未来 → 422', String(futureYear.status))
    const ancientYear = await api('POST', '/children', {
      token: parent.token,
      body: { name: '古代人', birthYear: 1900 },
    })
    check(ancientYear.status === 422, '出生年份早于 1990 → 422', String(ancientYear.status))
    const longName = await api('POST', '/children', { token: parent.token, body: { name: '名'.repeat(21) } })
    check(longName.status === 422, '称呼超过 20 字 → 422', String(longName.status))
    // 已用掉 2 个名额，再建 3 个到上限
    for (let i = 0; i < 3; i++) {
      await must('POST', '/children', { token: parent.token, body: { name: `名额${i}` } })
    }
    const overLimit = await api('POST', '/children', { token: parent.token, body: { name: '第六个' } })
    check(overLimit.status === 409, '超过 5 个名额 → 409', String(overLimit.status))
    // 清理掉多余档案，后面的断言只关心小明
    for (const c of (await children(parent.token)).children) {
      if (c.id !== childId) await must('DELETE', `/children/${c.id}`, { token: parent.token })
    }
    check((await children(parent.token)).children.length === 1, '多余档案已删掉，只剩小明')

    // ----------------------------------------------------------
    step('4. 修改档案')
    const patch = await must('PATCH', `/children/${childId}`, {
      token: parent.token,
      body: { name: '小明（四年级）', school: '实验二小' },
    })
    check(patch.child.name === '小明（四年级）', '改名生效', patch.child.name)
    check(patch.child.school === '实验二小', '改学校生效', patch.child.school)
    const emptyPatch = await api('PATCH', `/children/${childId}`, { token: parent.token, body: {} })
    check(emptyPatch.status === 422, '空修改 → 422（不是静默成功）', String(emptyPatch.status))

    // ----------------------------------------------------------
    step('5. 越权：别人家的孩子一律 404，不是 403')
    const strangerList = await children(stranger.token)
    check(strangerList.children.length === 0, '旁观家长的列表为空', String(strangerList.children.length))
    const readOther = await api('GET', `/children/${childId}/tasks`, { token: stranger.token })
    check(readOther.status === 404, '读别人家孩子的任务 → 404', String(readOther.status))
    const writeOther = await api('PATCH', `/children/${childId}`, {
      token: stranger.token,
      body: { name: '改你的' },
    })
    check(writeOther.status === 404, '改别人家孩子 → 404', String(writeOther.status))
    const delOther = await api('DELETE', `/children/${childId}`, { token: stranger.token })
    check(delOther.status === 404, '删别人家孩子 → 404', String(delOther.status))
    const addOther = await api('POST', `/children/${childId}/tasks`, {
      token: stranger.token,
      body: { title: '偷加的任务' },
    })
    check(addOther.status === 404, '往别人家孩子身上加任务 → 404', String(addOther.status))

    // ----------------------------------------------------------
    step('6. 挂设备：整组替换 + 只认自己的设备')
    const one = await must('PUT', `/children/${childId}/devices`, {
      token: parent.token,
      body: { deviceIds: [studyPhone.id] },
    })
    check(one.devices.length === 1 && one.devices[0].id === studyPhone.id, '挂上设备', JSON.stringify(one.devices.map((d) => d.id)))
    const repeat = await must('PUT', `/children/${childId}/devices`, {
      token: parent.token,
      body: { deviceIds: [studyPhone.id, studyPhone.id] },
    })
    check(repeat.devices.length === 1, '重复 deviceId 被去重（不是挂两次）', String(repeat.devices.length))
    const listAfterAssign = await children(parent.token)
    check(listAfterAssign.children[0].devices.length === 1, '列表里能看到这个孩子的设备', String(listAfterAssign.children[0].devices.length))
    const missingDevice = await api('PUT', `/children/${childId}/devices`, {
      token: parent.token,
      body: { deviceIds: ['does-not-exist'] },
    })
    check(missingDevice.status === 404, '挂一台不存在的设备 → 404', String(missingDevice.status))
    check((await children(parent.token)).children[0].devices.length === 1, '失败的那次没有把原来的归属清掉（事务）', String((await children(parent.token)).children[0].devices.length))
    // 别人家的设备挂到自己孩子名下 → 403（档案是自己的，设备不是）
    const strangerPhone = await bindDevice(stranger.token, 'CHLD3')
    devicesToClean.push({ token: stranger.token, id: strangerPhone.id })
    const foreignDevice = await api('PUT', `/children/${childId}/devices`, {
      token: parent.token,
      body: { deviceIds: [strangerPhone.id] },
    })
    check(foreignDevice.status === 403, '往自己孩子名下挂别人家设备 → 403', String(foreignDevice.status))
    check(
      foreignDevice.body?.message === '只有设备的主人可以把设备挂到孩子档案上',
      '403 文案说明白原因',
      String(foreignDevice.body?.message),
    )
    // 别人来挂我的孩子：连档案都看不到 → 404（不是 403）
    const strangerChild = await must('POST', '/children', { token: stranger.token, body: { name: '别家小孩' } })
    const steal = await api('PUT', `/children/${childId}/devices`, {
      token: stranger.token,
      body: { deviceIds: [strangerPhone.id] },
    })
    check(steal.status === 404, '别人家的孩子（连档案都看不到）→ 404', String(steal.status))
    check(strangerChild.child.name === '别家小孩', '旁观家长可以有自己的孩子档案', strangerChild.child.name)
    const detached = await must('PUT', `/children/${childId}/devices`, {
      token: parent.token,
      body: { deviceIds: [] },
    })
    check(detached.devices.length === 0, '整组替换会把没列出的设备摘下来', String(detached.devices.length))
    await must('PUT', `/children/${childId}/devices`, {
      token: parent.token,
      body: { deviceIds: [studyPhone.id] },
    })
    check((await children(parent.token)).children[0].devices.length === 1, '再挂回来', String((await children(parent.token)).children[0].devices.length))

    // ----------------------------------------------------------
    step('7. 今日任务：家长侧 CRUD')
    const task1 = await must('POST', `/children/${childId}/tasks`, {
      token: parent.token,
      body: { title: '练琴 30 分钟' },
    })
    check(task1.task.done === false, '新任务是未完成', String(task1.task.done))
    check(task1.task.date === today(), '不传日期就是今天（服务器本地日）', task1.task.date)
    const emptyTitle = await api('POST', `/children/${childId}/tasks`, {
      token: parent.token,
      body: { title: '  ' },
    })
    check(emptyTitle.status === 422, '空任务内容 → 422', String(emptyTitle.status))
    const longTitle = await api('POST', `/children/${childId}/tasks`, {
      token: parent.token,
      body: { title: '任'.repeat(51) },
    })
    check(longTitle.status === 422, '任务超过 50 字 → 422', String(longTitle.status))
    const oddDate = await api('POST', `/children/${childId}/tasks`, {
      token: parent.token,
      body: { title: '明天', date: '2026/01/01' },
    })
    check(oddDate.status === 422, '日期格式不对 → 422（不接受 2026/01/01）', String(oddDate.status))
    await must('POST', `/children/${childId}/tasks`, {
      token: parent.token,
      body: { title: '读英语 20 分钟' },
    })
    const todayTasks = await tasksOf(parent.token, childId)
    check(todayTasks.total === 2 && todayTasks.done === 0, '今天有 2 个任务、0 个完成', `${todayTasks.total}/${todayTasks.done}`)
    check(todayTasks.tasks[0].title === '练琴 30 分钟', '按创建顺序返回', todayTasks.tasks[0].title)
    const tomorrow = await must('POST', `/children/${childId}/tasks`, {
      token: parent.token,
      body: { title: '明天的任务', date: '2999-12-31' },
    })
    const todayAgain = await tasksOf(parent.token, childId)
    check(todayAgain.total === 2, '别的日期的任务不会混进今天', String(todayAgain.total))
    const thatDay = await tasksOf(parent.token, childId, '2999-12-31')
    check(thatDay.total === 1 && thatDay.tasks[0].id === tomorrow.task.id, '按日期查询能查到那一天', String(thatDay.total))
    await must('DELETE', `/children/${childId}/tasks/${tomorrow.task.id}`, { token: parent.token })
    check((await tasksOf(parent.token, childId, '2999-12-31')).total === 0, '删任务生效')
    const delAgain = await api('DELETE', `/children/${childId}/tasks/${tomorrow.task.id}`, { token: parent.token })
    check(delAgain.status === 404, '删已删掉的任务 → 404', String(delAgain.status))

    // 家长自己勾完成：不发通知（家长自己点的），且重复点不刷新完成时间
    const done1 = await must('PATCH', `/children/${childId}/tasks/${task1.task.id}`, {
      token: parent.token,
      body: { done: true },
    })
    check(done1.task.done === true && done1.task.doneAt != null, '家长可以代勾完成', String(done1.task.done))
    const stamp = done1.task.doneAt
    await new Promise((r) => setTimeout(r, 1100))
    const done2 = await must('PATCH', `/children/${childId}/tasks/${task1.task.id}`, {
      token: parent.token,
      body: { done: true },
    })
    check(done2.task.doneAt === stamp, '重复勾完成不会把时间刷成现在', `${stamp} → ${done2.task.doneAt}`)
    const undone = await must('PATCH', `/children/${childId}/tasks/${task1.task.id}`, {
      token: parent.token,
      body: { done: false },
    })
    check(undone.task.done === false && undone.task.doneAt === null, '取消完成会清掉完成时间', String(undone.task.doneAt))
    const parentNotes = await notificationOf(parent.token, 'child_task')
    check(parentNotes.length === 0, '家长自己勾完成不发通知（自己点的不打扰自己）', String(parentNotes.length))

    // ----------------------------------------------------------
    step('8. 孩子端：child-home 带上任务，设备勾掉后家长收到通知')
    const home = await must('GET', '/agent/child-home', { token: studyPhone.token })
    check(home.childName === '小明（四年级）', 'child-home 带回孩子姓名', String(home.childName))
    check(home.tasks.length === 2, 'child-home 带回今天的任务', String(home.tasks.length))
    check(home.tasks.every((t) => t.done === false), '都还没完成', JSON.stringify(home.tasks.map((t) => t.done)))

    const deviceDone = await must('POST', `/agent/tasks/${task1.task.id}`, {
      token: studyPhone.token,
      body: { done: true },
    })
    check(deviceDone.task.done === true, '设备端能勾掉任务', String(deviceDone.task.done))
    const notesAfter = await notificationOf(parent.token, 'child_task')
    check(notesAfter.length === 1, '家长收到一条「今日任务」通知', String(notesAfter.length))
    check(notesAfter[0].titleParams?.v0 === '小明（四年级）', '通知标题带的是孩子姓名', JSON.stringify(notesAfter[0].titleParams))
    check(notesAfter[0].titleParams?.v1 === '练琴 30 分钟', '通知标题带的是任务内容', JSON.stringify(notesAfter[0].titleParams))
    check(notesAfter[0].level === 'info', '级别是 info（好消息不抢红点）', String(notesAfter[0].level))
    check(notesAfter[0].linkPath === '/children', '点击跳到孩子档案页', String(notesAfter[0].linkPath))
    check(notesAfter[0].deviceId === studyPhone.id, '通知带 deviceId（能追到是哪台设备）', String(notesAfter[0].deviceId))

    await must('POST', `/agent/tasks/${task1.task.id}`, { token: studyPhone.token, body: { done: true } })
    check((await notificationOf(parent.token, 'child_task')).length === 1, '重复勾选不再发第二条', String((await notificationOf(parent.token, 'child_task')).length))
    await must('POST', `/agent/tasks/${task1.task.id}`, { token: studyPhone.token, body: { done: false } })
    await must('POST', `/agent/tasks/${task1.task.id}`, { token: studyPhone.token, body: { done: true } })
    check(
      (await notificationOf(parent.token, 'child_task')).length === 1,
      '取消后重新完成也只提醒一次（反复勾选不轰炸家长）',
      String((await notificationOf(parent.token, 'child_task')).length),
    )

    // 设备只能勾自己孩子的任务：「没挂档案」与「不存在的任务」都必须是 404
    await must('PUT', `/children/${childId}/devices`, { token: parent.token, body: { deviceIds: [] } })
    const noChild = await api('POST', `/agent/tasks/${task1.task.id}`, {
      token: studyPhone.token,
      body: { done: true },
    })
    check(noChild.status === 404, '没挂孩子档案的设备勾任务 → 404', String(noChild.status))
    await must('PUT', `/children/${childId}/devices`, {
      token: parent.token,
      body: { deviceIds: [studyPhone.id] },
    })
    const unknownTask = await api('POST', '/agent/tasks/does-not-exist', {
      token: studyPhone.token,
      body: { done: true },
    })
    check(unknownTask.status === 404, '不存在的任务 → 404', String(unknownTask.status))

    // 摘掉孩子档案后，child-home 回到「空清单」而不是报错
    await must('PUT', `/children/${childId}/devices`, { token: parent.token, body: { deviceIds: [] } })
    const homeNoChild = await must('GET', '/agent/child-home', { token: studyPhone.token })
    check(homeNoChild.childName === null && homeNoChild.tasks.length === 0, '设备摘掉档案后 child-home 是空清单', JSON.stringify(homeNoChild.childName))

    // ----------------------------------------------------------
    step('9. 家庭成员（§5.1）看不到别人家孩子的档案')
    const invited = await must('POST', `/devices/${studyPhone.id}/members`, {
      token: parent.token,
      body: { phone: member.phone, role: 'admin', nickname: '爷爷奶奶' },
    })
    check(invited.role === 'admin', '把家庭成员加成管理员', invited.role)
    const memberChildren = await children(member.token)
    check(memberChildren.children.length === 0, '成员的孩子列表是空的（不是主人家的孩子）', String(memberChildren.children.length))
    const memberRead = await api('GET', `/children/${childId}/tasks`, { token: member.token })
    check(memberRead.status === 404, '成员读主人家的孩子档案 → 404', String(memberRead.status))
    const memberWrite = await api('POST', `/children/${childId}/tasks`, {
      token: member.token,
      body: { title: '成员加的任务' },
    })
    check(memberWrite.status === 404, '成员给主人家的孩子加任务 → 404', String(memberWrite.status))
    // 成员可以正常改设备设置（§5.1 的权限没有被这次改动破坏）
    const memberToggle = await api('PUT', `/features?deviceId=${studyPhone.id}`, {
      token: member.token,
      body: { feature: 'webBlock', enabled: true },
    })
    check(memberToggle.status === 200, '成员仍然能改设备设置（§5.1 的权限没被破坏）', String(memberToggle.status))

    // ----------------------------------------------------------
    step('10. 删档案不删设备')
    const beforeDelete = await must('GET', '/devices', { token: parent.token })
    const beforeCount = beforeDelete.devices.length
    await must('DELETE', `/children/${childId}`, { token: parent.token })
    const afterDelete = await must('GET', '/devices', { token: parent.token })
    check(afterDelete.devices.length === beforeCount, '删掉孩子档案后设备还在', `${beforeCount} → ${afterDelete.devices.length}`)
    check(
      afterDelete.devices.every((d) => d.id !== undefined),
      '设备没有被连带删除（onDelete: SetNull）',
    )
    check((await children(parent.token)).children.length === 0, '档案列表空了')
    const goneTask = await api('GET', `/children/${childId}/tasks`, { token: parent.token })
    check(goneTask.status === 404, '删掉的档案不能再查任务 → 404', String(goneTask.status))
    const afterHome = await must('GET', '/agent/child-home', { token: studyPhone.token })
    check(afterHome.childName === null, '设备端也跟着回到「没有档案」', String(afterHome.childName))
  } finally {
    step('11. 清理')
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
    ok('清理完成（测试家长账号与设备都已删除）')
  }

  console.log(`\n\x1b[1m结果：${passed} 项通过 / ${failed} 项失败\x1b[0m`)
  if (failed > 0) process.exit(1)
}

main().catch((err) => {
  console.error(`\n\x1b[31m脚本中断：${err.message}\x1b[0m`)
  process.exit(1)
})
