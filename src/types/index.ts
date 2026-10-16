/**
 * 与后端 `server/` 的接口契约一一对应。
 * 全部来自真实接口返回，不再有 mock 版的重复定义（原 Device 曾在 3 个文件里各写一遍）。
 */

// ============================================================
// 用户
// ============================================================

export interface User {
  id: number
  /** 与 nickname 同值，保留 name 以兼容既有组件 */
  name: string
  nickname: string
  phone: string | null
  email: string | null
  avatar: string
  wechatBound: boolean
  createdAt: string
}

export interface AuthResponse {
  success: boolean
  token: string
  user: User
  isNew?: boolean
}

// ============================================================
// 设备
// ============================================================

export type DeviceStatus = 'online' | 'offline'

export interface Device {
  id: string
  userId: string
  name: string
  model: string
  /** "Android 14" 这类展示用字符串 */
  os: string
  osName: string
  osVersion: string
  avatar: string
  battery: number
  status: DeviceStatus
  /** "5分钟前" 这类中文文案 */
  lastActive: string
  lastActiveAt: string | null
  network: string
  locked: boolean
  /**
   * 是否隐藏孩子设备上的客户端图标（contract §9）。
   * 读：`GET /api/device`；写：`PUT /api/devices/:deviceId { hideIcon }`。
   * 注意：隐藏后**孩子设备上也找不到入口**，只能由家长端远程恢复或 ADB。
   */
  hideIcon: boolean
  /** 临时解锁到期时间（ISO），null 表示未临时解锁 */
  tempUnlock: string | null
  deviceCode: string
  agentVersion: string
  createdAt: string
  /**
   * 在线分级（见 `server/src/features/devices/devices.constants.ts` 的 LIVENESS_*）。
   *
   * 老字段 `status` 只有 online/offline 两档，家长点了指令才知道设备其实是「半小时前
   * 就不动了」。这一档是按 `lastActiveAt` 现算的：online / delayed / offline / lost / never，
   * 配 `livenessLabel` 的中文文案，首页角标与健康页都用它。
   */
  liveness: DeviceLiveness
  livenessLabel: string
  /**
   * 设备列表用的健康摘要（规划 §1.2 的「每台一个健康点」）。
   *
   * **只有列表接口带这三个字段**（`GET /api/devices`），单台设备的接口不带 ——
   * 详情走 `GET /api/device/health`。没上报过健康快照时 `healthLevel` 是 `null`：
   * 列表上画个绿点等于替设备担保，而我们此时什么都不知道。
   */
  healthLevel?: DeviceHealthLevel | null
  openGaps?: number | null
  healthReportedAt?: string | null
  /**
   * 待审批的孩子申请条数（规划 §3.1）。0 是「问过了，没有」，不是「不知道」——
   * 与 healthLevel 的 null 恰好相反，所以这里不给 null。
   */
  pendingTimeRequests?: number
  /**
   * 当前登录家长在这台设备上的角色（规划 §5.1）。
   *
   * `owner` 是绑定的那个账号；`admin`/`viewer` 是被邀请进来的家庭成员。
   * **服务端对每个写请求都会独立校验**，这个字段只用来决定界面画不画写入口 ——
   * 前端不骗人，但它也不是安全边界。
   */
  role?: DeviceRole
  /** 由 role 推出，服务端一起下发；只读成员为 false */
  canWrite?: boolean
  /** 只有设备主人能邀请/移除家庭成员 */
  canManageMembers?: boolean
}

/** 家长对一台设备的角色（规划 §5.1）：主人 / 管理员成员 / 只读成员 */
export type DeviceRole = 'owner' | 'admin' | 'viewer'

/**
 * 家庭成员（规划 §5.1）。
 *
 * 设备主人**不在**这张表里（他是 `ChildDevice.userId`），但接口会把他作为
 * 第一行 `id: 'owner'` 一起返回 —— 只返回成员表的话，界面会出现「设备没有主人」。
 */
export interface DeviceMember {
  id: string
  deviceId: string
  userId: number
  nickname: string
  /** 服务端已打码（138****8000）：成员之间确认是谁就够了，不需要完整号码 */
  phone: string | null
  avatar: string | null
  role: DeviceRole
  /** 「设备主人」/「管理员」/「只读」 */
  roleLabel: string
  isOwner: boolean
  createdAt: string
}

export interface DeviceMemberList {
  members: DeviceMember[]
  roleLabels: Record<string, string>
  limit: number
}

/**
 * 孩子档案（规划 §5.2）。
 *
 * 此前系统里只有设备，「双胞胎的两台手机属于同一个孩子」这件事无法表达。
 * 档案属于**家长账号**（不是设备），设备通过 `childId` 指过来。
 */
export interface Child {
  id: string
  name: string
  /** 出生年份。年龄由服务端现算（`age`），因为存下来的年龄每年都会过期 */
  birthYear: number | null
  age: number | null
  school: string
  avatar: string
  createdAt: string
  devices: ChildDeviceBrief[]
  todayTasks: { total: number; done: number }
}

/** 挂在孩子名下的一台设备（只要列表页要用的几个字段）。 */
export interface ChildDeviceBrief {
  id: string
  name: string
  model: string
  status: string
  locked: boolean
}

/**
 * 今日任务（规划 §5.2）。
 *
 * 挂在**孩子**身上而不是设备上：同一个孩子的两台设备看到同一份清单。
 * `date` 是 `YYYY-MM-DD` 字符串 —— 任务归属哪一天是日历概念，存时刻会被时区拖走。
 */
export interface ChildTask {
  id: string
  childId: string
  title: string
  date: string
  done: boolean
  doneAt: string | null
  createdAt: string
}

/** 在线分级：刚心跳 / 心跳延迟 / 失联 / 严重失联 / 从未连接 */
export type DeviceLiveness = 'online' | 'delayed' | 'offline' | 'lost' | 'never'

/**
 * 设备健康等级。
 *
 * 由**设备端**自己下结论（它能看见真实的系统开关状态），服务端只在老版本没给
 * `level` 时用 `deriveHealthLevel` 兜底推算。
 */
export type DeviceHealthLevel = 'ok' | 'warn' | 'danger'

/** 开关/权限的三态：on/off/granted/denied 是事实，unknown 表示设备还没报过这一项 */
export type DeviceHealthSwitchStatus = 'on' | 'off' | 'unknown'
export type DeviceHealthPermissionStatus = 'granted' | 'denied' | 'unknown'

