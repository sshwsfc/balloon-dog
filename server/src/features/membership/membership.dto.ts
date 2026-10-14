import { z } from 'zod';
import {
  BILLING_PERIODS,
  DISCOUNT_TYPES,
  PAY_CHANNELS,
  PURCHASABLE_TIERS,
  RULE_CONDITIONS,
} from './membership.constants';

// ============================================================
// 家长端
// ============================================================

export const createOrderSchema = z.object({
  planCode: z.string().min(1, '请选择套餐').max(64),
  payChannel: z.enum(PAY_CHANNELS, { message: '请选择支付方式' }),
  /** 邀请返现优惠券（可选）。面额与有效性一律以服务端为准。 */
  couponId: z.string().trim().max(64).optional(),
});

export const payOrderSchema = z.object({
  /** 模拟支付结果：成功 / 失败。真实接入后这里换成渠道回调的原始报文。 */
  outcome: z.enum(['success', 'fail']).default('success'),
});

export const autoRenewSchema = z.object({
  enabled: z.boolean(),
});

// ============================================================
// 后台：套餐管理
// ============================================================

const priceCents = z.number().int().min(0).max(10_000_000, '金额（分）过大');

export const upsertPlanSchema = z.object({
  code: z
    .string()
    .min(2, '编码至少 2 位')
    .max(64)
    .regex(/^[a-z0-9_]+$/, '编码只能用小写字母、数字和下划线'),
  tier: z.enum(PURCHASABLE_TIERS, { message: '档位只能是会员或超级会员' }),
  period: z.enum(BILLING_PERIODS, { message: '计费周期不合法' }),
  name: z.string().min(1, '请填套餐名').max(64),
  description: z.string().max(200).default(''),
  basePriceCents: priceCents,
  months: z.number().int().min(1).max(120).default(1),
  recommended: z.boolean().default(false),
  sortOrder: z.number().int().min(0).max(9999).default(0),
  enabled: z.boolean().default(true),
});

export const planIdSchema = z.object({ planId: z.string().min(1) });

// ============================================================
// 后台：定价规则管理
// ============================================================

export const upsertRuleSchema = z
  .object({
    name: z.string().min(1, '请填规则名').max(64),
    conditionType: z.enum(RULE_CONDITIONS, { message: '触发条件不合法' }),
    conditionMinDevices: z.number().int().min(1).max(999).nullable().default(null),
    conditionDays: z.number().int().min(1).max(3650).nullable().default(null),
    conditionFromTier: z.enum(PURCHASABLE_TIERS).nullable().default(null),
    targetTier: z.enum(['all', 'member', 'super']).default('all'),
    targetPeriod: z.enum(['all', 'monthly', 'yearly', 'auto_monthly']).default('all'),
    discountType: z.enum(DISCOUNT_TYPES, { message: '优惠方式不合法' }),
    discountValue: z.number().int().min(0).max(10_000_000),
    stackable: z.boolean().default(false),
    priority: z.number().int().min(0).max(9999).default(0),
    enabled: z.boolean().default(true),
    note: z.string().max(100).default(''),
  })
  .superRefine((v, ctx) => {
    if (v.discountType === 'percent' && (v.discountValue < 1 || v.discountValue > 100)) {
      ctx.addIssue({ code: 'custom', path: ['discountValue'], message: '按比例减时，比例要在 1~100 之间' });
    }
    if (v.conditionType === 'device_count' && !v.conditionMinDevices) {
      ctx.addIssue({ code: 'custom', path: ['conditionMinDevices'], message: '请填写设备数阈值' });
    }
    if (v.conditionType === 'registered_within_days' && !v.conditionDays) {
      ctx.addIssue({ code: 'custom', path: ['conditionDays'], message: '请填写天数' });
    }
    if (v.conditionType === 'tier_upgrade' && !v.conditionFromTier) {
      ctx.addIssue({ code: 'custom', path: ['conditionFromTier'], message: '请选择来源档位' });
    }
  });

export const ruleIdSchema = z.object({ ruleId: z.string().min(1) });

export const simulateSchema = z.object({
  planCode: z.string().min(1),
  /** 可选：不传就用当前这个家长账号的真实画像。 */
  userId: z.number().int().positive().optional(),
  hasPaid: z.boolean().optional(),
  activeTier: z.enum(['ordinary', 'member', 'super']).optional(),
  deviceCount: z.number().int().min(0).max(999).optional(),
  registeredDaysAgo: z.number().int().min(0).max(99999).optional(),
  /** 自定义画像时用：买家是不是被邀请注册的。 */
  invited: z.boolean().optional(),
  /** 自定义画像时用：邀请关系是否仍然有效（默认 true）。 */
  referralActive: z.boolean().optional(),
});

export type UpsertPlanInput = z.infer<typeof upsertPlanSchema>;
export type UpsertRuleInput = z.infer<typeof upsertRuleSchema>;
