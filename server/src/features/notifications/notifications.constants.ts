/**
 * 家长端站内通知的「单一事实来源」（规划 §2.1 第一档）。
 *
 * 通知类型是白名单：任何未列出的 type 都会被 DTO 拒绝，也不会出现在偏好页上。
 * 原因与功能开关一样 —— 拼错一个 type 只会静默不生效，而「家长说没收到」
 * 是这类系统最难排查的故障。
 */

export interface NotificationTypeDef {
  type: string;
  label: string;
  /** 这条通知要不要打扰到家长：info 只进消息中心，warn/danger 会进未读角标红点 */
  defaultLevel: 'info' | 'warn' | 'danger';
  /** 站内默认开着；家长可以逐类关掉 */
  defaultInApp: boolean;
  /** 设备相关（点进去要有 deviceId）还是账号级 */
  deviceScoped: boolean;
  /** 点击通知后跳转的家长端路径 —— 在这里定，免得每个生产点各写一遍还写不一致 */
  linkPath: string;
}

export const NOTIFICATION_TYPE_DEFS: NotificationTypeDef[] = [
  {
    type: 'agent_offline',
    label: '设备失联',
    defaultLevel: 'danger',
    defaultInApp: true,
    linkPath: '/device-health',
    deviceScoped: true,
  },
  {
    type: 'health_danger',
    label: '管控能力失效',
    defaultLevel: 'danger',
    defaultInApp: true,
    linkPath: '/device-health',
    deviceScoped: true,
  },
  {
    type: 'geofence_enter',
    label: '进入安全区',
    defaultLevel: 'info',
    defaultInApp: true,
    linkPath: '/location',
    deviceScoped: true,
  },
  {
    type: 'geofence_exit',
    label: '离开安全区',
    defaultLevel: 'info',
    defaultInApp: true,
    linkPath: '/location',
    deviceScoped: true,
  },
  {
    type: 'app_audit',
    label: '应用安装申请',
    defaultLevel: 'warn',
    defaultInApp: true,
    linkPath: '/app-audit',
    deviceScoped: true,
  },
  {
    type: 'child_request',
    label: '孩子的申请',
    defaultLevel: 'warn',
    defaultInApp: true,
    linkPath: '/time-requests',
    deviceScoped: true,
  },
  {
    // 孩子的求助（规划 §3.2）：孩子端主页的 SOS 按钮。
    // 级别是最高的 danger，且默认开着站内 —— 这是唯一一个「孩子在现场求助」的信号，
    // 家长关掉它没有正当理由（偏好页仍然允许关，但界面会写出后果）。
    type: 'child_sos',
    label: '孩子的求助',
    defaultLevel: 'danger',
    defaultInApp: true,
    linkPath: '/notifications',
    deviceScoped: true,
  },
  {
    type: 'device_shared',
    label: '家庭成员邀请',
    // 不是告警：对方只是被拉进来一起看。真正需要立刻知道的事用 warn/danger
    defaultLevel: 'info',
    defaultInApp: true,
    linkPath: '/devices',
    deviceScoped: true,
  },
  {
    // 孩子勾掉了「今日任务」（规划 §5.2）。info 而不是 warn：这是好消息，
    // 不该和「设备失联」抢同一个红点。
    type: 'child_task',
    label: '今日任务',
    defaultLevel: 'info',
    defaultInApp: true,
    linkPath: '/children',
    deviceScoped: true,
  },
  {
    type: 'membership_expiring',
    label: '会员即将到期',
    defaultLevel: 'warn',
    defaultInApp: true,
    linkPath: '/membership',
    deviceScoped: false,
  },
];

export const NOTIFICATION_TYPES = NOTIFICATION_TYPE_DEFS.map((d) => d.type);

const TYPE_DEF_BY_TYPE = new Map(NOTIFICATION_TYPE_DEFS.map((d) => [d.type, d]));

export function notificationTypeDef(type: string): NotificationTypeDef | undefined {
  return TYPE_DEF_BY_TYPE.get(type);
}

export function isNotificationType(type: string): boolean {
  return TYPE_DEF_BY_TYPE.has(type);
}

export function defaultInAppOf(type: string): boolean {
  return TYPE_DEF_BY_TYPE.get(type)?.defaultInApp ?? true;
}

export const NOTIFICATION_LEVELS = ['info', 'warn', 'danger'] as const;
export type NotificationLevel = (typeof NOTIFICATION_LEVELS)[number];

/**
 * 会员到期提醒的提前天数。
 *
 * 7 天：足够家长在不慌的情况下决定续不续；再长就会被「还早」忽略掉。
 */
export const MEMBERSHIP_EXPIRING_DAYS = 7;

/**
 * 通知标题/正文的长度上限。
 *
 * 为什么要有上限：`body` 里会带设备端原样透传的中文（比如失联时长），
 * 没上限时一条异常长的设备字符串就能把家长端的卡片撑坏。
 * 截断而不是拒收 —— 通知的价值在「知道这件事」，不该因为一句话太长而丢掉。
 */
export const NOTIFICATION_TITLE_MAX = 120;
export const NOTIFICATION_BODY_MAX = 500;

export function clampText(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

// ---------------- 站内之外的投递通道（规划 §2.1 第二档） ----------------

/**
 * 微信模板消息的重试上限。
 *
 * 3 次：微信这边的失败大多分两类 —— 配置错（模板 ID 不对、字段名不匹配）重试一万次
 * 也没用；网络/额度抖动重试一两次就会好。3 次覆盖后者，又不会让前者无限刷日志。
 * 到上限后投递记录留在 `failed`，家长端能把它显示出来（「为什么没收到」有据可查）。
 */
export const WECHAT_DELIVERY_MAX_ATTEMPTS = 3;

/** 一次惰性派发最多处理几条（家长打开消息中心时顺带发，不能让接口变慢）。 */
export const WECHAT_DISPATCH_BATCH = 5;

/**
 * 厂商推送为什么**不适用**（如实说明，而不是「以后再说」）。
 *
 * 厂商推送（小米/华为/OPPO/vivo/FCM）都要原生 App 的推送 SDK；这个项目的家长端是
 * 移动网页，没有能接收推送的进程。硬做一个「开关」只会是「存下来却永远不会生效」。
 * 家长端会把这句原样显示出来。
 */
export const PUSH_NOT_APPLICABLE_REASON = '家长端是移动网页，没有原生客户端可接收厂商推送；请使用微信服务号消息。';
