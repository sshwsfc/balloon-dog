/**
 * 会员服务：状态解析、动态报价、下单、模拟支付、到期收敛。
 *
 * 两个贯穿全文件的设计选择：
 *
 * 1. **惰性收敛**：档位不靠定时任务清理。每次读取会员状态时按 membershipExpiresAt
 *    现场判定，过期就顺手写回 ordinary。定时任务停一次，过期用户就永久享受会员权限 ——
 *    这种「依赖一个必须一直活着的进程」的权限模型不值得用。
 *
 * 2. **金额快照**：订单里存下单那一刻的原价、实付与命中的规则明细。规则后台随时能改，
 *    若订单只存 planCode，事后对账就是拿今天的价格解释上个月的订单。
 */

import type { MembershipOrder, MembershipPlan, Prisma } from '@prisma/client';
import { prisma } from '../../prisma';
import { config } from '../../config';
import { logger } from '../../logger';
import { BadRequestError, ConflictError, NotFoundError } from '../../errors';
import {
  DEFAULT_PLANS,
  DEFAULT_PRICING_RULES,
  DEFAULT_REFERRAL_PRICE_RULES,
  ENTITLEMENTS,
  PERIOD_LABELS,
  PERIOD_MONTHS,
  PAY_CHANNEL_FAKE,
  TIER_LABELS,
  TIER_RANK,
  isMembershipTier,
  isPurchasableTier,
  type BillingPeriod,
  type MembershipTier,
  type PurchasableTier,
} from './membership.constants';
import { fakeProviderAllowed } from '../payments/payments.constants';
import {
  priceWithReferral,
  type PricingAdjustment,
  type PricingContext,
  type PricingResult,
  type ReferralPriceView,
  type ReferralPricingContext,
} from './membership.pricing';
import { referralService } from '../referral/referral.service';

/** 连续包月允许的「迟到」上限：断档超过这个天数就不再自动续费。 */
const AUTO_RENEW_GRACE_DAYS = 31;

type UserMembershipRow = {
  id: number;
  membershipTier: string;
  membershipExpiresAt: Date | null;
  membershipStartedAt: Date | null;
  membershipAutoRenew: boolean;
  membershipRenewTier: string | null;
  firstPaidAt: Date | null;
  totalPaidCents: number;
  createdAt: Date;
};

const USER_MEMBERSHIP_SELECT = {
  id: true,
  membershipTier: true,
  membershipExpiresAt: true,
  membershipStartedAt: true,
  membershipAutoRenew: true,
  membershipRenewTier: true,
  firstPaidAt: true,
  totalPaidCents: true,
  createdAt: true,
} as const;

/** 传给家长端的会员状态。 */
export interface MembershipStatusView {
  tier: MembershipTier;
  tierLabel: string;
  /** 是否处于付费生效期。ordinary 或已过期都是 false。 */
  active: boolean;
  expiresAt: string | null;
  /** 剩余天数（不足一天算 1 天）；非会员为 null。 */
  daysLeft: number | null;
  autoRenew: boolean;
  renewTier: PurchasableTier | null;
  startedAt: string | null;
  /** 首次付费成功时间；null = 从未付费（「首单优惠」判定用）。 */
  firstPaidAt: string | null;
  totalPaidCents: number;
  /** 当前档位已解锁的权益 key。 */
  entitlements: string[];
  /** 下一档还差哪些权益；已是最高档为 null。 */
  nextTier: { tier: PurchasableTier; label: string; missing: { key: string; label: string }[] } | null;
}

export interface PlanQuote {
  code: string;
  name: string;
  description: string;
  tier: PurchasableTier;
  period: BillingPeriod;
  periodLabel: string;
  months: number;
  recommended: boolean;
  originalCents: number;
  finalCents: number;
  discountCents: number;
  monthlyEquivalentCents: number;
  adjustments: PricingAdjustment[];
}

export interface TierQuotes {
  tier: PurchasableTier;
  label: string;
  plans: PlanQuote[];
}

export interface OrderView {
  orderNo: string;
  planCode: string;
  tier: PurchasableTier;
  period: BillingPeriod;
  periodLabel: string;
  originalCents: number;
  amountCents: number;
  /** 抵扣用的邀请优惠券（没有则是 null）。 */
  couponId: string | null;
  couponCents: number;
  adjustments: PricingAdjustment[];
  payChannel: string;
  status: string;
  paidAt: string | null;
  startsAt: string | null;
  expiresAt: string | null;
  autoRenew: boolean;
  createdAt: string;
}

