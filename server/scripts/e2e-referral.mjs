#!/usr/bin/env node
/**
 * 分享提成（邀请返现）的端到端验证。
 *
 * 这条链路比会员那条更长：一个家长拉好友 → 好友注册时绑上邀请码 → 好友充值 →
 * 邀请人拿返现 → 次月结算 → 满足门槛后提现 → 后台审核打款。中间任何一环断了，
 * 家长看到的「最高返现 50%」就只是句广告词，所以按环节分开验：
 *
 *   1. **邀请码**：每个账号都有码，字符集去掉了 0/O/1/I/L（念给朋友听不会听错）；
 *   2. **绑定**：在建号**之前**就校验邀请码，坏码直接 400 而不是先建号再报错；
 *   3. **阶梯**：按「有效充值人数」取档 —— 顺序很关键，先把这一单的邀请人记成
 *      valid 再数人数，否则第 3 个人永远差一个；
 *   4. **月卡保底 / 年卡封顶**：截图里「月卡季卡返现 50%」实现为**下限**，
 *      「年卡以上最高返现 75 元」实现为**单笔上限**；
 *   5. **续费返现**：比例是「阶梯值夹在 [20, 50] 之间」，另有 75 元/笔上限；
 *   6. **券里程碑**：靠 `sourceRef` 唯一索引幂等，同一里程碑只发一次；
 *   7. **实名 + 提现门槛**：4 条门槛逐条可查，同一证件不能实名两个账号；
 *   8. **结算**：当月统计、次月 10-15 日发放 —— 用惰性收敛实现，
 *      正确性不依赖定时任务（这里直接把归属月改成过去来验证）；
 *   9. **券抵扣**：一张券不能同时押在两笔待支付订单上，取消订单要能释放；
 *  10. **后台**：审核状态机单向、规则整表替换、统计口径。
 *
 * 用法：node scripts/e2e-referral.mjs          （默认 http://localhost:4000/api）
 *      API_BASE=http://localhost:4002/api node scripts/e2e-referral.mjs
 *
 * 需要一个跑着的后端 + 已 seed 的库（后台接口用 admin 账号）。
 * 脚本自己注册若干临时家长，结束时会全部删干净（返现/提现/券都是级联删除）。
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

/** 8 位、去掉了 0/O/1/I/L 的邀请码字符集 */
const CODE_RE = /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{8}$/

/**
 * 造一个**校验位正确**的身份证号。
 *
 * 实名是「一个证件只能实名一个账号」，写死一个号的话脚本第二次跑就会撞上
 * 上一次留下的账号（409）。号码本身必须过 GB 11643 校验，所以不能随便编数字，
 * 只能换顺序码再算校验位。
 */
function makeIdCard(seq) {
  const weights = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2]
  const codes = ['1', '0', 'X', '9', '8', '7', '6', '5', '4', '3', '2']
  // 110101199003072316 是文档与手工验证里用过的号，避开它免得撞上已被实名的账号
  let n = seq % 1000
  if (n === 231) n = 232
  const base = `11010119900307${String(n).padStart(3, '0')}`
  let sum = 0
  for (let i = 0; i < 17; i += 1) sum += Number(base[i]) * weights[i]
  return base + codes[sum % 11]
}

/** 把合法的校验位改坏，用来验「校验位不正确要拒」。 */
function breakIdCard(idCard) {
  return `${idCard.slice(0, 17)}${idCard[17] === '9' ? '8' : '9'}`
}

/** 当月（返现的归属月）。服务端按「次月 10-15 日发放」结算，所以新返现一定落在当月。 */
function thisMonth() {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
}

main().catch((err) => {
  console.error(`\n\x1b[31m验证中断：${err.message}\x1b[0m`)
  process.exit(1)
})

/**
 * 平台默认值，与 `src/features/referral/referral.constants.ts` 的 `DEFAULT_*` 一致。
 * 脚本**开头和结尾都会**把配置与规则写回这里：一次中断如果留下「活动已暂停 + 首档 45%」，
 * 下一轮跑的时候 section 1 会全线报错 —— 那是上一轮留下的假故障，不是真回归。
 */
const DEFAULT_NOTICE = [
  '活动时间：本次活动长期有效，终止日期以公告为准。',
  '奖励规则：邀请新用户完成充值后，邀请人可按好友首充金额获得返现；邀请人数越多、返现比例档位越低，具体以页面阶梯为准。',
  '月卡、季卡返现 50%，年卡及以上单笔最高返现 75 元。',
  '奖励按当月统计，并于次月 10-15 日发放。',
  '续费奖励：被邀请好友后续续费，邀请人可获得该笔金额 20% 到 50% 的可提现奖励，单个邀请人单笔上限为 75 元。',
  '优惠券奖励：邀请满 3 人获得 5 元优惠券，满 10 人 30 元，满 20 人 60 元，超过 30 人每 30 人 100 元，可用于购买会员时抵扣。',
  '有效邀请：被邀请人若充值后产生退款或存在异常行为，奖励将取消或追回。',
  '提现条件：邀请人需至少邀请 3 名有效充值用户，账户完成实名认证，累计返现金 ≥ 50 元方可申请提现；审核通过后 7 个工作日内到账。',
  '反作弊条款：禁止任何形式的自买自返或关联账户套现，一经发现平台将取消奖励并采取相应处罚。',
]

const DEFAULT_RULE_BODY = {
  tiers: [
    { minInvitees: 0, maxInvitees: 3, ratePercent: 50 },
    { minInvitees: 4, maxInvitees: 9, ratePercent: 40 },
    { minInvitees: 10, maxInvitees: null, ratePercent: 20 },
  ],
  couponRules: [
    { name: '邀请满 3 人', inviteeCount: 3, repeatEvery: null, amountCents: 500, validDays: 90 },
    { name: '邀请满 10 人', inviteeCount: 10, repeatEvery: null, amountCents: 3000, validDays: 90 },
    { name: '邀请满 20 人', inviteeCount: 20, repeatEvery: null, amountCents: 6000, validDays: 90 },
    { name: '每满 30 人', inviteeCount: 30, repeatEvery: 30, amountCents: 10000, validDays: 90 },
  ],
  shortPeriodMinRatePercent: 50,
  longPeriodCapCents: 7500,
  renewalRatePercent: 20,
  renewalCapCents: 7500,
}

