/**
 * 告警大盘的口径（规划 §5.5）。
 *
 * **这里是唯一权威口径**：`docs/PLAN-admin-ops.md` §2 的表格与本文件必须逐字一致，
 * e2e 会照着本文件独立重算一遍数字。改口径时三处（文档 / 本文件 / 大盘界面）一起改。
 *
 * 三条纪律（写在这里是为了让后来者不用翻文档）：
 *  1. 分母永远写清楚：失联率的分母是**已绑定**设备，未认领的设备不算；
 *  2. 率类指标分母为 0 时返回 `null` 而不是 `0` —— 「查过了都正常」与「没有可统计对象」
 *     是两件事，界面显示「—」而不是「0%」；
 *  3. `never`（从未连接）不算失联，它单独一列。
 */
export type AlertSeverity = 'info' | 'warn' | 'danger';

/** 指标的取值方式：`point` 是当前快照，`window` 是时间窗内的计数/比率。 */
export type AlertMetricKind = 'point' | 'window';

export interface AlertRuleMeta {
  key: string;
  label: string;
  kind: AlertMetricKind;
  /** 单位：`%` 或 `条` */
  unit: '%' | '条';
  /** 阈值的分母是什么、怎么算的 —— 大盘与文档都要显示，避免「率」被误读 */
  denominator: string;
  defaultSeverity: AlertSeverity;
  defaultThreshold: number;
  /** 率类里没有窗口概念的规则为 0 = 不适用 */
  defaultWindowMinutes: number;
  note: string;
}

export const ALERT_RULES: AlertRuleMeta[] = [
  {
    key: 'device_offline',
    label: '设备失联率',
    kind: 'point',
    unit: '%',
    denominator: 'livenessOf() ∈ {offline, lost} 的已绑定设备 ÷ 已绑定设备（never 单独一列，不算失联）',
    defaultSeverity: 'danger',
    defaultThreshold: 30,
    defaultWindowMinutes: 0,
    note: '只统计已认领的设备：未认领的注册记录会把失联率稀释成永远正常。',
  },
  {
    key: 'control_gap',
    label: '管控失效率',
    kind: 'point',
    unit: '%',
    denominator: '有健康快照且（openGaps > 0 或 serviceRunning = false）的设备 ÷ 有健康快照的已绑定设备',
    defaultSeverity: 'warn',
    defaultThreshold: 30,
    defaultWindowMinutes: 0,
    note: '分母只算报过健康的设备：从未上报 ≠ 一切正常，它属于「还没有数据」。',
  },
  {
    key: 'command_failure',
    label: '指令失败率',
    kind: 'window',
    unit: '%',
    denominator: '窗口内 status ∈ {failed, expired} 的指令 ÷ 窗口内 finishedAt 非空的指令',
    defaultSeverity: 'warn',
    defaultThreshold: 20,
    defaultWindowMinutes: 60,
    note: '超时未领取（expired）算失败：家长点了没反应与明确失败一样要处置。',
  },
  {
    key: 'payment_anomaly',
    label: '支付异常',
    kind: 'window',
    unit: '条',
    denominator: '窗口内 PaymentEvent.result ≠ ok 的条数（坏签名 / 金额不符 / 未知单 / error）',
    defaultSeverity: 'danger',
    defaultThreshold: 1,
    defaultWindowMinutes: 60,
    note: '坏签名是有人在试探回调接口，一条就该看。',
  },
  {
    key: 'notify_failure',
    label: '通知投递失败',
    kind: 'window',
    unit: '条',
    denominator: 'NotificationDelivery 中 attempts >= 3 且 lastError ≠ 空 的条数',
    defaultSeverity: 'warn',
    defaultThreshold: 5,
    defaultWindowMinutes: 60,
    note: '重试三次仍失败才是「投不出去」；微信有时是自己那边抖一下。',
  },
];

export const ALERT_RULE_KEYS = ALERT_RULES.map((r) => r.key);

const BY_KEY = new Map(ALERT_RULES.map((r) => [r.key, r]));

export function alertRuleMetaOf(key: string): AlertRuleMeta | undefined {
  return BY_KEY.get(key);
}

export function isKnownAlertRule(key: string): boolean {
  return BY_KEY.has(key);
}

/** 严重度排序（大盘按它排在最前），数字越小越严重。 */
export const SEVERITY_RANK: Record<AlertSeverity, number> = {
  danger: 0,
  warn: 1,
  info: 2,
};
