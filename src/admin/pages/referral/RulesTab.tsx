import { useMemo, useState } from 'react'
import { AlertTriangle, CheckCircle2, Loader2, Plus, RefreshCw, Save, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { api, errorMessageOf, type ReferralRuleset } from '../../api'
import { useAsyncData } from '../../hooks/useAsyncData'
import { DataState, PageHeader, ToneBadge } from '../../components/ui-kit'
import { PERIOD_OPTIONS, centsToYuan, formatCents, quoteTier, validateTiers, yuanToCents } from './shared'

let seq = 0
function nextKey(): string {
  seq += 1
  return `row-${seq}`
}

interface TierDraft {
  key: string
  /** 服务端读到的启用状态，只用于展示：PUT 整表替换会把所有档位重建为启用。 */
  enabled: boolean
  min: string
  /** 留空 = 无上限（开口档）。 */
  max: string
  rate: string
}

interface CouponDraft {
  key: string
  enabled: boolean
  name: string
  inviteeCount: string
  /** 留空 = 只发一次。 */
  repeatEvery: string
  amountYuan: string
  validDays: string
}

function tierDraftsFrom(ruleset: ReferralRuleset): TierDraft[] {
  return ruleset.tiers.map((t) => ({
    key: nextKey(),
    enabled: t.enabled,
    min: String(t.minInvitees),
    max: t.maxInvitees === null ? '' : String(t.maxInvitees),
    rate: String(t.ratePercent),
  }))
}

function couponDraftsFrom(ruleset: ReferralRuleset): CouponDraft[] {
  return ruleset.couponRules.map((c) => ({
    key: nextKey(),
    enabled: c.enabled,
    name: c.name,
    inviteeCount: String(c.inviteeCount),
    repeatEvery: c.repeatEvery === null ? '' : String(c.repeatEvery),
    amountYuan: centsToYuan(c.amountCents),
    validDays: String(c.validDays),
  }))
}

/** 数字输入解析：空串按 0 或 null 处理，非法值原样返回 NaN 交给校验去报错。 */
function toInt(value: string): number {
  if (!value.trim()) return 0
  const n = Number(value)
  return Number.isFinite(n) ? Math.trunc(n) : NaN
}

/**
 * 镜像后端 `pickTier`：按 minInvitees 升序，取第一档满足「无上限 或 人数 ≤ 上限」的；
 * 都不满足时落到最后一档。
 */
function matchTierIndex(tiers: { min: number; max: number | null }[], count: number): number {
  if (tiers.length === 0) return -1
  const order = tiers.map((t, i) => ({ t, i })).sort((a, b) => a.t.min - b.t.min)
  for (const { t, i } of order) {
    if (t.max === null || count <= t.max) return i
  }
  return order[order.length - 1].i
}

/**
 * 规则与阶梯。
 *
 * 接口是**整表替换**：一次 PUT 会把所有阶梯与券规则删掉重建，所以这里不写「单行保存」，
 * 页面就是一个「全量草稿 + 一次保存」的编辑器 —— 半保存的状态在服务端根本不存在。
 * 保存前先在本地跑一遍服务端那两条硬约束，把 400 变成页面上的红字。
 */
function RulesEditor({ initial, onSaved }: { initial: ReferralRuleset; onSaved: () => void }) {
  const [tiers, setTiers] = useState<TierDraft[]>(() => tierDraftsFrom(initial))
  const [coupons, setCoupons] = useState<CouponDraft[]>(() => couponDraftsFrom(initial))

  const [shortMinRate, setShortMinRate] = useState(String(initial.shortPeriodMinRatePercent))
  const [longCapYuan, setLongCapYuan] = useState(centsToYuan(initial.longPeriodCapCents))
  const [renewalRate, setRenewalRate] = useState(String(initial.renewalRatePercent))
  const [renewalCapYuan, setRenewalCapYuan] = useState(centsToYuan(initial.renewalCapCents))

  const [sampleYuan, setSampleYuan] = useState('299')
  const [samplePeriod, setSamplePeriod] = useState('monthly')
  const [sampleInvitees, setSampleInvitees] = useState('3')

  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  // ---- 本地校验：先把服务端会拒绝的情况挡在提交之前 ----
  const tierProblems = useMemo(() => {
    const parsed = tiers.map((t) => ({
      minInvitees: toInt(t.min),
      maxInvitees: t.max.trim() === '' ? null : toInt(t.max),
    }))
    const bad = parsed.find(
      (t) => !Number.isInteger(t.minInvitees) || t.minInvitees < 0 || (t.maxInvitees !== null && !Number.isInteger(t.maxInvitees)),
    )
    if (bad) return ['人数必须是 0 及以上的整数']
    return validateTiers(parsed)
  }, [tiers])

  const couponProblems = useMemo(() => {
    const problems: string[] = []
    coupons.forEach((c, i) => {
      const n = i + 1
      if (!c.name.trim()) problems.push(`第 ${n} 条券规则缺少名称`)
      if (!Number.isInteger(toInt(c.inviteeCount)) || toInt(c.inviteeCount) < 1) {
        problems.push(`第 ${n} 条券规则的触发人数需为 1 及以上`)
      }
      if (c.repeatEvery.trim() !== '' && (!Number.isInteger(toInt(c.repeatEvery)) || toInt(c.repeatEvery) < 1)) {
        problems.push(`第 ${n} 条券规则的重复间隔需为 1 及以上，或留空`)
      }
      if (!Number.isFinite(yuanToCents(c.amountYuan)) || yuanToCents(c.amountYuan) < 0) {
        problems.push(`第 ${n} 条券规则的面额不合法`)
      }
      if (!Number.isInteger(toInt(c.validDays)) || toInt(c.validDays) < 0) {
        problems.push(`第 ${n} 条券规则的有效天数需为 0 及以上`)
      }
    })
    return problems
  }, [coupons])

  const rateProblems = useMemo(() => {
    const problems: string[] = []
    const check = (label: string, value: string, min: number, max: number) => {
      const n = toInt(value)
      if (!Number.isInteger(n) || n < min || n > max) problems.push(`${label}需为 ${min}-${max} 的整数`)
    }
    check('短周期保底比例', shortMinRate, 0, 100)
    check('续费返现比例', renewalRate, 0, 100)
    const longCap = yuanToCents(longCapYuan)
    if (!Number.isFinite(longCap) || longCap < 0) problems.push('长周期单笔上限不合法')
    const renewalCap = yuanToCents(renewalCapYuan)
    if (!Number.isFinite(renewalCap) || renewalCap < 0) problems.push('续费单笔上限不合法')
    return problems
  }, [shortMinRate, renewalRate, longCapYuan, renewalCapYuan])

  const problems = [...tierProblems, ...couponProblems, ...rateProblems]

  // ---- 试算：与家长端下单时走的是同一套口径（逐行镜像 quoteFirstPurchase） ----
  const sampleCents = yuanToCents(sampleYuan)
  const couponConfig = {
    shortPeriodMinRatePercent: toInt(shortMinRate),
    longPeriodCapCents: yuanToCents(longCapYuan),
  }
  const tierRanges = tiers.map((t) => ({
    min: toInt(t.min),
    max: t.max.trim() === '' ? null : toInt(t.max),
  }))
  const matchedIndex = matchTierIndex(tierRanges, toInt(sampleInvitees))

  const submit = async () => {
    if (problems.length > 0) {
      setFormError('请先修正上方列出的问题')
      return
    }
    setSaving(true)
    setFormError(null)
    try {
      await api.referral.rules.update({
        // 整表替换：必须带上每一档、每一条券规则；sortOrder 由服务端按数组顺序分配
        tiers: tiers.map((t) => ({
          minInvitees: toInt(t.min),
          maxInvitees: t.max.trim() === '' ? null : toInt(t.max),
          ratePercent: toInt(t.rate),
        })),
        couponRules: coupons.map((c) => ({
          name: c.name.trim(),
          inviteeCount: toInt(c.inviteeCount),
          repeatEvery: c.repeatEvery.trim() === '' ? null : toInt(c.repeatEvery),
          amountCents: yuanToCents(c.amountYuan),
          validDays: toInt(c.validDays),
        })),
        shortPeriodMinRatePercent: toInt(shortMinRate),
        longPeriodCapCents: yuanToCents(longCapYuan),
        renewalRatePercent: toInt(renewalRate),
        renewalCapCents: yuanToCents(renewalCapYuan),
      })
      toast.success('规则已保存')
      onSaved()
    } catch (error: unknown) {
      const message = errorMessageOf(error, '保存失败，请稍后重试')
      setFormError(message)
      toast.error(message)
      console.error('保存返现规则失败：', error)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-3">
      <Card className={problems.length > 0 ? 'border-destructive/40' : 'border-amber-200'}>
        <CardContent className="p-3 text-xs">
          <p className="flex items-center gap-1.5 font-medium text-foreground">
            {problems.length > 0 ? (
              <AlertTriangle className="h-4 w-4 text-destructive" />
            ) : (
              <CheckCircle2 className="h-4 w-4 text-primary" />
            )}
            服务端会强制检查的两条阶梯约束
          </p>
          <ul className="mt-1.5 list-disc space-y-0.5 pl-5 text-muted-foreground">
            <li>必须有一档从 0 人开始（兜底档）—— 否则只邀请 1-2 人的家长一分钱都拿不到。</li>
            <li>相邻档位的人数区间不能重叠，否则同一笔订单可能命中两档。</li>
            <li>人数上限留空表示「无上限」，它只能是最后一档，后面的档位永远不会命中。</li>
          </ul>
          {problems.length > 0 ? (
            <ul className="mt-2 space-y-0.5 text-destructive">
              {problems.map((p, i) => (
                <li key={`${i}-${p}`}>· {p}</li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-primary">当前草稿通过本地校验，可以保存。</p>
          )}
        </CardContent>
      </Card>

      <Card className="border-dashed">
        <CardContent className="p-3 text-xs text-muted-foreground">
          保存是<span className="font-medium text-foreground">整表替换</span>
          ：服务端会删掉现有全部阶梯与券规则再按本页内容重建，
          <span className="text-foreground">行内的启用状态不会保留</span>
          —— 请求体里没有这个字段，重建后一律为启用。若某档要停用，请直接删掉该行。
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between pb-2">
          <CardTitle className="text-sm font-medium">返现阶梯</CardTitle>
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              setTiers((prev) => [...prev, { key: nextKey(), enabled: true, min: '0', max: '', rate: '10' }])
            }
          >
            <Plus className="h-3.5 w-3.5" />
            增加一档
          </Button>
        </CardHeader>
        <CardContent className="pt-0">
          <div className="admin-table-scroll">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-16">档位</TableHead>
                  <TableHead className="w-32">最少邀请人数</TableHead>
                  <TableHead className="w-32">最多邀请人数</TableHead>
                  <TableHead className="w-28">返现比例 %</TableHead>
                  <TableHead className="w-24">状态</TableHead>
                  <TableHead className="w-40">试算结果</TableHead>
                  <TableHead className="w-24 text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {tiers.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={7} className="py-8 text-center text-xs text-muted-foreground">
                      还没有任何阶梯，至少需要一档从 0 人开始的兜底档
                    </TableCell>
                  </TableRow>
                ) : null}
                {tiers.map((t, i) => {
                  const preview = quoteTier(
                    {
                      baseAmountCents: Number.isFinite(sampleCents) ? sampleCents : 0,
                      tierRatePercent: toInt(t.rate),
                      period: samplePeriod,
                    },
                    couponConfig,
                  )
                  return (
                    <TableRow key={t.key} className={i === matchedIndex ? 'bg-primary/5' : undefined}>
                      <TableCell className="text-xs text-muted-foreground">
                        {i + 1}
                        {i === matchedIndex ? <span className="ml-1 text-primary">命中</span> : null}
                      </TableCell>
                      <TableCell>
                        <Input
                          type="number"
                          min={0}
                          className="w-24"
                          value={t.min}
                          onChange={(e) =>
                            setTiers((prev) => prev.map((x) => (x.key === t.key ? { ...x, min: e.target.value } : x)))
                          }
                        />
                      </TableCell>
                      <TableCell>
                        <Input
                          type="number"
                          min={0}
                          placeholder="不限"
                          className="w-24"
                          value={t.max}
                          onChange={(e) =>
                            setTiers((prev) => prev.map((x) => (x.key === t.key ? { ...x, max: e.target.value } : x)))
                          }
                        />
                      </TableCell>
                      <TableCell>
                        <Input
                          type="number"
                          min={0}
                          max={100}
                          className="w-20"
                          value={t.rate}
                          onChange={(e) =>
                            setTiers((prev) => prev.map((x) => (x.key === t.key ? { ...x, rate: e.target.value } : x)))
                          }
                        />
                      </TableCell>
                      <TableCell>
                        <ToneBadge tone={t.enabled ? 'green' : 'gray'}>{t.enabled ? '已启用' : '已停用'}</ToneBadge>
                      </TableCell>
                      <TableCell className="text-xs">
                        <span className="font-mono text-sm font-semibold text-primary">
                          {formatCents(preview.amountCents)}
                        </span>
                        <span className="ml-1 text-muted-foreground">@{preview.ratePercent}%</span>
                        <span className="block text-[11px] text-muted-foreground">{preview.note}</span>
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setTiers((prev) => prev.filter((x) => x.key !== t.key))}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                          删除
                        </Button>
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </div>

          <div className="mt-3 flex flex-wrap items-end gap-3 rounded-lg bg-muted p-3">
            <span className="text-xs font-medium text-foreground">试算</span>
            <label className="space-y-1">
              <span className="block text-[11px] text-muted-foreground">首购实付（元）</span>
              <Input
                type="number"
                min={0}
                step="0.01"
                className="w-28"
                value={sampleYuan}
                onChange={(e) => setSampleYuan(e.target.value)}
              />
            </label>
            <label className="space-y-1">
              <span className="block text-[11px] text-muted-foreground">邀请人数</span>
              <Input
                type="number"
                min={0}
                className="w-24"
                value={sampleInvitees}
                onChange={(e) => setSampleInvitees(e.target.value)}
              />
            </label>
            <label className="space-y-1">
              <span className="block text-[11px] text-muted-foreground">周期</span>
              <select
                className="h-9 rounded-md border border-input bg-card px-3 text-sm"
                value={samplePeriod}
                onChange={(e) => setSamplePeriod(e.target.value)}
              >
                {PERIOD_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
            <p className="text-[11px] text-muted-foreground">
              每档右侧的金额是「若该笔订单落在这一档」会返多少；「命中」标记的是按上面的邀请人数实际会走的那一档。
              短周期（月卡/季卡）比例不低于短周期保底，长周期（年卡及以上）受单笔上限约束。
            </p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between pb-2">
          <CardTitle className="text-sm font-medium">阶梯参数</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-3 p-4 pt-0 sm:grid-cols-2 lg:grid-cols-4">
          <label className="block space-y-1">
            <span className="text-xs text-muted-foreground">短周期保底比例 %</span>
            <Input value={shortMinRate} onChange={(e) => setShortMinRate(e.target.value)} />
            <span className="block text-[11px] text-muted-foreground">月卡/季卡的返现比例下限，取「至少给到」</span>
          </label>
          <label className="block space-y-1">
            <span className="text-xs text-muted-foreground">长周期单笔上限（元）</span>
            <Input value={longCapYuan} onChange={(e) => setLongCapYuan(e.target.value)} />
            <span className="block text-[11px] text-muted-foreground">年卡及以上单笔返现封顶</span>
          </label>
          <label className="block space-y-1">
            <span className="text-xs text-muted-foreground">续费返现比例 %</span>
            <Input value={renewalRate} onChange={(e) => setRenewalRate(e.target.value)} />
            <span className="block text-[11px] text-muted-foreground">续费返现的兜底比例</span>
          </label>
          <label className="block space-y-1">
            <span className="text-xs text-muted-foreground">续费单笔上限（元）</span>
            <Input value={renewalCapYuan} onChange={(e) => setRenewalCapYuan(e.target.value)} />
            <span className="block text-[11px] text-muted-foreground">续费返现单笔封顶</span>
          </label>
          <p className="text-[11px] text-muted-foreground sm:col-span-2 lg:col-span-4">
            除以上四项外，服务端还有一条硬上限：任何单笔返现都不超过 {formatCents(100000)}，配置失误也不会失控。
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between pb-2">
          <CardTitle className="text-sm font-medium">优惠券里程碑</CardTitle>
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              setCoupons((prev) => [
                ...prev,
                {
                  key: nextKey(),
                  enabled: true,
                  name: '',
                  inviteeCount: '5',
                  repeatEvery: '',
                  amountYuan: '10.00',
                  validDays: '30',
                },
              ])
            }
          >
            <Plus className="h-3.5 w-3.5" />
            增加一条
          </Button>
        </CardHeader>
        <CardContent className="pt-0">
          <div className="admin-table-scroll">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-16">序号</TableHead>
                  <TableHead>名称</TableHead>
                  <TableHead className="w-28">触发人数</TableHead>
                  <TableHead className="w-32">每隔几人重复</TableHead>
                  <TableHead className="w-28">面额（元）</TableHead>
                  <TableHead className="w-24">有效天数</TableHead>
                  <TableHead className="w-24">状态</TableHead>
                  <TableHead className="w-24 text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {coupons.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={8} className="py-8 text-center text-xs text-muted-foreground">
                      没有券规则：邀请达到里程碑时不会发券
                    </TableCell>
                  </TableRow>
                ) : null}
                {coupons.map((c, i) => (
                  <TableRow key={c.key}>
                    <TableCell className="text-xs text-muted-foreground">{i + 1}</TableCell>
                    <TableCell>
                      <Input
                        placeholder="例如：邀请 5 人奖励券"
                        value={c.name}
                        onChange={(e) =>
                          setCoupons((prev) =>
                            prev.map((x) => (x.key === c.key ? { ...x, name: e.target.value } : x)),
                          )
                        }
                      />
                    </TableCell>
                    <TableCell>
                      <Input
                        type="number"
                        min={1}
                        className="w-20"
                        value={c.inviteeCount}
                        onChange={(e) =>
                          setCoupons((prev) =>
                            prev.map((x) => (x.key === c.key ? { ...x, inviteeCount: e.target.value } : x)),
                          )
                        }
                      />
                    </TableCell>
                    <TableCell>
                      <Input
                        type="number"
                        min={1}
                        placeholder="只发一次"
                        className="w-24"
                        value={c.repeatEvery}
                        onChange={(e) =>
                          setCoupons((prev) =>
                            prev.map((x) => (x.key === c.key ? { ...x, repeatEvery: e.target.value } : x)),
                          )
                        }
                      />
                    </TableCell>
                    <TableCell>
                      <Input
                        type="number"
                        min={0}
                        step="0.01"
                        className="w-24"
                        value={c.amountYuan}
                        onChange={(e) =>
                          setCoupons((prev) =>
                            prev.map((x) => (x.key === c.key ? { ...x, amountYuan: e.target.value } : x)),
                          )
                        }
                      />
                    </TableCell>
                    <TableCell>
                      <Input
                        type="number"
                        min={0}
                        className="w-20"
                        value={c.validDays}
                        onChange={(e) =>
                          setCoupons((prev) =>
                            prev.map((x) => (x.key === c.key ? { ...x, validDays: e.target.value } : x)),
                          )
                        }
                      />
                    </TableCell>
                    <TableCell>
                      <ToneBadge tone={c.enabled ? 'green' : 'gray'}>{c.enabled ? '已启用' : '已停用'}</ToneBadge>
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setCoupons((prev) => prev.filter((x) => x.key !== c.key))}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                        删除
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <ul className="mt-2 space-y-0.5 text-[11px] text-muted-foreground">
            {coupons.map((c, i) => (
              <li key={c.key}>
                · 第 {i + 1} 条：累计邀请满 <span className="font-mono text-foreground">{c.inviteeCount || 0}</span> 人发
                一张 <span className="font-mono text-foreground">{formatCents(yuanToCents(c.amountYuan))}</span> 券，
                有效期 <span className="font-mono text-foreground">{c.validDays || 0}</span> 天
                {c.repeatEvery.trim() === ''
                  ? '，只发一次'
                  : `，之后每多 ${c.repeatEvery} 人再发一张`}
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="flex flex-wrap items-center gap-3 p-3">
          <Button onClick={submit} disabled={saving || problems.length > 0}>
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
            {saving ? '保存中…' : '保存全部规则'}
          </Button>
          <span className="text-xs text-muted-foreground">
            共 {tiers.length} 档阶梯 · {coupons.length} 条券规则
          </span>
          {formError ? <span className="text-xs text-destructive">{formError}</span> : null}
          <span className="ml-auto text-xs text-muted-foreground">
            保存为整表替换：本页没有的内容会被删除，请一次性提交完整配置。
          </span>
        </CardContent>
      </Card>
    </div>
  )
}

/** 返现阶梯 + 券里程碑 + 四项比例/上限，一次整表保存。 */
export function RulesTab() {
  const {
    data,
    loading,
    error,
    reload: load,
  } = useAsyncData(() => api.referral.rules.get(), { deps: [] })

  return (
    <div>
      <PageHeader
        title="规则与阶梯"
        description="邀请人数决定返现比例，达到里程碑自动发优惠券。右侧试算用的就是家长端下单时的同一套口径。"
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
        emptyText="暂无规则配置"
        onRetry={load}
      >
        {data ? (
          // 内容变化即重挂载：编辑中的草稿会被服务端最新值替换，避免拿旧草稿覆盖别人刚改的规则
          <RulesEditor key={JSON.stringify(data)} initial={data} onSaved={load} />
        ) : null}
      </DataState>
    </div>
  )
}
