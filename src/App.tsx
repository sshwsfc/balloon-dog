import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom'
import { HomePage } from './pages/HomePage'
import { LocationPage } from './pages/LocationPage'
import { ProfilePage } from './pages/ProfilePage'
import { QuizUnlockPage } from './pages/QuizUnlockPage'
import { SchedulePage } from './pages/SchedulePage'
import { LoginPage } from './pages/LoginPage'
import { OnboardingPage } from './pages/OnboardingPage'
import { DeviceManagePage } from './pages/DeviceManagePage'
import { MemberOnlyPage } from './components/MemberOnlyPage'
import { MediaPage } from './pages/MediaPage'
import { InsightsConfigPage } from './pages/InsightsConfigPage'
import { MembershipPage } from './pages/MembershipPage'
import { ReferralPage } from './pages/ReferralPage'
import { InsightsPage } from './pages/InsightsPage'
import { ModePage } from './pages/ModePage'
import { ModeSchedulePage } from './pages/ModeSchedulePage'
import { ModeAppsPage } from './pages/ModeAppsPage'
import { EyeCarePage } from './pages/EyeCarePage'
import { DeviceHealthPage } from './pages/DeviceHealthPage'
import { NotificationsPage } from './pages/NotificationsPage'
import { TimeRequestsPage } from './pages/TimeRequestsPage'
import { NotificationSettingsPage } from './pages/NotificationSettingsPage'
import { AppPluginsPage } from './pages/AppPluginsPage'
import { AppPluginDetailPage } from './pages/AppPluginDetailPage'
import { AppAuditPage } from './pages/AppAuditPage'
import { ChildrenPage } from './pages/ChildrenPage'
import { PrivacyPage } from './pages/PrivacyPage'
import { SupportPage } from './pages/SupportPage'
import { CallSmsPage } from './pages/CallSmsPage'
import { RemoteHelpPage } from './pages/RemoteHelpPage'
import { BottomNav, SIDEBAR_WIDTH_CLASS } from './components/BottomNav'
import { ErrorBoundary } from './components/ErrorBoundary'
import { Toaster } from 'sonner'
import { AuthProvider, useAuth } from './contexts/AuthContext'
import { DeviceProvider, RequireDevice } from './contexts/DeviceContext'
import { useTranslation } from 'react-i18next'

