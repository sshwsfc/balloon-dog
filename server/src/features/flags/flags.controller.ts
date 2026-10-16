/**
 * 灰度开关 —— 管理后台接口（规划 §5.5）。
 *
 * 只给后台，家长端不直接读这里：家长能看到的是**结果**（支付目录里有没有这个渠道、
 * 有没有工单入口），而不是开关列表 —— 否则开关就变成了对外承诺。
 */

import type { Request, Response } from 'express';
import { Router } from 'express';
import { authenticateAdmin, currentAdmin } from '../../middleware/auth';
import { ah } from '../../shared/asyncHandler';
import { flagKeySchema, flagPatchSchema, flagPreviewQuerySchema } from './flags.dto';
import { flagState, listFlags, resetFlag, updateFlag } from './flags.service';

/** GET /api/admin/flags —— 全部开关的当前状态（含代码默认值与接线说明）。 */
export async function listFeatureFlags(_req: Request, res: Response) {
  res.json({ flags: await listFlags() });
}

/** PATCH /api/admin/flags/:key —— 改开关（只改传进来的字段）。 */
export async function patchFeatureFlag(req: Request, res: Response) {
  const { key } = flagKeySchema.parse(req.params);
  const patch = flagPatchSchema.parse(req.body);
  const admin = currentAdmin(req);
  res.json({ success: true, flag: await updateFlag(key, patch, admin.id) });
}

/** DELETE /api/admin/flags/:key/reset —— 恢复代码默认值。 */
export async function resetFeatureFlag(req: Request, res: Response) {
  const { key } = flagKeySchema.parse(req.params);
  res.json({ success: true, flag: await resetFlag(key) });
}

/** GET /api/admin/flags/:key/preview?subjectId= —— 用某个账号/设备试算一次。 */
export async function previewFeatureFlag(req: Request, res: Response) {
  const { key } = flagKeySchema.parse(req.params);
  const { subjectId } = flagPreviewQuerySchema.parse(req.query);
  res.json({ preview: await flagState(key, subjectId ?? null) });
}

export const flagAdminRoutes = Router();
flagAdminRoutes.use(authenticateAdmin);
flagAdminRoutes.get('/', ah(listFeatureFlags));
flagAdminRoutes.get('/:key/preview', ah(previewFeatureFlag));
flagAdminRoutes.patch('/:key', ah(patchFeatureFlag));
flagAdminRoutes.delete('/:key/reset', ah(resetFeatureFlag));
