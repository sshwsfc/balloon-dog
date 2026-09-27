import { useState } from 'react'
import { toast } from 'sonner'
import { Loader2, Pencil, Plus, RefreshCw, Search, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input, Select, Textarea } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
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
import { api, errorMessageOf, formatDateTime, type QuestionRow } from '../api'
import { useAsyncData, useFilters } from '../hooks/useAsyncData'
import { ConfirmDialog } from '../components/ConfirmDialog'
import { DataState, PageHeader, Pagination, ToneBadge } from '../components/ui-kit'
import { QUIZ_GRADES, gradeLabel, quizTypeLabel } from '../components/status'

const GRADES = QUIZ_GRADES

const TYPES = [
  { value: 'english', label: '英文单词' },
  { value: 'poetry', label: '古诗填空' },
]

const typeLabel = quizTypeLabel

interface FormState {
  id: string | null
  type: string
  grade: string
  question: string
  options: string[]
  correctAnswer: number
  explanation: string
}

const EMPTY_FORM: FormState = {
  id: null,
  type: 'english',
  grade: 'grade3',
  question: '',
  options: ['', '', '', ''],
  correctAnswer: 0,
  explanation: '',
}

export default function QuestionManagePage() {
  const { filters, setFilter, page, setPage, pageSize, changePageSize } = useFilters({
    q: '',
    type: '',
    grade: '',
  })

  const { data: rows, loading, error, reload: load } = useAsyncData(
    () =>
      api.questions.list({
        q: filters.q.trim() || undefined,
        type: filters.type || undefined,
        grade: filters.grade || undefined,
        page,
        pageSize,
      }),
    { deps: [filters.q, filters.type, filters.grade, page, pageSize], debounceMs: 250 },
  )

  const [form, setForm] = useState<FormState | null>(null)
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [removeTarget, setRemoveTarget] = useState<QuestionRow | null>(null)
  const [removing, setRemoving] = useState(false)

  const openCreate = () => {
    setFormError(null)
    setForm({ ...EMPTY_FORM, options: ['', '', '', ''] })
  }

  const openEdit = (row: QuestionRow) => {
    setFormError(null)
    setForm({
      id: row.id,
      type: row.type,
      grade: row.grade,
      question: row.question,
      options: [...row.options],
      correctAnswer: row.correctAnswer,
      explanation: row.explanation,
    })
  }

  const validate = (f: FormState): string | null => {
    if (!f.question.trim()) return '题干不能为空'
    const options = f.options.map((o) => o.trim()).filter(Boolean)
    if (options.length < 2) return '至少需要 2 个非空选项'
    if (f.correctAnswer >= options.length) return '请把正确答案指向一个非空选项'
    return null
  }

  const save = async () => {
    if (!form) return
    const invalid = validate(form)
    if (invalid) {
      setFormError(invalid)
      return
    }
    setSaving(true)
    setFormError(null)
    try {
      // 提交前把空选项裁掉，避免把占位空行存进题库
      const payload = {
        type: form.type,
        grade: form.grade,
        question: form.question.trim(),
        options: form.options.map((o) => o.trim()).filter(Boolean),
        correctAnswer: form.correctAnswer,
        explanation: form.explanation.trim(),
      }
      if (form.id) {
        await api.questions.update(form.id, payload)
        toast.success('题目已更新')
      } else {
        await api.questions.create(payload)
        toast.success('题目已新增')
      }
      setForm(null)
      load()
    } catch (e) {
      setFormError(errorMessageOf(e, '保存失败'))
    } finally {
      setSaving(false)
    }
  }

  const doRemove = async () => {
    if (!removeTarget) return
    setRemoving(true)
    try {
      await api.questions.remove(removeTarget.id)
      toast.success('题目已删除')
      setRemoveTarget(null)
      load()
    } catch (e) {
      toast.error(errorMessageOf(e, '删除失败'))
    } finally {
      setRemoving(false)
    }
  }

  return (
    <div>
      <PageHeader
        title="题库管理"
        description="答题解锁使用的题库。已有孩子作答记录的题目不允许删除，防止连带清掉答题历史。"
        actions={
          <>
            <Button variant="outline" size="sm" onClick={load} disabled={loading}>
              {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
              刷新
            </Button>
            <Button size="sm" onClick={openCreate}>
              <Plus className="h-3.5 w-3.5" />
              新增题目
            </Button>
          </>
        }
      />

      {/* 题量分布 */}
      {rows && rows.distribution.length > 0 ? (
        <Card className="mb-3">
          <CardContent className="flex flex-wrap gap-2 p-3">
            {GRADES.map((g) => {
              const total = rows.distribution.filter((d) => d.grade === g.value).reduce((s, d) => s + d.count, 0)
              return (
                <button
                  key={g.value}
                  type="button"
                  onClick={() => setFilter('grade', filters.grade === g.value ? '' : g.value)}
                  className={`rounded-lg border px-3 py-1.5 text-xs transition-colors ${
                    filters.grade === g.value
                      ? 'border-primary bg-primary/10 text-primary'
                      : 'border-border text-muted-foreground hover:bg-accent'
                  }`}
                >
                  {g.label}
                  <span className="ml-1.5 font-medium">{total}</span>
                </button>
              )
            })}
          </CardContent>
        </Card>
      ) : null}

      <Card className="mb-3">
        <CardContent className="flex flex-wrap items-center gap-2 p-3">
          <div className="relative min-w-[220px] flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={filters.q}
              onChange={(e) => setFilter('q', e.target.value)}
              placeholder="搜索题干关键词"
              className="pl-9"
            />
          </div>
          <Select value={filters.type} onChange={(e) => setFilter('type', e.target.value)} className="w-32">
            <option value="">全部类型</option>
            {TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </Select>
          <Select value={filters.grade} onChange={(e) => setFilter('grade', e.target.value)} className="w-32">
            <option value="">全部年级</option>
            {GRADES.map((g) => (
              <option key={g.value} value={g.value}>
                {g.label}
              </option>
            ))}
          </Select>
        </CardContent>
      </Card>

      <Card className="overflow-hidden">
        <DataState
          loading={loading && !rows}
          error={error}
          empty={(rows?.items.length ?? 0) === 0}
          emptyText="没有符合条件的题目"
          onRetry={load}
        >
          <div className="admin-table-scroll">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-24">类型 / 年级</TableHead>
                  <TableHead>题干与选项</TableHead>
                  <TableHead className="w-32">创建时间</TableHead>
                  <TableHead className="w-24 text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows?.items.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell>
                      <ToneBadge tone={row.type === 'english' ? 'blue' : 'purple'}>{typeLabel(row.type)}</ToneBadge>
                      <div className="mt-1 text-xs text-muted-foreground">{gradeLabel(row.grade)}</div>
                    </TableCell>
                    <TableCell>
                      <div className="text-sm font-medium text-foreground">{row.question}</div>
                      <div className="mt-1 flex flex-wrap gap-1.5">
                        {row.options.map((opt, i) => (
                          <span
                            key={`${row.id}-${i}`}
                            className={`rounded px-2 py-0.5 text-xs ${
                              i === row.correctAnswer
                                ? 'bg-primary/10 font-medium text-primary'
                                : 'bg-muted text-muted-foreground'
                            }`}
                          >
                            {i === row.correctAnswer ? '✓ ' : ''}
                            {opt}
                          </span>
                        ))}
                      </div>
                      {row.explanation ? (
                        <div className="mt-1 text-xs text-muted-foreground">解析：{row.explanation}</div>
                      ) : null}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                      {formatDateTime(row.createdAt)}
                    </TableCell>
                    <TableCell>
                      <div className="flex justify-end gap-1">
                        <Button variant="ghost" size="sm" onClick={() => openEdit(row)} title="编辑">
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-destructive hover:text-destructive"
                          onClick={() => setRemoveTarget(row)}
                          title="删除"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
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

      {/* 新增 / 编辑 */}
      <Dialog open={Boolean(form)} onOpenChange={(open) => (!open ? setForm(null) : null)}>
        <DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{form?.id ? '编辑题目' : '新增题目'}</DialogTitle>
            <DialogDescription>答案与选项下标对应；提交时会自动去掉空白选项。</DialogDescription>
          </DialogHeader>

          {form ? (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label>类型</Label>
                  <Select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
                    {TYPES.map((t) => (
                      <option key={t.value} value={t.value}>
                        {t.label}
                      </option>
                    ))}
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label>年级</Label>
                  <Select value={form.grade} onChange={(e) => setForm({ ...form, grade: e.target.value })}>
                    {GRADES.map((g) => (
                      <option key={g.value} value={g.value}>
                        {g.label}
                      </option>
                    ))}
                  </Select>
                </div>
              </div>

              <div className="space-y-1.5">
                <Label>题干</Label>
                <Textarea
                  value={form.question}
                  onChange={(e) => setForm({ ...form, question: e.target.value })}
                  placeholder={
                    form.type === 'english' ? "What does 'apple' mean?" : '春眠不觉晓，__闻啼鸟。'
                  }
                />
              </div>

              <div className="space-y-1.5">
                <Label>选项（点左侧圆点设为正确答案）</Label>
                {form.options.map((opt, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setForm({ ...form, correctAnswer: i })}
                      className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-[10px] transition-colors ${
                        form.correctAnswer === i
                          ? 'border-primary bg-primary text-primary-foreground'
                          : 'border-border text-muted-foreground'
                      }`}
                      title="设为正确答案"
                    >
                      {String.fromCharCode(65 + i)}
                    </button>
                    <Input
                      value={opt}
                      onChange={(e) => {
                        const options = [...form.options]
                        options[i] = e.target.value
                        setForm({ ...form, options })
                      }}
                      placeholder={`选项 ${String.fromCharCode(65 + i)}`}
                    />
                    {form.options.length > 2 ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-destructive hover:text-destructive"
                        onClick={() => {
                          const options = form.options.filter((_, idx) => idx !== i)
                          const correctAnswer = Math.min(form.correctAnswer, options.length - 1)
                          setForm({ ...form, options, correctAnswer })
                        }}
                        title="删除该选项"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    ) : null}
                  </div>
                ))}
                {form.options.length < 8 ? (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setForm({ ...form, options: [...form.options, ''] })}
                  >
                    <Plus className="h-3.5 w-3.5" />
                    添加选项
                  </Button>
                ) : null}
              </div>

              <div className="space-y-1.5">
                <Label>解析（可选）</Label>
                <Input
                  value={form.explanation}
                  onChange={(e) => setForm({ ...form, explanation: e.target.value })}
                  placeholder="答题后展示给孩子的解释"
                />
              </div>

              {formError ? <p className="text-sm text-destructive">{formError}</p> : null}
            </div>
          ) : null}

          <DialogFooter>
            <Button variant="outline" onClick={() => setForm(null)} disabled={saving}>
              取消
            </Button>
            <Button onClick={save} disabled={saving}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              {saving ? '保存中…' : '保存'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={Boolean(removeTarget)}
        onOpenChange={(open) => (!open ? setRemoveTarget(null) : null)}
        title="删除题目"
        description={
          <>
            将删除题目「{removeTarget?.question}」。如果这道题已经有孩子作答过，后端会拒绝删除
            （避免连带清空答题历史），此时请改为修改题干内容。
          </>
        }
        confirmText="删除"
        loading={removing}
        onConfirm={doRemove}
      />
    </div>
  )
}
