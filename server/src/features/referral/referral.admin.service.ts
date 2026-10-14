/**
 * 分享提成 —— 后台运营接口。
 *
 * 这里只做「读统计 + 改规则 + 审提现」，不复制家长端那套返现计算：
 * 返现算多少由 referral.rules.ts 决定，后台的试算入口直接调它，
 * 避免出现「后台算出来的数」和「实际发的钱」两套口径。
 */

import { prisma } from '../../prisma';
import { BadRequestError, NotFoundError } from '../../errors';
import { referralService } from './referral.service';
import {
  COUPON_STATUS_LABELS,
  DEFAULT_CONFIG,
  REWARD_KIND_LABELS,
  REWARD_STATUS_LABELS,
  REFERRAL_STATUS_LABELS,
  WITHDRAW_CHANNEL_LABELS,
  WITHDRAWAL_STATUS_LABELS,
  type CouponStatus,
  type RewardKind,
  type RewardStatus,
} from './referral.constants';

function startOfDay(date: Date): Date {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

function dayKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function parseDate(value: unknown, label: string): Date | undefined {
  const raw = optionalString(value);
  if (!raw) return undefined;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) throw new BadRequestError(`${label}格式不正确`);
  return parsed;
}

/** 手机号打码：后台能看到「是谁」，但不该顺手把整份家长手机号导出去。 */
function maskPhone(phone: string | null | undefined): string {
  if (!phone) return '—';
  if (phone.length < 7) return phone;
  return `${phone.slice(0, 3)}****${phone.slice(-4)}`;
}

type UserBrief = { id: number; nickname: string | null; phone: string | null } | null;

function userLabel(user: UserBrief): string {
  if (!user) return '已注销';
  return `${user.nickname || '未命名'}（${maskPhone(user.phone)}）`;
}

const USER_BRIEF = { select: { id: true, nickname: true, phone: true } } as const;

// ============================================================
// 概览统计
// ============================================================

