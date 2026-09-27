import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { ah } from '../../shared/asyncHandler';
import { authenticateAdmin, requireSuperAdmin } from '../../middleware/auth';
import { config } from '../../config';
import { adminAudit } from './admin.audit';
import * as controller from './admin.controller';

/**
 * /api/admin —— 管理后台专用接口。
 *
 * 三层防护：
 *  1. adminAudit：记录该路由下**所有**请求（含登录失败的尝试）；
 *  2. 独立限流：登录接口单独收紧，防后台账号爆破；
 *  3. authenticateAdmin + requireSuperAdmin：管理员令牌鉴权，敏感的账号管理再要超级管理员。
 *
 * 与家长端是两条完全独立的通道：家长令牌访问这里会 401，管理员令牌访问家长接口同样 401。
 */
export const adminRoutes = Router();

// 审计挂在最前面：无论后面成功、失败还是 401，都会被记录
adminRoutes.use(adminAudit);

/**
 * 登录接口单独限流：后台账号价值高，是爆破的首要目标。
 *
 * `skipSuccessfulRequests: true` 很关键 —— 只统计**失败**尝试：
 *  - 安全上不受影响：爆破本来就是靠失败请求试探，失败仍被限到 10 次/分钟；
 *  - 可用性上避免误伤：多个管理员在同一出口 IP（公司 NAT）正常登录时，
 *    不会因为「别人刚登录过」而被自己的成功登录挤掉配额。
 */
const loginLimiter = rateLimit({
  windowMs: 60_000,
  max: config.ADMIN_LOGIN_RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: {
    title: 'TOO_MANY_REQUESTS',
    status: 429,
    message: '尝试过于频繁，请稍后再试',
    detail: null,
    errors: null,
  },
});

// ---- 公开 ----
adminRoutes.post('/login', loginLimiter, ah(controller.login));

// ---- 以下全部需要管理员令牌 ----
adminRoutes.use(authenticateAdmin);

adminRoutes.get('/profile', ah(controller.getProfile));
adminRoutes.post('/password', ah(controller.changeOwnPassword));
adminRoutes.get('/stats', ah(controller.stats));

// 家长账号
adminRoutes.get('/users', ah(controller.listUsers));
adminRoutes.get('/users/:userId', ah(controller.getUser));
adminRoutes.patch('/users/:userId/status', ah(controller.setUserStatus));
adminRoutes.delete('/users/:userId', ah(controller.removeUser));

// 设备
adminRoutes.get('/devices', ah(controller.listDevices));
adminRoutes.get('/devices/:deviceId', ah(controller.getDevice));
adminRoutes.post('/devices/:deviceId/unbind', ah(controller.unbindDevice));
adminRoutes.delete('/devices/:deviceId', ah(controller.removeDevice));

// 指令监控
adminRoutes.get('/commands', ah(controller.listCommands));
adminRoutes.post('/commands/:commandId/cancel', ah(controller.cancelCommand));

// 题库
adminRoutes.get('/questions', ah(controller.listQuestions));
adminRoutes.post('/questions', ah(controller.createQuestion));
adminRoutes.patch('/questions/:questionId', ah(controller.updateQuestion));
adminRoutes.delete('/questions/:questionId', ah(controller.removeQuestion));

// 答题记录
adminRoutes.get('/quiz-records', ah(controller.listQuizRecords));

// 短信验证码审计
adminRoutes.get('/sms-codes', ah(controller.listSmsCodes));
adminRoutes.post('/sms-codes/purge', ah(controller.purgeSmsCodes));

// 操作日志
adminRoutes.get('/logs', ah(controller.listLogs));

// 管理员账号管理：仅超级管理员
adminRoutes.get('/admins', ah(controller.listAdmins));
adminRoutes.post('/admins', requireSuperAdmin, ah(controller.createAdmin));
adminRoutes.patch('/admins/:id/password', requireSuperAdmin, ah(controller.resetAdminPassword));
adminRoutes.patch('/admins/:id/status', requireSuperAdmin, ah(controller.setAdminStatus));
adminRoutes.delete('/admins/:id', requireSuperAdmin, ah(controller.removeAdmin));
