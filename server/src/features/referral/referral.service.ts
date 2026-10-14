/**
 * 分享提成 / 邀请返现。
 *
 * 几条贯穿全文件的设计约束：
 * 1. **钱只认服务端的计算**。返现金额由订单实付金额 × 规则算出来并存进
 *    ReferralReward，家长端传什么金额都不看。
 * 2. **结算惰性收敛**。奖励按当月统计、次月 10 日起发放，这件事由
 *    settleForUser() 在每次读取时顺手做完（同一思路见 membership 的惰性降级）。
 *    另有一个 6 小时的定时任务兜底，但正确性不依赖它 —— 定时任务停一次，
 *    家长就该拿不到钱，这是不可接受的。
 * 3. **幂等**。券用 sourceRef 唯一索引去重；返现用订单号去重。
 *    重复调用只会重复算一遍，不会重复发钱。
 */

import crypto from 'crypto';
import { prisma } from '../../prisma';
import { config as appConfig } from '../../config';
import { BadRequestError, ConflictError, NotFoundError } from '../../errors';
import { logger } from '../../logger';
import {
  COUPON_STATUSES,
  CouponStatus,
  DEFAULT_CONFIG,
  DEFAULT_COUPON_RULES,
  DEFAULT_REWARD_TIERS,
  INVITE_CODE_ALPHABET,
  INVITE_CODE_LENGTH,
  INVITE_CODE_MAX_ATTEMPTS,
  MAX_WITHDRAWAL_CENTS,
  WITHDRAW_CHANNELS,
  WithdrawChannel,
  isValidIdCard,
  maskIdCard,
  settleMonthOf,
} from './referral.constants';
import {
  CouponAward,
  ReferralConfigLike,
  RewardQuote,
  checkWithdrawEligibility,
  couponAwardsFor,
  pickTier,
  quoteFirstPurchase,
  quoteRenewal,
} from './referral.rules';

/** 邀请码随机串。用 crypto 而不是 Math.random：可预测的邀请码等于可枚举。 */
function randomInviteCode(): string {
  const bytes = crypto.randomBytes(INVITE_CODE_LENGTH);
  let out = '';
  for (let i = 0; i < INVITE_CODE_LENGTH; i += 1) {
    out += INVITE_CODE_ALPHABET[bytes[i] % INVITE_CODE_ALPHABET.length];
  }
  return out;
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === 'P2002';
}

function maskPhone(phone: string | null | undefined): string {
  if (!phone) return '';
  if (phone.length < 7) return phone;
  return `${phone.slice(0, 3)}****${phone.slice(-4)}`;
}

function maskAccount(channel: string, account: string): string {
  const value = account.trim();
  if (channel === 'bank') {
    return value.length <= 4 ? `****${value}` : `**** **** **** ${value.slice(-4)}`;
  }
  // 支付宝/微信都是手机号或邮箱
  if (value.includes('@')) {
    const [name, domain] = value.split('@');
    const head = name.slice(0, 2);
    return `${head}***@${domain}`;
  }
  return maskPhone(value);
}

function generateRewardNo(): string {
  const d = new Date();
  const stamp = [
    d.getFullYear(),
    `${d.getMonth() + 1}`.padStart(2, '0'),
    `${d.getDate()}`.padStart(2, '0'),
    `${d.getHours()}`.padStart(2, '0'),
    `${d.getMinutes()}`.padStart(2, '0'),
    `${d.getSeconds()}`.padStart(2, '0'),
  ].join('');
  const rand = crypto.randomInt(100000, 999999);
  return `RW${stamp}${rand}`;
}

function generateWithdrawNo(): string {
  const d = new Date();
  const stamp = [
    d.getFullYear(),
    `${d.getMonth() + 1}`.padStart(2, '0'),
    `${d.getDate()}`.padStart(2, '0'),
    `${d.getHours()}`.padStart(2, '0'),
    `${d.getMinutes()}`.padStart(2, '0'),
    `${d.getSeconds()}`.padStart(2, '0'),
  ].join('');
  const rand = crypto.randomInt(100000, 999999);
  return `WD${stamp}${rand}`;
}

/** 身份证号哈希：只用于「同一证件是否已被别的账号实名」的比对。 */
function hashIdCard(raw: string): string {
  return crypto
    .createHmac('sha256', appConfig.JWT_SECRET)
    .update(`id-card:${raw.trim().toUpperCase()}`)
    .digest('hex');
}

// ---------------- 视图类型 ----------------

export interface ReferralConfigView extends ReferralConfigLike {
  enabled: boolean;
  title: string;
  subtitle: string;
  notice: string;
  /** 逐条的活动说明，家长端直接 map 渲染。 */
  noticeLines: string[];
  settleDayStart: number;
  settleDayEnd: number;
}

export interface ReferralStatsView {
  invitedCount: number;
  validCount: number;
  rewardTotalCents: number;
  pendingCents: number;
  settledCents: number;
  cancelledCents: number;
  withdrawnCents: number;
  pendingWithdrawCents: number;
  availableCents: number;
  couponUnusedCount: number;
  couponUnusedCents: number;
  /** 本月已产生的返现（待发放里属于本月的那部分）。 */
  currentMonthCents: string;
  currentMonthLabel: string;
}

