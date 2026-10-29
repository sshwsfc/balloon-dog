import crypto from 'node:crypto';
import { gmt8Timestamp, keyObject, pem } from './payments.keys';
import { config } from '../../config';
import { BadRequestError, ServiceUnavailableError } from '../../errors';
import { logger } from '../../logger';
import {
  PaymentChannel,
  fakeProviderAllowed,
  isChannelConfigured,
  missingEnvOf,
} from './payments.constants';

/**
 * 支付渠道适配层。
 *
 * 这一层的职责只有三件事：**下单**（拿到可以让家长付款的东西）、**验签**（确认回调真的
 * 来自渠道）、**退款**。订单状态机、会员生效、返现结算都不在这里 —— 见
 * `payments.service.ts` 与 `membership.service.ts` 的 `applyPaidOrder()`。
 *
 * ⚠️ **诚实边界**：微信支付 v3 与支付宝的签名/验签/退款报文都是照公开文档实现的，
 * 但**没有真实商户号可测**，所以「与真实网关的互操作」这一条没有端到端证据。
 * 有端到端证据的是这一层的**管线**（下单 → 回调 → 结算 → 退款 → 发票），
 * 由 `PAYMENT_FAKE_PROVIDER` 的假渠道覆盖（见 `server/scripts/e2e-payments.mjs`）。
 */

export interface PrepayInput {
  orderNo: string;
  amountCents: number;
  subject: string;
  /** 微信 JSAPI 需要 openid；没绑微信就退回扫码 */
  openid?: string | null;
}

export interface PrepayResult {
  channel: string;
  /** native_qr 扫码 / redirect 跳转 / jsapi 站内调起 */
  mode: 'native_qr' | 'redirect' | 'jsapi';
  codeUrl: string;
  prepayId: string;
  payload: Record<string, unknown>;
}

export interface NotifyInput {
  headers: Record<string, string | string[] | undefined>;
  /** 原始报文（签名是对原始字节算的，所以绝不能先 JSON.parse 再验签） */
  rawBody: string;
}

export interface NotifyResult {
  ok: boolean;
  ack: { contentType: string; body: string };
  orderNo: string;
  transactionId: string;
  paidCents: number;
  tradeState: string;
  reason: string;
}

export interface QueryInput {
  orderNo: string;
}

/**
 * 主动查单的结果。
 *
 * ⚠️ `found:false` 与「查询失败」是两件事：渠道明确回「没有这个单号」（微信 404 /
 * ORDER_NOT_EXIST）时要如实落成 found:false —— 那说明下单根本没成功；
 * 网络超时、网关 5xx 则要抛错，让家长看到「查询失败，稍后再试」而不是
 * 「渠道说没收到钱」。
 */
export interface QueryResult {
  found: boolean;
  paid: boolean;
  tradeState: string;
  transactionId: string;
  paidCents: number;
  reason: string;
}

export interface RefundInput {
  orderNo: string;
  refundNo: string;
  amountCents: number;
  totalCents: number;
  reason: string;
}

export interface RefundResult {
  ok: boolean;
  refundId: string;
  reason: string;
}

export interface PaymentProvider {
  key: string;
  label: string;
  createPayment(input: PrepayInput): Promise<PrepayResult>;
  verifyNotify(input: NotifyInput): Promise<NotifyResult>;
  /**
   * 主动查单：回调丢失时家长点「核对支付结果」靠它把钱找回来。
   *
   * 没有它的话，「渠道已收款但回调没到」就是一个只能人工处理的死状态 ——
   * 微信/支付宝的异步通知都可能因为网络、发布重启、网关抖动而重试失败。
   */
  queryPayment(input: QueryInput): Promise<QueryResult>;
  refund(input: RefundInput): Promise<RefundResult>;
}

function headerOf(headers: NotifyInput['headers'], name: string): string {
  const value = headers[name.toLowerCase()] ?? headers[name];
  if (Array.isArray(value)) return String(value[0] ?? '');
  return value == null ? '' : String(value);
}

