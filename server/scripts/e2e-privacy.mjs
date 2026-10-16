#!/usr/bin/env node
/**
 * 合规留痕、数据导出与注销端到端验证（规划 §5.3）。
 *
 * §5.3 要的四件事：家长同意书留痕、孩子端知情（§3.4 已交付，这里不重复验）、
 * 数据导出/删除、最小必要采集说明。这个脚本验的不是「接口能通」，
 * 而是六条最容易做成假合规的地方：
 *
 *   1. **撤回同意要真的停监控**：立刻解绑这个账号下的所有设备。只改状态位、
 *      设备继续上报，是最恶心的假合规。
 *   2. **同意记录只追加**：撤回写 revokedAt，重新同意写新行；「当时同意的是哪一版」要查得到。
 *   3. **版本不匹配必须拒绝**：客户端拿旧版来同意 → 409，不能默认同意新文本。
 *   4. **导出只能导出自己的**：另一个家长的设备名/孩子名不能出现在我的导出里；
 *      密码哈希、微信 openid、身份证哈希也不能出现。
 *   5. **注销有 7 天冷静期，且监控立刻停**；到期由清扫**真的删库**，
 *      并且**先删磁盘文件**——只删数据库行不删文件等于没删。
 *   6. **删除是级联的**：设备、孩子、任务、同意记录、流水全部跟着走。
 *
 * 用法：node scripts/e2e-privacy.mjs   （默认 http://localhost:4000/api）
 *
 * 需要跑着的后端 + 已 seed 的库。脚本自己注册一次性家长账号与设备，结束全部删除。
 * 其中「到期清扫」这几条要直接拨数据库里的时间戳，所以会动态 import @prisma/client ——
 * 拿不到数据库时这几条**明确跳过并标注**，不假装通过。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const API = process.env.API_BASE || 'http://localhost:4000/api'
const ADMIN_USER = process.env.ADMIN_USER || 'admin'
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'balloon-admin-2026'
const HERE = path.dirname(fileURLToPath(import.meta.url))
// 与后端 config.MEDIA_DIR 的默认值（相对 server/ 的 uploads）对齐
const UPLOAD_DIR = process.env.MEDIA_DIR || path.resolve(HERE, '..', 'uploads')

let passed = 0
let failed = 0
const ok = (m) => { passed++; console.log(`  \x1b[32m✓\x1b[0m ${m}`) }
const bad = (m, extra = '') => { failed++; console.log(`  \x1b[31m✗\x1b[0m ${m}${extra ? ` — ${extra}` : ''}`) }
const check = (c, m, extra = '') => (c ? ok(m) : bad(m, extra))
const skip = (m, why) => { console.log(`  \x1b[33m•\x1b[0m ${m}（跳过：${why}）`) }
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
    body: { phone, password: 'e2e-privacy-123', code: sent.devCode, nickname: tag },
  })
  return { token: reg.token, userId: reg.user?.id ?? null, phone, password: 'e2e-privacy-123' }
}

async function registerDevice(prefix) {
  const suffix = Date.now().toString(36).toUpperCase().slice(-5)
  const deviceCode = `${prefix}${suffix}`.slice(0, 12)
  const reg = await must('POST', '/agent/register', {
    body: {
      deviceCode,
      deviceSecret: `e2e-privacy-secret-${suffix}`,
      model: 'E2E Privacy Device',
      os: 'Android',
      osVersion: '14',
    },
  })
  return { deviceCode, deviceToken: reg.deviceToken }
}

async function bindDevice(token, prefix, name) {
  const reg = await registerDevice(prefix)
  const bound = await must('POST', '/devices/bind', {
    token,
    body: { deviceCode: reg.deviceCode, name },
  })
  return { id: bound.device.id, token: reg.deviceToken, deviceCode: reg.deviceCode }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const docs = (token) => must('GET', '/privacy/docs', { token })
const consents = (token) => must('GET', '/privacy/consents', { token }).then((r) => r.consents)
const consentOf = async (token, docType) => (await consents(token)).find((c) => c.docType === docType)

async function main() {
  console.log('\x1b[1m气球狗 · 合规留痕 / 导出 / 注销端到端验证（§5.3）\x1b[0m')
  console.log(`  API ${API}`)

  let prisma = null
  try {
    const mod = await import('@prisma/client')
    prisma = new mod.PrismaClient()
    await prisma.$queryRaw`SELECT 1`
  } catch {
    prisma = null
  }

  const userIds = []
  const deviceIds = []

  const parent = await registerParent('合规E2E')
  userIds.push(parent.userId)
  const stranger = await registerParent('合规E2E旁观')
  userIds.push(stranger.userId)
  // C 是注销的受害者：一台设备 + 一个假媒体文件，用来验「先删文件再删库」
  const victim = await registerParent('合规E2E注销')
  userIds.push(victim.userId)

  try {
    // ----------------------------------------------------------
    step('1. 准备：三台设备、两个孩子、一条任务、一个磁盘上的媒体文件')
    const myPhone = await bindDevice(parent.token, 'PRIV1', 'E2E 我的设备')
    deviceIds.push(myPhone.id)
    const otherPhone = await bindDevice(stranger.token, 'PRIV2', '旁观者的设备')
    deviceIds.push(otherPhone.id)
    const doomedPhone = await bindDevice(victim.token, 'PRIV3', '要注销的设备')
    deviceIds.push(doomedPhone.id)

    const myChild = await must('POST', '/children', {
      token: parent.token,
      body: { name: '合规测试娃', birthYear: new Date().getFullYear() - 8, school: '测试小学' },
    })
    await must('POST', `/children/${myChild.child.id}/tasks`, {
      token: parent.token,
      body: { title: '导出里应该看到这条任务' },
    })
    const otherChild = await must('POST', '/children', {
      token: stranger.token,
      body: { name: '旁观者的孩子' },
    })
    check(myPhone.id !== otherPhone.id && myChild.child.id !== otherChild.child.id, '三个家长各就各位')

    let mediaFile = null
    let mediaId = null
    if (prisma) {
      mediaFile = `e2e-privacy-${Date.now()}.jpg`
      fs.writeFileSync(path.join(UPLOAD_DIR, mediaFile), Buffer.from([0xff, 0xd8, 0xff, 0xe0]))
      const row = await prisma.mediaAsset.create({
        data: {
          deviceId: doomedPhone.id,
          userId: victim.userId,
          kind: 'photo',
          filename: mediaFile,
          mimeType: 'image/jpeg',
          sizeBytes: 4,
        },
      })
      mediaId = row.id
      check(fs.existsSync(path.join(UPLOAD_DIR, mediaFile)), '伪造一个「孩子的照片」落在磁盘上', mediaFile)
    } else {
      skip('伪造一个落在磁盘上的媒体文件', '拿不到 @prisma/client')
    }

    // ----------------------------------------------------------
    step('2. 文本目录：版本、两个文档、最小必要采集清单')
    const noToken = await api('GET', '/privacy/docs')
    check(noToken.status === 401, '未登录读隐私接口 → 401', String(noToken.status))
    const catalog = await docs(parent.token)
    check(typeof catalog.version === 'string' && catalog.version.length >= 8, '文本目录带版本号', String(catalog.version))
    check(catalog.docs.length === 2, '两份文本：监护授权 + 未成年人告知', String(catalog.docs.length))
    check(
      catalog.docs.every((d) => d.version === catalog.version && d.sections.length >= 5),
      '每份文本都有版本号与分节',
      catalog.docs.map((d) => `${d.docType}:${d.sections.length}`).join(' '),
    )
    check(catalog.docs.every((d) => d.required === true), '两份都是必读（同意是绑定的前提）')
    check(catalog.collection.length >= 9, '最小必要采集清单有条目', String(catalog.collection.length))
    check(
      catalog.collection.some((c) => c.retention.includes('默认 7 天')),
      '截屏的保留期限写的是真的会执行的 7 天',
    )
    check(catalog.deletionGraceDays === 7, '冷静期 7 天由服务端下发', String(catalog.deletionGraceDays))
    check(catalog.deletionConfirmText === '删除我的账号', '注销要求手动打确认文字')

    // ----------------------------------------------------------
    step('3. 同意：幂等、版本核对、认不出的文本')
    const before = await consents(parent.token)
    check(before.length === 2, '两份文本都在列表里', String(before.length))
    check(before.every((c) => !c.accepted && c.record === null), '一开始都没有同意过')
    check(before.every((c) => c.history.length === 0), '也没有历史记录')

    const first = await api('POST', '/privacy/consents', {
      token: parent.token,
      body: { docType: 'guardian_agreement', docVersion: catalog.version },
    })
    check(first.status === 201 && first.body.created === true, '同意监护授权 → 201', String(first.status))
    const again = await api('POST', '/privacy/consents', {
      token: parent.token,
      body: { docType: 'guardian_agreement', docVersion: catalog.version },
    })
    check(again.status === 200 && again.body.created === false, '同一版重复同意是幂等的（不新增记录）', String(again.status))
    const afterFirst = await consentOf(parent.token, 'guardian_agreement')
    check(afterFirst.accepted === true && afterFirst.history.length === 1, '同一版只留一行')
    check(afterFirst.record.acceptedAt && afterFirst.record.revokedAt === null, '记录带同意时间且未撤回')

    await must('POST', '/privacy/consents', {
      token: parent.token,
      body: { docType: 'minor_data_notice', docVersion: catalog.version },
    })
    const bothAccepted = await consents(parent.token)
    check(bothAccepted.every((c) => c.accepted), '两份都同意后就都置为已同意')

    const stale = await api('POST', '/privacy/consents', {
      token: parent.token,
      body: { docType: 'guardian_agreement', docVersion: '2000-01-01' },
    })
    check(stale.status === 409, '拿旧版本号来同意 → 409', String(stale.status))
    check(
      typeof stale.body?.message === 'string' && stale.body.message.includes('重新阅读'),
      '旧版本的报错是人话（要求重新阅读）',
      String(stale.body?.message),
    )
    const unknown = await api('POST', '/privacy/consents', {
      token: parent.token,
      body: { docType: 'not_a_doc', docVersion: catalog.version },
    })
    check(unknown.status === 404, '认不出的文本 → 404（不是笼统的 422）', String(unknown.status))
    const noVersion = await api('POST', '/privacy/consents', {
      token: parent.token,
      body: { docType: 'guardian_agreement' },
    })
    check(noVersion.status === 422, '不带版本号的同意 → 422', String(noVersion.status))

    // ----------------------------------------------------------
    step('4. 导出：自己的数据 + 别人的不出现在里面 + 不留秘密')
    const exported = await must('GET', '/privacy/export', { token: parent.token })
    check(exported.account?.id === parent.userId, '导出的是我自己的账号', String(exported.account?.id))
    check(exported.devices.some((d) => d.id === myPhone.id), '我的设备在导出里')
    check(exported.children.some((c) => c.name === '合规测试娃'), '我的孩子档案在导出里')
    check(exported.tasks.some((t) => t.title === '导出里应该看到这条任务'), '我布置的任务在导出里')
    check(exported.consents.length === 2, '同意记录跟着导出（这是留痕的一部分）', String(exported.consents.length))
    check(Array.isArray(exported.truncated), '导出带 truncated 标记（不假装是全量）')
    check(exported.collection.length >= 9, '导出里也带上最小必要采集清单')
    check(Array.isArray(exported.notes) && exported.notes.length >= 3, '导出里写清了「文件本身不在导出里」等边界')

    const flat = JSON.stringify(exported)
    check(!flat.includes('旁观者的设备'), '别的家长的设备名不出现在我的导出里')
    check(!flat.includes('旁观者的孩子'), '别的家长的孩子档案不出现在我的导出里')
    check(!flat.includes('passwordHash') && !flat.includes('wechatOpenid'), '导出里没有密码哈希与微信 openid')
    check(!flat.includes('idCardHash'), '导出里没有身份证哈希')
    check(exported.privacyRequests.length === 0, '第一次导出时还没有导出流水（流水在导出之后写）')

    const second = await must('GET', '/privacy/export', { token: parent.token })
    check(
      second.privacyRequests.some((r) => r.kind === 'export' && r.status === 'done'),
      '第二次导出能看到第一次的导出流水',
    )

    // ----------------------------------------------------------
    step('5. 撤回同意：解绑所有设备，监控当场停止')
    const guardian = await consentOf(parent.token, 'guardian_agreement')
    const wrongConfirm = await api('POST', `/privacy/consents/${guardian.record.id}/revoke`, {
      token: parent.token,
      body: { password: parent.password, confirm: '随便写点什么' },
    })
    check(wrongConfirm.status === 400, '确认文字不对 → 400', String(wrongConfirm.status))
    check(String(wrongConfirm.body?.message).includes('撤回同意'), '报错里点名了要打的那句话')
    const wrongPassword = await api('POST', `/privacy/consents/${guardian.record.id}/revoke`, {
      token: parent.token,
      body: { password: 'not-my-password', confirm: '撤回同意' },
    })
    check(wrongPassword.status === 401, '密码不对 → 401', String(wrongPassword.status))

    const revoked = await api('POST', `/privacy/consents/${guardian.record.id}/revoke`, {
      token: parent.token,
      body: { password: parent.password, confirm: '撤回同意' },
    })
    check(revoked.ok && revoked.body.unboundDevices === 1, '撤回同意解绑了 1 台设备', JSON.stringify(revoked.body))
    check(revoked.body.stoppedMonitoring === true, '必读文本的撤回会真的停止监控')
    const devicesAfter = await must('GET', '/devices', { token: parent.token })
    check(devicesAfter.devices.length === 0, '设备列表当场空了（不是「状态已撤回」而已）', String(devicesAfter.devices.length))
    // 设备记录是**删掉**的，不是改成「已解绑」：留着行就留着一个还能写上报的设备令牌，
    // 而且一台设备被下一个账号认领后，只按 deviceId 归档的事件与照片会跟着露出来。
    const unboundHome = await api('GET', '/agent/child-home', { token: myPhone.token })
    check(unboundHome.status === 401, '设备记录被删除 → 设备令牌立即失效（不是还能读 child-home）', String(unboundHome.status))
    if (prisma) {
      const deviceRow = await prisma.childDevice.findUnique({ where: { id: myPhone.id } })
      check(deviceRow === null, '设备行真的没了（不是 userId 置空）')
      const eventRows = await prisma.deviceEvent.count({ where: { deviceId: myPhone.id } })
      check(eventRows === 0, '设备上的历史事件也随设备行级联删除（否则下一个家长会看到它）', String(eventRows))
    } else {
      skip('设备行与历史事件真的删除', '拿不到 @prisma/client')
    }
    const stillThere = await must('GET', '/children', { token: parent.token })
    check(stillThere.children.length === 1, '撤回同意不等于删除数据：孩子档案还在')
    const revokedAgain = await api('POST', `/privacy/consents/${guardian.record.id}/revoke`, {
      token: parent.token,
      body: { password: parent.password, confirm: '撤回同意' },
    })
    check(revokedAgain.status === 409, '同一条记录不能撤回两次', String(revokedAgain.status))

    const afterRevoke = await consentOf(parent.token, 'guardian_agreement')
    check(afterRevoke.accepted === false && afterRevoke.record === null, '撤回后当前状态是「未同意」')
    check(afterRevoke.history.length === 1, '历史里留着那条已撤回的记录')
    const reAccept = await api('POST', '/privacy/consents', {
      token: parent.token,
      body: { docType: 'guardian_agreement', docVersion: catalog.version },
    })
    check(reAccept.status === 201, '撤回后可以重新同意', String(reAccept.status))
    const afterRe = await consentOf(parent.token, 'guardian_agreement')
    check(afterRe.history.length === 2 && afterRe.accepted === true, '重新同意写的是新的一行（只追加）', String(afterRe.history.length))

    // ----------------------------------------------------------
    step('6. 注销：7 天冷静期 + 监控立刻停 + 可撤销')
    const noAuth = await api('POST', '/privacy/deletion', { body: { password: 'x', confirm: '删除我的账号' } })
    check(noAuth.status === 401, '未登录申请注销 → 401', String(noAuth.status))
    const badConfirm = await api('POST', '/privacy/deletion', {
      token: victim.token,
      body: { password: victim.password, confirm: '删了吧' },
    })
    check(badConfirm.status === 400, '确认文字不对 → 400', String(badConfirm.status))
    const badPassword = await api('POST', '/privacy/deletion', {
      token: victim.token,
      body: { password: 'nope', confirm: '删除我的账号' },
    })
    check(badPassword.status === 401, '密码不对 → 401', String(badPassword.status))

    const scheduled = await api('POST', '/privacy/deletion', {
      token: victim.token,
      body: { password: victim.password, confirm: '删除我的账号' },
    })
    check(scheduled.ok && scheduled.body.deletion.scheduled === true, '申请注销成功', String(scheduled.status))
    const daysOut = (new Date(scheduled.body.deletion.scheduledFor).getTime() - Date.now()) / 86_400_000
    check(daysOut > 6.9 && daysOut < 7.1, '生效时间是 7 天后', daysOut.toFixed(2))
    check(scheduled.body.deletion.note.includes('删除 1 台设备'), '流水里写清了解绑了几台设备', scheduled.body.deletion.note)
    const victimDevices = await must('GET', '/devices', { token: victim.token })
    check(victimDevices.devices.length === 0, '冷静期内监控也立刻停（设备当场解绑）')
    const victimHome = await api('GET', '/agent/child-home', { token: doomedPhone.token })
    check(victimHome.status === 401, '设备记录当场删除 → 设备令牌失效')
    const twice = await api('POST', '/privacy/deletion', {
      token: victim.token,
      body: { password: victim.password, confirm: '删除我的账号' },
    })
    check(twice.status === 409, '重复申请注销 → 409', String(twice.status))

    const cancelled = await must('DELETE', '/privacy/deletion', { token: victim.token })
    check(cancelled.deletion.scheduled === false, '冷静期内可以撤销')
    check(cancelled.deletion.note.includes('重新绑定'), '撤销后如实说明设备需要重新绑定')
    const cancelTwice = await api('DELETE', '/privacy/deletion', { token: victim.token })
    check(cancelTwice.status === 409, '没排期时撤销 → 409', String(cancelTwice.status))

    const rescheduled = await api('POST', '/privacy/deletion', {
      token: victim.token,
      body: { password: victim.password, confirm: '删除我的账号' },
    })
    check(rescheduled.ok && rescheduled.body.deletion.scheduled === true, '撤销后还能重新申请')

    // ----------------------------------------------------------
    step('7. 到期清扫：真的删库，且先删磁盘文件')
    if (!prisma) {
      skip('到期清扫（账号真的被删除）', '拿不到 @prisma/client')
    } else {
      await prisma.user.update({
        where: { id: victim.userId },
        data: { deletionScheduledAt: new Date(Date.now() - 1000) },
      })
      // 惰性兜底：访问隐私接口时顺手清扫（定时任务之外的那条保险）
      const swept = await api('GET', '/privacy/deletion', { token: victim.token })
      check(swept.status === 404 || swept.status === 401, '到期后自己的令牌已经用不了', String(swept.status))

      const login = await api('POST', '/auth/login', {
        body: { phone: victim.phone, password: victim.password },
      })
      check(login.status === 401, '账号真的没了：密码登录 → 401', String(login.status))
      const deviceGone = await api('GET', '/agent/child-home', { token: doomedPhone.token })
      check(deviceGone.status === 401, '设备记录也级联删掉了（设备令牌失效）', String(deviceGone.status))

      const userRow = await prisma.user.findUnique({ where: { id: victim.userId } })
      check(userRow === null, '数据库里查不到这个账号')
      const deviceRow = await prisma.childDevice.findUnique({ where: { id: doomedPhone.id } })
      check(deviceRow === null, '设备行也级联删掉了')
      const requestRows = await prisma.privacyRequest.count({ where: { userId: victim.userId } })
      check(requestRows === 0, '注销流水随账号一起删除（服务端日志另有记录）')

      let fileGone = false
      for (let i = 0; i < 20 && !fileGone; i++) {
        fileGone = !fs.existsSync(path.join(UPLOAD_DIR, mediaFile))
        if (!fileGone) await sleep(150)
      }
      check(fileGone, '磁盘上的媒体文件也删了（只删行不删文件等于没删）', mediaFile || '')
      const mediaRow = await prisma.mediaAsset.findUnique({ where: { id: mediaId } })
      check(mediaRow === null, '媒体元数据行也删了')
    }

    // ----------------------------------------------------------
    step('8. 旁观者不受影响')
    const strangerStill = await consents(stranger.token)
    check(strangerStill.every((c) => !c.accepted), '旁观者的同意状态没被动过')
    const strangerDevices = await must('GET', '/devices', { token: stranger.token })
    check(strangerDevices.devices.length === 1, '旁观者的设备还在', String(strangerDevices.devices.length))
  } finally {
    // ----------------------------------------------------------
    step('9. 清理')
    const adminLogin = await api('POST', '/admin/login', {
      body: { username: ADMIN_USER, password: ADMIN_PASSWORD },
    })
    if (adminLogin.ok) {
      for (const id of deviceIds) {
        const r = await api('DELETE', `/admin/devices/${id}`, { token: adminLogin.body.token })
        if (!r.ok && r.status !== 404) console.log(`  \x1b[33m•\x1b[0m 删除设备 ${id} → ${r.status}`)
      }
      for (const id of userIds) {
        if (id == null) continue
        const r = await api('DELETE', `/admin/users/${id}`, { token: adminLogin.body.token })
        if (!r.ok && r.status !== 404) console.log(`  \x1b[33m•\x1b[0m 删除家长 ${id} → ${r.status}`)
      }
      ok('清理完成（测试家长账号与设备都已删除）')
    } else {
      bad('管理员登录失败，临时家长账号未清理', String(adminLogin.status))
    }
    if (prisma) await prisma.$disconnect()
  }

  console.log(`\n\x1b[1m结果：${passed} 项通过 / ${failed} 项失败\x1b[0m`)
  if (failed > 0) process.exit(1)
}

main().catch((err) => {
  console.error(`\n\x1b[31m脚本中断：${err.message}\x1b[0m`)
  process.exit(1)
})