export interface RewardView {
  rewardNo: string;
  kind: string;
  kindLabel: string;
  status: string;
  statusLabel: string;
  baseAmountCents: number;
  ratePercent: number;
  amountCents: number;
  capApplied: boolean;
  settleMonth: string;
  settledAt: string | null;
  cancelReason: string;
  createdAt: string;
  inviteeName: string;
  inviteePhone: string;
}

export interface CouponView {
  id: string;
  amountCents: number;
  source: string;
  status: CouponStatus;
  statusLabel: string;
  expiresAt: string | null;
  usedAt: string | null;
  usedOrderNo: string | null;
  createdAt: string;
  usable: boolean;
}

export interface WithdrawalView {
  withdrawNo: string;
  amountCents: number;
  status: string;
  statusLabel: string;
  realName: string;
  idCardTail: string;
  channel: string;
  channelLabel: string;
  account: string;
  userNote: string;
  reviewNote: string;
  createdAt: string;
  reviewedAt: string | null;
  paidAt: string | null;
}

export interface ReferralOverview {
  success: true;
  config: ReferralConfigView;
  inviteCode: string;
  /** 相对路径；家长端自己拼 window.location.origin，避免后端猜前端域名。 */
  linkPath: string;
  /** 绝对地址，仅用于「复制邀请文案」。 */
  inviteLink: string;
  stats: ReferralStatsView;
  tiers: { minInvitees: number; maxInvitees: number | null; ratePercent: number; current: boolean }[];
  currentTier: { minInvitees: number; maxInvitees: number | null; ratePercent: number } | null;
  nextTier: { minInvitees: number; ratePercent: number; needInvitees: number } | null;
  withdraw: ReturnType<typeof checkWithdrawEligibility>;
  identity: { verified: boolean; realName: string; idCardTail: string; idCardMasked: string };
  recentRewards: RewardView[];
  recentCoupons: CouponView[];
}

const KIND_LABELS: Record<string, string> = {
  first_purchase: '首充返现',
  renewal: '续费返现',
};
const REWARD_STATUS_LABELS: Record<string, string> = {
  pending: '待发放',
  settled: '已发放',
  cancelled: '已取消',
};
const WITHDRAWAL_STATUS_LABELS: Record<string, string> = {
  pending: '待审核',
  approved: '审核通过',
  paid: '已打款',
  rejected: '已驳回',
};
const WITHDRAWAL_CHANNEL_LABELS: Record<string, string> = {
  alipay: '支付宝',
  wechat: '微信',
  bank: '银行卡',
};
const COUPON_STATUS_LABELS: Record<string, string> = {
  unused: '未使用',
  used: '已使用',
  expired: '已过期',
};

// ---------------- 配置 ----------------

/** 铺初值：配置单行 + 阶梯 + 券里程碑。幂等，bootstrap 与 seed 都会调。 */
async function ensureDefaults(): Promise<{ tiers: number; couponRules: number }> {
  await prisma.referralConfig.upsert({
    where: { id: 'default' },
    update: {},
    create: { ...DEFAULT_CONFIG },
  });

  const tierCount = await prisma.referralRewardTier.count();
  if (tierCount === 0) {
    await prisma.referralRewardTier.createMany({ data: DEFAULT_REWARD_TIERS });
  }

  const couponCount = await prisma.referralCouponRule.count();
  if (couponCount === 0) {
    await prisma.referralCouponRule.createMany({ data: DEFAULT_COUPON_RULES });
  }

  return {
    tiers: await prisma.referralRewardTier.count(),
    couponRules: await prisma.referralCouponRule.count(),
  };
}

async function getConfig() {
  const existing = await prisma.referralConfig.findUnique({ where: { id: 'default' } });
  if (existing) return existing;
  return prisma.referralConfig.create({ data: { ...DEFAULT_CONFIG } });
}

function toConfigView(row: Awaited<ReturnType<typeof getConfig>>): ReferralConfigView {
  return {
    enabled: row.enabled,
    title: row.title,
    subtitle: row.subtitle,
    notice: row.notice,
    // 家长端要逐条渲染，直接给数组，别让前端去 split（换行符在不同平台会飘）
    noticeLines: row.notice ? row.notice.split('\n').filter((line) => line.trim()) : [],
    shortPeriodMinRatePercent: row.shortPeriodMinRatePercent,
    longPeriodCapCents: row.longPeriodCapCents,
    renewalRatePercent: row.renewalRatePercent,
    renewalCapCents: row.renewalCapCents,
    withdrawMinInvitees: row.withdrawMinInvitees,
    withdrawMinCents: row.withdrawMinCents,
    withdrawRequireVerified: row.withdrawRequireVerified,
    settleDayStart: row.settleDayStart,
    settleDayEnd: row.settleDayEnd,
  };
}

/** 阶梯 + 券规则（已启用、已排序）。返现计算与家长端展示共用。 */
async function loadRules() {
  const [tiers, couponRules] = await Promise.all([
    prisma.referralRewardTier.findMany({
      where: { enabled: true },
      orderBy: [{ sortOrder: 'asc' }, { minInvitees: 'asc' }],
    }),
    prisma.referralCouponRule.findMany({
      where: { enabled: true },
      orderBy: [{ sortOrder: 'asc' }, { inviteeCount: 'asc' }],
    }),
  ]);
  return { tiers, couponRules };
}

