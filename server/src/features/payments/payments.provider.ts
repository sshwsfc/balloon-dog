import crypto from 'node:crypto';
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
  refund(input: RefundInput): Promise<RefundResult>;
}

/** 环境变量里的 PEM 常常写成一行（\n 转义），两种写法都接受。 */
function pem(raw: string): string {
  const text = raw.includes('\\n') ? raw.replace(/\\n/g, '\n') : raw;
  return text.trim();
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
      .sign('RSA-SHA256', Buffer.from(message, 'utf8'), pem(config.WECHAT_PAY_PRIVATE_KEY))
      .toString('base64');
    return (
      `WECHATPAY2-SHA256-RSA2048 mchid="${config.WECHAT_PAY_MCH_ID}",` +
      `nonce_str="${nonce}",signature="${signature}",timestamp="${timestamp}",` +
      `serial_no="${config.WECHAT_PAY_SERIAL_NO}"`
    );
  }

  private async call<T>(method: 'GET' | 'POST', urlPath: string, payload?: unknown): Promise<T> {
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
    const text = await response.text();
    if (!response.ok) {
      // 渠道的错误信息原样带出来，运维要拿它去对商户平台日志
      throw new ServiceUnavailableError(`微信支付返回 ${response.status}：${text.slice(0, 200)}`);
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
          pem(config.WECHAT_PAY_PRIVATE_KEY),
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
    if (!config.WECHAT_PAY_PLATFORM_CERT) return badNotify('没有配置平台证书，无法验签');

    const message = `${timestamp}\n${nonce}\n${input.rawBody}\n`;
    let signatureOk = false;
    try {
      signatureOk = crypto.verify(
        'RSA-SHA256',
        Buffer.from(message, 'utf8'),
        pem(config.WECHAT_PAY_PLATFORM_CERT),
        Buffer.from(signature, 'base64'),
      );
    } catch (error) {
      logger.warn({ msg: 'wechat pay notify verify threw', err: String(error) });
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
const ALIPAY_METHOD_REFUND = 'alipay.trade.refund';

class AlipayProvider implements PaymentProvider {
  key = 'alipay';
  label = '支付宝';

  /** 支付宝的签名规则：参数按 key 升序、去掉 sign/sign_type、用 & 连接，再 RSA2 签名。 */
  private signOf(params: Record<string, string>): string {
    const content = Object.keys(params)
      .filter((k) => k !== 'sign' && k !== 'sign_type' && params[k] !== '')
      .sort()
      .map((k) => `${k}=${params[k]}`)
      .join('&');
    return crypto
      .sign('RSA-SHA256', Buffer.from(content, 'utf8'), pem(config.ALIPAY_PRIVATE_KEY))
      .toString('base64');
  }

  private baseParams(method: string): Record<string, string> {
    return {
      app_id: config.ALIPAY_APP_ID,
      method,
      charset: 'utf-8',
      sign_type: 'RSA2',
      timestamp: new Date().toISOString().slice(0, 19).replace('T', ' '),
      version: '1.0',
      notify_url: config.ALIPAY_NOTIFY_URL,
    };
  }

  private async call<T>(method: string, bizContent: Record<string, unknown>): Promise<T> {
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
    if (node?.code && node.code !== '10000') {
      throw new ServiceUnavailableError(`支付宝下单失败：${node.sub_msg ?? node.msg ?? node.code}`);
    }
    return parsed as T;
  }

  async createPayment(input: PrepayInput): Promise<PrepayResult> {
    const params: Record<string, string> = {
      ...this.baseParams(ALIPAY_METHOD_PAY),
      biz_content: JSON.stringify({
        out_trade_no: input.orderNo,
        total_amount: (input.amountCents / 100).toFixed(2),
        subject: input.subject,
        product_code: 'QUICK_WAP_WAY',
      }),
    };
    params.sign = this.signOf(params);
    const url = `${config.ALIPAY_GATEWAY}?${new URLSearchParams(params).toString()}`;
    return {
      channel: this.key,
      mode: 'redirect',
      codeUrl: url,
      prepayId: input.orderNo,
      payload: { redirectUrl: url },
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

    const content = Object.keys(params)
      .filter((k) => k !== 'sign' && k !== 'sign_type' && params[k] !== '')
      .sort()
      .map((k) => `${k}=${params[k]}`)
      .join('&');
    let ok = false;
    try {
      ok = crypto.verify(
        'RSA-SHA256',
        Buffer.from(content, 'utf8'),
        pem(config.ALIPAY_PUBLIC_KEY),
        Buffer.from(sign, 'base64'),
      );
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
    const result = await this.call<{ alipay_trade_refund_response?: { trade_no?: string; fund_change?: string } }>(
      ALIPAY_METHOD_REFUND,
      {
        out_trade_no: input.orderNo,
        refund_amount: (input.amountCents / 100).toFixed(2),
        out_request_no: input.refundNo,
        refund_reason: input.reason,
      },
    );
    return {
      ok: true,
      refundId: result.alipay_trade_refund_response?.trade_no ?? input.refundNo,
      reason: result.alipay_trade_refund_response?.fund_change ?? '',
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

class FakeProvider implements PaymentProvider {
  key = 'fake';
  label = '测试渠道（不会真的收钱）';

  private get secret(): string {
    return config.WECHAT_PAY_API_V3_KEY || 'fake-secret';
  }

  async createPayment(input: PrepayInput): Promise<PrepayResult> {
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
