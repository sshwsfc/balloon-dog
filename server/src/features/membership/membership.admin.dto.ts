import { z } from 'zod';
import {
  BILLING_PERIODS,
  DISCOUNT_TYPES,
  MEMBERSHIP_TIERS,
  MIN_PAYABLE_CENTS,
  ORDER_STATUSES,
  PAY_CHANNELS,
  PURCHASABLE_TIERS,
  REFERRAL_PRICE_TYPES,
  RULE_CONDITIONS,
} from './membership.constants';

/**
 * 后台会员管理的入参校验。
 *
 * 与家长端 dto 分开写：家长端只需要「选哪个套餐、用哪个渠道」，
 * 后台要能改套餐本身和定价规则，字段多得多，混在一个文件里两边都会难读。
 */

const tierEnum = z.enum(PURCHASABLE_TIERS);
const periodEnum = z.enum(BILLING_PERIODS);

/** 路径参数统一按非空字符串处理（Express 5 下 params 可能是 string[]）。 */
export const membershipIdParamSchema = z.object({ id: z.string().min(1) });

// ============================================================
// 套餐
// ============================================================

export const listPlansQuerySchema = z.object({
  tier: z.enum(MEMBERSHIP_TIERS).optional(),
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().max(100).optional(),
});

export const createPlanSchema = z.object({
  /** 留空则按 `{tier}_{period}` 自动生成，避免后台手滑写出重复或乱码 code */
  code: z
    .string()
    .trim()
    .regex(/^[a-z0-9_]{3,64}$/, '套餐编码只能用小写字母、数字和下划线')
    .optional(),
  tier: tierEnum,
  period: periodEnum,
  name: z.string().trim().min(1, '请填写套餐名称').max(64),
  description: z.string().trim().max(200).optional(),
  basePriceCents: z
    .number()
    .int('金额必须是整数分')
    .min(100, '基准价不能低于 1 元')
    .max(100_000_00, '基准价过高'),
  recommended: z.boolean().optional(),
  sortOrder: z.number().int().min(0).max(9999).optional(),
  enabled: z.boolean().optional(),
});

export const updatePlanSchema = createPlanSchema.partial().omit({ code: true, tier: true, period: true });

// ============================================================
// 定价规则
// ============================================================

export const listRulesQuerySchema = z.object({
  enabled: z.enum(['true', 'false']).optional(),
  conditionType: z.enum(RULE_CONDITIONS).optional(),
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().max(100).optional(),
});

export const createRuleSchema = z
  .object({
    name: z.string().trim().min(1, '请填写规则名称').max(64),
    conditionType: z.enum(RULE_CONDITIONS),
    conditionMinDevices: z.number().int().min(1).max(50).nullish(),
    conditionDays: z.number().int().min(1).max(3650).nullish(),
    conditionFromTier: tierEnum.nullish(),
    targetTier: z.enum(['all', ...PURCHASABLE_TIERS]).optional(),
    targetPeriod: z.enum(['all', ...BILLING_PERIODS]).optional(),
    discountType: z.enum(DISCOUNT_TYPES),
    discountValue: z.number().int().min(1).max(100_000_00),
    stackable: z.boolean().optional(),
    priority: z.number().int().min(0).max(9999).optional(),
    enabled: z.boolean().optional(),
    note: z.string().trim().max(120).optional(),
  })
  .superRefine((value, ctx) => {
    /*
      条件与参数必须配套。不校验的话，后台能存下一条「绑定设备数达到阈值」
      但没填阈值的规则 —— 引擎读不到参数只能当它永远不命中，
      而管理员在界面上看到的是「规则已启用」，两边就此对不上。
    */
    if (value.conditionType === 'device_count' && !value.conditionMinDevices) {
      ctx.addIssue({
        code: 'custom',
        path: ['conditionMinDevices'],
        message: '「绑定设备数达到阈值」必须填写设备数',
      });
    }
    if (value.conditionType === 'registered_within_days' && !value.conditionDays) {
      ctx.addIssue({
        code: 'custom',
        path: ['conditionDays'],
        message: '「注册后 N 天内」必须填写天数',
      });
    }
    if (value.conditionType === 'tier_upgrade' && !value.conditionFromTier) {
      ctx.addIssue({
        code: 'custom',
        path: ['conditionFromTier'],
        message: '「由指定档位升级」必须选择来源档位',
      });
    }
    if (value.discountType === 'percent' && value.discountValue > 100) {
      ctx.addIssue({
        code: 'custom',
        path: ['discountValue'],
        message: '按比例减的百分比不能超过 100',
      });
    }
  });