// ---------------- 邀请码 ----------------

/**
 * 取（必要时补发）邀请码。
 *
 * 老账号没有邀请码：不做数据迁移脚本，改成首次用到时补发，
 * 理由是这样新老账号走同一条路径，不会出现「迁移漏了一批人」。
 */
async function ensureInviteCode(userId: number): Promise<string> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { inviteCode: true },
  });
  if (!user) throw new NotFoundError('用户', String(userId));
  if (user.inviteCode) return user.inviteCode;

  for (let attempt = 0; attempt < INVITE_CODE_MAX_ATTEMPTS; attempt += 1) {
    try {
      const updated = await prisma.user.update({
        where: { id: userId },
        data: { inviteCode: randomInviteCode() },
        select: { inviteCode: true },
      });
      if (updated.inviteCode) return updated.inviteCode;
    } catch (error) {
      if (isUniqueViolation(error)) continue;
      throw error;
    }
  }
  throw new ConflictError('邀请码生成失败，请稍后重试');
}

/** 给所有还没有邀请码的账号补发（bootstrap 兜底，分批以免一次锁太久）。 */
async function backfillInviteCodes(batchSize = 200): Promise<number> {
  const users = await prisma.user.findMany({
    where: { inviteCode: null },
    select: { id: true },
    take: batchSize,
  });
  let done = 0;
  for (const user of users) {
    try {
      await ensureInviteCode(user.id);
      done += 1;
    } catch (error) {
      logger.warn({ msg: 'referral: 补发邀请码失败', userId: user.id, error: String(error) });
    }
  }
  return done;
}

// ---------------- 绑定 ----------------

/**
 * 注册前解析邀请码。返回 null 表示没填邀请码（自然注册）。
 *
 * 放在建账号**之前**校验：邀请码填错了要当场报错，
 * 而不是先把账号建出来、再悄悄丢掉邀请关系 —— 那种「注册成功了但没绑上」
 * 是最难查的一类问题（家长会说自己明明填了）。
 */
async function resolveInviteCode(code: string | undefined, inviteePhone?: string): Promise<number | null> {
  const normalized = (code ?? '').trim().toUpperCase();
  if (!normalized) return null;

  const config = await getConfig();
  // 活动暂停/结束后**忽略**邀请码，而不是拒绝这次注册。
  // 一条过期的分享链接不该把好友的注册一起挡掉 —— 少一笔返现，远比少一个注册便宜。
  // （下面的余额校验仍然照旧：码本身不存在 / 邀请人异常 / 自己邀请自己，该报错还是报错。）
  if (!config.enabled) return null;

  const inviter = await prisma.user.findUnique({
    where: { inviteCode: normalized },
    select: { id: true, phone: true, status: true },
  });
  if (!inviter) throw new BadRequestError('邀请码不存在，请确认后重试');
  if (inviter.status !== 'active') throw new BadRequestError('邀请人账号状态异常，无法绑定邀请关系');
  if (inviteePhone && inviter.phone && inviteePhone === inviter.phone) {
    throw new BadRequestError('不能使用自己的账号作为邀请人');
  }
  return inviter.id;
}

/** 建立邀请关系。此时被邀请人还没有充值，状态是 bound。 */
async function bindReferral(inviteeId: number, inviterId: number, code: string) {
  if (inviteeId === inviterId) throw new BadRequestError('不能使用自己的账号作为邀请人');

  const existing = await prisma.referral.findUnique({ where: { inviteeId } });
  if (existing) return existing;

  const normalized = code.trim().toUpperCase();
  return prisma.$transaction(async (tx) => {
    const created = await tx.referral.create({
      data: { inviterId, inviteeId, code: normalized },
    });
    await tx.user.update({
      where: { id: inviteeId },
      data: { referredById: inviterId, referredAt: new Date() },
    });
    return created;
  });
}

// ---------------- 统计 ----------------

async function sumByStatus(
  rows: { status: string; _sum: { amountCents: number | null }; _count: number }[],
  status: string,
): Promise<number> {
  const row = rows.find((r) => r.status === status);
  return row?._sum.amountCents ?? 0;
}

