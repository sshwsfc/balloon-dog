import { useMemo, useState } from 'react'
import {
  Activity,
  BookOpen,
  Cpu,
  HardDrive,
  MapPin,
  MessageSquare,
  ShieldAlert,
  TrendingUp,
  Users,
} from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { api, formatBytes, formatRate } from '../api'
import { useAsyncData } from '../hooks/useAsyncData'
import { DataState, PageHeader, ToneBadge } from '../components/ui-kit'
import { COMMAND_STATUS_TONE } from '../components/status'

const RANGE_OPTIONS = [
  { days: 7, label: '近 7 天' },
  { days: 30, label: '近 30 天' },
  { days: 90, label: '近 90 天' },
]

/** KPI 卡片。 */
function KpiCard({
  icon: Icon,
  label,
  value,
  hint,
  tone = 'text-primary',
}: {
  icon: typeof Users
  label: string
  value: string
  hint?: string
  tone?: string
}) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-start justify-between">
          <div className="min-w-0">
            <p className="text-xs text-muted-foreground">{label}</p>
            <p className="mt-1.5 text-2xl font-semibold tracking-tight text-foreground">{value}</p>
            {hint ? <p className="mt-1 text-xs text-muted-foreground">{hint}</p> : null}
          </div>
          <div className={`shrink-0 rounded-lg bg-muted p-2 ${tone}`}>
            <Icon className="h-4 w-4" />
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

/** 极简柱状趋势图（纯 SVG，不引图表库）。 */
function TrendChart({
  title,
  points,
  color = '#07c160',
}: {
  title: string
  points: { date: string; count: number }[]
  color?: string
}) {
  const max = Math.max(1, ...points.map((p) => p.count))
  const total = points.reduce((s, p) => s + p.count, 0)
  const W = 560
  const H = 120
  const gap = 2
  const barW = points.length > 0 ? Math.max(1, (W - gap * (points.length - 1)) / points.length) : 1

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center justify-between text-sm font-medium">
          <span>{title}</span>
          <span className="text-xs font-normal text-muted-foreground">区间合计 {total}</span>
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-0">
        <svg viewBox={`0 0 ${W} ${H}`} className="h-[120px] w-full" preserveAspectRatio="none" role="img" aria-label={title}>
          {points.map((p, i) => {
            const h = p.count === 0 ? 1 : Math.max(2, (p.count / max) * (H - 8))
            return (
              <rect
                key={p.date}
                x={i * (barW + gap)}
                y={H - h}
                width={barW}
                height={h}
                rx={1.5}
                fill={color}
                opacity={p.count === 0 ? 0.15 : 0.85}
              >
                <title>{`${p.date}：${p.count}`}</title>
              </rect>
            )
          })}
        </svg>
        <div className="mt-1 flex justify-between text-[11px] text-muted-foreground">
          <span>{points[0]?.date ?? ''}</span>
          <span>{points[points.length - 1]?.date ?? ''}</span>
        </div>
      </CardContent>
    </Card>
  )
}