function badNotify(reason: string): NotifyResult {
  return {
    ok: false,
    ack: { contentType: 'application/json', body: JSON.stringify({ code: 'FAIL', message: reason }) },
    orderNo: '',
    transactionId: '',
    paidCents: 0,
    tradeState: '',
    reason,
  };
}

// ============================================================
// 微信支付 v3
// ============================================================

const WECHAT_API = 'https://api.mch.weixin.qq.com';

class WechatPayProvider implements PaymentProvider {
  key = 'wechat';
  label = '微信支付';

  private authorization(method: string, urlPath: string, body: string): string {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const nonce = crypto.randomBytes(16).toString('hex');
    const message = `${method}\n${urlPath}\n${timestamp}\n${nonce}\n${body}\n`;
    const signature = crypto
      .sign('RSA-SHA256', Buffer.from(message, 'utf8'), keyObject(config.WECHAT_PAY_PRIVATE_KEY, 'private'))
      .toString('base64');
    return (
      `WECHATPAY2-SHA256-RSA2048 mchid="${config.WECHAT_PAY_MCH_ID}",` +
      `nonce_str="${nonce}",signature="${signature}",timestamp="${timestamp}",` +
      `serial_no="${config.WECHAT_PAY_SERIAL_NO}"`
    );
  }

  private async request(
    method: 'GET' | 'POST',
    urlPath: string,
    payload?: unknown,
  ): Promise<{ status: number; text: string }> {
    const body = payload ? JSON.stringify(payload) : '';
    const response = await fetch(`${WECHAT_API}${urlPath}`, {
      method,
      headers: {
        Authorization: this.authorization(method, urlPath, body),
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': 'balloon-dog/1.0',
      },
      body: body || undefined,
    });
    return { status: response.status, text: await response.text() };
  }

  private async call<T>(method: 'GET' | 'POST', urlPath: string, payload?: unknown): Promise<T> {
    const { status, text } = await this.request(method, urlPath, payload);
    if (status < 200 || status >= 300) {
      // 渠道的错误信息原样带出来，运维要拿它去对商户平台日志
      throw new ServiceUnavailableError(`微信支付返回 ${status}：${text.slice(0, 200)}`);
    }
    return (text ? JSON.parse(text) : {}) as T;
  }

  async createPayment(input: PrepayInput): Promise<PrepayResult> {
    const usesJsapi = Boolean(input.openid);
    const urlPath = usesJsapi
      ? '/v3/pay/transactions/jsapi'
      : '/v3/pay/transactions/native';
    const order: Record<string, unknown> = {
      appid: config.WECHAT_PAY_APP_ID,
      mchid: config.WECHAT_PAY_MCH_ID,
      description: input.subject,
      out_trade_no: input.orderNo,
      notify_url: config.WECHAT_PAY_NOTIFY_URL,
      amount: { total: input.amountCents, currency: 'CNY' },
    };
    if (usesJsapi) order.payer = { openid: input.openid };
    const result = await this.call<{ prepay_id: string; code_url?: string }>('POST', urlPath, order);

    if (usesJsapi) {
      // JSAPI 要在前端二次签名调起，这里把参数给全（签名用商户私钥）
      const timestamp = Math.floor(Date.now() / 1000).toString();
      const nonce = crypto.randomBytes(16).toString('hex');
      const pkg = `prepay_id=${result.prepay_id}`;
      const paySign = crypto
        .sign(
          'RSA-SHA256',
          Buffer.from(`${config.WECHAT_PAY_APP_ID}\n${timestamp}\n${nonce}\n${pkg}\n`, 'utf8'),
          keyObject(config.WECHAT_PAY_PRIVATE_KEY, 'private'),
        )
        .toString('base64');
      return {
        channel: this.key,
        mode: 'jsapi',
        codeUrl: '',
        prepayId: result.prepay_id,
        payload: { appId: config.WECHAT_PAY_APP_ID, timeStamp: timestamp, nonceStr: nonce, package: pkg, signType: 'RSA', paySign },
      };
    }

    return {
      channel: this.key,
      mode: 'native_qr',
      codeUrl: result.code_url ?? '',
      prepayId: result.prepay_id,
      payload: { codeUrl: result.code_url ?? '' },
    };
  }

