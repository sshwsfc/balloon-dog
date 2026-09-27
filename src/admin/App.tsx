import { Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { useAdminAuth } from './context/AdminAuthContext'
import AdminLayout from './components/AdminLayout'
import LoginPage from './pages/Login'
import DashboardPage from './pages/Dashboard'
import UserManagePage from './pages/UserManage'
import DeviceManagePage from './pages/DeviceManage'
import CommandMonitorPage from './pages/CommandMonitor'
import QuestionManagePage from './pages/QuestionManage'
import QuizRecordPage from './pages/QuizRecords'
import SmsAuditPage from './pages/SmsAudit'
import AdminManagePage from './pages/AdminManage'
import OperationLogPage from './pages/OperationLogs'
import SettingsPage from './pages/Settings'
import { Loader2 } from 'lucide-react'

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { admin, loading } = useAdminAuth()
  const location = useLocation()

  if (loading) {
    return (
      <div className="admin-shell flex min-h-screen items-center justify-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        正在校验登录状态…
      </div>
    )
  }
  if (!admin) {
    // 记住来路，登录后回跳
    return <Navigate to="/login" replace state={{ from: location.pathname }} />
  }
  return <>{children}</>
}

/** 仅超级管理员可访问的路由（如管理员账号管理）。 */
function SuperOnlyRoute({ children }: { children: React.ReactNode }) {
  const { isSuper } = useAdminAuth()
  if (!isSuper) return <Navigate to="/" replace />
  return <>{children}</>
}

export default function AdminApp() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route
        path="/"
        element={
          <ProtectedRoute>
            <AdminLayout />
          </ProtectedRoute>
        }
      >
        <Route index element={<DashboardPage />} />
        <Route path="users" element={<UserManagePage />} />
        <Route path="devices" element={<DeviceManagePage />} />
        <Route path="commands" element={<CommandMonitorPage />} />
        <Route path="questions" element={<QuestionManagePage />} />
        <Route path="quiz-records" element={<QuizRecordPage />} />
        <Route path="sms-codes" element={<SmsAuditPage />} />
        <Route
          path="admins"
          element={
            <SuperOnlyRoute>
              <AdminManagePage />
            </SuperOnlyRoute>
          }
        />
        <Route path="logs" element={<OperationLogPage />} />
        <Route path="settings" element={<SettingsPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}
