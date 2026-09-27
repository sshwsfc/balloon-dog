import { Router, Request, Response } from 'express';
import { ah } from '../../shared/asyncHandler';
import { authenticate, authenticateDevice } from '../../middleware/auth';
import { currentUserId, resolveDevice } from '../../shared/deviceScope';
import { devicesRepo } from '../devices/devices.repository';
import { quizService } from './quiz.service';
import {
  createQuestionSchema,
  quizQuestionQuerySchema,
  quizRecordsQuerySchema,
  submitAnswerSchema,
  updateQuizConfigSchema,
} from './quiz.dto';
import { NotFoundError } from '../../errors';

// ============================================================
// 家长端控制器
// ============================================================

/** GET /api/quiz/config */
export async function getConfig(req: Request, res: Response) {
  const device = await resolveDevice(req);
  res.json(await quizService.getConfig(device));
}

/** PUT /api/quiz/config */
export async function updateConfig(req: Request, res: Response) {
  const patch = updateQuizConfigSchema.parse(req.body);
  const device = await resolveDevice(req);
  res.json({ success: true, config: await quizService.updateConfig(device, patch) });
}

/** GET /api/quiz/question —— 家长端预览题目（不含答案）。 */
export async function previewQuestion(req: Request, res: Response) {
  const query = quizQuestionQuerySchema.parse(req.query);
  const device = await resolveDevice(req);
  res.json(await quizService.previewQuestion(device, query));
}

/** POST /api/quiz/answer —— 家长端自测（真实答题由设备端提交）。 */
export async function submitAnswer(req: Request, res: Response) {
  const { questionId, answer } = submitAnswerSchema.parse(req.body);
  const device = await resolveDevice(req);
  const result = await quizService.answer(device, questionId, answer, {
    recordUserId: currentUserId(req),
  });
  res.json(result);
}

/** GET /api/quiz/records */
export async function listRecords(req: Request, res: Response) {
  const { limit, type } = quizRecordsQuerySchema.parse(req.query);
  const device = await resolveDevice(req);
  res.json({ records: await quizService.listRecords(device, limit, type) });
}

/** GET /api/quiz/statistics */
export async function statistics(req: Request, res: Response) {
  const device = await resolveDevice(req);
  res.json(await quizService.statistics(device));
}

/** POST /api/quiz/questions —— 新增题目（题库维护）。 */
export async function createQuestion(req: Request, res: Response) {
  const input = createQuestionSchema.parse(req.body);
  res.status(201).json(await quizService.createQuestion(input));
}

// ============================================================
// 设备端控制器
// ============================================================

/** 取出设备端当前设备（含归属）。 */
async function currentDeviceForAgent(req: Request) {
  if (req.auth?.kind !== 'device') throw new NotFoundError('设备');
  const device = await devicesRepo.findById(req.auth.id);
  if (!device) throw new NotFoundError('设备', req.auth.id);
  return device;
}

/** GET /api/agent/quiz/question —— 设备端取题。 */
export async function agentNextQuestion(req: Request, res: Response) {
  const device = await currentDeviceForAgent(req);
  res.json(await quizService.nextQuestionForDevice(device));
}

/** POST /api/agent/quiz/answer —— 设备端交卷。 */
export async function agentSubmitAnswer(req: Request, res: Response) {
  const { questionId, answer } = submitAnswerSchema.parse(req.body);
  const device = await currentDeviceForAgent(req);
  res.json(await quizService.answer(device, questionId, answer));
}

// ============================================================
// 路由
// ============================================================

/** /api/quiz —— 家长端 */
export const quizRoutes = Router();
quizRoutes.use(authenticate);
quizRoutes.get('/config', ah(getConfig));
quizRoutes.put('/config', ah(updateConfig));
quizRoutes.get('/question', ah(previewQuestion));
quizRoutes.post('/answer', ah(submitAnswer));
quizRoutes.get('/records', ah(listRecords));
quizRoutes.get('/statistics', ah(statistics));
quizRoutes.post('/questions', ah(createQuestion));

/** /api/agent/quiz —— 设备端 */
export const quizAgentRoutes = Router();
quizAgentRoutes.use(authenticateDevice);
quizAgentRoutes.get('/question', ah(agentNextQuestion));
quizAgentRoutes.post('/answer', ah(agentSubmitAnswer));
