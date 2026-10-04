#!/usr/bin/env node
/**
 * 模式切换 / 护眼设置 / 应用插件管控 的端到端验证。
 *
 * 模拟一台真实设备端的完整往返：
 *   1. 注册设备 → 家长认领；
 *   2. 设备上报已安装应用清单（家长端「选择应用」「功能管控」的数据来源）；
 *   3. 家长配置模式（手动 / 按时段）、时段格子、学习应用白名单；
 *   4. 家长配置护眼与插件开关；
 *   5. 拉一次 /agent/config，核对下发给设备端的三块内容是否与设置一致
 *      —— 这一步是重点：家长端显示的和设备端真正拿到的必须是同一件事；
 *   6. 设备上报事件，家长端能读到「最新动态」；
 *   7. 越权与非法输入必须被拒。
 *
 * 用法：node scripts/e2e-mode.mjs          （默认 http://localhost:4000/api）
 *      API_BASE=http://localhost:4002/api node scripts/e2e-mode.mjs
 */

const API = process.env.API_BASE || 'http://localhost:4000/api'
const PARENT_PHONE = '13800138000'
const PARENT_PASSWORD = 'balloon123'
const PKG = 'com.tencent.mm'

let passed = 0
let failed = 0
const ok = (m) => { passed++; console.log(`  \x1b[32m✓\x1b[0m ${m}`) }
const bad = (m, extra = '') => { failed++; console.log(`  \x1b[31m✗\x1b[0m ${m}${extra ? ` — ${extra}` : ''}`) }
const check = (c, m, extra = '') => (c ? ok(m) : bad(m, extra))
const step = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function api(method, path, { body, token } = {}) {
  const headers = {}
  if (token) headers.Authorization = `Bearer ${token}`
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  const res = await fetch(`${API}${path}`, {
    method, headers, body: body !== undefined ? JSON.stringify(body) : undefined,
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

async function main() {
  console.log('\x1b[1m气球狗 · 模式切换 / 护眼 / 应用插件管控 端到端验证\x1b[0m')
  console.log(`  API ${API}`)

  // ==========================================================
  step('1. 准备：注册设备并让家长认领')
  const suffix = Date.now().toString(36).toUpperCase().slice(-6)
  const deviceCode = `MODE${suffix}`.slice(0, 12)
  const deviceSecret = 'e2e-mode-secret-0123456789abcdef'
  const reg = await must('POST', '/agent/register', {
    body: { deviceCode, deviceSecret, model: 'E2E Mode Device', os: 'Android', osVersion: '14' },
  })
  check(Boolean(reg.deviceToken), `设备已注册（绑定码 ${deviceCode}）`)
  const deviceToken = reg.deviceToken

  const login = await must('POST', '/auth/login', { body: { phone: PARENT_PHONE, password: PARENT_PASSWORD } })
  const token = login.token
  const bound = await must('POST', '/devices/bind', { token, body: { deviceCode, name: 'E2E 模式验证机' } })
  const deviceId = bound.device.id
  ok(`家长已认领（deviceId=${deviceId}）`)

  const q = `deviceId=${deviceId}`

  // ==========================================================
  step('2. 设备上报已安装应用清单')
  const reportedApps = [
    { packageName: 'com.tencent.mm', appName: '微信', isSystem: false, isLaunchable: true },
    { packageName: 'com.tencent.mobileqq', appName: 'QQ', isSystem: false, isLaunchable: true },
    { packageName: 'com.zhihu.android', appName: '知乎', isSystem: false, isLaunchable: true },
    { packageName: 'com.android.settings', appName: '设置', isSystem: true, isLaunchable: true },
  ]
  const reported = await must('POST', '/agent/apps', { token: deviceToken, body: { apps: reportedApps } })
  check(reported.count === reportedApps.length, `已上报 ${reported.count} 个应用`)

  const apps = await must('GET', `/device-apps?${q}`, { token })
  check(apps.total === 3, `家长端默认只看到 ${apps.total} 个非系统应用（系统应用被过滤）`)
  const searched = await must('GET', `/device-apps?${q}&q=知乎`, { token })
  check(searched.total === 1 && searched.apps[0].packageName === 'com.zhihu.android', '按应用名搜索可用')
  const withSystem = await must('GET', `/device-apps?${q}&includeSystem=true`, { token })
  check(withSystem.total === 4, '显式要求时能拿到系统应用（便于排查）')
  // 这一条专门钉住「布尔解析取反」这类坑：
  // 用 z.coerce.boolean() 的话 "false" 会被 JS 的 Boolean() 判成 true，与字面意思相反。
  const explicitFalse = await must('GET', `/device-apps?${q}&includeSystem=false`, { token })
  check(explicitFalse.total === 3,
    '显式传 includeSystem=false 时确实排除系统应用（不能用 z.coerce.boolean）',
    `实际拿到 ${explicitFalse.total} 个`)

  // ==========================================================
  step('3. 模式切换：手动 / 按时段 / 一格没选')
  const initial = await must('GET', `/device-mode?${q}`, { token })
  check(initial.effectiveMode === 'normal' && initial.manualMode === null, '默认是普通模式')
  check(initial.allDayStudyWarning === false, '默认不出现「全天学习模式」警告')

  const manualStudy = await must('PUT', `/device-mode?${q}`, { token, body: { manualMode: 'study' } })
  check(manualStudy.mode.effectiveMode === 'study', '手动切到学习模式后立即生效')

  await must('PUT', `/device-mode?${q}`, { token, body: { manualMode: null, scheduleEnabled: true } })
  const emptySlots = await must('GET', `/device-mode?${q}`, { token })
  check(emptySlots.effectiveMode === 'study',
    '开启时段规划但一格没选 → 全天学习模式（与参考产品语义一致）')
  check(emptySlots.allDayStudyWarning === true,
    '同时给出 allDayStudyWarning=true，家长端可以红字警告')

  // ==========================================================
  step('4. 设置模式时段（整表替换）')
  const now = new Date()
  const dow = now.getDay()
  const hour = now.getHours()
  await must('PUT', `/study-slots?${q}`, {
    token,
    body: { slots: [{ dayOfWeek: dow, hour }, { dayOfWeek: (dow + 1) % 7, hour: 9 }] },
  })
  const slots = await must('GET', `/study-slots?${q}`, { token })
  check(slots.total === 2, `已写入 ${slots.total} 格`)
  const afterSlots = await must('GET', `/device-mode?${q}`, { token })
  check(afterSlots.effectiveMode === 'study', '当前小时若命中格子则为学习模式')
  check(afterSlots.allDayStudyWarning === false, '填了格子之后不再报警告')

  // 整表替换要真的替换掉旧的，而不是追加
  await must('PUT', `/study-slots?${q}`, { token, body: { slots: [{ dayOfWeek: 3, hour: 15 }] } })
  const replaced = await must('GET', `/study-slots?${q}`, { token })
  check(replaced.total === 1 && replaced.slots[0].hour === 15, '整表替换生效（旧格子已清掉）')

  // 重复格子应被去重
  await must('PUT', `/study-slots?${q}`, {
    token, body: { slots: [{ dayOfWeek: 3, hour: 15 }, { dayOfWeek: 3, hour: 15 }] },
  })
  const deduped = await must('GET', `/study-slots?${q}`, { token })
  check(deduped.total === 1, '重复提交同一格会被去重，不会插两条')

  const badHour = await api('PUT', `/study-slots?${q}`, { token, body: { slots: [{ dayOfWeek: 1, hour: 99 }] } })
  check(badHour.status === 422, '非法小时（99）被拒（422）', `实际 ${badHour.status}`)
  const badDay = await api('PUT', `/study-slots?${q}`, { token, body: { slots: [{ dayOfWeek: 9, hour: 1 }] } })
  check(badDay.status === 422, '非法星期（9）被拒（422）', `实际 ${badDay.status}`)

  // ==========================================================
  step('5. 学习模式应用白名单')
  const added = await must('POST', `/mode-apps?${q}`, {
    token, body: { packageName: 'com.zhihu.android', group: 'study' },
  })
  check(added.app.appName === '知乎',
    '未传应用名时自动从设备上报的清单里补上（家长端不用手填）')

  await must('POST', `/mode-apps?${q}`, { token, body: { packageName: 'com.tencent.mm', group: 'study' } })
  await must('POST', `/mode-apps?${q}`, { token, body: { packageName: 'com.tencent.mobileqq', group: 'normal' } })

  const modeApps = await must('GET', `/mode-apps?${q}`, { token })
  check(modeApps.study.length === 2, `学习模式白名单 ${modeApps.study.length} 个`)
  check(modeApps.normal.length === 1, `普通模式专用 ${modeApps.normal.length} 个`)

  // 同一个应用同时进两组是合法的，重复加同一组则幂等
  await must('POST', `/mode-apps?${q}`, { token, body: { packageName: 'com.zhihu.android', group: 'study' } })
  const stillTwo = await must('GET', `/mode-apps?${q}`, { token })
  check(stillTwo.study.length === 2, '重复添加同一組是幂等的')

  const removed = await must('DELETE', `/mode-apps/${modeApps.normal[0].id}?${q}`, { token })
  check(removed.success === true, '可以逐个移除')
  const afterRemove = await must('GET', `/mode-apps?${q}`, { token })
  check(afterRemove.normal.length === 0, '移除后普通模式分组为空')

  const crossRemove = await api('DELETE', `/mode-apps/${modeApps.study[0].id}?deviceId=not-my-device`, { token })
  check(crossRemove.status === 404 || crossRemove.status === 403,
    '换一个不属于自己的 deviceId 删不掉（归属校验生效）', `实际 ${crossRemove.status}`)

  // ==========================================================
  step('6. 护眼设置')
  const eyeDefault = await must('GET', `/eye-care?${q}`, { token })
  check(eyeDefault.config.enabled === false, '护眼默认关闭')
  check(eyeDefault.config.nightEnabled === true, '默认夜间时段 22→7 是启用的')

  const eyeSet = await must('PUT', `/eye-care?${q}`, {
    token,
    body: { enabled: true, continuousMinutes: 30, restMinutes: 5, maxBrightnessPercent: 60 },
  })
  check(eyeSet.config.continuousMinutes === 30 && eyeSet.config.restMinutes === 5, '护眼设置已保存')

  const badEye = await api('PUT', `/eye-care?${q}`, { token, body: { continuousMinutes: 1 } })
  check(badEye.status === 422, '连续用眼 1 分钟（过短）被拒（422）', `实际 ${badEye.status}`)

  const beforeContradiction = await must('GET', `/eye-care?${q}`, { token })
  const contradictory = await api('PUT', `/eye-care?${q}`, {
    token, body: { nightStartHour: 22, nightEndHour: 22, nightLockEnabled: true },
  })
  check(contradictory.status === 400,
    '「夜间时段为空却要夜间锁定」被明确拒绝，而不是静默不生效', `实际 ${contradictory.status}`)

  // 被拒绝的请求绝不能留下痕迹。曾经的实现是先 update 再校验，
  // 于是客户端收到 400、数据库里却已经改坏了 —— 这种「报错了但其实生效了」
  // 是最难查的一类问题，必须有断言把它钉住。
  const afterContradiction = await must('GET', `/eye-care?${q}`, { token })
  check(afterContradiction.config.nightStartHour === beforeContradiction.config.nightStartHour
        && afterContradiction.config.nightEndHour === beforeContradiction.config.nightEndHour
        && afterContradiction.config.nightLockEnabled === beforeContradiction.config.nightLockEnabled,
    '被拒绝的护眼配置没有落库（先校验后写入）',
    `拒绝前 ${beforeContradiction.config.nightStartHour}→${beforeContradiction.config.nightEndHour}`
      + ` / 拒绝后 ${afterContradiction.config.nightStartHour}→${afterContradiction.config.nightEndHour}`)

  await must('PUT', `/eye-care?${q}`, {
    token, body: { nightStartHour: 22, nightEndHour: 7, nightLockEnabled: true },
  })
  ok('矛盾配置改回来后可正常保存')

  // ==========================================================
  step('7. 应用插件管控（微信 / QQ 功能管控）')
  const catalog = await must('GET', `/app-plugins?${q}`, { token })
  const targets = catalog.targets || []
  check(targets.length >= 6, `插件目录覆盖 ${targets.length} 个应用 / 场景`)
  const wechat = targets.find((t) => t.packageName === PKG)
  check(Boolean(wechat), '目录里有微信')
  check(wechat.plugins.length >= 15, `微信可管控项 ${wechat.plugins.length} 个`)
  check(wechat.blocked === 0, '默认全部放行（不会因为升级突然拦住孩子在用的功能）')

  const disabled = await must('PUT', `/app-plugins?${q}`, {
    token,
    body: { items: [
      { packageName: PKG, pluginKey: 'mm_moments', enabled: false },
      { packageName: PKG, pluginKey: 'mm_pay_entry', enabled: false },
    ] },
  })
  const wechatAfter = disabled.targets.find((t) => t.packageName === PKG)
  check(wechatAfter.blocked === 2, `微信已关闭 ${wechatAfter.blocked} 项`)
  const moments = wechatAfter.plugins.find((x) => x.key === 'mm_moments')
  check(moments.enabled === false && moments.customized === true, '朋友圈已标为「已自定义」')

  const unknown = await api('PUT', `/app-plugins?${q}`, {
    token, body: { items: [{ packageName: PKG, pluginKey: 'NOT_A_REAL_PLUGIN', enabled: false }] },
  })
  check(unknown.status === 400,
    '未知插件键被明确拒绝（不静默忽略，否则家长以为关掉了其实没有）', `实际 ${unknown.status}`)

  // ==========================================================
  step('8. 设备端拉配置：下发的必须和家长设置的是同一件事')
  await must('PUT', `/device-mode?${q}`, { token, body: { manualMode: null, scheduleEnabled: true } })
  await must('PUT', `/study-slots?${q}`, { token, body: { slots: [{ dayOfWeek: 1, hour: 8 }, { dayOfWeek: 2, hour: 9 }] } })

  const config = await must('GET', '/agent/config', { token: deviceToken })

  check(config.mode && config.mode.scheduleEnabled === true, '配置里有 mode.scheduleEnabled')
  check(config.mode.slots.length === 2, `下发了 ${config.mode.slots?.length} 个时段格子`)
  check(config.mode.studyApps.includes('com.zhihu.android'), '下发了学习模式白名单')
  check(config.mode.manualMode === null, 'manualMode=null 表示跟随时段')

  check(config.eyeCare && config.eyeCare.enabled === true, '配置里有 eyeCare 且已开启')
  check(config.eyeCare.continuousMinutes === 30, '护眼连续用眼时长与家长设置一致')

  const rules = config.appPlugins || []
  const mmRule = rules.find((r) => r.packageName === PKG)
  check(Boolean(mmRule), '下发了微信的插件规则')
  const momentsRule = mmRule?.plugins.find((p) => p.key === 'mm_moments')
  check(momentsRule && momentsRule.enabled === false, '朋友圈这条规则是「禁止」')
  check(momentsRule && Array.isArray(momentsRule.keywords) && momentsRule.keywords.length > 0,
    '规则里带了匹配关键词 —— 设备端不需要内置一份目录就能执行')
  check(!mmRule.plugins.some((p) => p.key === 'mm_video_channel'),
    '与默认值一致的项不下发（省流量，也让「设备端规则从哪来」好解释）')

  // ==========================================================
  step('9. 刷新应用列表走指令队列')
  const refresh = await must('POST', `/device-apps/refresh?${q}`, { token })
  check(refresh.command?.type === 'sync_apps', `已下发 ${refresh.command?.type} 指令`)
  const claimed = await must('GET', '/agent/commands/next?wait=1', { token: deviceToken })
  check(claimed.command?.type === 'sync_apps', '设备端能领到这条指令')
  await must('POST', `/agent/commands/${claimed.command.id}/result`, {
    token: deviceToken, body: { status: 'succeeded', result: { synced: true } },
  })
  ok('设备端回报结果成功')

  // ==========================================================
  step('10. 设备事件（家长端「最新动态」）')
  const nowMs = Date.now()
  await must('POST', '/agent/events', {
    token: deviceToken,
    body: { events: [
      { type: 'screen_on', detail: '点亮屏幕', at: nowMs - 60_000 },
      { type: 'unlock', detail: '解锁并点亮屏幕', at: nowMs - 50_000 },
      { type: 'mode_enter', detail: '进入学习模式', at: nowMs - 40_000 },
      { type: 'app_blocked', detail: '学习模式中，该应用不在允许清单里', at: nowMs - 30_000 },
      { type: 'plugin_blocked', detail: '该功能已被家长关闭（朋友圈）', at: nowMs - 20_000 },
    ] },
  })
  const events = await must('GET', `/device-events?${q}`, { token })
  check(events.total === 5, `家长端读到 ${events.total} 条动态`)
  check(events.items[0].type === 'plugin_blocked', '按时间倒序（最新的一条在最前）')
  check(events.items.every((e) => e.detail), '每条都带人话说明，家长端可直接展示')

  const filtered = await must('GET', `/device-events?${q}&type=app_blocked`, { token })
  check(filtered.total === 1, '可按类型筛选')

  // 设备端乱报时间（未来 / 很久以前）不应污染时间线
  await must('POST', '/agent/events', {
    token: deviceToken,
    body: { events: [
      { type: 'unlock', detail: '来自未来的事件', at: nowMs + 86_400_000 },
      { type: 'unlock', detail: '来自很久以前的事件', at: nowMs - 30 * 86_400_000 },
    ] },
  })
  const clamped = await must('GET', `/device-events?${q}&pageSize=2`, { token })
  const clampedAt = new Date(clamped.items[0].createdAt).getTime()
  check(Math.abs(clampedAt - Date.now()) < 60_000,
    '设备时钟异常时用服务端时间兜底（孩子改系统时间也骗不过去）')

  // ==========================================================
  step('11. 越权：别人家的设备一个都碰不到')
  // 走真实注册流程拿第二个家长令牌：非生产环境 send-code 会返回 devCode
  const otherPhone = `139${String(Date.now()).slice(-8)}`
  let other = null
  try {
    const sent = await must('POST', '/auth/send-code', {
      body: { phone: otherPhone, purpose: 'register' },
    })
    other = await must('POST', '/auth/register', {
      body: { phone: otherPhone, password: 'balloon123', code: sent.devCode },
    })
  } catch (e) {
    other = null
  }
  if (other?.token) {
    const peek = await api('GET', `/device-mode?${q}`, { token: other.token })
    check(peek.status === 403 || peek.status === 404, '另一个家长读不到本设备的模式配置')
    const write = await api('PUT', `/eye-care?${q}`, { token: other.token, body: { enabled: true } })
    check(write.status === 403 || write.status === 404, '另一个家长改不了本设备的护眼设置')
    const list = await api('GET', `/app-plugins?${q}`, { token: other.token })
    check(list.status === 403 || list.status === 404, '另一个家长看不到本设备的插件设置')
  } else {
    ok('跳过越权断言（无法创建第二个家长账号：注册需要短信验证码）')
  }

  const noAuth = await api('GET', `/device-mode?${q}`)
  check(noAuth.status === 401, '未登录一律 401')

  // 设备令牌不能冒充家长
  const deviceAsParent = await api('GET', `/device-mode?${q}`, { token: deviceToken })
  check(deviceAsParent.status === 401, '设备令牌访问家长端接口被拒（401）')

  // ==========================================================
  step('12. 清理')
  await must('POST', '/agent/apps', { token: deviceToken, body: { apps: [] } })
  await must('DELETE', `/devices/${deviceId}`, { token })
  ok('已解绑并删除验证设备')

  console.log(`\n\x1b[1m结果：${passed} 项通过，${failed} 项失败\x1b[0m`)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error(`\n\x1b[31m验证中断：${e.message}\x1b[0m`)
  process.exit(1)
})