/** 缺口的严重程度与可修复性（与设备端 `LongevityGuard` 的下发值一一对应） */
export type GapImportance = 'critical' | 'major' | 'minor'
export type GapFixability = 'auto' | 'manual' | 'none'

/** 顶部的「开关一览」：label/why/critical 是服务端的展示元数据，status 才是事实 */
export interface DeviceHealthCheck {
  key: string
  label: string
  /** 一句话解释「这项开着有什么用」，关掉时用来告诉家长后果 */
  why: string
  critical: boolean
  status: DeviceHealthSwitchStatus
}

export interface DeviceHealthPermission {
  key: string
  label: string
  status: DeviceHealthPermissionStatus
  /**
   * 分机型开启步骤（规划 §1.4）。只有 `denied` 且**不是**设备所有者时才有内容：
   * 设备所有者下这些权限是静默自授的，再报 denied 只可能是快照过期。
   */
  fixSteps: string[]
}

/**
 * 一条缺口。`detail` / `fixHint` 是**设备端下发的原文**，家长端不做二次翻译 ——
 * 两边各写一套迟早会出现「设备说无障碍被关、家长端说悬浮窗被关」的矛盾。
 */
export interface DeviceHealthGap {
  id: string
  label: string
  detail: string
  importance: GapImportance
  fixability: GapFixability
  fixHint: string
  /**
   * 分机型修复步骤，服务端按设备 `model` 选好（小米/华为/OPPO/vivo/三星各一套，
   * 认不出品牌给通用步骤）。只有 `fixability === 'manual'` 时非空 ——
   * `auto` 的项点「重新检测」就会自愈，`none` 的项谁都修不了。
   */
  fixSteps: string[]
}

/** `OwnerHardening.audit()` 的原样输出：某一项限制在这台机器上支不支持、有没生效 */
export interface DeviceHealthRestriction {
  id: string
  label: string
  supported: boolean
  applied: boolean
}

/** `GET /api/device/health` 的完整响应 */
export interface DeviceHealth {
  deviceId: string
  deviceName: string
  /** 设备从来没上报过快照时为 false —— 此时页面要说「尚未检测」，不能假装一切正常 */
  reported: boolean
  /** 快照超过 30 分钟没更新：里面的绿灯已经不代表「现在」 */
  stale: boolean
  level: DeviceHealthLevel
  levelLabel: string
  liveness: DeviceLiveness
  livenessLabel: string
  lastActive: string
  lastActiveAt: string | null
  online: boolean
  checks: DeviceHealthCheck[]
  permissions: DeviceHealthPermission[]
  gaps: DeviceHealthGap[]
  summary: {
    openGaps: number
    criticalGaps: number
    autoFixable: number
    manualFixable: number
  }
  restrictions: DeviceHealthRestriction[]
  serviceRunning: boolean
  /** 设备墙钟 − 服务端时间，正数表示设备时间偏快（孩子可能改过时间） */
  clockSkewSeconds: number
  healCount: number
  lastHealAt: string | null
  reportedAt: string | null
  updatedAt: string | null
}

// ============================================================
// 指令队列
// ============================================================

export type CommandStatus =
  | 'pending'
  | 'dispatched'
  | 'succeeded'
  | 'failed'
  | 'expired'
  | 'cancelled'

export interface DeviceCommand {
  id: string
  deviceId: string
  type: string
  /** 中文名，如「锁屏」 */
  label: string
  payload: Record<string, unknown>
  status: CommandStatus
  result: unknown
  error: string
  createdAt: string
  dispatchedAt: string | null
  finishedAt: string | null
  expiresAt: string
}

/** 下发指令的统一响应 */
export interface CommandDispatchResult {
  success: boolean
  command: DeviceCommand | null
  device: Device | null
  /** 设备离线等需要提示给家长的情况 */
  warning?: string
  noop?: boolean
}

// ============================================================
// 功能配置
// ============================================================

export interface ToggleState {
  enabled: boolean
}

/**
 * 单条应用限额（键是应用的展示名）。
 *
 * `dailyLimit` 是每日上限（分钟），`usedTodaySeconds` 是设备上报的「今天已经用了多少秒」
 * （contract §4）。设备端统计依赖 `PACKAGE_USAGE_STATS`，权限没给时设备不报用量，
 * 服务端会把当日值当 0 —— 所以界面上「今日已用 0 分钟」也可能是权限没给，
 * 文案不能把 0 说成「孩子今天没用过」。
 *
 * `packageName` 是设备端真正用来匹配前台窗口的标识（设置限制时必须带上）。
 */
export interface AppLimitEntry {
  dailyLimit: number
  packageName: string
  usedTodaySeconds: number
}

export interface Features {
  lockScreen: { enabled: boolean; locked: boolean }
  tempUnlock: { enabled: boolean; unlockTime: string | null }
  timePlan: { enabled: boolean; dailyLimit: number; usedToday: number }
  appLimit: { enabled: boolean; apps: Record<string, AppLimitEntry> }
  appAudit: { enabled: boolean; pendingApps: string[] }
  webBlock: { enabled: boolean; blockedUrls: string[] }
  quizUnlock: ToggleState
  screenMonitor: ToggleState
  remoteHelp: ToggleState
  callSms: ToggleState
  remotePhoto: ToggleState
  remoteRecord: ToggleState
  videoRecord: ToggleState
  audioRecord: ToggleState
  /** 学习模式 / 普通模式总开关（学习模式下只允许白名单应用） */
  modeSwitch: ToggleState
  /** 连续用眼提醒、强制休息、夜间护眼 */
  eyeCare: ToggleState
  /** 按应用关闭微信 / QQ 等具体功能 */
  appPlugin: ToggleState
}

// ============================================================
// 答题解锁
// ============================================================

export type QuizType = 'english' | 'poetry' | 'random'
export type QuestionBank = 'grade1' | 'grade2' | 'grade3' | 'grade4' | 'grade5' | 'grade6'

export interface QuizConfig {
  enabled: boolean
  quizType: string
  grade: string
  /** 与 grade 同义，保留以兼容既有页面 */
  questionBank: string
  correctRewardMinutes: number
  randomMode: boolean
  deviceId?: string
}

export interface QuizQuestion {
  id: string
  type: string
  grade: string
  question: string
  options: string[]
  /** 预览接口不返回；仅答题判定后返回 */
  correctAnswer?: number
  explanation?: string
}

export interface QuizRecord {
  id: string
  deviceId: string
  questionId: string
  type: string
  question: string
  userAnswer: number
  isCorrect: boolean
  rewardMinutes: number
  timestamp: string
}

