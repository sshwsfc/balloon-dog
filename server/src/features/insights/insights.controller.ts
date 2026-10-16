import { Router, Request, Response } from 'express';
import multer from 'multer';
import { ah } from '../../shared/asyncHandler';
import { authenticate, authenticateDevice } from '../../middleware/auth';
import { currentUserId, resolveDevice, resolveWritableDevice } from '../../shared/deviceScope';
import { config } from '../../config';
import { BadRequestError, NotFoundError } from '../../errors';
import { devicesRepo } from '../devices/devices.repository';
import { entitlementGate } from '../membership/membership.middleware';
import { insightsService } from './insights.service';
import {
  alertIdSchema,
  alertQuerySchema,
  budgetIdSchema,
  frameMetaListSchema,
  insightIdSchema,
  insightQuerySchema,
  screenAnswerSchema,
  updateScreenConfigSchema,
  uploadBatchSchema,
  upsertBudgetSchema,
} from './insights.dto';

/**
 * 截屏包上传用的是<b>内存存储</b>，不是磁盘。
 *
 * 原因：这个接口要先解 zip、校验条目、再决定怎么落盘，
 * 直接让 multer 写到磁盘会留下半个包需要额外清理，而且上传的 zip
 * 本身没有保留价值（我们要的是里面的帧）。内存里过一道最简单也最安全，
 * 大小上限由 SCREEN_BATCH_MAX_SIZE_MB 兜住。
 */
const screenUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: Math.round(config.SCREEN_BATCH_MAX_SIZE_MB * 1024 * 1024), files: 1 },
});

// ============================================================
// 设备端
// ============================================================

/** POST /api/agent/screen-batches */
export async function uploadScreenBatch(req: Request, res: Response) {
  const file = req.file;
  if (!file) throw new BadRequestError('请上传截屏包（表单字段名应为 file）');
  if (req.auth?.kind !== 'device') throw new BadRequestError('该接口仅设备端可访问');

  // frames 是表单里的 JSON 字符串
  let framesRaw: unknown;
  try {
    framesRaw = JSON.parse(String(req.body?.frames ?? '[]'));
  } catch {
    throw new BadRequestError('frames 不是合法的 JSON');
  }
  const frames = frameMetaListSchema.parse(framesRaw);

  const parsed = uploadBatchSchema.parse({
    startedAt: req.body?.startedAt,
    endedAt: req.body?.endedAt,
    frames,
    agentVersion: req.body?.agentVersion ?? '',
  });

  const device = await devicesRepo.findById(req.auth.id);
  if (!device) throw new NotFoundError('设备', req.auth.id);

  const result = await insightsService.ingestBatch(device, {
    zip: file.buffer,
    startedAt: parsed.startedAt,
    endedAt: parsed.endedAt,
    frames: parsed.frames,
    agentVersion: parsed.agentVersion,
  });

  // 202：包已收下，分析在后台跑。设备端据此立刻结束本轮，不要重传。
  res.status(202).json(result);
}

/** GET /api/agent/screen-quiz/next */
export async function nextScreenQuestion(req: Request, res: Response) {
  if (req.auth?.kind !== 'device') throw new BadRequestError('该接口仅设备端可访问');
  const device = await devicesRepo.findById(req.auth.id);
  if (!device) throw new NotFoundError('设备', req.auth.id);
  res.json(await insightsService.nextScreenQuestion(device));
}

/** POST /api/agent/screen-quiz/answer */
export async function answerScreenQuestion(req: Request, res: Response) {
  const { questionId, answer } = screenAnswerSchema.parse(req.body);
  if (req.auth?.kind !== 'device') throw new BadRequestError('该接口仅设备端可访问');
  const device = await devicesRepo.findById(req.auth.id);
  if (!device) throw new NotFoundError('设备', req.auth.id);
  res.json(await insightsService.answerScreenQuestion(device, questionId, answer));
}

// ============================================================
// 家长端
// ============================================================

export async function listInsights(req: Request, res: Response) {
  const query = insightQuerySchema.parse(req.query);
  const device = await resolveDevice(req);
  res.json(await insightsService.listInsights(device, query));
}

export async function getInsight(req: Request, res: Response) {
  const { insightId } = insightIdSchema.parse(req.params);
  const device = await resolveDevice(req);
  res.json(await insightsService.getInsight(device, insightId));
}

export async function reanalyzeInsight(req: Request, res: Response) {
  const { insightId } = insightIdSchema.parse(req.params);
  const device = await resolveWritableDevice(req);
  res.json(await insightsService.reanalyze(device, insightId));
}

export async function listAlerts(req: Request, res: Response) {
  const query = alertQuerySchema.parse(req.query);
  const device = await resolveDevice(req);
  res.json(await insightsService.listAlerts(device, query));
}