async function stats(days: number) {
  const now = new Date();
  const since = startOfDay(new Date(now.getTime() - (days - 1) * 24 * 3600 * 1000));

  const [
    referrals,
    rewards,
    coupons,
    withdrawals,
    config,
    tierCount,
    couponRuleCount,
    totalUsers,
    paidUsers,
  ] = await Promise.all([
    prisma.referral.findMany({
      select: { id: true, inviterId: true, inviteeId: true, status: true, boundAt: true, validAt: true },
    }),
    prisma.referralReward.findMany({
      select: {
        id: true,
        inviterId: true,
        kind: true,
        amountCents: true,
        baseAmountCents: true,
        status: true,
        createdAt: true,
        settledAt: true,
      },
    }),
    prisma.referralCoupon.findMany({ select: { id: true, status: true, amountCents: true, createdAt: true } }),
    prisma.referralWithdrawal.findMany({
      select: { id: true, status: true, amountCents: true, createdAt: true, paidAt: true },
    }),
    referralService.getConfig(),
    prisma.referralRewardTier.count({ where: { enabled: true } }),
    prisma.referralCouponRule.count({ where: { enabled: true } }),
    prisma.user.count(),
    prisma.user.count({ where: { firstPaidAt: { not: null } } }),
  ]);

  const sum = (rows: { amountCents: number }[]) => rows.reduce((acc, r) => acc + r.amountCents, 0);
  const live = rewards.filter((r) => r.status !== 'cancelled');

  const rewardTotals = {
    totalCents: sum(live),
    pendingCents: sum(live.filter((r) => r.status === 'pending')),
    settledCents: sum(live.filter((r) => r.status === 'settled')),
    cancelledCents: sum(rewards.filter((r) => r.status === 'cancelled')),
    firstPurchaseCents: sum(live.filter((r) => r.kind === 'first_purchase')),
    renewalCents: sum(live.filter((r) => r.kind === 'renewal')),
    count: live.length,
  };

  const withdrawalTotals = {
    pendingCents: sum(withdrawals.filter((w) => w.status === 'pending')),
    pendingCount: withdrawals.filter((w) => w.status === 'pending').length,
    approvedCents: sum(withdrawals.filter((w) => w.status === 'approved')),
    paidCents: sum(withdrawals.filter((w) => w.status === 'paid')),
    rejectedCents: sum(withdrawals.filter((w) => w.status === 'rejected')),
    paidCount: withdrawals.filter((w) => w.status === 'paid').length,
  };

  // 按天补齐：没有数据的那天也要出现 0，否则折线会把空档连成一条假斜线
  const series: { date: string; invited: number; valid: number; rewardCents: number }[] = [];
  const bucket = new Map<string, { invited: number; valid: number; rewardCents: number }>();
  for (let i = 0; i < days; i += 1) {
    const key = dayKey(new Date(since.getTime() + i * 24 * 3600 * 1000));
    bucket.set(key, { invited: 0, valid: 0, rewardCents: 0 });
    series.push({ date: key, invited: 0, valid: 0, rewardCents: 0 });
  }
  for (const r of referrals) {
    if (r.boundAt < since) continue;
    const b = bucket.get(dayKey(r.boundAt));
    if (b) b.invited += 1;
  }
  for (const r of referrals) {
    if (!r.validAt || r.validAt < since) continue;
    const b = bucket.get(dayKey(r.validAt));
    if (b) b.valid += 1;
  }
  for (const r of live) {
    if (r.createdAt < since) continue;
    const b = bucket.get(dayKey(r.createdAt));
    if (b) b.rewardCents += r.amountCents;
  }
  series.forEach((point) => {
    const b = bucket.get(point.date);
    if (b) {
      point.invited = b.invited;
      point.valid = b.valid;
      point.rewardCents = b.rewardCents;
    }
  });

  const byStatus = {
    bound: referrals.filter((r) => r.status === 'bound').length,
    valid: referrals.filter((r) => r.status === 'valid').length,
    invalid: referrals.filter((r) => r.status === 'invalid').length,
  };

  // 邀请达人榜：按累计返现额排，而不是按人数 —— 拉来 100 个不充值的不该排第一
  const perInviter = new Map<number, { count: number; validCount: number; amountCents: number }>();
  for (const r of referrals) {
    const entry = perInviter.get(r.inviterId) ?? { count: 0, validCount: 0, amountCents: 0 };
    entry.count += 1;
    if (r.status === 'valid') entry.validCount += 1;
    perInviter.set(r.inviterId, entry);
  }
  for (const r of live) {
    const entry = perInviter.get(r.inviterId);
    if (entry) entry.amountCents += r.amountCents;
  }
  const topIds = [...perInviter.entries()]
    .sort((a, b) => b[1].amountCents - a[1].amountCents || b[1].validCount - a[1].validCount)
    .slice(0, 10)
    .map(([id]) => id);
  const topUsers = topIds.length
    ? await prisma.user.findMany({ where: { id: { in: topIds } }, ...USER_BRIEF })
    : [];
  const userMap = new Map(topUsers.map((u) => [u.id, u]));
  const topInviters = topIds.map((id) => ({
    userId: id,
    label: userLabel(userMap.get(id) ?? null),
    count: perInviter.get(id)?.count ?? 0,
    validCount: perInviter.get(id)?.validCount ?? 0,
    amountCents: perInviter.get(id)?.amountCents ?? 0,
  }));

  const invitedInRange = referrals.filter((r) => r.boundAt >= since).length;
  const validInRange = referrals.filter((r) => r.validAt && r.validAt >= since).length;

  return {
    days,
    since: since.toISOString(),
    totals: {
      referrals: referrals.length,
      invitedInRange,
      validInRange,
      rewardTotals,
      withdrawalTotals,
      couponTotals: {
        issued: coupons.length,
        unused: coupons.filter((c) => c.status === 'unused').length,
        used: coupons.filter((c) => c.status === 'used').length,
        expired: coupons.filter((c) => c.status === 'expired').length,
        outstandingCents: sum(coupons.filter((c) => c.status === 'unused')),
      },
      totalUsers,
      paidUsers,
      /** 注册付费率：有付费行为的账号 / 全部账号。 */
      payConversion: totalUsers > 0 ? paidUsers / totalUsers : 0,
      /** 邀请转化率：邀请关系里最终产生有效充值的比例。 */
      inviteConversion: referrals.length > 0 ? byStatus.valid / referrals.length : 0,
    },
    byStatus,
    byRewardStatus: {
      pending: rewards.filter((r) => r.status === 'pending').length,
      settled: rewards.filter((r) => r.status === 'settled').length,
      cancelled: rewards.filter((r) => r.status === 'cancelled').length,
    },
    byWithdrawalStatus: {
      pending: withdrawalTotals.pendingCount,
      approved: withdrawals.filter((w) => w.status === 'approved').length,
      paid: withdrawalTotals.paidCount,
      rejected: withdrawals.filter((w) => w.status === 'rejected').length,
    },
    topInviters,
    series,
    config: {
      enabled: config.enabled,
      title: config.title,
      startedAt: config.startedAt.toISOString(),
      endsAt: config.endsAt ? config.endsAt.toISOString() : null,
      tierCount,
      couponRuleCount,
      withdrawMinInvitees: config.withdrawMinInvitees,
      withdrawMinCents: config.withdrawMinCents,
    },
  };
}

