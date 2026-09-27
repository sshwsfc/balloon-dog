import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { ah } from '../../shared/asyncHandler';
import { authenticate } from '../../middleware/auth';
import { config } from '../../config';
import * as controller from './auth.controller';

const router = Router();

/**
 * 认证类接口单独限流：发码/登录是撞库和短信轰炸的主要目标，
 * 不能和普通业务接口共用一个宽松阈值。
 *
 * `skipSuccessfulRequests: true`：只有失败请求才计入配额。成功的登录/发码
 * 不应该消耗额度 —— 否则同一出口 IP 下的多个家庭成员会互相挤掉配额。
 */
const authLimiter = rateLimit({
  windowMs: 60_000,
  max: config.AUTH_RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: {
    title: 'TOO_MANY_REQUESTS',
    status: 429,
    message: '操作过于频繁，请稍后再试',
    detail: null,
    errors: null,
  },
});

// ---- 手机号 + 密码 ----
router.post('/send-code', authLimiter, ah(controller.sendCode));
router.post('/register', authLimiter, ah(controller.register));
router.post('/login', authLimiter, ah(controller.login));
router.post('/sms-login', authLimiter, ah(controller.smsLogin));
router.post('/logout', ah(controller.logout));

// ---- 微信扫码登录 ----
router.get('/wechat/qr', ah(controller.wechatQr));
router.get('/wechat/state', ah(controller.wechatState));
router.get('/wechat/authorize-url', ah(controller.wechatAuthorizeUrl));
router.post('/wechat/dev-scan', authLimiter, ah(controller.wechatDevScan));
router.get('/wechat/callback', ah(controller.wechatCallback));

// ---- 资料（需登录）----
router.get('/profile', authenticate, ah(controller.getProfile));
router.put('/profile', authenticate, ah(controller.updateProfile));
router.post('/change-password', authenticate, ah(controller.changePassword));
router.post('/bind-phone', authenticate, ah(controller.bindPhone));

export const authRoutes = router;

/**
 * /api/user —— 前端历史上把「用户资料」放在这个前缀下（GET/PUT /api/user/info）。
 * 保留同一套处理器，避免前端为了改路径而大改。
 */
export const userInfoRoutes = Router();
userInfoRoutes.use(authenticate);
userInfoRoutes.get('/info', ah(controller.getProfile));
userInfoRoutes.put('/info', ah(controller.updateProfile));
