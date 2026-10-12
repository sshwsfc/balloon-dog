import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, Loader2, ScanLine } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

interface ScanCodeDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 扫到的原始字符串（此处就是孩子端的裸绑定码） */
  onResult: (raw: string) => void
}

type ScanPhase = 'starting' | 'scanning' | 'unsupported' | 'denied' | 'failed'

interface DetectedBarcode {
  rawValue: string
}

interface BarcodeDetectorLike {
  detect(source: CanvasImageSource): Promise<DetectedBarcode[]>
}

type BarcodeDetectorCtor = new (options?: { formats?: string[] }) => BarcodeDetectorLike

/**
 * 取浏览器的 BarcodeDetector。
 *
 * 这是「在页面里用摄像头扫码」的唯一无依赖方案，但目前**只有 Chromium 系**
 * 支持（Android Chrome / Edge / 三星浏览器）；iOS Safari 和 Firefox 都没有，
 * 所以拿不到时必须给出可用的退路，而不是转圈。
 */
function getBarcodeDetectorCtor(): BarcodeDetectorCtor | null {
  const ctor = (window as unknown as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector
  return typeof ctor === 'function' ? ctor : null
}

/** 摄像头被拒绝（而不是设备不存在/被占用）时，提示语要不一样。 */
function isPermissionDenied(error: unknown): boolean {
  return (
    error instanceof DOMException &&
    (error.name === 'NotAllowedError' || error.name === 'SecurityError')
  )
}

/**
 * 页面内摄像头扫码。
 *
 * 微信内不会走到这里 —— 那边由 `scanWithWechat()` 直接调起微信自己的扫一扫，
 * 体验和识别率都更好（见 OnboardingPage 的 handleScanClick）。这个对话框是
 * 给「普通浏览器」用的兜底，也是拿不到摄像头时的提示面板。
 */
export function ScanCodeDialog({ open, onOpenChange, onResult }: ScanCodeDialogProps) {
  const { t } = useTranslation()

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ScanLine className="h-4 w-4 text-[#07c160]" />
            {t('扫一扫绑定码')}
          </DialogTitle>
          <DialogDescription>{t('对准孩子端首页绑定码下方的二维码')}</DialogDescription>
        </DialogHeader>

        {/*
          只在打开时挂载：每次打开都是一份全新的 state（phase 初始就是
          'starting'），不必在 effect 里 setState 去「重置」——那会触发级联渲染，
          也会让摄像头还没开就先闪一帧。
        */}
        {open && <ScanBody onClose={() => onOpenChange(false)} onResult={onResult} />}
      </DialogContent>
    </Dialog>
  )
}