// ============================================================
// 列表
// ============================================================

async function listInvitees(query: {
  page: number;
  pageSize: number;
  q?: string;
  status?: string;
  from?: string;
  to?: string;
}) {
  const from = parseDate(query.from, '开始时间');
  const to = parseDate(query.to, '结束时间');
  const q = optionalString(query.q);

  const where: Record<string, unknown> = {};
  if (query.status) where.status = query.status;
  if (from || to) {
    where.boundAt = { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) };
  }
  if (q) {
    where.OR = [
      { code: { contains: q, mode: 'insensitive' } },
      { inviter: { is: { OR: [{ phone: { contains: q } }, { nickname: { contains: q } }, { inviteCode: q.toUpperCase() }] } } },
      { invitee: { is: { OR: [{ phone: { contains: q } }, { nickname: { contains: q } }] } } },
    ];
  }

  const [rows, total] = await Promise.all([
    prisma.referral.findMany({
      where,
      orderBy: { boundAt: 'desc' },
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
      include: { inviter: USER_BRIEF, invitee: USER_BRIEF },
    }),
    prisma.referral.count({ where }),
  ]);

  const ids = rows.map((r) => r.id);
  const rewardAgg = ids.length
    ? await prisma.referralReward.groupBy({
        by: ['inviteeId'],
        where: { inviteeId: { in: rows.map((r) => r.inviteeId) }, status: { not: 'cancelled' } },
        _sum: { amountCents: true },
        _count: true,
      })
    : [];
  const rewardMap = new Map(rewardAgg.map((a) => [a.inviteeId, a]));

  return {
    items: rows.map((r) => ({
      id: r.id,
      code: r.code,
      status: r.status,
      statusLabel: REFERRAL_STATUS_LABELS[r.status as keyof typeof REFERRAL_STATUS_LABELS] ?? r.status,
      invalidReason: r.invalidReason,
      inviterId: r.inviterId,
      inviterLabel: userLabel(r.inviter),
      inviteeId: r.inviteeId,
      inviteeLabel: userLabel(r.invitee),
      rewardCount: rewardMap.get(r.inviteeId)?._count ?? 0,
      rewardCents: rewardMap.get(r.inviteeId)?._sum.amountCents ?? 0,
      boundAt: r.boundAt.toISOString(),
      validAt: r.validAt ? r.validAt.toISOString() : null,
    })),
    total,
    page: query.page,
    pageSize: query.pageSize,
  };
}