  async verifyNotify(input: NotifyInput): Promise<NotifyResult> {
    const timestamp = headerOf(input.headers, 'wechatpay-timestamp');
    const nonce = headerOf(input.headers, 'wechatpay-nonce');
    const signature = headerOf(input.headers, 'wechatpay-signature');
    if (!timestamp || !nonce || !signature) return badNotify('缺少签名头');

    // 两种验签模式，按「配了什么」+「回调头里的 serial 是谁」自动选：
    //   1) 公钥模式：serial 就是微信支付公钥 ID（PUB_KEY_ID_…），用商户平台下载的 pub_key.pem；
    //   2) 平台证书模式：serial 是平台证书序列号，用商户自己的平台证书。
    // 微信 2024 年起不再给新商户下发平台证书（`/v3/certificates` 直接回
    // RESOURCE_NOT_EXISTS 并提示去申请微信支付公钥），所以公钥模式才是常态。
    const serial = headerOf(input.headers, 'wechatpay-serial');
    const publicKeyPem = pem(config.WECHAT_PAY_PLATFORM_PUBLIC_KEY || '');
    const publicKeyId = (config.WECHAT_PAY_PLATFORM_PUBLIC_KEY_ID || '').trim();
    const platformCertPem = pem(config.WECHAT_PAY_PLATFORM_CERT || '');

    let verifier: string | null = null;
    let verifyMode = '';
    if (publicKeyPem && (!publicKeyId || serial === publicKeyId)) {
      verifier = publicKeyPem;
      verifyMode = '微信支付公钥';
    } else if (platformCertPem) {
      verifier = platformCertPem;
      verifyMode = '平台证书';
    }
    if (!verifier) {
      return badNotify(
        '没有配置可用的验签材料（WECHAT_PAY_PLATFORM_PUBLIC_KEY 或 WECHAT_PAY_PLATFORM_CERT）',
      );
    }

    const message = `${timestamp}\n${nonce}\n${input.rawBody}\n`;
    let signatureOk = false;
    try {
      signatureOk = crypto.verify(
        'RSA-SHA256',
        Buffer.from(message, 'utf8'),
        verifier,
        Buffer.from(signature, 'base64'),
      );
    } catch (error) {
      logger.warn({ msg: 'wechat pay notify verify threw', err: String(error), verifyMode });
    }
    if (!signatureOk) return badNotify('验签失败');

    let envelope: { resource?: { ciphertext?: string; nonce?: string; associated_data?: string } };
    try {
      envelope = JSON.parse(input.rawBody);
    } catch {
      return badNotify('报文不是合法 JSON');
    }
    const resource = envelope.resource;
    if (!resource?.ciphertext || !resource.nonce) return badNotify('缺少 resource');

    // AES-256-GCM：密文（base64）末尾 16 字节是 auth tag
    try {
      const data = Buffer.from(resource.ciphertext, 'base64');
      const decipher = crypto.createDecipheriv(
        'aes-256-gcm',
        Buffer.from(config.WECHAT_PAY_API_V3_KEY, 'utf8'),
        Buffer.from(resource.nonce, 'utf8'),
      );
      decipher.setAuthTag(data.subarray(data.length - 16));
      if (resource.associated_data) {
        decipher.setAAD(Buffer.from(resource.associated_data, 'utf8'));
      }
      const plain = Buffer.concat([decipher.update(data.subarray(0, data.length - 16)), decipher.final()]);
      const parsed = JSON.parse(plain.toString('utf8')) as {
        out_trade_no?: string;
        transaction_id?: string;
        trade_state?: string;
        amount?: { total?: number };
      };
      const tradeState = parsed.trade_state ?? '';
      return {
        ok: tradeState === 'SUCCESS',
        ack: { contentType: 'application/json', body: JSON.stringify({ code: 'SUCCESS', message: '成功' }) },
        orderNo: parsed.out_trade_no ?? '',
        transactionId: parsed.transaction_id ?? '',
        paidCents: parsed.amount?.total ?? 0,
        tradeState,
        reason: tradeState === 'SUCCESS' ? '' : `渠道状态 ${tradeState}`,
      };
    } catch (error) {
      logger.warn({ msg: 'wechat pay resource decrypt failed', err: String(error) });
      return badNotify('报文体解密失败');
    }
  }