export interface QuizTypeStats {
  total: number
  correct: number
  accuracy: number
}

export interface QuizStatistics {
  totalQuestions: number
  correctCount: number
  incorrectCount: number
  accuracyRate: number
  totalRewardMinutes: number
  byType: {
    english: QuizTypeStats
    poetry: QuizTypeStats
    random: QuizTypeStats
    [key: string]: QuizTypeStats
  }
}

export interface QuizAnswerResult {
  success: boolean
  isCorrect: boolean
  rewardMinutes?: number
  correctAnswer: number
  explanation?: string
  recordId: string
  tempUnlockUntil: string | null
}

// ============================================================
// 位置与安全区
// ============================================================

export type ZoneType = 'home' | 'school' | 'other'

export interface LocationPoint {
  id: string
  deviceId: string
  latitude: number
  longitude: number
  accuracy: number
  address: string
  type: ZoneType
  /** 命中的安全区（未命中为 null） */
  zoneId: string | null
  zoneName: string | null
  timestamp: string
}

export interface SafeZone {
  id: string
  deviceId: string
  name: string
  latitude: number
  longitude: number
  radiusMeters: number
  address: string
  type: ZoneType
  /**
   * 是否启用。**服务端一直有这个字段**（`locations.service.ts` 只把 `enabled: true` 的围栏下发给设备），
   * 但家长端类型里漏了、UI 也没有开关，于是「停用某个围栏」这件事在界面上根本做不到 ——
   * 默认 true 所以行为看起来正常，只是给了人一个假印象。
   */
  enabled: boolean
  createdAt: string
}

// ============================================================
// 媒体
// ============================================================

export type MediaKind = 'photo' | 'screenshot' | 'video' | 'audio'

export interface MediaAsset {
  id: string
  deviceId: string
  kind: MediaKind
  mimeType: string
  sizeBytes: number
  commandId: string | null
  createdAt: string
  /** 带短时效签名的访问地址，可直接喂给 <img src> */
  url: string
}

// ============================================================
// 锁屏策略与定时时间表
// ============================================================

/**
 * 锁屏强度。
 * - `kiosk`：默认。用 Lock Task 把设备钉在锁定页，家长可远程即时解锁；
 * - `password`：最高强度。锁定瞬间把系统锁屏密码改成随机值，风险很高。
 */
export type LockStrength = 'kiosk' | 'password'

/** 单台设备的锁屏策略（GET/PUT /api/lock-policy） */
export interface LockPolicy {
  deviceId: string
  strength: LockStrength
  /** 锁屏前透明悬浮窗的预告秒数，0..600，0 表示不预告 */
  countdownSeconds: number
  /** 定时时间表总开关；关掉后所有规则都不生效 */
  scheduleEnabled: boolean
}

/** 时间表规则的动作用语义：`lock` 该时段锁定，`unlock` 该时段允许使用 */
export type ScheduleAction = 'lock' | 'unlock'

export interface ScheduleRule {
  id: string
  deviceId: string
  name: string
  action: ScheduleAction
  /** 0=周日 … 6=周六，与 JS `Date.getDay()` 一致；至少一天 */
  daysOfWeek: number[]
  /** 从 00:00 起的分钟数，0..1439（22:00 = 1320） */
  startMinute: number
  /** 1..1440（24:00 = 1440）；小于 startMinute 表示跨天 */
  endMinute: number
  enabled: boolean
  createdAt: string
  updatedAt: string
}

/** 后端按服务器时间算出的实时预览；设备端以本地时钟为准 */
export interface SchedulePreview {
  /** 按服务器时间，此刻是否处于锁定状态 */
  lockedNow: boolean
  /** 决定当前状态的规则名；未命中任何规则时为 null */
  matchedRuleName: string | null
  /** 下一次锁定状态发生变化的时刻（ISO）；没有边界时为 null */
  nextChangeAt: string | null
  /** 那次变化之后是否锁定；没有边界时为 null */
  nextChangeLocked: boolean | null
  evaluatedAt: string
}

export interface ScheduleListResponse {
  schedules: ScheduleRule[]
  scheduleEnabled: boolean
  preview: SchedulePreview
}

/** 新增 / 编辑规则的入参 */
export interface ScheduleRuleInput {
  name: string
  action: ScheduleAction
  daysOfWeek: number[]
  startMinute: number
  endMinute: number
  enabled: boolean
}

// ============================================================
// 屏幕行为 AI 洞察
// ============================================================

/** 风险等级，决定时间线上的色条 */
export type InsightRiskLevel = 'none' | 'low' | 'medium' | 'high'

/** 一个批次里识别出的一段连续活动（对应包内第 frameFrom ~ frameTo 张） */
export interface InsightActivity {
  app: string
  packageName: string
  /** game | video | social | study | browser | shopping | other */
  category: string
  description: string
  frameFrom: number
  frameTo: number
}

export interface InsightGame {
  name: string
  /** menu 菜单 | playing 对局中 | result 结算画面 | other */
  scene: string
  roundCompleted: boolean
  /** 0 ~ 1 */
  confidence: number
  evidence: string
}

export interface InsightVideo {
  name: string
  episodeCompleted: boolean
  confidence: number
  evidence: string
}

export interface InsightTopic {
  /** english | poetry | math | science | general */
  subject: string
  term: string
  meaning: string
}

/** 一个截屏包（批次）的分析结论 */
export interface Insight {
  id: string
  batchId: string
  deviceId: string
  createdAt: string
  summary: string
  riskLevel: InsightRiskLevel
  activities: InsightActivity[]
  games: InsightGame[]
  videos: InsightVideo[]
  keywords: string[]
  topics: InsightTopic[]
  provider: string
  model: string
  /** false 表示这是「启发式推断」而不是真 AI，界面上必须区分显示 */
  isAi: boolean
  periodFrom: string | null
  periodTo: string | null
  frameCount: number
  completedRounds: number
  completedEpisodes: number
}

/** 帧时间线的一项：只有时间和应用名，后端刻意不返回原图地址（儿童隐私约定） */
export interface InsightFrame {
  seq: number
  capturedAt: string
  packageName: string
  appLabel: string
}

/** 从结论里抽出的可计数用量片段（玩了几局 / 看了几集） */
export interface UsageEpisode {
  id: string
  kind: UsageBudgetKind
  /** 中文，如「游戏局数」 */
  kindLabel: string
  appName: string
  count: number
  confidence: number
  evidence: string
  occurredAt: string
}

