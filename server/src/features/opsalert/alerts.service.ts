import type { AlertRule } from '@prisma/client';
import { prisma } from '../../prisma';
import { logger } from '../../logger';
import { BadRequestError, NotFoundError } from '../../errors';
import { humanizeLastActive, livenessOf } from '../../shared/deviceScope';
import {
  ALERT_RULES,
  SEVERITY_RANK,
  alertRuleMetaOf,
  isKnownAlertRule,
  type AlertRuleMeta,
  type AlertSeverity,
} from './alerts.constants';

/**
 * 后台告警大盘（规划 §5.5）。
 *
 * **读时计算，没有后台扫描任务**：`overview()` 被调用时才去库里算这五个指标。
 * 这样做的好处是没有「扫描器挂了但大盘全绿」这种最危险的故障模式 —— 大盘不亮
 * 只可能是数据库不可用，而那会有别的告警。代价是每次刷新都要跑几条聚合查询，
 * 对运营页面量级完全够用。
 *
 * 这个能力**不出站**：不发短信、不发微信、不打电话。界面与文档都必须如实写着。
 */

export interface AlertSample {
  title: string;
  detail: string;
}

export interface AlertMetric {
  key: string;
  label: string;
  unit: '%' | '条';
  numerator: number;
  denominator: number;
  /** 率类指标分母为 0 时是 null（界面显示「—」，不是「0%」） */
  value: number | null;
  windowMinutes: number;
  denominatorText: string;
  samples: AlertSample[];
}

export interface AlertView {
  key: string;
  label: string;
  enabled: boolean;
  severity: AlertSeverity;
  threshold: number;
  unit: '%' | '条';
  windowMinutes: number;
  note: string;
  denominatorText: string;
  value: number | null;
  numerator: number;
  denominator: number;
  samples: AlertSample[];
  triggered: boolean;
  ack: {
    id: string;
    adminName: string | null;
    note: string;
    snapshot: Record<string, unknown>;
    createdAt: Date;
  } | null;
  usingDefaults: boolean;
}

const SAMPLE_LIMIT = 5;

function ratio(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return Math.round((numerator / denominator) * 1000) / 10;
}

function sinceOf(windowMinutes: number): Date | null {
  if (windowMinutes <= 0) return null;
  return new Date(Date.now() - windowMinutes * 60_000);
}

/** 指标一：设备失联率（快照）。 */
async function deviceOfflineMetric(): Promise<Pick<AlertMetric, 'numerator' | 'denominator' | 'value' | 'samples'>> {
  const devices = await prisma.childDevice.findMany({
    where: { userId: { not: null } },
    select: { id: true, name: true, status: true, lastActiveAt: true },
  });
  const bad = devices.filter((d) => {
    const level = livenessOf(d);
    return level === 'offline' || level === 'lost';
  });
  const samples = bad.slice(0, SAMPLE_LIMIT).map((d) => ({
    title: d.name,
    detail: `${livenessOf(d) === 'lost' ? '已失联' : '离线'} · 最后心跳 ${humanizeLastActive(d.lastActiveAt)}`,
  }));
  return {
    numerator: bad.length,
    denominator: devices.length,
    value: ratio(bad.length, devices.length),
    samples,
  };
}

/** 指标二：管控失效率（快照，分母是报过健康的已绑定设备）。 */
async function controlGapMetric(): Promise<Pick<AlertMetric, 'numerator' | 'denominator' | 'value' | 'samples'>> {
  const rows = await prisma.deviceHealth.findMany({
    where: { device: { userId: { not: null } } },
    select: {
      openGaps: true,
      serviceRunning: true,
      gaps: true,
      device: { select: { name: true } },
    },
  });
  const bad = rows.filter((r) => r.openGaps > 0 || r.serviceRunning === false);
  const samples = bad.slice(0, SAMPLE_LIMIT).map((r) => {
    const gaps = Array.isArray(r.gaps) ? (r.gaps as { label?: string }[]) : [];
    const labels = gaps
      .map((g) => g?.label)
      .filter((x): x is string => typeof x === 'string' && x.length > 0)
      .slice(0, 3);
    const bits: string[] = [];
    if (!r.serviceRunning) bits.push('守护服务没在跑');
    if (labels.length) bits.push(`缺口：${labels.join('、')}`);
    return { title: r.device.name, detail: bits.join('；') || `缺口 ${r.openGaps} 项` };
  });
  return {
    numerator: bad.length,
    denominator: rows.length,
    value: ratio(bad.length, rows.length),
    samples,
  };
}

