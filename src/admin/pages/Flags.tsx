import { useState } from 'react'
import { Loader2, RefreshCw, RotateCcw, Save, Search } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input, Textarea } from '@/components/ui/input'
import { Card, CardContent } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { ConfirmDialog } from '../components/ConfirmDialog'
import { DataState, PageHeader, ToneBadge } from '../components/ui-kit'
import {
  api,
  errorMessageOf,
  formatDateTime,
  type FlagEvaluation,
  type FlagPatch,
  type FlagView,
} from '../api'
import { useAsyncData } from '../hooks/useAsyncData'
import {
  ALLOW_IDS_MAX,
  ALLOW_ID_MAX,
  BUCKET_LABELS,
  DESCRIPTION_MAX,
  flagRuleText,
  parseAllowIds,
  subjectHint,
  updatedByText,
} from './flags/shared'

interface FlagForm {
  enabled: boolean
  rolloutPercent: string
  allowIdsText: string
  description: string
}

function buildChanges(flag: FlagView, next: FlagForm): string[] {
  const changes: string[] = []
  if (flag.enabled !== next.enabled) {
    changes.push(`启用状态：${flag.enabled ? '启用' : '停用'} → ${next.enabled ? '启用' : '停用'}`)
  }
  const nextPercent = Number(next.rolloutPercent)
  if (flag.rolloutPercent !== nextPercent) {
    changes.push(`放量比例：${flag.rolloutPercent}% → ${nextPercent}%`)
  }
  const nextAllowIds = parseAllowIds(next.allowIdsText)
  if (flag.allowIds.length !== nextAllowIds.length || flag.allowIds.some((id, i) => id !== nextAllowIds[i])) {
    changes.push(`白名单：${flag.allowIds.length} 项 → ${nextAllowIds.length} 项`)
  }
  if (flag.description !== next.description.trim()) {
    changes.push('说明文案：已修改')
  }
  return changes
}

