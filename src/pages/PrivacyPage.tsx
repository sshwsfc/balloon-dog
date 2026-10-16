import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { HeaderRefreshButton } from '@/components/HeaderRefreshButton'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { toast } from 'sonner'
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  ChevronDown,
  Download,
  FileText,
  Loader2,
  Lock,
  ShieldCheck,
  Trash2,
} from 'lucide-react'
import { api, toUserMessage } from '@/services/api'
import type { ConsentStatus, DeletionStatus, PrivacyCatalog, PrivacyDoc } from '@/types'
import { formatDateTime } from '@/lib/format'
import { useTranslation } from 'react-i18next'

/**
 * 合规与隐私（规划 §5.3）：同意留痕、最小必要采集说明、数据导出、注销账号。
 *
 * 这一页刻意不做成「一屏法务文本 + 一个同意勾选框」，因为那样的合规是假的：
 *
 *  1. **同意要落到「哪一版」**。服务端下发版本号，客户端带着版本号回来；
 *     文本改一个字就换版本号，旧版同意会自动变成「需要重新同意」。
 *  2. **撤回不是状态位**。撤回会立刻删除设备记录、停止监控，所以要求密码 +
 *     手动打一句确认文字 —— 顺手点一下就把孩子的守护关掉是不可接受的。
 *  3. **采集清单来自服务端唯一一份**（`COLLECTION_CATALOG`），界面不自己抄一遍。
 *     抄一份的下场是：代码改了清单没改，于是对外承诺的保留期限变成假话。
 *  4. **注销有 7 天冷静期**，界面上把「现在立刻发生什么」与「到期发生什么」分开写清楚。
 */

