import { useState } from 'react'
import { Info, Loader2, RefreshCw, ShieldAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { api, formatDateTime } from '../../api'
import { useAsyncData } from '../../hooks/useAsyncData'
import { DataState, PageHeader, ToneBadge } from '../../components/ui-kit'
import { RISK_LEVEL_LABEL, RISK_LEVEL_TONE, RISK_TYPE_META, RISK_TYPE_ORDER } from './shared'

const RANGE_OPTIONS = [7, 30, 90]

/**
 * 风险排查。
 *
 * 这一页**只看不做**：列出来的都是「值得人工看一眼」的信号，不是判定结论。
 * 刻意没有处罚按钮 —— 误伤一个正常家长的代价远大于漏掉一个刷单的，
 * 所以服务端也不提供任何自动处置接口。
 */
export function RiskTab() {
  const [days, setDays] = useState(30)

  const {
    data,
    loading,
    error,
    reload: load,
  } = useAsyncData(() => api.referral.risk(days), { deps: [days] })

  const grouped = RISK_TYPE_ORDER.map((type) => ({
    type,
    meta: RISK_TYPE_META[type] ?? { label: type, rule: '' },
    items: (data?.findings ?? []).filter((f) => f.type === type),
  })).filter((g) => g.items.length > 0)

  // 后端将来若新增了未登记的类型，也不能让它们凭空消失
  const known = new Set(RISK_TYPE_ORDER)
  const extras = (data?.findings ?? []).filter((f) => !known.has(f.type))
  if (extras.length > 0) {
    grouped.push({
      type: 'other',
      meta: { label: '其它信号', rule: '服务端返回了本页尚未登记说明的风险类型，请让研发补充口径。' },
      items: extras,
    })
  }

  return (
    <div>
      <PageHeader
        title="风险排查"
        description="基于邀请关系与提现记录的只读信号清单，用于人工复核。这里没有任何「处罚」「封禁」操作。"
        actions={
          <>
            <div className="flex overflow-hidden rounded-md border">
              {RANGE_OPTIONS.map((d) => (
                <button
                  key={d}
                  type="button"
                  onClick={() => setDays(d)}
                  className={`px-3 py-1.5 text-xs ${
                    days === d ? 'bg-primary text-primary-foreground' : 'bg-background text-muted-foreground'
                  }`}
                >
                  近 {d} 天
                </button>
              ))}
            </div>
            <Button variant="outline" size="sm" onClick={load} disabled={loading}>
              {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
              刷新
            </Button>
          </>
        }
      />

      <DataState loading={loading && !data} error={error} empty={!data} emptyText="暂无风险数据" onRetry={load}>
        {data ? (
          <div className="space-y-3">
            <Card className="border-amber-200 bg-amber-50/50">
              <CardContent className="flex items-start gap-2 p-3 text-xs text-amber-800">
                <Info className="mt-0.5 h-4 w-4 shrink-0" />
                <div className="space-y-1">
                  <p className="font-medium">本页仅为提示，不构成结论，也没有处罚动作。</p>
                  <p>
                    每一条只表示「这组账号出现了值得复核的特征」。同手机号自邀、同证件多账号、短时间集中绑定
                    都可能由正常原因造成（家人共用设备、换号、开学季集中注册）。请结合客服记录与实名材料人工判断；
                    确认作弊后需按运营流程线下处理，系统不会自动扣回或封禁。
                  </p>
                </div>
              </CardContent>
            </Card>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <Card>
                <CardContent className="p-3">
                  <p className="text-xs text-muted-foreground">高风险信号</p>
                  <p className="mt-1 font-mono text-lg font-semibold text-destructive">{data.high}</p>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="p-3">
                  <p className="text-xs text-muted-foreground">中风险信号</p>
                  <p className="mt-1 font-mono text-lg font-semibold text-amber-600">{data.medium}</p>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="p-3">
                  <p className="text-xs text-muted-foreground">扫描范围</p>
                  <p className="mt-1 font-mono text-lg font-semibold text-foreground">{data.scanned}</p>
                  <p className="text-[11px] text-muted-foreground">
                    自 {formatDateTime(data.since)} 起共 {data.days} 天
                  </p>
                </CardContent>
              </Card>
            </div>

            {grouped.length === 0 ? (
              <Card>
                <CardContent className="flex flex-col items-center gap-2 py-16 text-center">
                  <ShieldAlert className="h-6 w-6 text-muted-foreground" />
                  <p className="text-sm text-foreground">近 {data.days} 天没有发现可疑信号</p>
                  <p className="text-xs text-muted-foreground">换一个时间范围可以看更长的窗口。</p>
                </CardContent>
              </Card>
            ) : null}

            {grouped.map((g) => (
              <Card key={g.type}>
                <CardHeader className="pb-2">
                  <CardTitle className="flex flex-wrap items-center gap-2 text-sm font-medium">
                    {g.meta.label}
                    <ToneBadge tone="gray">{g.items.length} 条</ToneBadge>
                  </CardTitle>
                  <p className="text-xs text-muted-foreground">{g.meta.rule}</p>
                </CardHeader>
                <CardContent className="pt-0">
                  <div className="admin-table-scroll">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead className="w-24">级别</TableHead>
                          <TableHead>信号</TableHead>
                          <TableHead>涉及账号</TableHead>
                          <TableHead className="w-32">发生时间</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {g.items.map((f, i) => (
                          <TableRow key={`${f.type}-${f.at}-${i}`}>
                            <TableCell>
                              <ToneBadge tone={RISK_LEVEL_TONE[f.level] ?? 'gray'}>
                                {RISK_LEVEL_LABEL[f.level] ?? f.level}
                              </ToneBadge>
                            </TableCell>
                            <TableCell>
                              <p className="text-sm text-foreground">{f.title}</p>
                              <p className="text-xs text-muted-foreground">{f.detail}</p>
                            </TableCell>
                            <TableCell className="font-mono text-xs text-muted-foreground">
                              {f.userIds.length > 0 ? f.userIds.join('、') : '—'}
                            </TableCell>
                            <TableCell className="text-xs text-muted-foreground">{formatDateTime(f.at)}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        ) : null}
      </DataState>
    </div>
  )
}
