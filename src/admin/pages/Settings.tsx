import { useState } from 'react'
import { toast } from 'sonner'
import { Loader2, LogOut, ShieldCheck } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { api, errorMessageOf, getStoredAdmin, formatDateTime } from '../api'
import { ConfirmDialog } from '../components/ConfirmDialog'
import { PageHeader, ToneBadge } from '../components/ui-kit'
import { useAdminAuth } from '../context/AdminAuthContext'

export default function SettingsPage() {
  const { admin, logout } = useAdminAuth()
  const navigate = useNavigate()
  const [oldPassword, setOldPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [saving, setSaving] = useState(false)
  const [logoutOpen, setLogoutOpen] = useState(false)

  const stored = getStoredAdmin()

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!oldPassword) {
      toast.error('请输入原密码')
      return
    }
    if (newPassword.length < 8) {
      toast.error('新密码至少 8 位')
      return
    }
    if (newPassword !== confirmPassword) {
      toast.error('两次输入的新密码不一致')
      return
    }
    setSaving(true)
    try {
      await api.auth.changePassword(oldPassword, newPassword)
      // 密码变更后旧令牌仍然有效（JWT 无状态），但主动登出更稳妥
      toast.success('密码已修改，请使用新密码重新登录')
      setOldPassword('')
      setNewPassword('')
      setConfirmPassword('')
      logout({ silent: true })
      navigate('/login', { replace: true })
    } catch (error) {
      toast.error(errorMessageOf(error, '修改密码失败'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div>
      <PageHeader title="账号设置" description="查看当前登录身份并修改自己的密码。" />

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">当前身份</CardTitle>
            <CardDescription>后台账号与家长端账号体系完全独立。</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">账号</span>
              <span className="font-mono text-foreground">{admin?.username}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">姓名</span>
              <span className="text-foreground">{admin?.name}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">角色</span>
              <ToneBadge tone={admin?.role === 'super' ? 'purple' : 'gray'}>
                {admin?.role === 'super' ? '超级管理员' : '运营'}
              </ToneBadge>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">最近登录</span>
              <span className="text-foreground">{formatDateTime(stored?.lastLoginAt ?? null)}</span>
            </div>

            <div className="rounded-lg bg-muted p-3 text-xs text-muted-foreground">
              <div className="mb-1 flex items-center gap-1.5 font-medium text-foreground">
                <ShieldCheck className="h-3.5 w-3.5" />
                权限说明
              </div>
              {admin?.role === 'super' ? (
                <p>超级管理员拥有全部权限，包括新建/禁用/删除管理员账号。请务必使用强密码。</p>
              ) : (
                <p>运营账号可以查看平台数据、处置家长账号与设备、维护题库，但无法管理管理员账号。</p>
              )}
            </div>

            <Button variant="outline" className="w-full" onClick={() => setLogoutOpen(true)}>
              <LogOut className="h-4 w-4" />
              退出登录
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">修改密码</CardTitle>
            <CardDescription>修改成功后需要重新登录。</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={onSubmit} className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="old">原密码</Label>
                <Input
                  id="old"
                  type="password"
                  value={oldPassword}
                  onChange={(e) => setOldPassword(e.target.value)}
                  autoComplete="current-password"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="new">新密码</Label>
                <Input
                  id="new"
                  type="password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  placeholder="至少 8 位"
                  autoComplete="new-password"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="confirm">确认新密码</Label>
                <Input
                  id="confirm"
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  autoComplete="new-password"
                />
              </div>
              <Button type="submit" className="w-full" disabled={saving}>
                {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                {saving ? '保存中…' : '保存新密码'}
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>

      <ConfirmDialog
        open={logoutOpen}
        onOpenChange={setLogoutOpen}
        title="退出登录"
        description="退出后需要重新输入账号密码才能进入管理后台。"
        confirmText="退出"
        destructive={false}
        onConfirm={() => {
          setLogoutOpen(false)
          logout()
          navigate('/login', { replace: true })
        }}
      />
    </div>
  )
}
