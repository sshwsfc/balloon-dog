import { Request, Response } from 'express';
import {
  adminChangeOwnPasswordSchema,
  adminLoginSchema,
  createAdminSchema,
  createQuestionSchema,
  listCommandsQuerySchema,
  listDevicesQuerySchema,
  listLogsQuerySchema,
  listQuestionsQuerySchema,
  listQuizRecordsQuerySchema,
  listSmsCodesQuerySchema,
  listUsersQuerySchema,
  resetAdminPasswordSchema,
  setAdminStatusSchema,
  setUserStatusSchema,
  statsQuerySchema,
  updateQuestionSchema,
} from './admin.dto';
import { adminService } from './admin.service';
import { currentAdmin } from '../../middleware/auth';

/** 统一取路径参数并断言非空（Express 5 下 params 值可能为 string | string[]）。 */
function param(req: Request, name: string): string {
  const value = req.params[name];
  return Array.isArray(value) ? value[0] : String(value);
}

function intParam(req: Request, name: string): number {
  const value = Number.parseInt(param(req, name), 10);
  // 非法 id 交给 service 的 findUnique 处理，这里只保证类型是数字
  return Number.isFinite(value) ? value : -1;
}

// ============================================================
// 认证
// ============================================================

/** POST /api/admin/login */
export async function login(req: Request, res: Response) {
  const { username, password } = adminLoginSchema.parse(req.body);
  res.json({ success: true, ...(await adminService.login(username, password)) });
}

/** GET /api/admin/profile */
export async function getProfile(req: Request, res: Response) {
  res.json(await adminService.getProfile(currentAdmin(req).id));
}

/** POST /api/admin/password —— 修改自己的密码 */
export async function changeOwnPassword(req: Request, res: Response) {
  const { oldPassword, newPassword } = adminChangeOwnPasswordSchema.parse(req.body);
  res.json(await adminService.changeOwnPassword(currentAdmin(req).id, oldPassword, newPassword));
}

// ============================================================
// 管理员账号管理（仅超级管理员）
// ============================================================

/** GET /api/admin/admins */
export async function listAdmins(_req: Request, res: Response) {
  res.json({ admins: await adminService.listAdmins() });
}

/** POST /api/admin/admins */
export async function createAdmin(req: Request, res: Response) {
  const input = createAdminSchema.parse(req.body);
  res.status(201).json({ success: true, admin: await adminService.createAdmin(input) });
}

/** PATCH /api/admin/admins/:id/password */
export async function resetAdminPassword(req: Request, res: Response) {
  const { password } = resetAdminPasswordSchema.parse(req.body);
  res.json(await adminService.resetAdminPassword(intParam(req, 'id'), password, currentAdmin(req).id));
}

/** PATCH /api/admin/admins/:id/status */
export async function setAdminStatus(req: Request, res: Response) {
  const { status } = setAdminStatusSchema.parse(req.body);
  res.json(await adminService.setAdminStatus(intParam(req, 'id'), status, currentAdmin(req).id));
}

/** DELETE /api/admin/admins/:id */
export async function removeAdmin(req: Request, res: Response) {
  res.json(await adminService.removeAdmin(intParam(req, 'id'), currentAdmin(req).id));
}

// ============================================================
// 数据看板
// ============================================================

/** GET /api/admin/stats */
export async function stats(req: Request, res: Response) {
  const { days } = statsQuerySchema.parse(req.query);
  res.json(await adminService.stats(days));
}

// ============================================================
// 家长账号
// ============================================================

/** GET /api/admin/users */
export async function listUsers(req: Request, res: Response) {
  const query = listUsersQuerySchema.parse(req.query);
  res.json(await adminService.listUsers(query));
}

/** GET /api/admin/users/:userId */
export async function getUser(req: Request, res: Response) {
  res.json(await adminService.getUserDetail(intParam(req, 'userId')));
}

/** PATCH /api/admin/users/:userId/status */
export async function setUserStatus(req: Request, res: Response) {
  const { status } = setUserStatusSchema.parse(req.body);
  res.json(await adminService.setUserStatus(intParam(req, 'userId'), status));
}

/** DELETE /api/admin/users/:userId */
export async function removeUser(req: Request, res: Response) {
  res.json(await adminService.removeUser(intParam(req, 'userId')));
}

// ============================================================
// 设备
// ============================================================

/** GET /api/admin/devices */
export async function listDevices(req: Request, res: Response) {
  const query = listDevicesQuerySchema.parse(req.query);
  res.json(await adminService.listDevices(query));
}

/** GET /api/admin/devices/:deviceId */
export async function getDevice(req: Request, res: Response) {
  res.json(await adminService.getDeviceDetail(param(req, 'deviceId')));
}

/** POST /api/admin/devices/:deviceId/unbind */
export async function unbindDevice(req: Request, res: Response) {
  res.json(await adminService.forceUnbindDevice(param(req, 'deviceId')));
}

/** DELETE /api/admin/devices/:deviceId */
export async function removeDevice(req: Request, res: Response) {
  res.json(await adminService.removeDevice(param(req, 'deviceId')));
}

// ============================================================
// 指令监控
// ============================================================

/** GET /api/admin/commands */
export async function listCommands(req: Request, res: Response) {
  const query = listCommandsQuerySchema.parse(req.query);
  res.json(await adminService.listCommands(query));
}

/** POST /api/admin/commands/:commandId/cancel */
export async function cancelCommand(req: Request, res: Response) {
  res.json(await adminService.cancelCommand(param(req, 'commandId')));
}

// ============================================================
// 题库
// ============================================================

/** GET /api/admin/questions */
export async function listQuestions(req: Request, res: Response) {
  const query = listQuestionsQuerySchema.parse(req.query);
  res.json(await adminService.listQuestions(query));
}

/** POST /api/admin/questions */
export async function createQuestion(req: Request, res: Response) {
  const input = createQuestionSchema.parse(req.body);
  res.status(201).json({ success: true, question: await adminService.createQuestion(input) });
}

/** PATCH /api/admin/questions/:questionId */
export async function updateQuestion(req: Request, res: Response) {
  const patch = updateQuestionSchema.parse(req.body);
  res.json({ success: true, question: await adminService.updateQuestion(param(req, 'questionId'), patch) });
}

/** DELETE /api/admin/questions/:questionId */
export async function removeQuestion(req: Request, res: Response) {
  res.json(await adminService.removeQuestion(param(req, 'questionId')));
}

// ============================================================
// 答题记录
// ============================================================

/** GET /api/admin/quiz-records */
export async function listQuizRecords(req: Request, res: Response) {
  const query = listQuizRecordsQuerySchema.parse(req.query);
  res.json(await adminService.listQuizRecords(query));
}

// ============================================================
// 短信验证码审计
// ============================================================

/** GET /api/admin/sms-codes */
export async function listSmsCodes(req: Request, res: Response) {
  const query = listSmsCodesQuerySchema.parse(req.query);
  res.json(await adminService.listSmsCodes(query));
}

/** POST /api/admin/sms-codes/purge */
export async function purgeSmsCodes(_req: Request, res: Response) {
  res.json(await adminService.purgeSmsCodes());
}

// ============================================================
// 操作日志
// ============================================================

/** GET /api/admin/logs */
export async function listLogs(req: Request, res: Response) {
  const query = listLogsQuerySchema.parse(req.query);
  res.json(await adminService.listLogs(query));
}
