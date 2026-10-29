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
import type { AppPluginListResponse, AppPluginUpdateItem, AppPluginUpdateResult, AuthResponse, CallLogListResponse, Child, ChildDeviceBrief, ChildTask, CommandDispatchResult, ConsentRecordView, ConsentStatus, CreateMembershipOrderResponse, DeletionStatus, Device, DeviceAppListResponse, DeviceAppRefreshResult, DeviceCommand, DeviceEventListResponse, DeviceHealth, DeviceMember, DeviceMemberList, DeviceModeState, DeviceModeUpdateResult, DeviceModeValue, DeviceRole, EyeCareConfigPatch, EyeCareGetResponse, EyeCareUpdateResult, Features, InsightDetail, InsightListResponse, InsightReanalyzeResult, InvoiceResponse, InvoiceView, LocationPoint, LockPolicy, MediaAsset, MembershipOrder, MembershipOrderListResponse, MembershipOverview, MembershipStatus, MembershipTier, ModeAppAddResult, ModeAppGroup, ModeAppListResponse, ModeSlot, NotificationListResponse, NotificationPreferences, NotificationUnreadResponse, PayMembershipOrderResponse, PaymentChannelKey, PaymentIntentResponse, PaymentOrderDetailResponse, PaymentOrderListResponse, PaymentOrderView, PaymentsCatalog, PrivacyCatalog, PrivacyExport, PurchasableTier, QuizAnswerResult, QuizConfig, QuizQuestion, QuizRecord, QuizStatistics, ReferralCoupon, ReferralCouponListResponse, ReferralIdentityResponse, ReferralInvitee, ReferralListResponse, ReferralOverview, ReferralReward, ReferralWithdrawResponse, ReferralWithdrawal, RefundResponse, RemoteAction, SafeZone, ScheduleListResponse, ScheduleRule, ScheduleRuleInput, ScreenMonitorConfig, ScreenMonitorConfigPatch, ScreenMonitorUpdateResult, SmsListResponse, StudySlotListResponse, StudySlotReplaceResult, SupportConfig, SupportTicketView, TimeRequestListResponse, UsageAlertListResponse, UsageAlertReadAllResult, UsageAlertReadResult, UsageAlertType, UsageBudgetInput, UsageBudgetListResponse, UsageBudgetUpsertResult, UsageSummary, User, WithdrawChannel } from '@/types'
import { tt } from '@/i18n'

const API_BASE = '/api'
const TOKEN_KEY = 'balloon_dog_token'
const REQUEST_TIMEOUT_MS = 15_000

/** 后端统一错误体 */
interface ServerErrorBody {
  title?: string
  status?: number
  message?: string
  /** 补充信息，形状随 title（错误码）而定，见 ApiError.detail 的注释 */
  detail?: unknown
  errors?: { path: string; message: string }[] | null
  request_id?: string
}

export class ApiError extends Error {
  readonly status: number
  readonly code: string
  /** 可直接展示给用户的中文提示 */
  readonly userMessage: string
  /**
   * 后端给的补充信息。**形状随 code 而定**（老接口是字符串，
   * MEMBERSHIP_REQUIRED 是 { requiredTier, entitlement, currentTier }），
   * 所以这里刻意是 unknown：要读就先用下面的类型守卫收窄。
   */
  readonly detail: unknown
  readonly fieldErrors: { path: string; message: string }[] | null
  readonly requestId?: string