// ============================================================
// 小工具
// ============================================================

/**
 * 加 N 个月。1 月 31 日 + 1 个月会滚到 3 月 3 日，所以月末要压回来 ——
 * 会员到期时间跳过一整个月，用户会认为被多扣了一个月。
 */
export function addMonths(date: Date, months: number): Date {
  const out = new Date(date.getTime());
  const day = out.getDate();
  out.setMonth(out.getMonth() + months);
  if (out.getDate() < day) out.setDate(0);
  return out;
}

function daysBetween(from: Date, to: Date): number {
  return Math.ceil((to.getTime() - from.getTime()) / 86_400_000);
}

function generateOrderNo(): string {
  const d = new Date();
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  const stamp =
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const rand = String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0');
  return `MB${stamp}${rand}`;
}

function mockTransactionId(orderNo: string, channel: string): string {
  return `MOCK-${channel.toUpperCase()}-${orderNo}`;
}

function parseAdjustments(raw: string): PricingAdjustment[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as PricingAdjustment[]) : [];
  } catch {
    return [];
  }
}

// ============================================================
// 状态解析
// ============================================================

/**
 * 连续包月自动续费。
 *
 * 用「旧的到期时间」做乐观锁（updateMany 的 where 带上它）：
 * 家长端同时发出两个请求时，只有一个能改成功，另一个 count=0 直接放弃 ——
 * 否则一次到期会被扣两次钱。
 *
 * 断档超过 AUTO_RENEW_GRACE_DAYS 天则不再续费，直接降级：
 * 账号放了半年回来就静默补扣 6 个月，是能上新闻的那种事故。
 */
async function tryAutoRenew(user: UserMembershipRow): Promise<boolean> {
  if (!user.membershipExpiresAt || !user.membershipRenewTier) return false;
  if (!isPurchasableTier(user.membershipRenewTier)) return false;

  const now = new Date();
  const lapsedDays = daysBetween(user.membershipExpiresAt, now);
  if (lapsedDays > AUTO_RENEW_GRACE_DAYS) return false;

  const plan = await prisma.membershipPlan.findUnique({
    where: { code: `${user.membershipRenewTier}_auto_monthly` },
  });
  if (!plan || !plan.enabled) return false;

  const rules = await prisma.membershipPricingRule.findMany({ where: { enabled: true } });
  const ctx = await buildPricingContext(user);
  const { result: pricing, referral } = await quote(plan, rules, ctx, user.id);

  const base = user.membershipExpiresAt;
  const expiresAt = addMonths(base, PERIOD_MONTHS.auto_monthly);

  const claimed = await prisma.user.updateMany({
    where: {
      id: user.id,
      membershipTier: user.membershipRenewTier,
      membershipExpiresAt: base,
      membershipAutoRenew: true,
    },
    data: {
      membershipTier: user.membershipRenewTier,
      membershipExpiresAt: expiresAt,
      totalPaidCents: { increment: pricing.finalCents },
    },
  });
  if (claimed.count === 0) return false; // 并发请求已经续过了

  await prisma.membershipOrder.create({
    data: {
      orderNo: generateOrderNo(),
      userId: user.id,
      planCode: plan.code,
      tier: user.membershipRenewTier,
      period: 'auto_monthly',
      originalCents: pricing.originalCents,
      amountCents: pricing.finalCents,
      referralRuleId: referral.applied ? referral.ruleId : null,
      referralRuleName: referral.applied ? referral.ruleName : '',
      referralSurchargeCents: referral.surchargeCents,
      adjustments: JSON.stringify(pricing.adjustments),
      payChannel: 'wechat',
      status: 'paid',
      transactionId: `MOCK-AUTORENEW-${user.id}-${expiresAt.getTime()}`,
      paidAt: now,
      startsAt: base,
      expiresAt,
      autoRenew: true,
    },
  });

  // 自动续费同样要给邀请人算续费返现；失败只记录，不影响本次续费结果
  try {
    await referralService.onOrderPaid({
      orderNo: `AUTORENEW-${user.id}-${expiresAt.getTime()}`,
      userId: user.id,
      amountCents: pricing.finalCents,
      tier: user.membershipRenewTier ?? 'member',
      period: 'auto_monthly',
      isFirstPurchase: false,
      isAutoRenew: true,
    });
  } catch (error) {
    logger.error({ msg: 'referral settlement failed for auto renew', userId: user.id, err: error });
  }
  return true;
}