/** 一个开关 = 一张卡片：当前规则、是否代码默认值、谁在什么时候改的、试算入口。 */
function FlagCard({ flag, onSaved }: { flag: FlagView; onSaved: () => void }) {
  const [editOpen, setEditOpen] = useState(false)
  const [form, setForm] = useState<FlagForm>({
    enabled: flag.enabled,
    rolloutPercent: String(flag.rolloutPercent),
    allowIdsText: flag.allowIds.join('\n'),
    description: flag.description,
  })
  const [formError, setFormError] = useState('')
  const [pending, setPending] = useState<{ patch: FlagPatch; changes: string[] } | null>(null)
  const [saving, setSaving] = useState(false)

  const [resetOpen, setResetOpen] = useState(false)
  const [resetting, setResetting] = useState(false)

  const [subject, setSubject] = useState('')
  const [preview, setPreview] = useState<FlagEvaluation | null>(null)
  const [previewError, setPreviewError] = useState('')
  const [previewing, setPreviewing] = useState(false)

  const openEdit = () => {
    setForm({
      enabled: flag.enabled,
      rolloutPercent: String(flag.rolloutPercent),
      allowIdsText: flag.allowIds.join('\n'),
      description: flag.description,
    })
    setFormError('')
    setEditOpen(true)
  }

  const submitForm = () => {
    const rolloutPercent = Number(form.rolloutPercent)
    const allowIds = parseAllowIds(form.allowIdsText)

    if (!Number.isInteger(rolloutPercent) || rolloutPercent < 0 || rolloutPercent > 100) {
      setFormError('放量比例必须是 0 - 100 之间的整数')
      return
    }
    if (allowIds.length > ALLOW_IDS_MAX) {
      setFormError(`白名单最多 ${ALLOW_IDS_MAX} 项，当前 ${allowIds.length} 项`)
      return
    }
    const tooLong = allowIds.find((id) => id.length > ALLOW_ID_MAX)
    if (tooLong) {
      setFormError(`白名单里每一项最多 ${ALLOW_ID_MAX} 个字符：「${tooLong.slice(0, 20)}…」超长了`)
      return
    }
    if (form.description.trim().length > DESCRIPTION_MAX) {
      setFormError(`说明不能超过 ${DESCRIPTION_MAX} 个字`)
      return
    }

    const next: FlagForm = { ...form, description: form.description.trim() }
    const changes = buildChanges(flag, next)
    if (changes.length === 0) {
      toast.info('没有任何改动')
      return
    }

    setFormError('')
    setPending({
      changes,
      patch: {
        enabled: next.enabled,
        rolloutPercent,
        allowIds,
        description: next.description,
      },
    })
  }

  const applyPatch = async () => {
    if (!pending) return
    setSaving(true)
    try {
      await api.flags.update(flag.key, pending.patch)
      toast.success(`已更新「${flag.label}」`)
      setPending(null)
      setEditOpen(false)
      onSaved()
    } catch (err: unknown) {
      toast.error(errorMessageOf(err, '保存失败，请稍后重试'))
      console.error('更新灰度开关失败：', err)
    } finally {
      setSaving(false)
    }
  }

  const confirmReset = async () => {
    setResetting(true)
    try {
      await api.flags.reset(flag.key)
      toast.success(`「${flag.label}」已恢复代码默认值`)
      setResetOpen(false)
      onSaved()
    } catch (err: unknown) {
      toast.error(errorMessageOf(err, '恢复默认失败，请稍后重试'))
      console.error('恢复灰度开关默认失败：', err)
    } finally {
      setResetting(false)
    }
  }

  const runPreview = async () => {
    setPreviewing(true)
    setPreviewError('')
    try {
      const res = await api.flags.preview(flag.key, subject.trim())
      setPreview(res.preview)
    } catch (err: unknown) {
      setPreview(null)
      setPreviewError(errorMessageOf(err, '试算失败，请稍后重试'))
      console.error('试算灰度开关失败：', err)
    } finally {
      setPreviewing(false)
    }
  }

  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium text-foreground">{flag.label}</span>
              <ToneBadge tone={flag.enabled ? 'green' : 'gray'}>{flag.enabled ? '已启用' : '已停用'}</ToneBadge>
              <ToneBadge tone={flag.usingDefaults ? 'blue' : 'amber'}>
                {flag.usingDefaults ? '当前是代码默认值' : '已被改动'}
              </ToneBadge>
              <ToneBadge tone="gray">{BUCKET_LABELS[flag.bucket]}放量</ToneBadge>
            </div>
            <div className="mt-1 font-mono text-[11px] text-muted-foreground">{flag.key}</div>
            <p className="mt-1 text-xs text-muted-foreground">{flag.description}</p>
          </div>
          <div className="flex shrink-0 gap-1">
            <Button variant="outline" size="sm" onClick={openEdit}>
              <Save className="h-3.5 w-3.5" />
              调整
            </Button>
            <Button variant="outline" size="sm" disabled={flag.usingDefaults} onClick={() => setResetOpen(true)}>
              <RotateCcw className="h-3.5 w-3.5" />
              恢复默认
            </Button>
          </div>
        </div>

        <div className="grid gap-3 text-xs sm:grid-cols-2 lg:grid-cols-4">
          <div className="rounded-lg bg-muted p-2">
            <div className="text-muted-foreground">放量比例</div>
            <div className="tabular-nums text-foreground">{flag.rolloutPercent}%</div>
          </div>
          <div className="rounded-lg bg-muted p-2">
            <div className="text-muted-foreground">白名单</div>
            <div className="text-foreground">
              {flag.allowIds.length > 0 ? `${flag.allowIds.length} 项` : '无（不额外放行）'}
            </div>
          </div>
          <div className="rounded-lg bg-muted p-2">
            <div className="text-muted-foreground">最近修改</div>
            <div className="text-foreground">
              {updatedByText(flag)}
              {flag.updatedAt ? <div className="text-[11px]">{formatDateTime(flag.updatedAt)}</div> : null}
            </div>
          </div>
          <div className="rounded-lg bg-muted p-2">
            <div className="text-muted-foreground">接入位置</div>
            <div className="font-mono text-[11px] text-foreground">{flag.wiredAt}</div>
          </div>
        </div>

        <div className="rounded-lg border border-dashed p-3 text-xs">
          <div className="mb-1 text-muted-foreground">当前规则（人话）</div>
          <p className="text-foreground">{flagRuleText(flag)}</p>
        </div>

        {flag.allowIds.length > 0 ? (
          <div className="text-xs text-muted-foreground">
            <span className="mr-1">名单：</span>
            <span className="font-mono">{flag.allowIds.join('、')}</span>
          </div>
        ) : null}

        <div className="rounded-lg border p-3">
          <div className="mb-2 text-xs text-muted-foreground">
            试算：{subjectHint(flag)}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              className="h-8 w-56 text-xs"
              placeholder={flag.bucket === 'device' ? '设备 id' : '账号 id（如 123）'}
              value={subject}
              onChange={(e) => {
                setSubject(e.target.value)
                setPreview(null)
                setPreviewError('')
              }}
            />
            <Button variant="outline" size="sm" onClick={runPreview} disabled={previewing}>
              {previewing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Search className="h-3.5 w-3.5" />}
              试算
            </Button>
            {subject.trim() && flag.bucket !== 'none' ? null : (
              <span className="text-[11px] text-muted-foreground">留空也能试算（等于「没有试算对象」）</span>
            )}
          </div>

          {previewError ? <p className="mt-2 text-xs text-destructive">{previewError}</p> : null}

          {preview ? (
            <div className="mt-2 space-y-1 rounded-lg bg-muted p-3 text-xs">
              <div className="flex items-center gap-2">
                <ToneBadge tone={preview.hit ? 'green' : 'gray'}>{preview.hit ? '命中' : '未命中'}</ToneBadge>
                <span className="font-mono text-[11px] text-muted-foreground">{preview.reason}</span>
                {preview.usingDefaults ? <ToneBadge tone="blue">按代码默认值求值</ToneBadge> : null}
              </div>
              <div className="text-foreground">{preview.reasonText}</div>
            </div>
          ) : null}
        </div>
      </CardContent>

      <Dialog open={editOpen} onOpenChange={(open) => (!open ? setEditOpen(false) : null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>调整开关：{flag.label}</DialogTitle>
            <DialogDescription>改动会在确认后立即生效；下游是按 key 现算的，不需要重启服务。</DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="h-4 w-4 accent-[#07c160]"
                checked={form.enabled}
                onChange={(e) => setForm((prev) => ({ ...prev, enabled: e.target.checked }))}
              />
              启用（停用后所有对象都不命中，白名单也不例外）
            </label>

            <label className="block space-y-1">
              <span className="text-xs text-muted-foreground">
                放量比例（0-100 整数）{flag.bucket === 'none' ? ' —— 全局开关不按比例放量，这个值不参与判断' : ''}
              </span>
              <Input
                value={form.rolloutPercent}
                inputMode="numeric"
                disabled={flag.bucket === 'none'}
                onChange={(e) =>
                  setForm((prev) => ({ ...prev, rolloutPercent: e.target.value.replace(/[^\d]/g, '') }))
                }
              />
            </label>

            <label className="block space-y-1">
              <span className="text-xs text-muted-foreground">
                白名单（每行一个或逗号分隔，最多 {ALLOW_IDS_MAX} 项、每项 {ALLOW_ID_MAX} 字）
                {flag.bucket === 'none' ? ' —— 全局开关不看白名单' : ''}
              </span>
              <Textarea
                rows={3}
                value={form.allowIdsText}
                disabled={flag.bucket === 'none'}
                onChange={(e) => setForm((prev) => ({ ...prev, allowIdsText: e.target.value }))}
              />
            </label>

            <label className="block space-y-1">
              <span className="text-xs text-muted-foreground">说明（最多 {DESCRIPTION_MAX} 字）</span>
              <Textarea
                rows={2}
                maxLength={DESCRIPTION_MAX}
                value={form.description}
                onChange={(e) => setForm((prev) => ({ ...prev, description: e.target.value }))}
              />
            </label>

            {formError ? <p className="text-xs text-destructive">{formError}</p> : null}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setEditOpen(false)} disabled={saving}>
              取消
            </Button>
            <Button onClick={submitForm} disabled={saving}>
              下一步：确认改动
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 二次确认：改动前把「改了什么」逐条列出来，避免把放量比例从 20% 打成 2% 还不知道 */}
      <ConfirmDialog
        open={Boolean(pending)}
        onOpenChange={(open) => (!open ? setPending(null) : null)}
        title="确认修改灰度开关"
        description={`将修改「${flag.label}」（${flag.key}）：`}
        confirmText="确认修改"
        destructive={false}
        loading={saving}
        onConfirm={applyPatch}
      >
        {pending ? (
          <ul className="list-inside list-disc space-y-1 rounded-lg bg-muted p-3 text-xs text-foreground">
            {pending.changes.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        ) : null}
      </ConfirmDialog>

      <ConfirmDialog
        open={resetOpen}
        onOpenChange={(open) => (!open ? setResetOpen(false) : null)}
        title="恢复代码默认值"
        description={`将删除「${flag.label}」在数据库里的这条灰度配置，恢复为代码里写的默认开关与比例。`}
        confirmText="恢复默认"
        loading={resetting}
        onConfirm={confirmReset}
      />
    </Card>
  )
}