function ScanBody({
  onClose,
  onResult,
}: {
  onClose: () => void
  onResult: (raw: string) => void
}) {
  const { t } = useTranslation()
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const timerRef = useRef<number | null>(null)
  // 不支持 BarcodeDetector 的浏览器直接进提示态，连摄像头都不去要权限
  const [phase, setPhase] = useState<ScanPhase>(() =>
    getBarcodeDetectorCtor() ? 'starting' : 'unsupported',
  )
  const [detail, setDetail] = useState('')

  /**
   * onResult 放进 ref。
   *
   * 否则父组件每次渲染都会给出新的函数引用，effect 会把摄像头停掉再重启一遍 ——
   * 表现就是预览画面每隔几秒黑一下。
   */
  const onResultRef = useRef(onResult)
  useEffect(() => {
    onResultRef.current = onResult
  }, [onResult])

  const stopAll = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current)
      timerRef.current = null
    }
    const stream = streamRef.current
    if (stream) {
      // 一定要逐条 stop：只把 video.srcObject 置空，摄像头指示灯不会灭，
      // 用户会以为这个网页还在偷偷拍。
      for (const track of stream.getTracks()) track.stop()
      streamRef.current = null
    }
  }, [])

  useEffect(() => {
    const Ctor = getBarcodeDetectorCtor()
    if (!Ctor) return

    let cancelled = false

    // 注意：所有 setState 都发生在 await 之后（异步回调里），
    // 不能在 effect 体里同步调用 —— 那会触发级联渲染。
    void (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          // ideal 而不是 exact：没有后置摄像头的设备（比如某些平板）也能退到前置
          video: { facingMode: { ideal: 'environment' } },
        })
        if (cancelled) {
          for (const track of stream.getTracks()) track.stop()
          return
        }
        streamRef.current = stream

        const video = videoRef.current
        if (!video) {
          stopAll()
          setPhase('failed')
          setDetail('视频元素未就绪')
          return
        }
        video.srcObject = stream
        await video.play()
        if (cancelled) return
        setPhase('scanning')

        const detector = new Ctor({ formats: ['qr_code'] })
        let busy = false
        timerRef.current = window.setInterval(() => {
          // 上一帧还没解完就跳过这一帧：detect 是异步的，不设防会在低端机上堆积
          if (busy || cancelled) return
          const el = videoRef.current
          if (!el || el.readyState !== el.HAVE_ENOUGH_DATA) return

          busy = true
          detector
            .detect(el)
            .then((codes) => {
              const raw = codes[0]?.rawValue?.trim()
              if (!raw || cancelled) return
              stopAll()
              onResultRef.current(raw)
              onClose()
            })
            .catch(() => undefined)
            .finally(() => {
              busy = false
            })
        }, 350)
      } catch (error) {
        if (cancelled) return
        stopAll()
        setPhase(isPermissionDenied(error) ? 'denied' : 'failed')
        setDetail(error instanceof Error ? error.message : String(error))
      }
    })()

    return () => {
      cancelled = true
      stopAll()
    }
  }, [onClose, stopAll])

  const cameraVisible = phase === 'starting' || phase === 'scanning'

  return (
    <>
      {/* video 始终挂载、只切换可见性：否则「先用别的状态渲染过一帧」时
          ref 还是 null，取到的摄像头流就没地方挂，表现为点了没反应。 */}
      <div className={cameraVisible ? 'relative overflow-hidden rounded-xl bg-black' : 'hidden'}>
        <video ref={videoRef} playsInline muted className="h-64 w-full bg-black object-cover" />
        {phase === 'starting' && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/70 text-white">
            <Loader2 className="h-6 w-6 animate-spin" />
            <p className="text-xs">{t('正在打开摄像头…')}</p>
          </div>
        )}
        {phase === 'scanning' && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <div className="h-40 w-40 rounded-xl border-2 border-[#07c160]/80" />
          </div>
        )}
      </div>

      {phase === 'scanning' && (
        <p className="text-center text-[11px] text-gray-500">
          {t('把二维码放进取景框内，识别到会自动填入。')}
        </p>
      )}

      {phase === 'unsupported' && (
        <div className="space-y-3">
          <div className="flex gap-2.5 rounded-lg border border-amber-200 bg-amber-50 p-3">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
            <p className="text-[11px] leading-relaxed text-amber-800">
              {t('这个浏览器不支持在页面里直接扫码（目前只有安卓 Chrome 等 Chromium 浏览器支持）。可以用微信打开本页后点扫一扫，或者用手机自带的扫一扫／相机扫孩子端的二维码，再把那串绑定码输进来。')}
            </p>
          </div>
          <Button variant="outline" className="w-full" onClick={onClose}>
            {t('手动输入绑定码')}
          </Button>
        </div>
      )}

      {phase === 'denied' && (
        <div className="space-y-3">
          <div className="flex gap-2.5 rounded-lg border border-amber-200 bg-amber-50 p-3">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
            <p className="text-[11px] leading-relaxed text-amber-800">
              {t('没有拿到摄像头权限。请在浏览器的权限设置里允许本页使用摄像头后重试，或者直接手动输入绑定码。')}
            </p>
          </div>
          <Button variant="outline" className="w-full" onClick={onClose}>
            {t('手动输入绑定码')}
          </Button>
        </div>
      )}

      {phase === 'failed' && (
        <div className="space-y-3">
          <div className="flex gap-2.5 rounded-lg border border-amber-200 bg-amber-50 p-3">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
            <p className="text-[11px] leading-relaxed text-amber-800">
              {t('摄像头打开失败，请直接手动输入绑定码。另外摄像头只在 https 或 localhost 下可用，用局域网 http 地址访问会被浏览器拦住。')}
            </p>
          </div>
          {detail && <p className="break-all text-[10px] text-gray-400">{detail}</p>}
          <Button variant="outline" className="w-full" onClick={onClose}>
            {t('手动输入绑定码')}
          </Button>
        </div>
      )}
    </>
  )
}