  /**
   * 按商户订单号查单（`GET /v3/pay/transactions/out-trade-no/{no}?mchid=`）。
   *
   * 注意签名串里的 path **必须带 query**：微信规定签名覆盖的是「URL 含 query」的原文，
   * 少拼一个 `?mchid=` 就是 invalid sign。
   */
  async queryPayment(input: QueryInput): Promise<QueryResult> {
    const urlPath =
      `/v3/pay/transactions/out-trade-no/${encodeURIComponent(input.orderNo)}` +
      `?mchid=${encodeURIComponent(config.WECHAT_PAY_MCH_ID)}`;
    const { status, text } = await this.request('GET', urlPath);
    // 404 ORDER_NOT_EXIST：渠道侧真的没有这个单号（下单没成功），不是查询失败
    if (status === 404) {
      return {
        found: false,
        paid: false,
        tradeState: '',
        transactionId: '',
        paidCents: 0,
        reason: '渠道没有这个订单号',
      };
    }
    if (status < 200 || status >= 300) {
      throw new ServiceUnavailableError(`微信支付查单返回 ${status}：${text.slice(0, 200)}`);
    }
    const data = (text ? JSON.parse(text) : {}) as {
      trade_state?: string;
      transaction_id?: string;
      amount?: { total?: number };
    };
    const tradeState = data.trade_state ?? '';
    return {
      found: true,
      paid: tradeState === 'SUCCESS',
      tradeState,
      transactionId: data.transaction_id ?? '',
      paidCents: data.amount?.total ?? 0,
      reason: tradeState === 'SUCCESS' ? '' : `渠道状态 ${tradeState}`,
    };
  }

  async refund(input: RefundInput): Promise<RefundResult> {
    const result = await this.call<{ refund_id: string; status: string }>(
      'POST',
      '/v3/refund/domestic/refunds',
      {
        out_trade_no: input.orderNo,
        out_refund_no: input.refundNo,
        reason: input.reason,
        amount: { refund: input.amountCents, total: input.totalCents, currency: 'CNY' },
      },
    );
    return { ok: true, refundId: result.refund_id, reason: result.status };
  }
}

// ============================================================
// 支付宝（手机网站支付）
// ============================================================

const ALIPAY_METHOD_PAY = 'alipay.trade.wap.pay';
/** 电脑网站支付：手机网站支付没签约、但电脑网站支付签了时退到它（saas 项目用的就是它） */
const ALIPAY_METHOD_PAGE = 'alipay.trade.page.pay';
const ALIPAY_PRODUCT_WAP = 'QUICK_WAP_WAY';
const ALIPAY_PRODUCT_PAGE = 'FAST_INSTANT_TRADE_PAY';
const ALIPAY_NOT_OPEN =
  '支付宝渠道还没开通：商户平台未签约「手机网站支付」，或该应用没拿到支付接口授权。' +
  '请管理员在支付宝开放平台签约后再试，家长端不用改任何设置。';

const ALIPAY_METHOD_QUERY = 'alipay.trade.query';
const ALIPAY_METHOD_REFUND = 'alipay.trade.refund';

class AlipayProvider implements PaymentProvider {
  key = 'alipay';
  label = '支付宝';

  /**
   * 待签名串：参数按 key 升序、过滤空值、去掉 sign，用 & 连接。
   *
   * ⚠️ `sign_type` **必须参与签名**（新版 V2 规则）。剔除它是老 V1 规则，而
   * `openapi.alipay.com` 的 `alipay.trade.*` 在验签时会带上 `sign_type=RSA2`，
   * 少它一个字段就是 `invalid-signature`。同步通知验签则两种规则都接受
   * （见 `verifyNotify`），因为不同接入方式回带来的参数集并不一致。
   */
  private contentOf(params: Record<string, string>, includeSignType: boolean): string {
    return Object.keys(params)
      .filter((k) => k !== 'sign' && (includeSignType || k !== 'sign_type') && params[k] !== '')
      .sort()
      .map((k) => `${k}=${params[k]}`)
      .join('&');
  }

