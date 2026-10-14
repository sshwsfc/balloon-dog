import { useState } from 'react'
import { Loader2, RefreshCw, Save } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input, Textarea } from '@/components/ui/input'
import { api, errorMessageOf, formatDateTime, type ReferralConfigView } from '../../api'
import { useAsyncData } from '../../hooks/useAsyncData'
import { DataState, PageHeader, ToneBadge } from '../../components/ui-kit'
import { centsToYuan, yuanToCents } from './shared'

interface ConfigForm {
  title: string
  subtitle: string
  enabled: boolean
  noticeText: string
  startedAt: string
  endsAt: string
  withdrawMinInvitees: string
  withdrawMinYuan: string
  withdrawRequireVerified: boolean
  settleDayStart: string
  settleDayEnd: string
}

/** ISO → `datetime-local` 需要的本地 `YYYY-MM-DDTHH:mm`。 */
function toLocalInput(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** `datetime-local` 的值 → ISO；空值 → null。按本地时区解析，与服务端 `new Date(raw)` 一致。 */
function toIso(value: string): string | null {
  if (!value) return null
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

function formFrom(config: ReferralConfigView): ConfigForm {
  return {
    title: config.title,
    subtitle: config.subtitle,
    enabled: config.enabled,
    noticeText: config.notice.join('\n'),
    startedAt: toLocalInput(config.startedAt),
    endsAt: toLocalInput(config.endsAt),
    withdrawMinInvitees: String(config.withdrawMinInvitees),
    withdrawMinYuan: centsToYuan(config.withdrawMinCents),
    withdrawRequireVerified: config.withdrawRequireVerified,
    settleDayStart: String(config.settleDayStart),
    settleDayEnd: String(config.settleDayEnd),
  }
}

/**
 * 活动配置表单。
 *
 * 初始值只在**挂载时**从接口数据读一次（`useState` 初始化），保存成功后由外层
 * 用 `key={updatedAt}` 重新挂载 —— 这样不需要「数据到了再 setState」的 effect，
 * 也就不会踩到 `react-hooks/set-state-in-effect`。
 */
function ConfigForm({ initial, onSaved }: { initial: ReferralConfigView; onSaved: () => void }) {
  const [form, setForm] = useState<ConfigForm>(() => formFrom(initial))
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  const dirty = JSON.stringify(form) !== JSON.stringify(formFrom(initial))

  const set = <K extends keyof ConfigForm>(key: K, value: ConfigForm[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }))

  const noticeLines = form.noticeText
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)

  const submit = async () => {
    setFormError(null)

    if (!form.title.trim()) return setFormError('请填写活动标题')
    if (form.title.trim().length > 60) return setFormError('活动标题不能超过 60 个字')
    if (!form.subtitle.trim()) return setFormError('请填写活动副标题')
    if (form.subtitle.trim().length > 120) return setFormError('活动副标题不能超过 120 个字')
    if (noticeLines.length > 20) return setFormError('奖励说明最多 20 行')
    const tooLong = noticeLines.find((line) => line.length > 300)
    if (tooLong) return setFormError('每行奖励说明不能超过 300 个字')

    const minInvitees = Number(form.withdrawMinInvitees)
    if (!Number.isInteger(minInvitees) || minInvitees < 0 || minInvitees > 1000) {
      return setFormError('提现门槛人数需为 0-1000 的整数')
    }

    const minCents = yuanToCents(form.withdrawMinYuan)
    if (!Number.isFinite(minCents) || minCents < 0 || minCents > 10000000) {
      return setFormError('提现门槛金额需在 ￥0.00 - ￥100,000.00 之间')
    }

    const dayStart = Number(form.settleDayStart)
    const dayEnd = Number(form.settleDayEnd)
    if (!Number.isInteger(dayStart) || dayStart < 1 || dayStart > 28) {
      return setFormError('结算开始日需为 1-28 的整数')
    }
    if (!Number.isInteger(dayEnd) || dayEnd < 1 || dayEnd > 28) {
      return setFormError('结算结束日需为 1-28 的整数')
    }
    if (dayEnd < dayStart) return setFormError('结算结束日不能早于开始日')

    const startedAt = toIso(form.startedAt)
    const endsAt = toIso(form.endsAt)
    if (startedAt && endsAt && new Date(endsAt) <= new Date(startedAt)) {
      return setFormError('活动结束时间必须晚于开始时间')
    }

    setSaving(true)
    try {
      await api.referral.config.update({
        title: form.title.trim(),
        subtitle: form.subtitle.trim(),
        enabled: form.enabled,
        notice: noticeLines,
        startedAt,
        endsAt,
        withdrawMinInvitees: minInvitees,
        withdrawMinCents: minCents,
        withdrawRequireVerified: form.withdrawRequireVerified,
        settleDayStart: dayStart,
        settleDayEnd: dayEnd,
      })
      toast.success('活动配置已保存')
      onSaved()
    } catch (error: unknown) {
      const message = errorMessageOf(error, '保存失败，请稍后重试')
      setFormError(message)
      toast.error(message)
      console.error('保存活动配置失败：', error)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-3">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium">基本信息</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-3 p-4 pt-0 lg:grid-cols-2">
          <label className="block space-y-1">
            <span className="text-xs text-muted-foreground">活动标题（1-60 字）</span>
            <Input value={form.title} onChange={(e) => set('title', e.target.value)} maxLength={60} />
          </label>
          <label className="block space-y-1">
            <span className="text-xs text-muted-foreground">活动副标题（1-120 字）</span>
            <Input value={form.subtitle} onChange={(e) => set('subtitle', e.target.value)} maxLength={120} />
          </label>

          <label className="flex items-center gap-2 lg:col-span-2">
            <input
              type="checkbox"
              checked={form.enabled}
              onChange={(e) => set('enabled', e.target.checked)}
            />
            <span className="text-sm text-foreground">启用活动</span>
            <span className="text-xs text-muted-foreground">
              （关掉后家长端不再展示入口、不再产生新的邀请关系与返现；已产生的账不受影响）
            </span>
          </label>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium">活动时间</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-3 p-4 pt-0 lg:grid-cols-2">
          <label className="block space-y-1">
            <span className="text-xs text-muted-foreground">开始时间</span>
            <Input
              type="datetime-local"
              value={form.startedAt}
              onChange={(e) => set('startedAt', e.target.value)}
            />
          </label>
          <label className="block space-y-1">
            <span className="text-xs text-muted-foreground">结束时间（留空 = 长期有效）</span>
            <Input
              type="datetime-local"
              value={form.endsAt}
              onChange={(e) => set('endsAt', e.target.value)}
            />
          </label>
          <p className="text-xs text-muted-foreground lg:col-span-2">
            时间按浏览器所在时区录入与展示。结束时间必须晚于开始时间，否则保存会被拒绝。
          </p>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">提现门槛</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 p-4 pt-0">
            <label className="block space-y-1">
              <span className="text-xs text-muted-foreground">最少有效邀请人数（0-1000）</span>
              <Input
                type="number"
                min={0}
                max={1000}
                value={form.withdrawMinInvitees}
                onChange={(e) => set('withdrawMinInvitees', e.target.value)}
              />
            </label>
            <label className="block space-y-1">
              <span className="text-xs text-muted-foreground">最少可提现金额（元）</span>
              <Input
                type="number"
                min={0}
                step="0.01"
                value={form.withdrawMinYuan}
                onChange={(e) => set('withdrawMinYuan', e.target.value)}
              />
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={form.withdrawRequireVerified}
                onChange={(e) => set('withdrawRequireVerified', e.target.checked)}
              />
              <span className="text-sm text-foreground">提现必须完成实名认证</span>
            </label>
            <p className="text-xs text-muted-foreground">
              门槛只在「申请提现」时校验；调高门槛不会影响已经提交的申请。
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">结算窗口</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 p-4 pt-0">
            <div className="grid grid-cols-2 gap-3">
              <label className="block space-y-1">
                <span className="text-xs text-muted-foreground">开始日（1-28）</span>
                <Input
                  type="number"
                  min={1}
                  max={28}
                  value={form.settleDayStart}
                  onChange={(e) => set('settleDayStart', e.target.value)}
                />
              </label>
              <label className="block space-y-1">
                <span className="text-xs text-muted-foreground">结束日（1-28）</span>
                <Input
                  type="number"
                  min={1}
                  max={28}
                  value={form.settleDayEnd}
                  onChange={(e) => set('settleDayEnd', e.target.value)}
                />
              </label>
            </div>
            <p className="text-xs text-muted-foreground">
              每月这个日期区间内把上月累计的待发放返现统一置为已发放。上限 28 是为了每个月都有这一天。
            </p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium">奖励说明（家长端展示）</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 p-4 pt-0">
          <Textarea
            rows={6}
            value={form.noticeText}
            onChange={(e) => set('noticeText', e.target.value)}
            placeholder={'一行一条，空行会被自动忽略，最多 20 行\n例如：好友首次充值后，返现金额于次月发放'}
          />
          <p className="text-xs text-muted-foreground">
            当前 {noticeLines.length} / 20 行，每行最多 300 字。保存时会去掉空行。
          </p>
        </CardContent>
      </Card>

      <Card className="border-dashed">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium">家长端预览</CardTitle>
        </CardHeader>
        <CardContent className="space-y-1 p-4 pt-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-foreground">{form.title || '（未填标题）'}</span>
            <ToneBadge tone={form.enabled ? 'green' : 'gray'}>{form.enabled ? '进行中' : '已停用'}</ToneBadge>
          </div>
          <p className="text-xs text-muted-foreground">{form.subtitle || '（未填副标题）'}</p>
          <ul className="list-disc space-y-0.5 pl-4 text-xs text-muted-foreground">
            {noticeLines.length === 0 ? <li>（暂无奖励说明）</li> : null}
            {noticeLines.map((line, i) => (
              <li key={`${i}-${line}`}>{line}</li>
            ))}
          </ul>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="flex flex-wrap items-center gap-3 p-3">
          <Button onClick={submit} disabled={saving || !dirty}>
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
            {saving ? '保存中…' : '保存配置'}
          </Button>
          {!dirty ? (
            <span className="text-xs text-muted-foreground">没有未保存的修改</span>
          ) : (
            <span className="text-xs text-amber-600">有未保存的修改</span>
          )}
          {formError ? <span className="text-xs text-destructive">{formError}</span> : null}
          <span className="ml-auto text-xs text-muted-foreground">
            上次保存：{formatDateTime(initial.updatedAt)}
          </span>
        </CardContent>
      </Card>
    </div>
  )
}

/** 活动配置：开关、文案、时间窗、提现门槛与结算窗口。 */
export function ConfigTab() {
  const {
    data,
    loading,
    error,
    reload: load,
  } = useAsyncData(() => api.referral.config.get(), { deps: [] })

  return (
    <div>
      <PageHeader
        title="活动配置"
        description="这里改的是家长端正在看的那份活动。保存后立即生效，改动会记入操作日志。"
        actions={
          <Button variant="outline" size="sm" onClick={load} disabled={loading}>
            {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            重新加载
          </Button>
        }
      />

      <DataState
        loading={loading && !data}
        error={error}
        empty={!data}
        emptyText="暂无活动配置"
        onRetry={load}
      >
        {data ? (
          // key 绑 updatedAt：保存成功后重新拉取会换 key，表单随之拿到服务端的最终值
          <ConfigForm key={data.updatedAt} initial={data} onSaved={load} />
        ) : null}
      </DataState>
    </div>
  )
}