/** 把库里的原始档位收敛成「此刻真正生效的档位」，必要时顺手写回。 */
async function resolveMembership(userId: number): Promise<MembershipStatusView> {
  const user = (await prisma.user.findUnique({
    where: { id: userId },
    select: USER_MEMBERSHIP_SELECT,
  })) as UserMembershipRow | null;
  if (!user) throw new NotFoundError('用户', String(userId));

  let row: UserMembershipRow = user;
  let tier: MembershipTier = isMembershipTier(row.membershipTier) ? row.membershipTier : 'ordinary';

  if (tier !== 'ordinary') {
    const expiresAt = row.membershipExpiresAt;
    if (!expiresAt || expiresAt.getTime() <= Date.now()) {
      let renewed = false;
      if (row.membershipAutoRenew) renewed = await tryAutoRenew(row);
      if (renewed) {
        const fresh = (await prisma.user.findUnique({
          where: { id: userId },
          select: USER_MEMBERSHIP_SELECT,
        })) as UserMembershipRow;
        row = fresh;
        tier = isMembershipTier(row.membershipTier) ? row.membershipTier : 'ordinary';
      } else {
        // 降级：档位、到期时间、续费签约一起清掉，只留历史统计字段
        await prisma.user.update({
          where: { id: userId },
          data: {
            membershipTier: 'ordinary',
            membershipExpiresAt: null,
            membershipAutoRenew: false,
            membershipRenewTier: null,
          },
        });
        row = { ...row, membershipTier: 'ordinary', membershipExpiresAt: null, membershipAutoRenew: false, membershipRenewTier: null };
        tier = 'ordinary';
      }
    }
  }

  return toStatusView(row, tier);
}

function toStatusView(row: UserMembershipRow, tier: MembershipTier): MembershipStatusView {
  const active = tier !== 'ordinary' && !!row.membershipExpiresAt && row.membershipExpiresAt.getTime() > Date.now();
  const daysLeft = active && row.membershipExpiresAt ? Math.max(1, daysBetween(new Date(), row.membershipExpiresAt)) : null;
  const entitlements = ENTITLEMENTS.filter((e) => TIER_RANK[tier] >= TIER_RANK[e.minTier]).map((e) => e.key);

  let nextTier: MembershipStatusView['nextTier'] = null;
  if (TIER_RANK[tier] < TIER_RANK.super) {
    const target: PurchasableTier = tier === 'ordinary' ? 'member' : 'super';
    const missing = ENTITLEMENTS.filter(
      (e) => TIER_RANK[target] >= TIER_RANK[e.minTier] && TIER_RANK[tier] < TIER_RANK[e.minTier],
    ).map((e) => ({ key: e.key, label: e.label }));
    nextTier = { tier: target, label: TIER_LABELS[target], missing };
  }

  return {
    tier,
    tierLabel: TIER_LABELS[tier],
    active,
    expiresAt: active && row.membershipExpiresAt ? row.membershipExpiresAt.toISOString() : null,
    daysLeft,
    autoRenew: active && row.membershipAutoRenew,
    renewTier: isPurchasableTier(row.membershipRenewTier ?? '') ? (row.membershipRenewTier as PurchasableTier) : null,
    startedAt: row.membershipStartedAt ? row.membershipStartedAt.toISOString() : null,
    firstPaidAt: row.firstPaidAt ? row.firstPaidAt.toISOString() : null,
    totalPaidCents: row.totalPaidCents,
    entitlements,
    nextTier,
  };
}

async function buildPricingContext(row: {
  id: number;
  firstPaidAt: Date | null;
  createdAt: Date;
  membershipTier?: string;
  membershipExpiresAt?: Date | null;
}): Promise<PricingContext> {
  const deviceCount = await prisma.childDevice.count({ where: { userId: row.id } });
  let activeTier: MembershipTier = 'ordinary';
  if (isMembershipTier(row.membershipTier ?? '') && row.membershipExpiresAt && row.membershipExpiresAt.getTime() > Date.now()) {
    activeTier = row.membershipTier as MembershipTier;
  }
  const registeredDaysAgo = Math.floor((Date.now() - row.createdAt.getTime()) / 86_400_000);
  return { hasPaid: !!row.firstPaidAt, activeTier, deviceCount, registeredDaysAgo };
}

