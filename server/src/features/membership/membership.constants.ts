/**
 * 会员体系的「单一事实来源」。
 *
 * 三档账号（普通 / 会员 / 超级会员）、三种计费周期、四类会员权益、
 * 定价规则的触发条件与优惠方式，全部只在这里定义一次：
 * 家长端展示、服务端门禁、后台表单下拉都用同一份常量，
 * 避免出现「后台能选但服务端不认」的取值。
 */

// ============================================================
// 档位
// ============================================================

export const MEMBERSHIP_TIERS = ['ordinary', 'member', 'super'] as const;

export type MembershipTier = (typeof MEMBERSHIP_TIERS)[number];

/** 档位等级，用来比较「升级 / 降级 / 同级续费」。 */
export const TIER_RANK: Record<MembershipTier, number> = {
  ordinary: 0,
  member: 1,
  super: 2,
};

export const TIER_LABELS: Record<MembershipTier, string> = {
  ordinary: '普通账号',
  member: '会员',
  super: '超级会员',
};

/** 可购买的档位（ordinary 不售卖）。 */
export const PURCHASABLE_TIERS = ['member', 'super'] as const;
export type PurchasableTier = (typeof PURCHASABLE_TIERS)[number];

export function isMembershipTier(v: string): v is MembershipTier {
  return (MEMBERSHIP_TIERS as readonly string[]).includes(v);
}

export function isPurchasableTier(v: string): v is PurchasableTier {
  return (PURCHASABLE_TIERS as readonly string[]).includes(v);
}

// ============================================================
// 计费周期
// ============================================================

export const BILLING_PERIODS = ['monthly', 'yearly', 'auto_monthly'] as const;

export type BillingPeriod = (typeof BILLING_PERIODS)[number];

export const PERIOD_LABELS: Record<BillingPeriod, string> = {
  monthly: '按月',
  yearly: '按年',
  auto_monthly: '连续包月',
};

/** 一个计费周期买断多少个月。连续包月是「每月一次」，所以是 1。 */
export const PERIOD_MONTHS: Record<BillingPeriod, number> = {
  monthly: 1,
  yearly: 12,
  auto_monthly: 1,
};

export function isBillingPeriod(v: string): v is BillingPeriod {
  return (BILLING_PERIODS as readonly string[]).includes(v);
}

// ============================================================
// 权益
// ============================================================

/**
 * 会员权益清单。
 *
 * minTier 是「享受该权益所需的最低档位」，服务端所有门禁都读它，
 * 所以调整档位划分只需要改这一张表（家长端的权益对比表也读它）。
 */
export interface EntitlementDef {
  key: string;
  label: string;
  minTier: MembershipTier;
  description: string;
}

export const ENTITLEMENTS: EntitlementDef[] = [
  {
    key: 'quizUnlock',
    label: '答题解锁',
    minTier: 'member',
    description: '孩子答对题目换取使用时长',
  },
  {
    key: 'remoteMonitor',
    label: '远程监控',
    minTier: 'member',
    description: '远程拍照、远程录音、连续录像、环境监听、远程协助、电话短信',
  },
  {
    key: 'multiDevice',
    label: '绑定多台手机',
    minTier: 'member',
    description: '同一个账号可以绑定多台孩子设备',
  },
  {
    key: 'aiInsight',
    label: 'AI 洞察',
    minTier: 'super',
    description: '屏幕洞察、AI 画面分析、异常提醒',
  },
];

export const ENTITLEMENT_KEYS = ENTITLEMENTS.map((e) => e.key);

const ENTITLEMENT_BY_KEY = new Map(ENTITLEMENTS.map((e) => [e.key, e]));

export function entitlementOf(key: string): EntitlementDef | undefined {
  return ENTITLEMENT_BY_KEY.get(key);
}

/**
 * 设备功能开关 → 所需权益。
 *
 * 没列出的开关（锁屏、时间规划、应用限制……）属于基础功能，任何账号都能开。
 * 注意 screenMonitor：它是「截屏 + 交给 AI 分析」，属于 AI 洞察而不是远程监控，
 * 所以要求超级会员 —— 远程监控要的是 remote_* 那组一次性/持续采集能力。
 */
export const FEATURE_ENTITLEMENTS: Record<string, string> = {
  quizUnlock: 'quizUnlock',
  remotePhoto: 'remoteMonitor',
  remoteRecord: 'remoteMonitor',
  videoRecord: 'remoteMonitor',
  audioRecord: 'remoteMonitor',
  remoteHelp: 'remoteMonitor',
  callSms: 'remoteMonitor',
  screenMonitor: 'aiInsight',
};

/** 普通账号（非会员）最多能绑定几台设备；开通会员后放宽到 MAX_DEVICES_PER_USER。 */
export const FREE_DEVICE_LIMIT = 1;

// ============================================================
// 定价规则
// ============================================================

export const RULE_CONDITIONS = [
  'always',
  'first_purchase',
  'active_membership',
  'no_active_membership',
  'device_count',
  'registered_within_days',
  'tier_upgrade',
] as const;

