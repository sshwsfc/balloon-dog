import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { toast } from 'sonner'
import { ArrowLeft, Camera, Download, Mic, RefreshCw, Trash2, Video } from 'lucide-react'
import { api, toUserMessage } from '@/services/api'
import type { MediaAsset, MediaKind } from '@/types'

const KIND_LABEL: Record<MediaKind, string> = {
  photo: '照片',
  screenshot: '屏幕截图',
  video: '录像',
  audio: '录音',
}

const FILTERS: { key: '' | MediaKind; label: string }[] = [
  { key: '', label: '全部' },
  { key: 'photo', label: '照片' },
  { key: 'screenshot', label: '截图' },
  { key: 'video', label: '录像' },
  { key: 'audio', label: '录音' },
]

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/**
 * 设备媒体页。
 *
 * 后端返回的 `url` 是带短时效签名的地址（`<img>` 无法携带 Authorization 头），
 * 因此可以直接放进 src；签名过期后刷新页面即可重新签发。
 */
export function MediaPage() {
  const navigate = useNavigate()
  const [media, setMedia] = useState<MediaAsset[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<'' | MediaKind>('')
  const [preview, setPreview] = useState<MediaAsset | null>(null)
  const [removeTarget, setRemoveTarget] = useState<MediaAsset | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await api.getMedia({ limit: 100 })
      setMedia(res.media ?? [])
      setError(null)
    } catch (err) {
      setError(toUserMessage(err, '加载媒体文件失败'))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const handleRemove = async () => {
    if (!removeTarget) return
    try {
      await api.deleteMedia(removeTarget.id)
      toast.success('已删除')
      setRemoveTarget(null)
      setPreview(null)
      await load()
    } catch (err) {
      toast.error(toUserMessage(err, '删除失败'))
    }
  }

  const visible = filter ? media.filter((m) => m.kind === filter) : media

  return (
    <div className="min-h-screen bg-gray-100">
      <div className="bg-white px-4 py-4 border-b border-gray-200 flex items-center">
        <Button variant="ghost" size="icon" onClick={() => navigate(-1)} className="mr-2">
          <ArrowLeft className="w-5 h-5" />
        </Button>
        <h1 className="text-xl font-medium text-gray-900 flex-1">设备照片</h1>
        <Button
          variant="ghost"
          size="icon"
          onClick={() => void load()}
          aria-label="刷新"
        >
          <RefreshCw className="w-5 h-5 text-gray-400" />
        </Button>
      </div>

      <div className="px-3 pt-3 flex gap-2 overflow-x-auto">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            onClick={() => setFilter(f.key)}
            className={`px-3 py-1.5 rounded-full text-sm whitespace-nowrap transition-colors ${
              filter === f.key ? 'bg-[#07c160] text-white' : 'bg-white text-gray-600'
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {loading && (
        <div className="py-16 text-center">
          <div className="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-[#07c160]" />
          <p className="mt-2 text-gray-500 text-sm">加载中...</p>
        </div>
      )}

      {!loading && error && (
        <div className="px-6 py-16 text-center">
          <p className="text-gray-700">{error}</p>
          <Button
            className="mt-4 bg-[#07c160] hover:bg-[#06a050]"
            onClick={() => {
              setLoading(true)
              void load()
            }}
          >
            重新加载
          </Button>
        </div>
      )}

      {!loading && !error && (
        <div className="px-3 py-3">
          {visible.length === 0 ? (
            <Card>
              <CardContent className="p-10 text-center">
                <Camera className="w-12 h-12 text-gray-300 mx-auto mb-3" />
                <p className="text-gray-700 font-medium">
                  {filter ? `还没有${KIND_LABEL[filter as MediaKind]}` : '还没有任何媒体文件'}
                </p>
                <p className="text-sm text-gray-500 mt-2">
                  在首页开启「远程拍照」并点击该功能，孩子设备回传后就会出现在这里。
                </p>
              </CardContent>
            </Card>
          ) : (
            <div className="grid grid-cols-2 gap-3">
              {visible.map((item) => (
                <Card key={item.id} className="overflow-hidden">
                  <button
                    type="button"
                    className="block w-full text-left"
                    onClick={() => setPreview(item)}
                  >
                    <div className="aspect-square bg-gray-100 flex items-center justify-center overflow-hidden">
                      {item.mimeType.startsWith('image/') ? (
                        <img
                          src={item.url}
                          alt={KIND_LABEL[item.kind]}
                          className="w-full h-full object-cover"
                          loading="lazy"
                        />
                      ) : item.mimeType.startsWith('video/') ? (
                        <Video className="w-10 h-10 text-gray-400" />
                      ) : (
                        <Mic className="w-10 h-10 text-gray-400" />
                      )}
                    </div>
                  </button>
                  <CardContent className="p-2.5">
                    <div className="flex items-center justify-between">
                      <div className="min-w-0">
                        <p className="text-xs font-medium text-gray-900">{KIND_LABEL[item.kind]}</p>
                        <p className="text-[11px] text-gray-400">
                          {new Date(item.createdAt).toLocaleString('zh-CN', {
                            month: '2-digit',
                            day: '2-digit',
                            hour: '2-digit',
                            minute: '2-digit',
                          })}
                          {' · '}
                          {formatSize(item.sizeBytes)}
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => setRemoveTarget(item)}
                        className="text-gray-300 hover:text-red-500 p-1"
                        aria-label="删除"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </div>
      )}

      {/* 预览 */}
      <Dialog open={Boolean(preview)} onOpenChange={(open) => !open && setPreview(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{preview ? KIND_LABEL[preview.kind] : ''}</DialogTitle>
          </DialogHeader>
          {preview && (
            <div className="space-y-3">
              <div className="bg-gray-100 rounded-lg overflow-hidden flex items-center justify-center max-h-[60vh]">
                {preview.mimeType.startsWith('image/') ? (
                  <img src={preview.url} alt={KIND_LABEL[preview.kind]} className="max-h-[60vh] w-auto" />
                ) : preview.mimeType.startsWith('video/') ? (
                  <video src={preview.url} controls className="max-h-[60vh] w-full" />
                ) : (
                  <audio src={preview.url} controls className="w-full p-4" />
                )}
              </div>
              <p className="text-xs text-gray-500">
                采集于 {new Date(preview.createdAt).toLocaleString('zh-CN')} · {formatSize(preview.sizeBytes)}
              </p>
              <p className="text-[11px] text-gray-400">
                访问链接带短时效签名，过期后刷新页面会自动重新签发。
              </p>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setPreview(null)}>
              关闭
            </Button>
            {preview && (
              <a href={preview.url} download className="inline-flex">
                <Button variant="outline">
                  <Download className="w-4 h-4 mr-1" />
                  下载
                </Button>
              </a>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 删除确认 */}
      <Dialog open={Boolean(removeTarget)} onOpenChange={(open) => !open && setRemoveTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>删除媒体文件</DialogTitle>
          </DialogHeader>
          <p className="text-gray-600">
            确定要删除这条{KIND_LABEL[(removeTarget?.kind ?? 'photo') as MediaKind]}吗？删除后无法恢复。
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRemoveTarget(null)}>
              取消
            </Button>
            <Button className="bg-red-500 hover:bg-red-600 text-white" onClick={() => void handleRemove()}>
              删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
