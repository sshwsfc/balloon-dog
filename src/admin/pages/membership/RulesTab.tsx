import { useState } from 'react'
import { AlertTriangle, Calculator, Loader2, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input, Select, Textarea } from '@/components/ui/input'
import { Card, CardContent } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  api,
  errorMessageOf,
  type MembershipAdjustment,
  type MembershipRuleRow,
} from '../../api'
import { useAsyncData, useFilters } from '../../hooks/useAsyncData'
import { DataState, PageHeader, Pagination, ToneBadge } from '../../components/ui-kit'
import { ConfirmDialog } from '../../components/ConfirmDialog'
import {
  CONDITION_OPTIONS,
  DISCOUNT_OPTIONS,
  TARGET_PERIOD_OPTIONS,
  TARGET_TIER_OPTIONS,
  centsToYuan,
  formatCents,
  yuanToCents,
} from './shared'

interface RuleForm {
  name: string
  conditionType: string
  conditionMinDevices: string
  conditionDays: string
  conditionFromTier: string
  targetTier: string
  targetPeriod: string
  discountType: string
  discountValue: string
  stackable: boolean
  priority: string
  enabled: boolean
  note: string
}

const EMPTY_FORM: RuleForm = {
  name: '',
  conditionType: 'always',
  conditionMinDevices: '2',
  conditionDays: '7',
  conditionFromTier: 'member',
  targetTier: 'all',
  targetPeriod: 'all',
  discountType: 'percent',
  discountValue: '10',
  stackable: true,
  priority: '50',
  enabled: true,
  note: '',
}

/** 只有这几种条件需要额外参数，表单按需显示对应输入框。 */
function conditionNeeds(type: string): 'devices' | 'days' | 'tier' | null {
  if (type === 'device_count') return 'devices'
  if (type === 'registered_within_days') return 'days'
  if (type === 'tier_upgrade') return 'tier'
  return null
}

/**
 * 定价规则管理。
 *
 * 规则引擎的口径（家长端与后台试算共用同一套代码）：
 *  - 折扣一律按**原价**计算再相加，不做折上折；
 *  - 标「不可叠加」的规则，同一单里只有优先级最高的一条生效；
 *  - 实付有 1 元下限。
 * 这三条写在页面上，否则管理员看到「打了 9 折又打 8 折，怎么不是 72 折」会以为算错了。
 */
