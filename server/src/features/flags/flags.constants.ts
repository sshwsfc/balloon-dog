/**
 * 灰度开关的契约（规划 §5.5）。
 *
 * 这里定义的是「有哪些开关、每个开关按什么对象放量、默认值是多少」。**具体怎么求值**
 * 在 `flags.service.ts`，**接在哪个功能上**在各功能自己的代码里（见下面的 `wiredAt`）。
 *
 * 一条纪律：**没有接在功能上的开关不许存在**。增加一个 flag 时，`wiredAt` 必须写清
 * 「关掉它到底会发生什么」，否则它就是一个骗人的开关 —— 后台点得动、什么都不变。
 */
export type FlagBucket = 'user' | 'device' | 'none';

export interface FlagDef {
  key: string;
  label: string;
  description: string;
  /** 按什么对象放量。`none` = 全局开关，没有百分比的意义 */
  bucket: FlagBucket;
  defaultEnabled: boolean;
  defaultRolloutPercent: number;
  /** 关掉它之后的真实行为。写不清楚就说明这个开关不该加 */
  wiredAt: string;
}

export const FLAG_DEFS: FlagDef[] = [
  {
    key: 'pay.channel.wechat',
    label: '微信支付渠道',
    description: '按账号放量。关掉后家长端支付目录里不再出现微信支付；已经下单的订单不受影响。',
    bucket: 'user',
    defaultEnabled: true,
    defaultRolloutPercent: 100,
    wiredAt:
      'payments.service.catalog() 不把它列进 available；createPayment() 对已关闭渠道回 503（不是 400 —— 不是参数错，是能力关着）',
  },
  {
    key: 'pay.channel.alipay',
    label: '支付宝支付渠道',
    description:
      '按账号放量。想让 10% 的账号先试支付宝就把它调到 10 —— 百分比按账号稳定散列，同一个账号每次结果一致。',
    bucket: 'user',
    defaultEnabled: true,
    defaultRolloutPercent: 100,
    wiredAt: '同 pay.channel.wechat',
  },
  {
    key: 'pay.refund.selfservice',
    label: '家长自助退款',
    description: '全局开关。关掉后家长端只能联系客服退款；**后台人工退款不受影响**。',
    bucket: 'none',
    defaultEnabled: true,
    defaultRolloutPercent: 100,
    wiredAt: 'paymentsService.requestRefund() 回 403「自助退款暂时关闭，请联系客服」',
  },
  {
    key: 'notify.wechat.dispatch',
    label: '微信模板消息投递',
    description: '全局开关。关掉后模板消息不再出站（站内通知不受影响）。',
    bucket: 'none',
    defaultEnabled: true,
    defaultRolloutPercent: 100,
    wiredAt: 'notifications 的微信投递在出站前判一次，关掉时跳过且不写投递行',
  },
  {
    key: 'support.tickets',
    label: '客服工单入口',
    description: '全局开关。关掉后家长端不再提供工单入口、提交返回 503；历史工单仍可在后台查看。',
    bucket: 'none',
    defaultEnabled: true,
    defaultRolloutPercent: 100,
    wiredAt: 'GET /api/support/config 回 enabled=false，POST /api/support/tickets 回 503',
  },
];

export const FLAG_KEYS = FLAG_DEFS.map((d) => d.key);

const BY_KEY = new Map(FLAG_DEFS.map((d) => [d.key, d]));

export function flagDefOf(key: string): FlagDef | undefined {
  return BY_KEY.get(key);
}

export function isKnownFlag(key: string): boolean {
  return BY_KEY.has(key);
}

/** 渠道开关的 key 从这里生成，避免各处手写字符串拼错。 */
export function channelFlagKey(channel: string): string {
  return `pay.channel.${channel}`;
}
