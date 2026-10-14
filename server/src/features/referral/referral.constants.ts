/**
 * 分享提成 / 邀请返现的常量与默认值。
 *
 * 这里的 DEFAULT_* 只在「库里还没有配置」时用来铺初值（ensureDefaults），
 * 运行期一律从库里读 —— 活动口径（比例、上限、发放日、券门槛）运营要能随时改，
 * 写死在代码里等于每次调价都要发一次版。
 */

// ---------------- 邀请码 ----------------

/**
 * 邀请码字母表：去掉了容易看错的 0/O/1/I/L。
 * 家长会把邀请码念给别人听、也会手抄，形近字符带来的售后成本远高于多两位。
 */
export const INVITE_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export const INVITE_CODE_LENGTH = 8;
/** 生成时的重试次数：碰撞概率极低，但唯一索引冲突必须能自愈。 */
export const INVITE_CODE_MAX_ATTEMPTS = 8;

// ---------------- 邀请关系 ----------------

export const REFERRAL_STATUSES = ['bound', 'valid', 'invalid'] as const;
export type ReferralStatus = (typeof REFERRAL_STATUSES)[number];

export const REFERRAL_STATUS_LABELS: Record<ReferralStatus, string> = {
  bound: '已注册',
  valid: '有效邀请',
  invalid: '已作废',
};

// ---------------- 返现 ----------------

export const REWARD_KINDS = ['first_purchase', 'renewal'] as const;
export type RewardKind = (typeof REWARD_KINDS)[number];

export const REWARD_KIND_LABELS: Record<RewardKind, string> = {
  first_purchase: '首充返现',
  renewal: '续费返现',
};

/**
 * 返现状态。刻意只有三个：
 * 截图里「按当月统计，次月 10-15 日发放」意味着钱在发放前不能提，
 * 发放后就是可提现余额 —— 再细分「打款中」是提现单的状态，不是返现单的。
 */
export const REWARD_STATUSES = ['pending', 'settled', 'cancelled'] as const;
export type RewardStatus = (typeof REWARD_STATUSES)[number];

export const REWARD_STATUS_LABELS: Record<RewardStatus, string> = {
  pending: '待发放',
  settled: '已发放',
  cancelled: '已取消',
};

// ---------------- 提现 ----------------

export const WITHDRAWAL_STATUSES = ['pending', 'approved', 'paid', 'rejected'] as const;
export type WithdrawalStatus = (typeof WITHDRAWAL_STATUSES)[number];

export const WITHDRAWAL_STATUS_LABELS: Record<WithdrawalStatus, string> = {
  pending: '待审核',
  approved: '审核通过',
  paid: '已打款',
  rejected: '已驳回',
};

export const WITHDRAW_CHANNELS = ['alipay', 'wechat', 'bank'] as const;
export type WithdrawChannel = (typeof WITHDRAW_CHANNELS)[number];

export const WITHDRAW_CHANNEL_LABELS: Record<WithdrawChannel, string> = {
  alipay: '支付宝',
  wechat: '微信',
  bank: '银行卡',
};

// ---------------- 优惠券 ----------------

export const COUPON_STATUSES = ['unused', 'used', 'expired'] as const;
export type CouponStatus = (typeof COUPON_STATUSES)[number];

export const COUPON_STATUS_LABELS: Record<CouponStatus, string> = {
  unused: '未使用',
  used: '已使用',
  expired: '已过期',
};

// ---------------- 默认配置 ----------------

/**
 * 首充返现阶梯（截图第 2 条）。
 *
 * 两点必须说清楚，否则后来的人会以为写错了：
 * 1. 比例是**递减**的：3 人 50%、4-9 人 40%、≥10 人 20%。原活动如此 ——
 *    拉的人越多、单个好友的返点越低。
 * 2. 截图写的是「邀请人数 = 3 名：返现 50%」，这里实现为 **0-3 人**。
 *    照字面只认「正好 3 人」会留一个洞：只邀请了 1 个人的家长在好友充值时
 *    拿不到任何返现，而活动大标题偏偏写着「最高可获得 50% 返现」。
 *    第一档对下开口，这条阶梯才和标题自洽。
 * 3. 匹配用「第一档对下开口 + 其余按区间」：见 referral.rules.ts 的 pickTier。
 */
export const DEFAULT_REWARD_TIERS = [
  { minInvitees: 0, maxInvitees: 3, ratePercent: 50, sortOrder: 10 },
  { minInvitees: 4, maxInvitees: 9, ratePercent: 40, sortOrder: 20 },
  { minInvitees: 10, maxInvitees: null, ratePercent: 20, sortOrder: 30 },
];

/** 续费返现比例的硬上限（%）。截图：「可获得该笔金额的 20% 到 50%」。 */
export const MAX_RENEWAL_RATE_PERCENT = 50;

/** 优惠券里程碑（截图第 4 条）。repeatEvery 只在最后一条用得上。 */
export const DEFAULT_COUPON_RULES = [
  { name: '邀请满 3 人', inviteeCount: 3, repeatEvery: null, amountCents: 500, sortOrder: 10 },
  { name: '邀请满 10 人', inviteeCount: 10, repeatEvery: null, amountCents: 3000, sortOrder: 20 },
  { name: '邀请满 20 人', inviteeCount: 20, repeatEvery: null, amountCents: 6000, sortOrder: 30 },
  { name: '每满 30 人', inviteeCount: 30, repeatEvery: 30, amountCents: 10000, sortOrder: 40 },
];