/** 指标三：指令失败率（窗口）。 */
async function commandFailureMetric(
  windowMinutes: number,
): Promise<Pick<AlertMetric, 'numerator' | 'denominator' | 'value' | 'samples'>> {
  const since = sinceOf(windowMinutes);
  const rows = await prisma.deviceCommand.findMany({
    where: since ? { finishedAt: { gte: since } } : { finishedAt: { not: null } },
    select: { status: true, type: true, error: true, device: { select: { name: true } } },
  });
  const bad = rows.filter((r) => r.status === 'failed' || r.status === 'expired');
  const samples = bad.slice(0, SAMPLE_LIMIT).map((r) => ({
    title: `${r.device.name} · ${r.type}`,
    detail:
      r.status === 'expired'
        ? '超时未领取（设备端可能不在线）'
        : r.error || '设备端回报失败（没有给出原因）',
  }));
  return {
    numerator: bad.length,
    denominator: rows.length,
    value: ratio(bad.length, rows.length),
    samples,
  };
}

/** 指标四：支付异常条数（窗口）。 */
async function paymentAnomalyMetric(
  windowMinutes: number,
): Promise<Pick<AlertMetric, 'numerator' | 'denominator' | 'value' | 'samples'>> {
  const since = sinceOf(windowMinutes);
  const where = { result: { not: 'ok' }, ...(since ? { createdAt: { gte: since } } : {}) };
  // 计数用 count：`findMany({ take: 5 })` 会把「今天有 300 条坏签名」压成 5，
  // 样本可以有上限，事故规模不能有上限。
  const [count, rows] = await Promise.all([
    prisma.paymentEvent.count({ where }),
    prisma.paymentEvent.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: SAMPLE_LIMIT,
      select: { provider: true, kind: true, result: true, orderNo: true, detail: true },
    }),
  ]);
  return {
    numerator: count,
    denominator: count,
    value: count,
    samples: rows.map((r) => ({
      title: `${r.provider} · ${r.kind} · ${r.result}${r.orderNo ? ` · ${r.orderNo}` : ''}`,
      detail: r.detail || '没有更多细节',
    })),
  };
}

/** 指标五：通知投递失败条数（窗口，重试三次仍失败）。 */
async function notifyFailureMetric(
  windowMinutes: number,
): Promise<Pick<AlertMetric, 'numerator' | 'denominator' | 'value' | 'samples'>> {
  const since = sinceOf(windowMinutes);
  const where = {
    attempts: { gte: 3 },
    lastError: { not: '' },
    ...(since ? { createdAt: { gte: since } } : {}),
  };
  const [count, rows] = await Promise.all([
    prisma.notificationDelivery.count({ where }),
    prisma.notificationDelivery.findMany({
      where,
      orderBy: { updatedAt: 'desc' },
      take: SAMPLE_LIMIT,
      select: { channel: true, attempts: true, lastError: true, notification: { select: { title: true } } },
    }),
  ]);
  return {
    numerator: count,
    denominator: count,
    value: count,
    samples: rows.map((r) => ({
      title: `${r.channel} · 已试 ${r.attempts} 次 · ${r.notification.title}`,
      detail: r.lastError,
    })),
  };
}

async function computeMetric(meta: AlertRuleMeta, rule: AlertRule | null): Promise<AlertMetric> {
  const windowMinutes = rule ? rule.windowMinutes : meta.defaultWindowMinutes;
  const base =
    meta.key === 'device_offline'
      ? await deviceOfflineMetric()
      : meta.key === 'control_gap'
        ? await controlGapMetric()
        : meta.key === 'command_failure'
          ? await commandFailureMetric(windowMinutes)
          : meta.key === 'payment_anomaly'
            ? await paymentAnomalyMetric(windowMinutes)
            : await notifyFailureMetric(windowMinutes);
  return {
    key: meta.key,
    label: meta.label,
    unit: meta.unit,
    windowMinutes,
    denominatorText: meta.denominator,
    ...base,
  };
}

