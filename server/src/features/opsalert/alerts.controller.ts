/**
 * 后台告警大盘（规划 §5.5）—— 管理端接口。
 *
 * 与 `/api/alerts`（家长端的设备告警）不是一回事：那个是给家长看自己设备的，
 * 这里是运营看全局的。两者共用「告警」这个词，但受众、口径、鉴权完全不同，
 * 所以代码也分开放（`features/opsalert/` vs `features/insights/`），避免后来者改错文件。
 */

import type { Request, Response } from 'express';
import { Router } from 'express';
import { authenticateAdmin, currentAdmin } from '../../middleware/auth';
import { ah } from '../../shared/asyncHandler';
import {
  alertAckCreateSchema,
  alertAckIdSchema,
  alertAckListQuerySchema,
  alertRuleKeySchema,
  alertRulePatchSchema,
} from './alerts.dto';
import {
  createAlertAck,
  deleteAlertAck,
  listAlertAcks,
  listAlertRules,
  overview,
  resetAlertRule,
  updateAlertRule,
} from './alerts.service';

/** GET /api/admin/alerts/overview —— 五个指标 + 每条规则的触发状态与样本。 */
export async function getAlertOverview(_req: Request, res: Response) {
  res.json(await overview());
}

/** GET /api/admin/alerts/rules —— 规则列表（含代码默认值，便于「恢复默认」）。 */
export async function getAlertRules(_req: Request, res: Response) {
  res.json({ rules: await listAlertRules() });
}

/** PATCH /api/admin/alerts/rules/:key —— 改阈值 / 严重度 / 窗口 / 开关。 */
export async function patchAlertRule(req: Request, res: Response) {
  const { key } = alertRuleKeySchema.parse(req.params);
  const patch = alertRulePatchSchema.parse(req.body);
  res.json({ success: true, rule: await updateAlertRule(key, patch) });
}

/** DELETE /api/admin/alerts/rules/:key/reset —— 恢复代码默认口径。 */
export async function resetAlertRuleHandler(req: Request, res: Response) {
  const { key } = alertRuleKeySchema.parse(req.params);
  res.json({ success: true, rule: await resetAlertRule(key) });
}

/** GET /api/admin/alerts/acks —— 已确认列表。 */
export async function listAlertAcksHandler(req: Request, res: Response) {
  const { page, pageSize } = alertAckListQuerySchema.parse(req.query);
  res.json(await listAlertAcks(page, pageSize));
}

/** POST /api/admin/alerts/acks —— 「这条我看过了」（重复确认 = 更新备注与快照）。 */
export async function createAlertAckHandler(req: Request, res: Response) {
  const input = alertAckCreateSchema.parse(req.body);
  const admin = currentAdmin(req);
  res.status(201).json({ success: true, ack: await createAlertAck({ ...input, adminId: admin.id }) });
}

/** DELETE /api/admin/alerts/acks/:id —— 撤销确认（删行）。 */
export async function deleteAlertAckHandler(req: Request, res: Response) {
  const { id } = alertAckIdSchema.parse(req.params);
  res.json({ success: true, ...(await deleteAlertAck(id)) });
}

export const alertAdminRoutes = Router();
alertAdminRoutes.use(authenticateAdmin);
alertAdminRoutes.get('/overview', ah(getAlertOverview));
alertAdminRoutes.get('/rules', ah(getAlertRules));
alertAdminRoutes.patch('/rules/:key', ah(patchAlertRule));
alertAdminRoutes.delete('/rules/:key/reset', ah(resetAlertRuleHandler));
alertAdminRoutes.get('/acks', ah(listAlertAcksHandler));
alertAdminRoutes.post('/acks', ah(createAlertAckHandler));
alertAdminRoutes.delete('/acks/:id', ah(deleteAlertAckHandler));
