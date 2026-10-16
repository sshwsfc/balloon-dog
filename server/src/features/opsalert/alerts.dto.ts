import { z } from 'zod';

/** 规则 key 只能是代码里定义过的（服务层再校验一次，避免手写字符串绕过）。 */
export const alertRuleKeySchema = z.object({
  key: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9]+(_[a-z0-9]+)*$/, '规则 key 只能是小写字母、数字和下划线'),
});

export const alertRulePatchSchema = z
  .object({
    enabled: z.boolean().optional(),
    severity: z.enum(['info', 'warn', 'danger']).optional(),
    threshold: z.number().int().min(0).max(100_000).optional(),
    windowMinutes: z.number().int().min(0).max(1440).optional(),
    note: z.string().max(200).optional(),
  })
  .strict();

/**
 * 确认告警。**不接受 `snapshot`**：确认时的指标快照由服务端自己算 ——
 * 让前端传「我认为是 30%」会让确认记录失去证据价值。
 */
export const alertAckCreateSchema = z
  .object({
    key: z.string().min(1).max(64),
    subject: z.string().max(64).optional(),
    note: z.string().max(200).optional(),
  })
  .strict();

export const alertAckIdSchema = z.object({ id: z.string().min(1).max(64) });

export const alertAckListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