  private signOf(params: Record<string, string>): string {
    const content = this.contentOf(params, true);
    try {
      return crypto
        .sign('RSA-SHA256', Buffer.from(content, 'utf8'), keyObject(config.ALIPAY_PRIVATE_KEY, 'private'))
        .toString('base64');
    } catch (error) {
      // 环境变量里有值、但根本解析不了的密钥：说清楚是配置坏了，别抛 500 堆栈
      throw new ServiceUnavailableError(`支付宝私钥无法解析（ALIPAY_PRIVATE_KEY）：${String(error).slice(0, 120)}`);
    }
  }

  private verifyOf(content: string, sign: string): boolean {
    return crypto.verify(
      'RSA-SHA256',
      Buffer.from(content, 'utf8'),
      keyObject(config.ALIPAY_PUBLIC_KEY, 'public'),
      Buffer.from(sign, 'base64'),
    );
  }

  /**
   * 收银台可用性预检（只在**下单那一刻**跑一次，不产生渠道订单）。
   *
   * 支付宝的「应用没签约支付产品 / 没拿到接口授权」不会在签名阶段暴露 ——
   * 网关收下请求后才吐一张 `insufficient-isv-permissions` 的白页，或者把用户
   * 甩到 `appAssign.htm` 授权页。家长看到的就是「点了支付直接报错」。
   * 所以这里先把同一张收银台 URL 自己取一次，只认**已知的错误特征**：
   *   - 跳到 `appAssign.htm`（应用授权）
   *   - 页面里出现 `insufficient-isv-permissions` / `ISV权限不足` / `invalid-signature`
   * 命中就改成一句家长也看得懂的话，没命中（包括探测本身超时）一律放行。
   */
  private async cashierProblem(url: string): Promise<string> {
    let response: Response;
    try {
      response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(8000) });
    } catch {
      return '';
    }
    const location = response.headers.get('location') ?? '';
    if (location.includes('appAssign.htm')) return '应用没有拿到商户授权（appAssign）';
    if (response.status >= 400) return `网关返回 ${response.status}`;
    const text = await response.text();
    if (/insufficient-isv-permissions|ISV权限不足|invalid-signature/.test(text)) {
      return '应用未签约该支付产品（insufficient-isv-permissions）';
    }
    return '';
  }

  private baseParams(method: string): Record<string, string> {
    return {
      app_id: config.ALIPAY_APP_ID,
      method,
      charset: 'utf-8',
      sign_type: 'RSA2',
      timestamp: gmt8Timestamp(),
      version: '1.0',
      notify_url: config.ALIPAY_NOTIFY_URL,
      // 第三方应用（服务商代调用）必须带上商户授权令牌，否则网关一律甩到授权页
      ...(config.ALIPAY_APP_AUTH_TOKEN ? { app_auth_token: config.ALIPAY_APP_AUTH_TOKEN } : {}),
    };
  }

  /** 调一次开放平台接口，返回 `<method>_response` 节点（非 10000 直接抛错）。 */
  private async callNode(method: string, bizContent: Record<string, unknown>): Promise<Record<string, unknown>> {
    const params: Record<string, string> = {
      ...this.baseParams(method),
      biz_content: JSON.stringify(bizContent),
    };
    params.sign = this.signOf(params);
    const response = await fetch(config.ALIPAY_GATEWAY, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8' },
      body: new URLSearchParams(params).toString(),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new ServiceUnavailableError(`支付宝返回 ${response.status}：${text.slice(0, 200)}`);
    }
    const parsed = JSON.parse(text) as Record<string, { code?: string; msg?: string; sub_msg?: string }>;
    const node = parsed[`${method.replace(/\./g, '_')}_response`];
    if (!node) {
      throw new ServiceUnavailableError(`支付宝返回里没有 ${method}_response`);
    }
    if (node.code && node.code !== '10000') {
      throw new ServiceUnavailableError(`支付宝返回失败：${node.sub_msg ?? node.msg ?? node.code}`);
    }
    return node as Record<string, unknown>;
  }

  /**
   * 生成收银台跳转链接。
   *
   * 支付宝同一笔订单可以用两个产品立起来：手机网站支付（`wap.pay`，手机端体验最好）
   * 与电脑网站支付（`page.pay`，saas 项目一直用的是它）。**签约是按产品分别签的**，
   * 所以这里按顺序各造一张 URL 自己探一次：哪张能进收银台就用哪张。两张都进不去，
   * 就把真实的拒绝原因写进错误里（授权页 / ISV 权限不足 / 网关状态码），
   * 而不是让家长跳到一个白页。
   */
  async createPayment(input: PrepayInput): Promise<PrepayResult> {
    // 同步跳回（用户在支付宝里付完、点返回时落回会员页）。
    // ⚠️ 只能带**干净**的地址：支付宝网关会把值里的 & 当成重复参数，报 suspected-attack，
    // 所以订单号不拼在 URL 上，回跳页自己从 `out_trade_no` 取。
    const backUrl = `${config.CLIENT_URL}/membership`;
    const candidates: { method: string; productCode: string }[] = [
      { method: ALIPAY_METHOD_PAY, productCode: ALIPAY_PRODUCT_WAP },
      { method: ALIPAY_METHOD_PAGE, productCode: ALIPAY_PRODUCT_PAGE },
    ];
    const problems: string[] = [];
    for (const candidate of candidates) {
      const params: Record<string, string> = {
        ...this.baseParams(candidate.method),
        return_url: backUrl,
        biz_content: JSON.stringify({
          out_trade_no: input.orderNo,
          total_amount: (input.amountCents / 100).toFixed(2),
          subject: input.subject,
          product_code: candidate.productCode,
          // 和微信一样给 15 分钟：超过之后渠道侧单号就废了，界面必须让家长重新下单
          timeout_express: '15m',
        }),
      };
      params.sign = this.signOf(params);
      const url = `${config.ALIPAY_GATEWAY}?${new URLSearchParams(params).toString()}`;
      const problem = await this.cashierProblem(url);
      if (!problem) {
        return {
          channel: this.key,
          mode: 'redirect',
          codeUrl: url,
          prepayId: input.orderNo,
          payload: { redirectUrl: url },
        };
      }
      problems.push(`${candidate.method}：${problem}`);
    }
    throw new ServiceUnavailableError(`${ALIPAY_NOT_OPEN}（${problems.join('；')}）`);
  }

  /** 主动查单（`alipay.trade.query`）；渠道侧查无此单时会抛 TRADE_NOT_EXIST，落成 found:false。 */
  async queryPayment(input: QueryInput): Promise<QueryResult> {
    let node: Record<string, unknown>;
    try {
      node = await this.callNode(ALIPAY_METHOD_QUERY, { out_trade_no: input.orderNo });
    } catch (error) {
      // TRADE_NOT_EXIST：这个单号在支付宝侧不存在（下单没成功）
      const text = String(error);
      if (text.includes('TRADE_NOT_EXIST')) {
        return {
          found: false,
          paid: false,
          tradeState: '',
          transactionId: '',
          paidCents: 0,
          reason: '渠道没有这个订单号',
        };
      }
      throw error;
    }
    const tradeState = String(node.trade_status ?? '');
    const total = Number(node.total_amount ?? 0);
    return {
      found: true,
      paid: tradeState === 'TRADE_SUCCESS' || tradeState === 'TRADE_FINISHED',
      tradeState,
      transactionId: String(node.trade_no ?? ''),
      paidCents: Math.round(total * 100),
      reason: tradeState === 'TRADE_SUCCESS' ? '' : `渠道状态 ${tradeState}`,
    };
  }

  async verifyNotify(input: NotifyInput): Promise<NotifyResult> {
    // 支付宝的回调是 form-urlencoded（不是 JSON、也没有签名头），所以要从报文里解析参数
    let params: Record<string, string>;
    try {
      params = Object.fromEntries(new URLSearchParams(input.rawBody)) as Record<string, string>;
    } catch {
      return badNotify('回调报文无法解析');
    }
    const sign = params.sign ?? '';
    if (!sign) return badNotify('缺少 sign');
    if (!config.ALIPAY_PUBLIC_KEY) return badNotify('没有配置支付宝公钥，无法验签');

    const content = this.contentOf(params, false);
    const contentWithSignType = this.contentOf(params, true);
    let ok = false;
    try {
      // 两种规则都试：有的接入方式回带 sign_type、有的不带，而**错误的那一种不会报错**
      // （只是验签失败），所以不能只押一种。任何一变体验过就算过。
      ok =
        this.verifyOf(content, sign) ||
        (contentWithSignType !== content && this.verifyOf(contentWithSignType, sign));
    } catch (error) {
      logger.warn({ msg: 'alipay notify verify threw', err: String(error) });
    }
    if (!ok) return badNotify('验签失败');

    const tradeState = params.trade_status ?? '';
    const paidCents = Math.round(Number(params.total_amount ?? '0') * 100);
    return {
      ok: tradeState === 'TRADE_SUCCESS' || tradeState === 'TRADE_FINISHED',
      ack: { contentType: 'text/plain', body: 'success' },
      orderNo: params.out_trade_no ?? '',
      transactionId: params.trade_no ?? '',
      paidCents,
      tradeState,
      reason: tradeState === 'TRADE_SUCCESS' ? '' : `渠道状态 ${tradeState}`,
    };
  }

  async refund(input: RefundInput): Promise<RefundResult> {
    const node = await this.callNode(ALIPAY_METHOD_REFUND, {
      out_trade_no: input.orderNo,
      refund_amount: (input.amountCents / 100).toFixed(2),
      out_request_no: input.refundNo,
      refund_reason: input.reason,
    });
    return {
      ok: true,
      refundId: String(node.trade_no ?? input.refundNo),
      reason: String(node.fund_change ?? ''),
    };
  }
}

