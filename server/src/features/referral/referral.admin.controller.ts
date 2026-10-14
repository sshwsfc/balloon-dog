import type { Request, Response } from 'express';
import { Router } from 'express';
import { ah } from '../../shared/asyncHandler';
import { currentAdmin } from '../../middleware/auth';
import { referralAdminService } from './referral.admin.service';
import {
  referralAdminListQuerySchema,
  referralConfigUpdateSchema,
  referralIdParamSchema,
  referralReviewSchema,
  referralRiskQuerySchema,
  referralRuleUpdateSchema,
  referralStatsQuerySchema,
} from './referral.dto';

function param(req: Request, name: string): string {
  const value = req.params[name];
  return Array.isArray(value) ? value[0] : String(value);
}

/** GET /api/admin/referral/stats */
export async function stats(req: Request, res: Response) {
  const { days } = referralStatsQuerySchema.parse(req.query);
  res.json(await referralAdminService.stats(days));
}

/** GET /api/admin/referral/invitees */
export async function listInvitees(req: Request, res: Response) {
  const query = referralAdminListQuerySchema.parse(req.query);
  res.json(await referralAdminService.listInvitees(query));
}

/** GET /api/admin/referral/rewards */
export async function listRewards(req: Request, res: Response) {
  const query = referralAdminListQuerySchema.parse(req.query);
  res.json(await referralAdminService.listRewards(query));
}

/** GET /api/admin/referral/coupons */
export async function listCoupons(req: Request, res: Response) {
  const query = referralAdminListQuerySchema.parse(req.query);
  res.json(await referralAdminService.listCoupons(query));
}

/** GET /api/admin/referral/withdrawals */
export async function listWithdrawals(req: Request, res: Response) {
  const query = referralAdminListQuerySchema.parse(req.query);
  res.json(await referralAdminService.listWithdrawals(query));
}

/** POST /api/admin/referral/withdrawals/:id/review */
export async function reviewWithdrawal(req: Request, res: Response) {
  const { id } = referralIdParamSchema.parse({ id: param(req, 'id') });
  const input = referralReviewSchema.parse(req.body);
  const admin = currentAdmin(req);
  const withdrawal = await referralAdminService.reviewWithdrawal(id, input, admin.id);
  res.json({ success: true, withdrawal });
}

/** GET /api/admin/referral/rules */
export async function getRules(_req: Request, res: Response) {
  res.json(await referralAdminService.getRules());
}

/** PUT /api/admin/referral/rules */
export async function updateRules(req: Request, res: Response) {
  const input = referralRuleUpdateSchema.parse(req.body);
  res.json(await referralAdminService.updateRules(input));
}

/** GET /api/admin/referral/config */
export async function getConfig(req: Request, res: Response) {
  res.json(await referralAdminService.getConfigView());
}

/** PUT /api/admin/referral/config */
export async function updateConfig(req: Request, res: Response) {
  const input = referralConfigUpdateSchema.parse(req.body);
  res.json(await referralAdminService.updateConfig(input));
}

/** GET /api/admin/referral/risk */
export async function risk(req: Request, res: Response) {
  const { days } = referralRiskQuerySchema.parse(req.query);
  res.json(await referralAdminService.risk(days));
}

export const referralAdminRoutes = Router();

referralAdminRoutes.get('/stats', ah(stats));
referralAdminRoutes.get('/invitees', ah(listInvitees));
referralAdminRoutes.get('/rewards', ah(listRewards));
referralAdminRoutes.get('/coupons', ah(listCoupons));
referralAdminRoutes.get('/withdrawals', ah(listWithdrawals));
referralAdminRoutes.post('/withdrawals/:id/review', ah(reviewWithdrawal));
referralAdminRoutes.get('/rules', ah(getRules));
referralAdminRoutes.put('/rules', ah(updateRules));
referralAdminRoutes.get('/config', ah(getConfig));
referralAdminRoutes.put('/config', ah(updateConfig));
referralAdminRoutes.get('/risk', ah(risk));