async function computeStats(inviterId: number, config: Awaited<ReturnType<typeof getConfig>>) {
  const [invitedCount, validCount, rewardRows, withdrawalRows, couponRows] = await Promise.all([
    prisma.referral.count({ where: { inviterId, status: { in: ['bound', 'valid'] } } }),
    prisma.referral.count({ where: { inviterId, status: 'valid' } }),
    prisma.referralReward.groupBy({
      by: ['status'],
      where: { inviterId },
      _sum: { amountCents: true },
      _count: true,
    }),
    prisma.referralWithdrawal.groupBy({
      by: ['status'],
      where: { userId: inviterId },
      _sum: { amountCents: true },
      _count: true,
    }),
    prisma.referralCoupon.groupBy({
      by: ['status'],
      where: { userId: inviterId },
      _sum: { amountCents: true },
      _count: true,
    }),
  ]);

  const pendingCents = await sumByStatus(rewardRows, 'pending');
  const settledCents = await sumByStatus(rewardRows, 'settled');
  const cancelledCents = await sumByStatus(rewardRows, 'cancelled');
  const withdrawnCents =
    (await sumByStatus(withdrawalRows, 'approved')) + (await sumByStatus(withdrawalRows, 'paid'));
  const pendingWithdrawCents = await sumByStatus(withdrawalRows, 'pending');

  const settleMonth = settleMonthOf(new Date());
  const currentMonth = await prisma.referralReward.aggregate({
    where: { inviterId, settleMonth, status: { not: 'cancelled' } },
    _sum: { amountCents: true },
  });

  const couponUnused = couponRows.find((r) => r.status === 'unused');

  const stats: ReferralStatsView = {
    invitedCount,
    validCount,
    rewardTotalCents: pendingCents + settledCents,
    pendingCents,
    settledCents,
    cancelledCents,
    withdrawnCents,
    pendingWithdrawCents,
    availableCents: Math.max(0, settledCents - withdrawnCents - pendingWithdrawCents),
    couponUnusedCount: couponUnused?._count ?? 0,
    couponUnusedCents: couponUnused?._sum.amountCents ?? 0,
    currentMonthCents: String(currentMonth._sum.amountCents ?? 0),
    currentMonthLabel: settleMonth,
  };

  return {
    stats,
    validCount,
    settledCents,
    withdrawnCents,
    pendingWithdrawCents,
    config,
  };
}

// ---------------- 结算 ----------------

/**
 * 把已到发放日的「待发放」返现转为「已发放」，并顺手把过期券置为 expired。
 *
 * 只处理这个用户的记录：家长打开一次页面就结算一次自己的，
 * 比全表扫描便宜得多，也不必等定时任务。
 */
async function settleForUser(userId: number, now = new Date()): Promise<number> {
  const config = await getConfig();

  const pending = await prisma.referralReward.findMany({
    where: { inviterId: userId, status: 'pending' },
    select: { id: true, settleMonth: true },
  });

  const dueMonths = [
    ...new Set(
      pending
        .filter((r) => {
          const [y, m] = r.settleMonth.split('-').map(Number);
          if (!y || !m) return false;
          // 次月 10 日（含）之后才算发放
          const due = new Date(y, m, config.settleDayStart, 0, 0, 0, 0);
          return now.getTime() >= due.getTime();
        })
        .map((r) => r.settleMonth),
    ),
  ];

  let settled = 0;
  if (dueMonths.length > 0) {
    const result = await prisma.referralReward.updateMany({
      where: { inviterId: userId, status: 'pending', settleMonth: { in: dueMonths } },
      data: { status: 'settled', settledAt: now },
    });
    settled = result.count;
  }

  await prisma.referralCoupon.updateMany({
    where: { userId, status: 'unused', expiresAt: { not: null, lt: now } },
    data: { status: 'expired' },
  });

  return settled;
}

/** 全站结算（定时任务兜底）。返回结算条数与置为过期的券数。 */
async function sweep(now = new Date()): Promise<{ settled: number; expiredCoupons: number }> {
  const config = await getConfig();
  const pending = await prisma.referralReward.findMany({
    where: { status: 'pending' },
    select: { settleMonth: true },
    distinct: ['settleMonth'],
  });

  const dueMonths = pending
    .filter((r) => {
      const [y, m] = r.settleMonth.split('-').map(Number);
      if (!y || !m) return false;
      const due = new Date(y, m, config.settleDayStart, 0, 0, 0, 0);
      return now.getTime() >= due.getTime();
    })
    .map((r) => r.settleMonth);

  let settled = 0;
  if (dueMonths.length > 0) {
    const result = await prisma.referralReward.updateMany({
      where: { status: 'pending', settleMonth: { in: dueMonths } },
      data: { status: 'settled', settledAt: now },
    });
    settled = result.count;
  }

  const expired = await prisma.referralCoupon.updateMany({
    where: { status: 'unused', expiresAt: { not: null, lt: now } },
    data: { status: 'expired' },
  });

  return { settled, expiredCoupons: expired.count };
}

// ---------------- 视图组装 ----------------

function toRewardView(row: {
  rewardNo: string;
  kind: string;
  status: string;
  baseAmountCents: number;
  ratePercent: number;
  amountCents: number;
  capApplied: boolean;
  settleMonth: string;
  settledAt: Date | null;
  cancelReason: string;
  createdAt: Date;
  invitee: { nickname: string; phone: string | null };
}): RewardView {
  return {
    rewardNo: row.rewardNo,
    kind: row.kind,
    kindLabel: KIND_LABELS[row.kind] ?? row.kind,
    status: row.status,
    statusLabel: REWARD_STATUS_LABELS[row.status] ?? row.status,
    baseAmountCents: row.baseAmountCents,
    ratePercent: row.ratePercent,
    amountCents: row.amountCents,
    capApplied: row.capApplied,
    settleMonth: row.settleMonth,
    settledAt: row.settledAt ? row.settledAt.toISOString() : null,
    cancelReason: row.cancelReason,
    createdAt: row.createdAt.toISOString(),
    inviteeName: row.invitee.nickname,
    inviteePhone: maskPhone(row.invitee.phone),
  };
}

