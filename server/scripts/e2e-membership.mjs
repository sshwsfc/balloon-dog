#!/usr/bin/env node
/**
 * 会员体系的端到端验证。
 *
 * 会员这件事有四条互相独立的链路，任何一条断了都不算能上线，所以分开验：
 *
 *   1. **档位**：普通 → 会员 → 超级会员，充值才升级，过期会惰性降级回普通；
 *   2. **动态定价**：金额由服务端的规则表算出来，后台改一条规则家长端报价立刻跟着变；
 *      折扣一律按原价算再相加（不是折上折）、不可叠加的规则同一单只取一条、实付有 1 元地板；
 *   3. **门禁**：答题解锁 / 远程监控 / 多设备是会员；AI 洞察是超级会员。
 *      普通账号撞上门禁拿到的是 `MEMBERSHIP_REQUIRED`（带 requiredTier），前端据此弹升级引导；
 *   4. **订单**：金额在下单那一刻快照进订单，之后改规则不会篡改历史订单。
 *
 * 用法：node scripts/e2e-membership.mjs        （默认 http://localhost:4000/api）
 *      API_BASE=http://localhost:4002/api node scripts/e2e-membership.mjs
 *
 * 需要一个跑着的后端 + 已 seed 的库（用 admin 账号读后台接口）。脚本自己注册一个临时家长，
 * 结束时会把它连订单带设备一起删干净。
 */

import { PrismaClient } from '@prisma/client'

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
    method, headers, body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let parsed = null
  try { parsed = text ? JSON.parse(text) : null } catch { parsed = text }
  return { ok: res.ok, status: res.status, body: parsed, text }
}

const must = async (method, path, options) => {
  const r = await api(method, path, options)
  if (!r.ok) throw new Error(`${method} ${path} → ${r.status} ${r.body?.message || ''}`)
  return r.body
}

const yuan = (cents) => `￥${(cents / 100).toFixed(2)}`
const plansOf = (tiers, tier) => tiers.find((t) => t.tier === tier).plans
const planOf = (tiers, code) => {
  for (const group of tiers) {
    const hit = group.plans.find((p) => p.code === code)
    if (hit) return hit
  }
  return null
}

/**
 * 报价本身必须自洽：实付 = 原价 − 折扣合计（不低于 1 元地板）+ 受邀上浮额。
 *
 * `discountCents` 是「原价 − 实付」，受邀加价会把它抵消甚至变成负数 —— 家长端只在
 * `> 0` 时显示「已优惠」，所以这里不去断言它非负，只断言这条等式本身成立。
 */
function checkQuoteArithmetic(label, quote) {
  const discount = quote.adjustments.reduce((acc, a) => acc + a.amountCents, 0)
  const surcharge = quote.referral?.surchargeCents ?? 0
  check(
    quote.finalCents === Math.max(100, quote.originalCents - discount) + surcharge &&
      quote.discountCents === quote.originalCents - quote.finalCents,
    `${label} 实付 = 原价 − 折扣合计（不低于 1 元地板）+ 受邀上浮额`,
    `原价 ${quote.originalCents} 折扣 ${discount} 上浮 ${surcharge} 实付 ${quote.finalCents}`,
  )
  check(
    quote.monthlyEquivalentCents === Math.round(quote.finalCents / quote.months),
    `${label} 折合月价按 months 折算`,
    `${quote.monthlyEquivalentCents} vs ${Math.round(quote.finalCents / quote.months)}`,
  )
  check(
    quote.adjustments.every((a) => a.amountCents >= 0 && a.name && a.ruleId),
    `${label} 每条命中规则都有名字、id 和非负的减免额`,
  )
  /*
    受邀加价**不**进 adjustments：adjustments 是一份「逐条相加 == 常规优惠」的清单，
    把正数混进去会让这条恒等式变成假的。所以这里只验常规明细，再单独验加价那段关系。
  */
  check(
    quote.adjustments.every((a) =>
      a.discountType === 'percent'
        ? a.amountCents === Math.round((quote.originalCents * a.discountValue) / 100)
        : a.amountCents === a.discountValue,
    ),
    `${label} 常规规则的百分比折扣按原价计算（不是折上折）`,
  )
  check(
    quote.adjustments.every((a) => !a.ruleId.startsWith('referral:')),
    `${label} 受邀加价不混进优惠明细（否则「逐条相加 == 优惠」这条恒等式会假）`,
  )

  // 受邀加价：结账价 = max(常规定价实付, 受邀价)，多收的部分记在 referral.surchargeCents
  const normalFinal = quote.originalCents - quote.adjustments.reduce((acc, a) => acc + a.amountCents, 0)
  check(
    quote.referral.baseCents === normalFinal,
    `${label} 受邀价的基数是常规定价算完的实付价（不是原价）`,
    `${quote.referral.baseCents} vs ${normalFinal}`,
  )
  if (quote.referral.applied) {
    check(
      quote.finalCents === quote.referral.candidateCents &&
        quote.finalCents > normalFinal &&
        quote.referral.surchargeCents === quote.finalCents - normalFinal,
      `${label} 受邀价生效时结账价 = 受邀价，比常规定价多收 ${quote.referral.surchargeCents} 分`,
    )
  } else {
    check(
      quote.finalCents === normalFinal && quote.referral.surchargeCents === 0,
      `${label} 受邀价不生效时按常规定价结算`,
    )
  }
}

