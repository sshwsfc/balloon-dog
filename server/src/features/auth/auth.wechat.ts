import crypto from 'node:crypto';
import { config, wechatApiBase, wechatLoginConfigured } from '../../config';
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
  access_token?: string;
  openid?: string;
  unionid?: string;
  errcode?: number;
  errmsg?: string;
}

/** 真实模式：微信授权 code → openid（顺带把 access_token 带回来，用于拉用户资料）。 */
export async function exchangeCodeForOpenid(
  code: string,
): Promise<{ openid: string; unionid?: string; accessToken?: string }> {
  const appId = config.WECHAT_LOGIN_APP_ID!;
  const secret = config.WECHAT_LOGIN_APP_SECRET!;
  const url =
    `${wechatApiBase()}/sns/oauth2/access_token?` +
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
  return { openid: data.openid, unionid: data.unionid, accessToken: data.access_token };
}

/**
 * 拉取微信用户资料（昵称 / 头像）。
 *
 * 只有 `snsapi_userinfo` 的网页授权（微信内置浏览器那条链路）才拿得到；PC 扫码用的是
 * `snsapi_login`，拿不到资料。**失败一律吞掉**：昵称只是体验优化，绝不能因为它挂掉
 * 就让用户登不进来 —— 拿不到就沿用「微信用户xxxx」+ 默认头像。
 */
export async function fetchUserInfo(
  accessToken: string,
  openid: string,
): Promise<{ nickname?: string; headimgurl?: string }> {
  try {
    const data = await fetchWechatApi<{ nickname?: string; headimgurl?: string }>(
      `${wechatApiBase()}/sns/userinfo?access_token=${accessToken}&openid=${openid}&lang=zh_CN`,
      'userinfo',
    );
    return { nickname: data.nickname, headimgurl: data.headimgurl };
  } catch (error) {
    logger.debug({ msg: 'wechat userinfo skipped', err: String(error) });
    return {};
  }
}

/** 联调模式下由 state 推导出的稳定假 openid（同一会话重复调用得到同一用户）。 */
export function mockOpenidFor(state: string): string {
  return `mock_openid_${state}`;
}

// ---------------- 网页 JS-SDK（扫一扫）签名 ----------------

/**
 * 前端 `wx.config` 所需的签名参数。
 *
 * 家长端「绑定设备」里的扫一扫走微信 JS-SDK：前端把当前页面地址发过来，
 * 这里用 jsapi_ticket 算出 signature 回给前端。
 *
 * 为什么签名必须放服务端：`jsapi_ticket` 要用公众号的 AppSecret 换，
 * 而 AppSecret 绝不能下发到浏览器。
 *
 * 签名算法（微信官方规定，字段顺序不能变）：
 *   string1 = jsapi_ticket=TICKET&noncestr=NONCESTR&timestamp=TIMESTAMP&url=URL
 *   signature = sha1(string1)
 * 其中 url 必须与调用 wx.config 的页面地址**逐字符一致**（含 query，不含 #hash）。
 */
export interface JsapiSignature {
  appId: string;
  timestamp: number;
  nonceStr: string;
  signature: string;
}

interface CachedCredential {
  value: string;
  /** 绝对过期时刻（毫秒）。 */
  expiresAt: number;
}

/**
 * access_token / jsapi_ticket 的进程内缓存。
 *
 * 必须缓存：这两个接口都是 7200 秒有效期，但 access_token 每天只有 2000 次
 * 调用配额，每次扫码都去换很容易把当天额度烧光。
 *
 * 提前 `CREDENTIAL_SAFETY_MS` 过期，避开「刚取到就过期」的边界。多实例部署时
 * 每个实例各自持有一份缓存，会各自消耗配额，但仍是可接受的数量级。
 */
let cachedAccessToken: CachedCredential | null = null;
let cachedJsapiTicket: CachedCredential | null = null;

const CREDENTIAL_SAFETY_MS = 5 * 60 * 1000;
const CREDENTIAL_DEFAULT_TTL_MS = 7200 * 1000;

/** 微信开放接口返回的错误形状（成功时不带 errcode 或为 0）。 */
interface WechatApiError {
  errcode?: number;
  errmsg?: string;
}

async function fetchWechatApi<T>(url: string, what: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    logger.warn({ msg: 'wechat api http failed', what, status: res.status });
    throw new ServiceUnavailableError('微信接口暂时不可用，请稍后重试', 'WECHAT_UPSTREAM_ERROR');
  }
  const data = (await res.json()) as T & WechatApiError;
  if (data.errcode) {
    // errmsg 只写日志：可能带 appid / 内网信息
    logger.warn({ msg: 'wechat api failed', what, errcode: data.errcode, errmsg: data.errmsg });
    throw new ServiceUnavailableError('微信接口暂时不可用，请稍后重试', 'WECHAT_UPSTREAM_ERROR');
  }
  return data;
}