function toCouponView(
  row: {
    id: string;
    amountCents: number;
    source: string;
    status: string;
    expiresAt: Date | null;
    usedAt: Date | null;
    usedOrderNo: string | null;
    createdAt: Date;
  },
  now = new Date(),
): CouponView {
  const expired = row.expiresAt !== null && row.expiresAt.getTime() < now.getTime();
  const status = (expired && row.status === 'unused' ? 'expired' : row.status) as CouponStatus;
  const known = COUPON_STATUSES.includes(status);
  return {
    id: row.id,
    amountCents: row.amountCents,
    source: row.source,
    status,
    statusLabel: known ? COUPON_STATUS_LABELS[status] : status,
    expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
    usedAt: row.usedAt ? row.usedAt.toISOString() : null,
    usedOrderNo: row.usedOrderNo,
    createdAt: row.createdAt.toISOString(),
    usable: status === 'unused',
  };
}

function toWithdrawalView(row: {
  withdrawNo: string;
  amountCents: number;
  status: string;
  realName: string;
  idCardTail: string;
  channel: string;
  account: string;
  userNote: string;
  reviewNote: string;
  createdAt: Date;
  reviewedAt: Date | null;
  paidAt: Date | null;
}): WithdrawalView {
  return {
    withdrawNo: row.withdrawNo,
    amountCents: row.amountCents,
    status: row.status,
    statusLabel: WITHDRAWAL_STATUS_LABELS[row.status] ?? row.status,
    realName: row.realName,
    idCardTail: row.idCardTail,
    channel: row.channel,
    channelLabel: WITHDRAWAL_CHANNEL_LABELS[row.channel] ?? row.channel,
    account: row.account,
    userNote: row.userNote,
    reviewNote: row.reviewNote,
    createdAt: row.createdAt.toISOString(),
    reviewedAt: row.reviewedAt ? row.reviewedAt.toISOString() : null,
    paidAt: row.paidAt ? row.paidAt.toISOString() : null,
  };
}

// ---------------- 家长端接口 ----------------

async function getOverview(userId: number): Promise<ReferralOverview> {
  await settleForUser(userId);

  const config = await getConfig();
  const inviteCode = await ensureInviteCode(userId);
  const { tiers } = await loadRules();
  const computed = await computeStats(userId, config);

  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: { realName: true, idCardTail: true, verifiedAt: true },
  });

  const eligibility = checkWithdrawEligibility({
    settledCents: computed.settledCents,
    withdrawnCents: computed.withdrawnCents,
    pendingWithdrawCents: computed.pendingWithdrawCents,
    validInvitees: computed.validCount,
    verified: Boolean(user.verifiedAt),
    config: toConfigView(config),
  });

  const currentTier = pickTier(tiers, computed.validCount);
  const sorted = tiers.slice().sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
  const currentIndex = currentTier ? sorted.findIndex((t) => t.id === currentTier.id) : -1;
  const next = currentIndex >= 0 ? sorted[currentIndex + 1] : undefined;

  const [recentRewards, recentCoupons] = await Promise.all([
    prisma.referralReward.findMany({
      where: { inviterId: userId },
      orderBy: { createdAt: 'desc' },
      take: 10,
      include: { invitee: { select: { nickname: true, phone: true } } },
    }),
    prisma.referralCoupon.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 10,
    }),
  ]);

  const linkPath = `/login?mode=register&invite=${inviteCode}`;

  return {
    success: true,
    config: toConfigView(config),
    inviteCode,
    linkPath,
    inviteLink: `${appConfig.PUBLIC_BASE_URL.trim() || 'http://localhost:5173'}${linkPath}`,
    stats: computed.stats,
    tiers: sorted.map((t) => ({
      minInvitees: t.minInvitees,
      maxInvitees: t.maxInvitees,
      ratePercent: t.ratePercent,
      current: t.id === currentTier?.id,
    })),
    currentTier: currentTier
      ? {
          minInvitees: currentTier.minInvitees,
          maxInvitees: currentTier.maxInvitees,
          ratePercent: currentTier.ratePercent,
        }
      : null,
    nextTier: next
      ? {
          minInvitees: next.minInvitees,
          ratePercent: next.ratePercent,
          needInvitees: Math.max(0, next.minInvitees - computed.validCount),
        }
      : null,
    withdraw: eligibility,
    identity: {
      verified: Boolean(user.verifiedAt),
      realName: user.realName ?? '',
      idCardTail: user.idCardTail ?? '',
      idCardMasked: user.idCardTail ? `**************${user.idCardTail}` : '',
    },
    recentRewards: recentRewards.map(toRewardView),
    recentCoupons: recentCoupons.map((c) => toCouponView(c)),
  };
}