export interface InsightDetail extends Insight {
  frames: InsightFrame[]
  alerts: UsageAlert[]
  episodes: UsageEpisode[]
  /** 原始 AI 输出，用于排查，可折叠展示 */
  rawJson: string
}

export interface InsightListResponse {
  items: Insight[]
  unreadAlerts: number
  aiAvailable: boolean
  /** 后端给的中文说明，直接显示 */
  aiNote: string
}

export interface InsightReanalyzeResult {
  success: boolean
  batchId: string
}

// ============================================================
// 异常提醒
// ============================================================

export type UsageAlertType =
  | 'minor_content'
  | 'scam_suspect'
  | 'emotional_issue'
  | 'game_addiction'
  | 'high_spending'

export type UsageAlertSeverity = 'low' | 'medium' | 'high'

export interface UsageAlert {
  id: string
  deviceId: string
  insightId: string | null
  type: UsageAlertType
  /** 中文，如「游戏沉迷」 */
  typeLabel: string
  severity: UsageAlertSeverity
  title: string
  detail: string
  /** AI 给的判定依据原文，要显示，家长据此判断是否误报 */
  evidence: string
  read: boolean
  readAt: string | null
  createdAt: string
}

export interface UsageAlertListResponse {
  items: UsageAlert[]
  unread: number
}

export interface UsageAlertReadResult {
  success: boolean
  alert: UsageAlert
}

export interface UsageAlertReadAllResult {
  success: boolean
  updated: number
}

// ============================================================
// 截屏与 AI 设置
// ============================================================

/** ai 真 AI 分析 | heuristic 启发式推断 | disabled 未启用 */
export type ScreenAnalysisMode = 'ai' | 'heuristic' | 'disabled'

export interface ScreenMonitorConfig {
  /** 默认 false，这是最高敏感度权限 */
  captureEnabled: boolean
  /** 10..600，默认 30 */
  captureIntervalSeconds: number
  /** 2..30，默认 10 */
  framesPerBatch: number
  analyzeEnabled: boolean
  /** 1..20 */
  analyzeSampleCount: number
  /** 1..90 */
  retentionDays: number
  /** 是否用屏幕内容出题 */
  quizFromScreen: boolean
  alertMinorContent: boolean
  alertScam: boolean
  alertEmotional: boolean
  alertGameAddiction: boolean
  alertHighSpending: boolean
  aiAvailable: boolean
  analysisMode: ScreenAnalysisMode
  /** 后端给的中文说明，直接显示 */
  analysisNote: string
}

/** PUT /api/screen-monitor 的入参：任意子集 */
export type ScreenMonitorConfigPatch = Partial<
  Omit<ScreenMonitorConfig, 'aiAvailable' | 'analysisMode' | 'analysisNote'>
>

export interface ScreenMonitorUpdateResult {
  success: boolean
  userId: number
  config: ScreenMonitorConfig
}

// ============================================================
// 用量上限（玩几局 / 看几集）
// ============================================================

export type UsageBudgetKind = 'game_round' | 'video_episode'

export interface UsageBudget {
  id: string
  kind: UsageBudgetKind
  /** 留空 = 对全部应用生效 */
  appName: string
  /** 1..200 */
  dailyLimit: number
  enabled: boolean
  usedToday: number
}

export interface UsageBudgetListResponse {
  items: UsageBudget[]
}

export interface UsageBudgetInput {
  kind: UsageBudgetKind
  appName: string
  dailyLimit: number
  enabled: boolean
}

export interface UsageBudgetUpsertResult {
  success: boolean
  budget: Omit<UsageBudget, 'usedToday'>
}

export interface UsageSummaryBudget {
  id: string
  kind: UsageBudgetKind
  appName: string
  dailyLimit: number
  usedToday: number
  remaining: number
  exceeded: boolean
}

export interface UsageSummary {
  dayKey: string
  /** key 是 kind（game_round / video_episode） */
  used: Record<string, number>
  budgets: UsageSummaryBudget[]
}

// ============================================================
// 学习模式 / 普通模式（模式切换）
// ============================================================

/** 设备当前生效的模式；`study` 学习模式只允许白名单应用 */
export type DeviceModeValue = 'study' | 'normal'

/** 学习模式时段里的一格：0=周日 … 6=周六，hour 0..23 */
export interface ModeSlot {
  dayOfWeek: number
  hour: number
}

/** GET /api/device-mode —— 配置 + 服务端算出的当前模式 */
export interface DeviceModeState {
  /** null 表示跟随时段规划；显式值表示家长手动锁定模式 */
  manualMode: DeviceModeValue | null
  /** 是否启用「按时间设置」的时段规划 */
  scheduleEnabled: boolean
  effectiveMode: DeviceModeValue
  /** 开启时段规划却一格都没选 —— 此时全天都是学习模式，界面必须红字警告 */
  allDayStudyWarning: boolean
  slotCount: number
  /** 当前时刻对应的格子；scheduleEnabled 为 false 时为 null */
  currentSlot: ModeSlot | null
  serverTime: string
}

export interface DeviceModeUpdateResult {
  success: boolean
  mode: DeviceModeState
}

/** GET /api/study-slots */
export interface StudySlotListResponse {
  slots: ModeSlot[]
  total: number
  /** 一周 7 天 × 24 小时 = 168 */
  max: number
}

/** PUT /api/study-slots 返回整表替换后的结果 */
export interface StudySlotReplaceResult extends StudySlotListResponse {
  success: boolean
}

// ============================================================
// 学习模式的应用程序分组
// ============================================================

/** study = 学习模式允许使用（白名单）；normal = 普通模式专用 */
export type ModeAppGroup = 'study' | 'normal'

export interface ModeApp {
  id: string
  deviceId: string
  packageName: string
  appName: string
  group: ModeAppGroup
  createdAt: string
  updatedAt: string
}

/** GET /api/mode-apps */
export interface ModeAppListResponse {
  study: ModeApp[]
  normal: ModeApp[]
}

export interface ModeAppAddResult {
  success: boolean
  app: ModeApp
}

// ============================================================
// 设备已安装应用（选择应用 / 插件管理的数据来源）
// ============================================================

export interface DeviceApp {
  id: string
  packageName: string
  appName: string
  isSystem: boolean
  /** 有桌面图标、可启动的应用才值得管控 */
  isLaunchable: boolean
  /** 服务端是否已经存了这张图标（老版本孩子端不上传图标时为 false） */
  hasIcon: boolean
  /**
   * 图标地址，带签名，可以直接塞进 `<img src>`；没有图标时为 null。
   *
   * 签名 7 天有效，所以别把它存进 localStorage 长期用 ——
   * 每次列表接口都会重新签发。
   */
  iconUrl: string | null
}

