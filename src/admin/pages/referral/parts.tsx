import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import type { Tone } from '../../components/status'
import { formatCents } from './shared'

/** 列表上方那一排「按状态分组的条数 + 金额」，数据来自响应里的 `summary.statusCounts`。 */
export function StatusCountRow({
  options,
  tones,
  counts,
}: {
  options: { value: string; label: string }[]
  tones: Record<string, Tone>
  counts: Record<string, { count: number; amountCents: number }> | undefined
}) {
  const gridClass =
    options.length >= 4
      ? 'mb-3 grid grid-cols-2 gap-3 sm:grid-cols-4'
      : options.length === 3
        ? 'mb-3 grid grid-cols-3 gap-3'
        : 'mb-3 grid grid-cols-2 gap-3'

  return (
    <div className={gridClass}>
      {options.map((o) => {
        const c = counts?.[o.value]
        return (
          <Card key={o.value}>
            <CardContent className="p-3">
              <div className="flex items-center gap-2">
                <span className={`inline-block h-2 w-2 rounded-full ${DOT[tones[o.value] ?? 'gray']}`} />
                <span className="text-xs text-muted-foreground">{o.label}</span>
              </div>
              <p className="mt-1 font-mono text-lg font-semibold text-foreground">{c?.count ?? 0}</p>
              <p className="text-[11px] text-muted-foreground">{formatCents(c?.amountCents ?? 0)}</p>
            </CardContent>
          </Card>
        )
      })}
    </div>
  )
}

const DOT: Record<Tone, string> = {
  green: 'bg-primary',
  red: 'bg-destructive',
  amber: 'bg-amber-500',
  blue: 'bg-blue-500',
  gray: 'bg-muted-foreground',
  purple: 'bg-purple-500',
}

/**
 * 起止时间筛选。
 *
 * 两个输入框都是 `type="date"`，拿到的是 `YYYY-MM-DD`；换算成后端参数请用
 * `shared.ts` 里的 `dayStart` / `dayEnd`（结束日要补到当天最后一毫秒）。
 */
export function DateRangeFilter({
  from,
  to,
  onFromChange,
  onToChange,
}: {
  from: string
  to: string
  onFromChange: (value: string) => void
  onToChange: (value: string) => void
}) {
  return (
    <>
      <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
        从
        <Input
          type="date"
          className="w-[150px]"
          value={from}
          onChange={(e) => onFromChange(e.target.value)}
        />
      </label>
      <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
        到
        <Input type="date" className="w-[150px]" value={to} onChange={(e) => onToChange(e.target.value)} />
      </label>
    </>
  )
}
