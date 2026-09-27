import type { ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { ChevronLeft, ChevronRight, Loader2, RefreshCw } from 'lucide-react'
import { cn } from '@/lib/utils'
import { COMMAND_STATUS_TONE, TONES, type Tone } from './status'

/** 页面标题 + 右侧操作区。 */
export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string
  description?: ReactNode
  actions?: ReactNode
}) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold text-foreground">{title}</h1>
        {description ? <p className="mt-1 text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  )
}

/** 加载中 / 空 / 错误 三态的统一呈现，避免每个页面各写一套。 */
export function DataState({
  loading,
  error,
  empty,
  emptyText = '暂无数据',
  onRetry,
  children,
}: {
  loading: boolean
  error: string | null
  empty: boolean
  emptyText?: string
  onRetry?: () => void
  children: ReactNode
}) {
  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        加载中…
      </div>
    )
  }
  if (error) {
    return (
      <div className="py-16 text-center">
        <p className="text-sm text-destructive">{error}</p>
        {onRetry ? (
          <Button variant="outline" size="sm" className="mt-3" onClick={onRetry}>
            <RefreshCw className="h-3.5 w-3.5" />
            重试
          </Button>
        ) : null}
      </div>
    )
  }
  if (empty) {
    return <p className="py-16 text-center text-sm text-muted-foreground">{emptyText}</p>
  }
  return <>{children}</>
}

/** 分页条。 */
export function Pagination({
  page,
  pageSize,
  total,
  totalPages,
  onPageChange,
  onPageSizeChange,
}: {
  page: number
  pageSize: number
  total: number
  totalPages: number
  onPageChange: (page: number) => void
  onPageSizeChange?: (size: number) => void
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-3 py-3 text-sm">
      <span className="text-muted-foreground">
        共 <span className="font-medium text-foreground">{total}</span> 条 · 第 {page}/{totalPages} 页
      </span>
      <div className="flex items-center gap-2">
        {onPageSizeChange ? (
          <select
            value={pageSize}
            onChange={(e) => onPageSizeChange(Number(e.target.value))}
            className="h-8 rounded-md border border-input bg-card px-2 text-xs focus-visible:outline-none"
            aria-label="每页条数"
          >
            {[10, 20, 50, 100].map((n) => (
              <option key={n} value={n}>
                {n} 条/页
              </option>
            ))}
          </select>
        ) : null}
        <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => onPageChange(page - 1)}>
          <ChevronLeft className="h-3.5 w-3.5" />
          上一页
        </Button>
        <Button variant="outline" size="sm" disabled={page >= totalPages} onClick={() => onPageChange(page + 1)}>
          下一页
          <ChevronRight className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  )
}

/** 通用状态徽章。 */
export function ToneBadge({
  tone = 'gray',
  children,
  className,
}: {
  tone?: Tone
  children: ReactNode
  className?: string
}) {
  return <Badge className={cn('border-0 font-normal', TONES[tone], className)}>{children}</Badge>
}

/** 指令执行状态徽章（文案与配色取自 status.ts 的共享口径）。 */
export function CommandStatusBadge({ status }: { status: string }) {
  const view = COMMAND_STATUS_TONE[status] ?? { label: status, tone: 'gray' as Tone }
  return <ToneBadge tone={view.tone}>{view.label}</ToneBadge>
}

/** 设备在线/锁定徽章。 */
export function OnlineBadge({ online, locked }: { online: boolean; locked?: boolean }) {
  if (locked) return <ToneBadge tone="red">已锁定</ToneBadge>
  return <ToneBadge tone={online ? 'green' : 'gray'}>{online ? '在线' : '离线'}</ToneBadge>
}
