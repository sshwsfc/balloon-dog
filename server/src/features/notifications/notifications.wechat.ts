import { config, wechatApiBase, wechatTemplateConfigured, wechatTemplateLinkBase } from '../../config';
import { logger } from '../../logger';
import { ServiceUnavailableError } from '../../errors';
import { getAccessToken, invalidateAccessToken } from '../auth/auth.wechat';

/**
 * 微信服务号模板消息（规划 §2.1 第二档）。
 *
 * 为什么是模板消息而不是 App 推送：家长端是**移动网页**（微信风格 H5），没有原生客户端
 * 可以接收厂商推送 —— 小米/华为/OPPO 的推送通道都需要 App SDK。国内对 H5 家长最现实的
 * 触达方式就是让他关注服务号、我们发模板消息。厂商推送因此**不适用**（见 preferences 的
 * `push.reason`），而不是「以后再说」。
 *
 * 模板字段名是**公众号后台建模板的人定的**，这里按固定约定发送：
 *   first   = 标题（用户点开前能看到的预览）
 *   keyword1 = 标题、keyword2 = 正文（模板正文里排两行）
 *   remark  = 固定提示
 * 建模板时必须对上这些键，否则微信会回 47003（参数不合法），投递记录里会留下原文 ——
 * 这正是「投递记录要能回答为什么没收到」的用处。
 *
 * 联调：把 `WECHAT_API_BASE_URL` 指向 `server/scripts/mock-wechat-server.mjs`，
 * 「取 access_token → 发消息 → 令牌失效后重取再发」整条路径不需要真公众号就能验证。
 */

/** 微信返回的字段长度上限很宽松，但截断总比整条发失败好。 */
const FIELD_MAX = 200;

/** 需要「丢掉令牌缓存重取一次再试」的错误码。 */
const TOKEN_ERROR_CODES = new Set([40001, 40014, 42001, 42007]);

/** 微信接口返回的业务错误（errcode != 0）。 */
export class WechatSendError extends Error {
  constructor(
    message: string,
    readonly errcode: number | null = null,
  ) {
    super(message);
    this.name = 'WechatSendError';
  }
}

interface TemplatePayload {
  openid: string;
  /** 已经渲染好的中文标题（模板消息的内容是中文的，与家长端的界面语言无关） */
  title: string;
  body: string;
  /** 家长端路径，点开模板消息后跳过去 */
  linkPath: string;
}

function clampField(value: string): string {
  return value.length > FIELD_MAX ? `${value.slice(0, FIELD_MAX - 1)}…` : value;
}

/**
 * 发送一次模板消息。
 *
 * 令牌失效（40001/42001 等）时**自动重取令牌再试一次**：微信可能在 7200 秒到期前
 * 就让令牌失效（重新授权、服务器迁移），这种情况不该把这条通知判死。
 * 明确知道重试救不了的情况（`touser` 没关注公众号、模板 ID 不对）不重试。
 */
export async function sendWechatTemplate(payload: TemplatePayload): Promise<void> {
  if (!wechatTemplateConfigured) {
    throw new ServiceUnavailableError('微信服务号消息未配置', 'WECHAT_NOT_CONFIGURED');
  }
  try {
    await postTemplate(await getAccessToken(), payload);
    return;
  } catch (error: unknown) {
    if (!(error instanceof WechatSendError) || error.errcode === null || !TOKEN_ERROR_CODES.has(error.errcode)) {
      throw error;
    }
    logger.warn({ errcode: error.errcode }, '微信令牌被提前判失效，丢掉缓存重取后再发一次');
  }
  invalidateAccessToken();
  await postTemplate(await getAccessToken(), payload);
}

async function postTemplate(accessToken: string, payload: TemplatePayload): Promise<void> {
  const url = `${wechatApiBase()}/cgi-bin/message/template/send?access_token=${accessToken}`;
  const body = {
    touser: payload.openid,
    template_id: config.WECHAT_TEMPLATE_ID,
    url: `${wechatTemplateLinkBase()}${payload.linkPath || '/notifications'}`,
    data: {
      first: { value: clampField(payload.title) },
      keyword1: { value: clampField(payload.title) },
      keyword2: { value: clampField(payload.body) },
      remark: { value: '点开可查看详情并处理。' },
    },
  };

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (error: unknown) {
    // 网络层失败（DNS/超时/连接被拒）：算「暂时发不出去」，值得重试
    logger.warn({ err: error }, '微信模板消息请求失败');
    throw new WechatSendError('微信接口连不上，稍后重试', null);
  }

  interface WechatSendResponse {
    errcode?: number;
    errmsg?: string;
  }
  let data: WechatSendResponse = {};
  try {
    data = (await res.json()) as WechatSendResponse;
  } catch {
    throw new WechatSendError(`微信接口返回了非 JSON（HTTP ${res.status}）`, null);
  }

  if (!res.ok || (data.errcode !== undefined && data.errcode !== 0)) {
    const errcode = data.errcode ?? null;
    const errmsg = data.errmsg || `HTTP ${res.status}`;
    // errmsg 里可能出现 appid 等，只写进投递记录与日志，不下发给浏览器
    logger.warn({ errcode, errmsg }, '微信模板消息发送失败');
    throw new WechatSendError(`微信回 ${errcode ?? res.status}：${errmsg}`, errcode);
  }
}

/**
 * 把「模板 + 参数」渲染成要发出去的句子。
 *
 * 模板消息的内容固定是中文：公众号模板本身就是在后台用中文写的，服务端也没有
 * 按用户存语言（家长端的界面语言是浏览器侧的偏好）。所以这里只做插值，不做翻译 ——
 * 与「英文界面不许露出中文」的规则不冲突：那条规则管的是**家长端界面**。
 */
export function renderTemplate(template: string, params: Record<string, unknown> | null | undefined): string {
  if (!params) return template;
  return template.replace(/\{\{(\w+)\}\}/g, (_all, key: string) => {
    const value = params[key];
    return value === undefined || value === null ? '' : String(value);
  });
}