/**
 * 取（并缓存）公众号全局 access_token。
 *
 * 同时给模板消息通道用（`notifications.wechat.ts`）：同一个公众号、同一份配额，
 * 各建一份缓存只会让「每天 2000 次」的额度被重复消耗。
 */
export async function getAccessToken(): Promise<string> {
  const now = Date.now();
  if (cachedAccessToken && cachedAccessToken.expiresAt > now) return cachedAccessToken.value;

  const appId = config.WECHAT_LOGIN_APP_ID!;
  const secret = config.WECHAT_LOGIN_APP_SECRET!;
  const data = await fetchWechatApi<{ access_token?: string; expires_in?: number }>(
    `${wechatApiBase()}/cgi-bin/token?` +
      `grant_type=client_credential&appid=${appId}&secret=${secret}`,
    'access_token',
  );
  if (!data.access_token) {
    logger.warn({ msg: 'wechat access_token missing in response' });
    throw new ServiceUnavailableError('微信接口返回异常，请稍后重试', 'WECHAT_UPSTREAM_ERROR');
  }
  cachedAccessToken = {
    value: data.access_token,
    expiresAt:
      now + (data.expires_in ? data.expires_in * 1000 : CREDENTIAL_DEFAULT_TTL_MS) - CREDENTIAL_SAFETY_MS,
  };
  return cachedAccessToken.value;
}

/**
 * 丢掉 access_token 缓存。
 *
 * 微信可能在到期前就让令牌失效（重新授权、服务器换机），此时接口回 40001/42001；
 * 调用方丢掉缓存重取一次即可，不要直接把这条消息判死。
 */
export function invalidateAccessToken(): void {
  cachedAccessToken = null;
}

/** 取（并缓存）jsapi_ticket。 */
async function getJsapiTicket(): Promise<string> {
  const now = Date.now();
  if (cachedJsapiTicket && cachedJsapiTicket.expiresAt > now) return cachedJsapiTicket.value;

  const accessToken = await getAccessToken();
  const data = await fetchWechatApi<{ ticket?: string; expires_in?: number }>(
    `${wechatApiBase()}/cgi-bin/ticket/getticket?` +
      `access_token=${accessToken}&type=jsapi`,
    'jsapi_ticket',
  );
  if (!data.ticket) {
    logger.warn({ msg: 'wechat jsapi_ticket missing in response' });
    throw new ServiceUnavailableError('微信接口返回异常，请稍后重试', 'WECHAT_UPSTREAM_ERROR');
  }
  cachedJsapiTicket = {
    value: data.ticket,
    expiresAt:
      now + (data.expires_in ? data.expires_in * 1000 : CREDENTIAL_DEFAULT_TTL_MS) - CREDENTIAL_SAFETY_MS,
  };
  return cachedJsapiTicket.value;
}

/** 给页面地址签名，供前端 `wx.config` 使用。 */
export async function jsapiSignature(url: string): Promise<JsapiSignature> {
  if (!wechatLoginConfigured) {
    throw new ServiceUnavailableError('微信 JS-SDK 未配置', 'WECHAT_NOT_CONFIGURED');
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new BadRequestError('url 参数不是合法的绝对地址');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new BadRequestError('url 参数必须是 http/https 地址');
  }

  const ticket = await getJsapiTicket();
  const nonceStr = crypto.randomBytes(8).toString('hex');
  const timestamp = Math.floor(Date.now() / 1000);
  // 注意：这里对 url 不做任何规范化/解码，必须原样拼进去，
  // 否则签名与前端页面地址不一致，微信会报 invalid signature。
  const raw = `jsapi_ticket=${ticket}&noncestr=${nonceStr}&timestamp=${timestamp}&url=${url}`;
  const signature = crypto.createHash('sha1').update(raw, 'utf8').digest('hex');

  // host 与 PUBLIC_BASE_URL 不一致，最常见的原因是公众号后台没把当前域名填进
  // 「JS 接口安全域名」。只告警不拒绝：本地/内网联调本来就允许不一致。
  try {
    const base = new URL(config.PUBLIC_BASE_URL);
    if (base.host !== parsed.host) {
      logger.warn({
        msg: 'wechat jsapi url host mismatch',
        urlHost: parsed.host,
        publicHost: base.host,
      });
    }
  } catch {
    // PUBLIC_BASE_URL 没配或不是绝对地址时跳过这个检查
  }

  return { appId: config.WECHAT_LOGIN_APP_ID!, timestamp, nonceStr, signature };
}
