import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom'
import { HomePage } from './pages/HomePage'
import { LocationPage } from './pages/LocationPage'
import { ProfilePage } from './pages/ProfilePage'
import { QuizUnlockPage } from './pages/QuizUnlockPage'
import { SchedulePage } from './pages/SchedulePage'
import { LoginPage } from './pages/LoginPage'
import { DeviceManagePage } from './pages/DeviceManagePage'
import { MediaPage } from './pages/MediaPage'
import { InsightsPage } from './pages/InsightsPage'
import { ModePage } from './pages/ModePage'
import { ModeSchedulePage } from './pages/ModeSchedulePage'
import { ModeAppsPage } from './pages/ModeAppsPage'
import { EyeCarePage } from './pages/EyeCarePage'
import { AppPluginsPage } from './pages/AppPluginsPage'
import { AppPluginDetailPage } from './pages/AppPluginDetailPage'
import { AppAuditPage } from './pages/AppAuditPage'
import { BottomNav, SIDEBAR_WIDTH_CLASS } from './components/BottomNav'
import { ErrorBoundary } from './components/ErrorBoundary'
import { Toaster } from 'sonner'
import { AuthProvider, useAuth } from './contexts/AuthContext'

function LoadingScreen() {
  return (
    <div className="min-h-screen bg-gray-100 flex items-center justify-center">
      <div className="text-center">
        <div className="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-[#07c160]" />
        <p className="mt-2 text-gray-500 text-sm">加载中...</p>
      </div>
    </div>
  )
}

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth()
  if (loading) return <LoadingScreen />
  if (!user) return <Navigate to="/login" replace />
  return <>{children}</>
}

/**
 * 主框架。
 *
 * 修正点：BottomNav 原本渲染在 <Routes> 外层，登录页也会浮出底部导航
 * （点击只会被守卫弹回登录页）。现在按路由决定是否显示。
 */
function AppShell() {
  const location = useLocation()
  const { user } = useAuth()
  // 登录页、答题页都是沉浸式页面，不显示底部导航
  const hideNavPaths = ['/login', '/quiz-unlock', '/media']
  const showNav = Boolean(user) && !hideNavPaths.includes(location.pathname)

  return (
    <div className="min-h-screen bg-gray-100">
      {/* 宽屏下底部导航变成左侧栏，主内容要让出侧栏的宽度。
          只在「确实有导航」时让位，否则登录页/沉浸式页面会平白缩进一条。 */}
      <div className={showNav ? SIDEBAR_WIDTH_CLASS : undefined}>
        <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route
          path="/"
          element={
            <ProtectedRoute>
              <HomePage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/location"
          element={
            <ProtectedRoute>
              <LocationPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/profile"
          element={
            <ProtectedRoute>
              <ProfilePage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/quiz-unlock"
          element={
            <ProtectedRoute>
              <QuizUnlockPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/devices"
          element={
            <ProtectedRoute>
              <DeviceManagePage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/media"
          element={
            <ProtectedRoute>
              <MediaPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/schedule"
          element={
            <ProtectedRoute>
              <SchedulePage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/insights"
          element={
            <ProtectedRoute>
              <InsightsPage />
            </ProtectedRoute>
          }
        />
        {/* 模式切换：三态选择 / 时段规划 / 应用白名单 */}
        <Route
          path="/mode"
          element={
            <ProtectedRoute>
              <ModePage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/mode/schedule"
          element={
            <ProtectedRoute>
              <ModeSchedulePage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/mode/apps"
          element={
            <ProtectedRoute>
              <ModeAppsPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/eye-care"
          element={
            <ProtectedRoute>
              <EyeCarePage />
            </ProtectedRoute>
          }
        />
        {/* 插件管理：卡片列表 + 单个应用的插件清单 */}
        <Route
          path="/app-plugins"
          element={
            <ProtectedRoute>
              <AppPluginsPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/app-plugins/:packageName"
          element={
            <ProtectedRoute>
              <AppPluginDetailPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/app-audit"
          element={
            <ProtectedRoute>
              <AppAuditPage />
            </ProtectedRoute>
          }
        />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </div>
      {showNav && <BottomNav />}
      <Toaster position="top-center" richColors />
    </div>
  )
}

function App() {
  return (
    <ErrorBoundary>
      <AuthProvider>
        <BrowserRouter>
          <AppShell />
        </BrowserRouter>
      </AuthProvider>
    </ErrorBoundary>
  )
}

export default App
