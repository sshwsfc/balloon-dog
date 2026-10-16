import { Router, Request, Response } from 'express';
import { ah } from '../../shared/asyncHandler';
import { authenticate, authenticateAdmin } from '../../middleware/auth';
import { currentUserId } from '../../shared/deviceScope';
import { paymentsService } from './payments.service';
import {
  adminInvoiceUpdateSchema,
  adminPaymentQuerySchema,
  adminRefundSchema,
  createPaymentSchema,
  invoiceIdSchema,
  invoiceRequestSchema,
  orderNoSchema,
  refundRequestSchema,
} from './payments.dto';

/**
 * 支付（规划 §5.4）。三组路由：
 *
 *  - `/api/payments/*`（家长端，需要登录）：能付什么、下单、退款、开票；
 *  - `/api/payments/notify/:channel`（**渠道回调，没有登录态**）：必须拿到**原始报文**，
 *    所以它在 `app.ts` 里挂在 `express.json()` **之前**（签名是对原始字节算的，
 *    先 JSON.parse 再验签必然失败）；
 *  - `/api/admin/payments/*`（管理后台）：订单/退款/发票的查询与人工处理。
 */

// ============================================================
// 家长端
// ============================================================

/** GET /api/payments/catalog —— 现在能用的渠道、缺哪些配置、退款窗口。 */
export async function getCatalog(req: Request, res: Response) {
  // 目录是「这个账号现在能点什么」，所以必须带 userId：渠道正在按账号灰度时，
  // 两个账号看到的东西可以不一样。
  res.json(await paymentsService.catalog(currentUserId(req)));
}

/** GET /api/payments/orders —— 我的支付记录（含每笔的渠道事件）。 */
export async function listOrders(req: Request, res: Response) {
  const page = Math.max(1, Number(req.query.page ?? 1) || 1);
  const pageSize = Math.min(50, Math.max(1, Number(req.query.pageSize ?? 20) || 20));
  res.json(await paymentsService.myOrders(currentUserId(req), page, pageSize));
}

/** GET /api/payments/orders/:orderNo —— 一笔订单 + 渠道交互流水。 */
export async function getOrder(req: Request, res: Response) {
  const { orderNo } = orderNoSchema.parse(req.params);
  res.json(await paymentsService.orderDetail(currentUserId(req), orderNo));
}

/** POST /api/payments/orders/:orderNo/pay —— 向渠道下单（二维码 / 跳转 / 站内调起）。 */
export async function createPayment(req: Request, res: Response) {
  const { orderNo } = createPaymentSchema.parse(req.params);
  res.json({ success: true, ...(await paymentsService.createPayment(currentUserId(req), orderNo)) });
}

/** POST /api/payments/refunds —— 家长自助退款（窗口内、未开票）。 */
export async function requestRefund(req: Request, res: Response) {
  const input = refundRequestSchema.parse(req.body);
  res.json({
    success: true,
    ...(await paymentsService.requestRefund(currentUserId(req), input.orderNo, input.reason)),
  });
}

/** GET /api/payments/refunds —— 我的退款记录。 */
export async function listRefunds(req: Request, res: Response) {
  res.json(await paymentsService.myRefunds(currentUserId(req)));
}

/** POST /api/payments/invoices —— 申请开票。 */
export async function requestInvoice(req: Request, res: Response) {
  const input = invoiceRequestSchema.parse(req.body);
  res.status(201).json({ success: true, ...(await paymentsService.requestInvoice(currentUserId(req), input)) });
}

/** GET /api/payments/invoices —— 我的开票申请。 */
export async function listInvoices(req: Request, res: Response) {
  res.json(await paymentsService.myInvoices(currentUserId(req)));
}

export const paymentRoutes = Router();
paymentRoutes.use(authenticate);
paymentRoutes.get('/catalog', ah(getCatalog));
paymentRoutes.get('/orders', ah(listOrders));
paymentRoutes.get('/orders/:orderNo', ah(getOrder));
paymentRoutes.post('/orders/:orderNo/pay', ah(createPayment));
paymentRoutes.post('/refunds', ah(requestRefund));
paymentRoutes.get('/refunds', ah(listRefunds));
paymentRoutes.post('/invoices', ah(requestInvoice));
paymentRoutes.get('/invoices', ah(listInvoices));

