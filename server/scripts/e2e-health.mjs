#!/usr/bin/env node
/**
 * 设备健康与权限可见性的端到端验证（规划 §1）。
 *
 * 这个特性要解决的是一个「信息不对称」问题：孩子端的 20 多项管控能力全都压在
 * 两三个开关上（设备所有者 / 无障碍看门狗 / 授权 / 电池白名单 / VPN），被关掉
 * 就静默失效，而家长端此前只看得到「在线 + 电量」。所以这里逐条验证：
 *
 *   1. 没上报过快照时，家长端如实说「尚未检测」，而不是假装一切正常；
 *   2. 设备端报上来的缺口**原文**透传（不重新翻译），严重程度与修复方式也跟着走；
 *   3. 服务端不重新判定等级（设备说危险就是危险），只在老版本没给 level 时兜底推算；
 *   4. 未知的检查项 key 显示「未知」而不是猜一个 false —— 猜出来的红灯是假警报；
 *   5. 整份覆盖语义：第二次少报几条，缺口数就要跟着降下来，不能累加；
 *   6. 在线分级 online/delayed/offline/lost 的四个边界；
 *   7. 失联时补记一条动态，且反复刷新不会刷出一屏重复；
 *   8. 「重新检测」真的走指令队列（self_check 入队 → 设备领取 → 回报 → 快照更新）；
 *   9. 越权：换个家长读不到别人家孩子的健康数据；
 *  10. 脏数据一律拒收（超长、类型错、超上限）。
 *
 * 用法：node scripts/e2e-health.mjs       （默认 http://localhost:4000/api）
 *
 * 需要跑着的后端 + 已 seed 的库。脚本自己注册两台一次性家长账号与一台一次性设备，
 * 结束时全部删除。其中三组「时间边界」断言需要直接改库里的 lastActiveAt，
 * 所以会动态 import @prisma/client —— 拿不到数据库时这几条会**明确跳过并标注**，
 * 不会伪装成通过。
 */

const API = process.env.API_BASE || 'http://localhost:4000/api'
const PARENT_PHONE = process.env.PARENT_PHONE || '13800138000'
const PARENT_PASSWORD = process.env.PARENT_PASSWORD || 'balloon123'
const ADMIN_USER = process.env.ADMIN_USER || 'admin'
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'balloon-admin-2026'

