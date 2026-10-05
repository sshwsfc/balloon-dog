import express, { Express } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { config } from './config';
import { logger } from './logger';
import { prisma } from './prisma';
import { requestId } from './middleware/requestId';
import { errorHandler } from './middleware/errorHandler';
import { notFound } from './middleware/notFound';
import { authRoutes, userInfoRoutes } from './features/auth/auth.routes';
import {
  callRoutes,
  deviceRoutes,
  devicesRoutes,
  featureRoutes,
  smsRoutes,
  userCompatRoutes,
} from './features/devices/devices.routes';
import { agentRoutes } from './features/devices/agent.routes';
import { adminRoutes } from './features/admin/admin.routes';
import { quizRoutes } from './features/quiz/quiz.controller';
import { locationRoutes, safeZoneRoutes } from './features/locations/locations.controller';
import { mediaRoutes } from './features/media/media.routes';
import { lockPolicyRoutes, scheduleRoutes } from './features/schedule/schedule.controller';
import {
  alertRoutes,
  insightRoutes,
  screenConfigRoutes,
  usageBudgetRoutes,
  usageSummaryRoutes,
} from './features/insights/insights.controller';
import {
  deviceModeRoutes,
  studySlotRoutes,
  modeAppRoutes,
  deviceAppRoutes,
  eyeCareRoutes,
  appPluginRoutes,
  deviceEventRoutes,
} from './features/mode/mode.controller';

/**
 * Express 应用工厂。中间件顺序严格遵循：
 * helmet → cors → body → requestId → 访问日志 → 限流 → 健康检查 → 业务路由 → 404 → 错误处理
 *
 * 这个顺序是有讲究的：404 与错误处理必须在所有路由之后，
 * mock 版把路由注册在 app.listen() 之后（靠同步执行顺序侥幸生效），
 * 一旦有人在中间插入 await 就会静默 404 —— 这里从结构上杜绝。
 */
export function createApp(): Express {
  const app = express();

  // 反向代理后要拿到真实客户端 IP（限流按 IP 计数，拿不到真实 IP 就形同虚设）
  app.set('trust proxy', 1);

  app.use(helmet());

  app.use(
    cors({
      origin: config.CORS_ORIGIN.split(',').map((s) => s.trim()),
      credentials: true,
    }),
  );

  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true, limit: '1mb' }));
  app.use(requestId);

  // 结构化访问日志（按 requestId 串联）
  app.use((req, res, next) => {
    const child = logger.child({ requestId: req.requestId });
    const start = Date.now();
    res.on('finish', () => {
      child.info({
        msg: 'request',
        method: req.method,
        path: req.path,
        status: res.statusCode,
        duration_ms: Date.now() - start,
      });
    });
    next();
  });

  // 全局限流
  app.use(
    rateLimit({
      windowMs: 60_000,
      max: config.RATE_LIMIT_MAX,
      standardHeaders: true,
      legacyHeaders: false,
    }),
  );

  // ---- 健康检查 ----
  app.get('/health', (_req, res) => res.json({ status: 'ok', env: config.NODE_ENV }));
  app.get('/ready', async (_req, res) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      res.json({ status: 'ok', checks: { database: 'ok' } });
    } catch {
      // 不向外部暴露数据库错误细节，仅标记降级
      res.status(503).json({ status: 'degraded', checks: { database: 'error' } });
    }
  });

  // ---- 业务路由 ----
  app.use('/api/auth', authRoutes);
  app.use('/api/user', userInfoRoutes);
  app.use('/api/user', userCompatRoutes);
  app.use('/api/devices', devicesRoutes);
  app.use('/api/device', deviceRoutes);
  app.use('/api/features', featureRoutes);
  // §8 通话记录与短信：只面向家长；管理后台不挂这两条，只给计数
  app.use('/api/calls', callRoutes);
  app.use('/api/sms', smsRoutes);
  app.use('/api/quiz', quizRoutes);
  app.use('/api/locations', locationRoutes);
  app.use('/api/safe-zones', safeZoneRoutes);
  app.use('/api/media', mediaRoutes);
  app.use('/api/lock-policy', lockPolicyRoutes);
  app.use('/api/schedules', scheduleRoutes);
  app.use('/api/insights', insightRoutes);
  app.use('/api/alerts', alertRoutes);
  app.use('/api/screen-monitor', screenConfigRoutes);
  app.use('/api/usage-budgets', usageBudgetRoutes);
  app.use('/api/usage-summary', usageSummaryRoutes);
  app.use('/api/device-mode', deviceModeRoutes);
  app.use('/api/study-slots', studySlotRoutes);
  app.use('/api/mode-apps', modeAppRoutes);
  app.use('/api/device-apps', deviceAppRoutes);
  app.use('/api/eye-care', eyeCareRoutes);
  app.use('/api/app-plugins', appPluginRoutes);
  app.use('/api/device-events', deviceEventRoutes);
  app.use('/api/agent', agentRoutes);
  app.use('/api/admin', adminRoutes);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}
