import { Router } from 'express';
import { ah } from '../../shared/asyncHandler';
import { authenticateDevice } from '../../middleware/auth';
import * as controller from './agent.controller';
import { mediaAgentRoutes } from '../media/media.routes';
import { quizAgentRoutes } from '../quiz/quiz.controller';
import { screenAgentRoutes } from '../insights/insights.controller';
import { modeAgentRoutes } from '../mode/mode.controller';
import { agentGapsRoutes } from './agentGaps.routes';

/**
 * /api/agent —— 孩子设备上的 Agent 专用接口。
 * 除 /register（凭设备码 + 设备密钥自助注册）外，全部要求设备令牌。
 *
 * 这里逐条挂 authenticateDevice（而不是 use 一个大范围中间件），
 * 是为了让「哪些接口需要设备鉴权」在路由表上一眼可见，
 * 避免以后有人新增接口时被前面那个 use 默默保护、误以为不需要鉴权。
 */
export const agentRoutes = Router();

agentRoutes.post('/register', ah(controller.register));

agentRoutes.post('/heartbeat', authenticateDevice, ah(controller.heartbeat));
agentRoutes.get('/commands/next', authenticateDevice, ah(controller.nextCommand));
agentRoutes.post('/commands/:commandId/result', authenticateDevice, ah(controller.reportCommandResult));
agentRoutes.post('/locations', authenticateDevice, ah(controller.reportLocation));
agentRoutes.get('/config', authenticateDevice, ah(controller.getConfig));

// 子域路由（各自内部已挂设备鉴权）
agentRoutes.use('/media', mediaAgentRoutes);
agentRoutes.use('/quiz', quizAgentRoutes);

// 屏幕行为洞察：截屏包上传 + 屏幕相关答题。
// 每个子路由内部各自挂 authenticateDevice，与上面的风格保持一致。
agentRoutes.use('/', screenAgentRoutes);

// 应用清单上报 + 设备事件上报（最新动态）。
agentRoutes.use('/', modeAgentRoutes);

// 应用审核申请 / 逐应用用量 / 通话短信上报。
agentRoutes.use('/', agentGapsRoutes);