async function listRewards(query: {
  page: number;
  pageSize: number;
  q?: string;
  status?: string;
  kind?: string;
  from?: string;
  to?: string;
}) {
  const from = parseDate(query.from, '开始时间');
  const to = parseDate(query.to, '结束时间');
  const q = optionalString(query.q);

  const where: Record<string, unknown> = {};
  if (query.status) where.status = query.status;
  if (query.kind) where.kind = query.kind;
  if (from || to) {
    where.createdAt = { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) };
  }
  if (q) {
    where.OR = [
      { rewardNo: { contains: q, mode: 'insensitive' } },
      { orderNo: { contains: q, mode: 'insensitive' } },
      { inviter: { is: { OR: [{ phone: { contains: q } }, { nickname: { contains: q } }] } } },
      { invitee: { is: { OR: [{ phone: { contains: q } }, { nickname: { contains: q } }] } } },
    ];
  }

  const [rows, total, agg] = await Promise.all([
    prisma.referralReward.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
      include: { inviter: USER_BRIEF, invitee: USER_BRIEF },
    }),
    prisma.referralReward.count({ where }),
    prisma.referralReward.groupBy({ by: ['status'], where, _sum: { amountCents: true }, _count: true }),
  ]);

  return {
    items: rows.map((r) => ({
      id: r.id,
      rewardNo: r.rewardNo,
      inviterLabel: userLabel(r.inviter),
      inviteeLabel: userLabel(r.invitee),
      orderNo: r.orderNo,
      kind: r.kind,
      kindLabel: REWARD_KIND_LABELS[r.kind as RewardKind] ?? r.kind,
      baseAmountCents: r.baseAmountCents,
      ratePercent: r.ratePercent,
      amountCents: r.amountCents,
      capApplied: r.capApplied,
      status: r.status,
      statusLabel: REWARD_STATUS_LABELS[r.status as RewardStatus] ?? r.status,
      settleMonth: r.settleMonth,
      settledAt: r.settledAt ? r.settledAt.toISOString() : null,
      cancelReason: r.cancelReason,
      createdAt: r.createdAt.toISOString(),
    })),
    total,
    page: query.page,
    pageSize: query.pageSize,
    summary: {
      statusCounts: Object.fromEntries(
        agg.map((a) => [a.status, { count: a._count, amountCents: a._sum.amountCents ?? 0 }]),
      ),
    },
  };
}

async function listCoupons(query: { page: number; pageSize: number; q?: string; status?: string }) {
  const q = optionalString(query.q);
  const where: Record<string, unknown> = {};
  if (query.status) where.status = query.status;
  if (q) {
    where.OR = [
      { sourceRef: { contains: q, mode: 'insensitive' } },
      { user: { is: { OR: [{ phone: { contains: q } }, { nickname: { contains: q } }] } } },
    ];
  }

  const [rows, total, agg] = await Promise.all([
    prisma.referralCoupon.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
      include: { user: USER_BRIEF },
    }),
    prisma.referralCoupon.count({ where }),
    prisma.referralCoupon.groupBy({ by: ['status'], where, _sum: { amountCents: true }, _count: true }),
  ]);

  return {
    items: rows.map((c) => ({
      id: c.id,
      userLabel: userLabel(c.user),
      amountCents: c.amountCents,
      source: c.source,
      status: c.status,
      statusLabel: COUPON_STATUS_LABELS[c.status as CouponStatus] ?? c.status,
      expiresAt: c.expiresAt ? c.expiresAt.toISOString() : null,
      usedAt: c.usedAt ? c.usedAt.toISOString() : null,
      usedOrderNo: c.usedOrderNo,
      createdAt: c.createdAt.toISOString(),
    })),
    total,
    page: query.page,
    pageSize: query.pageSize,
    summary: {
      statusCounts: Object.fromEntries(
        agg.map((a) => [a.status, { count: a._count, amountCents: a._sum.amountCents ?? 0 }]),
      ),
    },
  };
}

async function listWithdrawals(query: {
  page: number;
  pageSize: number;
  q?: string;
  status?: string;
  channel?: string;
  from?: string;
  to?: string;
}) {
  const from = parseDate(query.from, '开始时间');
  const to = parseDate(query.to, '结束时间');
  const q = optionalString(query.q);

  const where: Record<string, unknown> = {};
  if (query.status) where.status = query.status;
  if (query.channel) where.channel = query.channel;
  if (from || to) {
    where.createdAt = { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) };
  }
  if (q) {
    where.OR = [
      { withdrawNo: { contains: q, mode: 'insensitive' } },
      { realName: { contains: q } },
      { account: { contains: q } },
      { user: { is: { OR: [{ phone: { contains: q } }, { nickname: { contains: q } }] } } },
    ];
  }

  const [rows, total, agg] = await Promise.all([
    prisma.referralWithdrawal.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
      include: { user: USER_BRIEF },
    }),
    prisma.referralWithdrawal.count({ where }),
    prisma.referralWithdrawal.groupBy({ by: ['status'], where, _sum: { amountCents: true }, _count: true }),
  ]);

  return {
    items: rows.map((w) => ({
      id: w.id,
      withdrawNo: w.withdrawNo,
      userLabel: userLabel(w.user),
      amountCents: w.amountCents,
      status: w.status,
      statusLabel: WITHDRAWAL_STATUS_LABELS[w.status as keyof typeof WITHDRAWAL_STATUS_LABELS] ?? w.status,
      realName: w.realName,
      idCardTail: w.idCardTail,
      channel: w.channel,
      channelLabel: WITHDRAW_CHANNEL_LABELS[w.channel as keyof typeof WITHDRAW_CHANNEL_LABELS] ?? w.channel,
      account: w.account,
      userNote: w.userNote,
      reviewNote: w.reviewNote,
      reviewedAt: w.reviewedAt ? w.reviewedAt.toISOString() : null,
      paidAt: w.paidAt ? w.paidAt.toISOString() : null,
      createdAt: w.createdAt.toISOString(),
    })),
    total,
    page: query.page,
    pageSize: query.pageSize,
    summary: {
      statusCounts: Object.fromEntries(
        agg.map((a) => [a.status, { count: a._count, amountCents: a._sum.amountCents ?? 0 }]),
      ),
    },
  };
}