/**
 * 账号的邀请身份：是不是被邀请注册的、邀请关系还有没有效。
 *
 * 「没有 Referral 行」按有效处理（只有被邀请人的关系行被删掉才会出现，属于数据被清理的
 * 边缘情况）：冤枉一个正常家长的代价，比少收一次几块钱的差价大得多。
 */
async function buildReferralPricingContext(userId: number): Promise<ReferralPricingContext> {
  const [user, referral] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: { referredById: true } }),
    prisma.referral.findUnique({ where: { inviteeId: userId }, select: { status: true } }),
  ]);
  return {
    invited: Boolean(user?.referredById),
    active: referral ? referral.status !== 'invalid' : true,
  };
}

/**
 * 一次算完「常规定价 + 受邀定价」。
 *
 * 家长端报价、下单、自动续费三处都必须走它 —— 少读一张表就会出现
 * 「会员中心显示 9 折、下单却是原价」这种最招投诉的不一致。
 */
async function quote(
  plan: MembershipPlan,
  rules: Awaited<ReturnType<typeof loadPricingRules>>,
  ctx: PricingContext,
  userId: number,
): Promise<{ result: PricingResult; referral: ReferralPriceView }> {
  const [referralRules, referralCtx] = await Promise.all([
    loadReferralPriceRules(),
    buildReferralPricingContext(userId),
  ]);
  return priceWithReferral(plan, rules, ctx, referralRules, referralCtx);
}

function loadPricingRules() {
  return prisma.membershipPricingRule.findMany({ where: { enabled: true } });
}

function loadReferralPriceRules() {
  return prisma.membershipReferralPriceRule.findMany({ where: { enabled: true } });
}

// ============================================================
// 视图转换
// ============================================================

/**
 * 订单视图（**家长端**）。
 *
 * 受邀定价对家长端是**不可见**的：不下发规则名，也不下发上浮金额；订单里那些
 * 「原价 − 逐条优惠」的明细是按下单**前**的常规定价算的，受邀账号的实付比这份明细
 * 算出来的高，摆出来就是一份自相矛盾的账单（15 − 3.75 ≠ 22.5），等于把上浮写在脸上。
 * 所以受邀订单直接压平：原价 = 实付、优惠明细清空，家长端只会看到一个干净的价格。
 * 完整快照仍在 MembershipOrder 表里，后台订单页照常展示（见 membership.admin.service.ts）。
 */
function toOrderView(order: MembershipOrder): OrderView {
  const concealed = order.referralSurchargeCents > 0;
  return {
    orderNo: order.orderNo,
    planCode: order.planCode,
    tier: order.tier as PurchasableTier,
    period: order.period as BillingPeriod,
    periodLabel: PERIOD_LABELS[order.period as BillingPeriod] ?? order.period,
    originalCents: concealed ? order.amountCents : order.originalCents,
    amountCents: order.amountCents,
    couponId: order.couponId,
    couponCents: order.couponCents,
    adjustments: concealed ? [] : parseAdjustments(order.adjustments),
    payChannel: order.payChannel,
    status: order.status,
    paidAt: order.paidAt ? order.paidAt.toISOString() : null,
    startsAt: order.startsAt ? order.startsAt.toISOString() : null,
    expiresAt: order.expiresAt ? order.expiresAt.toISOString() : null,
    autoRenew: order.autoRenew,
    createdAt: order.createdAt.toISOString(),
  };
}

/**
 * 套餐报价视图（**家长端**）。
 *
 * 与 `toOrderView` 同一个理由：受邀定价只影响价格，不向家长解释原因。
 * 受邀价生效时把常规定价的优惠明细一并收起 —— 那份明细按下单前的常规定价算，
 * 和上浮后的价格对不上；同时也不下发 `referral`（规则名 + 上浮额），
 * 否则随便打开一次开发者工具就能看到「受邀好友首单上浮 100% +￥107.6」。
 */
