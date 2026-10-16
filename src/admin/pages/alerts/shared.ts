import type { Tone } from '../../components/status'
import type { AlertSeverity, AlertUnit } from '../../api'

/**
 * 告警大盘的共享口径。
 *
 * 有三件事必须和 `server/src/features/opsalert/alerts.service.ts` 保持一致，
 * 所以集中在这里，避免各 Tab 各写一份：
 *  1. **`value` 是百分数**（后端 `ratio()` 已经乘过 100），不是 0-1 比例；
 *  2. `value === null` 表示分母为 0（没有可统计对象），要显示「—」而不是「0%」；
 *  3. `windowMinutes === 0` 表示即时快照（点指标），不是「窗口 0 分钟」。
 */

/** 严重度。数值排序由后端负责（SEVERITY_RANK），前端只展示。 */
export const SEVERITY_VIEW: Record<AlertSeverity, { label: string; tone: Tone }> = {
  danger: { label: '严重', tone: 'red' },
  warn: { label: '警告', tone: 'amber' },
  info: { label: '提示', tone: 'blue' },
}

export const SEVERITY_OPTIONS: { value: AlertSeverity; label: string }[] = [
  { value: 'info', label: '提示' },
  { value: 'warn', label: '警告' },
  { value: 'danger', label: '严重' },
]

export function severityView(severity: string): { label: string; tone: Tone } {
  return SEVERITY_VIEW[severity as AlertSeverity] ?? { label: severity, tone: 'gray' }
}

/**
 * 指标值 → 展示文本。**不要用 `formatRate()`**：那个函数按 0-1 比例处理，
 * 会把 30% 显示成 3000%。`null` 一律「—」。
 */
export function formatMetricValue(value: number | null | undefined, unit: AlertUnit): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  return unit === '%' ? `${value}%` : `${value} 条`
}

export function formatThreshold(threshold: number, unit: AlertUnit): string {
  return unit === '%' ? `${threshold}%` : `${threshold} 条`
}

/** 窗口说明：0 是即时快照，不是「0 分钟」。 */
export function windowText(windowMinutes: number): string {
  return windowMinutes > 0 ? `${windowMinutes} 分钟窗口` : '即时快照'
}

/** 分子是「多少个对象 / 多少条事件」——样本最多 5 条，真实规模看分子。 */
export function scaleText(numerator: number, unit: AlertUnit): string {
  return unit === '%' ? `${numerator} 个对象` : `${numerator} 条事件`
}

/**
 * 确认快照里读一个数字字段。
 * `snapshot` 在后端是 `Record<string, unknown>`（JSONB），取用前必须自己收窄类型。
 */
export function snapshotNumber(snapshot: Record<string, unknown>, key: string): number | null {
  const value = snapshot[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export const SAMPLE_LIMIT = 5
