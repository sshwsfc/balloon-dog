import { Router, Request, Response } from 'express';
import { ah } from '../../shared/asyncHandler';
import { authenticate } from '../../middleware/auth';
import { currentUserId } from '../../shared/deviceScope';
import { privacyService } from './privacy.service';
import {
  acceptConsentSchema,
  consentIdSchema,
  requestDeletionSchema,
  revokeConsentSchema,
} from './privacy.dto';

/**
 * 合规留痕、导出与注销（规划 §5.3）。挂 `/api/privacy`。
 *
 * 全部是**账号级**接口，没有设备作用域：同意的主体是家长账号，
 * 注销删的也是账号。所以这里不用 `resolveDevice`/`resolveWritableDevice`。
 *
 * 撤回同意与注销都要密码 + 手动确认文字（在 service 里核对），
 * 因为它们会立刻解绑设备、停止监控 —— 这是接口存在的意义，不是一个状态位。
 */

/** GET /api/privacy/docs —— 文本目录 + 最小必要采集清单（服务端唯一一份）。 */
export async function getDocs(_req: Request, res: Response) {
  res.json(privacyService.docs());
}

/** GET /api/privacy/consents —— 我对每份文本的同意情况（含历史）。 */
export async function listConsents(req: Request, res: Response) {
  res.json({ consents: await privacyService.listConsents(currentUserId(req)) });
}

/** POST /api/privacy/consents —— 同意某一版文本。 */
export async function acceptConsent(req: Request, res: Response) {
  const input = acceptConsentSchema.parse(req.body);
  const result = await privacyService.acceptConsent(currentUserId(req), input, {
    ip: req.ip ?? '',
    userAgent: req.get('user-agent') ?? '',
  });
  res.status(result.created ? 201 : 200).json({ success: true, ...result });
}

/** POST /api/privacy/consents/:consentId/revoke —— 撤回同意（立刻停止监控）。 */
export async function revokeConsent(req: Request, res: Response) {
  const { consentId } = consentIdSchema.parse(req.params);
  const input = revokeConsentSchema.parse(req.body);
  const result = await privacyService.revokeConsent(currentUserId(req), consentId, input);
  res.json({ success: true, ...result });
}

/** GET /api/privacy/deletion —— 注销状态（有没有排期、哪天生效）。 */
export async function getDeletion(req: Request, res: Response) {
  res.json({ deletion: await privacyService.deletionStatus(currentUserId(req)) });
}

/** POST /api/privacy/deletion —— 申请注销，进入冷静期。 */
export async function requestDeletion(req: Request, res: Response) {
  const input = requestDeletionSchema.parse(req.body);
  const deletion = await privacyService.requestDeletion(currentUserId(req), input);
  res.json({ success: true, deletion });
}

/** DELETE /api/privacy/deletion —— 冷静期内撤销注销。 */
export async function cancelDeletion(req: Request, res: Response) {
  const deletion = await privacyService.cancelDeletion(currentUserId(req));
  res.json({ success: true, deletion });
}

/** GET /api/privacy/export —— 导出我的数据（JSON 附件）。 */
export async function exportData(req: Request, res: Response) {
  const payload = await privacyService.exportData(currentUserId(req));
  const stamp = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Disposition', `attachment; filename="balloon-dog-export-${stamp}.json"`);
  res.json(payload);
}

/** /api/privacy */
export const privacyRoutes = Router();
privacyRoutes.use(authenticate);

/**
 * 到期注销的**惰性兜底**：定时任务（server.ts 每小时一次）之外，
 * 每次访问隐私接口也顺手清一遍。理由和 membership 的惰性降级一样 ——
 * 「到期真的删除」是一句对外的承诺，不能系在「那个 setInterval 还活着」上。
 *
 * 放在鉴权之后：一个已经被删掉的账号会在 authenticate 里拿到 401，
 * 不该因为「清理是第一步」而让任何人都能触发全表扫描。
 */
privacyRoutes.use(
  ah(async (_req, _res, next) => {
    await privacyService.sweepExpiredDeletions();
    next();
  }),
);

privacyRoutes.get('/docs', ah(getDocs));
privacyRoutes.get('/consents', ah(listConsents));
privacyRoutes.post('/consents', ah(acceptConsent));
privacyRoutes.post('/consents/:consentId/revoke', ah(revokeConsent));
privacyRoutes.get('/deletion', ah(getDeletion));
privacyRoutes.post('/deletion', ah(requestDeletion));
privacyRoutes.delete('/deletion', ah(cancelDeletion));
privacyRoutes.get('/export', ah(exportData));
