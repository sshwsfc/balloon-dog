import { NavLink, Outlet, useNavigate } from 'react-router-dom'
import { useState } from 'react'
import {
  Activity,
  BarChart3,
  BookOpen,
  ChevronLeft,
  ClipboardList,
  Cpu,
  KeyRound,
  LogOut,
  Menu,
  MessageSquare,
  Settings,
  ShieldCheck,
  Users,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useAdminAuth } from '../context/AdminAuthContext'
import { cn } from '@/lib/utils'

interface NavItem {
  to: string
  label: string
  icon: typeof BarChart3
  end?: boolean
  /** 仅超级管理员可见 */
  superOnly?: boolean
}

const NAV: NavItem[] = [
  { to: '/', label: '数据看板', icon: BarChart3, end: true },
  { to: '/users', label: '家长账号', icon: Users },
  { to: '/devices', label: '设备管理', icon: Cpu },
  { to: '/commands', label: '指令监控', icon: Activity },
  { to: '/questions', label: '题库管理', icon: BookOpen },
  { to: '/quiz-records', label: '答题记录', icon: ClipboardList },
  { to: '/sms-codes', label: '验证码审计', icon: MessageSquare },
  { to: '/admins', label: '管理员', icon: ShieldCheck, superOnly: true },
  { to: '/logs', label: '操作日志', icon: KeyRound },
  { to: '/settings', label: '账号设置', icon: Settings },
]

/**
 * 管理后台外壳：固定侧栏 + 内容区。
 * 窄屏下侧栏收起为抽屉（后台虽然以桌面为主，但运营偶尔会用平板查看）。
 */
export default function AdminLayout() {
  const { admin, logout, isSuper } = useAdminAuth()
  const navigate = useNavigate()
  const [drawerOpen, setDrawerOpen] = useState(false)

  const items = NAV.filter((item) => !item.superOnly || isSuper)

  const onLogout = () => {
    logout()
    navigate('/login', { replace: true })
  }

  const sidebar = (
    <div className="flex h-full flex-col">
      <div className="flex h-16 shrink-0 items-center gap-2.5 border-b border-border px-5">
        <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-[#07c160] to-[#06a050] text-lg">
          🐕
        </div>
        <div className="leading-tight">
          <div className="text-sm font-semibold text-foreground">气球狗</div>
          <div className="text-xs text-muted-foreground">管理后台</div>
        </div>
      </div>

      <nav className="flex-1 space-y-1 overflow-y-auto p-3">
        {items.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            onClick={() => setDrawerOpen(false)}
            className={({ isActive }) =>
              cn(
                'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                isActive
                  ? 'bg-primary/10 text-primary'
                  : 'text-muted-foreground hover:bg-accent hover:text-foreground',
              )
            }
          >
            <item.icon className="h-4 w-4 shrink-0" />
            {item.label}
          </NavLink>
        ))}
      </nav>

      <div className="shrink-0 border-t border-border p-3">
        <div className="mb-2 px-1">
          <div className="truncate text-sm font-medium text-foreground">{admin?.name || '管理员'}</div>
          <div className="truncate text-xs text-muted-foreground">
            {admin?.username} · {admin?.role === 'super' ? '超级管理员' : '运营'}
          </div>
        </div>
        <Button variant="outline" size="sm" className="w-full" onClick={onLogout}>
          <LogOut className="h-3.5 w-3.5" />
          退出登录
        </Button>
      </div>
    </div>
  )

  return (
    <div className="admin-shell min-h-screen bg-background">
      {/* 桌面端固定侧栏 */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-60 border-r border-border bg-card lg:block">
        {sidebar}
      </aside>

      {/* 移动端抽屉 */}
      {drawerOpen ? (
        <div className="fixed inset-0 z-40 lg:hidden">
          <button
            type="button"
            aria-label="关闭菜单"
            className="absolute inset-0 bg-black/40"
            onClick={() => setDrawerOpen(false)}
          />
          <aside className="absolute inset-y-0 left-0 w-64 border-r border-border bg-card">{sidebar}</aside>
        </div>
      ) : null}

      <div className="flex min-h-screen flex-col lg:pl-60">
        <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-border bg-card/95 px-4 backdrop-blur lg:hidden">
          <Button variant="ghost" size="icon" onClick={() => setDrawerOpen((v) => !v)} aria-label="打开菜单">
            {drawerOpen ? <ChevronLeft className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </Button>
          <span className="font-semibold text-foreground">气球狗管理后台</span>
        </header>

        <main className="flex-1 p-4 lg:p-8">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
