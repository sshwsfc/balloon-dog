import crypto from 'node:crypto';
import { config, wechatLoginConfigured } from '../../config';
import { logger } from '../../logger';
import { BadRequestError, ServiceUnavailableError } from '../../errors';

/**
 * 微信登录。
 *
 * 两种模式：
 *  - 真实模式：配置了 WECHAT_LOGIN_APP_ID + WECHAT_LOGIN_APP_SECRET 后，
 *    PC 端走 open.weixin.qq.com/connect/qrconnect 扫码（网站应用），
 *    微信内置浏览器走 oauth2/authorize（公众号网页授权）。
 *  - 本地联调模式：未配置时提供 dev-scan 接口模拟「扫码并授权」，
 *    让前端能在没有微信账号的情况下把整个登录态流程跑通。
 *
 * 扫码是轮询模型：
 *  1. 前端 createQr → 后端生成 state 并建会话，返回二维码内容；
 *  2. 前端每 2s queryState(state)：pending 继续等，done 拿到 token 落地登录；
 *  3. 微信回调 /api/auth/wechat/callback?code=&state= → 换 openid → 查/建用户 →
 *     签发 token → 写回会话。
 *
 * ⚠️ 会话存在进程内存里（TTL 10 分钟）。单实例部署没问题；
 * 若要多实例，需要把 sessions 换成 Redis/数据库（会话本身是短命数据，丢了只会让用户重扫）。
 */

interface QrSession {
  createdAt: number;
  status: 'pending' | 'done';
  token?: string;
  user?: unknown;
}

const sessions = new Map<string, QrSession>();
const SESSION_TTL_MS = 10 * 60 * 1000;

/** state → 会话的容量上限，防止被刷爆内存。 */
const MAX_SESSIONS = 5_000;

function gcSessions(): void {
  const now = Date.now();
  for (const [state, s] of sessions) {
    if (now - s.createdAt > SESSION_TTL_MS) sessions.delete(state);
  }
  // 极端情况下（大量并发扫码）按插入顺序淘汰最早的
  if (sessions.size > MAX_SESSIONS) {
    const excess = sessions.size - MAX_SESSIONS;
    let i = 0;
    for (const state of sessions.keys()) {
      if (i++ >= excess) break;
      sessions.delete(state);
    }
  }
}

/** 微信授权回调地址。 */
export function wechatRedirectUri(): string {
  if (config.WECHAT_LOGIN_REDIRECT_URI) return config.WECHAT_LOGIN_REDIRECT_URI;
  const base = config.PUBLIC_BASE_URL.trim() || `http://localhost:${config.PORT}`;
  return `${base}/api/auth/wechat/callback`;
}

/** PC 扫码授权链接（网站应用，snsapi_login）。 */
function buildQrConnectUrl(state: string): string {
  const appId = config.WECHAT_LOGIN_APP_ID!;
  const redirect = encodeURIComponent(wechatRedirectUri());
  return (
    'https://open.weixin.qq.com/connect/qrconnect?' +
    `appid=${appId}&redirect_uri=${redirect}&response_type=code&scope=snsapi_login&state=${state}` +
    '&self_redirect=true#wechat_redirect'
  );
}

/** 微信内置浏览器网页授权链接（公众号，snsapi_userinfo）。 */
export function buildOAuthUrl(state: string, redirectAfter = ''): string {
  if (!wechatLoginConfigured) {
    throw new ServiceUnavailableError('微信登录未配置', 'WECHAT_NOT_CONFIGURED');
  }
  const appId = config.WECHAT_LOGIN_APP_ID!;
  // 把「回调后要跳回的前端地址」编码进 state，回调时再解出来
  const encodedState = redirectAfter
    ? `${state}.${Buffer.from(redirectAfter, 'utf8').toString('base64url')}`
    : state;
  const redirect = encodeURIComponent(wechatRedirectUri());
  return (
    'https://open.weixin.qq.com/connect/oauth2/authorize?' +
    `appid=${appId}&redirect_uri=${redirect}&response_type=code&scope=snsapi_userinfo` +
    `&state=${encodedState}#wechat_redirect`
  );
}