export function PrivacyPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()

  const [catalog, setCatalog] = useState<PrivacyCatalog | null>(null)
  const [consents, setConsents] = useState<ConsentStatus[]>([])
  const [deletion, setDeletion] = useState<DeletionStatus | null>(null)
  const [loading, setLoading] = useState(true)

  /** 正在阅读的那份文本（阅读后同意） */
  const [reading, setReading] = useState<PrivacyDoc | null>(null)
  /** 正在撤回的那份同意 */
  const [revoking, setRevoking] = useState<ConsentStatus | null>(null)
  const [revokePassword, setRevokePassword] = useState('')
  const [revokeConfirm, setRevokeConfirm] = useState('')
  /** 注销表单 */
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [deletePassword, setDeletePassword] = useState('')
  const [deleteConfirm, setDeleteConfirm] = useState('')

  const [busy, setBusy] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [showCollection, setShowCollection] = useState(false)

  const load = useCallback(
    () =>
      Promise.all([api.getPrivacyDocs(), api.getPrivacyConsents(), api.getDeletionStatus()])
        .then(([docs, mine, status]) => {
          setCatalog(docs)
          setConsents(mine.consents)
          setDeletion(status.deletion)
        })
        .catch((error: unknown) => {
          toast.error(toUserMessage(error, t('加载合规信息失败')))
        })
        .finally(() => {
          setLoading(false)
        }),
    [t],
  )

  useEffect(() => {
    void load()
  }, [load])

  const accept = async (doc: PrivacyDoc) => {
    setBusy(true)
    try {
      await api.acceptPrivacyConsent({ docType: doc.docType, docVersion: doc.version })
      setReading(null)
      toast.success(t('已记录你的同意（版本 {{v0}}）', { v0: doc.version }))
      await load()
    } catch (error: unknown) {
      toast.error(toUserMessage(error, t('同意失败，请稍后重试')))
    } finally {
      setBusy(false)
    }
  }

  const revoke = async () => {
    if (!revoking?.record) return
    setBusy(true)
    try {
      const result = await api.revokePrivacyConsent(revoking.record.id, {
        password: revokePassword,
        confirm: revokeConfirm.trim(),
      })
      setRevoking(null)
      setRevokePassword('')
      setRevokeConfirm('')
      toast.success(
        result.stoppedMonitoring
          ? t('已停止监控，{{v0}} 台设备的记录已删除', { v0: result.unboundDevices })
          : t('已撤回同意'),
      )
      await load()
    } catch (error: unknown) {
      toast.error(toUserMessage(error, t('撤回失败，请稍后重试')))
    } finally {
      setBusy(false)
    }
  }

  const requestDeletion = async () => {
    setBusy(true)
    try {
      const result = await api.requestAccountDeletion({
        password: deletePassword,
        confirm: deleteConfirm.trim(),
      })
      setDeleteOpen(false)
      setDeletePassword('')
      setDeleteConfirm('')
      setDeletion(result.deletion)
      toast.success(t('注销已排期，冷静期内随时可以撤销'))
      await load()
    } catch (error: unknown) {
      toast.error(toUserMessage(error, t('申请注销失败，请稍后重试')))
    } finally {
      setBusy(false)
    }
  }

  const cancelDeletion = async () => {
    setBusy(true)
    try {
      const result = await api.cancelAccountDeletion()
      setDeletion(result.deletion)
      toast.success(t('已撤销注销'))
      await load()
    } catch (error: unknown) {
      toast.error(toUserMessage(error, t('撤销注销失败，请稍后重试')))
    } finally {
      setBusy(false)
    }
  }

  /**
   * 导出 = 真的把文件交给家长。所以走 Blob 下载，而不是「后端说导出成功」了事 ——
   * 拿不到文件的「导出成功」是假合规。
   */
  const exportData = async () => {
    setExporting(true)
    try {
      const data = await api.exportMyData()
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const stamp = data.generatedAt.slice(0, 10)
      const link = document.createElement('a')
      link.href = url
      link.download = `balloon-dog-export-${stamp}.json`
      document.body.appendChild(link)
      link.click()
      document.body.removeChild(link)
      URL.revokeObjectURL(url)
      toast.success(
        t('已导出：设备 {{v0}} 台、孩子 {{v1}} 位、任务 {{v2}} 条', {
          v0: data.devices.length,
          v1: data.children.length,
          v2: data.tasks.length,
        }),
      )
      await load()
    } catch (error: unknown) {
      toast.error(toUserMessage(error, t('导出失败，请稍后重试')))
    } finally {
      setExporting(false)
    }
  }

  const allRequiredAccepted = consents.filter((c) => c.required).every((c) => c.accepted)

  return (
    <div className="page-shell">
      <div className="page-header">
        <div className="flex items-center gap-2">
          <button
            type="button"
            aria-label={t('返回')}
            className="p-2 -ml-2 rounded-full active:bg-gray-100"
            onClick={() => navigate(-1)}
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
          <h1 className="text-lg font-medium flex-1">{t('合规与隐私')}</h1>
          <HeaderRefreshButton onRefresh={() => void load()} />
        </div>
      </div>

      <div className="p-4 space-y-4">
        {loading ? (
          <div className="flex items-center justify-center py-16 text-gray-400">
            <Loader2 className="w-5 h-5 animate-spin mr-2" />
            {t('加载中...')}
          </div>
        ) : (
          <>
            {deletion?.scheduled && (
              <Card className="border-amber-200 bg-amber-50">
                <CardContent className="p-4 space-y-2">
                  <div className="flex items-start gap-2">
                    <AlertTriangle className="w-4 h-4 text-amber-600 mt-0.5 flex-shrink-0" />
                    <div className="text-sm text-amber-900">
                      <p className="font-medium">
                        {t('账号将在 {{v0}} 删除', {
                          v0: deletion.scheduledFor
                            ? formatDateTime(deletion.scheduledFor)
                            : t('7 天后'),
                        })}
                      </p>
                      <p className="mt-1 text-amber-800">{deletion.note}</p>
                    </div>
                  </div>
                  <Button
                    variant="outline"
                    className="w-full"
                    disabled={busy}
                    onClick={() => void cancelDeletion()}
                  >
                    {busy && <Loader2 className="w-4 h-4 animate-spin mr-1" />}
                    {t('撤销注销')}
                  </Button>
                </CardContent>
              </Card>
            )}

            <Card>
              <CardContent className="p-4 space-y-3">
                <div className="flex items-center gap-2">
                  <ShieldCheck className="w-4 h-4 text-[#07c160]" />
                  <h2 className="text-sm font-medium">{t('监护授权与告知')}</h2>
                  {allRequiredAccepted ? (
                    <Badge className="bg-[#07c160]/10 text-[#07c160]">{t('已完成')}</Badge>
                  ) : (
                    <Badge variant="outline" className="text-amber-600 border-amber-300">
                      {t('待同意')}
                    </Badge>
                  )}
                </div>
                <p className="text-xs text-gray-500">
                  {t('文本改动一个字就会换版本号，旧版本的同意会自动变成「需要重新同意」。')}
                </p>

                <div className="space-y-3">
                  {consents.map((item) => (
                    <div key={item.docType} className="border rounded-lg p-3 space-y-2">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="text-sm font-medium truncate">{t(item.title)}</p>
                          <p className="text-xs text-gray-500 mt-0.5">{t('版本 {{v0}}', { v0: item.version })}</p>
                        </div>
                        {item.accepted ? (
                          <Badge className="bg-[#07c160]/10 text-[#07c160] flex-shrink-0">
                            {t('已同意')}
                          </Badge>
                        ) : item.needsReaccept ? (
                          <Badge variant="outline" className="text-amber-600 border-amber-300 flex-shrink-0">
                            {t('需要重新同意')}
                          </Badge>
                        ) : (
                          <Badge variant="outline" className="text-gray-500 flex-shrink-0">
                            {t('未同意')}
                          </Badge>
                        )}
                      </div>

                      {item.record && (
                        <p className="text-xs text-gray-400">
                          {t('同意时间：{{v0}}', { v0: formatDateTime(item.record.acceptedAt) })}
                          {item.history.length > 1
                            ? t('（含 {{v0}} 条历史记录）', { v0: item.history.length - 1 })
                            : ''}
                        </p>
                      )}

                      <div className="flex gap-2">
                        {!item.accepted && (
                          <Button
                            size="sm"
                            className="bg-[#07c160] hover:bg-[#06ad56]"
                            onClick={() => {
                              const doc = catalog?.docs.find((d) => d.docType === item.docType)
                              if (doc) setReading(doc)
                            }}
                          >
                            <Check className="w-4 h-4 mr-1" />
                            {item.needsReaccept ? t('重新阅读并同意') : t('阅读并同意')}
                          </Button>
                        )}
                        {item.accepted && item.record && (
                          <Button
                            size="sm"
                            variant="outline"
                            className="text-red-500 border-red-200"
                            onClick={() => {
                              setRevoking(item)
                              setRevokePassword('')
                              setRevokeConfirm('')
                            }}
                          >
                            {t('撤回同意')}
                          </Button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardContent className="p-4 space-y-3">
                <button
                  type="button"
                  className="w-full flex items-center gap-2"
                  onClick={() => setShowCollection((v) => !v)}
                >
                  <FileText className="w-4 h-4 text-gray-500" />
                  <h2 className="text-sm font-medium flex-1 text-left">{t('我们收集什么、留多久')}</h2>
                  <ChevronDown className={`w-4 h-4 text-gray-400 transition-transform ${showCollection ? 'rotate-180' : ''}`} />
                </button>

                {showCollection && (
                  <div className="space-y-2">
                    {(catalog?.collection ?? []).map((entry) => (
                      <div key={entry.key} className="border rounded-lg p-3">
                        <p className="text-sm font-medium">{t(entry.title)}</p>
                        <p className="text-xs text-gray-500 mt-1">{t(entry.examples)}</p>
                        <p className="text-xs text-gray-500 mt-1">
                          {t('用途')}：{t(entry.purpose)}
                        </p>
                        <p className="text-xs text-gray-500">
                          {t('保存')}：{t(entry.retention)}
                        </p>
                        <p className="text-xs text-gray-400 mt-1">
                          {t('存放位置')}：{t(entry.storedOn)}
                        </p>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardContent className="p-4 space-y-2">
                <h2 className="text-sm font-medium">{t('导出我的数据')}</h2>
                <p className="text-xs text-gray-500">
                  {t('一份 JSON：账号、设备、孩子档案、任务、同意记录、通知、订单等。照片和录屏的**文件本身**不在里面，导出的是元数据。')}
                </p>
                <Button
                  variant="outline"
                  className="w-full"
                  disabled={exporting}
                  onClick={() => void exportData()}
                >
                  {exporting ? (
                    <Loader2 className="w-4 h-4 animate-spin mr-1" />
                  ) : (
                    <Download className="w-4 h-4 mr-1" />
                  )}
                  {t('导出为 JSON 文件')}
                </Button>
              </CardContent>
            </Card>

            <Card className="border-red-100">
              <CardContent className="p-4 space-y-2">
                <div className="flex items-center gap-2">
                  <Trash2 className="w-4 h-4 text-red-500" />
                  <h2 className="text-sm font-medium text-red-600">{t('注销账号')}</h2>
                </div>
                {deletion?.scheduled ? (
                  <p className="text-xs text-gray-500">
                    {t('注销已经排期，到期会真的删除账号与磁盘上的文件。到期前可以撤销。')}
                  </p>
                ) : (
                  <>
                    <p className="text-xs text-gray-500">
                      {t('申请后**立刻**停止监控并删除设备记录；账号数据进入 {{v0}} 天冷静期，到期连同磁盘文件一起删除。', {
                        v0: deletion?.graceDays ?? 7,
                      })}
                    </p>
                    <Button
                      variant="outline"
                      className="w-full text-red-500 border-red-200"
                      onClick={() => {
                        setDeleteOpen(true)
                        setDeletePassword('')
                        setDeleteConfirm('')
                      }}
                    >
                      {t('申请注销')}
                    </Button>
                  </>
                )}
              </CardContent>
            </Card>
          </>
        )}
      </div>

      {/* 阅读并同意 */}
      <Dialog open={Boolean(reading)} onOpenChange={(open) => !open && setReading(null)}>
        <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{reading ? t(reading.title) : ''}</DialogTitle>
            <DialogDescription>
              {reading ? `${t('版本')} ${reading.version}` : ''}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            <p className="text-gray-500">{reading ? t(reading.summary) : ''}</p>
            {(reading?.sections ?? []).map((section) => (
              <div key={section.title}>
                <p className="font-medium">{t(section.title)}</p>
                <p className="text-gray-600 mt-0.5 leading-relaxed">{t(section.body)}</p>
              </div>
            ))}
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setReading(null)}>
              {t('稍后再说')}
            </Button>
            <Button
              className="bg-[#07c160] hover:bg-[#06ad56]"
              disabled={busy || !reading}
              onClick={() => reading && void accept(reading)}
            >
              {busy && <Loader2 className="w-4 h-4 animate-spin mr-1" />}
              {t('我已阅读并同意')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 撤回同意 */}
      <Dialog open={Boolean(revoking)} onOpenChange={(open) => !open && setRevoking(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('撤回同意')}</DialogTitle>
            <DialogDescription>
              {t('撤回会**立刻删除**这个账号下的设备记录（含照片与截屏）并停止监控。账号、孩子档案与订单不受影响。')}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <label className="text-xs text-gray-500">{t('账号密码')}</label>
              <input
                type="password"
                className="w-full border rounded-lg px-3 py-2 mt-1 focus:outline-none focus:border-[#07c160]"
                value={revokePassword}
                placeholder={t('请输入登录密码')}
                onChange={(e) => setRevokePassword(e.target.value)}
              />
            </div>
            <div>
              <label className="text-xs text-gray-500">
                {t('请输入「{{v0}}」以确认', { v0: catalog?.revokeConfirmText ?? '撤回同意' })}
              </label>
              <input
                className="w-full border rounded-lg px-3 py-2 mt-1 focus:outline-none focus:border-[#07c160]"
                value={revokeConfirm}
                placeholder={catalog?.revokeConfirmText ?? '撤回同意'}
                onChange={(e) => setRevokeConfirm(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setRevoking(null)}>
              {t('取消')}
            </Button>
            <Button
              variant="outline"
              className="text-red-500 border-red-200"
              disabled={busy || !revokePassword || revokeConfirm.trim() !== (catalog?.revokeConfirmText ?? '撤回同意')}
              onClick={() => void revoke()}
            >
              {busy && <Loader2 className="w-4 h-4 animate-spin mr-1" />}
              {t('确认撤回')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 申请注销 */}
      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('申请注销账号')}</DialogTitle>
            <DialogDescription>
              {t('现在立刻：停止监控、删除设备记录（含照片与截屏）。{{v0}} 天后：删除账号、孩子档案、订单与磁盘文件。', {
                v0: deletion?.graceDays ?? 7,
              })}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="flex items-start gap-2 text-xs text-amber-700 bg-amber-50 rounded-lg p-3">
              <Lock className="w-4 h-4 mt-0.5 flex-shrink-0" />
              <p>{t('冷静期内可以撤销，但设备记录已经删除 —— 撤销后要重新绑定设备才能恢复监控。')}</p>
            </div>
            <div>
              <label className="text-xs text-gray-500">{t('账号密码')}</label>
              <input
                type="password"
                className="w-full border rounded-lg px-3 py-2 mt-1 focus:outline-none focus:border-[#07c160]"
                value={deletePassword}
                placeholder={t('请输入登录密码')}
                onChange={(e) => setDeletePassword(e.target.value)}
              />
            </div>
            <div>
              <label className="text-xs text-gray-500">
                {t('请输入「{{v0}}」以确认', { v0: catalog?.deletionConfirmText ?? '删除我的账号' })}
              </label>
              <input
                className="w-full border rounded-lg px-3 py-2 mt-1 focus:outline-none focus:border-[#07c160]"
                value={deleteConfirm}
                placeholder={catalog?.deletionConfirmText ?? '删除我的账号'}
                onChange={(e) => setDeleteConfirm(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setDeleteOpen(false)}>
              {t('取消')}
            </Button>
            <Button
              className="bg-red-500 hover:bg-red-600 text-white"
              disabled={busy || !deletePassword || deleteConfirm.trim() !== (catalog?.deletionConfirmText ?? '删除我的账号')}
              onClick={() => void requestDeletion()}
            >
              {busy && <Loader2 className="w-4 h-4 animate-spin mr-1" />}
              {t('确认注销')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
