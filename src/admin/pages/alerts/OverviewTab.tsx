import { useState } from 'react'
import { AlertTriangle, CheckCircle2, Loader2, RefreshCw, ShieldAlert } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/input'
import { Card, CardContent } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { ConfirmDialog } from '../../components/ConfirmDialog'
import { DataState, PageHeader, ToneBadge } from '../../components/ui-kit'
import { api, errorMessageOf, formatDateTime, type AlertMetric, type AlertView } from '../../api'
import { useAsyncData } from '../../hooks/useAsyncData'
import {
  SAMPLE_LIMIT,
  formatMetricValue,
  formatThreshold,
  scaleText,
  severityView,
  snapshotNumber,
  windowText,
} from './shared'

/** 指标卡：一眼看到「是多少」和「分母是谁」。 */
function MetricCard({ metric }: { metric: AlertMetric }) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-2">
          <span className="text-sm font-medium text-foreground">{metric.label}</span>
          <ToneBadge tone="gray">{windowText(metric.windowMinutes)}</ToneBadge>
        </div>
        <div className="mt-2 text-2xl font-semibold tabular-nums text-foreground">
          {formatMetricValue(metric.value, metric.unit)}
        </div>
        <div className="mt-1 font-mono text-[11px] text-muted-foreground">
          分子 {metric.numerator} / 分母 {metric.denominator}
        </div>
        {/* 分母口径放这里而不是 tooltip：运营要先知道这个数字的分母是谁，才谈得上告警是否合理 */}
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
          分母：{metric.denominatorText || '未说明'}
        </p>
        {metric.value === null ? (
          <p className="mt-1 text-xs text-amber-700">暂无可统计对象（分母为 0），因此不判为事故</p>
        ) : null}
      </CardContent>
    </Card>
  )
}

