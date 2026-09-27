import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { Toaster } from 'sonner'
import { AdminAuthProvider } from './context/AdminAuthContext'
import AdminApp from './App'
import '@/index.css'

/**
 * 管理后台独立入口。
 *
 * 与家长端是两个互不影响的 SPA（同一次 Vite 构建产出两份 HTML）：
 *  - 家长端：index.html + #root
 *  - 后台：  admin/index.html + #admin-root，路由 basename = /admin
 *
 * 分成两个入口而不是给家长端加路由，是为了不让家长端把后台代码打进包里，
 * 也避免家长端任何一次改动意外暴露后台入口。
 */
createRoot(document.getElementById('admin-root')!).render(
  <StrictMode>
    <BrowserRouter basename="/admin">
      <AdminAuthProvider>
        <AdminApp />
        {/* 桌面端用右上角：top-center 会盖住页面标题与描述 */}
        <Toaster position="top-right" richColors closeButton />
      </AdminAuthProvider>
    </BrowserRouter>
  </StrictMode>,
)