async function listInvitees(userId: number, page: number, pageSize: number) {
  const where = { inviterId: userId };
  const [rows, total] = await Promise.all([
    prisma.referral.findMany({
      where,
      orderBy: { boundAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: { invitee: { select: { nickname: true, phone: true, createdAt: true } } },
    }),
    prisma.referral.count({ where }),
  ]);

  const inviteeIds = rows.map((r) => r.inviteeId);
  const rewards = inviteeIds.length
    ? await prisma.referralReward.groupBy({
        by: ['inviteeId'],
        where: { inviterId: userId, inviteeId: { in: inviteeIds }, status: { not: 'cancelled' } },
        _sum: { amountCents: true },
        _count: true,
      })
    : [];

  return {
    items: rows.map((row) => {
      const reward = rewards.find((r) => r.inviteeId === row.inviteeId);
      return {
        id: row.id,
        nickname: row.invitee.nickname,
        phone: maskPhone(row.invitee.phone),
        status: row.status,
        statusLabel:
          row.status === 'valid' ? '有效邀请' : row.status === 'invalid' ? '已作废' : '已注册',
        invalidReason: row.invalidReason,
        boundAt: row.boundAt.toISOString(),
        validAt: row.validAt ? row.validAt.toISOString() : null,
        rewardCents: reward?._sum.amountCents ?? 0,
        rewardCount: reward?._count ?? 0,
      };
    }),
    total,
    page,
    pageSize,
  };
}

async function listRewards(userId: number, page: number, pageSize: number, status?: string) {
  await settleForUser(userId);
  const where = { inviterId: userId, ...(status ? { status } : {}) };
  const [rows, total] = await Promise.all([
    prisma.referralReward.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: { invitee: { select: { nickname: true, phone: true } } },
    }),
    prisma.referralReward.count({ where }),
  ]);
  return { items: rows.map(toRewardView), total, page, pageSize };
}

async function listCoupons(userId: number, status?: string) {
  await settleForUser(userId);
  const where = { userId, ...(status ? { status } : {}) };
  const rows = await prisma.referralCoupon.findMany({
    where,
    orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
    take: 100,
  });
  const now = new Date();
  const items = rows.map((r) => toCouponView(r, now));
  return {
    items,
    summary: {
      unusedCount: items.filter((c) => c.status === 'unused').length,
      unusedCents: items.filter((c) => c.status === 'unused').reduce((s, c) => s + c.amountCents, 0),
      usedCount: items.filter((c) => c.status === 'used').length,
      expiredCount: items.filter((c) => c.status === 'expired').length,
    },
  };
}

async function listWithdrawals(userId: number, page: number, pageSize: number) {
  const where = { userId };
  const [rows, total] = await Promise.all([
    prisma.referralWithdrawal.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.referralWithdrawal.count({ where }),
  ]);
  return { items: rows.map(toWithdrawalView), total, page, pageSize };
}

/** 实名认证（提现前置）。同一证件只能实名一个账号 —— 这是反作弊条款的落点。 */
async function verifyIdentity(userId: number, realName: string, idCard: string) {
  const name = realName.trim();
  const value = idCard.trim().toUpperCase();
  if (name.length < 2 || name.length > 20) throw new BadRequestError('请输入真实姓名');
  if (!isValidIdCard(value)) throw new BadRequestError('身份证号不正确，请检查后重新输入');

  const idCardHash = hashIdCard(value);
  const taken = await prisma.user.findFirst({
    where: { idCardHash, id: { not: userId } },
    select: { id: true },
  });
  if (taken) {
    throw new ConflictError('该身份证号已被其他账号实名，同一证件不能用于多个账号');
  }

  const updated = await prisma.user.update({
    where: { id: userId },
    data: {
      realName: name,
      idCardHash,
      idCardTail: value.slice(-4),
      verifiedAt: new Date(),
    },
    select: { realName: true, idCardTail: true, verifiedAt: true },
  });

  return {
    verified: Boolean(updated.verifiedAt),
    realName: updated.realName ?? '',
    idCardMasked: maskIdCard(value),
  };
}

async function requestWithdrawal(
  userId: number,
  input: { amountCents?: number; channel: WithdrawChannel; account: string; note?: string },
) {
  await settleForUser(userId);
  const config = await getConfig();
  const view = toConfigView(config);
  const computed = await computeStats(userId, config);
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: { realName: true, idCardTail: true, verifiedAt: true },
  });

  const eligibility = checkWithdrawEligibility({
    settledCents: computed.settledCents,
    withdrawnCents: computed.withdrawnCents,
    pendingWithdrawCents: computed.pendingWithdrawCents,
    validInvitees: computed.validCount,
    verified: Boolean(user.verifiedAt),
    config: view,
  });

  if (!eligibility.eligible) {
    throw new BadRequestError(`暂时还不能提现：${eligibility.blockedReason}`);
  }

  const amountCents = input.amountCents ?? eligibility.availableCents;
  if (!Number.isFinite(amountCents) || amountCents <= 0) {
    throw new BadRequestError('提现金额必须大于 0');
  }
  if (amountCents > eligibility.availableCents) {
    throw new BadRequestError(
      `可提现余额不足，当前可提现 ¥${(eligibility.availableCents / 100).toFixed(2)}`,
    );
  }
  if (amountCents > MAX_WITHDRAWAL_CENTS) {
    throw new BadRequestError(`单次提现不能超过 ¥${(MAX_WITHDRAWAL_CENTS / 100).toFixed(2)}`);
  }
  if (!WITHDRAW_CHANNELS.includes(input.channel)) {
    throw new BadRequestError('请选择收款方式');
  }
  if (!input.account.trim()) throw new BadRequestError('请填写收款账号');

  if (!user.verifiedAt) throw new BadRequestError('请先完成实名认证');
  if (!user.realName || !user.idCardTail) throw new BadRequestError('请先完善实名信息');

  const created = await prisma.referralWithdrawal.create({
    data: {
      withdrawNo: generateWithdrawNo(),
      userId,
      amountCents,
      channel: input.channel,
      account: maskAccount(input.channel, input.account),
      realName: user.realName,
      idCardTail: user.idCardTail,
      userNote: input.note?.trim() ?? '',
    },
  });

  return toWithdrawalView(created);
}