// ============================================================
// 假渠道（仅测试）
// ============================================================

/**
 * 假渠道的签名 = md5(`${orderNo}:${amountCents}:${secret}`)。
 * 它当然不安全，所以只在 `PAYMENT_FAKE_PROVIDER=true` 且非生产环境存在
 * （见 `fakeProviderAllowed()`）；它的价值是让「回调 → 结算 → 退款」这条真实管线
 * 在没有商户号的情况下也有端到端证据 —— 包括**坏签名必须被拒**这条。
 */
export function fakeSignature(orderNo: string, amountCents: number, secret: string): string {
  return crypto.createHash('md5').update(`${orderNo}:${amountCents}:${secret}`).digest('hex');
}

/**
 * 测试用：把假渠道那一侧的订单状态改成 `SUCCESS`（模拟「用户已经在渠道付完钱，
 * 但异步通知丢了」）。**必须经由 `fakeProviderAllowed()` 把守的接口调用**，
 * 生产环境这个函数根本不可达。
 */
export function setFakeTradeState(orderNo: string, tradeState: string): void {
  FakeProvider.tradeStates.set(orderNo, tradeState);
}

class FakeProvider implements PaymentProvider {
  key = 'fake';
  label = '测试渠道（不会真的收钱）';

  private get secret(): string {
    return config.WECHAT_PAY_API_V3_KEY || 'fake-secret';
  }