  constructor(init: {
    status: number
    code: string
    userMessage: string
    detail?: unknown
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
export function toUserMessage(error: unknown, fallback = tt('操作失败，请稍后重试')): string {
  if (error instanceof ApiError) return error.userMessage || fallback
  if (error instanceof Error) {
    if (error.name === 'TimeoutError') return tt('请求超时，请检查网络后重试')
    if (error.name === 'AbortError') return tt('请求已取消')
    if (error.message === 'Failed to fetch') return tt('无法连接服务器，请确认后端已启动')
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
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
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
        userMessage: tt('请求超时，请检查网络后重试'),
      })
    }
    throw new ApiError({
      status: 0,
      code: 'NETWORK_ERROR',
      userMessage: tt('无法连接服务器，请确认后端已启动'),
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
      return tt('请求参数有误')
    case 403:
      return tt('没有权限执行此操作')
    case 404:
      return tt('请求的数据不存在')
    case 409:
      return tt('数据冲突，请刷新后重试')
    case 413:
      return tt('内容过大，请压缩后重试')
    case 422:
      return tt('提交内容未通过校验')
    case 429:
      return tt('操作过于频繁，请稍后再试')
    case 503:
      return tt('服务暂时不可用，请稍后重试')
    default:
      return tt('服务器开小差了，请稍后重试')
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
  /**
   * PATCH：家庭成员改角色用得到（`PATCH /api/devices/:deviceId/members/:memberId`）。
   * 之前只有 get/post/put/del —— 少一个动词时最容易顺手把接口改成 PUT，
   * 那样「只改角色」就变成一个必须提交全字段的更新接口，和其他成员的动作打架。
   */
  patch: <T>(path: string, body?: unknown, query?: Record<string, QueryValue>) =>
    request<T>(path, { method: 'PATCH', body, query }),
  upload: <T>(path: string, formData: FormData) =>
    request<T>(path, { method: 'POST', formData }),
}

// ============================================================
// 认证
// ============================================================

// ============================================================
// 分享提成（邀请返现）
// ============================================================

export const referralApi = {
  /** 邀请返现总览：邀请码/链接、收益统计、阶梯规则、券、提现门槛、活动说明。 */
  overview: () => http.get<ReferralOverview>('/referral'),

  invitees: (options?: { page?: number; pageSize?: number }) =>
    http.get<ReferralListResponse<ReferralInvitee>>('/referral/invitees', {
      page: options?.page ?? 1,
      pageSize: options?.pageSize ?? 20,
    }),

  rewards: (options?: { page?: number; pageSize?: number; status?: string }) =>
    http.get<ReferralListResponse<ReferralReward>>('/referral/rewards', {
      page: options?.page ?? 1,
      pageSize: options?.pageSize ?? 20,
      status: options?.status,
    }),

  coupons: (status?: string) =>
    http.get<ReferralCouponListResponse>('/referral/coupons', { status: status ?? 'all' }),

  /** 下单时能用的券（未使用、未过期）。 */
  usableCoupons: () => http.get<{ success: boolean; coupons: ReferralCoupon[] }>('/referral/coupons/usable'),

  withdrawals: (options?: { page?: number; pageSize?: number }) =>
    http.get<ReferralListResponse<ReferralWithdrawal>>('/referral/withdrawals', {
      page: options?.page ?? 1,
      pageSize: options?.pageSize ?? 20,
    }),

  /** 实名认证。身份证号在服务端只以哈希形式落库。 */
  verifyIdentity: (realName: string, idCard: string) =>
    http.post<ReferralIdentityResponse>('/referral/identity', { realName, idCard }),

  requestWithdrawal: (input: { amountCents?: number; channel: WithdrawChannel; account: string; note?: string }) =>
    http.post<ReferralWithdrawResponse>('/referral/withdrawals', input),
}

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

  // inviteCode 来自分享链接 /login?invite=XXXX；带上它注册即自动绑定邀请关系
  register: (data: { phone: string; password: string; code: string; nickname?: string; inviteCode?: string }) =>
    http.post<AuthResponse>('/auth/register', data),

  login: (data: { phone: string; password: string }) =>
    // 登录失败时不要触发全局 401 跳转（本来就在登录页）
    request<AuthResponse>('/auth/login', { method: 'POST', body: data, skipUnauthorizedHandler: true }),

  smsLogin: (data: { phone: string; code: string; inviteCode?: string }) =>
    request<AuthResponse>('/auth/sms-login', { method: 'POST', body: data, skipUnauthorizedHandler: true }),

  logout: () => http.post<{ success: boolean }>('/auth/logout', {}),

  /**
   * 修改密码。
   *
   * 注意 skipUnauthorizedHandler：「原密码错误」在服务端是 **401**，但这里的 401
   * 不是「令牌失效」，走全局处理会把家长踢回登录页、顺手清掉本地令牌 —— 明明
   * 只是输错了一个框。让它跟登录接口一样自己把错误交给调用方显示。
   */
  changePassword: (data: { oldPassword: string; newPassword: string }) =>
    request<{ success: boolean }>('/auth/change-password', {
      method: 'POST',
      body: data,
      skipUnauthorizedHandler: true,
    }),

  bindPhone: (data: { phone: string; code: string }) =>
    http.post<{ success: boolean; user: User }>('/auth/bind-phone', data),
}

export interface WechatQr {
  state: string
  /** 真实模式是微信授权链接（前端渲染成二维码）；联调模式是占位串 */
  qrContent: string
  real: boolean
}

export interface WechatJsapiSignature {
  appId: string
  timestamp: number
  nonceStr: string
  signature: string
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
  /**
   * 网页 JS-SDK 的 config 签名（「扫一扫」要用）。
   *
   * 必须把**当前页面地址**原样传上去（去 hash）：微信要求签名时用的 url 与调用时
   * 页面的 url 完全一致，差一个 query 都会报 invalid signature。
   */
  jsapiSignature: (url: string) =>
    http.get<WechatJsapiSignature>('/auth/wechat/jsapi-signature', { url }),
}

export const userApi = {
  getProfile: () => http.get<User>('/user/info'),
  updateProfile: (data: { name?: string; email?: string; avatar?: string }) =>
    http.put<{ success: boolean; user: User }>('/user/info', data),
}

// ============================================================
// 设备
// ============================================================

/**
 * 家长端站内通知（规划 §2.1）。
 *
 * 与「设备动态」刻意分开：动态是设备视角的日志流，通知是「需要家长知道并处理的事」。
 * 两者的读者与生命周期都不同，混在一起家长要么被淹没、要么不敢标已读。
 */
export const notificationApi = {
  list: (params?: { page?: number; pageSize?: number; unreadOnly?: boolean; type?: string; level?: string }) => {
    const query = new URLSearchParams()
    if (params?.page) query.set('page', String(params.page))
    if (params?.pageSize) query.set('pageSize', String(params.pageSize))
    if (params?.unreadOnly) query.set('unreadOnly', 'true')
    if (params?.type) query.set('type', params.type)
    if (params?.level) query.set('level', params.level)
    const qs = query.toString()
    return http.get<NotificationListResponse>(`/notifications${qs ? `?${qs}` : ''}`)
  },

  /** 未读角标（首页铃铛用；服务端会顺带跑一次惰性检查，不要拿来高频轮询） */
  unreadCount: () => http.get<NotificationUnreadResponse>('/notifications/unread-count'),

  markRead: (id: string) => http.post<NotificationUnreadResponse>(`/notifications/${id}/read`, {}),

  markAllRead: () => http.post<NotificationUnreadResponse>('/notifications/read-all', {}),

  remove: (id: string) => http.del<NotificationUnreadResponse>(`/notifications/${id}`),

  preferences: () => http.get<NotificationPreferences>('/notifications/preferences'),

  updatePreferences: (preferences: { type: string; inApp: boolean; wechat?: boolean; push?: boolean }[]) =>
    http.put<NotificationPreferences>('/notifications/preferences', { preferences }),

  /**
   * 往微信发一条测试消息（不传 id = 发最近的一条）。
   *
   * 同步返回结果，失败时 `ApiError.userMessage` 里带微信的 errcode 原文 ——
   * 这类问题（模板 ID 不对、字段名不匹配、没关注公众号）只有看到原文才排查得动。
   */
  testWechat: (notificationId?: string) =>
    http.post<{ sent: boolean; notificationId: string }>('/notifications/channels/wechat/test', {
      notificationId,
    }),
}

/**
 * 孩子的申请（规划 §3.1）—— 家长端审批加时 / 延后锁屏。
 *
 * 默认只拉待审批：家长进这个页面就是来处理它们的；要看历史传 status='all'。
 */
export const timeRequestApi = {
  list: (status: 'pending' | 'approved' | 'rejected' | 'all' = 'pending') =>
    http.get<TimeRequestListResponse>(`/device/time-requests?status=${status}`),

  /**
   * 批准或拒绝。`minutes` 只能改小（服务端也按 min(给的值, 申请值) 兜底）：
   * 孩子申请 120 分钟、家长给 30 分钟是常态，而「申请 5 分钟批 240 分钟」只会是误触。
   */
  review: (
    id: string,
    body: { status: 'approved' | 'rejected'; minutes?: number; note?: string },
  ) => http.post<{ success: boolean; grantedMinutes: number }>(`/device/time-requests/${id}/review`, body),
}

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

  /**
   * 家庭成员（规划 §5.1）。
   *
   * `members` 任何成员都能读（只读成员也该知道还有谁在看这台设备）；
   * 邀请 / 改角色 / 移除都只有设备主人能调，服务端会 403。
   */
  members: (deviceId: string) => http.get<DeviceMemberList>(`/devices/${deviceId}/members`),
  inviteMember: (
    deviceId: string,
    data: { phone: string; role?: DeviceRole; nickname?: string },
  ) => http.post<DeviceMember>(`/devices/${deviceId}/members`, data),
  updateMember: (
    deviceId: string,
    memberId: string,
    data: { role?: DeviceRole; nickname?: string },
  ) => http.patch<DeviceMember>(`/devices/${deviceId}/members/${memberId}`, data),
  removeMember: (deviceId: string, memberId: string) =>
    http.del<{ success: boolean }>(`/devices/${deviceId}/members/${memberId}`),

  select: (deviceId: string) =>
    http.post<{ success: boolean; device: Device }>(`/devices/${deviceId}/select`, {}),

  /**
   * 设备健康快照（`GET /api/device/health`）。
   *
   * 读的时候服务端会顺手补记一条「设备失联」动态（6 小时去重窗口），
   * 所以单纯打开健康页也可能产生一条动态 —— 这是有意的：失联值得留在时间线上。
   */
  health: (deviceId?: string) =>
    http.get<DeviceHealth>('/device/health', deviceId ? { deviceId } : undefined),

  /**
   * 让设备立刻体检一次（`POST /api/device/health/check`）。
   *
   * 只是把 `self_check` 指令丢进队列 —— 检测与回报都是设备做的，所以调用方
   * 必须接着轮询 `health()` 的 `updatedAt`，**不要**乐观地把开关置绿。
   */
  healthCheck: (deviceId?: string) =>
    http.post<{ success: boolean; command: DeviceCommand }>(
      '/device/health/check',
      deviceId ? { deviceId } : {},
    ),
}

// ============================================================
// 孩子档案与今日任务（规划 §5.2）
// ============================================================

/**
 * 孩子档案**不是设备作用域的**：它属于家长账号（`Child.userId`），
 * 所以这里的调用都不带 deviceId。设备与孩子的关联走 `setDevices` 整组替换。
 *
 * 档案与任务都只有档案主人能碰 —— 被邀请来看设备的家庭成员（§5.1）看不到
 * 别人家孩子的档案，服务端对越权一律回 404。
 */
export const childrenApi = {
  list: () => http.get<{ children: Child[] }>('/children'),

  create: (data: { name: string; birthYear?: number; school?: string }) =>
    http.post<{ success: boolean; child: Child }>('/children', data),

  update: (childId: string, data: { name?: string; birthYear?: number; school?: string }) =>
    http.patch<{ success: boolean; child: Child }>(`/children/${childId}`, data),

  /** 删档案只会把设备**解绑**（`onDelete: SetNull`），不会删设备 */
  remove: (childId: string) => http.del<{ success: boolean }>(`/children/${childId}`),

  /** 整组替换：传什么就是什么，没列出的设备会被摘下来 */
  setDevices: (childId: string, deviceIds: string[]) =>
    http.put<{ success: boolean; devices: ChildDeviceBrief[] }>(`/children/${childId}/devices`, {
      deviceIds,
    }),

  listTasks: (childId: string, date?: string) =>
    http.get<{ date: string; total: number; done: number; tasks: ChildTask[] }>(
      `/children/${childId}/tasks`,
      date ? { date } : undefined,
    ),

  createTask: (childId: string, data: { title: string; date?: string }) =>
    http.post<{ success: boolean; task: ChildTask }>(`/children/${childId}/tasks`, data),

  updateTask: (childId: string, taskId: string, data: { title?: string; done?: boolean }) =>
    http.patch<{ success: boolean; task: ChildTask }>(
      `/children/${childId}/tasks/${taskId}`,
      data,
    ),

  removeTask: (childId: string, taskId: string) =>
    http.del<{ success: boolean }>(`/children/${childId}/tasks/${taskId}`),
}

// ============================================================
// 合规留痕、导出与注销（规划 §5.3）
// ============================================================

export const supportApi = {
  /**
   * 帮助与反馈的**可用性与写入上限都来自服务端**：分类、提示语、未关闭工单上限（5）、
   * 正文长度上限，以及那个控制入口的灰度开关。前端不自己抄一份枚举。
   */
  config: () => http.get<SupportConfig>('/support/config'),

  create: (data: { category: string; subject: string; body: string; contact?: string; deviceId?: string }) =>
    http.post<{ ticket: SupportTicketView }>('/support/tickets', data),

  list: () => http.get<{ tickets: SupportTicketView[] }>('/support/tickets'),

  detail: (ticketNo: string) => http.get<{ ticket: SupportTicketView }>(`/support/tickets/${ticketNo}`),

  /** 补充信息。已关闭的工单不能再回 —— 否则「关闭」就没有意义了。 */
  reply: (ticketNo: string, body: string) =>
    http.post<{ ticket: SupportTicketView }>(`/support/tickets/${ticketNo}/replies`, { body }),
}

export const privacyApi = {
  /** 文本目录 + 最小必要采集清单（服务端唯一一份，界面不自己抄一份） */
  docs: () => http.get<PrivacyCatalog>('/privacy/docs'),

  consents: () => http.get<{ consents: ConsentStatus[] }>('/privacy/consents'),

  accept: (data: { docType: string; docVersion: string }) =>
    http.post<{ success: boolean; record: ConsentRecordView; created: boolean; needsReaccept: boolean }>(
      '/privacy/consents',
      data,
    ),

  /**
   * 撤回同意。要密码 + 手动打确认文字 —— 因为它**立刻删除设备记录并停止监控**，
   * 不是一个状态位。已经收集的账号数据（孩子档案、订单）不受影响。
   */
  revoke: (consentId: string, data: { password: string; confirm: string }) =>
    http.post<{
      success: boolean
      record: ConsentRecordView
      unboundDevices: number
      stoppedMonitoring: boolean
    }>(`/privacy/consents/${consentId}/revoke`, data),

  deletion: () => http.get<{ deletion: DeletionStatus }>('/privacy/deletion'),

  /** 申请注销：立刻停止监控，7 天冷静期后真的删除 */
  requestDeletion: (data: { password: string; confirm: string }) =>
    http.post<{ success: boolean; deletion: DeletionStatus }>('/privacy/deletion', data),

  cancelDeletion: () => http.del<{ success: boolean; deletion: DeletionStatus }>('/privacy/deletion'),

  /** 导出我的全部数据（媒体文件本身不在里面，见 notes） */
  exportData: () => http.get<PrivacyExport>('/privacy/export'),
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
// 会员 / 充值
// ============================================================

export const membershipApi = {
  /** 会员中心：当前档位 + 每档套餐按这个账号算出来的价格。 */
  overview: () => http.get<MembershipOverview>('/membership'),

  orders: (options?: { page?: number; pageSize?: number }) =>
    http.get<MembershipOrderListResponse>('/membership/orders', {
      page: options?.page ?? 1,
      pageSize: options?.pageSize ?? 20,
    }),

  /**
   * 下单。金额由**服务端**按当前规则算好并快照进订单，
   * 前端传的任何价格都会被忽略 —— 否则改一下请求体就能一分钱开会员。
   */
  createOrder: (planCode: string, payChannel: PaymentChannelKey, couponId?: string) =>
    http.post<CreateMembershipOrderResponse>('/membership/orders', {
      planCode,
      payChannel,
      /** 邀请返现拿到的抵扣券。金额仍由服务端算：券不能超过应付金额，也不会倒找钱。 */
      ...(couponId ? { couponId } : {}),
    }),

  /** 模拟支付。真实接入后这里换成「拉起渠道收银台 + 轮询订单状态」。 */
  payOrder: (orderNo: string, outcome: 'success' | 'fail' = 'success') =>
    http.post<PayMembershipOrderResponse>(`/membership/orders/${orderNo}/pay`, { outcome }),

  cancelOrder: (orderNo: string) =>
    http.post<{ success: boolean; order: MembershipOrder }>(
      `/membership/orders/${orderNo}/cancel`,
    ),

  /** 开启/关闭连续包月。 */
  setAutoRenew: (enabled: boolean) =>
    http.post<{ success: boolean; status: MembershipStatus }>('/membership/auto-renew', { enabled }),
}

export const paymentsApi = {
  /** 渠道目录：现在能用什么、缺哪些环境变量、自助退款窗口多久。 */
  catalog: () => http.get<PaymentsCatalog>('/payments/catalog'),

  /** 自己的订单（支付管线视图：比会员模块多了退款单号 / 发票 / 能不能退）。 */
  myOrders: (options?: { page?: number; pageSize?: number }) =>
    http.get<PaymentOrderListResponse>('/payments/orders', {
      page: options?.page ?? 1,
      pageSize: options?.pageSize ?? 20,
    }),

  /** 单笔订单 + 它的全部渠道交互流水（家长能看到自己这单发生了什么）。 */
  orderDetail: (orderNo: string) =>
    http.get<PaymentOrderDetailResponse>(`/payments/orders/${orderNo}`),

  /**
   * 向渠道发起支付（预支付）。
   *
   * 渠道没配且后端开着模拟支付时，返回的 `payment.mode` 是 `mock`：
   * 界面必须显示「模拟支付」而不是假装二维码能扫。
   */
  createPayment: (orderNo: string) =>
    http.post<PaymentIntentResponse>(`/payments/orders/${orderNo}/pay`, {}),

  /**
   * 主动查单对账。
   *
   * 异步回调会丢（网关抖动、发布重启撞上回调），丢了以后订单就卡在 pending、会员不开。
   * 这个方法让家长端在「二维码弹出来之后」自动去渠道核一次：渠道侧一旦是 SUCCESS
   * 就把钱认下来并结算，结算走的仍是后端与回调同一条 `applyPaidOrder()`。
   */
  syncPayment: (orderNo: string) =>
    http.post<{ success: boolean; order: PaymentOrderView; changed: boolean; tradeState: string; reason: string }>(
      `/payments/orders/${orderNo}/sync`,
      {},
    ),

  /** 自助退款。超过窗口 / 有待处理发票时后端会拒绝，并把原因写成一句人话。 */
  requestRefund: (orderNo: string, reason: string, amountCents?: number) =>
    http.post<RefundResponse>('/payments/refunds', {
      orderNo,
      reason,
      ...(amountCents != null ? { amountCents } : {}),
    }),

  myRefunds: (options?: { page?: number; pageSize?: number }) =>
    http.get<{ success: boolean; refunds: PaymentOrderView[] }>('/payments/refunds', {
      page: options?.page ?? 1,
      pageSize: options?.pageSize ?? 20,
    }),

  /** 申请开票。公司抬头必须给税号（后端 422 会指出是哪个字段）。 */
  requestInvoice: (input: { orderNo: string; title: string; taxNo?: string; email: string }) =>
    http.post<InvoiceResponse>('/payments/invoices', input),

  myInvoices: (options?: { page?: number; pageSize?: number }) =>
    http.get<{ success: boolean; invoices: InvoiceView[] }>('/payments/invoices', {
      page: options?.page ?? 1,
      pageSize: options?.pageSize ?? 20,
    }),
}

/** 会员权益不足（HTTP 403 / MEMBERSHIP_REQUIRED）时后端给的结构。 */
export interface MembershipRequiredDetail {
  requiredTier: PurchasableTier
  entitlement: string
  currentTier: MembershipTier
}

/**
 * 从任意错误里取出「缺哪一项会员权益」。
 *
 * 拿到非 null 就说明这不是 bug，而是该弹升级引导 —— 直接把 message
 * 展示给家长即可（后端已经写成一句人话）。
 */
export function membershipRequiredDetail(error: unknown): MembershipRequiredDetail | null {
  if (!(error instanceof ApiError) || error.code !== 'MEMBERSHIP_REQUIRED') return null
  const detail = error.detail
  if (!detail || typeof detail !== 'object') return null
  const d = detail as Partial<MembershipRequiredDetail>
  const requiredTier = d.requiredTier
  if (requiredTier !== 'member' && requiredTier !== 'super') return null
  return {
    requiredTier,
    entitlement: typeof d.entitlement === 'string' ? d.entitlement : '',
    currentTier:
      d.currentTier === 'member' || d.currentTier === 'super' ? d.currentTier : 'ordinary',
  }
}

/** 是不是「该升级会员」而不是真错误。 */
export function isMembershipRequired(error: unknown): boolean {
  return membershipRequiredDetail(error) !== null
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

  // 设备健康（§1 设备健康可见性）
  getDeviceHealth: deviceApi.health,
  requestDeviceHealthCheck: deviceApi.healthCheck,

  // 站内通知（规划 §2.1）
  getNotifications: notificationApi.list,
  getNotificationUnreadCount: notificationApi.unreadCount,
  testWechatNotification: notificationApi.testWechat,
  readNotification: notificationApi.markRead,
  readAllNotifications: notificationApi.markAllRead,
  deleteNotification: notificationApi.remove,
  getNotificationPreferences: notificationApi.preferences,
  updateNotificationPreferences: notificationApi.updatePreferences,

  // 孩子的申请（§3.1）
  listTimeRequests: timeRequestApi.list,
  reviewTimeRequest: timeRequestApi.review,

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

  // 家庭成员（规划 §5.1）
  getDeviceMembers: deviceApi.members,
  inviteDeviceMember: deviceApi.inviteMember,
  updateDeviceMember: deviceApi.updateMember,
  removeDeviceMember: deviceApi.removeMember,

  // 孩子档案与今日任务（规划 §5.2）
  getChildren: childrenApi.list,
  createChild: childrenApi.create,
  updateChild: childrenApi.update,
  deleteChild: childrenApi.remove,
  setChildDevices: childrenApi.setDevices,
  getChildTasks: childrenApi.listTasks,
  createChildTask: childrenApi.createTask,
  updateChildTask: childrenApi.updateTask,
  deleteChildTask: childrenApi.removeTask,

  // 合规留痕 / 导出 / 注销（规划 §5.3）
  // 客服工单（§5.5）
  getSupportConfig: supportApi.config,
  createSupportTicket: supportApi.create,
  getSupportTickets: supportApi.list,
  getSupportTicket: supportApi.detail,
  replySupportTicket: supportApi.reply,

  getPrivacyDocs: privacyApi.docs,
  getPrivacyConsents: privacyApi.consents,
  acceptPrivacyConsent: privacyApi.accept,
  revokePrivacyConsent: privacyApi.revoke,
  getDeletionStatus: privacyApi.deletion,
  requestAccountDeletion: privacyApi.requestDeletion,
  cancelAccountDeletion: privacyApi.cancelDeletion,
  exportMyData: privacyApi.exportData,

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

  // 会员 / 充值
  getMembership: membershipApi.overview,
  getMembershipOrders: membershipApi.orders,
  paymentCatalog: paymentsApi.catalog,
  paymentOrders: paymentsApi.myOrders,
  paymentOrderDetail: paymentsApi.orderDetail,
  createMembershipOrder: membershipApi.createOrder,
  payMembershipOrder: membershipApi.payOrder,
  cancelMembershipOrder: membershipApi.cancelOrder,
  setMembershipAutoRenew: membershipApi.setAutoRenew,

  // 分享提成
  getReferral: referralApi.overview,
  getReferralInvitees: referralApi.invitees,
  getReferralRewards: referralApi.rewards,
  getReferralCoupons: referralApi.coupons,
  getReferralWithdrawals: referralApi.withdrawals,
  verifyReferralIdentity: referralApi.verifyIdentity,
  requestReferralWithdrawal: referralApi.requestWithdrawal,
}