// ---------------- 与会员支付的接线 ----------------

export interface PaidOrderInput {
  orderNo: string;
  userId: number;
  amountCents: number;
  tier: string;
  period: string;
  /** 是否是该账号的首笔支付。由调用方在事务前算好，避免并发下重复判断。 */
  isFirstPurchase: boolean;
  /** 连续包月自动续费产生的扣款。运营统计要能把「人主动买的」和「系统自动扣的」分开。 */
  isAutoRenew?: boolean;
}

/**
 * 订单支付成功后的返现落账。
 *
 * 幂等：同一个订单号只会产生一条返现记录（orderNo 去重）。
 * 反作弊：邀请人与被邀请人是同一账号 / 同一手机号 → 关系置为 invalid 不发钱。
 */
async function onOrderPaid(input: PaidOrderInput): Promise<{ rewarded: boolean; amountCents: number }> {
  const invitee = await prisma.user.findUnique({
    where: { id: input.userId },
    select: { id: true, phone: true, status: true, referredById: true },
  });
  if (!invitee?.referredById) return { rewarded: false, amountCents: 0 };
  if (invitee.status !== 'active') return { rewarded: false, amountCents: 0 };

  const inviterId = invitee.referredById;
  if (inviterId === invitee.id) return { rewarded: false, amountCents: 0 };

  const existingReward = await prisma.referralReward.findFirst({
    where: { orderNo: input.orderNo },
    select: { id: true, amountCents: true },
  });
  if (existingReward) return { rewarded: false, amountCents: existingReward.amountCents };

  const [inviter, config, rules, referral] = await Promise.all([
    prisma.user.findUnique({
      where: { id: inviterId },
      select: { id: true, phone: true, status: true },
    }),
    getConfig(),
    loadRules(),
    prisma.referral.findUnique({ where: { inviteeId: invitee.id } }),
  ]);

  if (!inviter || inviter.status !== 'active') {
    return { rewarded: false, amountCents: 0 };
  }
  // 自买自返：同一手机号（或同一账号）之间不产生返现
  if (inviter.phone && invitee.phone && inviter.phone === invitee.phone) {
    await prisma.referral.updateMany({
      where: { inviteeId: invitee.id },
      data: { status: 'invalid', invalidReason: '邀请人与被邀请人手机号相同，疑似自买自返' },
    });
    logger.warn({ msg: 'referral: 自买自返拦截', inviterId, inviteeId: invitee.id });
    return { rewarded: false, amountCents: 0 };
  }

  // 先把关系置为有效，再按最新的有效邀请人数取阶梯 ——
  // 家长看到的是「我现在有 3 个有效邀请」，比例就该按 3 算。
  const now = new Date();
  if (!referral) {
    await prisma.referral.create({
      data: {
        inviterId,
        inviteeId: invitee.id,
        code: '',
        status: 'valid',
        validAt: now,
      },
    });
  } else if (referral.status !== 'valid') {
    await prisma.referral.update({
      where: { id: referral.id },
      data: { status: 'valid', validAt: referral.validAt ?? now },
    });
  }

  const validCount = await prisma.referral.count({ where: { inviterId, status: 'valid' } });
  const configView = toConfigView(config);

  const quote: RewardQuote = input.isFirstPurchase
    ? quoteFirstPurchase({
        baseAmountCents: input.amountCents,
        inviteeCount: validCount,
        period: input.period,
        tiers: rules.tiers,
        config: configView,
      })
    : quoteRenewal({
        baseAmountCents: input.amountCents,
        inviteeCount: validCount,
        tiers: rules.tiers,
        config: configView,
      });

  // 券里程碑：无论这次返现多少，只要有效邀请人数涨到了门槛就发券
  const awards = couponAwardsFor(rules.couponRules, validCount);
  if (awards.length > 0) {
    await awardCoupons(inviterId, awards, now);
  }

  if (quote.amountCents <= 0) return { rewarded: false, amountCents: 0 };

  await prisma.referralReward.create({
    data: {
      rewardNo: generateRewardNo(),
      inviterId,
      inviteeId: invitee.id,
      orderNo: input.orderNo,
      kind: input.isFirstPurchase ? 'first_purchase' : 'renewal',
      baseAmountCents: input.amountCents,
      ratePercent: quote.ratePercent,
      amountCents: quote.amountCents,
      capApplied: quote.capApplied,
      status: 'pending',
      settleMonth: settleMonthOf(now),
    },
  });

  logger.info({
    msg: 'referral: 返现已入账',
    inviterId,
    inviteeId: invitee.id,
    orderNo: input.orderNo,
    kind: input.isFirstPurchase ? 'first_purchase' : 'renewal',
    amountCents: quote.amountCents,
  });

  return { rewarded: true, amountCents: quote.amountCents };
}

