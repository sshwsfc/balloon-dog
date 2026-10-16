import { useState } from 'react'
import { Loader2, Pencil, RefreshCw, RotateCcw } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input, Select, Textarea } from '@/components/ui/input'
import { Card } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
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
import {
  api,
  errorMessageOf,
  formatDateTime,
  type AlertRulePatch,
  type AlertRuleRow,
  type AlertSeverity,
} from '../../api'
import { useAsyncData } from '../../hooks/useAsyncData'
import { SEVERITY_OPTIONS, formatThreshold, severityView, windowText } from './shared'

interface RuleForm {
  enabled: boolean
  severity: string
  threshold: string
  windowMinutes: string
  note: string
}

const EMPTY_FORM: RuleForm = { enabled: true, severity: 'warn', threshold: '0', windowMinutes: '0', note: '' }

/**
 * 「即时快照」指标不能改统计窗口（后端会 400：`x` 是即时快照指标，没有统计窗口）。
 *
 * 后端 `listAlertRules()` **没有返回 `kind`**（只有 unit / denominatorText /
 * defaultWindowMinutes），所以这里用「代码默认窗口为 0」反推点指标 ——
 * 契约里点指标（设备失联率、管控失效率）的默认窗口就是 0，窗口类（60 分钟）不是。
 * 一旦后端补上 `kind`，这个反推应当删掉。
 */
function isPointRule(rule: AlertRuleRow): boolean {
  return rule.defaultWindowMinutes === 0
}

/**
 * 告警规则。
 *
 * 改口径（阈值 / 严重度 / 窗口 / 开关）都在这里；「恢复默认」删的是数据库行，
 * 删除后重新按代码里 `ALERT_RULES` 的口径计算，不是把当前值再写回一次。
 */
