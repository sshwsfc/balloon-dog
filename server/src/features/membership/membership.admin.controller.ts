import { Request, Response } from 'express';
import {
  createPlanSchema,
  createRuleSchema,
  listOrdersQuerySchema,
  listPlansQuerySchema,
  listReferralPriceRulesQuerySchema,
  listRulesQuerySchema,
  membershipIdParamSchema,
  statsQuerySchema,
  updatePlanSchema,
  updateReferralPriceRuleSchema,
  updateRuleSchema,
  upsertReferralPriceRuleSchema,
} from './membership.admin.dto';
import { simulateSchema } from './membership.dto';
import { membershipAdminService } from './membership.admin.service';

// ============================================================
// 套餐
// ============================================================

/** GET /api/admin/membership/plans */
export async function listPlans(req: Request, res: Response) {
  const query = listPlansQuerySchema.parse(req.query);
  const data = await membershipAdminService.listPlans(query as Record<string, unknown>);
  res.json({ success: true, ...data });
}

/** POST /api/admin/membership/plans */
export async function createPlan(req: Request, res: Response) {
  const input = createPlanSchema.parse(req.body);
  const plan = await membershipAdminService.createPlan(input as Record<string, unknown>);
  res.status(201).json({ success: true, plan });
}

/** PATCH /api/admin/membership/plans/:id */
export async function updatePlan(req: Request, res: Response) {
  const { id } = membershipIdParamSchema.parse(req.params);
  const input = updatePlanSchema.parse(req.body);
  const plan = await membershipAdminService.updatePlan(id, input as Record<string, unknown>);
  res.json({ success: true, plan });
}

/** DELETE /api/admin/membership/plans/:id */
export async function removePlan(req: Request, res: Response) {
  const { id } = membershipIdParamSchema.parse(req.params);
  const result = await membershipAdminService.removePlan(id);
  res.json(result);
}

// ============================================================
// 定价规则
// ============================================================

/** GET /api/admin/membership/rules */
export async function listRules(req: Request, res: Response) {
  const query = listRulesQuerySchema.parse(req.query);
  const data = await membershipAdminService.listRules(query as Record<string, unknown>);
  res.json({ success: true, ...data });
}

/** POST /api/admin/membership/rules */
export async function createRule(req: Request, res: Response) {
  const input = createRuleSchema.parse(req.body);
  const rule = await membershipAdminService.createRule(input as Record<string, unknown>);
  res.status(201).json({ success: true, rule });
}

/** PATCH /api/admin/membership/rules/:id */
export async function updateRule(req: Request, res: Response) {
  const { id } = membershipIdParamSchema.parse(req.params);
  const input = updateRuleSchema.parse(req.body);
  const rule = await membershipAdminService.updateRule(id, input as Record<string, unknown>);
  res.json({ success: true, rule });
}

/** DELETE /api/admin/membership/rules/:id */
export async function removeRule(req: Request, res: Response) {
  const { id } = membershipIdParamSchema.parse(req.params);
  const result = await membershipAdminService.removeRule(id);
  res.json(result);
}

// ============================================================
// 受邀用户定价规则
// ============================================================

/** GET /api/admin/membership/referral-rules */
export async function listReferralPriceRules(req: Request, res: Response) {
  const query = listReferralPriceRulesQuerySchema.parse(req.query);
  const data = await membershipAdminService.listReferralPriceRules(query as Record<string, unknown>);
  res.json({ success: true, ...data });
}

/** POST /api/admin/membership/referral-rules */
export async function createReferralPriceRule(req: Request, res: Response) {
  const input = upsertReferralPriceRuleSchema.parse(req.body);
  const rule = await membershipAdminService.createReferralPriceRule(input as Record<string, unknown>);
  res.status(201).json({ success: true, rule });
}

/** PATCH /api/admin/membership/referral-rules/:id */
export async function updateReferralPriceRule(req: Request, res: Response) {
  const { id } = membershipIdParamSchema.parse(req.params);
  const input = updateReferralPriceRuleSchema.parse(req.body);
  const rule = await membershipAdminService.updateReferralPriceRule(id, input as Record<string, unknown>);
  res.json({ success: true, rule });
}

/** DELETE /api/admin/membership/referral-rules/:id */
export async function removeReferralPriceRule(req: Request, res: Response) {
  const { id } = membershipIdParamSchema.parse(req.params);
  const result = await membershipAdminService.removeReferralPriceRule(id);
  res.json(result);
}

/** POST /api/admin/membership/simulate */
export async function simulate(req: Request, res: Response) {
  const input = simulateSchema.parse(req.body);
  const data = await membershipAdminService.simulate(input as Record<string, unknown>);
  res.json({ success: true, ...data });
}

// ============================================================
// 订单与统计
// ============================================================

/** GET /api/admin/membership/orders */
export async function listOrders(req: Request, res: Response) {
  const query = listOrdersQuerySchema.parse(req.query);
  const data = await membershipAdminService.listOrders(query as Record<string, unknown>);
  res.json({ success: true, ...data });
}

/** GET /api/admin/membership/stats */
export async function stats(req: Request, res: Response) {
  const query = statsQuerySchema.parse(req.query);
  const data = await membershipAdminService.stats(query as Record<string, unknown>);
  res.json({ success: true, ...data });
}
