import { useTranslation } from 'react-i18next'
import { QRCodeSVG } from 'qrcode.react'

interface QrBlockProps {
  /** 编码进二维码的原始内容 */
  value: string
  /** 二维码上方的说明（中文原文，组件内走 t()） */
  caption: string
  /** 二维码下方的补充说明 */
  hint?: string
  /** 展示边长（px） */
  size?: number
}

/**
 * 展示一个二维码，供**另一台手机**扫描。
 *
 * 用 SVG 而不是 Canvas：SVG 跟着容器缩放不会糊，平板或大屏上给家长看时更清楚，
 * 也省掉了 canvas 在高 DPI 屏上按 CSS 尺寸拉伸导致的模糊。
 *
 * `marginSize`（静区）留 2 个模块、并额外套一层白底容器，都是刻意的：扫码器靠
 * 二维码四角的定位图案找边界，静区不足、或背景不是浅色时，很多机型会直接扫不出来 ——
 * 所以不能让二维码直接坐在页面的灰色背景上。
 * 纠错级别取 M（约 15% 容错）：L 太脆，Q/H 会把码点挤得更密，M 在手机屏上最稳。
 */
export function QrBlock({ value, caption, hint, size = 200 }: QrBlockProps) {
  const { t } = useTranslation()

  return (
    <div className="flex flex-col items-center">
      <p className="text-xs font-medium text-gray-900">{t(caption)}</p>
      <div className="mt-3 rounded-xl bg-white p-3 ring-1 ring-gray-200">
        <QRCodeSVG value={value} size={size} level="M" marginSize={2} title={t(caption)} />
      </div>
      {hint && (
        <p className="mt-3 text-center text-[11px] leading-relaxed text-gray-500">{t(hint)}</p>
      )}
    </div>
  )
}