/** GET /api/device-apps */
export interface DeviceAppListResponse {
  apps: DeviceApp[]
  total: number
}

/** POST /api/device-apps/refresh —— 与锁屏等一样是指令队列，设备在线才会立刻生效 */
export type DeviceAppRefreshResult = CommandDispatchResult

// ============================================================
// 护眼设置
// ============================================================

export interface EyeCareConfig {
  enabled: boolean
  /** 连续用眼多少分钟后提醒休息，5..240 */
  continuousMinutes: number
  /** 强制休息时长（分钟），1..60；休息期间锁屏 */
  restMinutes: number
  /** 夜间护眼时段起止小时 0..23；两者相同表示不启用夜间时段 */
  nightStartHour: number
  nightEndHour: number
  /** 夜间是否直接锁屏（false 则只在设备上提示） */
  nightLockEnabled: boolean
  /** 屏幕亮度上限百分比；0 表示不限制，否则 10..100 */
  maxBrightnessPercent: number
  /** 后端算出的「夜间时段是否有效」（起止小时不同才为 true） */
  nightEnabled: boolean
}

/** PUT /api/eye-care 的入参：任意子集（nightEnabled 是后端算出来的，不能提交） */
export type EyeCareConfigPatch = Partial<Omit<EyeCareConfig, 'nightEnabled'>>

export interface EyeCareGetResponse {
  config: EyeCareConfig
}

export interface EyeCareUpdateResult {
  success: boolean
  config: EyeCareConfig
}

// ============================================================
// 应用插件管控（微信 / QQ 等功能开关）
// ============================================================

export type AppPluginCategory =
  | 'payment'
  | 'social'
  | 'entertainment'
  | 'game'
  | 'install'
  | 'browsing'
  | 'privacy'

export interface AppPlugin {
  /** 稳定键名，服务端与设备端靠它对齐 */
  key: string
  label: string
  category: AppPluginCategory
  enabled: boolean
  /** 家长改过才为 true，便于一眼看出哪些是动过的 */
  customized: boolean
}

/** 一个可管控目标：真实应用，或 `__payment__` / `__appstore__` 这类跨应用伪包名 */
export interface AppPluginTarget {
  packageName: string
  appName: string
  /** 卡片角标文字，直接用中文，不含图标资源 */
  badge: string
  total: number
  /** 已关闭（被拦截）的插件数 */
  blocked: number
  plugins: AppPlugin[]
}

/** GET /api/app-plugins */
export interface AppPluginListResponse {
  targets: AppPluginTarget[]
}

/** PUT /api/app-plugins 返回更新后的整份目录 */
export interface AppPluginUpdateResult {
  success: boolean
  targets: AppPluginTarget[]
}

export interface AppPluginUpdateItem {
  packageName: string
  pluginKey: string
  enabled: boolean
}

// ============================================================
// 设备事件流（最新动态）
// ============================================================

export type DeviceEventType =
  | 'unlock'
  | 'lock'
  | 'screen_on'
  | 'screen_off'
  | 'app_installed'
  | 'app_removed'
  | 'mode_enter'
  | 'eye_rest'
  | 'plugin_blocked'
  | 'app_blocked'
  /** 管控被改动 / 被绕过：加固项失效、无障碍看门狗被关、VPN 授权被撤… */
  | 'tamper'

export interface DeviceEvent {
  id: string
  deviceId: string
  /** 后端是自由字符串列，界面按 DeviceEventType 映射图标文案，未知类型原样展示 */
  type: string
  /** 人话说明，家长端直接展示 */
  detail: string
  createdAt: string
}

/** GET /api/device-events */
export interface DeviceEventListResponse {
  page: number
  pageSize: number
  total: number
  totalPages: number
  items: DeviceEvent[]
}

// ============================================================
// 通话记录与短信（contract §8）
// ============================================================

/** 通话类型：呼入 / 呼出 / 未接 */
export type CallLogType = 'incoming' | 'outgoing' | 'missed'

export interface CallLogEntry {
  id: string
  phoneNumber: string
  /** 设备通讯录里能匹配到的联系人名；匹配不到时后端回 null，不是空串 */
  name: string | null
  type: CallLogType
  durationSeconds: number
  occurredAt: string
}

/** GET /api/calls */
export interface CallLogListResponse {
  page: number
  pageSize: number
  total: number
  totalPages: number
  items: CallLogEntry[]
}

/** 短信类型：收件 / 发件 */
export type SmsMessageType = 'inbox' | 'sent'

export interface SmsMessage {
  id: string
  /** 对方号码（后端字段名沿用 Android 侧的 address） */
  address: string
  body: string
  type: SmsMessageType
  occurredAt: string
}

/** GET /api/sms */
export interface SmsListResponse {
  page: number
  pageSize: number
  total: number
  totalPages: number
  items: SmsMessage[]
}

// ============================================================
// 远程协助（contract §7）
// ============================================================

/**
 * 设备端支持的远程操作动作。
 * 只有这几个，截屏走既有的 `screenshot` 指令，不在这个枚举里。
 */
export type RemoteAction = 'back' | 'home' | 'recents' | 'notifications' | 'open_app'

// ============================================================
// 通用
// ============================================================

export interface ApiErrorBody {
  title: string
  status: number
  message: string
  /** 形状随 title 而定（MEMBERSHIP_REQUIRED 是结构化对象），故为 unknown */
  detail: unknown
  errors: { path: string; message: string }[] | null
  request_id?: string
}

// ============================================================
// 会员体系
// ============================================================

/** 账号档位。ordinary 是默认档，注册即得。 */
export type MembershipTier = 'ordinary' | 'member' | 'super'

/** 可购买的档位：普通账号不是商品，只能通过到期退回来。 */
export type PurchasableTier = 'member' | 'super'

/** 计费周期：按月 / 按年 / 连续包月（自动续费）。 */
export type BillingPeriod = 'monthly' | 'yearly' | 'auto_monthly'

export type PayChannel = 'alipay' | 'wechat'

export type MembershipOrderStatus = 'pending' | 'paid' | 'failed' | 'cancelled' | 'expired'

/** 权益定义（后端 ENTITLEMENTS 的镜像）。 */
export interface MembershipEntitlement {
  key: string
  label: string
  minTier: PurchasableTier
  description: string
}