/** 发券。sourceRef 唯一，重复调用不会重复发。 */
async function awardCoupons(userId: number, awards: CouponAward[], now = new Date()): Promise<number> {
  const data = awards.map((award) => ({
    userId,
    amountCents: award.amountCents,
    source: 'milestone',
    sourceRef: award.sourceRef,
    status: 'unused',
    expiresAt:
      award.validDays > 0
        ? new Date(now.getTime() + award.validDays * 24 * 3600 * 1000)
        : null,
  }));
  const result = await prisma.referralCoupon.createMany({ data, skipDuplicates: true });
  if (result.count > 0) {
    logger.info({ msg: 'referral: 发放优惠券', userId, count: result.count });
  }
  return result.count;
}

/**
 * 订单退款/取消后的奖励追回（截图第 5 条）。
 *
 * 只要还没提现走，就把返现置为 cancelled 并把该笔「有效邀请」降回已注册；
 * 已经打进提现单的部分不在这里动 —— 那是财务侧的事，改数据库只会让账更乱。
 */
async function onOrderReversed(orderNo: string, reason = '订单已退款'): Promise<number> {
  const rewards = await prisma.referralReward.findMany({ where: { orderNo } });
  if (rewards.length === 0) return 0;

  let cancelled = 0;
  for (const reward of rewards) {
    if (reward.status === 'cancelled') continue;
    await prisma.referralReward.update({
      where: { id: reward.id },
      data: { status: 'cancelled', cancelReason: reason },
    });
    cancelled += 1;
  }

  // 被邀请人退回「未充值」，有效邀请人数随之减少
  const inviteeId = rewards[0].inviteeId;
  const inviterId = rewards[0].inviterId;
  const stillPaid = await prisma.membershipOrder.count({
    where: { userId: inviteeId, status: 'paid' },
  });
  if (stillPaid === 0) {
    await prisma.referral.updateMany({
      where: { inviteeId, inviterId },
      data: { status: 'bound', validAt: null, invalidReason: '' },
    });
  }

  logger.info({ msg: 'referral: 返现已追回', orderNo, cancelled });
  return cancelled;
}

// ---------------- 优惠券抵扣（与会员下单接线） ----------------

/**
 * 校验并取出一张券的抵扣额。
 *
 * 不在这里改券的状态：下单只是「预约使用」，支付成功才算真用掉。
 * 否则用户下了一单不付，券就凭空没了 —— 这类投诉客服永远解释不清。
 */
async function quoteCoupon(userId: number, couponId: string): Promise<{ id: string; amountCents: number }> {
  const coupon = await prisma.referralCoupon.findFirst({ where: { id: couponId, userId } });
  if (!coupon) throw new NotFoundError('优惠券', couponId);
  if (coupon.status !== 'unused') throw new BadRequestError('该优惠券已使用或已过期');
  if (coupon.expiresAt && coupon.expiresAt.getTime() < Date.now()) {
    await prisma.referralCoupon.update({ where: { id: coupon.id }, data: { status: 'expired' } });
    throw new BadRequestError('该优惠券已过期');
  }
  return { id: coupon.id, amountCents: coupon.amountCents };
}

/** 支付成功：核销券。用条件更新，重复调用不会把第二次也标记成功。 */
async function consumeCoupon(couponId: string, orderNo: string): Promise<boolean> {
  const result = await prisma.referralCoupon.updateMany({
    where: { id: couponId, status: 'unused' },
    data: { status: 'used', usedAt: new Date(), usedOrderNo: orderNo },
  });
  return result.count > 0;
}

/** 订单取消/过期/失败：把预约中的券放回未使用。 */
async function releaseCoupon(couponId: string): Promise<boolean> {
  const result = await prisma.referralCoupon.updateMany({
    where: { id: couponId, status: 'used', usedOrderNo: { not: null } },
    data: { status: 'unused', usedAt: null, usedOrderNo: null },
  });
  return result.count > 0;
}

/** 家长端会员中心下单时挑券：列出当前可用（未使用未过期）的券。 */
async function listUsableCoupons(userId: number) {
  await settleForUser(userId);
  const rows = await prisma.referralCoupon.findMany({
    where: { userId, status: 'unused' },
    orderBy: { amountCents: 'desc' },
  });
  const now = new Date();
  return rows
    .map((r) => toCouponView(r, now))
    .filter((c) => c.usable);
}

export const referralService = {
  ensureDefaults,
  backfillInviteCodes,
  getConfig,
  ensureInviteCode,
  resolveInviteCode,
  bindReferral,
  getOverview,
  listInvitees,
  listRewards,
  listCoupons,
  listWithdrawals,
  verifyIdentity,
  requestWithdrawal,
  onOrderPaid,
  onOrderReversed,
  settleForUser,
  sweep,
  quoteCoupon,
  consumeCoupon,
  releaseCoupon,
  listUsableCoupons,
};