function LoadingScreen() {
  const { t } = useTranslation()
  return (
    <div className="min-h-screen bg-gray-100 flex items-center justify-center">
      <div className="text-center">
        <div className="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-[#07c160]" />
        <p className="mt-2 text-gray-500 text-sm">{t('加载中...')}</p>
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
  // 订阅语言变化。页面上有一批**模块级**工具函数（formatDateTime / kindLabel 之类）
  // 用的是 i18n 实例的 tt()，它们不会自己触发重渲染；这里让整棵树重渲一次，
  // 那些函数随之用新语言重新求值。切勿删掉这个调用。
  useTranslation()
  // 登录页、答题页都是沉浸式页面，不显示底部导航
  // 引导页是全屏的任务流，不该出现底部导航把「下一步」挤掉
  const hideNavPaths = ['/login', '/quiz-unlock', '/media', '/onboarding']
  const showNav = Boolean(user) && !hideNavPaths.includes(location.pathname)

  return (
    // `.has-nav` 是给固定定位浮层用的（见 FeatureTip）：它们要知道当前有没有导航，
    // 才能决定是「抬到导航之上、让出侧栏」还是「贴底居中」。
    <div className={`min-h-screen bg-gray-100${showNav ? ' has-nav' : ''}`}>
      {/* 宽屏下底部导航变成左侧栏，主内容要让出侧栏的宽度。
          只在「确实有导航」时让位，否则登录页/沉浸式页面会平白缩进一条。 */}
      <div className={showNav ? SIDEBAR_WIDTH_CLASS : undefined}>
        <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route
          path="/onboarding"
          element={
            <ProtectedRoute>
              <OnboardingPage />
            </ProtectedRoute>
          }
        />
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
              <RequireDevice>
                <LocationPage />
            </RequireDevice>
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
              <RequireDevice>
                <QuizUnlockPage />
            </RequireDevice>
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
              <RequireDevice>
                <MemberOnlyPage
                  entitlementKey="remoteMonitor"
                  title="媒体"
                  gateTitle="远程监控是会员功能"
                  gateDescription="开通会员后，可以查看孩子设备上报的照片、截图与录音。"
                >
                  <MediaPage />
                </MemberOnlyPage>
            </RequireDevice>
            </ProtectedRoute>
          }
        />
        <Route
          path="/schedule"
          element={
            <ProtectedRoute>
              <RequireDevice>
                <SchedulePage />
            </RequireDevice>
            </ProtectedRoute>
          }
        />
        <Route
          path="/insights"
          element={
            <ProtectedRoute>
              <RequireDevice>
                <InsightsPage />
            </RequireDevice>
            </ProtectedRoute>
          }
        />
        {/*
          会员中心。**故意不套 RequireDevice**：绑设备属于会员权益，
          但充值本身不能要求先绑设备，否则新用户会卡在「先绑设备才能买会员、
          买会员才能绑第二台设备」的死循环里。
        */}
        <Route
          path="/membership"
          element={
            <ProtectedRoute>
              <MembershipPage />
            </ProtectedRoute>
          }
        />
        {/*
          邀请返现。同样不套 RequireDevice：分享提成是「拉新」动作，
          新账号还没绑设备时就应该能拿到自己的邀请码和链接。
        */}
        <Route
          path="/referral"
          element={
            <ProtectedRoute>
              <ReferralPage />
            </ProtectedRoute>
          }
        />
        {/* 洞察配置独立成页；入口是洞察页标题栏的「配置」按钮 */}
        <Route
          path="/insights/config"
          element={
            <ProtectedRoute>
              <RequireDevice>
                <InsightsConfigPage />
            </RequireDevice>
            </ProtectedRoute>
          }
        />
        {/* 模式切换：三态选择 / 时段规划 / 应用白名单 */}
        <Route
          path="/mode"
          element={
            <ProtectedRoute>
              <RequireDevice>
                <ModePage />
            </RequireDevice>
            </ProtectedRoute>
          }
        />
        <Route
          path="/mode/schedule"
          element={
            <ProtectedRoute>
              <RequireDevice>
                <ModeSchedulePage />
            </RequireDevice>
            </ProtectedRoute>
          }
        />
        <Route
          path="/mode/apps"
          element={
            <ProtectedRoute>
              <RequireDevice>
                <ModeAppsPage />
            </RequireDevice>
            </ProtectedRoute>
          }
        />
        {/* 设备健康：家长端一眼看见孩子端有哪些开关被关掉，并就地发起体检 */}
        <Route
          path="/device-health"
          element={
            <ProtectedRoute>
              <RequireDevice>
                <DeviceHealthPage />
              </RequireDevice>
            </ProtectedRoute>
          }
        />
        {/*
          消息中心：设备失联 / 管控失效 / 进出安全区 / 装应用申请都落到这里。
          刻意**不**包 RequireDevice —— 通知是账号级的，孩子手机掉了、解绑了，
          家长更需要看到之前那条「设备已失联」，而不是被弹回「先绑定设备」。
          通知设置同理。
        */}
        <Route
          path="/notifications"
          element={
            <ProtectedRoute>
              <NotificationsPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/notifications/settings"
          element={
            <ProtectedRoute>
              <NotificationSettingsPage />
            </ProtectedRoute>
          }
        />
        {/*
          孩子档案（§5.2）：档案属于账号，不属于设备 —— 一个还没绑设备的家长也要能先
          把孩子建起来，所以不包 RequireDevice。
        */}
        <Route
          path="/children"
          element={
            <ProtectedRoute>
              <ChildrenPage />
            </ProtectedRoute>
          }
        />
        {/*
          合规与隐私（§5.3）：同意的主体是家长账号，导出与注销删的也是账号，
          与「当前设备」无关 —— 同样只包 ProtectedRoute。
        */}
        <Route
          path="/privacy"
          element={
            <ProtectedRoute>
              <PrivacyPage />
            </ProtectedRoute>
          }
        />
        {/*
          帮助与反馈（§5.5）：工单属于账号，不属于设备 —— 没绑设备的家长也能提问，
          所以同样只包 ProtectedRoute。
        */}
        <Route
          path="/support"
          element={
            <ProtectedRoute>
              <SupportPage />
            </ProtectedRoute>
          }
        />
        {/*
          孩子的申请（§3.1）：批准 = 给当前设备下发一段使用时间。
          因此这一页**要**包 RequireDevice —— 没有设备就没有「给谁放行」这回事，
          与账号级的消息中心正相反。
        */}
        <Route
          path="/time-requests"
          element={
            <ProtectedRoute>
              <RequireDevice>
                <TimeRequestsPage />
              </RequireDevice>
            </ProtectedRoute>
          }
        />
        <Route
          path="/eye-care"
          element={
            <ProtectedRoute>
              <RequireDevice>
                <EyeCarePage />
            </RequireDevice>
            </ProtectedRoute>
          }
        />
        {/* 插件管理：卡片列表 + 单个应用的插件清单 */}
        <Route
          path="/app-plugins"
          element={
            <ProtectedRoute>
              <RequireDevice>
                <AppPluginsPage />
            </RequireDevice>
            </ProtectedRoute>
          }
        />
        <Route
          path="/app-plugins/:packageName"
          element={
            <ProtectedRoute>
              <RequireDevice>
                <AppPluginDetailPage />
            </RequireDevice>
            </ProtectedRoute>
          }
        />
        <Route
          path="/app-audit"
          element={
            <ProtectedRoute>
              <RequireDevice>
                <AppAuditPage />
            </RequireDevice>
            </ProtectedRoute>
          }
        />
        {/* 通话与短信：受限权限，列表为空时如实说明原因 */}
        <Route
          path="/call-sms"
          element={
            <ProtectedRoute>
              <RequireDevice>
                <MemberOnlyPage
                  entitlementKey="remoteMonitor"
                  title="通话与短信"
                  gateTitle="通话与短信是会员功能"
                  gateDescription="开通会员后，可以查看孩子设备的通话记录与短信。"
                >
                  <CallSmsPage />
                </MemberOnlyPage>
            </RequireDevice>
            </ProtectedRoute>
          }
        />
        {/* 远程协助：远程操作 + 按需取屏，不是实时投屏 */}
        <Route
          path="/remote-help"
          element={
            <ProtectedRoute>
              <RequireDevice>
                <MemberOnlyPage
                  entitlementKey="remoteMonitor"
                  title="远程协助"
                  gateTitle="远程协助是会员功能"
                  gateDescription="开通会员后，可以通过远程协助帮孩子操作手机。"
                >
                  <RemoteHelpPage />
                </MemberOnlyPage>
            </RequireDevice>
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
        <DeviceProvider>
          <BrowserRouter>
            <AppShell />
          </BrowserRouter>
        </DeviceProvider>
      </AuthProvider>
    </ErrorBoundary>
  )
}

export default App
