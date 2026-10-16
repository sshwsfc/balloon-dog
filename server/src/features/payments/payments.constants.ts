import { config } from '../../config';

/**
 * 支付渠道的配置位（规划 §5.4）。
 *
 * 这里只描述「一个渠道需要哪些变量」以及「它叫什么」，具体怎么签名、怎么验签在
 * `payments.provider.ts`。把这两件事分开，是因为前者是**产品事实**（家长端要如实告诉
 * 运维缺什么），后者是会随渠道文档变化的技术细节。
 */
export interface PaymentProviderDef {
  key: PaymentChannel;
  label: string;
  /** 一套渠道要能收钱，这些配置必须全部非空。缺任何一个都不能上线收款。 */
  requiredEnv: string[];
  /** 家长端/后台展示的补充说明（例如「需要企业资质」）。 */
  note: string;
}

export type PaymentChannel = 'wechat' | 'alipay';

/** 订单状态（与 schema 注释一致）。 */
export const ORDER_STATUS = {
  pending: '待支付',
  paid: '已支付',
  failed: '支付失败',
  cancelled: '已取消',
  refunding: '退款中',
  refunded: '已退款',
} as const;

export type OrderStatus = keyof typeof ORDER_STATUS;

/** 发票申请状态。 */
export const INVOICE_STATUS = {
  pending: '待处理',
  issued: '已开具',
  rejected: '已驳回',
} as const;

export const INVOICE_LIMIT_PER_USER = 20;

export const PROVIDERS: PaymentProviderDef[] = [
  {
    key: 'wechat',
    label: '微信支付',
    requiredEnv: [
      'WECHAT_PAY_MCH_ID',
      'WECHAT_PAY_APP_ID',
      'WECHAT_PAY_API_V3_KEY',
      'WECHAT_PAY_SERIAL_NO',
      'WECHAT_PAY_PRIVATE_KEY',
      'WECHAT_PAY_PLATFORM_CERT',
      'WECHAT_PAY_NOTIFY_URL',
    ],
    note: '需要企业资质的微信支付商户号；回调必须公网 https 可达',
  },
  {
    key: 'alipay',
    label: '支付宝',
    requiredEnv: [
      'ALIPAY_APP_ID',
      'ALIPAY_PRIVATE_KEY',
      'ALIPAY_PUBLIC_KEY',
      'ALIPAY_NOTIFY_URL',
    ],
    note: '需要支付宝开放平台应用；签名算法 RSA2',
  },
];

/**
 * 一个渠道缺哪些配置。**按渠道各自判断**，不做「支付总开关」——
 * 现实里常见「支付宝配好了、微信还在等审核」，一刀切会让能收的钱也收不了。
 */
export function missingEnvOf(key: PaymentChannel): string[] {
  const def = PROVIDERS.find((p) => p.key === key);
  if (!def) return [];
  return def.requiredEnv.filter((name) => {
    const value = (config as unknown as Record<string, unknown>)[name];
    return !(typeof value === 'string' && value.trim().length > 0);
  });
}

export function isChannelConfigured(key: PaymentChannel): boolean {
  return missingEnvOf(key).length === 0;
}

/**
 * 假渠道只在测试里可用。
 *
 * 这一条是**硬闸**：`PAYMENT_FAKE_PROVIDER=true` 而 NODE_ENV=production 时直接当没配，
 * 免得有人把环境变量从测试环境抄到生产，结果上线了一个「签名等于 md5」的支付网关。
 */
export function fakeProviderAllowed(): boolean {
  return config.PAYMENT_FAKE_PROVIDER && config.NODE_ENV !== 'production';
}

/**
 * 「配置好了」与「运营开着」是两件事，家长端能选的渠道要两个都成立。
 *
 * 前者是环境变量（`isChannelConfigured`），后者是灰度开关（`flagEnabled`，见
 * `payments.service.ts` 的 `channelEnabledFor`）。判定必须放在 service —— 这里保持
 * 纯配置、不碰数据库，才能被后台体检和文档引用而不带出一次查询。
 */
