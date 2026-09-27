import { request, type QueryValue } from './client'

/** 后端所有列表接口统一的返回结构。 */
export interface Paged<T> {
  page: number
  pageSize: number
  total: number
  totalPages: number
  items: T[]
}

// ============================================================
// 类型（与 server/src/features/admin 的返回一一对应）
// ============================================================

export interface AdminAccount {
  id: number
  username: string
  name: string
  role: string
  status: string
  lastLoginAt: string | null
  createdAt: string | null
}

export interface CommandView {
  id: string
  deviceId: string
  type: string
  label: string
  payload: Record<string, unknown>
  status: string
  result: unknown
  error: string
  createdAt: string
  dispatchedAt: string | null
  finishedAt: string | null
  expiresAt: string
  /** 仅后台列表返回 */
  deviceName?: string
  owner?: { id: number; phone: string | null; nickname: string } | null
}

export interface StatsResponse {
  range: { days: number; from: string; to: string }
  kpi: {
    totalUsers: number
    activeUsers: number
    disabledUsers: number
    newUsersInRange: number
    totalDevices: number
    boundDevices: number
    unboundDevices: number
    onlineDevices: number
    lockedDevices: number
    totalCommands: number
    pendingCommands: number
    succeededCommands: number
    failedCommands: number
    commandSuccessRate: number | null
    totalMedia: number
    mediaBytes: number
    totalLocations: number
    totalSafeZones: number
    totalQuizRecords: number
    quizAccuracy: number | null
    totalSmsCodes: number
  }
  series: {
    users: { date: string; count: number }[]
    devices: { date: string; count: number }[]
    commands: { date: string; count: number }[]
  }
  breakdown: {
    commandsByType: { type: string; count: number }[]
    commandsByStatus: { status: string; count: number }[]
    quizByType: { type: string; count: number; rewardMinutes: number }[]
  }
}

export interface UserRow {
  id: number
  phone: string | null
  email: string | null
  nickname: string
  avatar: string
  status: string
  wechatBound: boolean
  createdAt: string
  deviceCount: number
  commandCount: number
  quizRecordCount: number
  mediaCount: number
}

export interface UserDetail {
  user: {
    id: number
    phone: string | null
    email: string | null
    nickname: string
    avatar: string
    status: string
    wechatBound: boolean
    activeDeviceId: string | null
    createdAt: string
    updatedAt: string
  }
  stats: {
    deviceCount: number
    onlineDeviceCount: number
    commandTotal: number
    commandFailed: number
    quizTotal: number
    quizCorrect: number
    quizAccuracy: number | null
    mediaTotal: number
    locationTotal: number
  }
  devices: {
    id: string
    name: string
    model: string
    os: string
    status: string
    locked: boolean
    battery: number
    lastActiveAt: string | null
    deviceCode: string
    boundAt: string | null
    counts: { commands: number; media: number; locations: number; quizRecords: number }
  }[]
  recentCommands: CommandView[]
}

export interface DeviceRow {
  id: string
  name: string
  model: string
  os: string
  online: boolean
  battery: number
  network: string
  locked: boolean
  tempUnlockUntil: string | null
  deviceCode: string
  agentVersion: string
  lastActiveAt: string | null
  createdAt: string
  boundAt: string | null
  bound: boolean
  owner: { id: number; phone: string | null; nickname: string; status: string } | null
  counts: { commands: number; media: number; locations: number; quizRecords: number }
}

export interface DeviceDetail {
  device: DeviceRow & {
    status: string
  }
  owner: { id: number; phone: string | null; nickname: string; status: string } | null
  features: Record<string, boolean>
  timePlan: { enabled: boolean; dailyLimitMinutes: number; usedTodayMinutes: number } | null
  appLimits: { appName: string; packageName: string; dailyLimitMinutes: number; enabled: boolean }[]
  blockedUrls: string[]
  pendingAuditCount: number
  quizConfig: {
    enabled: boolean
    quizType: string
    grade: string
    correctRewardMinutes: number
    randomMode: boolean
  } | null
  recentCommands: CommandView[]
}

export interface QuestionRow {
  id: string
  type: string
  grade: string
  question: string
  options: string[]
  correctAnswer: number
  explanation: string
  createdAt: string
}

export interface QuizRecordRow {
  id: string
  deviceId: string
  questionId: string
  deviceName: string
  owner: { id: number; phone: string | null; nickname: string } | null
  type: string
  question: string
  userAnswer: number
  isCorrect: boolean
  rewardMinutes: number
  createdAt: string
}