/** 活动时间与说明。notice 一行一条，家长端逐条渲染。 */
export const DEFAULT_NOTICE = [
  '活动时间：本次活动长期有效，终止日期以公告为准。',
  '奖励规则：邀请新用户完成充值后，邀请人可按好友首充金额获得返现；邀请人数越多、返现比例档位越低，具体以页面阶梯为准。',
  '月卡、季卡返现 50%，年卡及以上单笔最高返现 75 元。',
  '奖励按当月统计，并于次月 10-15 日发放。',
  '续费奖励：被邀请好友后续续费，邀请人可获得该笔金额 20% 到 50% 的可提现奖励，单个邀请人单笔上限为 75 元。',
  '优惠券奖励：邀请满 3 人获得 5 元优惠券，满 10 人 30 元，满 20 人 60 元，超过 30 人每 30 人 100 元，可用于购买会员时抵扣。',
  '有效邀请：被邀请人若充值后产生退款或存在异常行为，奖励将取消或追回。',
  '提现条件：邀请人需至少邀请 3 名有效充值用户，账户完成实名认证，累计返现金 ≥ 50 元方可申请提现；审核通过后 7 个工作日内到账。',
  '反作弊条款：禁止任何形式的自买自返或关联账户套现，一经发现平台将取消奖励并采取相应处罚。',
].join('\n');

export const DEFAULT_CONFIG = {
  id: 'default',
  enabled: true,
  title: '邀请新用户，返现 50%',
  subtitle: '新用户注册充值后，您最高可获得 50% 返现',
  notice: DEFAULT_NOTICE,
  shortPeriodMinRatePercent: 50,
  longPeriodCapCents: 7500,
  renewalRatePercent: 20,
  renewalCapCents: 7500,
  withdrawMinInvitees: 3,
  withdrawMinCents: 5000,
  withdrawRequireVerified: true,
  settleDayStart: 10,
  settleDayEnd: 15,
};

/** 首充返现的绝对兜底上限（分）：任何配置失误都不该让单笔返现失控。 */
export const MAX_REWARD_CENTS = 100000;
/** 单次提现上限（分），防止一次性提走异常额度。 */
export const MAX_WITHDRAWAL_CENTS = 500000;

// ---------------- 纯工具 ----------------

/** 归属月份（按当月统计的依据）。 */
export function settleMonthOf(date: Date): string {
  const y = date.getFullYear();
  const m = `${date.getMonth() + 1}`.padStart(2, '0');
  return `${y}-${m}`;
}

/**
 * 某个月的奖励什么时候发放（截图：次月 10-15 日）。
 *
 * 返回「次月 10 日 00:00」——只要到了这一天，这批奖励就算「已发放」，
 * 具体 10 号还是 15 号到账由打款环节决定，与账务口径无关。
 */
export function settleDateFor(settleMonth: string, settleDayStart: number): Date {
  const [y, m] = settleMonth.split('-').map(Number);
  // 月份从 0 开始，所以 m 本身就是「次月」的下标
  return new Date(y, m, settleDayStart, 0, 0, 0, 0);
}

/**
 * 当前时刻是否已经过了 settleMonth 的发放日。
 * 用「次月 10 日」而不是「次月 15 日」：10 号就可以打款，卡到 15 号只是延迟。
 */
export function isSettleDue(settleMonth: string, settleDayStart: number, now: Date): boolean {
  return now.getTime() >= settleDateFor(settleMonth, settleDayStart).getTime();
}

/** 长周期（年卡及以上）。我们只有「按年」算长周期，连续包月与按月都算短周期。 */
export function isLongPeriod(period: string): boolean {
  return period === 'yearly';
}

// ---------------- 实名认证 ----------------

const ID_CARD_WEIGHTS = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
const ID_CARD_CHECK_CODES = ['1', '0', 'X', '9', '8', '7', '6', '5', '4', '3', '2'];

/**
 * 18 位身份证号校验（GB 11643-1999 的校验位算法）。
 *
 * 只做格式与校验位，不联公安库 —— 这是本地/演示环境，接真实实名校验要另走通道。
 * 但格式必须真校验：不校验的话，家长填 18 个 1 也能过，提现审核时才发现是废号。
 */
export function isValidIdCard(raw: string): boolean {
  const value = raw.trim().toUpperCase();
  if (!/^\d{17}[\dX]$/.test(value)) return false;

  // 出生日期必须是个真实存在的日子（20260230 这种要挡住）
  const year = Number(value.slice(6, 10));
  const month = Number(value.slice(10, 12));
  const day = Number(value.slice(12, 14));
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    return false;
  }
  if (year < 1900 || date.getTime() > Date.now()) return false;

  let sum = 0;
  for (let i = 0; i < 17; i += 1) sum += Number(value[i]) * ID_CARD_WEIGHTS[i];
  return ID_CARD_CHECK_CODES[sum % 11] === value[17];
}

/** 身份证号打码：只留前 6 位与后 4 位（前端展示用）。 */
export function maskIdCard(raw: string): string {
  const value = raw.trim().toUpperCase();
  if (value.length < 10) return '****';
  return `${value.slice(0, 6)}********${value.slice(-4)}`;
}