/**
 * 灰度开关。
 *
 * 开关是**代码白名单**：能出现哪些 key 由 `flags.constants.ts` 决定，界面只能改
 * 口径、不能新增或删除 —— 所以这里没有「新建开关」按钮。
 */
export default function FlagsPage() {
  const { data, loading, error, reload: load } = useAsyncData(() => api.flags.list(), { deps: [] })
  const flags = data?.flags ?? []

  return (
    <div>
      <PageHeader
        title="灰度开关"
        description="按 key 的实时灰度配置：开关、放量比例、白名单。开关清单来自代码，界面只能改口径，不能新增或删除。"
        actions={
          <Button variant="outline" size="sm" onClick={load} disabled={loading}>
            {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            刷新
          </Button>
        }
      />

      <Card className="mb-3">
        <CardContent className="p-4 text-xs text-muted-foreground">
          共 <span className="text-foreground">{flags.length}</span> 个开关，全部由代码定义（白名单）。
          这里改的是全局百分比 + 白名单两层，<span className="text-foreground">没有</span>按地区 /
          版本 / 时间窗的多维放量；求值是每次请求现算的哈希分桶，不是预生成的名单。
        </CardContent>
      </Card>

      <DataState
        loading={loading && !data}
        error={error}
        empty={flags.length === 0}
        emptyText="代码里没有定义任何灰度开关"
        onRetry={load}
      >
        <div className="space-y-3">
          {flags.map((flag) => (
            <FlagCard key={flag.key} flag={flag} onSaved={load} />
          ))}
        </div>
      </DataState>
    </div>
  )
}