function quoteOf(plan: MembershipPlan, pricing: PricingResult, referral: ReferralPriceView): PlanQuote {
  const concealed = referral.applied;
  return {
    code: plan.code,
    name: plan.name,
    description: plan.description,
    tier: plan.tier as PurchasableTier,
    period: plan.period as BillingPeriod,
    periodLabel: PERIOD_LABELS[plan.period as BillingPeriod] ?? plan.period,
    months: plan.months,
    recommended: plan.recommended,
    originalCents: concealed ? pricing.finalCents : pricing.originalCents,
    finalCents: pricing.finalCents,
    discountCents: concealed ? 0 : pricing.discountCents,
    monthlyEquivalentCents: pricing.monthlyEquivalentCents,
    adjustments: concealed ? [] : pricing.adjustments,
  };
}

// ============================================================
// 对外服务
// ============================================================

/** 只算报价（会员中心、下单前、后台试算都走它）。 */
async function quoteAll(userId: number): Promise<TierQuotes[]> {
    const user = (await prisma.user.findUnique({
      where: { id: userId },
      select: USER_MEMBERSHIP_SELECT,
    })) as UserMembershipRow | null;
    if (!user) throw new NotFoundError('用户', String(userId));

    const [plans, rules, ctx, referralRules, referralCtx] = await Promise.all([
      prisma.membershipPlan.findMany({ where: { enabled: true }, orderBy: [{ tier: 'asc' }, { sortOrder: 'asc' }] }),
      loadPricingRules(),
      buildPricingContext(user),
      loadReferralPriceRules(),
      buildReferralPricingContext(userId),
    ]);

    const tiers: TierQuotes[] = [];
    for (const tier of ['member', 'super'] as PurchasableTier[]) {
      const tierPlans = plans.filter((p) => p.tier === tier);
      if (tierPlans.length === 0) continue;
      tiers.push({
        tier,
        label: TIER_LABELS[tier],
        plans: tierPlans.map((p) => {
          const { result, referral } = priceWithReferral(p, rules, ctx, referralRules, referralCtx);
          return quoteOf(p, result, referral);
        }),
      });
    }
    return tiers;
}

/**
 * 把一笔待支付订单结算成「已支付 + 会员生效」。**渠道无关、且幂等。**
 *
 * 之所以把它从 `payOrder()` 里抽出来：规划 §5.4 接入真实支付后，有两条路会走到
 * 「钱到账了」—— 模拟支付（`payOrder`）与渠道异步回调（`features/payments/payments.service`）。
 * 如果各写一遍，第二次改规则（比如会员区间的算法、返现结算时机）必然只改一处，
 * 于是「模拟支付测通了、真渠道上线后行为不同」。两条路都调用这里，只有一处实现。
 *
 * 幂等由事务里的 `updateMany({ where: { id, status: 'pending' } })` 保证：
 * 渠道重复投递同一个回调时返回 `changed: false`，不重复加会员时长、不重复返现。
 */
export async function applyPaidOrder(input: {
  orderId: string;
  /** 渠道流水号；模拟支付时是本地生成的占位号 */
  transactionId: string;
  /** 渠道实收金额，用于和订单金额比对（比对失败时调用方就不该调进来） */
  paidCents?: number;
  paidAt?: Date;
}): Promise<{ order: MembershipOrder; userId: number; changed: boolean }> {
  const order = await prisma.membershipOrder.findUnique({ where: { id: input.orderId } });
  if (!order) throw new NotFoundError('订单', input.orderId);
  if (order.status === 'paid') return { order, userId: order.userId, changed: false };
  if (order.status !== 'pending') throw new ConflictError('该订单已结束，请重新下单');

  const userId = order.userId;
  const now = input.paidAt ?? new Date();
  const state = await resolveMembership(userId);
  const currentExpiry = state.expiresAt ? new Date(state.expiresAt) : null;
  // 同档续费接着剩余时长；升级/跨档从此刻重新起算（剩余的旧档时长由
  // tier_upgrade 定价规则以抵扣的形式补偿，见 membership.constants.ts）。
  const sameTier = state.tier === order.tier;
  const periodStart = sameTier && currentExpiry && currentExpiry.getTime() > now.getTime() ? currentExpiry : now;
  const periodEnd = addMonths(periodStart, PERIOD_MONTHS[order.period as BillingPeriod] ?? 1);

  const updated = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const claimed = await tx.membershipOrder.updateMany({
      where: { id: order.id, status: 'pending' },
      data: {
        status: 'paid',
        paidAt: now,
        transactionId: input.transactionId,
        startsAt: periodStart,
        expiresAt: periodEnd,
      },
    });
    if (claimed.count === 0) throw new ConflictError('订单状态已变化，请刷新后重试');

    await tx.user.update({
      where: { id: userId },
      data: {
        membershipTier: order.tier,
        membershipExpiresAt: periodEnd,
        membershipStartedAt: state.startedAt ? new Date(state.startedAt) : now,
        membershipAutoRenew: order.autoRenew,
        membershipRenewTier: order.autoRenew ? order.tier : null,
        firstPaidAt: state.firstPaidAt ? undefined : now,
        totalPaidCents: { increment: order.amountCents },
      },
    });

    return tx.membershipOrder.findUniqueOrThrow({ where: { id: order.id } });
  });

  // 返现与优惠券的结算放在事务之外，并且整体 try/catch 兜住：
  // 此刻钱已经到账、会员已经生效，返现失败只该记日志（可以事后补），
  // 绝不能把会员一起回滚掉 —— 那才是真正的「付了钱没到账」。
  try {
    await referralService.onOrderPaid({
      orderNo: order.orderNo,
      userId,
      amountCents: order.amountCents,
      tier: order.tier,
      period: order.period,
      isFirstPurchase: !state.firstPaidAt,
      isAutoRenew: false,
    });
    if (order.couponId) await referralService.consumeCoupon(order.couponId, order.orderNo);
  } catch (error) {
    logger.error({ msg: 'referral settlement failed', orderNo: order.orderNo, err: error });
  }

  return { order: updated, userId, changed: true };
}