export interface SmsCodeRow {
  id: string
  phone: string
  purpose: string
  attempts: number
  state: string
  expiresAt: string
  consumedAt: string | null
  createdAt: string
}

export interface OperationLogRow {
  id: number
  adminId: number | null
  adminName: string
  action: string
  method: string
  path: string
  status: number
  detail: string | null
  ip: string | null
  createdAt: string
}

type Query = Record<string, QueryValue>

// ============================================================
// 接口
// ============================================================

export const api = {
  auth: {
    login: (username: string, password: string) =>
      request<{ success: boolean; token: string; admin: AdminAccount }>('/admin/login', {
        method: 'POST',
        body: { username, password },
        skipAuth: true,
      }),
    profile: () => request<AdminAccount>('/admin/profile'),
    changePassword: (oldPassword: string, newPassword: string) =>
      request<{ success: boolean }>('/admin/password', {
        method: 'POST',
        body: { oldPassword, newPassword },
      }),
  },

  stats: (days: number) => request<StatsResponse>('/admin/stats', { query: { days } }),

  users: {
    list: (q: Query) => request<Paged<UserRow>>('/admin/users', { query: q }),
    get: (id: number) => request<UserDetail>(`/admin/users/${id}`),
    setStatus: (id: number, status: 'active' | 'disabled', reason?: string) =>
      request<{ success: boolean; status: string }>(`/admin/users/${id}/status`, {
        method: 'PATCH',
        body: { status, reason },
      }),
    remove: (id: number) =>
      request<{ success: boolean; removedMediaFiles: number }>(`/admin/users/${id}`, { method: 'DELETE' }),
  },

  devices: {
    list: (q: Query) => request<Paged<DeviceRow>>('/admin/devices', { query: q }),
    get: (id: string) => request<DeviceDetail>(`/admin/devices/${id}`),
    unbind: (id: string) =>
      request<{ success: boolean; previousOwnerId: number }>(`/admin/devices/${id}/unbind`, {
        method: 'POST',
      }),
    remove: (id: string) =>
      request<{ success: boolean; removedMediaFiles: number }>(`/admin/devices/${id}`, {
        method: 'DELETE',
      }),
  },

  commands: {
    list: (q: Query) => request<Paged<CommandView>>('/admin/commands', { query: q }),
    cancel: (id: string) =>
      request<{ command: CommandView; cancelled: boolean }>(`/admin/commands/${id}/cancel`, {
        method: 'POST',
      }),
  },

  questions: {
    list: (q: Query) =>
      request<Paged<QuestionRow> & { distribution: { grade: string; type: string; count: number }[] }>(
        '/admin/questions',
        { query: q },
      ),
    create: (body: {
      type: string
      grade: string
      question: string
      options: string[]
      correctAnswer: number
      explanation?: string
    }) => request<{ success: boolean; question: QuestionRow }>('/admin/questions', { method: 'POST', body }),
    update: (id: string, body: Partial<Omit<QuestionRow, 'id' | 'createdAt'>>) =>
      request<{ success: boolean; question: QuestionRow }>(`/admin/questions/${id}`, {
        method: 'PATCH',
        body,
      }),
    remove: (id: string) =>
      request<{ success: boolean }>(`/admin/questions/${id}`, { method: 'DELETE' }),
  },

  quizRecords: {
    list: (q: Query) => request<Paged<QuizRecordRow>>('/admin/quiz-records', { query: q }),
  },

  smsCodes: {
    list: (q: Query) =>
      request<Paged<SmsCodeRow> & { distribution: { purpose: string; count: number }[] }>('/admin/sms-codes', {
        query: q,
      }),
    purge: () => request<{ success: boolean; deleted: number }>('/admin/sms-codes/purge', { method: 'POST' }),
  },

  logs: {
    list: (q: Query) => request<Paged<OperationLogRow>>('/admin/logs', { query: q }),
  },

  admins: {
    list: () => request<{ admins: AdminAccount[] }>('/admin/admins'),
    create: (body: { username: string; password: string; name?: string; role: string }) =>
      request<{ success: boolean; admin: AdminAccount }>('/admin/admins', { method: 'POST', body }),
    resetPassword: (id: number, password: string) =>
      request<{ success: boolean }>(`/admin/admins/${id}/password`, { method: 'PATCH', body: { password } }),
    setStatus: (id: number, status: 'active' | 'disabled') =>
      request<{ success: boolean }>(`/admin/admins/${id}/status`, { method: 'PATCH', body: { status } }),
    remove: (id: number) => request<{ success: boolean }>(`/admin/admins/${id}`, { method: 'DELETE' }),
  },
}

export * from './client'
