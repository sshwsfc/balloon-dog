/**
 * 后端接口层。
 *
 * 相对 mock 版的几处关键修正：
 *  1. **错误信息透传**：后端返回的 `{ message }` 是可直接展示的中文短句，
 *     过去被整包丢弃、前端统一显示 "API Error: 400"。现在 ApiError.userMessage 有值，
 *     所有页面用 `toUserMessage(error)` 取值。
 *  2. **delete 也带令牌**：原本 delete() 是唯一漏拼 Authorization 的方法，
 *     导致删除设备必然 401。现在所有方法走同一个 request()。
 *  3. **401 统一处理**：令牌失效时自动清凭据并跳登录，而不是让每个页面自己 try/catch。
 *  4. **相对路径 /api**：开发走 Vite 代理、生产走 Nginx 反代，不再硬编码 host:port
 *     （原实现拼接 `location.hostname:3000`，换端口/域名就废）。
 */
import type {
  AppPluginListResponse,
  AppPluginUpdateItem,
  AppPluginUpdateResult,
  AuthResponse,
  CallLogListResponse,
  CommandDispatchResult,
  Device,
  DeviceAppListResponse,
  DeviceAppRefreshResult,
  DeviceCommand,
  DeviceEventListResponse,
  DeviceModeState,
  DeviceModeUpdateResult,
  DeviceModeValue,
  EyeCareConfigPatch,
  EyeCareGetResponse,
  EyeCareUpdateResult,
  Features,
  InsightDetail,
  InsightListResponse,
  InsightReanalyzeResult,
  LocationPoint,
  LockPolicy,
  MediaAsset,
  ModeAppAddResult,
  ModeAppGroup,
  ModeAppListResponse,
  ModeSlot,
  QuizAnswerResult,
  QuizConfig,
  QuizQuestion,
  QuizRecord,
  QuizStatistics,
  RemoteAction,
  SafeZone,
  ScheduleListResponse,
  ScheduleRule,
  ScheduleRuleInput,
  ScreenMonitorConfig,
  ScreenMonitorConfigPatch,
  ScreenMonitorUpdateResult,
  SmsListResponse,
  StudySlotListResponse,
  StudySlotReplaceResult,
  UsageAlertListResponse,
  UsageAlertReadAllResult,
  UsageAlertReadResult,
  UsageAlertType,
  UsageBudgetInput,
  UsageBudgetListResponse,
  UsageBudgetUpsertResult,
  UsageSummary,
  User,
} from '@/types'

const API_BASE = '/api'
const TOKEN_KEY = 'balloon_dog_token'
const REQUEST_TIMEOUT_MS = 15_000

/** 后端统一错误体 */
interface ServerErrorBody {
  title?: string
  status?: number
  message?: string
  detail?: string | null
  errors?: { path: string; message: string }[] | null
  request_id?: string
}

export class ApiError extends Error {
  readonly status: number
  readonly code: string
  /** 可直接展示给用户的中文提示 */
  readonly userMessage: string
  readonly detail: string | null
  readonly fieldErrors: { path: string; message: string }[] | null
  readonly requestId?: string

  constructor(init: {
    status: number
    code: string
    userMessage: string
    detail?: string | null
    fieldErrors?: { path: string; message: string }[] | null
    requestId?: string
  }) {
    super(init.userMessage)
    this.name = 'ApiError'
    this.status = init.status
    this.code = init.code
    this.userMessage = init.userMessage
    this.detail = init.detail ?? null
    this.fieldErrors = init.fieldErrors ?? null
    this.requestId = init.requestId
  }
}

/**
 * 从任意异常里取出「能展示给用户」的中文提示。
 * 页面里统一用这个，不要再写 `error.message || '...'` ——
 * 网络错误、超时、后端业务错误的文案差异都在这里收口。
 */
export function toUserMessage(error: unknown, fallback = '操作失败，请稍后重试'): string {
  if (error instanceof ApiError) return error.userMessage || fallback
  if (error instanceof Error) {
    if (error.name === 'TimeoutError') return '请求超时，请检查网络后重试'
    if (error.name === 'AbortError') return '请求已取消'
    if (error.message === 'Failed to fetch') return '无法连接服务器，请确认后端已启动'
    return error.message || fallback
  }
  return fallback
}

// ============================================================
// 令牌存储
// ============================================================

let currentToken: string | null = null
let unauthorizedHandler: (() => void) | null = null

export function setAuthToken(token: string | null): void {
  currentToken = token
  if (token) {
    localStorage.setItem(TOKEN_KEY, token)
  } else {
    localStorage.removeItem(TOKEN_KEY)
  }
}

export function getAuthToken(): string | null {
  if (!currentToken) {
    currentToken = localStorage.getItem(TOKEN_KEY)
  }
  return currentToken
}

