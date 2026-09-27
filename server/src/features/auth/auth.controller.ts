import { Request, Response } from 'express';
import {
  sendCodeSchema,
  registerSchema,
  loginSchema,
  smsLoginSchema,
  wechatStateSchema,
  wechatDevScanSchema,
  updateProfileSchema,
  changePasswordSchema,
  bindPhoneSchema,
} from './auth.dto';
import { authService } from './auth.service';
import { currentUserId } from '../../shared/deviceScope';
import { config } from '../../config';
import { logger } from '../../logger';

/** POST /api/auth/send-code —— 发送短信验证码。 */
export async function sendCode(req: Request, res: Response) {
  const { phone, purpose } = sendCodeSchema.parse(req.body);
  const result = await authService.sendCode(phone, purpose);
  res.json({
    success: true,
    message: '验证码已发送',
    ttlSeconds: result.ttlSeconds,
    // devCode 仅在未配置真实短信通道的本地联调模式下返回
    ...(result.devCode ? { devCode: result.devCode } : {}),
  });
}

/** POST /api/auth/register */
export async function register(req: Request, res: Response) {
  const { phone, password, code, nickname } = registerSchema.parse(req.body);
  const result = await authService.register(phone, password, code, nickname);
  res.status(201).json({ success: true, ...result });
}

/** POST /api/auth/login */
export async function login(req: Request, res: Response) {
  const { phone, identifier, password } = loginSchema.parse(req.body);
  const result = await authService.login((phone ?? identifier)!, password);
  res.json({ success: true, ...result });
}

/** POST /api/auth/sms-login —— 验证码登录（无密码，首次自动注册）。 */
export async function smsLogin(req: Request, res: Response) {
  const { phone, code } = smsLoginSchema.parse(req.body);
  const result = await authService.smsLogin(phone, code);
  res.json({ success: true, ...result });
}

/** POST /api/auth/logout —— 无状态 JWT，服务端只记日志，实际清理在前端。 */
export async function logout(req: Request, res: Response) {
  if (req.auth?.kind === 'user') {
    logger.info({ msg: 'user logout', userId: req.auth.id });
  }
  res.json({ success: true });
}

// ---------------- 微信扫码登录 ----------------

/** GET /api/auth/wechat/qr —— 创建扫码会话。 */
export async function wechatQr(_req: Request, res: Response) {
  res.json(authService.createWechatQr());
}

/** GET /api/auth/wechat/state —— 轮询扫码状态。 */
export async function wechatState(req: Request, res: Response) {
  const { state } = wechatStateSchema.parse(req.query);
  res.json(authService.queryWechatState(state));
}

/** GET /api/auth/wechat/authorize-url —— 微信内置浏览器直接授权跳转。 */
export async function wechatAuthorizeUrl(req: Request, res: Response) {
  const redirectAfter = typeof req.query.redirect === 'string' ? req.query.redirect : '';
  res.json(authService.wechatAuthorizeUrl(redirectAfter));
}

/** POST /api/auth/wechat/dev-scan —— 本地联调模拟扫码。 */
export async function wechatDevScan(req: Request, res: Response) {
  const { state } = wechatDevScanSchema.parse(req.body);
  await authService.devWechatScan(state);
  res.json({ success: true, status: 'scanned' });
}

/**
 * GET /api/auth/wechat/callback —— 微信授权回调。
 *
 * 两种承载方式都要支持：
 *  - PC 扫码：用户在微信里确认后，微信把浏览器（可能嵌在 iframe 里）跳到这里；
 *    返回的 HTML 用 postMessage 把 token 通知父窗口。
 *  - 微信内置浏览器整页授权：不在 iframe 内时，直接 302 跳回前端登录页并带上 token。
 *
 * 因此必须移除 helmet 的 X-Frame-Options，否则回调页无法被 iframe 加载。
 */
export async function wechatCallback(req: Request, res: Response) {
  const rawState = String(req.query.state || '');
  const code = String(req.query.code || '');
  const loginUrl = `${config.CLIENT_URL}/login`;

  res.removeHeader('X-Frame-Options');

  const sendResult = (type: 'success' | 'error', payload: string, redirectAfter: string) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'unsafe-inline'");
    const isSuccess = type === 'success';
    const color = isSuccess ? '#07c160' : '#fa5151';
    const text = isSuccess ? '微信登录成功，正在返回…' : `微信登录失败：${payload}`;
    // 回跳地址优先用 state 里带的（微信内置浏览器场景），否则用配置的登录页
    const fallback = redirectAfter || loginUrl;
    res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>微信登录</title></head><body><script>
      (function () {
        var payload = { source: 'balloon-dog-wx-login', type: '${type}', ${isSuccess ? 'token' : 'message'}: ${JSON.stringify(payload)} };
        var isTop = (window.self === window.top);
        // 1) 通知父窗口（PC 扫码弹窗：前端监听后落地并关闭弹窗）
        try { window.parent.postMessage(payload, '*'); } catch (e) {}
        // 2) 顶层窗口：跳回登录页并带上结果
        if (isTop) {
          var base = ${JSON.stringify(fallback)};
          var sep = base.indexOf('?') >= 0 ? '&' : '?';
          var url = ${isSuccess}
            ? base + sep + 'wx_token=' + encodeURIComponent(payload.token)
            : base + sep + 'wx_error=' + encodeURIComponent(payload.message || '1');
          window.location.replace(url);
          return;
        }
        document.body.innerHTML = '<p style="font-family:-apple-system,sans-serif;font-size:14px;color:${color};text-align:center;padding-top:40px;">' + ${JSON.stringify(text)} + '</p>';
      })();
    </script></body></html>`);
  };

  try {
    const { token, redirectAfter } = await authService.wechatCallback(rawState, code);
    sendResult('success', token, redirectAfter);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : '微信登录失败';
    logger.warn({ msg: 'wechat login callback failed', err: message });
    sendResult('error', message, '');
  }
}

// ---------------- 资料 ----------------

/** GET /api/auth/profile （前端历史路径：/api/user/info 也指向同一处理器） */
export async function getProfile(req: Request, res: Response) {
  const user = await authService.getProfile(currentUserId(req));
  res.json(user);
}

/** PUT /api/auth/profile */
export async function updateProfile(req: Request, res: Response) {
  const data = updateProfileSchema.parse(req.body);
  const user = await authService.updateProfile(currentUserId(req), data);
  res.json({ success: true, user });
}

/** POST /api/auth/change-password */
export async function changePassword(req: Request, res: Response) {
  const { oldPassword, newPassword } = changePasswordSchema.parse(req.body);
  res.json(await authService.changePassword(currentUserId(req), oldPassword, newPassword));
}

/** POST /api/auth/bind-phone */
export async function bindPhone(req: Request, res: Response) {
  const { phone, code } = bindPhoneSchema.parse(req.body);
  const user = await authService.bindPhone(currentUserId(req), phone, code);
  res.json({ success: true, user });
}
