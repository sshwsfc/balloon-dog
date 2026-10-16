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
import { adminAudit } from './features/admin/admin.audit';
import { flagAdminRoutes } from './features/flags/flags.controller';
import { alertAdminRoutes } from './features/opsalert/alerts.controller';
import { supportRoutes, ticketAdminRoutes } from './features/support/support.controller';
import { quizRoutes } from './features/quiz/quiz.controller';
import { locationRoutes, safeZoneRoutes } from './features/locations/locations.controller';
import { childrenRoutes } from './features/children/children.controller';
import { privacyRoutes } from './features/privacy/privacy.controller';
import {
  paymentAdminRoutes,
  paymentNotifyRoutes,
  paymentRoutes,
} from './features/payments/payments.controller';
import { notificationRoutes } from './features/notifications/notifications.controller';
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
  appIconRoutes,
  eyeCareRoutes,
  appPluginRoutes,
  deviceEventRoutes,
} from './features/mode/mode.controller';
import { membershipRoutes } from './features/membership/membership.controller';
import { referralRoutes } from './features/referral/referral.controller';

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

  // 4mb 而不是 1mb：孩子端上报应用清单时会顺带带上应用图标的 base64
  // （每个约 2~4KB，几百个可启动应用就是几百 KB）。图标只在应用有增删时才会重传，
  // 平时心跳/上报都是小包。
  //
  // 支付回调**必须在 json 解析之前**：微信 v3 的签名是对原始字节算的，
  // 先 parse 再签名比对必然失败。所以先用 express.raw 把这一条路径截下来
  // （`type: '*/*'` 是因为支付宝的回调是 form-urlencoded、微信是 JSON）。
  app.use(
    '/api/payments/notify',
    express.raw({ type: '*/*', limit: '256kb' }),
    paymentNotifyRoutes,
  );
  app.use(express.json({ limit: '4mb' }));
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

  /*
   * 全局限流，按 IP 计数。
   *
   * 跑 `npm run e2e:responsive` 前记得把 RATE_LIMIT_MAX 调大：那个套件是
   * 5 档视口 × 17 路由的整页重载，峰值 300+ 请求/分钟，正好压在默认配额上。
   * 一旦被限流，前端拿不到 /api/user/info 就退化成未登录、弹回 /login，
   * e2e 于是报成「页面上找不到「设备」」这种看不出真因的假失败。
   */
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
  // §5.2 孩子档案与今日任务：账号级（不是设备级），档案属于家长
  app.use('/api/children', childrenRoutes);
  // §5.3 合规：同意留痕 / 数据导出 / 注销（账号级）
  app.use('/api/privacy', privacyRoutes);
  app.use('/api/payments', paymentRoutes);
  // §5.5 客服工单：家长提交与查看进度（入口由灰度开关控制）
  app.use('/api/support', supportRoutes);
  // 后台审计挂在整个 /api/admin 前缀上，而不是某个 router 内部：后台路由分散在
  // /api/admin、/api/admin/payments、/api/admin/flags 等多个挂载点，任何一个新挂载点
  // 忘了带审计，都会在 OperationLog 里留下一个看不见的缺口（这正是 payments 曾经的漏洞）。
  // 放在鉴权之前，失败与 401 的尝试同样被记录。
  app.use('/api/admin', adminAudit);
  // 管理端的支付路由要挂在 /api/admin 之前，否则会被 adminRoutes 先接走
  app.use('/api/admin/payments', paymentAdminRoutes);
  app.use('/api/admin/flags', flagAdminRoutes);
  app.use('/api/admin/alerts', alertAdminRoutes);
  app.use('/api/admin/tickets', ticketAdminRoutes);
  app.use('/api/media', mediaRoutes);
  app.use('/api/lock-policy', lockPolicyRoutes);
  app.use('/api/schedules', scheduleRoutes);
  app.use('/api/insights', insightRoutes);
  app.use('/api/alerts', alertRoutes);
  app.use('/api/screen-monitor', screenConfigRoutes);
  app.use('/api/usage-budgets', usageBudgetRoutes);
  app.use('/api/usage-summary', usageSummaryRoutes);
  app.use('/api/membership', membershipRoutes);
  app.use('/api/referral', referralRoutes);
  app.use('/api/device-mode', deviceModeRoutes);
  app.use('/api/study-slots', studySlotRoutes);
  app.use('/api/mode-apps', modeAppRoutes);
  app.use('/api/device-apps', deviceAppRoutes);
  // 图标走签名 URL（<img> 带不了 Authorization 头），不能挂在上面那个 router 下
  app.use('/api/app-icons', appIconRoutes);
  app.use('/api/eye-care', eyeCareRoutes);
  app.use('/api/app-plugins', appPluginRoutes);
  app.use('/api/device-events', deviceEventRoutes);
  app.use('/api/notifications', notificationRoutes);
  app.use('/api/agent', agentRoutes);
  app.use('/api/admin', adminRoutes);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}