/** 一条定价规则命中的结果：前端只用来展示「省了多少、为什么」。 */
export interface PricingAdjustment {
  ruleId: string
  name: string
  discountType: 'percent' | 'amount'
  discountValue: number
  /** 这条规则实际减掉的分（已经按原价算好，不是百分比） */
  amountCents: number
  note: string
}

/**
 * 受邀用户定价的状态（会员价格 × 是否被邀请注册）。
 *
 * **只存在于后台与测试**：被邀请注册的家长价格更高（邀请人的分享返现成本落在
 * 这张订单上），但这件事对家长端是**不可见**的 —— 接口不下发规则名和上浮额，
 * 受邀生效时服务端还会把优惠明细压平（见 `server/src/features/membership/membership.service.ts`
 * 的 `quoteOf` / `toOrderView`），家长端只会看到一个干净的价格。
 */
export interface ReferralPriceInfo {
  /** 这个账号有没有资格走受邀定价（被邀请注册） */
  applicable: boolean
  /** 受邀价最终有没有真的生效 */
  applied: boolean
  /** 一句话解释当前状态（后台展示用） */
  reason: string
  ruleId: string | null
  ruleName: string
  priceType: 'percent' | 'amount' | 'fixed' | null
  priceValue: number
  /** 加价基数：常规定价的实付价 */
  baseCents: number
  /** 命中的规则算出来的最高价；没命中为 null */
  candidateCents: number | null
  /** 比常规定价多收了多少分；0 表示没生效 */
  surchargeCents: number
  /** 结账价 = max(常规定价, candidateCents) */
  finalCents: number
  /** 一共命中几条规则（价格取的是最高的一条） */
  matchedCount: number
  note: string
}

/** 一个套餐在当前账号下的动态报价。 */
export interface MembershipPlanQuote {
  code: string
  name: string
  description: string
  tier: PurchasableTier
  period: BillingPeriod
  periodLabel: string
  months: number
  recommended: boolean
  originalCents: number
  finalCents: number
  discountCents: number
  /** 折合每月多少分，用来横向比较年付与月付 */
  monthlyEquivalentCents: number
  adjustments: PricingAdjustment[]
}

export interface MembershipTierQuotes {
  tier: PurchasableTier
  label: string
  plans: MembershipPlanQuote[]
}

export interface MembershipStatus {
  tier: MembershipTier
  tierLabel: string
  /** 当前是否有生效的付费身份（ordinary 恒为 false） */
  active: boolean
  expiresAt: string | null
  daysLeft: number | null
  autoRenew: boolean
  renewTier: PurchasableTier | null
  startedAt: string | null
  firstPaidAt: string | null
  totalPaidCents: number
  /** 当前档位已解锁的权益 key 列表 */
  entitlements: string[]
  nextTier: {
    tier: PurchasableTier
    label: string
    missing: { key: string; label: string }[]
  } | null
}

export interface MembershipOverview {
  success: boolean
  status: MembershipStatus
  entitlements: MembershipEntitlement[]
  tiers: MembershipTierQuotes[]
  /** 后端是否在跑模拟支付（false 时支付接口会 503） */
  mockPay: boolean
}

export interface MembershipOrder {
  orderNo: string
  planCode: string
  tier: PurchasableTier
  period: BillingPeriod
  periodLabel: string
  originalCents: number
  amountCents: number
  /** 抵扣用的邀请返现优惠券；没有则为 null */
  couponId: string | null
  couponCents: number
  adjustments: PricingAdjustment[]
  payChannel: PayChannel
  status: MembershipOrderStatus
  transactionId: string | null
  paidAt: string | null
  expiresAt: string | null
  createdAt: string
}

export interface MembershipOrderListResponse {
  success: boolean
  orders: MembershipOrder[]
  total: number
  page: number
  pageSize: number
}

export interface CreateMembershipOrderResponse {
  success: boolean
  order: MembershipOrder
}

export interface PayMembershipOrderResponse {
  success: boolean
  order: MembershipOrder
  status: MembershipStatus
}

// ============================================================
// 支付渠道管线（规划 §5.4）
// ============================================================

/**
 * 能下单的渠道。`fake` 是**仅测试环境**可用的渠道，它走的也是完整的
 * 「下单 → 预支付 → 验签回调」管线（只是不联网、签名用本地密钥），
 * 所以 e2e 能用它验证真实链路而不是模拟支付。
 */
export type PaymentChannelKey = PayChannel | 'fake'

/** 一个渠道当前能不能用；不能用时 `missing` 列出缺哪几个环境变量。 */
export interface PaymentChannelOption {
  key: PaymentChannelKey
  label: string
  configured: boolean
  missing: string[]
  /** 渠道自己的补充说明（例如微信需要绑定了 openid 才能用 JSAPI） */
  note: string
}

export interface PaymentsCatalog {
  channels: PaymentChannelOption[]
  /** 当前真正可用的渠道 key */
  available: string[]
  /** 测试环境才为 true：假渠道可用 */
  fakeAvailable: boolean
  /** 后端是否开着模拟支付（true 时未配置渠道也能把流程跑通，但不扣款） */
  mockPay: boolean
  refundWindowDays: number
  invoiceLimit: number
  notifyPath: string
  /** 给家长端的一句话说明：没有配置就如实说「没有配置」，绝不写成「支付成功」 */
  notice: string
}

/** 渠道返回的预支付信息。`mock` 表示渠道没配、后端降级成模拟支付。 */
export interface PaymentIntent {
  channel: string
  channelLabel: string
  mode: 'native_qr' | 'jsapi' | 'h5' | 'mock' | string
  codeUrl: string
  prepayId: string
  payload: Record<string, unknown>
  mockPay?: boolean
  missing?: string[]
}

/** 一笔订单在支付管线下的完整视图（比会员模块的 MembershipOrder 多了退款/发票信息）。 */
export interface PaymentOrderView {
  orderNo: string
  planCode: string
  tier: string
  period: string
  payChannel: string
  payChannelLabel: string
  /** 计费周期的展示文案（包月 / 连续包月 / 包年） */
  periodLabel: string
  status: string
  statusLabel: string
  amountCents: number
  originalCents: number
  couponCents: number
  refundCents: number
  refundReason: string
  refundedAt: string | null
  refundNo: string | null
  notifiedOrderNo: string | null
  transactionId: string | null
  prepayId: string | null
  paidAt: string | null
  startsAt: string | null
  expiresAt: string | null
  createdAt: string
  canPay: boolean
  canRefund: boolean
  refundDeadline: string | null
  invoice: { id: string; status: string; statusLabel: string; invoiceNo: string } | null
  /** 这个渠道缺哪些环境变量（空数组表示配置齐全） */
  missingConfig: string[]
}