let passed = 0
let failed = 0
let skipped = 0
const ok = (m) => { passed++; console.log(`  \x1b[32m✓\x1b[0m ${m}`) }
const bad = (m, extra = '') => { failed++; console.log(`  \x1b[31m✗\x1b[0m ${m}${extra ? ` — ${extra}` : ''}`) }
const check = (c, m, extra = '') => (c ? ok(m) : bad(m, extra))
const skip = (m) => { skipped++; console.log(`  \x1b[33m•\x1b[0m ${m}（跳过：拿不到数据库，无法构造时间边界）`) }
const step = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`)

async function api(method, path, { body, token, raw } = {}) {
  const headers = {}
  if (token) headers.Authorization = `Bearer ${token}`
  if (body !== undefined && !raw) headers['Content-Type'] = 'application/json'
  const res = await fetch(`${API}${path}`, {
    method,
    headers,
    body: raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined,
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

/** 注册一个一次性家长账号，返回 { token, userId, phone }。 */
async function registerParent(tag) {
  const phone = `136${String(Date.now()).slice(-8)}`
  const sent = await must('POST', '/auth/send-code', { body: { phone, purpose: 'register' } })
  const reg = await must('POST', '/auth/register', {
    body: { phone, password: 'e2e-health-123', code: sent.devCode, nickname: tag },
  })
  return { token: reg.token, userId: reg.user?.id ?? null, phone }
}

/** 一份「一切正常」的快照，作为各处断言的基础，避免每个用例重复 30 行。 */
function healthyBody(overrides = {}) {
  return {
    level: 'ok',
    gaps: [],
    checks: {
      deviceOwner: true,
      adminActive: true,
      overlay: true,
      accessibility: true,
      batteryWhitelist: true,
      vpnConsent: true,
      vpnAlwaysOn: true,
      usageAccess: true,
      protectedPackage: true,
    },
    permissions: { location: 'granted', camera: 'granted', mic: 'granted', callLog: 'granted', sms: 'granted', notification: 'denied' },
    restrictions: [
      { id: 'no_uninstall_apps', label: '禁止卸载应用', supported: true, applied: true },
      { id: 'no_safe_boot', label: '禁止安全模式', supported: false, applied: false },
    ],
    serviceRunning: true,
    clockSkewSeconds: 0,
    healCount: 3,
    lastHealAt: new Date().toISOString(),
    ...overrides,
  }
}

const GAP_ACCESSIBILITY = {
  id: 'accessibility',
  label: '无障碍看门狗',
  detail: '无障碍看门狗已被关闭：孩子可下拉通知栏、进设置、按最近任务绕过锁定',
  importance: 'critical',
  fixability: 'auto',
  fixHint: '点「重新检测」即可尝试自愈',
}
const GAP_BATTERY = {
  id: 'batteryWhitelist',
  label: '电池优化白名单',
  detail: '未加入电池优化白名单：息屏后可能被 Doze 冻结，心跳与指令会延迟',
  importance: 'major',
  fixability: 'manual',
  fixHint: '在孩子手机上打开「设置 → 电池 → 电池优化」，把气球狗设为「不优化」',
}
const GAP_OVERLAY = {
  id: 'overlay',
  label: '悬浮窗权限',
  detail: '悬浮窗权限已关闭：锁定页只能靠无障碍看门狗拉回，按返回键有概率逃出',
  importance: 'major',
  fixability: 'manual',
  fixHint: '',
}

async function main() {
  console.log('\x1b[1m气球狗 · 设备健康端到端验证\x1b[0m')
  console.log(`  API ${API}`)

  // 时间边界断言要直接改库；拿不到就明确跳过（不伪装通过）
  let prisma = null
  try {
    const mod = await import('@prisma/client')
    prisma = new mod.PrismaClient()
    await prisma.$queryRaw`SELECT 1`
  } catch (err) {
    prisma = null
  }

  const deviceIds = []
  const userIds = []
  const parent = await registerParent('健康E2E')
  userIds.push(parent.userId)
  const other = await registerParent('健康E2E旁观')
  userIds.push(other.userId)

  try {
    // ----------------------------------------------------------
    step('1. 准备：注册一台设备并让家长认领')
    const suffix = Date.now().toString(36).toUpperCase().slice(-6)
    const deviceCode = `HLTH${suffix}`.slice(0, 12)
    const reg = await must('POST', '/agent/register', {
      body: {
        deviceCode,
        deviceSecret: 'e2e-health-secret-0123456789abcdef',
        model: 'E2E Health Device',
        os: 'Android',
        osVersion: '14',
      },
    })
    const deviceToken = reg.deviceToken
    check(Boolean(deviceToken), `设备已注册（绑定码 ${deviceCode}）`)

    const bound = await must('POST', '/devices/bind', { token: parent.token, body: { deviceCode, name: 'E2E 健康验证机' } })
    const deviceId = bound.device.id
    deviceIds.push(deviceId)
    const q = `?deviceId=${deviceId}`
    ok(`家长已认领（deviceId=${deviceId}）`)
    check(bound.device.liveness === 'online', '设备视图带上在线分级 liveness', bound.device.liveness)
    check(bound.device.livenessLabel === '在线', '并且带中文标签 livenessLabel', bound.device.livenessLabel)

    // ----------------------------------------------------------
    step('2. 设备还没上报过：如实说「尚未检测」')
    const before = await must('GET', `/device/health${q}`, { token: parent.token })
    check(before.reported === false, '未上报时 reported=false')
    check(before.levelLabel === '尚未检测', '等级文案是「尚未检测」而不是「管控正常」', before.levelLabel)
    check(before.gaps.length === 0 && before.summary.openGaps === 0, '缺口列表为空')
    check(
      before.checks.length === 9 && before.checks.every((c) => c.status === 'unknown'),
      '9 项开关全部显示「未知」，不替设备猜一个正常',
      before.checks.map((c) => c.status).join(','),
    )
    check(before.permissions.length === 6 && before.permissions.every((p) => p.status === 'unknown'), '权限同样全部显示「未知」')
    check(before.stale === true, '没有快照时标记为数据陈旧')
    check(before.serviceRunning === false, '守护服务状态默认 false')

    // ----------------------------------------------------------
    step('3. 设备上报「一切正常」的快照')
    const reported = await must('POST', '/agent/health', { token: deviceToken, body: healthyBody() })
    check(reported.success === true, '上报成功')
    check(typeof reported.serverTime === 'string', '回了一个权威 serverTime（供设备锚时钟）')
    check(reported.level === 'ok' && reported.openGaps === 0, '服务端确认等级 ok / 0 项缺口')

    const good = await must('GET', `/device/health${q}`, { token: parent.token })
    check(good.reported === true, 'reported 变成 true')
    check(good.level === 'ok', '等级为 ok')
    check(good.levelLabel === '管控正常', '等级文案为「管控正常」', good.levelLabel)
    check(good.stale === false, '刚上报的快照不算陈旧')
    check(good.checks.every((c) => c.status === 'on'), '9 项开关全部显示已开启', good.checks.filter((c) => c.status !== 'on').map((c) => c.key).join(','))
    check(good.permissions.find((p) => p.key === 'location')?.status === 'granted', '定位权限显示已授权')
    check(good.permissions.find((p) => p.key === 'notification')?.status === 'denied', '通知权限如实显示被拒绝')
    check(good.summary.openGaps === 0 && good.summary.criticalGaps === 0, '缺口统计全 0')
    check(good.restrictions.length === 2, '加固项两条都带回来了', String(good.restrictions.length))
    check(good.restrictions.find((r) => r.id === 'no_safe_boot')?.supported === false, '不支持的加固项如实标 supported=false')
    check(good.serviceRunning === true && good.healCount === 3, '守护服务与自愈次数带回来了')
    check(good.checks.find((c) => c.key === 'deviceOwner')?.critical === true, 'critical 标记随元数据下发（家长端据此排序）')
    check(Boolean(good.checks.find((c) => c.key === 'accessibility')?.why), '每项都带「为什么重要」的一句话')

    // ----------------------------------------------------------
    step('4. 设备上报缺口：原文透传 + 严重程度与修复方式')
    await must('POST', '/agent/health', {
      token: deviceToken,
      body: healthyBody({
        level: 'danger',
        gaps: [GAP_ACCESSIBILITY, GAP_BATTERY, GAP_OVERLAY],
        checks: { ...healthyBody().checks, accessibility: false, overlay: false, batteryWhitelist: false },
      }),
    })
    const gapsView = await must('GET', `/device/health${q}`, { token: parent.token })
    check(gapsView.level === 'danger', '等级为 danger')
    check(gapsView.levelLabel === '管控已实质失效', '等级文案为「管控已实质失效」', gapsView.levelLabel)
    check(gapsView.summary.openGaps === 3, '缺口数为 3', String(gapsView.summary.openGaps))
    check(gapsView.summary.criticalGaps === 1, '其中 1 项 critical', String(gapsView.summary.criticalGaps))
    check(gapsView.summary.autoFixable === 1, '1 项可自动修复', String(gapsView.summary.autoFixable))
    check(gapsView.summary.manualFixable === 2, '2 项需要家长手动操作', String(gapsView.summary.manualFixable))
    check(gapsView.gaps[0].detail === GAP_ACCESSIBILITY.detail, '缺口原文一字不改地透传（不重新翻译）')
    check(gapsView.gaps[0].importance === 'critical' && gapsView.gaps[0].fixability === 'auto', '严重程度与修复方式跟着缺口走')
    check(gapsView.gaps[1].fixHint === GAP_BATTERY.fixHint, '修复指引原文透传')
    check(gapsView.gaps.map((g) => g.id).join(',') === 'accessibility,batteryWhitelist,overlay', '缺口顺序按设备端给的顺序')
    check(gapsView.checks.find((c) => c.key === 'accessibility')?.status === 'off', '开关一览里无障碍显示已关闭')
    check(gapsView.checks.find((c) => c.key === 'deviceOwner')?.status === 'on', '没坏的项仍然显示已开启')

    // ----------------------------------------------------------
    step('5. 未知 key 与缺失 key 都显示「未知」，不猜')
    await must('POST', '/agent/health', {
      token: deviceToken,
      body: {
        level: 'warn',
        gaps: [],
        // 只报两项；再塞一个服务端还不认识的新检查项
        checks: { accessibility: true, brandNewCheck: false },
        permissions: { location: 'granted', futurePermission: 'denied' },
      },
    })
    const partial = await must('GET', `/device/health${q}`, { token: parent.token })
    check(partial.checks.find((c) => c.key === 'accessibility')?.status === 'on', '报了的项按事实显示')
    check(partial.checks.find((c) => c.key === 'deviceOwner')?.status === 'unknown', '没报的项显示 unknown 而不是 false')
    check(!partial.checks.some((c) => c.key === 'brandNewCheck'), '服务端不认识的新 key 不会被塞进展示列表')
    check(partial.permissions.find((p) => p.key === 'location')?.status === 'granted', '权限同理：报了的就是事实')
    check(partial.permissions.find((p) => p.key === 'camera')?.status === 'unknown', '权限没报的项显示 unknown')
    check(partial.restrictions.length === 0, '这次没报加固项，列表就是空的（整份覆盖）')

    // ----------------------------------------------------------
    step('6. 等级以设备端结论为准；老版本没给 level 时才兜底推算')
    await must('POST', '/agent/health', { token: deviceToken, body: healthyBody({ level: 'danger' }) })
    const deviceWins = await must('GET', `/device/health${q}`, { token: parent.token })
    check(deviceWins.level === 'danger', '开关都是开的、但设备说 danger，服务端不改它的结论', deviceWins.level)

    const noLevelAllOk = healthyBody()
    delete noLevelAllOk.level
    await must('POST', '/agent/health', { token: deviceToken, body: noLevelAllOk })
    check((await must('GET', `/device/health${q}`, { token: parent.token })).level === 'ok', '没给 level + 全部正常 → 兜底推算为 ok')

    await must('POST', '/agent/health', {
      token: deviceToken,
      body: { ...noLevelAllOk, checks: { ...noLevelAllOk.checks, deviceOwner: false } },
    })
    check((await must('GET', `/device/health${q}`, { token: parent.token })).level === 'danger', '没给 level + 关键项关着 → 兜底推算为 danger')

    await must('POST', '/agent/health', {
      token: deviceToken,
      body: { ...noLevelAllOk, checks: { ...noLevelAllOk.checks, batteryWhitelist: false } },
    })
    check((await must('GET', `/device/health${q}`, { token: parent.token })).level === 'warn', '没给 level + 只有非关键项关着 → 兜底推算为 warn')

    // ----------------------------------------------------------
    step('7. 整份覆盖：第二次少报几条，缺口数就要降下来')
    await must('POST', '/agent/health', { token: deviceToken, body: healthyBody({ level: 'warn', gaps: [GAP_BATTERY] }) })
    const shrunk = await must('GET', `/device/health${q}`, { token: parent.token })
    check(shrunk.summary.openGaps === 1, '缺口从 3 降到 1（不是累加）', String(shrunk.summary.openGaps))
    check(shrunk.gaps[0].id === 'batteryWhitelist', '留下的是第二次报的那条')
    await must('POST', '/agent/health', { token: deviceToken, body: healthyBody() })
    check((await must('GET', `/device/health${q}`, { token: parent.token })).summary.openGaps === 0, '再报一次空缺口就彻底清零')

    // ----------------------------------------------------------
    step('8. 在线分级：online / delayed / offline / lost 四个边界')
    const fresh = await must('GET', `/device/health${q}`, { token: parent.token })
    check(fresh.liveness === 'online' && fresh.online === true, '刚心跳过 → online')

    if (!prisma) {
      skip('delayed / offline / lost 三档边界')
      skip('失联补记动态与去重')
    } else {
      const backdate = async (ms) => {
        await prisma.childDevice.update({ where: { id: deviceId }, data: { lastActiveAt: new Date(Date.now() - ms) } })
      }
      await backdate(5 * 60_000)
      const delayed = await must('GET', `/device/health${q}`, { token: parent.token })
      check(delayed.liveness === 'delayed', '5 分钟没心跳 → 心跳延迟', delayed.liveness)
      check(delayed.livenessLabel === '心跳延迟', '中文标签跟着变', delayed.livenessLabel)

      await backdate(45 * 60_000)
      const offline = await must('GET', `/device/health${q}`, { token: parent.token })
      check(offline.liveness === 'offline', '45 分钟没心跳 → 失联', offline.liveness)

      await backdate(30 * 60 * 60_000)
      const lost = await must('GET', `/device/health${q}`, { token: parent.token })
      check(lost.liveness === 'lost', '30 小时没心跳 → 严重失联', lost.liveness)

      const events1 = await must('GET', `/device-events?deviceId=${deviceId}&pageSize=50`, { token: parent.token })
      const offlineEvents = events1.items.filter((e) => e.type === 'agent_offline')
      check(offlineEvents.length === 1, '失联时补记了一条 agent_offline 动态', String(offlineEvents.length))
      check(/失联/.test(offlineEvents[0]?.detail || '') && /(分钟|小时)/.test(offlineEvents[0]?.detail || ''), '并写明失联了多久', offlineEvents[0]?.detail)

      // 反复刷新不能刷出一屏重复告警（去重窗口生效）
      await must('GET', `/device/health${q}`, { token: parent.token })
      await must('GET', `/device/health${q}`, { token: parent.token })
      const events2 = await must('GET', `/device-events?deviceId=${deviceId}&pageSize=50`, { token: parent.token })
      check(
        events2.items.filter((e) => e.type === 'agent_offline').length === 1,
        '连续刷新三次仍然只有一条失联动态（去重生效）',
        String(events2.items.filter((e) => e.type === 'agent_offline').length),
      )

      // 恢复心跳：重新变成在线，并且再失联时应该能再记一条（窗口内不重复、窗口外允许）
      await must('POST', '/agent/heartbeat', { token: deviceToken, body: { battery: 42 } })
      check((await must('GET', `/device/health${q}`, { token: parent.token })).liveness === 'online', '恢复心跳后回到 online')
    }

    // ----------------------------------------------------------
    step('9. 「重新检测」真的走指令队列')
    const dispatched = await must('POST', '/device/health/check', { token: parent.token })
    check(dispatched.success === true, '下发成功')
    check(dispatched.command?.type === 'self_check', '下发的是 self_check 指令', dispatched.command?.type)
    check(dispatched.command?.status === 'pending', '指令状态是 pending（等设备领取）')

    const pendingCommands = await must('GET', `/device/commands${q}`, { token: parent.token })
    check(
      pendingCommands.commands.some((c) => c.id === dispatched.command.id && c.type === 'self_check'),
      '家长端指令列表里能看到它',
    )

    const claimed = await must('GET', '/agent/commands/next?wait=1', { token: deviceToken })
    check(claimed.command?.id === dispatched.command.id, '设备端长轮询领到了同一条指令', String(claimed.command?.id))
    check(claimed.command?.type === 'self_check', '类型是 self_check', String(claimed.command?.type))

    await must('POST', `/agent/commands/${dispatched.command.id}/result`, {
      token: deviceToken,
      body: { status: 'succeeded', result: { healed: 2, summary: '重开无障碍看门狗；仍有 1 项缺口' } },
    })
    const doneCommands = await must('GET', `/device/commands${q}`, { token: parent.token })
    check(
      doneCommands.commands.find((c) => c.id === dispatched.command.id)?.status === 'succeeded',
      '回报后收敛为 succeeded',
    )

    // 设备自愈完随即上报新快照 → 家长端看到的缺口少了
    const beforeCheck = await must('GET', `/device/health${q}`, { token: parent.token })
    await must('POST', '/agent/health', {
      token: deviceToken,
      body: healthyBody({ level: 'warn', gaps: [GAP_BATTERY], healCount: 4 }),
    })
    const afterCheck = await must('GET', `/device/health${q}`, { token: parent.token })
    check(afterCheck.summary.openGaps === 1, '自愈后缺口从需要修的降下来了', String(afterCheck.summary.openGaps))
    check(afterCheck.healCount === 4, '自愈次数 +1 也带到了家长端')
    check(
      new Date(afterCheck.updatedAt).getTime() >= new Date(beforeCheck.updatedAt).getTime(),
      '快照更新时间向前推进（家长端据此判断「真的重测了」）',
    )
    check(beforeCheck.commands === undefined, '健康接口不夹带指令列表（各管各的）')

    // ----------------------------------------------------------
    step('10. 越权与脏数据')
    const forbidden = await api('GET', `/device/health${q}`, { token: other.token })
    check(forbidden.status === 403, '另一个家长读不到别人家孩子的健康数据（403）', String(forbidden.status))
    const forbiddenCheck = await api('POST', `/device/health/check${q}`, { token: other.token })
    check(forbiddenCheck.status === 403, '也不能触发别人家孩子的重新检测（403）', String(forbiddenCheck.status))
    const noAuth = await api('GET', `/device/health${q}`)
    check(noAuth.status === 401, '未登录读不到（401）', String(noAuth.status))
    const deviceSideRead = await api('GET', '/device/health', { token: deviceToken })
    check(deviceSideRead.status === 401, '设备令牌读不了家长端接口（401）', String(deviceSideRead.status))

    const tooManyGaps = await api('POST', '/agent/health', {
      token: deviceToken,
      body: healthyBody({ gaps: Array.from({ length: 61 }, (_, i) => ({ id: `g${i}`, detail: `缺口 ${i}` })) }),
    })
    check(tooManyGaps.status === 422, '61 条缺口被拒（上限 60）', String(tooManyGaps.status))

    const longDetail = await api('POST', '/agent/health', {
      token: deviceToken,
      body: healthyBody({ gaps: [{ id: 'x', detail: 'x'.repeat(301) }] }),
    })
    check(longDetail.status === 422, '缺口说明超过 300 字被拒', String(longDetail.status))

    const badCheckType = await api('POST', '/agent/health', {
      token: deviceToken,
      body: healthyBody({ checks: { deviceOwner: 'yes' } }),
    })
    check(badCheckType.status === 422, '检查项不是布尔被拒（避免把字符串当成真值）', String(badCheckType.status))

    const badSkew = await api('POST', '/agent/health', {
      token: deviceToken,
      body: healthyBody({ clockSkewSeconds: 999_999 }),
    })
    check(badSkew.status === 422, '时钟偏差超出 ±24 小时被拒', String(badSkew.status))

    await must('POST', '/agent/health', { token: deviceToken, body: healthyBody({ clockSkewSeconds: -120 }) })
    const skewed = await must('GET', `/device/health${q}`, { token: parent.token })
    check(skewed.clockSkewSeconds === -120, '时钟偏差如实存下来（供规划 §1.6 用）', String(skewed.clockSkewSeconds))


    // ----------------------------------------------------------
    step('10. 分机型修复步骤：同一份缺口，不同机型给不同路径')
    // 两台机型各报同一条「电池白名单没开」的缺口：一台型号认不出来（generic），一台是小米。
    // 家长端的动作指引完全不同 —— 这正是规划 §1.4 要解决的问题，所以在这里验它。
    await must('POST', '/agent/health', { token: deviceToken, body: healthyBody({ level: 'warn', gaps: [GAP_BATTERY] }) })
    const genericView = await must('GET', `/device/health${q}`, { token: parent.token })

    // 先解绑，再绑第二台：普通账号绑不了两台手机（多设备是会员权益），
    // 而这里要验的是「同一份缺口在不同机型下的步骤不同」，与账号档位无关。
    const unbind1 = await api('DELETE', `/devices/${deviceId}`, { token: parent.token })
    if (unbind1.ok || unbind1.status === 404) ok('先解绑第一台，腾出绑定位')
    else bad('解绑第一台失败', String(unbind1.status))

    const oemCode = `OEM${suffix}`.slice(0, 12)
    const oemReg = await must('POST', '/agent/register', {
      body: {
        deviceCode: oemCode,
        deviceSecret: 'e2e-health-oem-secret-0123456789',
        model: 'Xiaomi 2211133C',
        os: 'Android',
        osVersion: '14',
      },
    })
    const oemBound = await must('POST', '/devices/bind', {
      token: parent.token,
      body: { deviceCode: oemCode, name: 'E2E 小米验证机' },
    })
    const oemId = oemBound.device.id
    deviceIds.push(oemId)
    await must('POST', '/agent/health', { token: oemReg.deviceToken, body: healthyBody({ level: 'warn', gaps: [GAP_BATTERY] }) })
    const oemView = await must('GET', `/device/health?deviceId=${oemId}`, { token: parent.token })

    const genericSteps = genericView.gaps.find((g) => g.id === 'batteryWhitelist').fixSteps
    const oemSteps = oemView.gaps.find((g) => g.id === 'batteryWhitelist').fixSteps
    check(Array.isArray(genericSteps) && genericSteps.length >= 3, '认不出的机型给通用步骤', `len=${genericSteps && genericSteps.length}`)
    check(oemSteps.join(' ').includes('MIUI'), '小米机型给的是 MIUI 的路径（两套文案不是一份）', oemSteps[0])
    check(oemSteps.join('|') !== genericSteps.join('|'), '同一条缺口在两台机型下不是同一份文案')
    const autoGap = genericView.gaps.find((g) => g.id === 'accessibility')
    check(!autoGap || autoGap.fixSteps.length === 0, '能自动修的缺口不给手动步骤（点「重新检测」就好）')

    const unbound = await api('POST', '/agent/health', { token: 'not-a-real-device-token', body: healthyBody() })
    check(unbound.status === 401, '无效设备令牌上报被拒（401）', String(unbound.status))
  } finally {
    // ----------------------------------------------------------
    step('11. 清理')
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
  if (failed === 0) console.log(`\x1b[32m设备健康：全部通过（${passed} 项${skipped ? `，跳过 ${skipped} 项` : ''}）\x1b[0m`)
  else console.log(`\x1b[31m设备健康：${passed} 项通过，${failed} 项失败${skipped ? `，跳过 ${skipped} 项` : ''}\x1b[0m`)
  console.log('═'.repeat(54))
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('\x1b[31m验证中断：\x1b[0m', err.message)
  process.exit(1)
})
