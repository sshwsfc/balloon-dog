import { Router, Request, Response } from 'express';
import { ah } from '../../shared/asyncHandler';
import { authenticate } from '../../middleware/auth';
import { currentUserId, parsePagination } from '../../shared/deviceScope';
import { NotFoundError, ServiceUnavailableError } from '../../errors';
import { config } from '../../config';
import { membershipService } from './membership.service';
import { autoRenewSchema, createOrderSchema, payOrderSchema } from './membership.dto';

/**
 * /api/membership —— 家长端会员中心。
 *
 * 支付是**模拟**的（见 config.MEMBERSHIP_MOCK_PAY）：下单只落一条 pending 订单，
 * 支付成功由 /orders/:orderNo/pay 显式触发，等价于渠道异步回调。
 * 真实接入支付宝/微信时，只需要把 payOrder 换成「验签后的回调处理」，
 * 订单与会员生效的逻辑（快照金额、同档续费顺延、升级重新起算）都不用动。
 */

// ============================================================
// 家长端
// ============================================================

/** GET /api/membership —— 当前档位 + 每档套餐的动态报价。 */
export async function getOverview(req: Request, res: Response) {
  const userId = currentUserId(req);
  const data = await membershipService.getOverview(userId);
  res.json({ success: true, ...data, mockPay: config.MEMBERSHIP_MOCK_PAY });
}

/** GET /api/membership/orders */
export async function listOrders(req: Request, res: Response) {
  const userId = currentUserId(req);
  const { page, pageSize } = parsePagination(req.query as Record<string, unknown>);
  const data = await membershipService.listOrders(userId, page, pageSize);
  res.json({ success: true, ...data });
}

/** POST /api/membership/orders —— 下单（返回带动态价格的订单）。 */
export async function createOrder(req: Request, res: Response) {
  const userId = currentUserId(req);
  const body = createOrderSchema.parse(req.body ?? {});
  const data = await membershipService.createOrder(userId, body);
  res.status(201).json({ success: true, ...data });
}

/** POST /api/membership/orders/:orderNo/pay —— 模拟支付（成功/失败）。 */
export async function payOrder(req: Request, res: Response) {
  const userId = currentUserId(req);
  const orderNo = String(req.params.orderNo ?? '').trim();
  if (!orderNo) throw new NotFoundError('订单');
  if (!config.MEMBERSHIP_MOCK_PAY) {
    throw new ServiceUnavailableError('支付渠道尚未接入，暂时无法支付');
  }
  const body = payOrderSchema.parse(req.body ?? {});
  const data = await membershipService.payOrder(userId, orderNo, body.outcome);
  res.json({ success: true, ...data });
}

/** POST /api/membership/orders/:orderNo/cancel */
export async function cancelOrder(req: Request, res: Response) {
  const userId = currentUserId(req);
  const orderNo = String(req.params.orderNo ?? '').trim();
  if (!orderNo) throw new NotFoundError('订单');
  const order = await membershipService.cancelOrder(userId, orderNo);
  res.json({ success: true, order });
}

/** POST /api/membership/auto-renew —— 开启/关闭连续包月。 */
export async function setAutoRenew(req: Request, res: Response) {
  const userId = currentUserId(req);
  const body = autoRenewSchema.parse(req.body ?? {});
  const status = await membershipService.setAutoRenew(userId, body.enabled);
  res.json({ success: true, status });
}

export const membershipRoutes = Router();
membershipRoutes.use(authenticate);
membershipRoutes.get('/', ah(getOverview));
membershipRoutes.get('/orders', ah(listOrders));
membershipRoutes.post('/orders', ah(createOrder));
membershipRoutes.post('/orders/:orderNo/pay', ah(payOrder));
membershipRoutes.post('/orders/:orderNo/cancel', ah(cancelOrder));
membershipRoutes.post('/auto-renew', ah(setAutoRenew));