export const updateRuleSchema = z.object({
  name: z.string().trim().min(1).max(64).optional(),
  conditionType: z.enum(RULE_CONDITIONS).optional(),
  conditionMinDevices: z.number().int().min(1).max(50).nullish(),
  conditionDays: z.number().int().min(1).max(3650).nullish(),
  conditionFromTier: tierEnum.nullish(),
  targetTier: z.enum(['all', ...PURCHASABLE_TIERS]).optional(),
  targetPeriod: z.enum(['all', ...BILLING_PERIODS]).optional(),
  discountType: z.enum(DISCOUNT_TYPES).optional(),
  discountValue: z.number().int().min(1).max(100_000_00).optional(),
  stackable: z.boolean().optional(),
  priority: z.number().int().min(0).max(9999).optional(),
  enabled: z.boolean().optional(),
  note: z.string().trim().max(120).optional(),
});

// ============================================================
// 受邀定价规则（会员价格 × 是否被邀请注册）
// ============================================================

export const listReferralPriceRulesQuerySchema = z.object({
  enabled: z.enum(['true', 'false']).optional(),
  priceType: z.enum(REFERRAL_PRICE_TYPES).optional(),
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().max(100).optional(),
});

export const upsertReferralPriceRuleSchema = z
  .object({
    name: z.string().trim().min(1, '请填规则名').max(64),
    targetTier: z.enum(['all', ...PURCHASABLE_TIERS]).default('all'),
    targetPeriod: z.enum(['all', ...BILLING_PERIODS]).default('all'),
    priceType: z.enum(REFERRAL_PRICE_TYPES, { message: '上浮方式不合法' }),
    priceValue: z.number().int().min(0).max(10_000_000),
    firstPurchaseOnly: z.boolean().default(true),
    requireActiveReferral: z.boolean().default(true),
    priority: z.number().int().min(0).max(9999).default(0),
    enabled: z.boolean().default(true),
    note: z.string().trim().max(120).default(''),
  })
  .superRefine((v, ctx) => {
    if (v.priceType === 'percent' && (v.priceValue < 1 || v.priceValue > 200)) {
      ctx.addIssue({ code: 'custom', path: ['priceValue'], message: '按比例上浮时，比例要在 1~200 之间' });
    }
    if (v.priceType === 'fixed' && v.priceValue < MIN_PAYABLE_CENTS) {
      // 一口价低于常规价时引擎会判「不生效」，但那种配置看着像生效了、实际静默无效，
      // 不如在这里直接拦住，让管理员知道自己在配一个永远不会命中的规则。
      ctx.addIssue({
        code: 'custom',
        path: ['priceValue'],
        message: `一口价不能低于 ${MIN_PAYABLE_CENTS / 100} 元`,
      });
    }
  });

export const updateReferralPriceRuleSchema = z.object({
  name: z.string().trim().min(1).max(64).optional(),
  targetTier: z.enum(['all', ...PURCHASABLE_TIERS]).optional(),
  targetPeriod: z.enum(['all', ...BILLING_PERIODS]).optional(),
  priceType: z.enum(REFERRAL_PRICE_TYPES).optional(),
  priceValue: z.number().int().min(0).max(10_000_000).optional(),
  firstPurchaseOnly: z.boolean().optional(),
  requireActiveReferral: z.boolean().optional(),
  priority: z.number().int().min(0).max(9999).optional(),
  enabled: z.boolean().optional(),
  note: z.string().trim().max(120).optional(),
});

// ============================================================
// 订单
// ============================================================

export const listOrdersQuerySchema = z.object({
  status: z.enum(ORDER_STATUSES).optional(),
  tier: tierEnum.optional(),
  period: periodEnum.optional(),
  payChannel: z.enum(PAY_CHANNELS).optional(),
  /** 按订单号或用户手机号模糊搜 */
  q: z.string().trim().max(64).optional(),
  from: z.string().trim().max(32).optional(),
  to: z.string().trim().max(32).optional(),
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().max(100).optional(),
});

export const statsQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(365).optional(),
});

export const orderIdParamSchema = z.object({ orderNo: z.string().min(1) });
