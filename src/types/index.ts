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
  /** 临时解锁到期时间（ISO），null 表示未临时解锁 */
  tempUnlock: string | null
  deviceCode: string
  agentVersion: string
  createdAt: string
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

export interface Features {
  lockScreen: { enabled: boolean; locked: boolean }
  tempUnlock: { enabled: boolean; unlockTime: string | null }
  timePlan: { enabled: boolean; dailyLimit: number; usedToday: number }
  appLimit: { enabled: boolean; apps: Record<string, number> }
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
// 通用
// ============================================================

export interface ApiErrorBody {
  title: string
  status: number
  message: string
  detail: string | null
  errors: { path: string; message: string }[] | null
  request_id?: string
}