/** 数据库缺行时补上（幂等）。启动时调用，保证大盘与代码定义一致。 */
export async function ensureAlertRuleDefaults(): Promise<number> {
  let created = 0;
  for (const meta of ALERT_RULES) {
    const existing = await prisma.alertRule.findUnique({ where: { key: meta.key } });
    if (existing) continue;
    await prisma.alertRule.create({
      data: {
        key: meta.key,
        label: meta.label,
        enabled: true,
        severity: meta.defaultSeverity,
        threshold: meta.defaultThreshold,
        windowMinutes: meta.defaultWindowMinutes,
        note: meta.note,
      },
    });
    created += 1;
  }
  if (created > 0) logger.info({ msg: 'alert rule defaults restored', created });
  return created;
}

export async function listAlertRules() {
  const rows = await prisma.alertRule.findMany();
  const byKey = new Map(rows.map((r) => [r.key, r]));
  return ALERT_RULES.map((meta) => {
    const row = byKey.get(meta.key) ?? null;
    return {
      key: meta.key,
      label: meta.label,
      enabled: row ? row.enabled : true,
      severity: (row?.severity ?? meta.defaultSeverity) as AlertSeverity,
      threshold: row ? row.threshold : meta.defaultThreshold,
      windowMinutes: row ? row.windowMinutes : meta.defaultWindowMinutes,
      unit: meta.unit,
      denominatorText: meta.denominator,
      defaultThreshold: meta.defaultThreshold,
      defaultSeverity: meta.defaultSeverity,
      defaultWindowMinutes: meta.defaultWindowMinutes,
      note: row?.note || meta.note,
      usingDefaults: row == null,
      updatedAt: row?.updatedAt ?? null,
    };
  });
}

export async function overview() {
  const rows = await prisma.alertRule.findMany();
  const byKey = new Map(rows.map((r) => [r.key, r]));
  const acks = await prisma.alertAck.findMany({
    include: { admin: { select: { username: true } } },
  });
  const ackByKeySubject = new Map(acks.map((a) => [`${a.key}\u0000${a.subject}`, a]));

  const metrics: AlertMetric[] = [];
  const alerts: AlertView[] = [];
  for (const meta of ALERT_RULES) {
    const row = byKey.get(meta.key) ?? null;
    const metric = await computeMetric(meta, row);
    metrics.push(metric);

    const enabled = row ? row.enabled : true;
    const severity = (row?.severity ?? meta.defaultSeverity) as AlertSeverity;
    const threshold = row ? row.threshold : meta.defaultThreshold;
    // 分母为 0 的率类指标**不触发**：没有可统计对象不等于事故（与「从未上报 ≠ 一切正常」同源）
    const triggered = enabled && metric.value != null && metric.value >= threshold;
    const ack = ackByKeySubject.get(`${meta.key}\u0000`) ?? null;
    alerts.push({
      key: meta.key,
      label: meta.label,
      enabled,
      severity,
      threshold,
      unit: meta.unit,
      windowMinutes: metric.windowMinutes,
      note: row?.note || meta.note,
      denominatorText: meta.denominator,
      value: metric.value,
      numerator: metric.numerator,
      denominator: metric.denominator,
      samples: triggered ? metric.samples : [],
      triggered,
      ack: ack
        ? {
            id: ack.id,
            adminName: ack.admin?.username ?? null,
            note: ack.note,
            snapshot: (ack.snapshot ?? {}) as Record<string, unknown>,
            createdAt: ack.createdAt,
          }
        : null,
      usingDefaults: row == null,
    });
  }

  alerts.sort((a, b) => {
    if (a.triggered !== b.triggered) return a.triggered ? -1 : 1;
    const sev = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (sev !== 0) return sev;
    return (b.value ?? -1) - (a.value ?? -1);
  });

  return { generatedAt: new Date(), metrics, alerts };
}

export interface AlertRulePatch {
  enabled?: boolean;
  severity?: AlertSeverity;
  threshold?: number;
  windowMinutes?: number;
  note?: string;
}