export type RuleCondition = (typeof RULE_CONDITIONS)[number];

export const RULE_CONDITION_LABELS: Record<RuleCondition, string> = {
  always: '不限条件',
  first_purchase: '首单（从未付费成功）',
  active_membership: '同档续费（当前已是该档会员）',
  no_active_membership: '未开通或已过期',
  device_count: '绑定设备数达到阈值',
  registered_within_days: '注册后 N 天内',
  tier_upgrade: '由指定档位升级',
};

export const DISCOUNT_TYPES = ['percent', 'amount'] as const;

export type DiscountType = (typeof DISCOUNT_TYPES)[number];

export const DISCOUNT_TYPE_LABELS: Record<DiscountType, string> = {
  percent: '按比例减',
  amount: '减固定金额',
};

/** 单个订单最低应付金额（分）。防止后台把规则配成 0 元单。 */
export const MIN_PAYABLE_CENTS = 100;

// ============================================================
// 受邀用户定价（会员价格 × 是否被邀请注册）
// ============================================================

/**
 * 受邀定价的三种算法。比常规定价多一个 `fixed`：运营上也常用「受邀好友首单一律
 * 199 元」这种一口价，用 percent/amount 表达不了。
 */
export const REFERRAL_PRICE_TYPES = ['percent', 'amount', 'fixed'] as const;

export type ReferralPriceType = (typeof REFERRAL_PRICE_TYPES)[number];

export const REFERRAL_PRICE_TYPE_LABELS: Record<ReferralPriceType, string> = {
  percent: '按常规价上浮比例',
  amount: '常规价加收固定金额',
  fixed: '一口价',
};

/**
 * 首次灌库时写入的默认受邀定价规则（见 seed.ts）。
 *
 * 数值不是随手拍的：返现是按**实付价**算的，所以「上浮 s、返现率 r」要满足
 * `(1 + s) × (1 − r) ≥ 1`（即 `s ≥ r ÷ (1 − r)`）平台才不亏：
 *
 * | 邀请人档位（返现率 r） | 刚好打平的上浮 s |
 * | --- | --- |
 * | 0-3 人 → 50% | 100% |
 * | 4-9 人 → 40% | 67% |
 * | ≥10 人 → 20% | 25% |
 *
 * 首单那条按**最坏档**兜底，所以是 **100%**：受邀用户首单付两倍，其中一半原路返给邀请人，
 * 平台刚好拿回常规价（年卡还有单笔 75 元封顶，所以实际是赚的）。
 * 续费那条默认 **25%**，只对齐「≥10 人 20%」这一档 —— 这是**有意的折中**：真按 100% 默认，
 * 受邀用户续费永远是双倍价，产品上没法接受。代价是清楚的：如果邀请人还在 50%/40% 档，
 * 这一单续费平台会倒贴（付 1.25 倍、返 0.625 倍）。要彻底不亏，运营得把续费那条上调到
 * 67%/100%，或者下调「续费返现比例」（`renewalRatePercent`，默认 20）—— 后台的
 * 「受邀用户定价」页顶部有一段实时说明，家长端下单页也会把命中的规则名和上浮额显示出来。
 *
 * 之所以不能自动按档位算：返现档位是按**邀请人**的邀请人数动态变的（0-3 人 50%、4-9 人
 * 40%、≥10 人 20%），而受邀定价规则只拿得到「买家是不是受邀注册的」，看不到他邀请人当前
 * 在哪个档。所以这里只能给一套与档位无关的默认值。
 *
 * 两条的优先级刻意不同（首单那条更高），用来演示「所有命中规则各算一次、取最高价」。
 */
export const DEFAULT_REFERRAL_PRICE_RULES = [
  {
    name: '受邀好友首单上浮 100%',
    targetTier: 'all',
    targetPeriod: 'all',
    priceType: 'percent',
    // 上浮 100%：正好覆盖邀请人首充返现的最高档（50%）—— 付两倍、返一半、平台拿原价。
    priceValue: 100,
    firstPurchaseOnly: true,
    requireActiveReferral: true,
    priority: 20,
    note: '受邀注册的账号首次开通会员，在常规定价基础上上浮 100%（分享返现的成本）',
  },
  {
    name: '受邀好友续费上浮 25%',
    targetTier: 'all',
    targetPeriod: 'all',
    priceType: 'percent',
    // 续费返现区间是 20%-50%，默认从下限 20% 上浮一点，留出调节空间。
    priceValue: 25,
    firstPurchaseOnly: false,
    requireActiveReferral: true,
    priority: 10,
    note: '受邀注册的账号续费时，在常规定价基础上上浮 25%',
  },
];

export const PAY_CHANNELS = ['alipay', 'wechat'] as const;

export type PayChannel = (typeof PAY_CHANNELS)[number];

export const PAY_CHANNEL_LABELS: Record<PayChannel, string> = {
  alipay: '支付宝',
  wechat: '微信支付',
};

