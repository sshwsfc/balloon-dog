import type { ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

/**
 * 危险操作确认弹窗。
 * 基于项目已有的 Dialog 实现，不引入新的 Radix 依赖。
 * `requireText` 用于「删除账号」这类不可逆操作：必须原样输入指定文本才能确认。
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmText = '确认',
  cancelText = '取消',
  destructive = true,
  loading = false,
  requireText,
  typedText = '',
  onTypedTextChange,
  onConfirm,
  children,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description?: ReactNode
  confirmText?: string
  cancelText?: string
  destructive?: boolean
  loading?: boolean
  /** 需要用户输入的确认文本（如设备名）；提供时输入不匹配则禁用确认按钮 */
  requireText?: string
  typedText?: string
  onTypedTextChange?: (value: string) => void
  onConfirm: () => void
  children?: ReactNode
}) {
  const textOk = !requireText || typedText.trim() === requireText

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>
        {children}
        {requireText ? (
          <div className="space-y-1.5">
            <p className="text-xs text-muted-foreground">
              请输入 <span className="font-mono font-medium text-foreground">{requireText}</span> 以确认：
            </p>
            <input
              value={typedText}
              onChange={(e) => onTypedTextChange?.(e.target.value)}
              className="h-9 w-full rounded-md border border-input bg-card px-3 text-sm focus-visible:border-ring focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              placeholder={requireText}
              autoComplete="off"
            />
          </div>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={loading}>
            {cancelText}
          </Button>
          <Button
            variant={destructive ? 'destructive' : 'default'}
            onClick={onConfirm}
            disabled={loading || !textOk}
          >
            {loading ? '处理中…' : confirmText}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