export async function markAlertRead(req: Request, res: Response) {
  const { alertId } = alertIdSchema.parse(req.params);
  const device = await resolveWritableDevice(req);
  res.json(await insightsService.markAlertRead(device, alertId));
}

export async function markAllAlertsRead(req: Request, res: Response) {
  const device = await resolveWritableDevice(req);
  res.json(await insightsService.markAllAlertsRead(device));
}

export async function getScreenConfig(req: Request, res: Response) {
  const device = await resolveDevice(req);
  res.json(await insightsService.getScreenConfig(device));
}

export async function updateScreenConfig(req: Request, res: Response) {
  const patch = updateScreenConfigSchema.parse(req.body);
  const device = await resolveWritableDevice(req);
  // 记录是谁改的，便于审计（截屏开关是敏感设置）
  const userId = currentUserId(req);
  res.json({ success: true, userId, config: await insightsService.updateScreenConfig(device, patch) });
}

export async function listBudgets(req: Request, res: Response) {
  const device = await resolveDevice(req);
  res.json(await insightsService.listBudgets(device));
}

export async function upsertBudget(req: Request, res: Response) {
  const input = upsertBudgetSchema.parse(req.body);
  const device = await resolveWritableDevice(req);
  res.json(await insightsService.upsertBudget(device, input));
}

export async function removeBudget(req: Request, res: Response) {
  const { budgetId } = budgetIdSchema.parse(req.params);
  const device = await resolveWritableDevice(req);
  res.json(await insightsService.removeBudget(device, budgetId));
}

export async function usageSummary(req: Request, res: Response) {
  const device = await resolveDevice(req);
  res.json(await insightsService.usageSummary(device));
}

// ============================================================
// 路由
// ============================================================

/** /api/agent 下新增的屏幕相关接口（由 agent.routes.ts 挂载） */
export const screenAgentRoutes = Router();
screenAgentRoutes.post(
  '/screen-batches',
  authenticateDevice,
  screenUpload.single('file'),
  ah(uploadScreenBatch),
);
screenAgentRoutes.get('/screen-quiz/next', authenticateDevice, ah(nextScreenQuestion));
screenAgentRoutes.post('/screen-quiz/answer', authenticateDevice, ah(answerScreenQuestion));

/**
 * /api/insights —— 家长端时间线
 *
 * 整条路由归**超级会员**（权益 aiInsight）：AI 洞察 = 屏幕洞察 + AI 画面分析 + 异常提醒。
 * 家长端在拉数据之前会先看档位，非超级会员直接渲染升级卡片，正常不会走到这里的 403；
 * 这里的门禁是防「绕过界面直接打接口」。
 */
export const insightRoutes = Router();
insightRoutes.use(authenticate);
insightRoutes.use(entitlementGate('aiInsight'));
insightRoutes.get('/', ah(listInsights));
insightRoutes.get('/:insightId', ah(getInsight));
insightRoutes.post('/:insightId/reanalyze', ah(reanalyzeInsight));

/** /api/alerts —— 异常提醒 */
export const alertRoutes = Router();
alertRoutes.use(authenticate);
alertRoutes.use(entitlementGate('aiInsight'));
alertRoutes.get('/', ah(listAlerts));
alertRoutes.post('/read-all', ah(markAllAlertsRead));
alertRoutes.post('/:alertId/read', ah(markAlertRead));

/** /api/screen-monitor —— 截屏与 AI 设置 */
export const screenConfigRoutes = Router();
screenConfigRoutes.use(authenticate);
screenConfigRoutes.use(entitlementGate('aiInsight'));
screenConfigRoutes.get('/', ah(getScreenConfig));
screenConfigRoutes.put('/', ah(updateScreenConfig));

/**
 * /api/usage-budgets —— 玩几局 / 看几集
 *
 * **不加会员门禁**：用量上限属于基础管控（每日使用时长对任何账号都可用）。
 * 局数/集数那两条依赖「屏幕洞察」，设备上没开时本来就只是不生效，
 * 家长端也已经用琥珀色提示说明了这一点 —— 在这里整页 403 反而把
 * 时长限制也一起挡掉了。
 */
export const usageBudgetRoutes = Router();
usageBudgetRoutes.use(authenticate);
usageBudgetRoutes.get('/', ah(listBudgets));
usageBudgetRoutes.put('/', ah(upsertBudget));
usageBudgetRoutes.delete('/:budgetId', ah(removeBudget));

/** /api/usage-summary —— 今日用量 */
export const usageSummaryRoutes = Router();
usageSummaryRoutes.use(authenticate);
usageSummaryRoutes.get('/', ah(usageSummary));
