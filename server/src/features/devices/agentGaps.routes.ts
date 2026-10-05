import { Router } from 'express';
import { ah } from '../../shared/asyncHandler';
import { authenticateDevice } from '../../middleware/auth';
import * as controller from './agent.controller';

/**
 * 设备端「补齐管控闭环」接口（§3 应用审核 / §4 逐应用用量 / §8 电话短信）。
 *
 * 挂到 /api/agent 下（见 agent.routes.ts）。与 screenAgentRoutes / modeAgentRoutes
 * 一样，本模块内部统一挂 authenticateDevice，路由表上不用再逐条重复。
 * 路径前缀 '/'：这些接口在 /api/agent 下就是顶层路径（/audit-requests 等）。
 */
export const agentGapsRoutes = Router();

agentGapsRoutes.use(authenticateDevice);

// §3 应用安装审核：申请 + 轮询结果
agentGapsRoutes.post('/audit-requests', ah(controller.createAuditRequest));
agentGapsRoutes.get('/audit-requests/:id', ah(controller.getAuditRequest));

// §4 今日逐应用用量（全量替换）
agentGapsRoutes.post('/app-usage', ah(controller.reportAppUsage));

// §8 通话记录与短信（全量替换最近 N 条）
agentGapsRoutes.post('/calls', ah(controller.reportCalls));
agentGapsRoutes.post('/sms', ah(controller.reportSms));