export const ORDER_STATUSES = ['pending', 'paid', 'failed', 'cancelled', 'refunded'] as const;

export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const ORDER_STATUS_LABELS: Record<OrderStatus, string> = {
  pending: '待支付',
  paid: '已支付',
  failed: '支付失败',
  cancelled: '已取消',
  refunded: '已退款',
};

// ============================================================
// 默认数据（seed 用）
// ============================================================

/** 默认套餐：会员 / 超级会员 × 按月 / 按年 / 连续包月。价格都能在后台改。 */
export const DEFAULT_PLANS = [
  {
    code: 'member_monthly',
    tier: 'member',
    period: 'monthly',
    name: '会员 · 按月',
    description: '每月自动到期，按需续费',
    basePriceCents: 1500,
    months: 1,
    recommended: false,
    sortOrder: 10,
  },
  {
    code: 'member_yearly',
    tier: 'member',
    period: 'yearly',
    name: '会员 · 按年',
    description: '一次付一年，折合每月更便宜',
    basePriceCents: 14800,
    months: 12,
    recommended: true,
    sortOrder: 20,
  },
  {
    code: 'member_auto_monthly',
    tier: 'member',
    period: 'auto_monthly',
    name: '会员 · 连续包月',
    description: '每月自动续费，可随时关闭',
    basePriceCents: 1200,
    months: 1,
    recommended: false,
    sortOrder: 30,
  },
  {
    code: 'super_monthly',
    tier: 'super',
    period: 'monthly',
    name: '超级会员 · 按月',
    description: '含 AI 洞察，每月自动到期',
    basePriceCents: 2500,
    months: 1,
    recommended: false,
    sortOrder: 40,
  },
  {
    code: 'super_yearly',
    tier: 'super',
    period: 'yearly',
    name: '超级会员 · 按年',
    description: '含 AI 洞察，一次付一年',
    basePriceCents: 24800,
    months: 12,
    recommended: true,
    sortOrder: 50,
  },
  {
    code: 'super_auto_monthly',
    tier: 'super',
    period: 'auto_monthly',
    name: '超级会员 · 连续包月',
    description: '含 AI 洞察，每月自动续费',
    basePriceCents: 2000,
    months: 1,
    recommended: false,
    sortOrder: 60,
  },
] as const;

/**
 * 默认定价规则。
 *
 * 规则之间的关系要能讲清楚，否则家长会觉得「价格怎么算的」：
 *  - 不可叠加的规则（首单立减、会员续费折扣）同一单只取优先级最高的一条；
 *  - 可叠加的（年付立减、连续包月折扣、多设备折扣、升级抵扣）会全部生效；
 *  - 每条折扣都按**原价**计算后相加，不会出现「折上折」的复利效应。
 */
export const DEFAULT_PRICING_RULES = [
  {
    name: '首单立减 3 元',
    conditionType: 'first_purchase',
    targetTier: 'all',
    targetPeriod: 'all',
    discountType: 'amount',
    discountValue: 300,
    stackable: true,
    priority: 100,
    note: '首次开通立减 3 元',
  },
  {
    name: '会员续费 9 折',
    conditionType: 'active_membership',
    targetTier: 'all',
    targetPeriod: 'all',
    discountType: 'percent',
    discountValue: 10,
    stackable: true,
    priority: 60,
    note: '会员续费 9 折',
  },
  {
    name: '年付立减 30 元',
    conditionType: 'always',
    targetTier: 'all',
    targetPeriod: 'yearly',
    discountType: 'amount',
    discountValue: 3000,
    stackable: false,
    priority: 55,
    note: '年付再减 30 元',
  },
  {
    name: '连续包月 8 折',
    conditionType: 'always',
    targetTier: 'all',
    targetPeriod: 'auto_monthly',
    discountType: 'percent',
    discountValue: 20,
    stackable: false,
    priority: 50,
    note: '连续包月 8 折',
  },
  {
    name: '多设备家庭 9 折',
    conditionType: 'device_count',
    conditionMinDevices: 2,
    targetTier: 'all',
    targetPeriod: 'all',
    discountType: 'percent',
    discountValue: 10,
    stackable: true,
    priority: 40,
    note: '已绑定 2 台以上设备，9 折',
  },
  {
    name: '升级超级会员抵扣 10 元',
    conditionType: 'tier_upgrade',
    conditionFromTier: 'member',
    targetTier: 'super',
    targetPeriod: 'all',
    discountType: 'amount',
    discountValue: 1000,
    stackable: true,
    priority: 70,
    note: '从会员升级，抵扣 10 元',
  },
  {
    name: '新用户 7 天内 95 折',
    conditionType: 'registered_within_days',
    conditionDays: 7,
    targetTier: 'all',
    targetPeriod: 'all',
    discountType: 'percent',
    discountValue: 5,
    stackable: true,
    priority: 30,
    note: '新用户专享 95 折',
  },
] as const;
