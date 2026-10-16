/**
 * 客服工单（规划 §5.5）。
 *
 * 非目标（界面与文档都要如实写）：**没有附件**（家长在正文里描述，或引用「媒体库」里的
 * 记录）、**没有模板与自动回复机器人**。这两件事不是「以后再补」，而是「现在就不假装有」。
 */

export type TicketStatus = 'open' | 'processing' | 'waiting' | 'closed';
export type TicketPriority = 'low' | 'normal' | 'high';

export const TICKET_STATUSES: TicketStatus[] = ['open', 'processing', 'waiting', 'closed'];
export const TICKET_PRIORITIES: TicketPriority[] = ['low', 'normal', 'high'];

export const TICKET_STATUS_LABELS: Record<string, string> = {
  open: '待处理',
  processing: '处理中',
  waiting: '等待家长回复',
  closed: '已关闭',
};

export const TICKET_PRIORITY_LABELS: Record<string, string> = {
  low: '低',
  normal: '普通',
  high: '紧急',
};

export interface TicketCategoryDef {
  key: string;
  label: string;
  /** 家长选中后界面给的一句提示：让他知道该写什么，减少来回一轮 */
  hint: string;
}

/**
 * 分类是**固定枚举**而不是自由文本：运营要能按分类筛选与统计，
 * 让家长自己填一个「其他」以外的字符串，后台就永远分不了组。
 */
export const TICKET_CATEGORIES: TicketCategoryDef[] = [
  { key: 'device', label: '设备连接 / 绑定', hint: '写清设备名称，以及是连不上、频繁掉线还是绑不上。' },
  { key: 'control', label: '管控不生效', hint: '写清哪一项管控（锁屏、限制应用…）以及设备型号。' },
  { key: 'payment', label: '支付 / 退款 / 发票', hint: '写上订单号；退款与开票问题优先在这里提。' },
  { key: 'account', label: '账号与登录', hint: '写清是收不到验证码、登录不上还是要换手机号。' },
  { key: 'suggestion', label: '功能建议', hint: '说说你想解决什么问题，比直接给方案更有帮助。' },
  { key: 'other', label: '其他问题', hint: '' },
];

export const TICKET_CATEGORY_KEYS = TICKET_CATEGORIES.map((c) => c.key);

/** 同一家长**未关闭**的工单上限。到顶了要先等处理，不是无限开。 */
export const TICKET_OPEN_LIMIT = 5;

/** 单条回复的长度上限（正文与回复取同一个值，避免回复比正文还长）。 */
export const TICKET_BODY_MAX = 2000;
export const TICKET_SUBJECT_MAX = 80;