export const membershipService = {
  /** 家长端会员中心：当前状态 + 每档套餐的动态报价。 */
  async getOverview(userId: number) {
    const [status, tiers] = await Promise.all([resolveMembership(userId), quoteAll(userId)]);
    return { status, entitlements: ENTITLEMENTS, tiers };
  },

  quoteAll,
  getStatus: resolveMembership,

  async createOrder(
    userId: number,
    input: { planCode: string; payChannel: string; couponId?: string },
  ) {
    // 假渠道只存在于测试环境（规划 §5.4）：它不联网、回调签名是 md5，
    // 一旦在生产可用，就等于给「不花开会员」留了后门。dto 里允许这个枚举值，
    // 真正的闸在这里 —— dto 只校验形状，环境判断属于业务规则。
    if (input.payChannel === PAY_CHANNEL_FAKE && !fakeProviderAllowed()) {
      throw new BadRequestError('测试支付渠道仅在测试环境可用');
    }
    const plan = await prisma.membershipPlan.findUnique({ where: { code: input.planCode } });
    if (!plan || !plan.enabled) throw new NotFoundError('套餐', input.planCode);
    if (!isPurchasableTier(plan.tier)) throw new BadRequestError('该套餐不可购买');

    const user = (await prisma.user.findUnique({
      where: { id: userId },
      select: USER_MEMBERSHIP_SELECT,
    })) as UserMembershipRow | null;
    if (!user) throw new NotFoundError('用户', String(userId));

    const [rules, ctx] = await Promise.all([loadPricingRules(), buildPricingContext(user)]);
    const { result: pricing, referral } = await quote(plan, rules, ctx, userId);

    // 邀请返现优惠券：在规则折扣之后再抵扣。
    // 这里只校验与记录，券的状态到支付成功才改 —— 下单不付就把券作废，等于家长点一下「开通」
    // 就白丢一张券。真正的占用与释放见 payOrder / cancelOrder / releaseOrderCoupon。
    let couponCents = 0;
    let couponId: string | null = null;
    if (input.couponId) {
      // 一张券不能同时押在两笔待支付订单上：否则两笔都用它下单、都按抵扣后的价格付款，
      // 第一笔把它核销掉，第二笔就白拿了一次抵扣。
      const held = await prisma.membershipOrder.findFirst({
        where: { userId, couponId: input.couponId, status: 'pending' },
        select: { orderNo: true, planCode: true },
      });
      if (held) {
        throw new BadRequestError('该优惠券已用于另一笔待支付订单，请先完成或取消那笔订单');
      }
      const coupon = await referralService.quoteCoupon(userId, input.couponId);
      // 抵扣不超过订单金额：券面额比订单还大时只抵到 0，不产生「倒找钱」
      couponCents = Math.min(coupon.amountCents, pricing.finalCents);
      couponId = coupon.id;
    }
    const payableCents = Math.max(0, pricing.finalCents - couponCents);

    // 同一账号同一套餐的未支付订单只留一条：家长反复点「立即开通」不该堆出一串待支付单，
    // 否则订单列表会被自己的试探点击刷屏，对账时也分不清哪条是真的。
    const existing = await prisma.membershipOrder.findFirst({
      where: { userId, planCode: plan.code, status: 'pending' },
      orderBy: { createdAt: 'desc' },
    });
    if (existing) {
      // 换券/取消用券：原来占着的那张必须先放回去，否则它会被永久锁死在一张废单上
      if (existing.couponId && existing.couponId !== couponId) {
        await referralService.releaseCoupon(existing.couponId);
      }
      const updated = await prisma.membershipOrder.update({
        where: { id: existing.id },
        data: {
          originalCents: pricing.originalCents,
          amountCents: payableCents,
          referralRuleId: referral.applied ? referral.ruleId : null,
          referralRuleName: referral.applied ? referral.ruleName : '',
          referralSurchargeCents: referral.surchargeCents,
          adjustments: JSON.stringify(pricing.adjustments),
          couponId,
          couponCents,
          payChannel: input.payChannel,
        },
      });
      return { order: toOrderView(updated), plan: quoteOf(plan, pricing, referral), reused: true };
    }

    const created = await prisma.membershipOrder.create({
      data: {
        orderNo: generateOrderNo(),
        userId,
        planCode: plan.code,
        tier: plan.tier,
        period: plan.period,
        originalCents: pricing.originalCents,
        amountCents: payableCents,
        referralRuleId: referral.applied ? referral.ruleId : null,
        referralRuleName: referral.applied ? referral.ruleName : '',
        referralSurchargeCents: referral.surchargeCents,
        adjustments: JSON.stringify(pricing.adjustments),
        couponId,
        couponCents,
        payChannel: input.payChannel,
        status: 'pending',
        autoRenew: plan.period === 'auto_monthly',
      },
    });
    return { order: toOrderView(created), plan: quoteOf(plan, pricing, referral), reused: false };
  },

  /**
   * 模拟支付（规划 §5.4 之前的过渡路径）。
   *
   * `MEMBERSHIP_MOCK_PAY=true` 时家长端可以直接把订单标成成功，让整条
   * 「下单 → 支付 → 会员生效 → 返现」在没有商户号的情况下也能走通。
   * 真实渠道走 `features/payments` 的回调，但**两边的结算都调用同一个
   * `applyPaidOrder()`**，所以不存在「模拟能过、真渠道不过」的第二套逻辑。
   */
  async payOrder(userId: number, orderNo: string, outcome: 'success' | 'fail') {
    const order = await prisma.membershipOrder.findFirst({ where: { orderNo, userId } });
    if (!order) throw new NotFoundError('订单', orderNo);
    if (order.status === 'paid') throw new ConflictError('该订单已经支付过了');
    if (order.status !== 'pending') throw new ConflictError('该订单已结束，请重新下单');

    if (outcome === 'fail') {
      const failed = await prisma.membershipOrder.update({
        where: { id: order.id },
        data: { status: 'failed' },
      });
      return { order: toOrderView(failed), status: await resolveMembership(userId) };
    }

    // 结算逻辑只有一处（applyPaidOrder），真实渠道回调走的是同一个函数
    const settled = await applyPaidOrder({
      orderId: order.id,
      transactionId: mockTransactionId(order.orderNo, order.payChannel),
    });
    if (!settled.changed) throw new ConflictError('该订单已经支付过了');
    return { order: toOrderView(settled.order), status: await resolveMembership(userId) };
  },

  async cancelOrder(userId: number, orderNo: string) {
    const order = await prisma.membershipOrder.findFirst({ where: { orderNo, userId } });
    if (!order) throw new NotFoundError('订单', orderNo);
    if (order.status !== 'pending') throw new ConflictError('只有待支付的订单可以取消');
    const cancelled = await prisma.membershipOrder.update({
      where: { id: order.id },
      data: { status: 'cancelled' },
    });
    // 取消后把券放回未使用：占着不还，家长会以为券被吞了
    if (order.couponId) await referralService.releaseCoupon(order.couponId);
    return toOrderView(cancelled);
  },

  /** 关闭/开启连续包月。开启要求当前有生效中的付费档位。 */
  async setAutoRenew(userId: number, enabled: boolean) {
    const state = await resolveMembership(userId);
    if (enabled) {
      if (!state.active || state.tier === 'ordinary') {
        throw new BadRequestError('当前没有生效中的会员，开通连续包月请直接购买「连续包月」套餐');
      }
      await prisma.user.update({
        where: { id: userId },
        data: { membershipAutoRenew: true, membershipRenewTier: state.tier },
      });
    } else {
      await prisma.user.update({
        where: { id: userId },
        data: { membershipAutoRenew: false },
      });
    }
    return resolveMembership(userId);
  },

  async listOrders(userId: number, page: number, pageSize: number) {
    const [orders, total] = await Promise.all([
      prisma.membershipOrder.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.membershipOrder.count({ where: { userId } }),
    ]);
    return { orders: orders.map(toOrderView), total, page, pageSize };
  },

  /** 没有会员套餐数据时灌入默认套餐与规则（seed 与首次启动都用它）。 */
  async ensureDefaults(): Promise<{ plans: number; rules: number; referralRules: number }> {
    let plans = 0;
    for (const p of DEFAULT_PLANS) {
      await prisma.membershipPlan.upsert({
        where: { code: p.code },
        create: { ...p },
        update: {},
      });
      plans += 1;
    }
    let rules = 0;
    const existingRules = await prisma.membershipPricingRule.count();
    if (existingRules === 0) {
      await prisma.membershipPricingRule.createMany({ data: DEFAULT_PRICING_RULES.map((r) => ({ ...r })) });
      rules = DEFAULT_PRICING_RULES.length;
    }

    // 受邀定价规则同理：只在表为空时写入，绝不覆盖后台改过的值
    let referralRules = 0;
    const existingReferralRules = await prisma.membershipReferralPriceRule.count();
    if (existingReferralRules === 0) {
      await prisma.membershipReferralPriceRule.createMany({
        data: DEFAULT_REFERRAL_PRICE_RULES.map((r) => ({ ...r })),
      });
      referralRules = DEFAULT_REFERRAL_PRICE_RULES.length;
    }
    return { plans, rules, referralRules };
  },

  /**
   * 定时维护（server.ts 里每 6 小时一次）。
   *
   * 做两件事：
   *  1. 把超过 TTL 还没支付的订单标成 expired —— 不能让一张三天前的待支付订单
   *     今天还能按当时的价格成交（价格规则可能已经改了）。
   *  2. 给「已开启连续包月且快到期/已到期」的账号尝试续费。
   *
   * 第 2 条是模拟扣款：真实接入后这里换成「向渠道发起代扣」，
   * 扣款结果由渠道异步回调驱动（回调里调 applyPaidOrder 那一套逻辑）。
   * 现在直接当成功，因为失败路径没法从外部触发，测不了反而是假的。
   */
  async sweep(): Promise<{ orders: number; renewed: number; failed: number }> {
    const now = new Date();
    const deadline = new Date(now.getTime() - config.MEMBERSHIP_ORDER_TTL_SECONDS * 1000);
    // 先取出要作废的订单：updateMany 不返回受影响的行，而这些订单上可能还押着优惠券
    const stale = await prisma.membershipOrder.findMany({
      where: { status: 'pending', createdAt: { lt: deadline } },
      select: { id: true, couponId: true },
    });
    const expired = await prisma.membershipOrder.updateMany({
      where: { id: { in: stale.map((o) => o.id) } },
      data: { status: 'expired' },
    });
    for (const order of stale) {
      if (order.couponId) await referralService.releaseCoupon(order.couponId);
    }

    // 快到期（24 小时内）或已经过期、且开着连续包月的账号
    const soon = new Date(now.getTime() + 24 * 3600 * 1000);
    const due = (await prisma.user.findMany({
      where: {
        membershipAutoRenew: true,
        membershipTier: { in: ['member', 'super'] },
        membershipExpiresAt: { lte: soon },
      },
      select: USER_MEMBERSHIP_SELECT,
    })) as UserMembershipRow[];

    let renewed = 0;
    let failed = 0;
    for (const user of due) {
      try {
        const ok = await tryAutoRenew(user);
        if (ok) renewed += 1;
        else failed += 1;
      } catch {
        // 单账号失败不能影响其他账号；关掉自动续费避免每次扫描都重试
        await prisma.user.update({
          where: { id: user.id },
          data: { membershipAutoRenew: false },
        });
        failed += 1;
      }
    }
    return { orders: expired.count, renewed, failed };
  },
};
