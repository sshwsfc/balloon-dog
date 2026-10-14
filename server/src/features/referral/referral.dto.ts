import { z } from 'zod';
import { COUPON_STATUSES, WITHDRAW_CHANNELS } from './referral.constants';

// ============================================================
// 家长端
// ============================================================

/** 分页查询：邀请记录 / 返现明细 / 提现记录共用一个形状。 */
export const referralListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  status: z.string().trim().max(24).optional(),
});

export const referralCouponQuerySchema = z.object({
  status: z.enum(['all', ...COUPON_STATUSES]).optional(),
});

/**
 * 实名认证。
 *
 * `idCard` 在这里只做格式校验，落库前会被服务层哈希 —— 数据库里永远没有明文身份证号。
 */
export const referralVerifySchema = z.object({
  realName: z.string().trim().min(2, '请输入真实姓名').max(20, '姓名过长'),
  idCard: z.string().trim().min(15, '请输入身份证号').max(18, '身份证号过长'),
});

export const referralWithdrawSchema = z.object({
  amountCents: z.coerce.number().int().min(1).optional(),
  channel: z.enum(WITHDRAW_CHANNELS, { message: '请选择提现方式' }),
  account: z.string().trim().min(2, '请填写收款账号').max(64, '收款账号过长'),
  note: z.string().trim().max(200).optional(),
});

// ============================================================
// 后台
// ============================================================

export const referralAdminListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  /** 手机号 / 昵称 / 邀请码 / 身份证姓名，按列表语义模糊匹配。 */
  q: z.string().trim().max(64).optional(),
  status: z.string().trim().max(24).optional(),
  kind: z.string().trim().max(24).optional(),
  channel: z.string().trim().max(24).optional(),
  from: z.string().trim().max(32).optional(),
  to: z.string().trim().max(32).optional(),
});

export const referralIdParamSchema = z.object({
  id: z.string().trim().min(1).max(64),
});

/** 提现审核：通过 / 驳回 / 标记已打款。 */
export const referralReviewSchema = z.object({
  action: z.enum(['approve', 'reject', 'pay'], { message: '请选择审核动作' }),
  note: z.string().trim().max(200).optional(),
});

const tierSchema = z.object({
  minInvitees: z.coerce.number().int().min(0).max(10000),
  maxInvitees: z.coerce.number().int().min(0).max(10000).nullable().optional(),
  ratePercent: z.coerce.number().int().min(0).max(100),
});

const couponRuleSchema = z.object({
  name: z.string().trim().min(1, '请填写券名称').max(40),
  inviteeCount: z.coerce.number().int().min(1).max(10000),
  repeatEvery: z.coerce.number().int().min(1).max(10000).nullable().optional(),
  amountCents: z.coerce.number().int().min(0).max(10000000),
  validDays: z.coerce.number().int().min(0).max(3650),
});

/**
 * 奖励规则：整表替换式保存。
 *
 * 选择「整表替换」而不是逐条 CRUD，是因为阶梯之间互相关联
 * （区间不能重叠、必须留一个兜底档），逐条改很容易中途留下一个自相矛盾的表。
 */
export const referralRuleUpdateSchema = z
  .object({
    tiers: z.array(tierSchema).min(1, '至少要保留一档奖励规则').max(12),
    couponRules: z.array(couponRuleSchema).max(20),
    shortPeriodMinRatePercent: z.coerce.number().int().min(0).max(100),
    longPeriodCapCents: z.coerce.number().int().min(0).max(10000000),
    renewalRatePercent: z.coerce.number().int().min(0).max(100),
    renewalCapCents: z.coerce.number().int().min(0).max(10000000),
  })
  .superRefine((value, ctx) => {
    // 比例阶梯按人数升序后必须严格递进，且不能重叠 ——
    // 否则同一笔订单会命中两档，返现多少全看遍历顺序。
    const sorted = [...value.tiers].sort((a, b) => a.minInvitees - b.minInvitees);
    if (sorted[0]?.minInvitees !== 0) {
      ctx.addIssue({ code: 'custom', path: ['tiers'], message: '必须有一档从 0 人开始（兜底档）' });
    }
    for (let i = 1; i < sorted.length; i += 1) {
      const prev = sorted[i - 1];
      const cur = sorted[i];
      if (prev.maxInvitees !== null && prev.maxInvitees !== undefined && cur.minInvitees <= prev.maxInvitees) {
        ctx.addIssue({ code: 'custom', path: ['tiers'], message: '奖励阶梯的人数区间不能重叠' });
      }
    }
  });

export const referralConfigUpdateSchema = z.object({
  title: z.string().trim().min(1, '请填写活动标题').max(60),
  subtitle: z.string().trim().min(1, '请填写活动副标题').max(120),
  enabled: z.coerce.boolean(),
  /** 活动说明，一行一条；落库时拼成换行分隔的字符串。 */
  notice: z.array(z.string().trim().min(1).max(300)).max(20),
  startedAt: z.string().trim().max(32).nullable().optional(),
  endsAt: z.string().trim().max(32).nullable().optional(),
  withdrawMinInvitees: z.coerce.number().int().min(0).max(1000),
  withdrawMinCents: z.coerce.number().int().min(0).max(10000000),
  withdrawRequireVerified: z.coerce.boolean(),
  settleDayStart: z.coerce.number().int().min(1).max(28),
  settleDayEnd: z.coerce.number().int().min(1).max(28),
});

export const referralRiskQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(365).default(30),
});

export const referralStatsQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(365).default(30),
});