export function RulesTab() {
  const { filters, setFilter, page, setPage, pageSize, changePageSize } = useFilters({
    conditionType: '',
    enabled: '',
  })

  const { data, loading, error, reload: load } = useAsyncData(
    () =>
      api.membership.rules.list({
        conditionType: filters.conditionType || undefined,
        enabled: filters.enabled || undefined,
        page,
        pageSize,
      }),
    { deps: [filters.conditionType, filters.enabled, page, pageSize] },
  )

  const [editing, setEditing] = useState<MembershipRuleRow | null>(null)
  const [creating, setCreating] = useState(false)
  const [form, setForm] = useState<RuleForm>(EMPTY_FORM)
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [removing, setRemoving] = useState<MembershipRuleRow | null>(null)
  const [simulating, setSimulating] = useState(false)

  const openCreate = () => {
    setForm(EMPTY_FORM)
    setFormError(null)
    setCreating(true)
  }

  const openEdit = (rule: MembershipRuleRow) => {
    setForm({
      name: rule.name,
      conditionType: rule.conditionType,
      conditionMinDevices: String(rule.conditionMinDevices ?? 2),
      conditionDays: String(rule.conditionDays ?? 7),
      conditionFromTier: rule.conditionFromTier ?? 'member',
      targetTier: rule.targetTier,
      targetPeriod: rule.targetPeriod,
      discountType: rule.discountType,
      // 金额类规则在库里存的是「分」，表单里让运营填「元」
      discountValue:
        rule.discountType === 'amount' ? centsToYuan(rule.discountValue) : String(rule.discountValue),
      stackable: rule.stackable,
      priority: String(rule.priority),
      enabled: rule.enabled,
      note: rule.note,
    })
    setFormError(null)
    setEditing(rule)
  }

  const closeForm = () => {
    setCreating(false)
    setEditing(null)
    setFormError(null)
  }

  const submit = async () => {
    if (!form.name.trim()) return setFormError('请填写规则名称')
    const value =
      form.discountType === 'amount' ? yuanToCents(form.discountValue) : Number(form.discountValue)
    if (!Number.isFinite(value) || value <= 0) return setFormError('优惠数值必须大于 0')
    if (form.discountType === 'percent' && value > 100) return setFormError('百分比不能超过 100')

    setSaving(true)
    setFormError(null)
    try {
      const body: Record<string, unknown> = {
        name: form.name.trim(),
        conditionType: form.conditionType,
        conditionMinDevices: form.conditionType === 'device_count' ? Number(form.conditionMinDevices) : null,
        conditionDays: form.conditionType === 'registered_within_days' ? Number(form.conditionDays) : null,
        conditionFromTier: form.conditionType === 'tier_upgrade' ? form.conditionFromTier : null,
        targetTier: form.targetTier,
        targetPeriod: form.targetPeriod,
        discountType: form.discountType,
        discountValue: value,
        stackable: form.stackable,
        priority: Number(form.priority) || 0,
        enabled: form.enabled,
        note: form.note.trim(),
      }
      if (editing) {
        await api.membership.rules.update(editing.id, body)
      } else {
        await api.membership.rules.create(body)
      }
      closeForm()
      load()
    } catch (err: unknown) {
      setFormError(errorMessageOf(err, '保存失败'))
    } finally {
      setSaving(false)
    }
  }

  const confirmRemove = async () => {
    if (!removing) return
    setSaving(true)
    try {
      await api.membership.rules.remove(removing.id)
      setRemoving(null)
      load()
    } catch (err: unknown) {
      setFormError(errorMessageOf(err, '删除失败'))
      setRemoving(null)
    } finally {
      setSaving(false)
    }
  }

  const need = conditionNeeds(form.conditionType)
  const incomplete = data?.incompleteCount ?? 0

  return (
    <div>
      <PageHeader
        title="定价规则"
        description="家长端的实付价 = 套餐基准价 − 命中的规则。折扣按原价算再相加（不折上折）；「不可叠加」的规则同单只取优先级最高的一条；实付最低 1 元。"
        actions={
          <>
            <Button variant="outline" size="sm" onClick={() => setSimulating(true)}>
              <Calculator className="h-3.5 w-3.5" />
              试算
            </Button>
            <Button variant="outline" size="sm" onClick={load} disabled={loading}>
              {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
              刷新
            </Button>
            <Button size="sm" onClick={openCreate}>
              <Plus className="h-3.5 w-3.5" />
              新建规则
            </Button>
          </>
        }
      />

      {incomplete > 0 ? (
        <Card className="mb-3 border-amber-200">
          <CardContent className="flex items-center gap-2 p-3 text-xs text-amber-700">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            有 {incomplete} 条启用中的规则缺少条件参数（如「设备数达标」没填阈值），它们在计价时永远不会命中，请补齐。
          </CardContent>
        </Card>
      ) : null}

      <Card className="mb-3">
        <CardContent className="flex flex-wrap items-center gap-2 p-3">
          <Select
            value={filters.conditionType}
            onChange={(e) => setFilter('conditionType', e.target.value)}
            className="w-52"
          >
            <option value="">全部条件</option>
            {CONDITION_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
          <Select value={filters.enabled} onChange={(e) => setFilter('enabled', e.target.value)} className="w-32">
            <option value="">全部状态</option>
            <option value="true">启用中</option>
            <option value="false">已停用</option>
          </Select>
        </CardContent>
      </Card>

      <Card className="overflow-hidden">
        <DataState
          loading={loading && !data}
          error={error}
          empty={(data?.items.length ?? 0) === 0}
          emptyText="还没有定价规则，点右上角「新建规则」添加"
          onRetry={load}
        >
          <div className="admin-table-scroll">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>规则</TableHead>
                  <TableHead className="w-44">触发条件</TableHead>
                  <TableHead className="w-28">优惠</TableHead>
                  <TableHead className="w-32">适用范围</TableHead>
                  <TableHead className="w-24">叠加</TableHead>
                  <TableHead className="w-20 text-right">优先级</TableHead>
                  <TableHead className="w-24">状态</TableHead>
                  <TableHead className="w-24 text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data?.items.map((rule) => (
                  <TableRow key={rule.id}>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-foreground">{rule.name}</span>
                        {rule.complete === false ? <ToneBadge tone="amber">参数不全</ToneBadge> : null}
                      </div>
                      {rule.note ? <div className="text-xs text-muted-foreground">{rule.note}</div> : null}
                    </TableCell>
                    <TableCell>
                      <div className="text-sm text-foreground">{rule.conditionLabel}</div>
                      {rule.conditionSummary !== rule.conditionLabel ? (
                        <div className="text-xs text-muted-foreground">{rule.conditionSummary}</div>
                      ) : null}
                    </TableCell>
                    <TableCell>
                      <span className="font-mono text-sm text-foreground">{rule.discountSummary}</span>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {rule.targetTier === 'all' ? '不限档位' : rule.targetTier === 'member' ? '会员套餐' : '超级套餐'}
                      <br />
                      {rule.targetPeriod === 'all'
                        ? '不限周期'
                        : rule.targetPeriod === 'monthly'
                          ? '按月'
                          : rule.targetPeriod === 'yearly'
                            ? '按年'
                            : '连续包月'}
                    </TableCell>
                    <TableCell>
                      <ToneBadge tone={rule.stackable ? 'green' : 'gray'}>
                        {rule.stackable ? '可叠加' : '独占'}
                      </ToneBadge>
                    </TableCell>
                    <TableCell className="text-right font-mono text-sm text-foreground">{rule.priority}</TableCell>
                    <TableCell>
                      <ToneBadge tone={rule.enabled ? 'green' : 'gray'}>{rule.enabled ? '启用' : '停用'}</ToneBadge>
                    </TableCell>
                    <TableCell className="text-right">
                      <Button variant="ghost" size="sm" onClick={() => openEdit(rule)}>
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => setRemoving(rule)}>
                        <Trash2 className="h-3.5 w-3.5 text-destructive" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          {data ? (
            <Pagination
              page={data.page}
              pageSize={pageSize}
              total={data.total}
              totalPages={data.totalPages}
              onPageChange={setPage}
              onPageSizeChange={changePageSize}
            />
          ) : null}
        </DataState>
      </Card>

      {/* 新建 / 编辑 */}
      <Dialog open={creating || Boolean(editing)} onOpenChange={(open) => (!open ? closeForm() : null)}>
        <DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editing ? `编辑「${editing.name}」` : '新建定价规则'}</DialogTitle>
            <DialogDescription>
              条件决定「什么人能享受」，折扣决定「便宜多少」。金额类折扣按原价计算，不做折上折。
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <label className="block space-y-1">
              <span className="text-xs text-muted-foreground">规则名称</span>
              <Input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="如「多设备家庭 9 折」"
              />
            </label>

            <div className="grid grid-cols-2 gap-3">
              <label className="space-y-1">
                <span className="text-xs text-muted-foreground">触发条件</span>
                <Select
                  value={form.conditionType}
                  onChange={(e) => setForm({ ...form, conditionType: e.target.value })}
                >
                  {CONDITION_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </Select>
              </label>

              {need === 'devices' ? (
                <label className="space-y-1">
                  <span className="text-xs text-muted-foreground">绑定设备数 ≥</span>
                  <Input
                    value={form.conditionMinDevices}
                    onChange={(e) => setForm({ ...form, conditionMinDevices: e.target.value })}
                    inputMode="numeric"
                  />
                </label>
              ) : null}

              {need === 'days' ? (
                <label className="space-y-1">
                  <span className="text-xs text-muted-foreground">注册天数 ≤</span>
                  <Input
                    value={form.conditionDays}
                    onChange={(e) => setForm({ ...form, conditionDays: e.target.value })}
                    inputMode="numeric"
                  />
                </label>
              ) : null}

              {need === 'tier' ? (
                <label className="space-y-1">
                  <span className="text-xs text-muted-foreground">当前档位</span>
                  <Select
                    value={form.conditionFromTier}
                    onChange={(e) => setForm({ ...form, conditionFromTier: e.target.value })}
                  >
                    <option value="ordinary">普通账号</option>
                    <option value="member">会员</option>
                  </Select>
                </label>
              ) : null}
            </div>

            <div className="grid grid-cols-2 gap-3">
              <label className="space-y-1">
                <span className="text-xs text-muted-foreground">折扣方式</span>
                <Select
                  value={form.discountType}
                  onChange={(e) => setForm({ ...form, discountType: e.target.value })}
                >
                  {DISCOUNT_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </Select>
              </label>
              <label className="space-y-1">
                <span className="text-xs text-muted-foreground">
                  {form.discountType === 'percent' ? '减多少（%）' : '减多少（元）'}
                </span>
                <Input
                  value={form.discountValue}
                  onChange={(e) => setForm({ ...form, discountValue: e.target.value })}
                  inputMode="decimal"
                />
              </label>
            </div>

            <div className="grid grid-cols-3 gap-3">
              <label className="space-y-1">
                <span className="text-xs text-muted-foreground">适用档位</span>
                <Select value={form.targetTier} onChange={(e) => setForm({ ...form, targetTier: e.target.value })}>
                  {TARGET_TIER_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </Select>
              </label>
              <label className="space-y-1">
                <span className="text-xs text-muted-foreground">适用周期</span>
                <Select value={form.targetPeriod} onChange={(e) => setForm({ ...form, targetPeriod: e.target.value })}>
                  {TARGET_PERIOD_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </Select>
              </label>
              <label className="space-y-1">
                <span className="text-xs text-muted-foreground">优先级</span>
                <Input
                  value={form.priority}
                  onChange={(e) => setForm({ ...form, priority: e.target.value })}
                  inputMode="numeric"
                />
              </label>
            </div>

            <div className="flex items-center gap-4 text-sm">
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={form.stackable}
                  onChange={(e) => setForm({ ...form, stackable: e.target.checked })}
                />
                可与其他规则叠加
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={form.enabled}
                  onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
                />
                启用
              </label>
            </div>

            <label className="block space-y-1">
              <span className="text-xs text-muted-foreground">备注（家长端会显示为优惠说明）</span>
              <Textarea
                value={form.note}
                onChange={(e) => setForm({ ...form, note: e.target.value })}
                rows={2}
                placeholder="如「已绑定 2 台以上设备，9 折」"
              />
            </label>

            {formError ? <p className="text-xs text-destructive">{formError}</p> : null}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={closeForm} disabled={saving}>
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
        open={Boolean(removing)}
        onOpenChange={(open) => (!open ? setRemoving(null) : null)}
        title="删除定价规则"
        description={
          removing
            ? `确定删除「${removing.name}」？历史订单里存的是规则快照，删除不会影响已成交的订单。`
            : ''
        }
        confirmText="删除"
        loading={saving}
        onConfirm={confirmRemove}
      />

      <SimulateDialog open={simulating} onOpenChange={setSimulating} />
    </div>
  )
}

/**
 * 试算弹窗。
 *
 * 改规则之前先看效果：传家长账号 id 就用真实画像（是否首单、已绑几台、注册多久），
 * 也可以直接编一个画像，不必为了试规则去造账号。
 */
function SimulateDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { data: plans } = useAsyncData(() => api.membership.plans.list({ pageSize: 100 }), {
    deps: [],
    enabled: open,
  })

  const [planCode, setPlanCode] = useState('')
  const [mode, setMode] = useState<'account' | 'profile'>('profile')
  const [userId, setUserId] = useState('')
  const [profile, setProfile] = useState({ hasPaid: false, activeTier: 'ordinary', deviceCount: '2', days: '30' })
  const [result, setResult] = useState<{
    source: string
    result: { originalCents: number; finalCents: number; discountCents: number; monthlyEquivalentCents: number; adjustments: MembershipAdjustment[] }
    missed: MembershipAdjustment[]
  } | null>(null)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const options = plans?.items ?? []
  const effectiveCode = planCode || options[0]?.code || ''

  const run = async () => {
    if (!effectiveCode) return setErr('请先选择一个套餐')
    setLoading(true)
    setErr(null)
    try {
      const res = await api.membership.simulate(
        mode === 'account'
          ? { planCode: effectiveCode, userId: Number(userId) }
          : {
              planCode: effectiveCode,
              hasPaid: profile.hasPaid,
              activeTier: profile.activeTier,
              deviceCount: Number(profile.deviceCount) || 0,
              registeredDaysAgo: Number(profile.days) || 0,
            },
      )
      setResult({ source: res.source, result: res.result, missed: res.missed })
    } catch (error: unknown) {
      setErr(errorMessageOf(error, '试算失败'))
      setResult(null)
    } finally {
      setLoading(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>价格试算</DialogTitle>
          <DialogDescription>
            用当前启用中的规则算一遍实付价。可以指定一个家长账号用它的真实画像，也可以直接编一套画像。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <label className="block space-y-1">
            <span className="text-xs text-muted-foreground">套餐</span>
            <Select value={effectiveCode} onChange={(e) => setPlanCode(e.target.value)}>
              {options.map((p) => (
                <option key={p.code} value={p.code}>
                  {p.name}（原价 {formatCents(p.basePriceCents)}）
                </option>
              ))}
            </Select>
          </label>

          <div className="flex gap-2">
            <Button
              variant={mode === 'profile' ? 'default' : 'outline'}
              size="sm"
              onClick={() => setMode('profile')}
            >
              自定义画像
            </Button>
            <Button
              variant={mode === 'account' ? 'default' : 'outline'}
              size="sm"
              onClick={() => setMode('account')}
            >
              指定账号
            </Button>
          </div>

          {mode === 'account' ? (
            <label className="block space-y-1">
              <span className="text-xs text-muted-foreground">家长账号 id</span>
              <Input value={userId} onChange={(e) => setUserId(e.target.value)} inputMode="numeric" placeholder="如 3" />
            </label>
          ) : (
            <div className="grid grid-cols-2 gap-3">
              <label className="space-y-1">
                <span className="text-xs text-muted-foreground">当前档位</span>
                <Select
                  value={profile.activeTier}
                  onChange={(e) => setProfile({ ...profile, activeTier: e.target.value })}
                >
                  <option value="ordinary">普通账号</option>
                  <option value="member">会员</option>
                  <option value="super">超级会员</option>
                </Select>
              </label>
              <label className="space-y-1">
                <span className="text-xs text-muted-foreground">绑定设备数</span>
                <Input
                  value={profile.deviceCount}
                  onChange={(e) => setProfile({ ...profile, deviceCount: e.target.value })}
                  inputMode="numeric"
                />
              </label>
              <label className="space-y-1">
                <span className="text-xs text-muted-foreground">注册天数前</span>
                <Input
                  value={profile.days}
                  onChange={(e) => setProfile({ ...profile, days: e.target.value })}
                  inputMode="numeric"
                />
              </label>
              <label className="flex items-end gap-2 pb-2 text-sm">
                <input
                  type="checkbox"
                  checked={profile.hasPaid}
                  onChange={(e) => setProfile({ ...profile, hasPaid: e.target.checked })}
                />
                曾经付费成功过
              </label>
            </div>
          )}

          <Button onClick={run} disabled={loading} className="w-full">
            {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Calculator className="h-3.5 w-3.5" />}
            算一下
          </Button>

          {err ? <p className="text-xs text-destructive">{err}</p> : null}

          {result ? (
            <div className="space-y-2 rounded-lg bg-muted p-3">
              <div className="flex items-baseline justify-between">
                <span className="text-xs text-muted-foreground">{result.source} 实付</span>
                <span className="font-mono text-xl font-semibold text-primary">
                  {formatCents(result.result.finalCents)}
                </span>
              </div>
              <div className="flex justify-between text-xs text-muted-foreground">
                <span>原价 {formatCents(result.result.originalCents)}</span>
                <span>
                  共减 {formatCents(result.result.discountCents)} · 折合每月{' '}
                  {formatCents(result.result.monthlyEquivalentCents)}
                </span>
              </div>
              <div className="space-y-1 border-t pt-2">
                {result.result.adjustments.length === 0 ? (
                  <p className="text-xs text-muted-foreground">没有命中任何优惠</p>
                ) : (
                  result.result.adjustments.map((a, i) => (
                    <div key={`${a.ruleId}-${i}`} className="flex justify-between text-xs">
                      <span className="text-foreground">{a.name}</span>
                      <span className="font-mono text-primary">−{formatCents(a.amountCents)}</span>
                    </div>
                  ))
                )}
              </div>
              {result.missed.length > 0 ? (
                <div className="space-y-1 border-t pt-2">
                  <p className="text-xs text-amber-700">命中但被「不可叠加」挤掉：</p>
                  {result.missed.map((a, i) => (
                    <div key={`${a.ruleId}-m-${i}`} className="flex justify-between text-xs text-muted-foreground">
                      <span>{a.name}</span>
                      <span className="font-mono">−{formatCents(a.amountCents)}</span>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            关闭
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