async function main() {
  console.log('\x1b[1m气球狗 · 会员体系端到端验证\x1b[0m')
  console.log(`  API ${API}`)

  const prisma = new PrismaClient()
  const phone = `139${String(Date.now()).slice(-8)}`
  const password = 'e2e-membership-123'
  const created = { userId: null, deviceIds: [], extraUsers: [] }

  try {
    // ==========================================================
    step('1. 注册一个全新的临时家长')
    // ==========================================================
    const sent = await must('POST', '/auth/send-code', { body: { phone, purpose: 'register' } })
    check(Boolean(sent.devCode), `非生产环境返回 devCode（${sent.devCode}）`)
    const reg = await must('POST', '/auth/register', {
      body: { phone, password, code: sent.devCode, nickname: '会员E2E' },
    })
    const token = reg.token
    created.userId = reg.user?.id ?? null
    check(Boolean(token), '注册成功并拿到 token')

    const overview = await must('GET', '/membership', { token })
    check(overview.status.tier === 'ordinary', '新账号默认是普通账号', overview.status.tier)
    check(overview.status.active === false, '普通账号没有有效期');
    check(overview.mockPay === true, '当前是模拟支付环境（MEMBERSHIP_MOCK_PAY）')
    check(Array.isArray(overview.entitlements) && overview.entitlements.length === 4, '返回 4 项权益', String(overview.entitlements?.length))
    const ent = (key) => overview.entitlements.find((e) => e.key === key)
    check(ent('quizUnlock')?.minTier === 'member' && ent('remoteMonitor')?.minTier === 'member' && ent('multiDevice')?.minTier === 'member', '答题解锁 / 远程监控 / 多设备是会员权益')
    check(ent('aiInsight')?.minTier === 'super', 'AI 洞察是超级会员权益')
    check(overview.status.entitlements.length === 0, '普通账号一项权益都没解锁')

    // ==========================================================
    step('2. 动态定价：全新账号 + 1 台设备的报价必须分毫不差')
    // ==========================================================
    // 手算依据（默认规则，见 membership.constants.ts 的 DEFAULT_PRICING_RULES）：
    //   首单立减 3 元（-300，可叠加）+ 新用户 7 天内 95 折（按原价的 5%）
    //   按年再命中「年付立减 30 元」（-3000，不可叠加）；连续包月再命中「连续包月 8 折」（按原价 20%）
    const fresh = await must('GET', '/membership', { token })
    const expectFresh = {
      member_monthly: 1500 - 300 - 75,
      member_yearly: 14800 - 300 - 3000 - 740,
      member_auto_monthly: 1200 - 300 - 240 - 60,
      super_monthly: 2500 - 300 - 125,
      super_yearly: 24800 - 300 - 3000 - 1240,
      super_auto_monthly: 2000 - 300 - 400 - 100,
    }
    for (const [code, cents] of Object.entries(expectFresh)) {
      const quote = planOf(fresh.tiers, code)
      check(quote?.finalCents === cents, `${code} 实付 ${yuan(cents)}`, `实际 ${quote ? yuan(quote.finalCents) : '（没这个套餐）'}`)
    }
    const withRules = planOf(fresh.tiers, 'member_monthly')
    check(
      withRules.adjustments.some((a) => a.name.includes('首单')) && withRules.adjustments.some((a) => a.name.includes('新用户')),
      `新账号命中「首单立减」+「新用户 95 折」`,
      withRules.adjustments.map((a) => a.name).join('、'),
    )
    for (const group of fresh.tiers) for (const q of group.plans) checkQuoteArithmetic(q.code, q)

    // ==========================================================
    step('3. 门禁：普通账号撞上会员功能要拿到 MEMBERSHIP_REQUIRED')
    // ==========================================================
    const insights = await api('GET', '/insights', { token })
    check(insights.status === 403, 'GET /insights → 403', `实际 ${insights.status}`)
    check(insights.body?.title === 'MEMBERSHIP_REQUIRED', '错误码是 MEMBERSHIP_REQUIRED', String(insights.body?.title))
    check(insights.body?.detail?.requiredTier === 'super' && insights.body?.detail?.entitlement === 'aiInsight', 'detail 带 requiredTier=super / entitlement=aiInsight', JSON.stringify(insights.body?.detail))

    const quiz = await api('GET', '/quiz/config', { token })
    check(quiz.status === 403 && quiz.body?.detail?.requiredTier === 'member', 'GET /quiz/config → 403 且 requiredTier=member', JSON.stringify(quiz.body?.detail))

    const screenMonitor = await api('PUT', '/screen-monitor', { token, body: { enabled: true } })
    check(screenMonitor.status === 403 && screenMonitor.body?.detail?.entitlement === 'aiInsight', '屏幕洞察（截屏 + AI 分析）按超级会员拦', JSON.stringify(screenMonitor.body?.detail))

    // 用量上限属于基础管控：整页 403 会把「每日使用时长」这种基础限制一起挡掉，所以刻意不拦。
    // 此刻账号还没绑设备，接口会因为缺设备报 404 —— 只要不是 403 就说明没被会员门禁拦。
    const budgets = await api('GET', '/usage-budgets', { token })
    check(budgets.status !== 403, '用量上限不按会员拦（基础管控对任何档位都可用）', `实际 ${budgets.status}`)

    // ==========================================================
    step('4. 设备额度：普通账号只能绑 1 台，第 2 台撞 multiDevice')
    // ==========================================================
    const bindDevice = async (prefix, name) => {
      const code = `${prefix}${Date.now().toString(36).toUpperCase().slice(-6)}`.slice(0, 12)
      const r = await must('POST', '/agent/register', {
        body: { deviceCode: code, deviceSecret: `e2e-membership-${prefix.toLowerCase()}-000000000000`, model: name, os: 'Android', osVersion: '14' },
      })
      void r
      const bound = await api('POST', '/devices/bind', { token, body: { deviceCode: code, name } })
      if (bound.ok) created.deviceIds.push(bound.body.device.id)
      return bound
    }
    const first = await bindDevice('MB1', 'E2E 会员一号机')
    check(first.ok, '第 1 台设备免费绑定成功', `${first.status} ${first.body?.message || ''}`)
    const budgetsWithDevice = await api('GET', '/usage-budgets', { token })
    check(budgetsWithDevice.ok, '用量上限在普通账号上也能正常读取（200）', `实际 ${budgetsWithDevice.status}`)
    const second = await bindDevice('MB2', 'E2E 会员二号机')
    check(second.status === 403, '第 2 台设备被拦（403）', `实际 ${second.status}`)
    check(second.body?.title === 'MEMBERSHIP_REQUIRED' && second.body?.detail?.entitlement === 'multiDevice', '拦的是 multiDevice 权益而不是「最多 20 台」', JSON.stringify(second.body?.detail))

    // ==========================================================
    step('5. 多设备规则：绑上第 2 台之后报价里要出现多设备折扣')
    // ==========================================================
    await must('POST', '/membership/orders', { token, body: { planCode: 'member_monthly', payChannel: 'alipay' } })
    const orderForDevice = await must('GET', '/membership/orders', { token })
    await must('POST', `/membership/orders/${orderForDevice.orders[0].orderNo}/pay`, { token, body: { outcome: 'success' } })
    const secondAfterPaid = await bindDevice('MB3', 'E2E 会员三号机')
    check(secondAfterPaid.ok, '充完会员后第 2 台设备可以绑定了', `${secondAfterPaid.status} ${secondAfterPaid.body?.message || ''}`)

    const twoDevices = await must('GET', '/membership', { token })
    const multi = planOf(twoDevices.tiers, 'member_monthly')
    check(multi.adjustments.some((a) => a.name.includes('多设备')), '2 台设备命中「多设备家庭 9 折」', multi.adjustments.map((a) => a.name).join('、'))
    check(multi.finalCents === 1500 - 150 - 150 - 75, `多设备后 会员·按月 = ${yuan(1500 - 150 - 150 - 75)}`, yuan(multi.finalCents))

    // ==========================================================
    step('6. 订单：金额快照、待支付单复用、支付后档位立即生效')
    // ==========================================================
    const statusAfterPay = await must('GET', '/membership', { token })
    check(statusAfterPay.status.tier === 'member', '支付后档位变成会员', statusAfterPay.status.tier)
    check(statusAfterPay.status.active === true && statusAfterPay.status.daysLeft >= 28, `有效期约 1 个月（剩余 ${statusAfterPay.status.daysLeft} 天）`)
    check(statusAfterPay.status.entitlements.includes('quizUnlock') && statusAfterPay.status.entitlements.includes('remoteMonitor') && statusAfterPay.status.entitlements.includes('multiDevice'), '会员解锁答题解锁 / 远程监控 / 多设备')
    check(!statusAfterPay.status.entitlements.includes('aiInsight'), '会员还没解锁 AI 洞察')
    check(statusAfterPay.status.totalPaidCents > 0, `累计充值已累加（${yuan(statusAfterPay.status.totalPaidCents)}）`)

    const paidQuiz = await api('GET', '/quiz/config', { token })
    check(paidQuiz.ok, '会员可以访问答题解锁接口了', `实际 ${paidQuiz.status}`)
    const stillGated = await api('GET', '/insights', { token })
    check(stillGated.status === 403 && stillGated.body?.detail?.requiredTier === 'super', '会员访问 AI 洞察仍然被拦（提示升级超级会员）', JSON.stringify(stillGated.body?.detail))

    const reuseA = await must('POST', '/membership/orders', { token, body: { planCode: 'super_yearly', payChannel: 'alipay' } })
    const reuseB = await must('POST', '/membership/orders', { token, body: { planCode: 'super_yearly', payChannel: 'wechat' } })
    check(reuseA.order.orderNo === reuseB.order.orderNo, '同一套餐重复下单不会堆单，复用那条待支付订单', `${reuseA.order.orderNo} vs ${reuseB.order.orderNo}`)
    const quoteSuperYearly = planOf(twoDevices.tiers, 'super_yearly')
    check(reuseA.order.amountCents === quoteSuperYearly.finalCents, '订单金额与报价一致', `${reuseA.order.amountCents} vs ${quoteSuperYearly.finalCents}`)
    check(reuseA.order.originalCents === 24800 && Array.isArray(reuseA.order.adjustments) && reuseA.order.adjustments.length > 0, '订单存了原价与规则明细快照')

    const cancelled = await must('POST', `/membership/orders/${reuseA.order.orderNo}/cancel`, { token })
    check(cancelled.order?.status === 'cancelled' || cancelled.status === 'cancelled', '待支付订单可以取消', JSON.stringify(cancelled.order?.status ?? cancelled.status))
    const payCancelled = await api('POST', `/membership/orders/${reuseA.order.orderNo}/pay`, { token, body: { outcome: 'success' } })
    check(!payCancelled.ok, '已取消的订单不能再支付', `实际 ${payCancelled.status}`)

    // ==========================================================
    step('7. 支付失败不下发权益，同档续费顺延 / 升级重新起算')
    // ==========================================================
    const failOrder = await must('POST', '/membership/orders', { token, body: { planCode: 'member_yearly', payChannel: 'alipay' } })
    const failedPay = await must('POST', `/membership/orders/${failOrder.order.orderNo}/pay`, { token, body: { outcome: 'fail' } })
    check(failedPay.order?.status === 'failed', '模拟支付失败会把订单置为 failed', JSON.stringify(failedPay.order?.status))
    const afterFail = await must('GET', '/membership', { token })
    check(afterFail.status.tier === 'member', '支付失败不会改变档位', afterFail.status.tier)
    const doublePay = await api('POST', `/membership/orders/${failOrder.order.orderNo}/pay`, { token, body: { outcome: 'success' } })
    check(!doublePay.ok, '失败订单不能补一次成功', `实际 ${doublePay.status}`)

    const beforeRenew = await must('GET', '/membership', { token })
    const renewal = await must('POST', '/membership/orders', { token, body: { planCode: 'member_monthly', payChannel: 'alipay' } })
    check(renewal.order.adjustments.some((a) => a.name.includes('续费')), '同档续费命中「会员续费 9 折」规则', renewal.order.adjustments.map((a) => a.name).join('、'))
    await must('POST', `/membership/orders/${renewal.order.orderNo}/pay`, { token, body: { outcome: 'success' } })
    const afterRenew = await must('GET', '/membership', { token })
    check(afterRenew.status.daysLeft > beforeRenew.status.daysLeft + 20, `同档续费顺延（${beforeRenew.status.daysLeft} → ${afterRenew.status.daysLeft} 天）`)
    check(afterRenew.status.startedAt === beforeRenew.status.startedAt, '续费不重算开通时间')

    const upgrade = await must('POST', '/membership/orders', { token, body: { planCode: 'super_monthly', payChannel: 'wechat' } })
    check(upgrade.order.adjustments.some((a) => a.name.includes('升级超级会员抵扣')), '会员升超级命中「升级超级会员抵扣」规则', upgrade.order.adjustments.map((a) => a.name).join('、'))
    await must('POST', `/membership/orders/${upgrade.order.orderNo}/pay`, { token, body: { outcome: 'success' } })
    const afterUpgrade = await must('GET', '/membership', { token })
    check(afterUpgrade.status.tier === 'super', '升到超级会员', afterUpgrade.status.tier)
    check(afterUpgrade.status.daysLeft <= 32, `升级按新周期重新起算，而不是在原有效期上叠加（剩余 ${afterUpgrade.status.daysLeft} 天）`)
    check(afterUpgrade.status.entitlements.includes('aiInsight'), '超级会员解锁 AI 洞察')
    const superInsights = await api('GET', '/insights', { token })
    check(superInsights.ok, '超级会员可以访问 AI 洞察接口了', `实际 ${superInsights.status}`)

    const [orderRow] = await prisma.membershipOrder.findMany({
      where: { orderNo: upgrade.order.orderNo }, select: { amountCents: true, originalCents: true, adjustments: true },
    })
    check(orderRow?.amountCents === upgrade.order.amountCents, '订单金额原样落库（不会被后续重算覆盖）')

    // ==========================================================
    step('8. 连续包月与自动续费开关')
    // ==========================================================
    const autoBuy = await must('POST', '/membership/orders', { token, body: { planCode: 'super_auto_monthly', payChannel: 'alipay' } })
    await must('POST', `/membership/orders/${autoBuy.order.orderNo}/pay`, { token, body: { outcome: 'success' } })
    const autoOn = await must('GET', '/membership', { token })
    check(autoOn.status.autoRenew === true, '买「连续包月」后自动续费自动开启')
    check(autoOn.status.renewTier === 'super', '记下了要续的档位', String(autoOn.status.renewTier))
    const off = await must('POST', '/membership/auto-renew', { token, body: { enabled: false } })
    check(off.status?.autoRenew === false, '可以随时关掉自动续费')
    const onAgain = await must('POST', '/membership/auto-renew', { token, body: { enabled: true } })
    check(onAgain.status?.autoRenew === true, '也可以再打开')
    const ord = await must('POST', '/membership/orders', { token, body: { planCode: 'member_monthly', payChannel: 'alipay' } })
    await must('POST', `/membership/orders/${ord.order.orderNo}/pay`, { token, body: { outcome: 'success' } })
    const downgraded = await must('GET', '/membership', { token })
    check(downgraded.status.autoRenew === false, '续了别的档位后，原来那个「连续包月」的自动续费会被关掉', String(downgraded.status.autoRenew))

    // ==========================================================
    step('9. 订单列表：分页与状态过滤')
    // ==========================================================
    const page1 = await must('GET', '/membership/orders?page=1&pageSize=2', { token })
    check(Array.isArray(page1.orders) && page1.orders.length === 2, '按 pageSize 分页', String(page1.orders?.length))
    check(page1.total >= 5, `订单总数正确（${page1.total}）`)
    const page2 = await must('GET', '/membership/orders?page=2&pageSize=2', { token })
    check(page2.orders[0]?.orderNo !== page1.orders[0]?.orderNo, '翻页拿到不同的订单')
    const allOrders = await must('GET', '/membership/orders?page=1&pageSize=50', { token })
    const statuses = new Set(allOrders.orders.map((o) => o.status))
    check(statuses.has('paid') && statuses.has('cancelled') && statuses.has('failed'), '历史订单里同时有已支付 / 已取消 / 支付失败', [...statuses].join('、'))
    check(allOrders.orders.every((o) => typeof o.periodLabel === 'string' && typeof o.tier === 'string'), '订单带档位与周期文案（前端直接渲染）')

    // ==========================================================
    step('10. 后台改规则，家长端报价立刻跟着变')
    // ==========================================================
    const adminLogin = await must('POST', '/admin/login', { body: { username: ADMIN_USER, password: ADMIN_PASSWORD } })
    const adminToken = adminLogin.token
    check(Boolean(adminToken), '管理员登录成功')

    const baseline = planOf(await must('GET', '/membership', { token }).then((r) => r.tiers), 'member_monthly').finalCents
    const created1 = await must('POST', '/admin/membership/rules', {
      token: adminToken,
      body: {
        name: 'E2E 临时规则·月付 1 元封顶', conditionType: 'always',
        targetTier: 'member', targetPeriod: 'monthly',
        discountType: 'amount', discountValue: 100000, stackable: true, priority: 999, enabled: true,
      },
    })
    const ruleId = created1.rule.id
    const floored = planOf(await must('GET', '/membership', { token }).then((r) => r.tiers), 'member_monthly')
    check(floored.finalCents === 100, '加一条超大额规则后实付落到 1 元地板', yuan(floored.finalCents))
    const flooredSum = floored.adjustments.reduce((acc, a) => acc + a.amountCents, 0)
    check(floored.discountCents === 1500 - 100 && flooredSum === floored.discountCents,
      '地板价生效时明细会被削到与实付一致（逐条相加永远等于原价 - 实付）',
      `折扣合计 ${floored.discountCents} 明细合计 ${flooredSum}`)

    await must('DELETE', `/admin/membership/rules/${ruleId}`, { token: adminToken })
    const restored = planOf(await must('GET', '/membership', { token }).then((r) => r.tiers), 'member_monthly')
    check(restored.finalCents === baseline, '删掉规则后报价回到原值', `${yuan(baseline)} → ${yuan(restored.finalCents)}`)

    const incomplete = await api('POST', '/admin/membership/rules', {
      token: adminToken,
      body: { name: '缺参数的规则', conditionType: 'device_count', discountType: 'percent', discountValue: 10, enabled: true },
    })
    check(incomplete.status === 422, '条件缺参数的规则被拒（422）', `实际 ${incomplete.status}`)
    const badPercent = await api('POST', '/admin/membership/rules', {
      token: adminToken,
      body: { name: '折扣率越界', conditionType: 'always', discountType: 'percent', discountValue: 150, enabled: true },
    })
    check(badPercent.status === 422, '折扣率超过 100% 被拒（422）', `实际 ${badPercent.status}`)

    const rulesList = await must('GET', '/admin/membership/rules?page=1&pageSize=50', { token: adminToken })
    check(rulesList.items.every((r) => typeof r.complete === 'boolean'), '规则列表标出「参数是否齐全」（不齐全的启用规则永远不会命中）')
    check(rulesList.items.some((r) => r.name.includes('首单')), '默认规则在列表里')

    const simulate = await must('POST', '/admin/membership/simulate', {
      token: adminToken,
      body: { planCode: 'member_monthly', deviceCount: 3, hasPaid: false, registeredDaysAgo: 1, activeTier: 'ordinary' },
    })
    check(
      simulate.result?.finalCents === 1500 - 300 - 150 - 75,
      `试算不依赖具体账号（3 台设备新用户 → ${yuan(1500 - 300 - 150 - 75)}）`,
      yuan(simulate.result?.finalCents),
    )
    check(simulate.result?.adjustments?.length === 3, '试算按画像给出 3 条命中规则', String(simulate.result?.adjustments?.length))

    // ==========================================================
    step('11. 后台统计的口径：按有效期算档位，不读字段原值')
    // ==========================================================
    const stats = await must('GET', '/admin/membership/stats?days=30', { token: adminToken })
    check(stats.totals.paidAmountCents >= afterUpgrade.status.totalPaidCents, `累计收入含本次订单（全站 ${yuan(stats.totals.paidAmountCents)}）`)
    check(typeof stats.users.activeMember === 'number' && typeof stats.users.activeSuper === 'number', '统计区分有效会员与有效超级会员')
    check(stats.users.activeTotal === stats.users.activeMember + stats.users.activeSuper, '有效会员合计 = 会员 + 超级会员')
    check(Array.isArray(stats.series) && stats.series.length === 30, `每日序列补齐到 30 天（含 0 值，避免折线连成假斜线）`, String(stats.series?.length))
    check(stats.series.every((d) => typeof d.amountCents === 'number' && typeof d.count === 'number'), '每日序列每天都有金额与笔数')
    check(stats.config.enabledPlans >= 6 && stats.config.enabledRules >= 7, `统计里附了套餐/规则配置数（${stats.config.enabledPlans} / ${stats.config.enabledRules}）`)
    const adminOrders = await must('GET', `/admin/membership/orders?q=${encodeURIComponent(phone)}&page=1&pageSize=20`, { token: adminToken })
    check(adminOrders.items.length >= 5 && adminOrders.items.every((o) => o.user?.phone === phone), '后台能按家长手机号过滤订单', String(adminOrders.items?.length))
    check(
      typeof adminOrders.summary?.statusCounts?.paid?.count === 'number' && adminOrders.summary.paidAmountCents > 0,
      '订单列表返回状态小计（笔数 + 金额）',
      JSON.stringify(adminOrders.summary?.statusCounts?.paid),
    )
    const snapshot = adminOrders.items.find((o) => o.orderNo === upgrade.order.orderNo)
    check(Array.isArray(snapshot?.adjustments) && snapshot.adjustments.length > 0, '后台订单详情能看到下单那刻的规则快照（不是拿今天价格重算的）')

    // ==========================================================
    step('12. 惰性降级：过期后拉一次接口就要把档位写回去')
    // ==========================================================
    const row = await prisma.user.findUnique({ where: { phone }, select: { id: true } })
    await prisma.user.update({
      where: { id: row.id },
      data: { membershipExpiresAt: new Date(Date.now() - 24 * 3600 * 1000), membershipAutoRenew: false },
    })
    const expired = await must('GET', '/membership', { token })
    check(expired.status.tier === 'ordinary' && expired.status.active === false, '过期账号读出来就是普通账号', expired.status.tier)
    const written = await prisma.user.findUnique({ where: { id: row.id }, select: { membershipTier: true, membershipRenewTier: true } })
    check(written.membershipTier === 'ordinary', '过期不是「显示上降级」——字段被真的写回 ordinary（定时任务停了也不会永久白嫖）', written.membershipTier)
    check(written.membershipRenewTier === null, '顺带把待续档位清掉')
    const gatedAgain = await api('GET', '/insights', { token })
    check(gatedAgain.status === 403, '过期后 AI 洞察重新被拦（403）', `实际 ${gatedAgain.status}`)
    // ==========================================================
    step('13. 受邀用户定价：会员价格 × 是否被邀请注册')
    // ==========================================================
    /*
      被邀请注册的家长价格**更高** —— 邀请人要拿的分享返现是平台出的，这笔成本落在他的
      订单上，所以结账价 = max(常规定价, 受邀价)。默认规则是「首单上浮 100%」+「续费上浮 25%」。

      每个断言都先用「未受邀的同画像」把常规定价问出来，再拿受邀账号的真实报价去比 ——
      不写死金额。写死金额的话，运营在后台调一次规则这个测试就红了，而它本该验的是**公式**。
    */
    const profile = { hasPaid: false, activeTier: 'ordinary', deviceCount: 0, registeredDaysAgo: 0 }
    const normalQuote = async (planCode, overrides = {}) => {
      const r = await must('POST', '/admin/membership/simulate', {
        token: adminToken,
        body: { planCode, ...profile, ...overrides, invited: false },
      })
      return r.result
    }

    // 邀请人就是本脚本开头注册的那个临时家长；它自己不接受邀请，所以受邀定价不适用。
    const inviterOverview = await must('GET', '/referral', { token })
    check(!inviterOverview.config || typeof inviterOverview.inviteCode === 'string', '临时家长也有邀请码，可以用来拉一个受邀账号')

    const notInvited = await must('GET', '/membership', { token })
    check(
      planOf(notInvited.tiers, 'member_monthly').referral.applicable === false,
      '没通过邀请注册的账号：受邀定价不适用',
      planOf(notInvited.tiers, 'member_monthly').referral.reason,
    )
    check(
      planOf(notInvited.tiers, 'member_monthly').referral.reason.includes('不是通过邀请注册'),
      '并给出可展示的理由（而不是静默按常规定价）',
    )

    // 受邀账号：用一个新手机号 + 邀请码注册
    const inviteePhone = `138${String(Date.now() + 31).slice(-8)}`
    const inviteeSent = await must('POST', '/auth/send-code', { body: { phone: inviteePhone, purpose: 'register' } })
    const inviteeReg = await must('POST', '/auth/register', {
      body: {
        phone: inviteePhone,
        password,
        code: inviteeSent.devCode,
        nickname: '受邀家长',
        inviteCode: inviterOverview.inviteCode,
      },
    })
    const inviteeToken = inviteeReg.token
    created.extraUsers.push({ id: inviteeReg.user.id, phone: inviteePhone })

    const invited = await must('GET', '/membership', { token: inviteeToken })
    const invitedMonthly = planOf(invited.tiers, 'member_monthly')
    const invitedYearly = planOf(invited.tiers, 'member_yearly')
    check(invitedMonthly.referral.applicable === true, '受邀注册的账号：受邀定价适用')
    check(invitedMonthly.referral.applied === true, '而且真的生效了（价格被抬高了）', invitedMonthly.referral.reason)
    check(
      invitedMonthly.referral.surchargeCents > 0,
      `价格比常规定价更高（多收 ${yuan(invitedMonthly.referral.surchargeCents)}）`,
    )
    check(
      invitedMonthly.finalCents > invitedMonthly.referral.baseCents,
      '结账价严格高于常规定价，而不是取了两者中更低的',
    )
    checkQuoteArithmetic('受邀账号月付', invitedMonthly)
    checkQuoteArithmetic('受邀账号年付', invitedYearly)

    const normalMonthly = await normalQuote('member_monthly')
    const normalYearly = await normalQuote('member_yearly')
    check(
      invitedMonthly.finalCents === Math.round(normalMonthly.finalCents * 2),
      `月付按「常规定价 × 200%」算（${yuan(normalMonthly.finalCents)} → ${yuan(invitedMonthly.finalCents)}）`,
      yuan(invitedMonthly.finalCents),
    )
    /*
      首单时两条默认规则**都**命中（50% 那条限首单、25% 那条不限），价格取其中最高的 ——
      这正是「几条规则各算一个价、取 max」的口径，而不是「按优先级挑一条」。
    */
    check(
      invitedMonthly.referral.matchedCount === 2,
      `首单时两条默认规则都命中（命中 ${invitedMonthly.referral.matchedCount} 条）`,
    )
    check(
      invitedYearly.finalCents === Math.round(normalYearly.finalCents * 2),
      `年付同样取最高价（${yuan(normalYearly.finalCents)} → ${yuan(invitedYearly.finalCents)}），而不是被周期限定那条压低`,
      yuan(invitedYearly.finalCents),
    )
    check(
      invitedYearly.referral.ruleName === '受邀好友首单上浮 100%' &&
        invitedMonthly.referral.ruleName === '受邀好友首单上浮 100%',
      '命中的规则名下发到家长端（前端据此展示贵了多少、为什么贵）',
      `${invitedMonthly.referral.ruleName} / ${invitedYearly.referral.ruleName}`,
    )

    // 下单那一刻要落快照：事后改规则不能篡改历史订单
    const inviteeOrder = await must('POST', '/membership/orders', {
      token: inviteeToken,
      body: { planCode: 'member_yearly', payChannel: 'alipay' },
    })
    check(
      inviteeOrder.order.amountCents === invitedYearly.finalCents,
      `下单金额 = 家长端看到的受邀价（${yuan(invitedYearly.finalCents)}）`,
      yuan(inviteeOrder.order.amountCents),
    )
    check(
      inviteeOrder.order.referralRuleName === '受邀好友首单上浮 100%' &&
        inviteeOrder.order.referralSurchargeCents ===
          invitedYearly.finalCents - invitedYearly.referral.baseCents,
      '订单里存了命中的规则名与上浮金额（快照，不靠事后重算）',
      `${inviteeOrder.order.referralRuleName} / ${inviteeOrder.order.referralSurchargeCents}`,
    )
    await must('POST', `/membership/orders/${inviteeOrder.order.orderNo}/pay`, { token: inviteeToken, body: {} })

    // 首单限定：付过费之后首单那条不再命中，落到续费那条（25%）
    const afterPaid = await must('GET', '/membership', { token: inviteeToken })
    const afterPaidMonthly = planOf(afterPaid.tiers, 'member_monthly')
    check(
      afterPaidMonthly.referral.applicable === true && afterPaidMonthly.referral.applied === true,
      '已付费账号仍适用，但换成续费那条加价规则',
      afterPaidMonthly.referral.reason,
    )
    check(
      afterPaidMonthly.referral.ruleName === '受邀好友续费上浮 25%',
      `续费规则接手（${afterPaidMonthly.referral.ruleName}）`,
    )
    /*
      不能拿「未受邀的同画像」去比：这个账号刚付完一笔会员费，activeTier 已经从
      ordinary 变成 member，常规规则跟着变，比出来的差额是会员态带来的。所以这里验的是
      不变量本身 —— finalCents === 常规定价实付 + surchargeCents。
    */
    const afterPaidAdjustments = afterPaidMonthly.adjustments ?? []
    const afterPaidNormal =
      afterPaidMonthly.originalCents - afterPaidAdjustments.reduce((n, a) => n + a.amountCents, 0)
    check(
      afterPaidAdjustments.every((a) => !String(a.ruleId ?? '').startsWith('referral:')) &&
        afterPaidMonthly.finalCents === afterPaidNormal + afterPaidMonthly.referral.surchargeCents,
      '加价不进优惠明细，结账价 = 常规定价实付 + 上浮额（恒等式没被破坏）',
      `实付 ${yuan(afterPaidMonthly.finalCents)} / 常规 ${yuan(afterPaidNormal)} / 上浮 ${yuan(afterPaidMonthly.referral.surchargeCents)}`,
    )

    // 反作弊联动：邀请关系被判作废后不该再被加价
    const referralRow = await prisma.referral.findUnique({ where: { inviteeId: inviteeReg.user.id } })
    check(Boolean(referralRow), '受邀账号在库里有一条邀请关系')
    await prisma.referral.update({ where: { id: referralRow.id }, data: { status: 'invalid' } })
    const invalidated = await must('GET', '/membership', { token: inviteeToken })
    check(
      planOf(invalidated.tiers, 'member_monthly').referral.reason.includes('作废') &&
        planOf(invalidated.tiers, 'member_monthly').referral.applied === false,
      '邀请关系被作废后，回到常规定价并给出「已作废」的理由',
      planOf(invalidated.tiers, 'member_monthly').referral.reason,
    )

    /*
      一口价：低于常规定价时必须**不生效**（取 max 的安全属性 —— 配错规则不能变成打折，
      否则「先被邀请、再用一个超低一口价开会员」就是能被直接刷的漏洞）。
      验完就删，脚本要能反复跑。
    */
    const lowFixed = await must('POST', '/admin/membership/referral-rules', {
      token: adminToken,
      body: {
        name: 'E2E 低价一口价',
        targetTier: 'all',
        targetPeriod: 'all',
        priceType: 'fixed',
        priceValue: 990,
        firstPurchaseOnly: false,
        requireActiveReferral: false,
        priority: 999,
        enabled: true,
        note: 'E2E 临时规则',
      },
    })
    check(Boolean(lowFixed.rule?.id), '后台能新建受邀定价规则')
    check(lowFixed.rule.impact.includes('一口价'), `后台把规则翻译成人话（${lowFixed.rule.impact}）`)
    const lowFixedQuote = await must('GET', '/membership', { token: inviteeToken })
    const lowFixedMonthly = planOf(lowFixedQuote.tiers, 'member_monthly')
    check(
      lowFixedMonthly.finalCents !== 990 && lowFixedMonthly.referral.reason.includes('不低于'),
      '低于常规定价的一口价不生效：配错规则只会「不生效」，不会变成给受邀用户的折扣',
      `${yuan(lowFixedMonthly.finalCents)} / ${lowFixedMonthly.referral.reason}`,
    )
    check(
      lowFixedMonthly.referral.matchedCount >= 1,
      '它确实被算进了候选，只是没赢 —— 不是被优先级筛掉的',
    )
    const listed = await must('GET', '/admin/membership/referral-rules?enabled=true', { token: adminToken })
    check(listed.items.some((r) => r.id === lowFixed.rule.id), '新规则出现在后台列表里')
    const patchedHighFixed = await must('PATCH', `/admin/membership/referral-rules/${lowFixed.rule.id}`, {
      token: adminToken,
      body: { priceValue: 990000, enabled: false },
    })
    check(
      patchedHighFixed.rule.priceValue === 990000 && patchedHighFixed.rule.enabled === false,
      '后台能改规则并停用',
    )
    const afterDisable = await must('GET', '/membership', { token: inviteeToken })
    check(
      planOf(afterDisable.tiers, 'member_monthly').finalCents !== 990000,
      '停用后规则不再参与计算',
      yuan(planOf(afterDisable.tiers, 'member_monthly').finalCents),
    )
    const badFixed = await api('POST', '/admin/membership/referral-rules', {
      token: adminToken,
      body: { name: '太便宜', priceType: 'fixed', priceValue: 1 },
    })
    check(badFixed.status === 422 || badFixed.status === 400, `一口价低于 1 元被拒（实际 ${badFixed.status}）`)
    const badReferralPercent = await api('POST', '/admin/membership/referral-rules', {
      token: adminToken,
      body: { name: '比例越界', priceType: 'percent', priceValue: 201 },
    })
    check(
      badReferralPercent.status === 422 || badReferralPercent.status === 400,
      `上浮比例超过 200% 被拒（实际 ${badReferralPercent.status}）`,
    )
    const removedRule = await api('DELETE', `/admin/membership/referral-rules/${lowFixed.rule.id}`, { token: adminToken })
    check(removedRule.ok, '后台能删除规则')

    // 后台试算也要能画出受邀画像，否则运营改规则时看不到加价
    const simInvited = await must('POST', '/admin/membership/simulate', {
      token: adminToken,
      body: { planCode: 'member_yearly', ...profile, invited: true, referralActive: true },
    })
    check(simInvited.referral?.applied === true, '后台试算支持「受邀」画像')
    const simNormal = await normalQuote('member_yearly')
    check(
      simInvited.result.finalCents === Math.round(simNormal.finalCents * 2) &&
        simInvited.referral.surchargeCents === simInvited.result.finalCents - simNormal.finalCents,
      '试算金额与家长端一致（同一套公式）',
      `${yuan(simInvited.result.finalCents)} vs ${yuan(simNormal.finalCents)}`,
    )
    const simInvalid = await must('POST', '/admin/membership/simulate', {
      token: adminToken,
      body: { planCode: 'member_yearly', ...profile, invited: true, referralActive: false },
    })
    check(simInvalid.referral?.applied === false, '试算支持「关系已作废」画像', simInvalid.referral?.reason)

    // 收尾：把邀请关系改回去，避免影响后面的清理断言
    await prisma.referral.update({ where: { id: referralRow.id }, data: { status: 'valid' } })
  } finally {
    // ==========================================================
    step('14. 清理')
    // ==========================================================
    try {
      for (const deviceId of created.deviceIds) {
        const login = await api('POST', '/auth/login', { body: { phone, password } })
        if (login.ok) await api('DELETE', `/devices/${deviceId}`, { token: login.body.token })
      }
      const adminLogin = await api('POST', '/admin/login', { body: { username: ADMIN_USER, password: ADMIN_PASSWORD } })
      if (adminLogin.ok) {
        for (const extra of created.extraUsers) {
          const removedExtra = await api('DELETE', `/admin/users/${extra.id}`, { token: adminLogin.body.token })
          check(removedExtra.ok, `已清理受邀临时家长 ${extra.phone}（连带其订单/返现/券）`, `实际 ${removedExtra.status}`)
        }
      }
      if (adminLogin.ok && created.userId) {
        const removed = await api('DELETE', `/admin/users/${created.userId}`, { token: adminLogin.body.token })
        check(removed.ok, `已清理临时家长 ${phone}（连带其订单）`, `实际 ${removed.status}`)
      }
    } catch (err) {
      bad('清理临时数据', err.message)
    }
    await prisma.$disconnect()
    console.log(`\n\x1b[1m${passed}/${passed + failed} 项通过\x1b[0m`)
    if (failed > 0) process.exit(1)
  }
}

main().catch((err) => {
  console.error(`\n\x1b[31m验证中断：${err.message}\x1b[0m`)
  process.exit(1)
})
