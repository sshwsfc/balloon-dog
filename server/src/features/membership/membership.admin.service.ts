import { Prisma } from '@prisma/client';
import { prisma } from '../../prisma';
import { BadRequestError, ConflictError, NotFoundError } from '../../errors';
import { parsePagination } from '../../shared/deviceScope';
import { priceWithReferral, type PricingContext, type ReferralPricingContext } from './membership.pricing';
import {
  BILLING_PERIODS,
  DISCOUNT_TYPE_LABELS,
  ORDER_STATUSES,
  PAY_CHANNEL_LABELS,
  PERIOD_LABELS,
  REFERRAL_PRICE_TYPE_LABELS,
  RULE_CONDITION_LABELS,
  TIER_LABELS,
  type BillingPeriod,
  type MembershipTier,
} from './membership.constants';

/**
 * 后台会员管理。
 *
 * 与家长端的 membership.service.ts 分开：那个文件只关心「当前登录家长自己的
 * 会员状态与下单」，这里关心「所有套餐、所有规则、所有人的订单」。
 * 两者唯一的交集是 Prisma 模型，不需要共享代码。
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** 把 Date 收敛到当天 0 点，用来按天分桶。 */
function startOfDay(value: Date): Date {
  const d = new Date(value);
  d.setHours(0, 0, 0, 0);
  return d;
}