  /**
   * 假渠道的「渠道侧状态」。
   *
   * 真实渠道的状态在微信/支付宝那边，我们只能查；假渠道没有那一边，所以用一个
   * 进程内 Map 模拟。**它的唯一用途是让「回调丢了、主动查单把钱找回来」这条
   * 路径也有端到端证据**（见 `setFakeTradeState`，只能由测试用的开发接口写入，
   * 且该接口与假渠道同受 `fakeProviderAllowed()` 硬闸）。
   */
  static tradeStates = new Map<string, string>();

  async createPayment(input: PrepayInput): Promise<PrepayResult> {
    FakeProvider.tradeStates.set(input.orderNo, 'NOTPAY');
    return {
      channel: this.key,
      mode: 'native_qr',
      codeUrl: `https://example.invalid/fake-pay/${input.orderNo}`,
      prepayId: `FAKE_${input.orderNo}`,
      payload: {
        fake: true,
        orderNo: input.orderNo,
        amountCents: input.amountCents,
        notifyUrl: '/api/payments/notify/fake',
        sign: fakeSignature(input.orderNo, input.amountCents, this.secret),
      },
    };
  }

  async queryPayment(input: QueryInput): Promise<QueryResult> {
    const tradeState = FakeProvider.tradeStates.get(input.orderNo);
    if (!tradeState) {
      return {
        found: false,
        paid: false,
        tradeState: '',
        transactionId: '',
        paidCents: 0,
        reason: '渠道没有这个订单号',
      };
    }
    return {
      found: true,
      paid: tradeState === 'SUCCESS',
      tradeState,
      transactionId: tradeState === 'SUCCESS' ? `FAKE_TX_${input.orderNo}` : '',
      // 假渠道不记金额：查单结果里给 0，由 service 判断「0 表示渠道没回报金额」
      paidCents: 0,
      reason: tradeState === 'SUCCESS' ? '' : `渠道状态 ${tradeState}`,
    };
  }