// ============================================================
// 渠道回调（无登录态、原始报文）
// ============================================================

/**
 * POST /api/payments/notify/:channel
 *
 * 微信/支付宝都会带重试：只要不是 2xx 就持续重投。所以这里的应答**必须区分
 * 「这笔回调本身有问题」（非 2xx，让它重投并让运维看见）与「重复投递」
 * （200，单据已经结算完毕）。判定逻辑全在 `paymentsService.handleNotify`。
 */
export async function notify(req: Request, res: Response) {
  const channel = String(req.params.channel ?? '');
  const rawBody = Buffer.isBuffer(req.body)
    ? req.body.toString('utf8')
    : typeof req.body === 'string'
      ? req.body
      : JSON.stringify(req.body ?? {});
  const outcome = await paymentsService.handleNotify(channel, {
    headers: req.headers as Record<string, string | string[] | undefined>,
    rawBody,
  });
  res.status(outcome.httpStatus).type(outcome.contentType).send(outcome.body);
}

export const paymentNotifyRoutes = Router();
paymentNotifyRoutes.post('/:channel', ah(notify));

// ============================================================
// 管理后台
// ============================================================

/** GET /api/admin/payments/stats —— 收款/退款/渠道分布/坏签名回调。 */
export async function adminStats(_req: Request, res: Response) {
  res.json(await paymentsService.adminStats());
}

/** GET /api/admin/payments/orders —— 全部订单（可按状态/渠道/订单号/账号筛）。 */
export async function adminListOrders(req: Request, res: Response) {
  const query = adminPaymentQuerySchema.parse(req.query);
  res.json(await paymentsService.adminListOrders(query));
}

/** GET /api/admin/payments/orders/:orderNo/events —— 一笔订单的全部渠道交互。 */
export async function adminOrderEvents(req: Request, res: Response) {
  const { orderNo } = orderNoSchema.parse(req.params);
  res.json(await paymentsService.adminEvents(orderNo));
}

/** POST /api/admin/payments/refunds —— 人工退款。 */
export async function adminRefund(req: Request, res: Response) {
  const input = adminRefundSchema.parse(req.body);
  res.json({
    success: true,
    ...(await paymentsService.adminRefund(input.orderNo, input.amountCents, input.reason)),
  });
}

/** GET /api/admin/payments/refunds —— 退款列表（含处理中的）。 */
export async function adminListRefunds(req: Request, res: Response) {
  const page = Math.max(1, Number(req.query.page ?? 1) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize ?? 20) || 20));
  res.json(await paymentsService.adminListRefunds(page, pageSize));
}

/** GET /api/admin/payments/invoices —— 开票申请列表。 */
export async function adminListInvoices(req: Request, res: Response) {
  const status = typeof req.query.status === 'string' && req.query.status ? req.query.status : undefined;
  const page = Math.max(1, Number(req.query.page ?? 1) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize ?? 20) || 20));
  res.json(await paymentsService.adminListInvoices(status, page, pageSize));
}

/** PATCH /api/admin/payments/invoices/:invoiceId —— 开具 / 驳回。 */
export async function adminUpdateInvoice(req: Request, res: Response) {
  const { invoiceId } = invoiceIdSchema.parse(req.params);
  const input = adminInvoiceUpdateSchema.parse(req.body);
  res.json({ success: true, ...(await paymentsService.adminUpdateInvoice(invoiceId, input)) });
}

export const paymentAdminRoutes = Router();
paymentAdminRoutes.use(authenticateAdmin);
paymentAdminRoutes.get('/stats', ah(adminStats));
paymentAdminRoutes.get('/orders', ah(adminListOrders));
paymentAdminRoutes.get('/orders/:orderNo/events', ah(adminOrderEvents));
paymentAdminRoutes.post('/refunds', ah(adminRefund));
paymentAdminRoutes.get('/refunds', ah(adminListRefunds));
paymentAdminRoutes.get('/invoices', ah(adminListInvoices));
paymentAdminRoutes.patch('/invoices/:invoiceId', ah(adminUpdateInvoice));