function dayKey(value: Date): string {
  const d = startOfDay(value);
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${month}-${day}`;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function parseDate(value: unknown, label: string): Date | undefined {
  const raw = optionalString(value);
  if (!raw) return undefined;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) throw new BadRequestError(`${label}不是合法日期`);
  return parsed;
}

/** 套餐的对外视图：把需要联动展示的标签一次算好，前端不用再查表。 */
function planView(plan: {
  id: string;
  code: string;
  tier: string;
  period: string;
  name: string;
  description: string;
  basePriceCents: number;
  months: number;
  recommended: boolean;
  sortOrder: number;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}, orderCount = 0) {
  return {
    id: plan.id,
    code: plan.code,
    tier: plan.tier,
    tierLabel: TIER_LABELS[plan.tier as keyof typeof TIER_LABELS] ?? plan.tier,
    period: plan.period,
    periodLabel: PERIOD_LABELS[plan.period as keyof typeof PERIOD_LABELS] ?? plan.period,
    name: plan.name,
    description: plan.description,
    basePriceCents: plan.basePriceCents,
    months: plan.months,
    recommended: plan.recommended,
    sortOrder: plan.sortOrder,
    enabled: plan.enabled,
    orderCount,
    createdAt: plan.createdAt,
    updatedAt: plan.updatedAt,
  };
}

function ruleView(rule: {
  id: string;
  name: string;
  conditionType: string;
  conditionMinDevices: number | null;
  conditionDays: number | null;
  conditionFromTier: string | null;
  targetTier: string;
  targetPeriod: string;
  discountType: string;
  discountValue: number;
  stackable: boolean;
  priority: number;
  enabled: boolean;
  note: string;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    ...rule,
    conditionLabel:
      RULE_CONDITION_LABELS[rule.conditionType as keyof typeof RULE_CONDITION_LABELS] ??
      rule.conditionType,
    discountTypeLabel:
      DISCOUNT_TYPE_LABELS[rule.discountType as keyof typeof DISCOUNT_TYPE_LABELS] ??
      rule.discountType,
    // 一句话把条件参数说清：后台列表里光看 conditionType 不知道阈值是多少
    conditionSummary: (() => {
      switch (rule.conditionType) {
        case 'device_count':
          return `绑定设备数 ≥ ${rule.conditionMinDevices ?? '?'}`;
        case 'registered_within_days':
          return `注册 ≤ ${rule.conditionDays ?? '?'} 天`;
        case 'tier_upgrade':
          return `由「${
            rule.conditionFromTier
              ? (TIER_LABELS[rule.conditionFromTier as keyof typeof TIER_LABELS] ??
                rule.conditionFromTier)
              : '?'
          }」升级`;
        default:
          return RULE_CONDITION_LABELS[rule.conditionType as keyof typeof RULE_CONDITION_LABELS] ?? '';
      }
    })(),
    discountSummary:
      rule.discountType === 'percent'
        ? `减 ${rule.discountValue}%`
        : `减 ￥${(rule.discountValue / 100).toFixed(2)}`,
  };
}

/** 规则是否具备全部必需参数（用来标出历史脏数据，而不是悄悄跳过）。 */
function ruleIsComplete(rule: {
  conditionType: string;
  conditionMinDevices: number | null;
  conditionDays: number | null;
  conditionFromTier: string | null;
}): boolean {
  if (rule.conditionType === 'device_count') return Boolean(rule.conditionMinDevices);
  if (rule.conditionType === 'registered_within_days') return Boolean(rule.conditionDays);
  if (rule.conditionType === 'tier_upgrade') return Boolean(rule.conditionFromTier);
  return true;
}

/**
 * 受邀用户定价规则的视图。
 *
 * `impact` 是给运营看的一句话：这条规则命中时到底减多少 —— 后台列表里只有
 * `discountType: 'percent', discountValue: 10` 时，没人一眼看得出是「9 折」还是「减 10 分」。
 */
function referralPriceRuleView(rule: {
  id: string;
  name: string;
  targetTier: string;
  targetPeriod: string;
  priceType: string;
  priceValue: number;
  firstPurchaseOnly: boolean;
  requireActiveReferral: boolean;
  priority: number;
  enabled: boolean;
  note: string;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    ...rule,
    priceTypeLabel:
      REFERRAL_PRICE_TYPE_LABELS[rule.priceType as keyof typeof REFERRAL_PRICE_TYPE_LABELS] ??
      rule.priceType,
    targetTierLabel: rule.targetTier === 'all' ? '全部档位' : (TIER_LABELS[rule.targetTier as keyof typeof TIER_LABELS] ?? rule.targetTier),
    targetPeriodLabel:
      rule.targetPeriod === 'all'
        ? '全部周期'
        : (PERIOD_LABELS[rule.targetPeriod as BillingPeriod] ?? rule.targetPeriod),
    scopeSummary: [
      rule.firstPurchaseOnly ? '仅首单' : '含续费',
      rule.requireActiveReferral ? '邀请关系有效' : '关系已作废也上浮',
    ].join(' · '),
    impact: describeReferralPrice(rule.priceType, rule.priceValue),
  };
}

/** 把「方式 + 数值」翻译成一句人话（规则列表与试算结果共用）。 */
function describeReferralPrice(priceType: string, priceValue: number): string {
  switch (priceType) {
    case 'percent':
      // 50 → 1.5 倍；12.5 → 1.125 倍，保留三位小数再抹掉末尾的 0 就够读
      return `常规定价 × ${((100 + priceValue) / 100).toFixed(3).replace(/0+$/, '').replace(/\.$/, '')}（上浮 ${priceValue}%）`;
    case 'amount':
      return `常规定价 + ￥${(priceValue / 100).toFixed(2)}`;
    case 'fixed':
      return `一口价 ￥${(priceValue / 100).toFixed(2)}（低于常规价时不生效）`;
    default:
      return priceType;
  }
}

export const membershipAdminService = {
  // ==========================================================
  // 套餐
  // ==========================================================

  async listPlans(query: Record<string, unknown>) {
    const { page, pageSize, skip, take } = parsePagination(query, 20);
    const tier = optionalString(query.tier);

    const where: Prisma.MembershipPlanWhereInput = tier ? { tier } : {};

    const [total, rows] = await Promise.all([
      prisma.membershipPlan.count({ where }),
      prisma.membershipPlan.findMany({
        where,
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
        skip,
        take,
      }),
    ]);

    /*
      订单数用一次 groupBy 批量取，而不是给 MembershipPlan 加 `orders` 关系：
      MembershipOrder 存的是 planCode 快照（套餐可以改价改名，订单要保留下单时的事实），
      为它加外键反而会让「删套餐」被数据库挡住、又和「停用」的语义打架。
    */
    const orderCounts = rows.length
      ? await prisma.membershipOrder.groupBy({
          by: ['planCode'],
          where: { planCode: { in: rows.map((r) => r.code) } },
          _count: { _all: true },
        })
      : [];
    const orderCountOf = (code: string) =>
      orderCounts.find((o) => o.planCode === code)?._count._all ?? 0;

    return {
      page,
      pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
      items: rows.map((row) => planView(row, orderCountOf(row.code))),
      // 档位 × 周期的覆盖情况：后台一眼能看出「超级会员还缺连续包月」这种缺口
      coverage: BILLING_PERIODS.map((period) => ({
        period,
        periodLabel: PERIOD_LABELS[period],
        member: rows.some((r) => r.tier === 'member' && r.period === period && r.enabled),
        super: rows.some((r) => r.tier === 'super' && r.period === period && r.enabled),
      })),
    };
  },

  async createPlan(input: Record<string, unknown>) {
    const tier = String(input.tier);
    const period = String(input.period);
    const code = optionalString(input.code) ?? `${tier}_${period}`;

    const exists = await prisma.membershipPlan.findUnique({ where: { code } });
    if (exists) throw new ConflictError(`套餐编码「${code}」已存在`);

    const plan = await prisma.membershipPlan.create({
      data: {
        code,
        tier,
        period,
        name: String(input.name),
        description: optionalString(input.description) ?? '',
        basePriceCents: Number(input.basePriceCents),
        months: Number(input.months ?? (period === 'yearly' ? 12 : 1)),
        recommended: Boolean(input.recommended),
        sortOrder: Number(input.sortOrder ?? 0),
        enabled: input.enabled === undefined ? true : Boolean(input.enabled),
      },
    });
    return planView(plan);
  },

  async updatePlan(id: string, input: Record<string, unknown>) {
    const existing = await prisma.membershipPlan.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError('套餐', id);

    const plan = await prisma.membershipPlan.update({
      where: { id },
      data: {
        ...(input.name !== undefined ? { name: String(input.name) } : {}),
        ...(input.description !== undefined
          ? { description: optionalString(input.description) ?? '' }
          : {}),
        ...(input.basePriceCents !== undefined
          ? { basePriceCents: Number(input.basePriceCents) }
          : {}),
        ...(input.recommended !== undefined ? { recommended: Boolean(input.recommended) } : {}),
        ...(input.sortOrder !== undefined ? { sortOrder: Number(input.sortOrder) } : {}),
        ...(input.enabled !== undefined ? { enabled: Boolean(input.enabled) } : {}),
      },
    });
    const orderCount = await prisma.membershipOrder.count({ where: { planCode: plan.code } });
    return planView(plan, orderCount);
  },

  /**
   * 删除套餐。
   *
   * 已经有订单引用时**不删**：订单要能回溯「当时买的是什么」，
   * 把套餐删掉会让历史订单里的 planCode 变成一个查不到的东西。
   * 这种情况让管理员改成「停用」，家长端立刻看不到，历史还在。
   */
  async removePlan(id: string) {
    const plan = await prisma.membershipPlan.findUnique({ where: { id } });
    if (!plan) throw new NotFoundError('套餐', id);
    const orderCount = await prisma.membershipOrder.count({ where: { planCode: plan.code } });
    if (orderCount > 0) {
      throw new ConflictError(
        `「${plan.name}」已有 ${orderCount} 笔订单，不能删除；请改成「停用」`,
      );
    }
    await prisma.membershipPlan.delete({ where: { id } });
    return { success: true, id };
  },

  // ==========================================================
  // 定价规则
  // ==========================================================

  async listRules(query: Record<string, unknown>) {
    const { page, pageSize, skip, take } = parsePagination(query, 20);
    const enabledRaw = optionalString(query.enabled);
    const conditionType = optionalString(query.conditionType);

    const where: Prisma.MembershipPricingRuleWhereInput = {
      ...(enabledRaw ? { enabled: enabledRaw === 'true' } : {}),
      ...(conditionType ? { conditionType } : {}),
    };

    const [total, rows] = await Promise.all([
      prisma.membershipPricingRule.count({ where }),
      prisma.membershipPricingRule.findMany({
        where,
        orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
        skip,
        take,
      }),
    ]);

    return {
      page,
      pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
      items: rows.map((rule) => ({ ...ruleView(rule), complete: ruleIsComplete(rule) })),
      // 配了规则却启用中、参数又不全的，直接报出来 —— 它们在引擎里是永不命中
      incompleteCount: rows.filter((r) => r.enabled && !ruleIsComplete(r)).length,
    };
  },

  async createRule(input: Record<string, unknown>) {
    const rule = await prisma.membershipPricingRule.create({
      data: {
        name: String(input.name),
        conditionType: String(input.conditionType),
        conditionMinDevices: input.conditionMinDevices == null ? null : Number(input.conditionMinDevices),
        conditionDays: input.conditionDays == null ? null : Number(input.conditionDays),
        conditionFromTier: input.conditionFromTier == null ? null : String(input.conditionFromTier),
        targetTier: optionalString(input.targetTier) ?? 'all',
        targetPeriod: optionalString(input.targetPeriod) ?? 'all',
        discountType: String(input.discountType),
        discountValue: Number(input.discountValue),
        stackable: Boolean(input.stackable),
        priority: Number(input.priority ?? 0),
        enabled: input.enabled === undefined ? true : Boolean(input.enabled),
        note: optionalString(input.note) ?? '',
      },
    });
    return ruleView(rule);
  },

  async updateRule(id: string, input: Record<string, unknown>) {
    const existing = await prisma.membershipPricingRule.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError('定价规则', id);

    /*
      合并后的规则必须仍然「参数齐全」。
      只校验请求体是不够的：把一条 device_count 规则改成 registered_within_days
      时请求体里没有 conditionDays，只校验入参会放过它。
    */
    const merged = {
      conditionType: input.conditionType !== undefined ? String(input.conditionType) : existing.conditionType,
      conditionMinDevices:
        input.conditionMinDevices !== undefined
          ? input.conditionMinDevices == null
            ? null
            : Number(input.conditionMinDevices)
          : existing.conditionMinDevices,
      conditionDays:
        input.conditionDays !== undefined
          ? input.conditionDays == null
            ? null
            : Number(input.conditionDays)
          : existing.conditionDays,
      conditionFromTier:
        input.conditionFromTier !== undefined
          ? input.conditionFromTier == null
            ? null
            : String(input.conditionFromTier)
          : existing.conditionFromTier,
    };
    if (!ruleIsComplete(merged)) {
      throw new BadRequestError('该条件缺少必要参数，请补齐阈值后再保存');
    }
    if (
      (input.discountType ?? existing.discountType) === 'percent' &&
      Number(input.discountValue ?? existing.discountValue) > 100
    ) {
      throw new BadRequestError('按比例减的百分比不能超过 100');
    }

    const rule = await prisma.membershipPricingRule.update({
      where: { id },
      data: {
        ...(input.name !== undefined ? { name: String(input.name) } : {}),
        ...(input.conditionType !== undefined ? { conditionType: merged.conditionType } : {}),
        ...(input.conditionMinDevices !== undefined
          ? { conditionMinDevices: merged.conditionMinDevices }
          : {}),
        ...(input.conditionDays !== undefined ? { conditionDays: merged.conditionDays } : {}),
        ...(input.conditionFromTier !== undefined
          ? { conditionFromTier: merged.conditionFromTier }
          : {}),
        ...(input.targetTier !== undefined ? { targetTier: String(input.targetTier) } : {}),
        ...(input.targetPeriod !== undefined ? { targetPeriod: String(input.targetPeriod) } : {}),
        ...(input.discountType !== undefined ? { discountType: String(input.discountType) } : {}),
        ...(input.discountValue !== undefined
          ? { discountValue: Number(input.discountValue) }
          : {}),
        ...(input.stackable !== undefined ? { stackable: Boolean(input.stackable) } : {}),
        ...(input.priority !== undefined ? { priority: Number(input.priority) } : {}),
        ...(input.enabled !== undefined ? { enabled: Boolean(input.enabled) } : {}),
        ...(input.note !== undefined ? { note: optionalString(input.note) ?? '' } : {}),
      },
    });
    return ruleView(rule);
  },

  /** 规则和订单之间没有外键，删掉不会破坏历史订单（订单里存的是规则快照）。 */
  async removeRule(id: string) {
    const existing = await prisma.membershipPricingRule.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError('定价规则', id);
    await prisma.membershipPricingRule.delete({ where: { id } });
    return { success: true, id };
  },

  // ==========================================================
  // 受邀用户定价规则（会员价格 × 是否被邀请注册）
  // ==========================================================

  async listReferralPriceRules(query: Record<string, unknown>) {
    const { page, pageSize, skip, take } = parsePagination(query, 20);
    const enabledRaw = optionalString(query.enabled);
    const priceType = optionalString(query.priceType);

    const where: Prisma.MembershipReferralPriceRuleWhereInput = {
      ...(enabledRaw ? { enabled: enabledRaw === 'true' } : {}),
      ...(priceType ? { priceType } : {}),
    };

    const [total, rows] = await Promise.all([
      prisma.membershipReferralPriceRule.count({ where }),
      prisma.membershipReferralPriceRule.findMany({
        where,
        orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
        skip,
        take,
      }),
    ]);

    return {
      page,
      pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
      items: rows.map(referralPriceRuleView),
    };
  },

  async createReferralPriceRule(input: Record<string, unknown>) {
    const rule = await prisma.membershipReferralPriceRule.create({
      data: {
        name: String(input.name),
        targetTier: optionalString(input.targetTier) ?? 'all',
        targetPeriod: optionalString(input.targetPeriod) ?? 'all',
        priceType: String(input.priceType),
        priceValue: Number(input.priceValue),
        firstPurchaseOnly: input.firstPurchaseOnly === undefined ? true : Boolean(input.firstPurchaseOnly),
        requireActiveReferral:
          input.requireActiveReferral === undefined ? true : Boolean(input.requireActiveReferral),
        priority: Number(input.priority ?? 0),
        enabled: input.enabled === undefined ? true : Boolean(input.enabled),
        note: optionalString(input.note) ?? '',
      },
    });
    return referralPriceRuleView(rule);
  },

  async updateReferralPriceRule(id: string, input: Record<string, unknown>) {
    const existing = await prisma.membershipReferralPriceRule.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError('受邀定价规则', id);

    const rule = await prisma.membershipReferralPriceRule.update({
      where: { id },
      data: {
        ...(input.name !== undefined ? { name: String(input.name) } : {}),
        ...(input.targetTier !== undefined ? { targetTier: String(input.targetTier) } : {}),
        ...(input.targetPeriod !== undefined ? { targetPeriod: String(input.targetPeriod) } : {}),
        ...(input.priceType !== undefined ? { priceType: String(input.priceType) } : {}),
        ...(input.priceValue !== undefined ? { priceValue: Number(input.priceValue) } : {}),
        ...(input.firstPurchaseOnly !== undefined
          ? { firstPurchaseOnly: Boolean(input.firstPurchaseOnly) }
          : {}),
        ...(input.requireActiveReferral !== undefined
          ? { requireActiveReferral: Boolean(input.requireActiveReferral) }
          : {}),
        ...(input.priority !== undefined ? { priority: Number(input.priority) } : {}),
        ...(input.enabled !== undefined ? { enabled: Boolean(input.enabled) } : {}),
        ...(input.note !== undefined ? { note: optionalString(input.note) ?? '' } : {}),
      },
    });
    return referralPriceRuleView(rule);
  },

  /** 同常规规则：订单存的是快照，删规则不影响历史订单。 */
  async removeReferralPriceRule(id: string) {
    const existing = await prisma.membershipReferralPriceRule.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError('受邀定价规则', id);
    await prisma.membershipReferralPriceRule.delete({ where: { id } });
    return { success: true, id };
  },

  // ==========================================================
  // 订单
  // ==========================================================

  async listOrders(query: Record<string, unknown>) {
    const { page, pageSize, skip, take } = parsePagination(query, 20);
    const status = optionalString(query.status);
    const tier = optionalString(query.tier);
    const period = optionalString(query.period);
    const payChannel = optionalString(query.payChannel);
    const q = optionalString(query.q);
    const from = parseDate(query.from, '开始时间');
    const to = parseDate(query.to, '结束时间');

    const where: Prisma.MembershipOrderWhereInput = {
      ...(status ? { status } : {}),
      ...(tier ? { tier } : {}),
      ...(period ? { period } : {}),
      ...(payChannel ? { payChannel } : {}),
      ...(from || to
        ? {
            createdAt: {
              ...(from ? { gte: from } : {}),
              ...(to ? { lte: to } : {}),
            },
          }
        : {}),
      ...(q
        ? {
            OR: [
              { orderNo: { contains: q, mode: 'insensitive' } },
              { user: { phone: { contains: q } } },
            ],
          }
        : {}),
    };

    const [total, rows, sums] = await Promise.all([
      prisma.membershipOrder.count({ where }),
      prisma.membershipOrder.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take,
        include: { user: { select: { id: true, phone: true, nickname: true } } },
      }),
      prisma.membershipOrder.groupBy({
        by: ['status'],
        where,
        _count: { _all: true },
        _sum: { amountCents: true },
      }),
    ]);

    const statusCounts = Object.fromEntries(
      ORDER_STATUSES.map((s) => {
        const hit = sums.find((x) => x.status === s);
        return [s, { count: hit?._count._all ?? 0, amountCents: hit?._sum.amountCents ?? 0 }];
      }),
    );

    return {
      page,
      pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
      items: rows.map((order) => {
        let adjustments: unknown = [];
        try {
          adjustments = JSON.parse(order.adjustments);
        } catch {
          // 快照是历史数据，解析不了就原样返回字符串，不要让整页 500
          adjustments = order.adjustments;
        }
        return {
          id: order.id,
          orderNo: order.orderNo,
          user: order.user,
          planCode: order.planCode,
          tier: order.tier,
          tierLabel: TIER_LABELS[order.tier as keyof typeof TIER_LABELS] ?? order.tier,
          period: order.period,
          periodLabel: PERIOD_LABELS[order.period as keyof typeof PERIOD_LABELS] ?? order.period,
          originalCents: order.originalCents,
          amountCents: order.amountCents,
          discountCents: Math.max(0, order.originalCents - order.amountCents),
          adjustments,
          payChannel: order.payChannel,
          payChannelLabel:
            PAY_CHANNEL_LABELS[order.payChannel as keyof typeof PAY_CHANNEL_LABELS] ??
            order.payChannel,
          status: order.status,
          transactionId: order.transactionId,
          paidAt: order.paidAt,
          startsAt: order.startsAt,
          expiresAt: order.expiresAt,
          autoRenew: order.autoRenew,
          createdAt: order.createdAt,
        };
      }),
      // 合计用**当前筛选条件**下的口径，管理员一改筛选就能看到对应的小计
      summary: {
        statusCounts,
        paidCount: statusCounts.paid?.count ?? 0,
        paidAmountCents: statusCounts.paid?.amountCents ?? 0,
      },
    };
  },

  // ==========================================================
  // 统计
  // ==========================================================

  async stats(query: Record<string, unknown>) {
    const days = Number(query.days ?? 30);
    const since = startOfDay(new Date(Date.now() - (days - 1) * DAY_MS));

    const [
      revenueByStatus,
      paidOrders,
      tierGroups,
      expiringSoon,
      autoRenewCount,
      enabledPlanCount,
      enabledRuleCount,
      planPerformance,
    ] = await Promise.all([
      prisma.membershipOrder.groupBy({
        by: ['status'],
        _count: { _all: true },
        _sum: { amountCents: true },
      }),
      // 按天分桶要拿到逐单明细：Prisma 的 groupBy 不能按天截断
      prisma.membershipOrder.findMany({
        where: { status: 'paid', paidAt: { not: null }, createdAt: { gte: since } },
        select: { amountCents: true, paidAt: true, createdAt: true, tier: true, userId: true },
      }),
      prisma.user.groupBy({
        by: ['membershipTier'],
        _count: { _all: true },
      }),
      prisma.user.count({
        where: {
          membershipTier: { not: 'ordinary' },
          membershipExpiresAt: { gt: new Date(), lt: new Date(Date.now() + 7 * DAY_MS) },
        },
      }),
      prisma.user.count({
        where: { membershipAutoRenew: true, membershipTier: { not: 'ordinary' } },
      }),
      prisma.membershipPlan.count({ where: { enabled: true } }),
      prisma.membershipPricingRule.count({ where: { enabled: true } }),
      prisma.membershipOrder.groupBy({
        by: ['planCode'],
        where: { status: 'paid' },
        _count: { _all: true },
        _sum: { amountCents: true },
        orderBy: { _sum: { amountCents: 'desc' } },
        take: 10,
      }),
    ]);

    /*
      档位统计分两套口径：
      - activeTierCounts 按**有效期**算，是「现在真的还是会员」的人数；
      - storedTierCounts 直接读 membershipTier 字段，含已过期但还没被惰性降级的人。
      只读字段会把过期用户算成会员，只读有效期又会看不到降级还没发生的数据，
      两个都给出来，管理员能看出「有过期账号还没被清理」。
    */
    const now = new Date();
    const storedTierCounts = Object.fromEntries(
      tierGroups.map((g) => [g.membershipTier, g._count._all]),
    );
    const [totalUsers, activeMemberUsers, activeSuperUsers] = await Promise.all([
      prisma.user.count(),
      prisma.user.count({ where: { membershipTier: 'member', membershipExpiresAt: { gt: now } } }),
      prisma.user.count({ where: { membershipTier: 'super', membershipExpiresAt: { gt: now } } }),
    ]);
    const activeTierCounts = {
      member: activeMemberUsers,
      super: activeSuperUsers,
      ordinary: Math.max(0, totalUsers - activeMemberUsers - activeSuperUsers),
    };

    // 按天补齐：没有订单的那天要出现 0，否则折线图会把空档连成一条假斜线
    const byDay = new Map<string, { amountCents: number; count: number }>();
    for (let i = 0; i < days; i += 1) {
      const key = dayKey(new Date(since.getTime() + i * DAY_MS));
      byDay.set(key, { amountCents: 0, count: 0 });
    }
    for (const order of paidOrders) {
      const key = dayKey(order.paidAt ?? order.createdAt);
      const bucket = byDay.get(key);
      if (!bucket) continue;
      bucket.amountCents += order.amountCents;
      bucket.count += 1;
    }

    const series = [...byDay.entries()].map(([date, value]) => ({ date, ...value }));

    const paidTotalCents = revenueByStatus.find((s) => s.status === 'paid')?._sum.amountCents ?? 0;
    const paidTotalCount = revenueByStatus.find((s) => s.status === 'paid')?._count._all ?? 0;
    const payingUsers = new Set(paidOrders.map((o) => o.userId)).size;

    return {
      days,
      since,
      // 全量口径
      totals: {
        paidAmountCents: paidTotalCents,
        paidCount: paidTotalCount,
        payingUsers,
        averageOrderCents: paidTotalCount > 0 ? Math.round(paidTotalCents / paidTotalCount) : 0,
        totalUsers,
      },
      byStatus: Object.fromEntries(
        ORDER_STATUSES.map((s) => {
          const hit = revenueByStatus.find((x) => x.status === s);
          return [s, { count: hit?._count._all ?? 0, amountCents: hit?._sum.amountCents ?? 0 }];
        }),
      ),
      users: {
        total: totalUsers,
        // 按有效期算的「现在真的还是会员」
        activeMember: activeTierCounts.member,
        activeSuper: activeTierCounts.super,
        activeTotal: activeTierCounts.member + activeTierCounts.super,
        ordinary: activeTierCounts.ordinary,
        activeTierCounts,
        // 字段里的档位（含已过期但还没被惰性降级的）
        storedTierCounts,
        expiringIn7Days: expiringSoon,
        autoRenew: autoRenewCount,
        // 付费转化率：付过费的人 / 全部注册用户
        paidConversion: totalUsers > 0 ? payingUsers / totalUsers : 0,
      },
      config: {
        enabledPlans: enabledPlanCount,
        enabledRules: enabledRuleCount,
      },
      series,
      planPerformance: planPerformance.map((p) => ({
        planCode: p.planCode,
        count: p._count._all,
        amountCents: p._sum.amountCents ?? 0,
      })),
    };
  },

  // ==========================================================
  // 试算
  // ==========================================================

  /**
   * 后台试算：改完规则想知道「这个人现在要付多少钱」。
   *
   * 传 userId 就用那个账号的真实画像，不传则用请求里给的四项画像
   * （后台调规则时不必为了看效果先去造一个账号）。
   */
  async simulate(input: Record<string, unknown>) {
    const planCode = String(input.planCode);
    const plan = await prisma.membershipPlan.findUnique({ where: { code: planCode } });
    if (!plan) throw new NotFoundError('套餐', planCode);

    let context: PricingContext;
    let referralContext: ReferralPricingContext;
    let source: string;

    if (input.userId != null) {
      const userId = Number(input.userId);
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: {
          id: true,
          firstPaidAt: true,
          membershipTier: true,
          membershipExpiresAt: true,
          createdAt: true,
        },
      });
      if (!user) throw new NotFoundError('家长账号', String(userId));
      const deviceCount = await prisma.childDevice.count({ where: { userId } });
      const now = new Date();
      const expired = Boolean(user.membershipExpiresAt && user.membershipExpiresAt <= now);
      context = {
        hasPaid: Boolean(user.firstPaidAt),
        activeTier: (expired ? 'ordinary' : user.membershipTier) as MembershipTier,
        deviceCount,
        registeredDaysAgo: Math.floor((now.getTime() - user.createdAt.getTime()) / DAY_MS),
      };
      const [row, referral] = await Promise.all([
        prisma.user.findUnique({ where: { id: userId }, select: { referredById: true } }),
        prisma.referral.findUnique({ where: { inviteeId: userId }, select: { status: true } }),
      ]);
      referralContext = {
        invited: Boolean(row?.referredById),
        active: referral ? referral.status !== 'invalid' : true,
      };
      source = `账号 #${userId}`;
    } else {
      context = {
        hasPaid: Boolean(input.hasPaid),
        activeTier: (input.activeTier as PricingContext['activeTier']) ?? 'ordinary',
        deviceCount: Number(input.deviceCount ?? 0),
        registeredDaysAgo: Number(input.registeredDaysAgo ?? 0),
      };
      referralContext = {
        invited: Boolean(input.invited),
        active: input.referralActive == null ? true : Boolean(input.referralActive),
      };
      source = '自定义画像';
    }

    const [rules, referralRules] = await Promise.all([
      prisma.membershipPricingRule.findMany({
        where: { enabled: true },
        orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
      }),
      prisma.membershipReferralPriceRule.findMany({
        where: { enabled: true },
        orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
      }),
    ]);

    // enforceStacking=false：把命中的规则全列出来，管理员才看得出「哪条没生效、被谁盖住了」
    const all = priceWithReferral(plan, rules, context, [], referralContext, false).result;
    const applied = priceWithReferral(plan, rules, context, referralRules, referralContext, true);

    return {
      source,
      plan: planView(plan),
      context,
      result: applied.result,
      referral: applied.referral,
      // 命中但被「不可叠加」挤掉、最终没进价的规则
      missed: all.adjustments.filter(
        (a) => !applied.result.adjustments.some((b) => b.ruleId === a.ruleId),
      ),
    };
  },
};
