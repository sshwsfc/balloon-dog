import { useState } from 'react'
import { Calculator, Loader2, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input, Select, Textarea } from '@/components/ui/input'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
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
  type MembershipReferralRuleRow,
  type MembershipSimulateReferral,
} from '../../api'
import { useAsyncData, useFilters } from '../../hooks/useAsyncData'
import { DataState, PageHeader, Pagination, ToneBadge } from '../../components/ui-kit'
import { ConfirmDialog } from '../../components/ConfirmDialog'
import {
  TARGET_PERIOD_OPTIONS,
  TARGET_TIER_OPTIONS,
  centsToYuan,
  formatCents,
  yuanToCents,
} from './shared'

/** 专享价的三种折扣方式（比常规定价规则多一个「一口价」）。 */
const REFERRAL_DISCOUNT_OPTIONS = [
  { value: 'percent', label: '按比例上浮（%）' },
  { value: 'amount', label: '加收固定金额（元）' },
  { value: 'fixed', label: '一口价（元）' },
]

interface ReferralForm {
  name: string
  targetTier: string
  targetPeriod: string
  priceType: string
  priceValue: string
  firstPurchaseOnly: boolean
  requireActiveReferral: boolean
  priority: string
  enabled: boolean
  note: string
}

const EMPTY_FORM: ReferralForm = {
  name: '',
  targetTier: 'all',
  targetPeriod: 'all',
  priceType: 'percent',
  priceValue: '50',
  firstPurchaseOnly: true,
  requireActiveReferral: true,
  priority: '50',
  enabled: true,
  note: '',
}

/** 数值输入框的标签与说明随上浮方式变化：金额类让运营填「元」，提交前换算成分。 */
function priceValueMeta(type: string): { label: string; hint: string } {
  if (type === 'percent') {
    return { label: '上浮比例（%）', hint: '在常规定价算完的实付价基础上再上浮这个百分比，例如 50 表示贵一半' }
  }
  if (type === 'fixed') {
    return { label: '一口价（元）', hint: '无论常规价算出来多少，受邀用户都按这个价；低于常规价时这条规则不生效' }
  }
  return { label: '加收金额（元）', hint: '在常规定价算完的实付价基础上直接加这个金额' }
}

/**
 * 受邀用户定价规则管理。
 *
 * 被邀请注册的家长价格**更高**：邀请人要拿的分享返现是平台出的，这笔成本落在他的订单上。
 * 所以这个价格不进常规定价的加法，而是在常规定价算完的**实付价之上**再抬一档：
 * 每条命中的规则各算一个价，与常规定价一起取最高价。
 * 页面顶部把这条口径写出来，否则运营会以为它和「定价规则」一样是叠加的减法。
 */