const DEFAULT_CONFIG_BODY = {
  title: '邀请新用户，返现 50%',
  subtitle: '新用户注册充值后，您最高可获得 50% 返现',
  enabled: true,
  notice: DEFAULT_NOTICE,
  startedAt: null,
  endsAt: null,
  withdrawMinInvitees: 3,
  withdrawMinCents: 5000,
  withdrawRequireVerified: true,
  settleDayStart: 10,
  settleDayEnd: 15,
}

async function main() {
  const prisma = new PrismaClient()
  const stamp = String(Date.now()).slice(-8)
  const password = 'e2e-referral-123'
  /** 创建过的临时账号，用于最后清理 */
  const created = []
  /** 管理员令牌：第 0 步拿到，清理前复用（避免重复登录撞登录频率限制） */
  let adminToken = null

  /** 把活动配置与规则写回平台默认值。开头 / 结尾各调一次。 */
  async function resetDefaults(token) {
    await must('PUT', '/admin/referral/config', { token, body: DEFAULT_CONFIG_BODY })
    await must('PUT', '/admin/referral/rules', { token, body: DEFAULT_RULE_BODY })
  }

  /** 注册一个临时家长；inviteCode 传了就顺手验一下「带邀请码注册」。 */
  async function signUp(label, inviteCode) {
    const phone = `137${String(Number(stamp) + created.length * 7919).padStart(8, '0').slice(-8)}`
    const sent = await must('POST', '/auth/send-code', { body: { phone, purpose: 'register' } })
    const body = { phone, password, code: sent.devCode, nickname: label }
    if (inviteCode) body.inviteCode = inviteCode
    const reg = await must('POST', '/auth/register', { body })
    created.push({ id: reg.user.id, phone, label })
    return { id: reg.user.id, phone, token: reg.token, label }
  }

  /** 让某个账号买一个套餐并完成模拟支付，返回下单结果。 */
  async function buy(user, planCode, extra = {}) {
    const created1 = await must('POST', '/membership/orders', {
      token: user.token,
      body: { planCode, payChannel: 'alipay', ...extra },
    })
    const paid = await must('POST', `/membership/orders/${created1.order.orderNo}/pay`, {
      token: user.token,
      body: { outcome: 'success' },
    })
    return { order: created1.order, paid: paid.order }
  }

  /** 取某个套餐当前算出来的实付金额（动态定价，不能写死）。 */
  async function quoteCents(user, planCode) {
    const overview = await must('GET', '/membership', { token: user.token })
    for (const group of overview.tiers) {
      const hit = group.plans.find((p) => p.code === planCode)
      if (hit) return hit.finalCents
    }
    throw new Error(`找不到套餐 ${planCode}`)
  }

  try {
    // ==========================================================
    step('0. 复位平台默认配置（上一轮中断可能留下「活动已暂停 / 首档 45%」）')
    // ==========================================================
    const adminLogin = await must('POST', '/admin/login', { body: { username: ADMIN_USER, password: ADMIN_PASSWORD } })
    adminToken = adminLogin.token
    check(Boolean(adminToken), '管理员登录成功')
    await resetDefaults(adminToken)
    const bootConfig = await must('GET', '/admin/referral/config', { token: adminToken })
    const bootRules = await must('GET', '/admin/referral/rules', { token: adminToken })
    check(bootConfig.enabled === true && bootRules.tiers[0].ratePercent === 50, '活动回到「开启」、首档回到 50%')
    check(bootConfig.notice.length === DEFAULT_NOTICE.length, `活动说明恢复到 ${DEFAULT_NOTICE.length} 条`, `${bootConfig.notice.length} 条`)

    // ==========================================================
    step('1. 邀请人的邀请码：自动生成、可分享、规则表已就位')
    // ==========================================================
    const alice = await signUp('邀请人E2E')
    const overview = await must('GET', '/referral', { token: alice.token })
    check(CODE_RE.test(overview.inviteCode), `新账号立刻有 8 位邀请码（${overview.inviteCode}），字符集不含 0/O/1/I/L`)
    check(overview.linkPath.includes(overview.inviteCode), '分享链接里带上邀请码', overview.linkPath)
    check(overview.linkPath.includes('mode=register'), '分享链接直达注册态', overview.linkPath)
    check(overview.inviteLink.startsWith('http') && overview.inviteLink.endsWith(overview.linkPath), 'inviteLink 是绝对地址（用于复制邀请文案）', overview.inviteLink)
    check(overview.stats.invitedCount === 0 && overview.stats.rewardTotalCents === 0, '新账号统计全 0')
    check(overview.stats.inviteCode === undefined, '邀请码只出现在顶层，不混在统计里')
    check(Array.isArray(overview.tiers) && overview.tiers.length === 3, `默认 3 档阶梯（${overview.tiers.map((x) => `${x.minInvitees}-${x.maxInvitees ?? '∞'}:${x.ratePercent}%`).join(' / ')}）`)
    check(
      overview.tiers[0].ratePercent === 50 && overview.tiers[1].ratePercent === 40 && overview.tiers[2].ratePercent === 20,
      '比例就是截图里的 50 / 40 / 20（人越多比例越低，不是笔误）',
    )
    check(overview.tiers[0].maxInvitees === 3, '第一档是「0-3 人」而不是「正好 3 人」—— 只邀请 1 人的家长也有返现')
    check(overview.tiers[2].maxInvitees === null, '最高档对上开口')
    check(overview.currentTier?.ratePercent === 50, '0 人的账号当前落在 50% 档')
    check(overview.nextTier?.minInvitees === 4 && overview.nextTier?.needInvitees === 4, '给出「还差几人到下一档」（0 人时还差 4 人）', JSON.stringify(overview.nextTier))
    check(overview.config.noticeLines.length >= 8, `活动说明逐条返回（${overview.config.noticeLines.length} 条）`)
    check(overview.config.noticeLines.every((l) => l.trim() && !l.includes('\n')), '每条说明都是单行（前端直接 map 渲染，不用自己 split）')
    check(overview.withdraw.eligible === false && overview.withdraw.requirements.length === 4, '提现门槛是 4 条', String(overview.withdraw.requirements.length))
    check(overview.withdraw.blockedReason.length > 0, '没满足时给出「差在哪」', overview.withdraw.blockedReason)
    check(overview.stats.currentMonthCents === '0' && overview.stats.currentMonthLabel === thisMonth(), '「本月已产生」带上归属月份', overview.stats.currentMonthLabel)

    // ==========================================================
    step('2. 绑定：邀请码在**建号前**校验，坏码不会先建号再报错')
    // ==========================================================
    // 手机号必须每次都是新的：写死一个号会被「验证码重发间隔」拦下，
    // 那样测到的就不是邀请码校验而是限流。
    const badPhone = `137${String(Number(stamp) + 999999).padStart(8, '0').slice(-8)}`
    const badCode = await api('POST', '/auth/send-code', { body: { phone: badPhone, purpose: 'register' } })
    if (badCode.ok) {
      const r = await api('POST', '/auth/register', {
        body: { phone: badPhone, password, code: badCode.body.devCode, nickname: '坏码', inviteCode: 'ZZZZZZZZ' },
      })
      check(r.status === 400, '不存在的邀请码 → 400', `实际 ${r.status}`)
      const exists = await prisma.user.count({ where: { phone: badPhone } })
      check(exists === 0, '被拒的注册没有留下半个账号（校验发生在建号之前）')
    } else {
      bad('发送验证码（坏码用例）', `实际 ${badCode.status}`)
    }

    // 用**小写**的邀请码注册，验证服务端做了归一化
    const bob = await signUp('好友B', overview.inviteCode.toLowerCase())
    check(Boolean(bob.token), '带邀请码注册成功')
    const afterBind = await must('GET', '/referral', { token: alice.token })
    check(afterBind.stats.invitedCount === 1, '邀请人数 +1')
    check(afterBind.stats.validCount === 0, '还没充值，不算「有效充值用户」')
    const invitees1 = await must('GET', '/referral/invitees', { token: alice.token })
    check(invitees1.items[0]?.status === 'bound' && invitees1.items[0]?.statusLabel === '已注册', '邀请记录里是「已注册」', invitees1.items[0]?.statusLabel)
    check(invitees1.items[0]?.phone.includes('****'), '好友手机号脱敏', invitees1.items[0]?.phone)
    const bobOverview = await must('GET', '/referral', { token: bob.token })
    check(CODE_RE.test(bobOverview.inviteCode) && bobOverview.inviteCode !== overview.inviteCode, '被邀请人自己也有一张独立的邀请码')

    // ==========================================================
    step('3. 首充返现：0-3 人档 → 50%')
    // ==========================================================
    const bobQuote = await quoteCents(bob, 'member_monthly')
    await buy(bob, 'member_monthly')
    const r1 = await must('GET', '/referral', { token: alice.token })
    const reward1 = (await must('GET', '/referral/rewards', { token: alice.token })).items[0]
    check(r1.stats.validCount === 1, '好友充值后变成「有效充值用户」')
    check(reward1?.kind === 'first_purchase' && reward1?.kindLabel === '首充返现', '算的是首充返现', reward1?.kindLabel)
    check(reward1?.ratePercent === 50, '命中 50% 档', `${reward1?.ratePercent}%`)
    check(reward1?.baseAmountCents === bobQuote, '计费基数是订单**实付**金额（不是原价）', `${yuan(reward1?.baseAmountCents)} vs ${yuan(bobQuote)}`)
    check(reward1?.amountCents === Math.floor(bobQuote * 0.5), `返现 = 实付 × 50% = ${yuan(Math.floor(bobQuote * 0.5))}`, yuan(reward1?.amountCents))
    check(reward1?.capApplied === false, '这一档没触发上限')
    check(reward1?.status === 'pending' && reward1?.statusLabel === '待发放', '当月产生的是「待发放」', reward1?.statusLabel)
    check(reward1?.settleMonth === thisMonth(), `归属当月（${thisMonth()}）—— 次月 10-15 日才发放`, reward1?.settleMonth)
    const r1Stats = r1.stats
    check(r1Stats.pendingCents === reward1.amountCents && r1Stats.settledCents === 0 && r1Stats.availableCents === 0, '待发放 / 已发放 / 可提现三个口径互不串台')

    // ==========================================================
    step('4. 券里程碑：满 3 人发 5 元券，且只发一次')
    // ==========================================================
    const carol = await signUp('好友C', overview.inviteCode)
    await buy(carol, 'member_monthly')
    const couponsAfter2 = await must('GET', '/referral/coupons', { token: alice.token })
    check(couponsAfter2.items.length === 0, '2 人还没到里程碑，不发券')
    const dave = await signUp('好友D', overview.inviteCode)
    await buy(dave, 'member_monthly')
    const couponsAfter3 = await must('GET', '/referral/coupons', { token: alice.token })
    check(couponsAfter3.items.length === 1, '满 3 人发了 1 张券', String(couponsAfter3.items.length))
    check(couponsAfter3.items[0].amountCents === 500, '面额 5 元（500 分）', yuan(couponsAfter3.items[0].amountCents))
    check(couponsAfter3.items[0].status === 'unused' && couponsAfter3.items[0].usable === true, '券是「未使用」且可用')
    check(couponsAfter3.items[0].expiresAt !== null, '券有有效期')
    check(couponsAfter3.summary.unusedCents === 500 && couponsAfter3.summary.unusedCount === 1, '券列表带小计', JSON.stringify(couponsAfter3.summary))
    const usable = await must('GET', '/referral/coupons/usable', { token: alice.token })
    check(usable.coupons.length === 1 && usable.coupons[0].id === couponsAfter3.items[0].id, '下单用的「可用券」接口只返回未使用且未过期的')
    const after3 = await must('GET', '/referral', { token: alice.token })
    check(after3.stats.couponUnusedCount === 1 && after3.stats.couponUnusedCents === 500, '总览里的券统计跟着变')
    check(after3.stats.validCount === 3, '3 名有效充值用户')
    check(after3.currentTier?.ratePercent === 50, '仍然在 50% 档（第 4 个人才降档）')
    check(after3.nextTier?.needInvitees === 1, '提示「再邀请 1 人」就到下一档', JSON.stringify(after3.nextTier))
    check(after3.withdraw.requirements.find((x) => x.key === 'invitees')?.met === true, '「至少 3 名有效充值用户」这一条已达成')

    // ==========================================================
    step('5. 第 4 个人：降到 40% 档，但月卡有 50% 保底')
    // ==========================================================
    const erin = await signUp('好友E', overview.inviteCode)
    const erinQuote = await quoteCents(erin, 'member_monthly')
    await buy(erin, 'member_monthly')
    const rewards5 = await must('GET', '/referral/rewards', { token: alice.token })
    const eReward = rewards5.items.find((x) => x.inviteePhone === erin.phone.replace(/(\d{3})\d{4}(\d{4})/, '$1****$2'))
    const erinRow = eReward ?? rewards5.items[0]
    check(erinRow.ratePercent === 50, `第 4 个人已在 40% 档，但买的是月卡 → 按 50% 保底（截图：「月卡、季卡返现 50%」）`, `${erinRow.ratePercent}%`)
    check(erinRow.amountCents === Math.floor(erinQuote * 0.5), '保底后的金额也按保底比例算', yuan(erinRow.amountCents))

    // 同一个人「续费」走的是 renewal 口径（20% 到 50%，另有 75 元上限）
    const erinRenewQuote = await quoteCents(erin, 'member_monthly')
    await buy(erin, 'member_monthly')
    const rewards5b = await must('GET', '/referral/rewards', { token: alice.token })
    const renewal = rewards5b.items.find((x) => x.kind === 'renewal')
    check(Boolean(renewal), '第二次充值算「续费返现」', renewal?.kindLabel)
    check(renewal?.status === 'pending', '续费返现同样先进待发放')
    check(
      renewal && renewal.ratePercent >= overview.config.renewalRatePercent && renewal.ratePercent <= 50,
      `续费比例夹在 [${overview.config.renewalRatePercent}, 50] 之间（实际 ${renewal?.ratePercent}%）`,
    )
    check(renewal?.amountCents === Math.floor(erinRenewQuote * (renewal.ratePercent / 100)), '续费返现 = 实付 × 该比例', yuan(renewal?.amountCents))
    check(
      renewal?.amountCents <= overview.config.renewalCapCents,
      `不超过单笔上限 ${yuan(overview.config.renewalCapCents)}`,
      yuan(renewal?.amountCents),
    )

    // 年卡：40% 档。注意 frank 是通过邀请注册的，他的实付价里已经含了「受邀加价」
    // （被邀请的家长要承担邀请人的返现成本，价格更高），所以返现基数也跟着变高。
    const frank = await signUp('好友F', overview.inviteCode)
    const frankQuote = await quoteCents(frank, 'super_yearly')
    await buy(frank, 'super_yearly')
    const rewards6 = await must('GET', '/referral/rewards', { token: alice.token })
    const yearly = rewards6.items.find((x) => x.baseAmountCents === frankQuote)
    check(yearly?.ratePercent === 40, '第 5 个人在 40% 档，年卡按阶梯比例 40%', `${yearly?.ratePercent}%`)
    const frankUncapped = Math.floor(frankQuote * 0.4)
    check(
      yearly?.amountCents === Math.min(frankUncapped, overview.config.longPeriodCapCents),
      '年卡返现 = min(实付 × 40%, 75 元单笔上限)',
      `${yuan(yearly?.amountCents)}（未封顶应为 ${yuan(frankUncapped)}）`,
    )
    check(
      yearly?.capApplied === frankUncapped > overview.config.longPeriodCapCents,
      '是否触发上限，由「实付 × 比例」有没有超过 75 元决定',
      `${yuan(frankUncapped)} vs 上限 ${yuan(overview.config.longPeriodCapCents)}`,
    )

    // 75 元单笔上限：换一个还在 0-3 人档（50%）的邀请人，年卡实付 × 50% 必然超过上限 ——
    // frank 那一段是「按算出来的金额判断」，这一段是「一定封顶」，两种都验。
    const gina = await signUp('邀请人G')
    const ginaOverview = await must('GET', '/referral', { token: gina.token })
    const henry = await signUp('好友H', ginaOverview.inviteCode)
    const henryQuote = await quoteCents(henry, 'super_yearly')
    await buy(henry, 'super_yearly')
    const ginaRewards = await must('GET', '/referral/rewards', { token: gina.token })
    const capped = ginaRewards.items.find((x) => x.baseAmountCents === henryQuote)
    check(capped?.ratePercent === 50, '0-3 人档的年卡首充按 50% 算', `${capped?.ratePercent}%`)
    check(capped?.capApplied === true, '年卡金额大，触发「年卡以上最高返现 75 元」的单笔上限')
    check(
      capped?.amountCents === ginaOverview.config.longPeriodCapCents,
      `封顶在 ${yuan(ginaOverview.config.longPeriodCapCents)}`,
      yuan(capped?.amountCents),
    )
    check(
      Math.floor(henryQuote * 0.5) > ginaOverview.config.longPeriodCapCents,
      `不封顶本应是 ${yuan(Math.floor(henryQuote * 0.5))}，确实高于上限（这条断言证明上限真的起了作用）`,
    )
    const couponsAfter5 = await must('GET', '/referral/coupons', { token: alice.token })
    check(couponsAfter5.items.length === 1, '第 4、5 个人不再补发 3 人档的券（同一里程碑只发一次）', String(couponsAfter5.items.length))
    const after5 = await must('GET', '/referral', { token: alice.token })
    check(after5.currentTier?.ratePercent === 40, '有效充值 5 人 → 当前档位降到 40%', `${after5.currentTier?.ratePercent}%`)
    check(after5.nextTier?.minInvitees === 10 && after5.nextTier?.needInvitees === 5, '下一档是 10 人，还差 5 人', JSON.stringify(after5.nextTier))
    check(after5.tiers.find((x) => x.ratePercent === 40)?.current === true, '档位表上标出「当前」')

    // ==========================================================
    step('6. 实名认证：身份证号只存哈希，同一证件不能实名两个账号')
    // ==========================================================
    const idCard = makeIdCard(Number(stamp))
    const badId = await api('POST', '/referral/identity', { token: alice.token, body: { realName: '张小明', idCard: breakIdCard(idCard) } })
    check(badId.status === 400, '校验位错的身份证号被拒（400）', `实际 ${badId.status}`)
    const wrongLen = await api('POST', '/referral/identity', { token: alice.token, body: { realName: '张', idCard: '11010119900307' } })
    check(wrongLen.status === 422 || wrongLen.status === 400, '长度不对的身份证号被拒', `实际 ${wrongLen.status}`)
    const identity = await must('POST', '/referral/identity', { token: alice.token, body: { realName: '张小明', idCard } })
    check(identity.identity?.verified === true || identity.verified === true, '合规的身份证号通过认证')
    const idView = identity.identity ?? identity
    check(idView.idCardMasked === `${idCard.slice(0, 6)}********${idCard.slice(-4)}`, `只回显掩码（${idView.idCardMasked}）`)
    const aliceRow = await prisma.user.findUnique({ where: { id: alice.id }, select: { realName: true, idCardHash: true, idCardTail: true } })
    check(aliceRow.idCardHash?.length === 64, '库里存的是 64 位 HMAC，不是明文')
    check(aliceRow.idCardHash !== idCard, '明文没有落库')
    check(aliceRow.idCardTail === idCard.slice(-4), '只留后 4 位用于展示')
    const takenId = await api('POST', '/referral/identity', { token: bob.token, body: { realName: '张小明', idCard } })
    check(takenId.status === 409, '同一证件给第二个账号 → 409（反作弊条款的落点）', `实际 ${takenId.status}`)

    // ==========================================================
    step('7. 结算：当月统计、次月 10-15 日发放（惰性收敛，不依赖定时任务）')
    // ==========================================================
    const beforeSettle = await must('GET', '/referral', { token: alice.token })
    check(beforeSettle.stats.settledCents === 0 && beforeSettle.stats.pendingCents > 0, '当月产生的返现先挂在「待发放」')
    check(
      beforeSettle.withdraw.requirements.find((x) => x.key === 'amount')?.met === false,
      '未结算的那部分不算进「累计返现」门槛',
      JSON.stringify(beforeSettle.withdraw.requirements.find((x) => x.key === 'amount')),
    )
    const pendingBefore = await prisma.referralReward.count({ where: { inviterId: alice.id, status: 'pending' } })
    // 把归属月改成上个月 → 发放日已过，读一次接口就应该结算
    await prisma.referralReward.updateMany({
      where: { inviterId: alice.id, status: 'pending' },
      data: { settleMonth: '2026-08' },
    })
    const afterSettle = await must('GET', '/referral', { token: alice.token })
    check(afterSettle.stats.pendingCents === 0, '归属月一过发放日，读接口时就地结算', `pending ${yuan(afterSettle.stats.pendingCents)}`)
    check(afterSettle.stats.settledCents > 0, `累计返现变成「已发放」（${yuan(afterSettle.stats.settledCents)}）`)
    check(afterSettle.stats.availableCents === afterSettle.stats.settledCents, '没人提现过，可提现 = 已发放')
    const stillPending = await prisma.referralReward.count({ where: { inviterId: alice.id, status: 'pending' } })
    check(pendingBefore > 0 && stillPending === 0, '不是「显示上结算」——状态被真的写回 settled')
    const settledRow = await prisma.referralReward.findFirst({ where: { inviterId: alice.id }, select: { settledAt: true } })
    check(settledRow.settledAt !== null, '记下发放时间')

    // ==========================================================
    step('8. 提现：4 条门槛 + 申请后余额冻结')
    // ==========================================================
    const ready = await must('GET', '/referral', { token: alice.token })
    check(ready.withdraw.requirements.every((x) => x.met), '4 条门槛全部达成', JSON.stringify(ready.withdraw.requirements.map((x) => `${x.key}:${x.met}`)))
    check(ready.withdraw.eligible === true && ready.withdraw.blockedReason === '', 'eligible = true')
    const available = ready.withdraw.availableCents
    check(available >= ready.config.withdrawMinCents, `可提现 ${yuan(available)} 已过 ${yuan(ready.config.withdrawMinCents)} 门槛`)

    const tooMuch = await api('POST', '/referral/withdrawals', {
      token: alice.token,
      body: { channel: 'alipay', account: '13800138000', amountCents: available + 100000 },
    })
    check(tooMuch.status === 400, '提现超过可提现余额 → 400', `实际 ${tooMuch.status}`)

    const noIdentity = await api('POST', '/referral/withdrawals', {
      token: bob.token,
      body: { channel: 'alipay', account: '13800138000' },
    })
    check(noIdentity.status === 400, '没实名的账号不能提现 → 400', `实际 ${noIdentity.status}`)

    const wd = await must('POST', '/referral/withdrawals', {
      token: alice.token,
      body: { channel: 'alipay', account: '13800138000', amountCents: available },
    })
    check(/^WD\d+$/.test(wd.withdrawal.withdrawNo), `提现单号成型（${wd.withdrawal.withdrawNo}）`)
    check(wd.withdrawal.status === 'pending' && wd.withdrawal.statusLabel === '待审核', '初始状态是待审核')
    check(wd.withdrawal.account === '138****8000', '收款账号脱敏存储', wd.withdrawal.account)
    check(wd.withdrawal.realName === '张小明' && wd.withdrawal.idCardTail === idCard.slice(-4), '存的是提现那刻的实名快照')
    const afterWd = await must('GET', '/referral', { token: alice.token })
    check(afterWd.stats.availableCents === 0, '申请后余额被冻结，不能重复提')
    check(afterWd.stats.pendingWithdrawCents === available, `审核中的金额单独统计（${yuan(afterWd.stats.pendingWithdrawCents)}）`)
    check(
      afterWd.withdraw.requirements.find((x) => x.key === 'balance')?.met === false,
      '余额门槛立刻变回未达成',
      JSON.stringify(afterWd.withdraw.requirements.find((x) => x.key === 'balance')),
    )
    const wdList = await must('GET', '/referral/withdrawals', { token: alice.token })
    check(wdList.items.length === 1 && wdList.items[0].withdrawNo === wd.withdrawal.withdrawNo, '提现记录里能看到这笔')

    // ==========================================================
    step('9. 优惠券抵扣：一张券不能同时押在两笔待支付订单上')
    // ==========================================================
    const couponId = couponsAfter3.items[0].id
    const couponCents = couponsAfter3.items[0].amountCents
    const aliceQuote = await quoteCents(alice, 'member_monthly')
    const o1 = await must('POST', '/membership/orders', { token: alice.token, body: { planCode: 'member_monthly', payChannel: 'alipay', couponId } })
    check(o1.order.couponCents === couponCents, `下单带券，抵扣 ${yuan(couponCents)}`, yuan(o1.order.couponCents))
    check(o1.order.amountCents === Math.max(0, aliceQuote - couponCents), `应付 = 原价 -券（${yuan(o1.order.amountCents)}）`)
    const held = await must('GET', '/referral/coupons?status=unused', { token: alice.token })
    check(held.items.length === 1, '只是「押」在待支付订单上，此时券还是未使用')
    const o2 = await api('POST', '/membership/orders', { token: alice.token, body: { planCode: 'member_monthly', payChannel: 'alipay', couponId } })
    check(o2.status === 400, '同一张券押第二笔待支付订单 → 400', `实际 ${o2.status}`)
    const ghost = await api('POST', '/membership/orders', { token: alice.token, body: { planCode: 'member_monthly', payChannel: 'alipay', couponId: 'nope-does-not-exist' } })
    check(ghost.status === 404, '不存在的券 → 404', `实际 ${ghost.status}`)

    await must('POST', `/membership/orders/${o1.order.orderNo}/cancel`, { token: alice.token })
    const o3 = await api('POST', '/membership/orders', { token: alice.token, body: { planCode: 'member_monthly', payChannel: 'alipay', couponId } })
    check(o3.ok, '取消订单后券被释放，可以再用', `实际 ${o3.status}`)
    await must('POST', `/membership/orders/${o3.body.order.orderNo}/pay`, { token: alice.token, body: { outcome: 'success' } })
    const used = await must('GET', '/referral/coupons?status=used', { token: alice.token })
    check(used.items.length === 1, '支付后券变「已使用」')
    check(used.items[0].usedOrderNo === o3.body.order.orderNo, '记下核销的订单号', used.items[0].usedOrderNo)
    const o4 = await api('POST', '/membership/orders', { token: alice.token, body: { planCode: 'member_monthly', payChannel: 'alipay', couponId } })
    check(o4.status === 400, '已使用的券不能再抵 → 400', `实际 ${o4.status}`)

    // ==========================================================
    step('10. 后台：统计口径、审核状态机、规则整表替换')
    // ==========================================================
    check(Boolean(adminToken), '复用第 0 步的管理员会话')

    const stats = await must('GET', '/admin/referral/stats?days=30', { token: adminToken })
    const totals = stats.totals
    // 全站金额不能拿去和「某个账号的余额」比 —— 库里还有别人的数据。改成拿 alice 自己的
    // 首充返现总额比：全站口径必须至少覆盖本次测试造出来的那部分。
    const aliceFirstPurchase = (await must('GET', '/referral/rewards?page=1&pageSize=50', { token: alice.token }))
      .items.filter((x) => x.kind === 'first_purchase' && x.status !== 'cancelled')
      .reduce((sum, x) => sum + x.amountCents, 0)
    check(
      totals.rewardTotals.firstPurchaseCents >= aliceFirstPurchase,
      `统计里的首充返现额含本次（全站 ${yuan(totals.rewardTotals.firstPurchaseCents)} ≥ alice 的 ${yuan(aliceFirstPurchase)}）`,
    )
    check(totals.rewardTotals.totalCents === totals.rewardTotals.pendingCents + totals.rewardTotals.settledCents, '返现总额 = 待发放 + 已发放（已取消的不混进来）')
    check(totals.rewardTotals.renewalCents > 0, '首充与续费分开统计（续费那笔在这里）')
    check(Array.isArray(stats.series) && stats.series.length === 30, '每日序列补齐到 30 天', String(stats.series?.length))
    check(
      stats.series.every((d) => typeof d.rewardCents === 'number' && typeof d.invited === 'number' && typeof d.valid === 'number'),
      '每天都有邀请数 / 有效数 / 返现额三个 0 值兜底（否则折线把空档连成假斜线）',
    )
    check(stats.series.some((d) => d.rewardCents > 0), '今天这一格确实记上了返现')
    check(totals.withdrawalTotals.pendingCount >= 1, '提现待审核笔数已计入统计')
    check(totals.couponTotals.issued >= 1 && totals.couponTotals.used >= 1, '券的发放与核销都统计到', JSON.stringify(totals.couponTotals))
    check(totals.couponTotals.unused + totals.couponTotals.used + totals.couponTotals.expired === totals.couponTotals.issued, '券三种状态之和等于发放总数')
    const aliceInviteesForStats = await must('GET', '/referral/invitees?page=1&pageSize=50', { token: alice.token })
    const aliceValidCount = aliceInviteesForStats.items.filter((x) => x.status === 'valid').length
    check(
      stats.byStatus.valid >= aliceValidCount && aliceValidCount >= 5,
      `按邀请状态分类统计（全站有效 ${stats.byStatus.valid} ≥ alice 的 ${aliceValidCount}）`,
      JSON.stringify(stats.byStatus),
    )
    check(
      stats.byRewardStatus.pending + stats.byRewardStatus.settled === totals.rewardTotals.count,
      '「待发放 + 已发放」等于计入口径的总笔数',
      JSON.stringify(stats.byRewardStatus),
    )
    check(Array.isArray(stats.topInviters) && stats.topInviters.length > 0, '给出邀请排行')
    check(stats.topInviters[0].amountCents > 0, '排行按累计返现额（不是按人数）')
    check(typeof totals.paidUsers === 'number' && totals.paidUsers > 0, '付费用户数已统计', String(totals.paidUsers))
    check(typeof totals.inviteConversion === 'number' && typeof totals.payConversion === 'number', '给出邀请转化率与充值转化率')

    const adminInvitees = await must('GET', `/admin/referral/invitees?q=${encodeURIComponent(alice.phone)}&page=1&pageSize=20`, { token: adminToken })
    check(adminInvitees.items.length >= 5 && adminInvitees.items.every((r) => r.inviterId === alice.id), `后台能按邀请人手机号过滤（${adminInvitees.items.length} 条）`)
    check(adminInvitees.total === adminInvitees.items.length, '按邀请人过滤时总数与条目一致')
    check(adminInvitees.items[0].inviterLabel.includes('****'), '后台列表里手机号也是脱敏的', adminInvitees.items[0].inviterLabel)
    check(adminInvitees.items.some((r) => r.rewardCents > 0), '每条邀请记录带上它带来的返现额')

    const adminWithdrawals = await must('GET', `/admin/referral/withdrawals?q=${encodeURIComponent(alice.phone)}&page=1&pageSize=20`, { token: adminToken })
    const target = adminWithdrawals.items.find((w) => w.withdrawNo === wd.withdrawal.withdrawNo)
    check(Boolean(target), '后台能看到这笔提现')
    const wdId = target.id

    const payTooEarly = await api('POST', `/admin/referral/withdrawals/${wdId}/review`, { token: adminToken, body: { action: 'pay' } })
    check(payTooEarly.status === 400, '未审核直接标记打款 → 400（状态机单向）', `实际 ${payTooEarly.status}`)
    const approved = await must('POST', `/admin/referral/withdrawals/${wdId}/review`, { token: adminToken, body: { action: 'approve', note: '资料齐全' } })
    check(approved.withdrawal?.status === 'approved' || approved.status === 'approved', '通过审核 → approved')
    check(approved.withdrawal?.reviewNote === '资料齐全' || approved.reviewNote === '资料齐全', '审核备注落库')
    const paid = await must('POST', `/admin/referral/withdrawals/${wdId}/review`, { token: adminToken, body: { action: 'pay' } })
    check(paid.withdrawal?.status === 'paid' || paid.status === 'paid', '标记打款 → paid')
    const rejectedAfterPaid = await api('POST', `/admin/referral/withdrawals/${wdId}/review`, { token: adminToken, body: { action: 'reject', note: '反悔' } })
    check(rejectedAfterPaid.status === 400, '已打款的申请不能再驳回 → 400', `实际 ${rejectedAfterPaid.status}`)
    const afterPaid = await must('GET', '/referral', { token: alice.token })
    check(afterPaid.stats.withdrawnCents === available && afterPaid.stats.pendingWithdrawCents === 0, '打款后家长的「已提现」跟着更新')

    const rules = await must('GET', '/admin/referral/rules', { token: adminToken })
    check(rules.tiers.length === 3 && rules.couponRules.length === 4, `规则表已就位（${rules.tiers.length} 档 + ${rules.couponRules.length} 条券规则）`)
    check(rules.tiers[0].minInvitees === 0 && rules.tiers[0].ratePercent === 50, '后台看到的阶梯与家长端一致')

    const noBaseTier = await api('PUT', '/admin/referral/rules', {
      token: adminToken,
      body: {
        tiers: [{ minInvitees: 1, maxInvitees: 3, ratePercent: 50 }, { minInvitees: 4, maxInvitees: null, ratePercent: 40 }],
        couponRules: rules.couponRules,
        shortPeriodMinRatePercent: rules.shortPeriodMinRatePercent,
        longPeriodCapCents: rules.longPeriodCapCents,
        renewalRatePercent: rules.renewalRatePercent,
        renewalCapCents: rules.renewalCapCents,
      },
    })
    check(noBaseTier.status === 422, '没有「从 0 人开始」的兜底档 → 422', `实际 ${noBaseTier.status}`)
    const overlapping = await api('PUT', '/admin/referral/rules', {
      token: adminToken,
      body: {
        tiers: [{ minInvitees: 0, maxInvitees: 5, ratePercent: 50 }, { minInvitees: 3, maxInvitees: null, ratePercent: 40 }],
        couponRules: rules.couponRules,
        shortPeriodMinRatePercent: rules.shortPeriodMinRatePercent,
        longPeriodCapCents: rules.longPeriodCapCents,
        renewalRatePercent: rules.renewalRatePercent,
        renewalCapCents: rules.renewalCapCents,
      },
    })
    check(overlapping.status === 422, '阶梯区间重叠 → 422（否则同一单命中两档，给多少看遍历顺序）', `实际 ${overlapping.status}`)

    const trimmedRules = {
      tiers: [{ minInvitees: 0, maxInvitees: 3, ratePercent: 45 }, { minInvitees: 4, maxInvitees: 9, ratePercent: 40 }, { minInvitees: 10, maxInvitees: null, ratePercent: 20 }],
      couponRules: rules.couponRules,
      shortPeriodMinRatePercent: rules.shortPeriodMinRatePercent,
      longPeriodCapCents: rules.longPeriodCapCents,
      renewalRatePercent: rules.renewalRatePercent,
      renewalCapCents: rules.renewalCapCents,
    }
    await must('PUT', '/admin/referral/rules', { token: adminToken, body: trimmedRules })
    // 用一个**全新的邀请人**来验新规则：alice 名下已经 6 个有效邀请，落在 4-9 档，
    // 而且月卡有 50% 保底，两件事都会盖住「首档改成 45%」的效果。
    // 年卡是长周期，不受保底影响，正好单独验阶梯。
    const ivy = await signUp('邀请人I')
    const ivyOverview = await must('GET', '/referral', { token: ivy.token })
    const jack = await signUp('好友J', ivyOverview.inviteCode)
    const jackQuote = await quoteCents(jack, 'member_yearly')
    await buy(jack, 'member_yearly')
    const ivyRewards = await must('GET', '/referral/rewards?status=pending', { token: ivy.token })
    const jackReward = ivyRewards.items.find((x) => x.kind === 'first_purchase')
    check(jackReward?.ratePercent === 45, `后台把首档改成 45% 后，新产生的返现立刻按 45% 算（${jackReward?.ratePercent}%）`)
    check(jackReward?.amountCents === Math.floor(jackQuote * 0.45), '金额随之重算', yuan(jackReward?.amountCents))
    check(jackReward?.capApplied === false, '年卡这一单没到 75 元上限，验的是阶梯本身')
    check(ivyOverview.tiers[0].ratePercent === 45, '家长端读到的阶梯也跟着后台改')
    const aliceHistory = await must('GET', '/referral/rewards', { token: alice.token })
    const oldFirst = aliceHistory.items.find((x) => x.baseAmountCents === bobQuote)
    check(oldFirst?.ratePercent === 50, '改规则不影响历史已落库的返现（只影响之后产生的）', `${oldFirst?.ratePercent}%`)

    // ==========================================================
    step('11. 活动配置：开关、说明逐条往返、参数校验')
    // ==========================================================
    const cfg = await must('GET', '/admin/referral/config', { token: adminToken })
    // 注意字段名：**读**回来的是逐条数组 `notice`，写入时也是这个字段。
    check(Array.isArray(cfg.notice) && cfg.notice.length >= 8, `配置里返回逐条说明（${cfg.notice?.length} 条）`)
    const baseConfig = {
      title: cfg.title,
      subtitle: cfg.subtitle,
      enabled: cfg.enabled,
      notice: cfg.notice,
      startedAt: cfg.startedAt,
      endsAt: cfg.endsAt,
      withdrawMinInvitees: cfg.withdrawMinInvitees,
      withdrawMinCents: cfg.withdrawMinCents,
      withdrawRequireVerified: cfg.withdrawRequireVerified,
      settleDayStart: cfg.settleDayStart,
      settleDayEnd: cfg.settleDayEnd,
    }
    const badWindow = await api('PUT', '/admin/referral/config', {
      token: adminToken,
      body: { ...baseConfig, settleDayStart: 20, settleDayEnd: 5 },
    })
    check(badWindow.status === 422 || badWindow.status === 400, '发放日结束早于开始 → 被拒', `实际 ${badWindow.status}`)

    const editedNotice = ['E2E 活动说明第一条', 'E2E 活动说明第二条', 'E2E 活动说明第三条']
    await must('PUT', '/admin/referral/config', {
      token: adminToken,
      body: { ...baseConfig, title: 'E2E 邀请活动', enabled: false, notice: editedNotice },
    })
    const cfgBack = await must('GET', '/admin/referral/config', { token: adminToken })
    check(cfgBack.title === 'E2E 邀请活动', '标题改掉了')
    check(JSON.stringify(cfgBack.notice) === JSON.stringify(editedNotice), '说明按行往返（数组 ↔ 换行字符串）', JSON.stringify(cfgBack.notice))
    const paused = await must('GET', '/referral', { token: alice.token })
    check(paused.config.enabled === false, '关掉活动后家长端能读到「已暂停」')
    check(paused.config.title === 'E2E 邀请活动', '家长端标题跟着后台走')
    check(JSON.stringify(paused.config.noticeLines) === JSON.stringify(editedNotice), '家长端拿到的是逐条数组，不用自己 split')

    // 一条过期的分享链接不该把好友的注册也一起挡掉：活动暂停时邀请码被**忽略**，
    // 账号正常建出来，只是不建立邀请关系。
    const beforePaused = (await must('GET', '/referral', { token: alice.token })).stats
    const pausedBuy = await signUp('好友H', overview.inviteCode)
    const afterPaused = (await must('GET', '/referral', { token: alice.token })).stats
    check(Boolean(pausedBuy.token), '活动暂停时点邀请链接仍然能正常注册')
    check(afterPaused.invitedCount === beforePaused.invitedCount, '只是不建立邀请关系', `${beforePaused.invitedCount} → ${afterPaused.invitedCount}`)
    // 注意比的是**条数**不是金额：alice 名下早就有别的好友买过同样价位的月卡，
    // 按金额找会撞上历史那笔，看起来像「暂停了还在发钱」。
    const rewardsBeforePause = (await must('GET', '/referral/rewards', { token: alice.token })).items.length
    await buy(pausedBuy, 'member_monthly')
    const rewardsAfterPause = (await must('GET', '/referral/rewards', { token: alice.token })).items.length
    check(rewardsAfterPause === rewardsBeforePause, '活动暂停期间的新充值不再产生返现', `${rewardsBeforePause} → ${rewardsAfterPause}`)
    const pausedOwn = await must('GET', '/referral', { token: pausedBuy.token })
    check(pausedOwn.stats.invitedCount === 0 && pausedOwn.stats.rewardTotalCents === 0, '被忽略邀请码的账号自己没有任何邀请关系')
    await must('PUT', '/admin/referral/config', { token: adminToken, body: baseConfig })
    const resumed = await must('GET', '/admin/referral/config', { token: adminToken })
    check(resumed.notice.length >= 8, '配置已还原')

    const rulesRestored = await must('GET', '/admin/referral/rules', { token: adminToken })
    check(rulesRestored.tiers[0].ratePercent === 45, '（规则将在清理前还原，见下一步）')

    const risk = await must('GET', '/admin/referral/risk?days=30', { token: adminToken })
    check(Array.isArray(risk.findings), '风险排查接口返回可疑列表')
    check(typeof risk.scanned === 'number' && typeof risk.high === 'number' && typeof risk.medium === 'number', '风险排查给出扫描量与高/中风险计数')
    check(
      risk.findings.every((f) => Array.isArray(f.userIds) && f.level && f.title && f.detail),
      '每条风险都带等级、说明与涉及的账号（只列不罚，人工判断）',
    )

    // ==========================================================
    step('12. 兜底：把规则还原成默认值')
    // ==========================================================
    await resetDefaults(adminToken)
    const restored = await must('GET', '/admin/referral/rules', { token: adminToken })
    check(restored.tiers.length === 3 && restored.tiers[0].ratePercent === 50 && restored.tiers[1].ratePercent === 40, '阶梯已还原成 50 / 40 / 20')
  } finally {
    // ==========================================================
    step('13. 清理')
    // ==========================================================
    // 先把配置/规则复位：脚本中途 throw 时也必须走到这里，否则下一轮跑的是脏库。
    try {
      if (!adminToken) {
        const relogin = await api('POST', '/admin/login', { body: { username: ADMIN_USER, password: ADMIN_PASSWORD } })
        if (relogin.ok) adminToken = relogin.body.token
      }
      if (adminToken) {
        await resetDefaults(adminToken)
        check(true, '活动配置与规则已复位成平台默认值')
      } else {
        bad('配置复位：拿不到管理员会话')
      }
    } catch (err) {
      bad('配置复位', err.message)
    }
    try {
      const adminLogin = adminToken
        ? { ok: true, body: { token: adminToken } }
        : await api('POST', '/admin/login', { body: { username: ADMIN_USER, password: ADMIN_PASSWORD } })
      if (adminLogin.ok) {
        for (const user of created) {
          const removed = await api('DELETE', `/admin/users/${user.id}`, { token: adminLogin.body.token })
          if (!removed.ok) bad(`清理临时家长 ${user.label}(${user.phone})`, `实际 ${removed.status}`)
        }
        check(true, `已清理 ${created.length} 个临时家长（连带其订单 / 返现 / 券 / 提现）`)
      } else {
        bad('清理：管理员登录失败')
      }
    } catch (err) {
      bad('清理临时数据', err.message)
    }
    await prisma.$disconnect()
    console.log(`\n\x1b[1m${passed}/${passed + failed} 项通过\x1b[0m`)
    // 只置 exitCode，不要在这里 process.exit —— 提前退出会把真正的失败原因吞掉
    if (failed > 0) process.exitCode = 1
  }
}