/**
 * 提现审核。
 *
 * 状态机是单向的：pending → approved → paid，或 pending → rejected。
 * 已打款的单子不允许再改（钱已经出去了，改状态只会让账对不上）。
 */
async function reviewWithdrawal(
  id: string,
  input: { action: 'approve' | 'reject' | 'pay'; note?: string },
  adminId: number,
) {
  const row = await prisma.referralWithdrawal.findUnique({ where: { id } });
  if (!row) throw new NotFoundError('提现申请', id);

  if (input.action === 'approve') {
    if (row.status !== 'pending') throw new BadRequestError('只有待审核的申请可以通过');
  } else if (input.action === 'reject') {
    if (row.status !== 'pending') throw new BadRequestError('只有待审核的申请可以驳回');
  } else if (row.status !== 'approved') {
    throw new BadRequestError('只有已通过的申请可以标记打款');
  }

  const status = input.action === 'approve' ? 'approved' : input.action === 'reject' ? 'rejected' : 'paid';

  const updated = await prisma.referralWithdrawal.update({
    where: { id },
    data: {
      status,
      reviewNote: input.note ?? '',
      reviewedBy: adminId,
      reviewedAt: new Date(),
      paidAt: status === 'paid' ? new Date() : row.paidAt,
    },
    include: { user: USER_BRIEF },
  });

  return {
    id: updated.id,
    withdrawNo: updated.withdrawNo,
    userLabel: userLabel(updated.user),
    amountCents: updated.amountCents,
    status: updated.status,
    statusLabel: WITHDRAWAL_STATUS_LABELS[updated.status as keyof typeof WITHDRAWAL_STATUS_LABELS] ?? updated.status,
    reviewNote: updated.reviewNote,
    reviewedAt: updated.reviewedAt ? updated.reviewedAt.toISOString() : null,
    paidAt: updated.paidAt ? updated.paidAt.toISOString() : null,
  };
}

// ============================================================
// 规则与活动配置
// ============================================================

async function getRules() {
  const config = await referralService.getConfig();
  const [tiers, couponRules] = await Promise.all([
    prisma.referralRewardTier.findMany({ orderBy: [{ sortOrder: 'asc' }, { minInvitees: 'asc' }] }),
    prisma.referralCouponRule.findMany({ orderBy: [{ sortOrder: 'asc' }, { inviteeCount: 'asc' }] }),
  ]);

  return {
    tiers: tiers.map((t) => ({
      id: t.id,
      minInvitees: t.minInvitees,
      maxInvitees: t.maxInvitees,
      ratePercent: t.ratePercent,
      sortOrder: t.sortOrder,
      enabled: t.enabled,
      label: t.maxInvitees === null ? `${t.minInvitees} 名及以上` : `${t.minInvitees} - ${t.maxInvitees} 名`,
    })),
    couponRules: couponRules.map((c) => ({
      id: c.id,
      name: c.name,
      inviteeCount: c.inviteeCount,
      repeatEvery: c.repeatEvery,
      amountCents: c.amountCents,
      validDays: c.validDays,
      sortOrder: c.sortOrder,
      enabled: c.enabled,
    })),
    shortPeriodMinRatePercent: config.shortPeriodMinRatePercent,
    longPeriodCapCents: config.longPeriodCapCents,
    renewalRatePercent: config.renewalRatePercent,
    renewalCapCents: config.renewalCapCents,
  };
}

