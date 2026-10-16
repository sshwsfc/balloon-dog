import { z } from 'zod';

/**
 * 支付相关的请求校验（规划 §5.4）。
 *
 * 与其余切片一样，这里只管**形状**（长度、类型、范围），业务规则（这单能不能退、
 * 这张发票能不能开）留在 service —— 因为那些规则要读库，写在 dto 里会变成
 * 「同一条规则校验两次、改一次漏一次」。
 */

export const orderNoSchema = z.object({
  orderNo: z.string().trim().min(6, '订单号不正确').max(64, '订单号不正确'),
});

/** 家长端发起支付：只需要订单号，渠道取下单时选的那个。 */
export const createPaymentSchema = orderNoSchema;

/** 模拟支付（只在渠道未接入 / 测试环境可用）。 */
export const mockPaySchema = z.object({
  orderNo: z.string().trim().min(6).max(64),
  outcome: z.enum(['success', 'fail']).default('success'),
});

/** 家长自助退款：必须说明原因，避免出现「无理由退款」这种客服无从下手的记录。 */
export const refundRequestSchema = z.object({
  orderNo: z.string().trim().min(6).max(64),
  reason: z.string().trim().min(2, '请简单说明退款原因').max(200, '退款原因太长了'),
});

/**
 * 发票申请。
 *
 * 个人抬头可以没有税号，公司抬头必须有 —— 这一条在 service 里判（需要看抬头类型），
 * 这里只限制长度。
 */
export const invoiceRequestSchema = z.object({
  orderNo: z.string().trim().min(6).max(64),
  title: z.string().trim().min(2, '请填写发票抬头').max(50, '发票抬头太长了'),
  taxNo: z.string().trim().max(30).default(''),
  email: z.string().trim().email('请填写正确的邮箱').max(120),
  amountCents: z.number().int().positive().optional(),
});

export const invoiceIdSchema = z.object({ invoiceId: z.string().trim().min(1) });

// ---- 管理后台 ----

export const adminRefundSchema = z.object({
  orderNo: z.string().trim().min(6).max(64),
  amountCents: z.number().int().positive('退款金额必须大于 0'),
  reason: z.string().trim().min(2, '请填写退款原因').max(200),
});

export const adminInvoiceUpdateSchema = z
  .object({
    status: z.enum(['pending', 'issued', 'rejected']),
    invoiceNo: z.string().trim().max(50).optional(),
    note: z.string().trim().max(200).optional(),
  })
  .refine((v) => v.status !== 'issued' || (v.invoiceNo ?? '').trim().length > 0, {
    message: '标记为已开具时必须填写发票号码',
    path: ['invoiceNo'],
  });

export const adminPaymentQuerySchema = z.object({
  status: z.string().trim().max(20).optional(),
  channel: z.string().trim().max(20).optional(),
  orderNo: z.string().trim().max(64).optional(),
  userId: z.coerce.number().int().positive().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
