import { useState } from 'react'
import { Loader2, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react'
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
import { api, errorMessageOf, formatDateTime, type MembershipPlanRow } from '../../api'
import { useAsyncData, useFilters } from '../../hooks/useAsyncData'
import { DataState, PageHeader, Pagination, ToneBadge } from '../../components/ui-kit'
import { ConfirmDialog } from '../../components/ConfirmDialog'
import {
  PERIOD_OPTIONS,
  TIER_OPTIONS,
  TIER_TONE,
  centsToYuan,
  formatCents,
  monthlyEquivalent,
  yuanToCents,
} from './shared'

interface PlanForm {
  code: string
  tier: string
  period: string
  name: string
  description: string
  priceYuan: string
  months: string
  recommended: boolean
  sortOrder: string
  enabled: boolean
}

const EMPTY_FORM: PlanForm = {
  code: '',
  tier: 'member',
  period: 'monthly',
  name: '',
  description: '',
  priceYuan: '15.00',
  months: '1',
  recommended: false,
  sortOrder: '0',
  enabled: true,
}

/**
 * 套餐管理。
 *
 * 套餐是「基准价 + 档位 + 周期」的三元组，实际售价由定价规则算出来 ——
 * 所以这里只让管理员维护基准价，改规则在「定价规则」页，两件事不混在一起。
 */
export function PlansTab() {
  const { filters, setFilter, page, setPage, pageSize, changePageSize } = useFilters({ tier: '' })

  const { data, loading, error, reload: load } = useAsyncData(
    () => api.membership.plans.list({ tier: filters.tier || undefined, page, pageSize }),
    { deps: [filters.tier, page, pageSize] },
  )

  const [editing, setEditing] = useState<MembershipPlanRow | null>(null)
  const [creating, setCreating] = useState(false)
  const [form, setForm] = useState<PlanForm>(EMPTY_FORM)
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [removing, setRemoving] = useState<MembershipPlanRow | null>(null)

  const openCreate = () => {
    setForm(EMPTY_FORM)
    setFormError(null)
    setCreating(true)
  }

  const openEdit = (plan: MembershipPlanRow) => {
    setForm({
      code: plan.code,
      tier: plan.tier,
      period: plan.period,
      name: plan.name,
      description: plan.description,
      priceYuan: centsToYuan(plan.basePriceCents),
      months: String(plan.months),
      recommended: plan.recommended,
      sortOrder: String(plan.sortOrder),
      enabled: plan.enabled,
    })
    setFormError(null)
    setEditing(plan)
  }

  const closeForm = () => {
    setCreating(false)
    setEditing(null)
    setFormError(null)
  }

  const submit = async () => {
    const priceCents = yuanToCents(form.priceYuan)
    if (!form.name.trim()) return setFormError('请填写套餐名称')
    if (priceCents <= 0) return setFormError('基准价必须大于 0')

    setSaving(true)
    setFormError(null)
    try {
      const body = {
        name: form.name.trim(),
        description: form.description.trim(),
        basePriceCents: priceCents,
        months: Number(form.months) || 1,
        recommended: form.recommended,
        sortOrder: Number(form.sortOrder) || 0,
        enabled: form.enabled,
      }
      if (editing) {
        await api.membership.plans.update(editing.id, body)
      } else {
        await api.membership.plans.create({
          ...body,
          code: form.code.trim() || undefined,
          tier: form.tier,
          period: form.period,
        })
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
      await api.membership.plans.remove(removing.id)
      setRemoving(null)
      load()
    } catch (err: unknown) {
      setFormError(errorMessageOf(err, '删除失败'))
      setRemoving(null)
    } finally {
      setSaving(false)
    }
  }

  const coverage = data?.coverage ?? []

  return (
    <div>
      <PageHeader
        title="会员套餐"
        description="套餐只定义「基准价 + 档位 + 周期」，家长看到的实付价由定价规则算出来。已有订单的套餐不能删除，只能停用。"
        actions={
          <>
            <Button variant="outline" size="sm" onClick={load} disabled={loading}>
              {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
              刷新
            </Button>
            <Button size="sm" onClick={openCreate}>
              <Plus className="h-3.5 w-3.5" />
              新建套餐
            </Button>
          </>
        }
      />

      {/* 档位 × 周期的覆盖矩阵：一眼看出「超级会员还缺连续包月」这类缺口 */}
      <Card className="mb-3">
        <CardContent className="flex flex-wrap items-center gap-x-6 gap-y-2 p-3 text-xs">
          <span className="text-muted-foreground">上架覆盖：</span>
          {coverage.map((c) => (
            <span key={c.period} className="flex items-center gap-1.5">
              <span className="text-foreground">{c.periodLabel}</span>
              <ToneBadge tone={c.member ? 'blue' : 'gray'}>会员{c.member ? '✓' : '—'}</ToneBadge>
              <ToneBadge tone={c.super ? 'purple' : 'gray'}>超级{c.super ? '✓' : '—'}</ToneBadge>
            </span>
          ))}
          <Select value={filters.tier} onChange={(e) => setFilter('tier', e.target.value)} className="ml-auto w-32">
            <option value="">全部档位</option>
            {TIER_OPTIONS.map((o) => (
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
          emptyText="还没有套餐，点右上角「新建套餐」添加"
          onRetry={load}
        >
          <div className="admin-table-scroll">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>套餐</TableHead>
                  <TableHead className="w-24">编码</TableHead>
                  <TableHead className="w-24">档位</TableHead>
                  <TableHead className="w-24">周期</TableHead>
                  <TableHead className="w-28 text-right">基准价</TableHead>
                  <TableHead className="w-28 text-right">折合每月</TableHead>
                  <TableHead className="w-20 text-right">已售</TableHead>
                  <TableHead className="w-24">状态</TableHead>
                  <TableHead className="w-24 text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data?.items.map((plan) => (
                  <TableRow key={plan.id}>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-foreground">{plan.name}</span>
                        {plan.recommended ? <ToneBadge tone="amber">推荐</ToneBadge> : null}
                      </div>
                      <div className="text-xs text-muted-foreground">{plan.description || '—'}</div>
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">{plan.code}</TableCell>
                    <TableCell>
                      <ToneBadge tone={TIER_TONE[plan.tier] ?? 'gray'}>{plan.tierLabel}</ToneBadge>
                    </TableCell>
                    <TableCell className="text-sm text-foreground">{plan.periodLabel}</TableCell>
                    <TableCell className="whitespace-nowrap text-right font-mono text-sm text-foreground">
                      {formatCents(plan.basePriceCents)}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-right font-mono text-xs text-muted-foreground">
                      {formatCents(monthlyEquivalent(plan.basePriceCents, plan.months))}
                      <span className="ml-1">/{plan.months}月</span>
                    </TableCell>
                    <TableCell className="text-right font-mono text-sm text-foreground">{plan.orderCount}</TableCell>
                    <TableCell>
                      <ToneBadge tone={plan.enabled ? 'green' : 'gray'}>{plan.enabled ? '已上架' : '已停用'}</ToneBadge>
                    </TableCell>
                    <TableCell className="text-right">
                      <Button variant="ghost" size="sm" onClick={() => openEdit(plan)}>
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => setRemoving(plan)}>
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

      <Dialog open={creating || Boolean(editing)} onOpenChange={(open) => (!open ? closeForm() : null)}>
        <DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editing ? `编辑「${editing.name}」` : '新建套餐'}</DialogTitle>
            <DialogDescription>
              基准价是「原价」，家长端会在此基础上按定价规则打折。档位与周期创建后不可改 ——
              已有订单按 planCode 回溯，改了会让历史订单名不副实。
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            {!editing ? (
              <div className="grid grid-cols-2 gap-3">
                <label className="space-y-1">
                  <span className="text-xs text-muted-foreground">档位</span>
                  <Select value={form.tier} onChange={(e) => setForm({ ...form, tier: e.target.value })}>
                    {TIER_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </Select>
                </label>
                <label className="space-y-1">
                  <span className="text-xs text-muted-foreground">计费周期</span>
                  <Select value={form.period} onChange={(e) => setForm({ ...form, period: e.target.value })}>
                    {PERIOD_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </Select>
                </label>
              </div>
            ) : null}

            <label className="block space-y-1">
              <span className="text-xs text-muted-foreground">套餐名称</span>
              <Input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="如「会员 · 按年」"
              />
            </label>

            {!editing ? (
              <label className="block space-y-1">
                <span className="text-xs text-muted-foreground">
                  编码（留空自动生成 <span className="font-mono">档位_周期</span>）
                </span>
                <Input
                  value={form.code}
                  onChange={(e) => setForm({ ...form, code: e.target.value })}
                  placeholder="member_yearly"
                  className="font-mono"
                />
              </label>
            ) : null}

            <label className="block space-y-1">
              <span className="text-xs text-muted-foreground">说明</span>
              <Textarea
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
                placeholder="一句话说明，家长端会显示在套餐下方"
                rows={2}
              />
            </label>

            <div className="grid grid-cols-3 gap-3">
              <label className="space-y-1">
                <span className="text-xs text-muted-foreground">基准价（元）</span>
                <Input
                  value={form.priceYuan}
                  onChange={(e) => setForm({ ...form, priceYuan: e.target.value })}
                  inputMode="decimal"
                />
              </label>
              <label className="space-y-1">
                <span className="text-xs text-muted-foreground">折算月数</span>
                <Input
                  value={form.months}
                  onChange={(e) => setForm({ ...form, months: e.target.value })}
                  inputMode="numeric"
                />
              </label>
              <label className="space-y-1">
                <span className="text-xs text-muted-foreground">排序</span>
                <Input
                  value={form.sortOrder}
                  onChange={(e) => setForm({ ...form, sortOrder: e.target.value })}
                  inputMode="numeric"
                />
              </label>
            </div>

            <div className="flex items-center gap-4 text-sm">
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={form.recommended}
                  onChange={(e) => setForm({ ...form, recommended: e.target.checked })}
                />
                标「推荐」
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={form.enabled}
                  onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
                />
                上架
              </label>
            </div>

            <p className="rounded-lg bg-muted p-2.5 text-xs text-muted-foreground">
              折合每月 {formatCents(monthlyEquivalent(yuanToCents(form.priceYuan), Number(form.months) || 1))}
              ，家长端按此比较哪个周期更划算。
            </p>

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
        title="删除套餐"
        description={
          removing
            ? `确定删除「${removing.name}」？已售 ${removing.orderCount} 笔的套餐无法删除，请改用「停用」。`
            : ''
        }
        confirmText="删除"
        loading={saving}
        onConfirm={confirmRemove}
      />

      <p className="mt-2 text-xs text-muted-foreground">
        最近更新：{data?.items[0] ? formatDateTime(data.items[0].updatedAt) : '—'}
      </p>
    </div>
  )
}