/** state 里可能带了「回调后跳回地址」，拆出来。 */
export function splitState(rawState: string): { state: string; redirectAfter: string } {
  const idx = rawState.indexOf('.');
  if (idx < 0) return { state: rawState, redirectAfter: '' };
  const state = rawState.slice(0, idx);
  const b64 = rawState.slice(idx + 1);
  try {
    return { state, redirectAfter: Buffer.from(b64, 'base64url').toString('utf8') };
  } catch {
    return { state: rawState, redirectAfter: '' };
  }
}

export interface QrCreated {
  state: string;
  qrContent: string;
  real: boolean;
}

/** 创建扫码会话，返回二维码内容（真实模式是微信授权链接，联调模式是占位串）。 */
export function createQr(): QrCreated {
  gcSessions();
  const state = crypto.randomBytes(16).toString('hex');
  sessions.set(state, { createdAt: Date.now(), status: 'pending' });
  const real = wechatLoginConfigured;
  return {
    state,
    qrContent: real ? buildQrConnectUrl(state) : `BALLOON-DOG-WECHAT-MOCK:${state}`,
    real,
  };
}

/** 轮询扫码状态。 */
export function queryState(state: string): { status: 'pending' | 'done'; token?: string; user?: unknown } {
  const s = sessions.get(state);
  if (!s) throw new BadRequestError('二维码已过期，请刷新后重试');
  if (s.status === 'done') {
    // 取走后即销毁：token 只交付一次，避免同一个 state 被反复换取
    sessions.delete(state);
    return { status: 'done', token: s.token, user: s.user };
  }
  return { status: 'pending' };
}

/** 完成扫码登录（真实回调与联调模拟共用）。 */
export function completeScan(state: string, token: string, user: unknown): void {
  const s = sessions.get(state);
  if (!s) throw new BadRequestError('二维码已过期，请刷新后重试');
  s.status = 'done';
  s.token = token;
  s.user = user;
}

/** 联调模式：确认 state 合法（真正的用户创建在 service 层做）。 */
export function assertMockScanAllowed(): void {
  if (wechatLoginConfigured) {
    throw new BadRequestError('已配置真实微信登录，请使用微信扫码');
  }
}

/** 确认 state 会话存在且未过期。 */
export function assertSessionExists(state: string): void {
  const s = sessions.get(state);
  if (!s) throw new BadRequestError('二维码已过期，请刷新后重试');
  logger.debug({ msg: 'wechat session ok', state });
}

/** 微信 oauth2/access_token 的成功/失败响应形状。 */
interface WechatTokenResponse {
  openid?: string;
  unionid?: string;
  errcode?: number;
  errmsg?: string;
}

/** 真实模式：微信授权 code → openid。 */
export async function exchangeCodeForOpenid(code: string): Promise<{ openid: string; unionid?: string }> {
  const appId = config.WECHAT_LOGIN_APP_ID!;
  const secret = config.WECHAT_LOGIN_APP_SECRET!;
  const url =
    'https://api.weixin.qq.com/sns/oauth2/access_token?' +
    `appid=${appId}&secret=${secret}&code=${code}&grant_type=authorization_code`;

  const res = await fetch(url);
  if (!res.ok) {
    logger.warn({ msg: 'wechat oauth http failed', status: res.status });
    throw new BadRequestError('微信授权失败，请重试');
  }
  const data = (await res.json()) as WechatTokenResponse;
  if (!data.openid) {
    // errmsg 只写日志：可能包含 appid 等内部信息
    logger.warn({ msg: 'wechat oauth failed', errcode: data.errcode, errmsg: data.errmsg });
    throw new BadRequestError('微信授权失败，请重试');
  }
  return { openid: data.openid, unionid: data.unionid };
}

/** 联调模式下由 state 推导出的稳定假 openid（同一会话重复调用得到同一用户）。 */
export function mockOpenidFor(state: string): string {
  return `mock_openid_${state}`;
}