/** 整表替换：先删后建。阶梯表很小（个位数），不值得为它写增量同步。 */
async function updateRules(input: {
  tiers: { minInvitees: number; maxInvitees?: number | null; ratePercent: number }[];
  couponRules: {
    name: string;
    inviteeCount: number;
    repeatEvery?: number | null;
    amountCents: number;
    validDays: number;
  }[];
  shortPeriodMinRatePercent: number;
  longPeriodCapCents: number;
  renewalRatePercent: number;
  renewalCapCents: number;
}) {
  const sorted = [...input.tiers].sort((a, b) => a.minInvitees - b.minInvitees);

  await referralService.getConfig(); // 确保配置行存在
  await prisma.$transaction([
    prisma.referralRewardTier.deleteMany({}),
    prisma.referralCouponRule.deleteMany({}),
    prisma.referralRewardTier.createMany({
      data: sorted.map((t, index) => ({
        minInvitees: t.minInvitees,
        maxInvitees: t.maxInvitees ?? null,
        ratePercent: t.ratePercent,
        sortOrder: index,
        enabled: true,
      })),
    }),
    prisma.referralCouponRule.createMany({
      data: input.couponRules.map((c, index) => ({
        name: c.name,
        inviteeCount: c.inviteeCount,
        repeatEvery: c.repeatEvery ?? null,
        amountCents: c.amountCents,
        validDays: c.validDays,
        sortOrder: index,
        enabled: true,
      })),
    }),
    prisma.referralConfig.update({
      where: { id: 'default' },
      data: {
        shortPeriodMinRatePercent: input.shortPeriodMinRatePercent,
        longPeriodCapCents: input.longPeriodCapCents,
        renewalRatePercent: input.renewalRatePercent,
        renewalCapCents: input.renewalCapCents,
      },
    }),
  ]);

  return getRules();
}