export default function DashboardPage() {
  const [days, setDays] = useState(30)

  const { data, loading, error, reload: load } = useAsyncData(() => api.stats(days), {
    deps: [days],
  })

  const kpi = data?.kpi
  const statusRows = useMemo(() => {
    if (!data) return []
    return [...data.breakdown.commandsByStatus].sort((a, b) => b.count - a.count)
  }, [data])

  return (
    <div>
      <PageHeader
        title="数据看板"
        description="平台整体运行状况。指令类指标为「后端已下发、设备端已执行」的真实结果。"
        actions={
          <div className="flex gap-1 rounded-lg border border-border bg-card p-1">
            {RANGE_OPTIONS.map((opt) => (
              <Button
                key={opt.days}
                size="sm"
                variant={days === opt.days ? 'default' : 'ghost'}
                onClick={() => setDays(opt.days)}
              >
                {opt.label}
              </Button>
            ))}
          </div>
        }
      />

      <DataState loading={loading} error={error} empty={!data} onRetry={load}>
        {kpi ? (
          <div className="space-y-4">
            {/* 核心 KPI */}
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <KpiCard
                icon={Users}
                label="家长账号"
                value={String(kpi.totalUsers)}
                hint={`区间新增 ${kpi.newUsersInRange} · 禁用 ${kpi.disabledUsers}`}
              />
              <KpiCard
                icon={Cpu}
                label="孩子设备"
                value={String(kpi.totalDevices)}
                hint={`已认领 ${kpi.boundDevices} · 待认领 ${kpi.unboundDevices}`}
              />
              <KpiCard
                icon={Activity}
                label="累计指令"
                value={String(kpi.totalCommands)}
                hint={`待执行 ${kpi.pendingCommands} · 成功 ${kpi.succeededCommands}`}
              />
              <KpiCard
                icon={TrendingUp}
                label="指令成功率"
                value={formatRate(kpi.commandSuccessRate)}
                hint={`失败/超时 ${kpi.failedCommands} 条`}
                tone={kpi.commandSuccessRate !== null && kpi.commandSuccessRate < 0.8 ? 'text-destructive' : 'text-primary'}
              />
            </div>

            {/* 次级指标 */}
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <KpiCard
                icon={ShieldAlert}
                label="当前在线设备"
                value={String(kpi.onlineDevices)}
                hint={`已锁定 ${kpi.lockedDevices} 台`}
              />
              <KpiCard
                icon={HardDrive}
                label="回传媒体"
                value={String(kpi.totalMedia)}
                hint={`占用 ${formatBytes(kpi.mediaBytes)}`}
              />
              <KpiCard
                icon={MapPin}
                label="位置数据"
                value={String(kpi.totalLocations)}
                hint={`安全区 ${kpi.totalSafeZones} 个`}
              />
              <KpiCard
                icon={BookOpen}
                label="答题正确率"
                value={formatRate(kpi.quizAccuracy)}
                hint={`共 ${kpi.totalQuizRecords} 条答题记录`}
              />
            </div>

            {/* 趋势 */}
            <div className="grid gap-3 lg:grid-cols-3">
              <TrendChart title="新增家长账号" points={data.series.users} />
              <TrendChart title="新增设备" points={data.series.devices} color="#3b82f6" />
              <TrendChart title="指令下发量" points={data.series.commands} color="#f59e0b" />
            </div>

            {/* 分布 */}
            <div className="grid gap-3 lg:grid-cols-3">
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-medium">指令状态分布</CardTitle>
                </CardHeader>
                <CardContent className="space-y-2 pt-0">
                  {statusRows.length === 0 ? (
                    <p className="py-4 text-center text-sm text-muted-foreground">暂无数据</p>
                  ) : (
                    statusRows.map((row) => {
                      const view = COMMAND_STATUS_TONE[row.status] ?? { label: row.status, tone: 'gray' as const }
                      return (
                        <div key={row.status} className="flex items-center justify-between text-sm">
                          <ToneBadge tone={view.tone}>{view.label}</ToneBadge>
                          <span className="font-medium text-foreground">{row.count}</span>
                        </div>
                      )
                    })
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-medium">指令类型分布</CardTitle>
                </CardHeader>
                <CardContent className="space-y-2 pt-0">
                  {data.breakdown.commandsByType.length === 0 ? (
                    <p className="py-4 text-center text-sm text-muted-foreground">暂无数据</p>
                  ) : (
                    data.breakdown.commandsByType.slice(0, 8).map((row) => (
                      <div key={row.type} className="flex items-center justify-between text-sm">
                        <span className="font-mono text-xs text-muted-foreground">{row.type}</span>
                        <span className="font-medium text-foreground">{row.count}</span>
                      </div>
                    ))
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-medium">答题与验证码</CardTitle>
                </CardHeader>
                <CardContent className="space-y-2 pt-0">
                  {data.breakdown.quizByType.map((row) => (
                    <div key={row.type} className="flex items-center justify-between text-sm">
                      <span className="text-muted-foreground">
                        {row.type === 'english' ? '英文单词' : row.type === 'poetry' ? '古诗填空' : row.type}
                      </span>
                      <span className="text-foreground">
                        {row.count} 题 · 奖励 {row.rewardMinutes} 分钟
                      </span>
                    </div>
                  ))}
                  <div className="flex items-center justify-between border-t border-border pt-2 text-sm">
                    <span className="flex items-center gap-1.5 text-muted-foreground">
                      <MessageSquare className="h-3.5 w-3.5" />
                      验证码发送总量
                    </span>
                    <span className="font-medium text-foreground">{kpi.totalSmsCodes}</span>
                  </div>
                </CardContent>
              </Card>
            </div>
          </div>
        ) : null}
      </DataState>
    </div>
  )
}
