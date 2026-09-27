import { useState } from 'react'
import { Navigate, useLocation, useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { Loader2, ShieldCheck } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { useAdminAuth } from '../context/AdminAuthContext'
import { errorMessageOf } from '../api/client'

export default function LoginPage() {
  const { admin, login } = useAdminAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const from = (location.state as { from?: string } | null)?.from || '/'

  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)

  if (admin) return <Navigate to={from} replace />

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!username.trim() || !password) {
      toast.error('请输入账号与密码')
      return
    }
    setSubmitting(true)
    try {
      const me = await login(username.trim(), password)
      toast.success(`欢迎回来，${me.name}`)
      navigate(from, { replace: true })
    } catch (error) {
      toast.error(errorMessageOf(error, '登录失败，请重试'))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="admin-shell flex min-h-screen items-center justify-center bg-gradient-to-br from-[#07c160] to-[#059a4d] p-4">
      <Card className="w-full max-w-sm shadow-xl">
        <CardHeader className="text-center">
          <div className="mx-auto mb-2 flex h-12 w-12 items-center justify-center rounded-2xl bg-white text-2xl shadow">
            🐕
          </div>
          <CardTitle className="text-xl">管理后台登录</CardTitle>
          <CardDescription>气球狗 · 平台运营与安全审计</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="username">管理员账号</Label>
              <Input
                id="username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="admin"
                autoComplete="username"
                autoFocus
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="password">密码</Label>
              <Input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                autoComplete="current-password"
              />
            </div>
            <Button type="submit" className="w-full" disabled={submitting}>
              {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
              {submitting ? '登录中…' : '登录'}
            </Button>
          </form>

          <p className="mt-4 text-center text-xs text-muted-foreground">
            后台与家长端账号体系完全独立，家长账号无法登录此处。
          </p>
        </CardContent>
      </Card>
    </div>
  )
}