export function RulesTab() {
  const { data, loading, error, reload: load } = useAsyncData(() => api.alerts.rules(), { deps: [] })

  const [editFor, setEditFor] = useState<AlertRuleRow | null>(null)
  const [form, setForm] = useState<RuleForm>(EMPTY_FORM)
  const [formError, setFormError] = useState('')
  const [saving, setSaving] = useState(false)

  const [resetFor, setResetFor] = useState<AlertRuleRow | null>(null)
  const [resetSaving, setResetSaving] = useState(false)

  const openEdit = (rule: AlertRuleRow) => {
    setEditFor(rule)
    setForm({
      enabled: rule.enabled,
      severity: rule.severity,
      threshold: String(rule.threshold),
      windowMinutes: String(rule.windowMinutes),
      note: rule.note,
    })
    setFormError('')
  }

  const submit = async () => {
    if (!editFor) return
    const threshold = Number(form.threshold)
    const windowMinutes = Number(form.windowMinutes)
    const point = isPointRule(editFor)

    if (!Number.isInteger(threshold) || threshold < 0 || threshold > 100_000) {
      setFormError('阈值必须是 0 - 100000 之间的整数')
      return
    }
    if (!point && (!Number.isInteger(windowMinutes) || windowMinutes < 0 || windowMinutes > 1440)) {
      setFormError('统计窗口必须是 0 - 1440 分钟之间的整数（0 = 即时快照）')
      return
    }
    if (form.note.length > 200) {
      setFormError('说明不能超过 200 个字')
      return
    }

    const patch: AlertRulePatch = {
      enabled: form.enabled,
      severity: form.severity as AlertSeverity,
      threshold,
      note: form.note.trim(),
    }
    // 点指标不传 windowMinutes：传了非 0 会被后端拒绝
    if (!point) patch.windowMinutes = windowMinutes

    setSaving(true)
    setFormError('')
    try {
      await api.alerts.updateRule(editFor.key, patch)
      toast.success(`已更新「${editFor.label}」`)
      setEditFor(null)
      load()
    } catch (err: unknown) {
      setFormError(errorMessageOf(err, '保存失败，请稍后重试'))
      console.error('更新告警规则失败：', err)
    } finally {
      setSaving(false)
    }
  }

  const confirmReset = async () => {
    if (!resetFor) return
    setResetSaving(true)
    try {
      await api.alerts.resetRule(resetFor.key)
      toast.success(`「${resetFor.label}」已恢复代码默认口径`)
      setResetFor(null)
      load()
    } catch (err: unknown) {
      toast.error(errorMessageOf(err, '恢复默认失败，请稍后重试'))
      console.error('恢复告警规则默认失败：', err)
    } finally {
      setResetSaving(false)
    }
  }

  const rules = data?.rules ?? []

  return (
    <div>
      <PageHeader
        title="告警规则"
        description="阈值、严重度与统计窗口。规则 key 是代码里定义好的白名单，这里只能改口径、不能新增或删除。"
        actions={
          <Button variant="outline" size="sm" onClick={load} disabled={loading}>
            {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            刷新
          </Button>
        }
      />

      <Card className="overflow-hidden">
        <DataState
          loading={loading && !data}
          error={error}
          empty={rules.length === 0}
          emptyText="没有可用的告警规则"
          onRetry={load}
        >
          <div className="admin-table-scroll">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-56">规则</TableHead>
                  <TableHead className="w-24">状态</TableHead>
                  <TableHead className="w-20">严重度</TableHead>
                  <TableHead className="w-24 text-right">阈值</TableHead>
                  <TableHead className="w-28">统计窗口</TableHead>
                  <TableHead className="w-64">分母口径</TableHead>
                  <TableHead className="w-36">来源</TableHead>
                  <TableHead className="w-40 text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rules.map((rule) => {
                  const sev = severityView(rule.severity)
                  return (
                    <TableRow key={rule.key}>
                      <TableCell>
                        <div className="text-sm text-foreground">{rule.label}</div>
                        <div className="font-mono text-[11px] text-muted-foreground">{rule.key}</div>
                      </TableCell>
                      <TableCell>
                        <ToneBadge tone={rule.enabled ? 'green' : 'gray'}>
                          {rule.enabled ? '启用' : '停用'}
                        </ToneBadge>
                      </TableCell>
                      <TableCell>
                        <ToneBadge tone={sev.tone}>{sev.label}</ToneBadge>
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-right tabular-nums text-sm">
                        {formatThreshold(rule.threshold, rule.unit)}
                        {rule.threshold !== rule.defaultThreshold ? (
                          <div className="text-[11px] text-muted-foreground">
                            默认 {formatThreshold(rule.defaultThreshold, rule.unit)}
                          </div>
                        ) : null}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                        {windowText(rule.windowMinutes)}
                        {isPointRule(rule) ? (
                          <div className="text-[11px]">即时快照指标</div>
                        ) : (
                          <div className="text-[11px]">默认 {windowText(rule.defaultWindowMinutes)}</div>
                        )}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">{rule.denominatorText}</TableCell>
                      <TableCell className="text-xs">
                        {rule.usingDefaults ? (
                          <ToneBadge tone="blue">代码默认值</ToneBadge>
                        ) : (
                          <>
                            <ToneBadge tone="amber">已改动</ToneBadge>
                            <div className="mt-1 text-[11px] text-muted-foreground">
                              {formatDateTime(rule.updatedAt)}
                            </div>
                          </>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-1">
                          <Button variant="ghost" size="sm" onClick={() => openEdit(rule)}>
                            <Pencil className="h-3.5 w-3.5" />
                            编辑
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={rule.usingDefaults}
                            title={rule.usingDefaults ? '已经是代码默认口径' : '删除改动，恢复代码默认口径'}
                            onClick={() => setResetFor(rule)}
                          >
                            <RotateCcw className="h-3.5 w-3.5" />
                            恢复默认
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </div>
        </DataState>
      </Card>

      <Dialog open={Boolean(editFor)} onOpenChange={(open) => (!open ? setEditFor(null) : null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>编辑规则：{editFor?.label}</DialogTitle>
            <DialogDescription>
              {editFor ? `key ${editFor.key} · 分母 ${editFor.denominatorText}` : ''}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="h-4 w-4 accent-[#07c160]"
                checked={form.enabled}
                onChange={(e) => setForm((prev) => ({ ...prev, enabled: e.target.checked }))}
              />
              启用这条规则（停用后只统计、不判触发）
            </label>

            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block space-y-1">
                <span className="text-xs text-muted-foreground">严重度</span>
                <Select
                  value={form.severity}
                  onChange={(e) => setForm((prev) => ({ ...prev, severity: e.target.value }))}
                >
                  {SEVERITY_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </Select>
              </label>

              <label className="block space-y-1">
                <span className="text-xs text-muted-foreground">
                  阈值（{editFor?.unit === '%' ? '百分数，30 表示 30%' : '条数'}）
                </span>
                <Input
                  value={form.threshold}
                  inputMode="numeric"
                  onChange={(e) =>
                    setForm((prev) => ({ ...prev, threshold: e.target.value.replace(/[^\d]/g, '') }))
                  }
                />
              </label>
            </div>

            <label className="block space-y-1">
              <span className="text-xs text-muted-foreground">统计窗口（分钟，0 = 即时快照）</span>
              <Input
                value={form.windowMinutes}
                inputMode="numeric"
                disabled={editFor ? isPointRule(editFor) : false}
                onChange={(e) =>
                  setForm((prev) => ({ ...prev, windowMinutes: e.target.value.replace(/[^\d]/g, '') }))
                }
              />
              {editFor && isPointRule(editFor) ? (
                <span className="text-[11px] text-amber-700">即时快照指标没有统计窗口，不能修改</span>
              ) : null}
            </label>

            <label className="block space-y-1">
              <span className="text-xs text-muted-foreground">说明（可选，最多 200 字）</span>
              <Textarea
                rows={2}
                maxLength={200}
                value={form.note}
                onChange={(e) => setForm((prev) => ({ ...prev, note: e.target.value }))}
              />
            </label>

            {formError ? <p className="text-xs text-destructive">{formError}</p> : null}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setEditFor(null)} disabled={saving}>
              取消
            </Button>
            <Button onClick={submit} disabled={saving}>
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={Boolean(resetFor)}
        onOpenChange={(open) => (!open ? setResetFor(null) : null)}
        title="恢复代码默认口径"
        description={
          resetFor
            ? `将删除「${resetFor.label}」在数据库里的改动，恢复为：${severityView(resetFor.defaultSeverity).label} · 阈值 ${formatThreshold(
                resetFor.defaultThreshold,
                resetFor.unit,
              )} · ${windowText(resetFor.defaultWindowMinutes)}。`
            : undefined
        }
        confirmText="恢复默认"
        loading={resetSaving}
        onConfirm={confirmReset}
      />
    </div>
  )
}