async function getConfigView() {
  const row = await referralService.getConfig();
  return {
    title: row.title,
    subtitle: row.subtitle,
    enabled: row.enabled,
    notice: row.notice ? row.notice.split('\n').filter((line) => line.trim()) : [...DEFAULT_CONFIG.notice.split('\n')],
    startedAt: row.startedAt.toISOString(),
    endsAt: row.endsAt ? row.endsAt.toISOString() : null,
    withdrawMinInvitees: row.withdrawMinInvitees,
    withdrawMinCents: row.withdrawMinCents,
    withdrawRequireVerified: row.withdrawRequireVerified,
    settleDayStart: row.settleDayStart,
    settleDayEnd: row.settleDayEnd,
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function updateConfig(input: {
  title: string;
  subtitle: string;
  enabled: boolean;
  notice: string[];
  startedAt?: string | null;
  endsAt?: string | null;
  withdrawMinInvitees: number;
  withdrawMinCents: number;
  withdrawRequireVerified: boolean;
  settleDayStart: number;
  settleDayEnd: number;
}) {
  if (input.settleDayEnd < input.settleDayStart) {
    throw new BadRequestError('结算结束日不能早于开始日');
  }
  const startedAt = parseDate(input.startedAt, '活动开始时间');
  const endsAt = parseDate(input.endsAt, '活动结束时间');
  if (startedAt && endsAt && endsAt <= startedAt) {
    throw new BadRequestError('活动结束时间必须晚于开始时间');
  }

  await referralService.getConfig();
  await prisma.referralConfig.update({
    where: { id: 'default' },
    data: {
      title: input.title,
      subtitle: input.subtitle,
      enabled: input.enabled,
      notice: input.notice.join('\n'),
      ...(startedAt ? { startedAt } : {}),
      endsAt: endsAt ?? null,
      withdrawMinInvitees: input.withdrawMinInvitees,
      withdrawMinCents: input.withdrawMinCents,
      withdrawRequireVerified: input.withdrawRequireVerified,
      settleDayStart: input.settleDayStart,
      settleDayEnd: input.settleDayEnd,
    },
  });
  return getConfigView();
}

// ============================================================
// 风控
// ============================================================

/**
 * 反作弊（截图第 7 条）。
 *
 * 这些检查只做「列出来给人看」，不做自动处罚 —— 真实场景里误伤一个正常家长的代价
 * 远大于漏掉一个刷单的，最终判断必须由人工做出。
 */
async function risk(days: number) {
  const since = startOfDay(new Date(Date.now() - (days - 1) * 24 * 3600 * 1000));

  const referrals = await prisma.referral.findMany({
    where: { boundAt: { gte: since } },
    include: {
      inviter: { select: { id: true, nickname: true, phone: true, idCardHash: true } },
      invitee: { select: { id: true, nickname: true, phone: true, idCardHash: true, createdAt: true } },
    },
    orderBy: { boundAt: 'desc' },
    take: 2000,
  });

  const findings: {
    type: string;
    level: 'high' | 'medium';
    title: string;
    detail: string;
    userIds: number[];
    at: string;
  }[] = [];

  for (const r of referrals) {
    // 1. 自我邀请：同一个手机号自己邀请自己
    if (r.inviter.phone && r.inviter.phone === r.invitee.phone) {
      findings.push({
        type: 'self_invite',
        level: 'high',
        title: '疑似自我邀请',
        detail: `邀请人与被邀请人手机号相同：${maskPhone(r.inviter.phone)}`,
        userIds: [r.inviter.id, r.invitee.id],
        at: r.boundAt.toISOString(),
      });
    }
    // 2. 同一实名证件被多个账号使用：这是提现套现最常见的形态
    if (r.inviter.idCardHash && r.inviter.idCardHash === r.invitee.idCardHash) {
      findings.push({
        type: 'same_identity',
        level: 'high',
        title: '邀请双方共用同一实名证件',
        detail: `${userLabel(r.inviter)} 与 ${userLabel(r.invitee)} 的实名证件一致`,
        userIds: [r.inviter.id, r.invitee.id],
        at: r.boundAt.toISOString(),
      });
    }
  }

  // 3. 同一邀请人在极短时间内集中绑定：正常邀请不会一分钟来五个
  const byInviter = new Map<number, typeof referrals>();
  for (const r of referrals) {
    const list = byInviter.get(r.inviterId) ?? [];
    list.push(r);
    byInviter.set(r.inviterId, list);
  }
  for (const [inviterId, list] of byInviter) {
    const sorted = [...list].sort((a, b) => a.boundAt.getTime() - b.boundAt.getTime());
    for (let i = 0; i + 4 < sorted.length; i += 1) {
      const span = sorted[i + 4].boundAt.getTime() - sorted[i].boundAt.getTime();
      if (span <= 60 * 60 * 1000) {
        findings.push({
          type: 'burst_invite',
          level: 'medium',
          title: '短时间内集中绑定',
          detail: `${userLabel(sorted[i].inviter)} 在 1 小时内绑定了 5 名以上新用户`,
          userIds: [inviterId],
          at: sorted[i].boundAt.toISOString(),
        });
        break;
      }
    }
  }

  // 4. 提现积压：待审核超过 3 天，家长会以为平台赖账
  const staleDate = new Date(Date.now() - 3 * 24 * 3600 * 1000);
  const staleWithdrawals = await prisma.referralWithdrawal.findMany({
    where: { status: 'pending', createdAt: { lt: staleDate } },
    include: { user: USER_BRIEF },
    orderBy: { createdAt: 'asc' },
  });
  for (const w of staleWithdrawals) {
    findings.push({
      type: 'stale_withdrawal',
      level: 'medium',
      title: '提现申请超过 3 天未审核',
      detail: `${userLabel(w.user)} 申请提现 ${(w.amountCents / 100).toFixed(2)} 元，等待中`,
      userIds: [w.userId],
      at: w.createdAt.toISOString(),
    });
  }

  return {
    days,
    since: since.toISOString(),
    scanned: referrals.length,
    high: findings.filter((f) => f.level === 'high').length,
    medium: findings.filter((f) => f.level === 'medium').length,
    findings: findings.sort((a, b) => (a.level === b.level ? 0 : a.level === 'high' ? -1 : 1)),
  };
}

export const referralAdminService = {
  stats,
  listInvitees,
  listRewards,
  listCoupons,
  listWithdrawals,
  reviewWithdrawal,
  getRules,
  updateRules,
  getConfigView,
  updateConfig,
  risk,
};
