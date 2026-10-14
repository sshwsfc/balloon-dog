/**
 * 分享提成（邀请返现）—— 家长端接口。
 *
 * 金额单位一律是「分」，与会员体系保持一致；前端负责换算成元展示。
 */

import type { Request, Response } from 'express';
import { Router } from 'express';
import { authenticate } from '../../middleware/auth';
import { currentUserId, parsePagination } from '../../shared/deviceScope';
import { ah } from '../../shared/asyncHandler';
import { referralService } from './referral.service';
import {
  referralCouponQuerySchema,
  referralListQuerySchema,
  referralVerifySchema,
  referralWithdrawSchema,
} from './referral.dto';

/** GET /api/referral —— 邀请返现总览（邀请码、统计、阶梯规则、券、活动说明）。 */
export async function getReferralOverview(req: Request, res: Response) {
  const userId = currentUserId(req);
  const overview = await referralService.getOverview(userId);
  res.json(overview);
}

/** GET /api/referral/invitees —— 我邀请的人。 */
export async function listInvitees(req: Request, res: Response) {
  const userId = currentUserId(req);
  const { page, pageSize } = parsePagination(req.query);
  const result = await referralService.listInvitees(userId, page, pageSize);
  res.json({ success: true, ...result });
}

/** GET /api/referral/rewards —— 返现明细。 */
export async function listRewards(req: Request, res: Response) {
  const userId = currentUserId(req);
  const { page, pageSize } = parsePagination(req.query);
  const { status } = referralListQuerySchema.parse(req.query);
  const result = await referralService.listRewards(userId, page, pageSize, status);
  res.json({ success: true, ...result });
}

/** GET /api/referral/coupons —— 优惠券列表。 */
export async function listCoupons(req: Request, res: Response) {
  const userId = currentUserId(req);
  const { status } = referralCouponQuerySchema.parse(req.query);
  const coupons = await referralService.listCoupons(userId, status === 'all' ? undefined : status);
  res.json({ success: true, ...coupons });
}

/** GET /api/referral/coupons/usable —— 下单时能用的券。 */
export async function listUsableCoupons(req: Request, res: Response) {
  const userId = currentUserId(req);
  const coupons = await referralService.listUsableCoupons(userId);
  res.json({ success: true, coupons });
}

/** GET /api/referral/withdrawals —— 提现记录。 */
export async function listWithdrawals(req: Request, res: Response) {
  const userId = currentUserId(req);
  const { page, pageSize } = parsePagination(req.query);
  const result = await referralService.listWithdrawals(userId, page, pageSize);
  res.json({ success: true, ...result });
}

/** POST /api/referral/identity —— 实名认证（身份证号只存哈希）。 */
export async function verifyIdentity(req: Request, res: Response) {
  const userId = currentUserId(req);
  const { realName, idCard } = referralVerifySchema.parse(req.body);
  const result = await referralService.verifyIdentity(userId, realName, idCard);
  res.json({ success: true, ...result });
}

/** POST /api/referral/withdrawals —— 申请提现。 */
export async function requestWithdrawal(req: Request, res: Response) {
  const userId = currentUserId(req);
  const input = referralWithdrawSchema.parse(req.body);
  const withdrawal = await referralService.requestWithdrawal(userId, input);
  res.status(201).json({ success: true, withdrawal });
}

export const referralRoutes = Router();

referralRoutes.use(authenticate);
referralRoutes.get('/', ah(getReferralOverview));
referralRoutes.get('/invitees', ah(listInvitees));
referralRoutes.get('/rewards', ah(listRewards));
referralRoutes.get('/coupons', ah(listCoupons));
referralRoutes.get('/coupons/usable', ah(listUsableCoupons));
referralRoutes.get('/withdrawals', ah(listWithdrawals));
referralRoutes.post('/identity', ah(verifyIdentity));
referralRoutes.post('/withdrawals', ah(requestWithdrawal));