export interface PaymentEventView {
  id: string
  kind: string
  provider: string
  signatureOk: boolean
  result: string
  detail: string
  createdAt: string
}

export interface PaymentOrderListResponse {
  success: boolean
  orders: PaymentOrderView[]
  total: number
  page: number
  pageSize: number
}

export interface PaymentOrderDetailResponse {
  success: boolean
  order: PaymentOrderView
  events: PaymentEventView[]
}

export interface PaymentIntentResponse {
  success: boolean
  order: PaymentOrderView
  payment: PaymentIntent
}

export interface RefundResponse {
  success: boolean
  order: PaymentOrderView
  membershipRevoked: boolean
}

export type InvoiceStatus = 'pending' | 'issued' | 'rejected'

export interface InvoiceView {
  id: string
  orderNo: string
  amountCents: number
  title: string
  taxNo: string
  email: string
  status: InvoiceStatus | string
  statusLabel: string
  invoiceNo: string
  note: string
  issuedAt: string | null
  createdAt: string
}

export interface InvoiceResponse {
  success: boolean
  invoice: InvoiceView
}

// ============================================================
// 分享提成（邀请返现）
// ============================================================

/** 邀请码用到的账号/关系状态。 */
export type ReferralStatus = 'bound' | 'valid' | 'invalid'
export type ReferralRewardKind = 'first_purchase' | 'renewal'
export type ReferralRewardStatus = 'pending' | 'settled' | 'cancelled'
export type ReferralWithdrawalStatus = 'pending' | 'approved' | 'paid' | 'rejected'
export type ReferralCouponStatus = 'unused' | 'used' | 'expired'
export type WithdrawChannel = 'alipay' | 'wechat' | 'bank'

export interface ReferralConfig {
  enabled: boolean
  title: string
  subtitle: string
  notice: string
  /** 逐条的活动说明，直接 map 渲染 */
  noticeLines: string[]
  shortPeriodMinRatePercent: number
  longPeriodCapCents: number
  renewalRatePercent: number
  renewalCapCents: number
  withdrawMinInvitees: number
  withdrawMinCents: number
  withdrawRequireVerified: boolean
  settleDayStart: number
  settleDayEnd: number
}

export interface ReferralStats {
  invitedCount: number
  validCount: number
  rewardTotalCents: number
  pendingCents: number
  settledCents: number
  cancelledCents: number
  withdrawnCents: number
  pendingWithdrawCents: number
  availableCents: number
  couponUnusedCount: number
  couponUnusedCents: number
  /** 本月已产生的返现（分，字符串避免大数精度问题） */
  currentMonthCents: string
  currentMonthLabel: string
}

export interface ReferralTier {
  minInvitees: number
  maxInvitees: number | null
  ratePercent: number
  current: boolean
}

export interface ReferralNextTier {
  minInvitees: number
  ratePercent: number
  needInvitees: number
}

export interface WithdrawRequirement {
  key: 'invitees' | 'verified' | 'amount' | 'balance'
  label: string
  met: boolean
  current: string
  required: string
}

export interface ReferralWithdrawEligibility {
  eligible: boolean
  availableCents: number
  requirements: WithdrawRequirement[]
  blockedReason: string
}

export interface ReferralIdentity {
  verified: boolean
  realName: string
  idCardTail: string
  idCardMasked: string
}

export interface ReferralReward {
  rewardNo: string
  kind: ReferralRewardKind
  kindLabel: string
  status: ReferralRewardStatus
  statusLabel: string
  baseAmountCents: number
  ratePercent: number
  amountCents: number
  capApplied: boolean
  settleMonth: string
  settledAt: string | null
  cancelReason: string
  createdAt: string
  inviteeName: string
  inviteePhone: string
}

export interface ReferralCoupon {
  id: string
  amountCents: number
  source: string
  status: ReferralCouponStatus
  statusLabel: string
  expiresAt: string | null
  usedAt: string | null
  usedOrderNo: string | null
  createdAt: string
  usable: boolean
}

export interface ReferralInvitee {
  id: string
  nickname: string
  phone: string
  status: ReferralStatus
  statusLabel: string
  invalidReason: string
  boundAt: string
  validAt: string | null
  rewardCents: number
  rewardCount: number
}

export interface ReferralWithdrawal {
  withdrawNo: string
  amountCents: number
  status: ReferralWithdrawalStatus
  statusLabel: string
  realName: string
  idCardTail: string
  channel: WithdrawChannel
  channelLabel: string
  account: string
  userNote: string
  reviewNote: string
  createdAt: string
  reviewedAt: string | null
  paidAt: string | null
}

export interface ReferralOverview {
  success: boolean
  config: ReferralConfig
  inviteCode: string
  /** 相对路径，前端自己拼 window.location.origin */
  linkPath: string
  inviteLink: string
  stats: ReferralStats
  tiers: ReferralTier[]
  currentTier: { minInvitees: number; maxInvitees: number | null; ratePercent: number } | null
  nextTier: ReferralNextTier | null
  withdraw: ReferralWithdrawEligibility
  identity: ReferralIdentity
  recentRewards: ReferralReward[]
  recentCoupons: ReferralCoupon[]
}

export interface ReferralCouponListResponse {
  success: boolean
  items: ReferralCoupon[]
  summary: {
    unusedCount: number
    unusedCents: number
    usedCount: number
    expiredCount: number
  }
}

export interface ReferralListResponse<T> {
  success: boolean
  items: T[]
  total: number
  page: number
  pageSize: number
}

export interface ReferralIdentityResponse extends ReferralIdentity {
  success: boolean
}

export interface ReferralWithdrawResponse {
  success: boolean
  withdrawal: ReferralWithdrawal
}

// ============================================================
// 家长端站内通知（规划 §2.1 第一档）
// ============================================================

/** 通知类型白名单（与服务端 notifications.constants.ts 一一对应）。 */
export type NotificationType =
  | 'agent_offline'
  | 'health_danger'
  | 'geofence_enter'
  | 'geofence_exit'
  | 'app_audit'
  | 'child_request'
  | 'child_sos'
  | 'membership_expiring'

/**
 * 孩子的申请（规划 §3.1）。
 *
 * `kind` 是服务端白名单里的枚举（extend_time / delay_lock），展示一律用
 * 服务端给的 `kindLabel` —— 与指令名、缺口说明同一条规矩：中文由服务端给，
 * 前端把它包进 t() 就能出英文，不会漏掉一个枚举值而显示成内部代号。
 */