/**
 * 注册 401 回调（AuthContext 在挂载时注册）。
 * 令牌过期/被禁用时，API 层先清凭证再通知上层跳转登录，
 * 避免每个页面各自处理一遍。
 */
export function setUnauthorizedHandler(handler: (() => void) | null): void {
  unauthorizedHandler = handler
}

// ============================================================
// 请求核心
// ============================================================

type QueryValue = string | number | boolean | undefined | null

function buildUrl(path: string, query?: Record<string, QueryValue>): string {
  const url = `${API_BASE}${path}`
  if (!query) return url
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== '') {
      params.append(key, String(value))
    }
  }
  const qs = params.toString()
  return qs ? `${url}?${qs}` : url
}

interface RequestOptions {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE'
  body?: unknown
  query?: Record<string, QueryValue>
  /** 上传表单时传 FormData（不能设 Content-Type，交给浏览器带 boundary） */
  formData?: FormData
  /** 内部标记：401 时不触发跳转（登录接口本身失败不该再跳一次） */
  skipUnauthorizedHandler?: boolean
}

async function request<T>(path: string, options: RequestOptions): Promise<T> {
  const headers: Record<string, string> = {}
  const token = getAuthToken()
  if (token) headers.Authorization = `Bearer ${token}`

  let body: BodyInit | undefined
  if (options.formData) {
    body = options.formData
  } else if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json'
    body = JSON.stringify(options.body)
  }

  let response: Response
  try {
    response = await fetch(buildUrl(path, options.query), {
      method: options.method,
      headers,
      body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch (error) {
    // 网络层异常（断网/超时/后端没起来）统一包装，页面只需认 ApiError
    if (error instanceof DOMException && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
      throw new ApiError({
        status: 0,
        code: 'TIMEOUT',
        userMessage: '请求超时，请检查网络后重试',
      })
    }
    throw new ApiError({
      status: 0,
      code: 'NETWORK_ERROR',
      userMessage: '无法连接服务器，请确认后端已启动',
    })
  }

  // 204 或空响应体
  const text = await response.text()
  let payload: unknown = null
  if (text) {
    try {
      payload = JSON.parse(text)
    } catch {
      payload = null
    }
  }

  if (!response.ok) {
    const errBody = (payload ?? {}) as ServerErrorBody

    if (response.status === 401 && !options.skipUnauthorizedHandler) {
      setAuthToken(null)
      unauthorizedHandler?.()
    }

    throw new ApiError({
      status: response.status,
      code: errBody.title || `HTTP_${response.status}`,
      // 后端已经给了中文 message，直接用；没有才兜底
      userMessage: errBody.message || defaultMessageForStatus(response.status),
      detail: errBody.detail ?? null,
      fieldErrors: errBody.errors ?? null,
      requestId: errBody.request_id,
    })
  }

  return payload as T
}

function defaultMessageForStatus(status: number): string {
  switch (status) {
    case 400:
      return '请求参数有误'
    case 403:
      return '没有权限执行此操作'
    case 404:
      return '请求的数据不存在'
    case 409:
      return '数据冲突，请刷新后重试'
    case 413:
      return '内容过大，请压缩后重试'
    case 422:
      return '提交内容未通过校验'
    case 429:
      return '操作过于频繁，请稍后再试'
    case 503:
      return '服务暂时不可用，请稍后重试'
    default:
      return '服务器开小差了，请稍后重试'
  }
}

const http = {
  get: <T>(path: string, query?: Record<string, QueryValue>) =>
    request<T>(path, { method: 'GET', query }),
  post: <T>(path: string, body?: unknown, query?: Record<string, QueryValue>) =>
    request<T>(path, { method: 'POST', body, query }),
  put: <T>(path: string, body?: unknown, query?: Record<string, QueryValue>) =>
    request<T>(path, { method: 'PUT', body, query }),
  del: <T>(path: string, query?: Record<string, QueryValue>) =>
    request<T>(path, { method: 'DELETE', query }),
  upload: <T>(path: string, formData: FormData) =>
    request<T>(path, { method: 'POST', formData }),
}

// ============================================================
// 认证
// ============================================================

export type SmsPurpose = 'register' | 'login' | 'bind'

export interface SendCodeResult {
  success: boolean
  message: string
  ttlSeconds: number
  /** 仅在后端未配置真实短信通道的本地联调模式下返回 */
  devCode?: string
}

export const authApi = {
  sendCode: (phone: string, purpose: SmsPurpose = 'register') =>
    http.post<SendCodeResult>('/auth/send-code', { phone, purpose }),

  register: (data: { phone: string; password: string; code: string; nickname?: string }) =>
    http.post<AuthResponse>('/auth/register', data),

  login: (data: { phone: string; password: string }) =>
    // 登录失败时不要触发全局 401 跳转（本来就在登录页）
    request<AuthResponse>('/auth/login', { method: 'POST', body: data, skipUnauthorizedHandler: true }),

  smsLogin: (data: { phone: string; code: string }) =>
    request<AuthResponse>('/auth/sms-login', { method: 'POST', body: data, skipUnauthorizedHandler: true }),

  logout: () => http.post<{ success: boolean }>('/auth/logout', {}),

  changePassword: (data: { oldPassword: string; newPassword: string }) =>
    http.post<{ success: boolean }>('/auth/change-password', data),

  bindPhone: (data: { phone: string; code: string }) =>
    http.post<{ success: boolean; user: User }>('/auth/bind-phone', data),
}

export interface WechatQr {
  state: string
  /** 真实模式是微信授权链接（前端渲染成二维码）；联调模式是占位串 */
  qrContent: string
  real: boolean
}

export const wechatApi = {
  createQr: () => http.get<WechatQr>('/auth/wechat/qr'),
  poll: (state: string) =>
    http.get<{ status: 'pending' | 'done'; token?: string; user?: User }>('/auth/wechat/state', { state }),
  /** 微信内置浏览器直接授权 */
  authorizeUrl: (redirect?: string) =>
    http.get<{ url: string }>('/auth/wechat/authorize-url', redirect ? { redirect } : undefined),
  /** 未配置真实微信时的联调模拟扫码 */
  devScan: (state: string) => http.post<{ success: boolean }>('/auth/wechat/dev-scan', { state }),
}

export const userApi = {
  getProfile: () => http.get<User>('/user/info'),
  updateProfile: (data: { name?: string; email?: string; avatar?: string }) =>
    http.put<{ success: boolean; user: User }>('/user/info', data),
}

// ============================================================
// 设备
// ============================================================

export const deviceApi = {
  list: () => http.get<{ devices: Device[] }>('/devices'),

  /** 当前操作设备（未指定则用后端记录的 activeDeviceId） */
  current: (deviceId?: string) =>
    http.get<Device>('/device', deviceId ? { deviceId } : undefined),

  /** 凭孩子设备上显示的绑定码认领设备 */
  bind: (data: { deviceCode: string; name?: string }) =>
    http.post<{ success: boolean; alreadyBound: boolean; device: Device }>('/devices/bind', data),

  /**
   * 改名 / 换头像（`PUT /api/devices/:deviceId`）。
   *
   * 同一个接口也负责隐藏桌面图标（contract §9，字段 `hideIcon`）——
   * 它**不是**功能开关：`/api/features` 会以「未知的功能标识」拒绝 `hideIcon`，
   * 只有写 `ChildDevice.hideIcon` 才会随 `/api/agent/config` 下发到设备。
   */
  update: (deviceId: string, data: { name?: string; avatar?: string; hideIcon?: boolean }) =>
    http.put<{ success: boolean; device: Device }>(`/devices/${deviceId}`, data),

  remove: (deviceId: string) => http.del<{ success: boolean }>(`/devices/${deviceId}`),

  select: (deviceId: string) =>
    http.post<{ success: boolean; device: Device }>(`/devices/${deviceId}/select`, {}),
}

// ============================================================
// 指令下发
// ============================================================

export const commandApi = {
  lock: (locked: boolean, deviceId?: string) =>
    http.post<CommandDispatchResult>('/device/lock', { locked }, deviceId ? { deviceId } : undefined),

  tempUnlock: (minutes: number, deviceId?: string) =>
    http.post<CommandDispatchResult>('/device/temp-unlock', { minutes }, deviceId ? { deviceId } : undefined),

  cancelTempUnlock: (deviceId?: string) =>
    http.post<CommandDispatchResult>('/device/cancel-temp-unlock', {}, deviceId ? { deviceId } : undefined),

  takePhoto: (deviceId?: string) =>
    http.post<CommandDispatchResult>('/device/remote-photo', {}, deviceId ? { deviceId } : undefined),

  screenshot: (deviceId?: string) =>
    http.post<CommandDispatchResult>('/device/screenshot', {}, deviceId ? { deviceId } : undefined),

  startRecording: (deviceId?: string) =>
    http.post<CommandDispatchResult>('/device/start-recording', {}, deviceId ? { deviceId } : undefined),

  stopRecording: (recordingId: string, deviceId?: string) =>
    http.post<CommandDispatchResult>('/device/stop-recording', { recordingId }, deviceId ? { deviceId } : undefined),

  startAudio: (deviceId?: string) =>
    http.post<CommandDispatchResult>('/device/start-audio', {}, deviceId ? { deviceId } : undefined),

  stopAudio: (recordingId: string, deviceId?: string) =>
    http.post<CommandDispatchResult>('/device/stop-audio', { recordingId }, deviceId ? { deviceId } : undefined),

  /**
   * 环境监听（contract §6）。
   * 与「远程录音」是两件事：`start_audio` 是一次录音，`start_ambient` 是让设备**持续分段**录，
   * 归到功能开关 `audioRecord` 下（不是 `remoteRecord`）。设备端录音期间会挂常驻通知，
   * 不做隐蔽录音 —— 家长端的文案必须把这点说清楚。
   */
  startAmbient: (deviceId?: string) =>
    http.post<CommandDispatchResult>('/device/start-ambient', {}, deviceId ? { deviceId } : undefined),

  stopAmbient: (deviceId?: string) =>
    http.post<CommandDispatchResult>('/device/stop-ambient', {}, deviceId ? { deviceId } : undefined),

  /**
   * 远程协助动作（contract §7）。
   * 设备端用无障碍服务执行返回 / 回桌面 / 最近任务 / 拉通知栏，`open_app` 需要包名。
   * 无障碍服务没连上时设备会失败并回报，不会假装成功。
   */
  remoteAction: (action: RemoteAction, packageName?: string, deviceId?: string) =>
    http.post<CommandDispatchResult>(
      '/device/remote-action',
      packageName ? { action, packageName } : { action },
      deviceId ? { deviceId } : undefined,
    ),

  /** 让设备重新读取通话记录与短信并上报（contract §8 的 `sync_calls_sms` 指令） */
  syncCallsSms: (deviceId?: string) =>
    http.post<CommandDispatchResult>('/device/sync-calls-sms', {}, deviceId ? { deviceId } : undefined),

  history: (options?: { deviceId?: string; status?: string; limit?: number }) =>
    http.get<{ commands: DeviceCommand[] }>('/device/commands', {
      deviceId: options?.deviceId,
      status: options?.status,
      limit: options?.limit ?? 20,
    }),

  cancel: (commandId: string, deviceId?: string) =>
    http.post<{ command: DeviceCommand; cancelled: boolean }>(
      `/device/commands/${commandId}/cancel`,
      {},
      deviceId ? { deviceId } : undefined,
    ),
}

// ============================================================
// 功能配置
// ============================================================

export const featureApi = {
  get: (deviceId?: string) => http.get<Features>('/features', deviceId ? { deviceId } : undefined),

  set: (feature: string, enabled: boolean, deviceId?: string) =>
    http.put<{ success: boolean }>('/features', { feature, enabled }, deviceId ? { deviceId } : undefined),

  setTimePlan: (dailyLimit: number, deviceId?: string) =>
    http.put<{ success: boolean }>('/features/time-plan', { dailyLimit }, deviceId ? { deviceId } : undefined),

  /**
   * 设置逐应用每日限额。
   *
   * `packageName` 必填：设备端 `GuardRules.matchAppLimit` 是拿前台窗口的包名去匹配规则的，
   * 只传展示名的规则在设备上永远不会触发（历史缺陷：只传 appName → 库里空包名 → 设备丢弃）。
   * 包名要从孩子端上报的应用清单里拿（见 deviceAppApi.list）。
   */
  setAppLimit: (
    appName: string,
    packageName: string,
    limit: number,
    deviceId?: string,
  ) =>
    http.put<{ success: boolean }>(
      '/features/app-limit',
      { appName, packageName, limit },
      deviceId ? { deviceId } : undefined,
    ),

  removeAppLimit: (appName: string, deviceId?: string) =>
    http.del<{ success: boolean }>(
      `/features/app-limit/${encodeURIComponent(appName)}`,
      deviceId ? { deviceId } : undefined,
    ),

  auditApp: (appName: string, approved: boolean, deviceId?: string) =>
    http.post<{ success: boolean }>('/features/app-audit', { appName, approved }, deviceId ? { deviceId } : undefined),

  blockUrl: (url: string, deviceId?: string) =>
    http.post<{ success: boolean; url: string }>('/features/web-block', { url }, deviceId ? { deviceId } : undefined),

  unblockUrl: (url: string, deviceId?: string) =>
    http.del<{ success: boolean }>(
      `/features/web-block/${encodeURIComponent(url)}`,
      deviceId ? { deviceId } : undefined,
    ),
}

// ============================================================
// 答题解锁
// ============================================================

export const quizApi = {
  getConfig: (deviceId?: string) => http.get<QuizConfig>('/quiz/config', deviceId ? { deviceId } : undefined),

  updateConfig: (
    config: {
      enabled?: boolean
      quizType?: string
      questionBank?: string
      grade?: string
      correctRewardMinutes?: number
      randomMode?: boolean
    },
    deviceId?: string,
  ) =>
    http.put<{ success: boolean; config: QuizConfig }>(
      '/quiz/config',
      config,
      deviceId ? { deviceId } : undefined,
    ),

  previewQuestion: (options?: { type?: string; grade?: string; deviceId?: string }) =>
    http.get<QuizQuestion>('/quiz/question', {
      type: options?.type,
      grade: options?.grade,
      deviceId: options?.deviceId,
    }),

  submitAnswer: (questionId: string, answer: number, deviceId?: string) =>
    http.post<QuizAnswerResult>('/quiz/answer', { questionId, answer }, deviceId ? { deviceId } : undefined),

  records: (options?: { limit?: number; type?: string; deviceId?: string }) =>
    http.get<{ records: QuizRecord[] }>('/quiz/records', {
      limit: options?.limit ?? 20,
      type: options?.type,
      deviceId: options?.deviceId,
    }),

  statistics: (deviceId?: string) =>
    http.get<QuizStatistics>('/quiz/statistics', deviceId ? { deviceId } : undefined),
}

// ============================================================
// 位置与安全区
// ============================================================

export const locationApi = {
  list: (options?: { deviceId?: string; limit?: number; from?: string; to?: string }) =>
    http.get<{ locations: LocationPoint[] }>('/locations', {
      deviceId: options?.deviceId,
      limit: options?.limit ?? 50,
      from: options?.from,
      to: options?.to,
    }),

  latest: (deviceId?: string) =>
    http.get<{ location: LocationPoint | null }>('/locations/latest', deviceId ? { deviceId } : undefined),

  listZones: (deviceId?: string) =>
    http.get<{ safeZones: SafeZone[] }>('/safe-zones', deviceId ? { deviceId } : undefined),

  createZone: (
    data: {
      name: string
      latitude: number
      longitude: number
      radiusMeters?: number
      address?: string
      type?: 'home' | 'school' | 'other'
    },
    deviceId?: string,
  ) => http.post<{ success: boolean; safeZone: SafeZone }>('/safe-zones', data, deviceId ? { deviceId } : undefined),

  updateZone: (zoneId: string, data: Partial<Omit<SafeZone, 'id' | 'deviceId' | 'createdAt'>>, deviceId?: string) =>
    http.put<{ success: boolean; safeZone: SafeZone }>(
      `/safe-zones/${zoneId}`,
      data,
      deviceId ? { deviceId } : undefined,
    ),

  removeZone: (zoneId: string, deviceId?: string) =>
    http.del<{ success: boolean }>(`/safe-zones/${zoneId}`, deviceId ? { deviceId } : undefined),
}

// ============================================================
// 锁屏策略与定时时间表
// ============================================================

/**
 * 锁屏强度策略。
 *
 * 注意：`strength` / `countdownSeconds` 是设备端执行锁定时的参数，改这里只改配置，
 * 不会立即锁屏（立即锁屏走 commandApi.lock 的指令队列）。
 */
export const lockPolicyApi = {
  get: (deviceId?: string) => http.get<LockPolicy>('/lock-policy', deviceId ? { deviceId } : undefined),

  update: (
    patch: { strength?: LockPolicy['strength']; countdownSeconds?: number; scheduleEnabled?: boolean },
    deviceId?: string,
  ) =>
    http.put<{ success: boolean; policy: LockPolicy }>(
      '/lock-policy',
      patch,
      deviceId ? { deviceId } : undefined,
    ),
}

/**
 * 定时锁屏 / 解锁时间表。
 *
 * 求值优先级（后端与设备端同一套语义）：命中 `unlock` → 允许使用；
 * 否则命中 `lock` → 锁定；都没命中 → 不因时间表锁定。
 * 返回的 `preview` 按服务器时间计算，真正执行的是孩子设备（以设备本地时钟为准）。
 */
export const scheduleApi = {
  // ---------- 时间表规则 ----------
  list: (deviceId?: string) => http.get<ScheduleListResponse>('/schedules', deviceId ? { deviceId } : undefined),

  create: (data: ScheduleRuleInput, deviceId?: string) =>
    http.post<{ success: boolean; schedule: ScheduleRule }>(
      '/schedules',
      data,
      deviceId ? { deviceId } : undefined,
    ),

  update: (scheduleId: string, data: Partial<ScheduleRuleInput>, deviceId?: string) =>
    http.put<{ success: boolean; schedule: ScheduleRule }>(
      `/schedules/${scheduleId}`,
      data,
      deviceId ? { deviceId } : undefined,
    ),

  remove: (scheduleId: string, deviceId?: string) =>
    http.del<{ success: boolean }>(`/schedules/${scheduleId}`, deviceId ? { deviceId } : undefined),

  // ---------- 锁屏强度策略 ----------
  getPolicy: lockPolicyApi.get,
  updatePolicy: lockPolicyApi.update,
}

// ============================================================
// 媒体
// ============================================================

export const mediaApi = {
  list: (options?: { deviceId?: string; kind?: string; limit?: number }) =>
    http.get<{ media: MediaAsset[] }>('/media', {
      deviceId: options?.deviceId,
      kind: options?.kind,
      limit: options?.limit ?? 50,
    }),

  remove: (mediaId: string) => http.del<{ success: boolean }>(`/media/${mediaId}`),
}

// ============================================================
// 屏幕行为 AI 洞察
// ============================================================

/**
 * 洞察时间线（一个批次 = 一条记录）。
 *
 * 注意 `isAi` / `aiNote`：后端没有配置视觉模型时会降级成「启发式推断」，
 * 界面必须据此明确区分，不能让家长把推断当成 AI 结论。
 */
export const insightApi = {
  list: (options?: {
    deviceId?: string
    limit?: number
    from?: string
    to?: string
    onlyRisky?: boolean
  }) =>
    http.get<InsightListResponse>('/insights', {
      deviceId: options?.deviceId,
      limit: options?.limit ?? 30,
      from: options?.from,
      to: options?.to,
      onlyRisky: options?.onlyRisky ?? false,
    }),

  detail: (insightId: string, deviceId?: string) =>
    http.get<InsightDetail>(`/insights/${insightId}`, deviceId ? { deviceId } : undefined),

  /** 换模型后补跑：清掉旧结论让分析重跑 */
  reanalyze: (insightId: string, deviceId?: string) =>
    http.post<InsightReanalyzeResult>(
      `/insights/${insightId}/reanalyze`,
      {},
      deviceId ? { deviceId } : undefined,
    ),
}

// ============================================================
// 异常提醒
// ============================================================

export const alertApi = {
  list: (options?: {
    deviceId?: string
    type?: UsageAlertType
    unreadOnly?: boolean
    limit?: number
  }) =>
    http.get<UsageAlertListResponse>('/alerts', {
      deviceId: options?.deviceId,
      type: options?.type,
      unreadOnly: options?.unreadOnly ?? false,
      limit: options?.limit ?? 30,
    }),

  markRead: (alertId: string, deviceId?: string) =>
    http.post<UsageAlertReadResult>(
      `/alerts/${alertId}/read`,
      {},
      deviceId ? { deviceId } : undefined,
    ),

  markAllRead: (deviceId?: string) =>
    http.post<UsageAlertReadAllResult>(
      '/alerts/read-all',
      {},
      deviceId ? { deviceId } : undefined,
    ),
}

// ============================================================
// 截屏与 AI 设置
// ============================================================

/**
 * 截屏监控配置。
 *
 * `captureEnabled` 是最高敏感度权限（会周期性把画面送到 AI 服务），
 * 默认关闭；更新接口只接受配置子集，返回值统一挂在 `config` 字段里。
 */
export const screenMonitorApi = {
  get: (deviceId?: string) =>
    http.get<ScreenMonitorConfig>('/screen-monitor', deviceId ? { deviceId } : undefined),

  update: (patch: ScreenMonitorConfigPatch, deviceId?: string) =>
    http.put<ScreenMonitorUpdateResult>(
      '/screen-monitor',
      patch,
      deviceId ? { deviceId } : undefined,
    ),
}

// ============================================================
// 用量上限（玩几局 / 看几集）
// ============================================================

/** 达到上限时后端会自动下发锁屏指令，前端只负责配置与展示用量 */
export const usageBudgetApi = {
  list: (deviceId?: string) =>
    http.get<UsageBudgetListResponse>('/usage-budgets', deviceId ? { deviceId } : undefined),

  /** 同 (kind, appName) 已有记录则更新，没有则新建 */
  upsert: (input: UsageBudgetInput, deviceId?: string) =>
    http.put<UsageBudgetUpsertResult>(
      '/usage-budgets',
      input,
      deviceId ? { deviceId } : undefined,
    ),

  remove: (budgetId: string, deviceId?: string) =>
    http.del<{ success: boolean }>(
      `/usage-budgets/${budgetId}`,
      deviceId ? { deviceId } : undefined,
    ),

  summary: (deviceId?: string) =>
    http.get<UsageSummary>('/usage-summary', deviceId ? { deviceId } : undefined),
}

// ============================================================
// 模式切换（学习模式 / 普通模式）
// ============================================================

/**
 * 设备模式配置（GET/PUT `/api/device-mode`）。
 *
 * `manualMode = null` 表示「跟随时段规划」，此时由 `scheduleEnabled` + 时段格子决定模式；
 * 显式传 `'study'` / `'normal'` 是家长手动锁定模式，时段规划不参与。
 * 求值以**孩子设备本地时钟**为准，`effectiveMode` 只是服务端按服务器时间的推算。
 */
export const deviceModeApi = {
  get: (deviceId?: string) =>
    http.get<DeviceModeState>('/device-mode', deviceId ? { deviceId } : undefined),

  update: (
    patch: { manualMode?: DeviceModeValue | null; scheduleEnabled?: boolean },
    deviceId?: string,
  ) =>
    http.put<DeviceModeUpdateResult>(
      '/device-mode',
      patch,
      deviceId ? { deviceId } : undefined,
    ),
}

/**
 * 学习模式时段格子（0–23 时 × 一周 7 天）。
 *
 * 更新是**整表替换**而不是逐格增删：一次请求要么全成要么全不成，
 * 不会留下「半套规则」这种比没有规则更难排查的状态。最多 168 格。
 */
export const studySlotApi = {
  get: (deviceId?: string) =>
    http.get<StudySlotListResponse>('/study-slots', deviceId ? { deviceId } : undefined),

  replace: (slots: ModeSlot[], deviceId?: string) =>
    http.put<StudySlotReplaceResult>(
      '/study-slots',
      { slots },
      deviceId ? { deviceId } : undefined,
    ),
}

// ============================================================
// 学习模式应用分组
// ============================================================

export const modeAppApi = {
  list: (deviceId?: string) =>
    http.get<ModeAppListResponse>('/mode-apps', deviceId ? { deviceId } : undefined),

  add: (
    data: { packageName: string; appName?: string; group: ModeAppGroup },
    deviceId?: string,
  ) =>
    http.post<ModeAppAddResult>('/mode-apps', data, deviceId ? { deviceId } : undefined),

  remove: (id: string, deviceId?: string) =>
    http.del<{ success: boolean }>(`/mode-apps/${id}`, deviceId ? { deviceId } : undefined),
}

// ============================================================
// 设备已安装应用
// ============================================================

export const deviceAppApi = {
  /**
   * `includeSystem` 只在为 true 时拼进 query。
   * 后端的 `z.coerce.boolean()` 会把字符串 "false" 也判成 true，
   * 所以「不包含系统应用」只能靠**不传参数**表达，不能传 false。
   */
  list: (options?: { deviceId?: string; q?: string; includeSystem?: boolean }) =>
    http.get<DeviceAppListResponse>('/device-apps', {
      deviceId: options?.deviceId,
      q: options?.q,
      includeSystem: options?.includeSystem ? true : undefined,
    }),

  /** 让设备重新上报应用清单（走指令队列，设备在线才会立刻生效） */
  refresh: (deviceId?: string) =>
    http.post<DeviceAppRefreshResult>(
      '/device-apps/refresh',
      {},
      deviceId ? { deviceId } : undefined,
    ),
}

// ============================================================
// 护眼设置
// ============================================================

export const eyeCareApi = {
  get: (deviceId?: string) =>
    http.get<EyeCareGetResponse>('/eye-care', deviceId ? { deviceId } : undefined),

  /** patch 里不能带 `nightEnabled`：它是后端按起止小时算出来的只读字段 */
  update: (patch: EyeCareConfigPatch, deviceId?: string) =>
    http.put<EyeCareUpdateResult>('/eye-care', patch, deviceId ? { deviceId } : undefined),
}

// ============================================================
// 应用插件管控
// ============================================================

export const appPluginApi = {
  list: (deviceId?: string) =>
    http.get<AppPluginListResponse>('/app-plugins', deviceId ? { deviceId } : undefined),

  /** 批量开关（1..200 项）；后端逐项校验插件键，未知键会整批报错而不是静默忽略 */
  update: (items: AppPluginUpdateItem[], deviceId?: string) =>
    http.put<AppPluginUpdateResult>(
      '/app-plugins',
      { items },
      deviceId ? { deviceId } : undefined,
    ),
}

// ============================================================
// 设备事件流（最新动态）
// ============================================================

export const deviceEventApi = {
  list: (options?: { deviceId?: string; page?: number; pageSize?: number }) =>
    http.get<DeviceEventListResponse>('/device-events', {
      deviceId: options?.deviceId,
      page: options?.page ?? 1,
      pageSize: options?.pageSize ?? 20,
    }),
}

// ============================================================
// 通话记录与短信（contract §8）
// ============================================================

export const callSmsApi = {
  /**
   * 通话记录。设备端需要 `READ_CALL_LOG`（Google Play 受限权限），
   * 没授权时设备不会上报，列表就会是空的 —— 页面必须把这点讲清楚，不能说成「没有通话」。
   */
  calls: (options?: { deviceId?: string; page?: number; pageSize?: number }) =>
    http.get<CallLogListResponse>('/calls', {
      deviceId: options?.deviceId,
      page: options?.page ?? 1,
      pageSize: options?.pageSize ?? 20,
    }),

  /** 短信。同样依赖受限权限 `READ_SMS`。 */
  sms: (options?: { deviceId?: string; page?: number; pageSize?: number }) =>
    http.get<SmsListResponse>('/sms', {
      deviceId: options?.deviceId,
      page: options?.page ?? 1,
      pageSize: options?.pageSize ?? 20,
    }),
}

// ============================================================
// 兼容聚合导出（既有页面用 `api.xxx` 的写法可继续使用）
// ============================================================

export const api = {
  // 认证
  sendCode: authApi.sendCode,
  sendVerificationCode: (phone: string) => authApi.sendCode(phone, 'register'),
  register: authApi.register,
  login: authApi.login,
  smsLogin: authApi.smsLogin,
  logout: authApi.logout,
  changePassword: authApi.changePassword,
  bindPhone: authApi.bindPhone,

  // 微信
  wechatQr: wechatApi.createQr,
  wechatPoll: wechatApi.poll,
  wechatAuthorizeUrl: wechatApi.authorizeUrl,
  wechatDevScan: wechatApi.devScan,

  // 用户
  getUserInfo: userApi.getProfile,
  updateUser: userApi.updateProfile,

  // 设备
  getDevices: deviceApi.list,
  getDevice: deviceApi.current,
  bindDevice: deviceApi.bind,
  updateDevice: deviceApi.update,
  deleteDevice: deviceApi.remove,
  selectDevice: deviceApi.select,

  // 指令
  lockScreen: commandApi.lock,
  tempUnlock: commandApi.tempUnlock,
  cancelTempUnlock: commandApi.cancelTempUnlock,
  takePhoto: commandApi.takePhoto,
  screenshot: commandApi.screenshot,
  startRecording: commandApi.startRecording,
  stopRecording: commandApi.stopRecording,
  startAudioRecording: commandApi.startAudio,
  stopAudioRecording: commandApi.stopAudio,
  startAmbient: commandApi.startAmbient,
  stopAmbient: commandApi.stopAmbient,
  remoteAction: commandApi.remoteAction,
  syncCallsSms: commandApi.syncCallsSms,
  getCommands: commandApi.history,
  cancelCommand: commandApi.cancel,

  // 功能
  getFeatures: featureApi.get,
  enableFeature: featureApi.set,
  setTimePlan: featureApi.setTimePlan,
  setAppLimit: featureApi.setAppLimit,
  removeAppLimit: featureApi.removeAppLimit,
  auditApp: featureApi.auditApp,
  blockUrl: featureApi.blockUrl,
  unblockUrl: featureApi.unblockUrl,

  // 答题
  getQuizConfig: quizApi.getConfig,
  updateQuizConfig: quizApi.updateConfig,
  getQuizQuestion: quizApi.previewQuestion,
  submitQuizAnswer: quizApi.submitAnswer,
  getQuizRecords: quizApi.records,
  getQuizStatistics: quizApi.statistics,

  // 位置
  getLocations: locationApi.list,
  getLatestLocation: locationApi.latest,
  getSafeZones: locationApi.listZones,
  createSafeZone: locationApi.createZone,
  updateSafeZone: locationApi.updateZone,
  deleteSafeZone: locationApi.removeZone,

  // 媒体
  getMedia: mediaApi.list,
  deleteMedia: mediaApi.remove,

  // 锁屏策略与定时时间表
  getLockPolicy: scheduleApi.getPolicy,
  updateLockPolicy: scheduleApi.updatePolicy,
  getSchedules: scheduleApi.list,
  createSchedule: scheduleApi.create,
  updateSchedule: scheduleApi.update,
  deleteSchedule: scheduleApi.remove,

  // 屏幕行为 AI 洞察
  getInsights: insightApi.list,
  getInsight: insightApi.detail,
  reanalyzeInsight: insightApi.reanalyze,

  // 异常提醒
  getAlerts: alertApi.list,
  markAlertRead: alertApi.markRead,
  markAllAlertsRead: alertApi.markAllRead,

  // 截屏与 AI 设置
  getScreenMonitorConfig: screenMonitorApi.get,
  updateScreenMonitorConfig: screenMonitorApi.update,

  // 用量上限
  getUsageBudgets: usageBudgetApi.list,
  upsertUsageBudget: usageBudgetApi.upsert,
  deleteUsageBudget: usageBudgetApi.remove,
  getUsageSummary: usageBudgetApi.summary,

  // 模式切换（学习模式 / 普通模式）
  getDeviceMode: deviceModeApi.get,
  updateDeviceMode: deviceModeApi.update,

  // 学习模式时段格子
  getStudySlots: studySlotApi.get,
  replaceStudySlots: studySlotApi.replace,

  // 学习模式应用分组
  getModeApps: modeAppApi.list,
  addModeApp: modeAppApi.add,
  deleteModeApp: modeAppApi.remove,

  // 设备已安装应用
  getDeviceApps: deviceAppApi.list,
  refreshDeviceApps: deviceAppApi.refresh,

  // 护眼设置
  getEyeCare: eyeCareApi.get,
  updateEyeCare: eyeCareApi.update,

  // 应用插件管控
  getAppPlugins: appPluginApi.list,
  updateAppPlugins: appPluginApi.update,

  // 设备事件流
  getDeviceEvents: deviceEventApi.list,

  // 通话记录与短信
  getCallLogs: callSmsApi.calls,
  getSmsMessages: callSmsApi.sms,
}