/** 一条告警：触发状态、阈值、口径、样本与确认状态。 */
function AlertCard({
  alert,
  onAck,
  onRevoke,
}: {
  alert: AlertView
  onAck: (alert: AlertView) => void
  onRevoke: (alert: AlertView) => void
}) {
  const sev = severityView(alert.severity)

  return (
    <Card className={alert.triggered ? 'border-destructive/40' : undefined}>
      <CardContent className="p-4">
        <div className="flex flex-wrap items-center gap-2">
          <ToneBadge tone={sev.tone}>{sev.label}</ToneBadge>
          <span className="text-sm font-medium text-foreground">{alert.label}</span>
          {alert.triggered ? (
            <ToneBadge tone="red">触发中</ToneBadge>
          ) : (
            <ToneBadge tone="green">未触发</ToneBadge>
          )}
          {!alert.enabled ? <ToneBadge tone="gray">已停用</ToneBadge> : null}
          {alert.usingDefaults ? <ToneBadge tone="blue">代码默认值</ToneBadge> : null}
          <ToneBadge tone="gray">{windowText(alert.windowMinutes)}</ToneBadge>
          <span className="ml-auto font-mono text-[11px] text-muted-foreground">{alert.key}</span>
        </div>

        <div className="mt-3 flex flex-wrap items-baseline gap-x-4 gap-y-1">
          <span className="text-xl font-semibold tabular-nums text-foreground">
            {formatMetricValue(alert.value, alert.unit)}
          </span>
          <span className="text-xs text-muted-foreground">
            阈值 ≥ {formatThreshold(alert.threshold, alert.unit)}
          </span>
          <span className="font-mono text-[11px] text-muted-foreground">
            分子 {alert.numerator} / 分母 {alert.denominator}
          </span>
        </div>

        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
          分母：{alert.denominatorText || '未说明'}
        </p>
        {alert.note ? <p className="mt-1 text-xs text-muted-foreground">{alert.note}</p> : null}
        {alert.value === null ? (
          <p className="mt-1 text-xs text-amber-700">暂无可统计对象，显示「—」而不是「0%」</p>
        ) : null}

        {alert.triggered && alert.samples.length > 0 ? (
          <div className="mt-3 rounded-lg bg-muted p-3">
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <AlertTriangle className="h-3.5 w-3.5" />
              <span>
                样本（最多 {SAMPLE_LIMIT} 条，事故规模 {scaleText(alert.numerator, alert.unit)}）
              </span>
            </div>
            <ul className="mt-2 space-y-1">
              {alert.samples.map((sample, index) => (
                <li key={`${sample.title}-${index}`} className="text-xs">
                  <span className="font-medium text-foreground">{sample.title}</span>
                  <span className="ml-2 text-muted-foreground">{sample.detail}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border pt-3">
          {alert.ack ? (
            <>
              <ShieldAlert className="h-4 w-4 text-muted-foreground" />
              <span className="text-xs text-muted-foreground">
                已由 {alert.ack.adminName || '管理员'} 于 {formatDateTime(alert.ack.createdAt)} 确认
                {alert.ack.note ? `：${alert.ack.note}` : ''}
              </span>
              {/* 确认只是「我看过了」，不是放行：只要指标还越线，就要继续显示触发中 */}
              {alert.triggered ? <ToneBadge tone="red">确认后仍处于触发状态</ToneBadge> : null}
              <Button variant="outline" size="sm" className="ml-auto" onClick={() => onRevoke(alert)}>
                撤销确认
              </Button>
            </>
          ) : (
            <>
              <CheckCircle2 className="h-4 w-4 text-muted-foreground" />
              <span className="text-xs text-muted-foreground">
                尚未确认。确认只记录「已看过」，不会解除触发状态。
              </span>
              <Button
                variant="outline"
                size="sm"
                className="ml-auto"
                disabled={!alert.triggered}
                title={alert.triggered ? '确认这条告警' : '未触发时不产生确认记录'}
                onClick={() => onAck(alert)}
              >
                确认告警
              </Button>
            </>
          )}
        </div>
      </CardContent>
    </Card>
  )
}

/**
 * 告警总览。
 *
 * 顺序**完全照抄后端**：触发的在前 → 严重度 → 数值降序（`alerts.service.overview()`
 * 已经排好），前端再排一次就会出现两套口径。
 */
export function OverviewTab() {
  const { data, loading, error, reload: load } = useAsyncData(() => api.alerts.overview(), { deps: [] })

  const [ackFor, setAckFor] = useState<AlertView | null>(null)
  const [ackNote, setAckNote] = useState('')
  const [ackSaving, setAckSaving] = useState(false)
  const [ackError, setAckError] = useState('')
  const [revokeFor, setRevokeFor] = useState<AlertView | null>(null)
  const [revokeSaving, setRevokeSaving] = useState(false)

  const openAck = (alert: AlertView) => {
    setAckFor(alert)
    setAckNote('')
    setAckError('')
  }

  const confirmAck = async () => {
    if (!ackFor) return
    const note = ackNote.trim()
    if (note.length > 200) {
      setAckError('备注不能超过 200 个字')
      return
    }
    setAckSaving(true)
    setAckError('')
    try {
      // 不传 snapshot：确认时的指标快照由服务端自己算（传了会被 422 拒绝）
      await api.alerts.ack({ key: ackFor.key, note: note || undefined })
      toast.success(`已确认「${ackFor.label}」`)
      setAckFor(null)
      load()
    } catch (err: unknown) {
      setAckError(errorMessageOf(err, '确认失败，请稍后重试'))
      console.error('确认告警失败：', err)
    } finally {
      setAckSaving(false)
    }
  }

  const confirmRevoke = async () => {
    if (!revokeFor?.ack) return
    setRevokeSaving(true)
    try {
      await api.alerts.removeAck(revokeFor.ack.id)
      toast.success('已撤销确认')
      setRevokeFor(null)
      load()
    } catch (err: unknown) {
      toast.error(errorMessageOf(err, '撤销失败，请稍后重试'))
      console.error('撤销确认失败：', err)
    } finally {
      setRevokeSaving(false)
    }
  }

  const alerts = data?.alerts ?? []
  const metrics = data?.metrics ?? []
  const triggeredCount = alerts.filter((a) => a.triggered).length

  return (
    <div>
      <PageHeader
        title="告警大盘"
        description="五个运营指标的当前口径与触发情况。告警是「读时计算」：没有后台扫描任务，也不会发短信/微信/电话（无出站告警是刻意不做，不是还没做）。"
        actions={
          <Button variant="outline" size="sm" onClick={load} disabled={loading}>
            {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            刷新
          </Button>
        }
      />

      <DataState loading={loading && !data} error={error} empty={false} onRetry={load}>
        <div className="mb-4 flex flex-wrap items-center gap-3 text-sm">
          <ToneBadge tone={triggeredCount > 0 ? 'red' : 'green'}>
            触发中 {triggeredCount} / {alerts.length}
          </ToneBadge>
          <span className="text-xs text-muted-foreground">
            统计时间 {formatDateTime(data?.generatedAt)}
          </span>
        </div>

        <div className="mb-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {metrics.map((metric) => (
            <MetricCard key={metric.key} metric={metric} />
          ))}
        </div>

        <div className="space-y-3">
          {alerts.map((alert) => (
            <AlertCard key={alert.key} alert={alert} onAck={openAck} onRevoke={setRevokeFor} />
          ))}
        </div>
      </DataState>

      <Dialog open={Boolean(ackFor)} onOpenChange={(open) => (!open ? setAckFor(null) : null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>确认告警：{ackFor?.label}</DialogTitle>
            <DialogDescription>
              确认记录的是「谁在什么时候看过了」，快照由服务端当场计算。
              {ackFor?.triggered ? '确认不等于放行：指标仍然越线时，这条告警会继续显示为触发中。' : ''}
            </DialogDescription>
          </DialogHeader>

          <label className="block space-y-1">
            <span className="text-xs text-muted-foreground">备注（可选，最多 200 字）</span>
            <Textarea
              rows={3}
              maxLength={200}
              placeholder="例如：已定位为某型号设备批量掉线，正在处理"
              value={ackNote}
              onChange={(e) => setAckNote(e.target.value)}
            />
          </label>
          {ackError ? <p className="text-xs text-destructive">{ackError}</p> : null}

          <DialogFooter>
            <Button variant="outline" onClick={() => setAckFor(null)} disabled={ackSaving}>
              取消
            </Button>
            <Button onClick={confirmAck} disabled={ackSaving}>
              {ackSaving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              确认
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={Boolean(revokeFor)}
        onOpenChange={(open) => (!open ? setRevokeFor(null) : null)}
        title="撤销确认"
        description={
          revokeFor
            ? `撤销「${revokeFor.label}」的确认记录后，这条告警会回到未确认状态。撤销是删除记录，不是标记失效。`
            : undefined
        }
        confirmText="撤销确认"
        loading={revokeSaving}
        onConfirm={confirmRevoke}
      >
        {revokeFor?.ack ? (
          <div className="space-y-1 rounded-lg bg-muted p-3 text-xs text-muted-foreground">
            <div>确认人：{revokeFor.ack.adminName || '管理员'}</div>
            <div>确认时间：{formatDateTime(revokeFor.ack.createdAt)}</div>
            <div>确认备注：{revokeFor.ack.note || '（无）'}</div>
            <div>
              当时快照：{formatMetricValue(snapshotNumber(revokeFor.ack.snapshot, 'value'), revokeFor.unit)}
              （阈值 {formatThreshold(revokeFor.threshold, revokeFor.unit)}）
            </div>
          </div>
        ) : null}
      </ConfirmDialog>
    </div>
  )
}