export type TimeRequestKind = 'extend_time' | 'delay_lock'
export type TimeRequestStatus = 'pending' | 'approved' | 'rejected'

export interface TimeRequest {
  id: string
  kind: TimeRequestKind
  /** 服务端给的中文类型名（「申请加时」/「申请延后锁屏」） */
  kindLabel: string
  /** 孩子申请的分钟数 */
  minutes: number
  /** 孩子写的理由，空字符串表示没写 */
  reason: string
  status: TimeRequestStatus
  /** 家长的批注 / 拒绝理由 */
  reviewNote: string
  /** 家长实际批准的分钟数；未审批或已拒绝时为 null */
  grantedMinutes: number | null
  reviewedAt: string | null
  createdAt: string
}

export interface TimeRequestListResponse {
  items: TimeRequest[]
}

export type NotificationLevel = 'info' | 'warn' | 'danger'

export interface AppNotification {
  id: string
  type: NotificationType
  /** 服务端给的中文类型名（如「设备失联」），直接展示，不在前端再映射一遍 */
  typeLabel: string
  level: NotificationLevel
  /**
   * 标题**模板**：固定句子直接就是中文原文；带变量的句子形如 `'{{v0}} 已失联'`，
   * 变量值在 `titleParams` 里。渲染一律走 renderNotificationText()（见 NotificationsPage）。
   */
  title: string
  body: string
  /** 标题模板的插值参数；老数据是空 */
  titleParams: Record<string, string | number> | null
  /** 正文模板的插值参数；老数据是空 */
  bodyParams: Record<string, string | number> | null
  /** 点击后跳转的家长端路径；空字符串表示没有可跳的地方 */
  linkPath: string
  deviceId: string | null
  read: boolean
  readAt: string | null
  createdAt: string
}

export interface NotificationListResponse {
  page: number
  pageSize: number
  total: number
  totalPages: number
  unreadCount: number
  items: AppNotification[]
}

export interface NotificationUnreadResponse {
  unreadCount: number
}

/**
 * 通知通道。
 *
 * `configured` 是**服务端**的事实：微信服务号与厂商推送都还没接入。
 * 界面据此显示「未配置」而不是让家长填一个永远不会生效的开关 ——
 * 存了不做才是真骗人。
 */
/** 某条消息在微信通道上的投递结果（家长端用它回答「为什么没收到」）。 */
export interface NotificationDeliveryInfo {
  status: 'pending' | 'sent' | 'failed'
  attempts: number
  /** 失败原因，微信的 errcode 原文就留在这里 */
  lastError: string
  sentAt: string | null
  createdAt: string
}

export interface NotificationChannel {
  configured: boolean
  label: string
  /** 微信通道：这个账号绑没绑 openid（没绑就发不出去） */
  bound?: boolean
  /** 缺哪个条件就说什么（空串 = 没什么要说的） */
  hint?: string
  /** 厂商推送：为什么**不适用**（不是「以后再说」） */
  reason?: string
  /** 最近一次投递 */
  lastDelivery?: NotificationDeliveryInfo | null
}

export interface NotificationPreferenceItem {
  type: NotificationType
  label: string
  inApp: boolean
  wechat: boolean
  push: boolean
}

export interface NotificationPreferences {
  channels: {
    wechat: NotificationChannel
    push: NotificationChannel
  }
  items: NotificationPreferenceItem[]
}

// ============================================================
// 合规留痕、数据导出与注销（规划 §5.3）
// ============================================================

export interface PrivacyDocSection {
  title: string
  body: string
}

/** 一份合规模本。改一个字就换版本号，旧版同意不再算数。 */
export interface PrivacyDoc {
  docType: string
  version: string
  title: string
  /** 必读文本：没同意就没有有效授权 */
  required: boolean
  summary: string
  sections: PrivacyDocSection[]
}

/** 最小必要采集清单里的一行。`retention` 写的是真的会执行的天数。 */
export interface CollectionEntry {
  key: string
  title: string
  examples: string
  purpose: string
  retention: string
  storedOn: string
}

export interface PrivacyCatalog {
  version: string
  docs: PrivacyDoc[]
  collection: CollectionEntry[]
  deletionGraceDays: number
  deletionConfirmText: string
  revokeConfirmText: string
}

export interface ConsentRecordView {
  id: string
  docType: string
  docVersion: string
  acceptedAt: string
  revokedAt: string | null
}

export interface ConsentStatus {
  docType: string
  title: string
  version: string
  required: boolean
  /** 已有**当前版本**的有效同意 */
  accepted: boolean
  /** 同意过旧版本 —— 必须重新阅读并同意 */
  needsReaccept: boolean
  record: ConsentRecordView | null
  /** 只追加的历史（含已撤回的） */
  history: ConsentRecordView[]
}

export interface DeletionStatus {
  scheduled: boolean
  scheduledFor: string | null
  graceDays: number
  note: string
  canCancel: boolean
}

/** 导出是一份完整 JSON。这里只声明界面要用的几个字段，其余原样下载。 */
export interface PrivacyExport {
  generatedAt: string
  docVersion: string
  account: { id: number; nickname: string; phone: string | null }
  devices: unknown[]
  children: unknown[]
  tasks: unknown[]
  consents: ConsentRecordView[]
  privacyRequests: { kind: string; status: string; createdAt: string; note: string }[]
  collection: CollectionEntry[]
  truncated: string[]
  notes: string[]
}

// ── 客服工单（规划 §5.5）──────────────────────────────────────────────
// 非目标如实写在这里，界面不能装：没有附件、没有自动回复机器人。
// 分类与状态的中文标签由服务端下发（`TICKET_CATEGORIES` / `TICKET_STATUS_LABELS`），
// 前端**不自己抄一份** —— 抄一份的下场是后台加了分类、家长端还是旧的。

export interface SupportCategory {
  key: string
  label: string
  /** 选中后给的一句提示：告诉家长该写什么，少一轮来回 */
  hint: string
}

export interface SupportConfig {
  enabled: boolean
  categories: SupportCategory[]
  openLimit: number
  bodyMax: number
  /** 运营配的对外联系方式；没配就是空字符串，界面如实写「在工单里回复你」 */
  contact: string
  notice: string
}

export interface SupportReply {
  by: 'parent' | 'admin'
  at: string
  body: string
}

export interface SupportTicketView {
  ticketNo: string
  category: string
  subject: string
  body: string
  contact: string
  status: string
  statusLabel: string
  createdAt: string
  updatedAt: string
  closedAt: string | null
  replies: SupportReply[]
}