export async function updateAlertRule(key: string, patch: AlertRulePatch) {
  const meta = alertRuleMetaOf(key);
  if (!meta) throw new NotFoundError('告警规则', key);
  if (patch.threshold !== undefined && (patch.threshold < 0 || patch.threshold > 100_000)) {
    throw new BadRequestError('阈值必须是 0-100000 之间的整数');
  }
  if (patch.windowMinutes !== undefined && (patch.windowMinutes < 0 || patch.windowMinutes > 1440)) {
    throw new BadRequestError('统计窗口必须是 0-1440 分钟（0 = 即时快照）');
  }
  if (meta.kind === 'point' && patch.windowMinutes !== undefined && patch.windowMinutes !== 0) {
    throw new BadRequestError(`「${meta.label}」是即时快照指标，没有统计窗口`);
  }
  await prisma.alertRule.upsert({
    where: { key },
    create: {
      key,
      label: meta.label,
      enabled: patch.enabled ?? true,
      severity: patch.severity ?? meta.defaultSeverity,
      threshold: patch.threshold ?? meta.defaultThreshold,
      windowMinutes: patch.windowMinutes ?? meta.defaultWindowMinutes,
      note: patch.note ?? meta.note,
    },
    update: patch,
  });
  const rules = await listAlertRules();
  return rules.find((r) => r.key === key)!;
}

export async function resetAlertRule(key: string) {
  if (!isKnownAlertRule(key)) throw new NotFoundError('告警规则', key);
  await prisma.alertRule.deleteMany({ where: { key } });
  await ensureAlertRuleDefaults();
  const rules = await listAlertRules();
  return rules.find((r) => r.key === key)!;
}

export async function listAlertAcks(page: number, pageSize: number) {
  const [total, rows] = await Promise.all([
    prisma.alertAck.count(),
    prisma.alertAck.findMany({
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: { admin: { select: { username: true } } },
    }),
  ]);
  return {
    total,
    page,
    pageSize,
    acks: rows.map((a) => ({
      id: a.id,
      key: a.key,
      subject: a.subject,
      label: alertRuleMetaOf(a.key)?.label ?? a.key,
      adminName: a.admin?.username ?? null,
      note: a.note,
      snapshot: (a.snapshot ?? {}) as Record<string, unknown>,
      createdAt: a.createdAt,
    })),
  };
}

/**
 * 确认一条告警（可重复确认 = 更新备注与快照；撤销是删除）。
 *
 * 快照由**服务端**在确认那一刻算：前端传进来的「我认为是 30%」不作数 ——
 * 否则确认记录就失去了「当时实际是多少」的证据价值。
 */
export async function createAlertAck(input: {
  key: string;
  subject?: string;
  note?: string;
  adminId: number;
}) {
  const meta = alertRuleMetaOf(input.key);
  if (!meta) throw new NotFoundError('告警规则', input.key);
  const subject = input.subject ?? '';
  const rule = await prisma.alertRule.findUnique({ where: { key: input.key } });
  const metric = await computeMetric(meta, rule);
  const snapshot = {
    value: metric.value,
    numerator: metric.numerator,
    denominator: metric.denominator,
    threshold: rule ? rule.threshold : meta.defaultThreshold,
    at: new Date().toISOString(),
  };
  const ack = await prisma.alertAck.upsert({
    where: { key_subject: { key: input.key, subject } },
    create: { key: input.key, subject, adminId: input.adminId, note: input.note ?? '', snapshot },
    update: { adminId: input.adminId, note: input.note ?? '', snapshot },
    include: { admin: { select: { username: true } } },
  });
  return {
    id: ack.id,
    key: ack.key,
    subject: ack.subject,
    adminName: ack.admin?.username ?? null,
    note: ack.note,
    snapshot: (ack.snapshot ?? {}) as Record<string, unknown>,
    createdAt: ack.createdAt,
  };
}

export async function deleteAlertAck(id: string) {
  const existing = await prisma.alertAck.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError('告警确认', id);
  await prisma.alertAck.delete({ where: { id } });
  return { id, key: existing.key };
}

export const alertOpsService = {
  overview,
  listAlertRules,
  updateAlertRule,
  resetAlertRule,
  listAlertAcks,
  createAlertAck,
  deleteAlertAck,
};