  async verifyNotify(input: NotifyInput): Promise<NotifyResult> {
    let body: { orderNo?: string; amountCents?: number; transactionId?: string; tradeState?: string; sign?: string };
    try {
      body = JSON.parse(input.rawBody);
    } catch {
      return badNotify('报文不是合法 JSON');
    }
    const orderNo = body.orderNo ?? '';
    const amountCents = Number(body.amountCents ?? 0);
    const expected = fakeSignature(orderNo, amountCents, this.secret);
    if (!orderNo || !body.sign || body.sign !== expected) return badNotify('验签失败');
    const tradeState = body.tradeState ?? 'SUCCESS';
    return {
      ok: tradeState === 'SUCCESS',
      ack: { contentType: 'application/json', body: JSON.stringify({ code: 'SUCCESS', message: '成功' }) },
      orderNo,
      transactionId: body.transactionId ?? `FAKE_TX_${orderNo}`,
      paidCents: amountCents,
      tradeState,
      reason: tradeState === 'SUCCESS' ? '' : `渠道状态 ${tradeState}`,
    };
  }

  async refund(input: RefundInput): Promise<RefundResult> {
    return { ok: true, refundId: `FAKE_REFUND_${input.refundNo}`, reason: 'SUCCESS' };
  }
}

// ============================================================
// 注册表
// ============================================================

const registry: Record<string, PaymentProvider> = {
  wechat: new WechatPayProvider(),
  alipay: new AlipayProvider(),
};

/**
 * 取一个渠道。**不在这里检查配置**：调用方需要区分「渠道不支持」与「渠道没配」，
 * 前者是 404，后者是 503 且要带上缺哪些变量。
 */
export function getProvider(key: string): PaymentProvider | null {
  if (key === 'fake') return fakeProviderAllowed() ? new FakeProvider() : null;
  const provider = registry[key];
  if (!provider) return null;
  return provider;
}

/** 渠道是否可用（配置齐全 / 假渠道被允许）。 */
export function providerReady(key: string): boolean {
  if (key === 'fake') return fakeProviderAllowed();
  if (key !== 'wechat' && key !== 'alipay') return false;
  return isChannelConfigured(key as PaymentChannel);
}

export function providerMissing(key: string): string[] {
  if (key === 'fake') return fakeProviderAllowed() ? [] : ['PAYMENT_FAKE_PROVIDER'];
  if (key !== 'wechat' && key !== 'alipay') return [];
  return missingEnvOf(key as PaymentChannel);
}

/** 下单/退款前的统一门禁：没配就 503，并说清缺哪几个变量。 */
export function requireProvider(key: string): PaymentProvider {
  const provider = getProvider(key);
  if (!provider) throw new BadRequestError('不支持的支付渠道');
  const missing = providerMissing(key);
  if (missing.length > 0) {
    throw new ServiceUnavailableError(`支付渠道「${provider.label}」尚未配置，缺少：${missing.join('、')}`);
  }
  return provider;
}
