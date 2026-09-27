import { Check, Loader2, RefreshCw, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Select } from '@/components/ui/input'
import { Card } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { api, formatDateTime } from '../api'
import { useAsyncData, useFilters } from '../hooks/useAsyncData'
import { DataState, PageHeader, Pagination, ToneBadge } from '../components/ui-kit'
import { quizTypeLabel } from '../components/status'

export default function QuizRecordPage() {
  const { filters, setFilter, page, setPage, pageSize, changePageSize } = useFilters({
    type: '',
    isCorrect: '',
  })

  const { data: rows, loading, error, reload: load } = useAsyncData(
    () =>
      api.quizRecords.list({
        type: filters.type || undefined,
        isCorrect: filters.isCorrect || undefined,
        page,
        pageSize,
      }),
    { deps: [filters.type, filters.isCorrect, page, pageSize] },
  )

  return (
    <div>
      <PageHeader
        title="答题记录"
        description="全平台孩子在设备上的答题明细。答对会为其设备延长可用时长（奖励分钟数在最后一列）。"
        actions={
          <Button variant="outline" size="sm" onClick={load} disabled={loading}>
            {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            刷新
          </Button>
        }
      />

      <Card className="mb-3">
        <div className="flex flex-wrap items-center gap-2 p-3">
          <Select value={filters.type} onChange={(e) => setFilter('type', e.target.value)} className="w-32">
            <option value="">全部类型</option>
            <option value="english">英文单词</option>
            <option value="poetry">古诗填空</option>
          </Select>
          <Select value={filters.isCorrect} onChange={(e) => setFilter('isCorrect', e.target.value)} className="w-28">
            <option value="">全部结果</option>
            <option value="true">答对</option>
            <option value="false">答错</option>
          </Select>
        </div>
      </Card>

      <Card className="overflow-hidden">
        <DataState
          loading={loading && !rows}
          error={error}
          empty={(rows?.items.length ?? 0) === 0}
          emptyText="暂无答题记录"
          onRetry={load}
        >
          <div className="admin-table-scroll">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-20">结果</TableHead>
                  <TableHead>题目</TableHead>
                  <TableHead className="w-40">设备 / 家长</TableHead>
                  <TableHead className="w-32">类型</TableHead>
                  <TableHead className="w-20">奖励</TableHead>
                  <TableHead className="w-36">时间</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows?.items.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell>
                      {row.isCorrect ? (
                        <ToneBadge tone="green">
                          <Check className="mr-0.5 h-3 w-3" />
                          答对
                        </ToneBadge>
                      ) : (
                        <ToneBadge tone="red">
                          <X className="mr-0.5 h-3 w-3" />
                          答错
                        </ToneBadge>
                      )}
                    </TableCell>
                    <TableCell>
                      <div className="text-sm text-foreground">{row.question}</div>
                      <div className="text-xs text-muted-foreground">
                        孩子选择第 {row.userAnswer + 1} 个选项
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="text-sm text-foreground">{row.deviceName || '—'}</div>
                      <div className="text-xs text-muted-foreground">
                        {row.owner ? row.owner.phone || row.owner.nickname : '未认领'}
                      </div>
                    </TableCell>
                    <TableCell>
                      <ToneBadge tone={row.type === 'english' ? 'blue' : 'purple'}>
                        {quizTypeLabel(row.type)}
                      </ToneBadge>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {row.rewardMinutes > 0 ? `+${row.rewardMinutes} 分钟` : '—'}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                      {formatDateTime(row.createdAt)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          {rows ? (
            <Pagination
              page={rows.page}
              pageSize={rows.pageSize}
              total={rows.total}
              totalPages={rows.totalPages}
              onPageChange={setPage}
              onPageSizeChange={changePageSize}
            />
          ) : null}
        </DataState>
      </Card>
    </div>
  )
}