export function ReferralPriceTab() {
  const { filters, setFilter, page, setPage, pageSize, changePageSize } = useFilters({
    enabled: '',
    priceType: '',
  })

  const { data, loading, error, reload: load } = useAsyncData(
    () =>
      api.membership.referralRules.list({
        enabled: filters.enabled || undefined,
        priceType: filters.priceType || undefined,
        page,
        pageSize,
      }),
    { deps: [filters.enabled, filters.priceType, page, pageSize] },
  )

  const [editing, setEditing] = useState<MembershipReferralRuleRow | null>(null)
  const [creating, setCreating] = useState(false)
  const [form, setForm] = useState<ReferralForm>(EMPTY_FORM)
  const [saving, setSaving] = useState(false)
  const [removing, setRemoving] = useState<MembershipReferralRuleRow | null>(null)

  const openCreate = () => {
    setForm(EMPTY_FORM)
    setCreating(true)
  }

  const openEdit = (rule: MembershipReferralRuleRow) => {
    setForm({
      name: rule.name,
      targetTier: rule.targetTier,
      targetPeriod: rule.targetPeriod,
      priceType: rule.priceType,
      // 金额类规则在库里存的是「分」，表单里让运营填「元」；percent 本身就是百分比整数
      priceValue:
        rule.priceType === 'percent' ? String(rule.priceValue) : centsToYuan(rule.priceValue),
      firstPurchaseOnly: rule.firstPurchaseOnly,
      requireActiveReferral: rule.requireActiveReferral,
      priority: String(rule.priority),
      enabled: rule.enabled,
      note: rule.note,
    })
    setEditing(rule)
  }

  const closeForm = () => {
    setCreating(false)
    setEditing(null)
  }

  const submit = async () => {
    if (!form.name.trim()) {
      toast.error('请填写规则名称')
      return
    }

    // 与服务端 DTO 同口径的本地校验：不合法就不发请求
    let value: number
    if (form.priceType === 'percent') {
      value = Number(form.priceValue)
      if (!Number.isInteger(value) || value < 1 || value > 200) {
        toast.error('按比例上浮时，比例要在 1~200 之间的整数')
        return
      }
    } else {
      value = yuanToCents(form.priceValue)
      if (form.priceType === 'fixed' && value < 100) {
        toast.error('一口价不能低于 1 元')
        return
      }
      if (form.priceType === 'amount' && value <= 0) {
        toast.error('加收金额必须大于 0 元')
        return
      }
    }

    const priority = Number(form.priority)
    if (!Number.isInteger(priority) || priority < 0 || priority > 9999) {
      toast.error('优先级要是 0~9999 之间的整数')
      return
    }

    setSaving(true)
    try {
      const body: Record<string, unknown> = {
        name: form.name.trim(),
        targetTier: form.targetTier,
        targetPeriod: form.targetPeriod,
        priceType: form.priceType,
        priceValue: value,
        firstPurchaseOnly: form.firstPurchaseOnly,
        requireActiveReferral: form.requireActiveReferral,
        priority,
        enabled: form.enabled,
        note: form.note.trim(),
      }
      if (editing) {
        await api.membership.referralRules.update(editing.id, body)
      } else {
        await api.membership.referralRules.create(body)
      }
      toast.success(editing ? '受邀定价规则已更新' : '受邀定价规则已创建')
      closeForm()
      load()
    } catch (err: unknown) {
      const message = errorMessageOf(err, '保存失败')
      toast.error(message)
      console.error('保存受邀定价规则失败：', err)
    } finally {
      setSaving(false)
    }
  }

  const confirmRemove = async () => {
    if (!removing) return
    setSaving(true)
    try {
      await api.membership.referralRules.remove(removing.id)
      toast.success('受邀定价规则已删除')
      setRemoving(null)
      load()
    } catch (err: unknown) {
      const message = errorMessageOf(err, '删除失败')
      toast.error(message)
      console.error('删除受邀定价规则失败：', err)
      setRemoving(null)
    } finally {
      setSaving(false)
    }
  }

  const meta = priceValueMeta(form.priceType)

  return (
    <div>
      <PageHeader
        title="受邀用户定价"
        description="被邀请注册的家长要承担邀请人的分享返现成本，所以在常规定价之上再抬一档。"
        actions={
          <>
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

      {/* 算法口径：不写清楚，运营会把它和「定价规则」当成同一种叠加关系 */}
      <Card className="mb-3 border-dashed">
        <CardContent className="space-y-1 p-3 text-xs text-muted-foreground">
          <p>
            结账价 = <span className="font-medium text-foreground">max(常规定价, 受邀价)</span>
            。常规定价先按<span className="font-medium text-foreground">定价规则</span>
            算完，再看本表命中的每条规则各算出什么价，
            <span className="font-medium text-foreground">取其中最高的一个</span>
            。基数是
            <span className="font-medium text-foreground">常规定价算完的实付价</span>
            ，不是原价。
          </p>
          <p>
            取 max 有业务和安全两层原因：被邀请家长的这单要覆盖邀请人的分享返现（首充最高
            50%），平台不能倒贴；同时规则配错（比例填 0、一口价填得比常规价低）只会
            <span className="font-medium text-foreground">不生效</span>
            ，不会出现「被邀请反而更便宜」的套利口子。优先级只在同价时决定展示哪一条。
          </p>
          <p>
            上浮多少才不亏：返现是按<span className="font-medium text-foreground">实付价</span>
            算的，所以「上浮 <span className="font-mono">s</span>、返现率{' '}
            <span className="font-mono">r</span>」要满足{' '}
            <span className="font-mono">(1 + s) × (1 − r) ≥ 1</span>，即{' '}
            <span className="font-mono">s ≥ r ÷ (1 − r)</span> —— 返现 50% 要上浮 100%、40%
            要 67%、20% 只要 25%。默认的「首单上浮 100%」就是按<span className="font-medium text-foreground">最坏的 50% 档</span>
            兜底，正好打平（年卡还有单笔 75 元封顶，所以实际是赚的）；「续费上浮 25%」只对齐
            「≥10 人 20%」那一档 ——
            <span className="font-medium text-foreground">
              邀请人还在 50%/40% 档时，这单续费平台是倒贴的
            </span>
            ，要彻底不亏得把续费那条调到 67%/100%，或下调活动配置里的「续费返现比例」。
          </p>
        </CardContent>
      </Card>

      <SimulateBlock />

      <Card className="mb-3">
        <CardContent className="flex flex-wrap items-center gap-2 p-3">
          <Select value={filters.enabled} onChange={(e) => setFilter('enabled', e.target.value)} className="w-32">
            <option value="">全部状态</option>
            <option value="true">启用中</option>
            <option value="false">已停用</option>
          </Select>
          <Select
            value={filters.priceType}
            onChange={(e) => setFilter('priceType', e.target.value)}
            className="w-52"
          >
            <option value="">全部上浮方式</option>
            {REFERRAL_DISCOUNT_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        </CardContent>
      </Card>

      <Card className="overflow-hidden">
        <DataState
          loading={loading && !data}
          error={error}
          empty={(data?.items.length ?? 0) === 0}
          emptyText="还没有受邀定价规则，点右上角「新建规则」添加"
          onRetry={load}
        >
          <div className="admin-table-scroll">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>规则</TableHead>
                  <TableHead className="w-32">作用范围</TableHead>
                  <TableHead className="w-64">加价</TableHead>
                  <TableHead className="w-48">生效范围</TableHead>
                  <TableHead className="w-20 text-right">优先级</TableHead>
                  <TableHead className="w-24">状态</TableHead>
                  <TableHead className="w-24 text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data?.items.map((rule) => (
                  <TableRow key={rule.id}>
                    <TableCell>
                      <div className="text-sm font-medium text-foreground">{rule.name}</div>
                      {rule.note ? <div className="text-xs text-muted-foreground">{rule.note}</div> : null}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {rule.targetTierLabel}
                      <br />
                      {rule.targetPeriodLabel}
                    </TableCell>
                    <TableCell>
                      <div className="font-mono text-sm text-foreground">{rule.priceTypeLabel}</div>
                      <div className="font-mono text-xs text-primary">{rule.impact}</div>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">{rule.scopeSummary}</TableCell>
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
            <DialogTitle>{editing ? `编辑「${editing.name}」` : '新建受邀定价规则'}</DialogTitle>
            <DialogDescription>
              命中后在常规定价算完的实付价之上算出受邀价，与常规定价取更高的那个；多条命中时取最高价。
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <label className="block space-y-1">
              <span className="text-xs text-muted-foreground">规则名称</span>
              <Input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="如「受邀家长首单一口价 199 元」"
              />
            </label>

            <div className="grid grid-cols-2 gap-3">
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
            </div>

            <div className="grid grid-cols-2 gap-3">
              <label className="space-y-1">
                <span className="text-xs text-muted-foreground">上浮方式</span>
                <Select
                  value={form.priceType}
                  onChange={(e) => setForm({ ...form, priceType: e.target.value })}
                >
                  {REFERRAL_DISCOUNT_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </Select>
              </label>
              <label className="space-y-1">
                <span className="text-xs text-muted-foreground">{meta.label}</span>
                <Input
                  value={form.priceValue}
                  onChange={(e) => setForm({ ...form, priceValue: e.target.value })}
                  inputMode="decimal"
                />
              </label>
            </div>
            <p className="text-xs text-muted-foreground">{meta.hint}</p>

            <div className="space-y-2 text-sm">
              <label className="flex items-start gap-2">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={form.firstPurchaseOnly}
                  onChange={(e) => setForm({ ...form, firstPurchaseOnly: e.target.checked })}
                />
                <span>
                  只对首次付费生效
                  <span className="block text-xs text-muted-foreground">关掉后续费也上浮</span>
                </span>
              </label>
              <label className="flex items-start gap-2">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={form.requireActiveReferral}
                  onChange={(e) => setForm({ ...form, requireActiveReferral: e.target.checked })}
                />
                <span>
                  邀请关系必须有效
                  <span className="block text-xs text-muted-foreground">关掉后邀请关系已作废的账号也上浮</span>
                </span>
              </label>
            </div>

            <div className="grid grid-cols-3 gap-3">
              <label className="space-y-1">
                <span className="text-xs text-muted-foreground">优先级（同价时优先展示）</span>
                <Input
                  value={form.priority}
                  onChange={(e) => setForm({ ...form, priority: e.target.value })}
                  inputMode="numeric"
                />
              </label>
              <label className="flex items-end gap-2 pb-2 text-sm">
                <input
                  type="checkbox"
                  checked={form.enabled}
                  onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
                />
                启用
              </label>
            </div>

            <label className="block space-y-1">
              <span className="text-xs text-muted-foreground">备注（家长端会显示为价格说明）</span>
              <Textarea
                value={form.note}
                onChange={(e) => setForm({ ...form, note: e.target.value })}
                rows={2}
                placeholder="如「受邀注册家长首单上浮 50%」"
              />
            </label>
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
        title="删除受邀定价规则"
        description={
          removing
            ? `确定删除「${removing.name}」？历史订单里存的是规则快照，删除不会影响已成交的订单。`
            : ''
        }
        confirmText="删除"
        loading={saving}
        onConfirm={confirmRemove}
      />
    </div>
  )
}

/**
 * 试算区块。
 *
 * 只走「自定义画像」：不传 userId，直接编一套「是否受邀注册 / 是否首单 / 关系是否有效」，
 * 看受邀定价到底有没有生效、贵了多少 —— 不必为了试规则先去造一个受邀账号。
 */
function SimulateBlock() {
  const { data: plans } = useAsyncData(() => api.membership.plans.list({ pageSize: 100 }), { deps: [] })

  const [planCode, setPlanCode] = useState('')
  const [invited, setInvited] = useState(true)
  const [hasPaid, setHasPaid] = useState(false)
  const [referralActive, setReferralActive] = useState(true)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [result, setResult] = useState<{
    result: {
      originalCents: number
      finalCents: number
      discountCents: number
      adjustments: MembershipAdjustment[]
    }
    referral: MembershipSimulateReferral
  } | null>(null)

  const options = plans?.items ?? []
  const effectiveCode = planCode || options[0]?.code || ''

  const run = async () => {
    if (!effectiveCode) return setErr('请先选择一个套餐')
    setLoading(true)
    setErr(null)
    try {
      const res = await api.membership.simulate({
        planCode: effectiveCode,
        hasPaid,
        invited,
        referralActive,
      })
      setResult({ result: res.result, referral: res.referral })
    } catch (error: unknown) {
      setErr(errorMessageOf(error, '试算失败'))
      setResult(null)
    } finally {
      setLoading(false)
    }
  }

  return (
    <Card className="mb-3">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-1.5 text-sm font-medium">
          <Calculator className="h-4 w-4" />
          价格试算
        </CardTitle>
        <CardDescription>
          自定义画像试算：编一套「是否受邀注册 / 是否首单 / 邀请关系是否有效」，看受邀定价有没有生效。
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <label className="space-y-1">
            <span className="text-xs text-muted-foreground">套餐</span>
            <Select value={effectiveCode} onChange={(e) => setPlanCode(e.target.value)}>
              {options.length === 0 ? <option value="">暂无可选套餐</option> : null}
              {options.map((p) => (
                <option key={p.code} value={p.code}>
                  {p.name}（原价 {formatCents(p.basePriceCents)}）
                </option>
              ))}
            </Select>
          </label>

          <div className="space-y-1">
            <span className="text-xs text-muted-foreground">注册来源</span>
            <div className="flex gap-2">
              <Button variant={invited ? 'default' : 'outline'} size="sm" onClick={() => setInvited(true)}>
                受邀注册
              </Button>
              <Button variant={!invited ? 'default' : 'outline'} size="sm" onClick={() => setInvited(false)}>
                未受邀
              </Button>
            </div>
          </div>

          <div className="space-y-1">
            <span className="text-xs text-muted-foreground">付费状态</span>
            <div className="flex gap-2">
              <Button variant={!hasPaid ? 'default' : 'outline'} size="sm" onClick={() => setHasPaid(false)}>
                首单
              </Button>
              <Button variant={hasPaid ? 'default' : 'outline'} size="sm" onClick={() => setHasPaid(true)}>
                已付费
              </Button>
            </div>
          </div>

          <div className="space-y-1">
            <span className="text-xs text-muted-foreground">邀请关系</span>
            <div className="flex gap-2">
              <Button
                variant={referralActive ? 'default' : 'outline'}
                size="sm"
                onClick={() => setReferralActive(true)}
              >
                有效
              </Button>
              <Button
                variant={!referralActive ? 'default' : 'outline'}
                size="sm"
                onClick={() => setReferralActive(false)}
              >
                已作废
              </Button>
            </div>
          </div>
        </div>

        <Button size="sm" onClick={run} disabled={loading}>
          {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Calculator className="h-3.5 w-3.5" />}
          试算
        </Button>

        {err ? <p className="text-xs text-destructive">{err}</p> : null}

        {result ? (
          <div className="space-y-2 rounded-lg bg-muted p-3">
            <div className="flex items-baseline justify-between">
              <span className="text-xs text-muted-foreground">最终实付</span>
              <span className="font-mono text-xl font-semibold text-primary">
                {formatCents(result.result.finalCents)}
              </span>
            </div>
            <div className="flex flex-wrap justify-between gap-x-4 text-xs text-muted-foreground">
              <span>套餐原价 {formatCents(result.result.originalCents)}</span>
              <span>常规优惠后 {formatCents(result.referral.baseCents)}</span>
              {result.referral.applied ? (
                <span className="text-amber-700">
                  受邀上浮 +{formatCents(result.referral.surchargeCents)}
                </span>
              ) : null}
            </div>

            <div className="space-y-1 border-t pt-2">
              {result.result.adjustments.length === 0 ? (
                <p className="text-xs text-muted-foreground">没有命中任何优惠</p>
              ) : (
                result.result.adjustments.map((a, i) => (
                  <div key={`${a.ruleId}-${i}`} className="flex justify-between gap-4 text-xs">
                    <span className="text-foreground">{a.name}</span>
                    <span className="shrink-0 font-mono text-primary">−{formatCents(a.amountCents)}</span>
                  </div>
                ))
              )}
            </div>

            <div className="space-y-1 border-t pt-2 text-xs">
              <p className={result.referral.applied ? 'font-medium text-amber-700' : 'font-medium text-muted-foreground'}>
                {result.referral.applied
                  ? `受邀定价已生效，比常规定价多收 ${formatCents(result.referral.surchargeCents)}`
                  : '受邀定价未生效（按常规定价结算）'}
              </p>
              <p className="text-muted-foreground">服务端判定：{result.referral.reason}</p>
              {result.referral.ruleName ? (
                <p className="text-muted-foreground">
                  取到的规则：{result.referral.ruleName}
                  {result.referral.candidateCents !== null
                    ? `（受邀价 ${formatCents(result.referral.candidateCents)}`
                    : ''}
                  {result.referral.matchedCount > 1
                    ? `，共命中 ${result.referral.matchedCount} 条，取最高的一条）`
                    : result.referral.candidateCents !== null
                      ? '）'
                      : ''}
                </p>
              ) : null}
            </div>
          </div>
        ) : null}
      </CardContent>
    </Card>
  )
}
