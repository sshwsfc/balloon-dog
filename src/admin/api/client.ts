/**
 * 管理后台 API client。
 *
 * 与家长端的 `src/services/api.ts` 刻意分开：
 *  - 使用**独立**的 localStorage key 与令牌（两个 SPA 可能同域共存，不能互相顶掉登录态）；
 *  - 401 走自己的事件通道，后台掉线不会影响家长端；
 *  - 后台是表格密集型操作，统一返回分页结构，这里只做请求与错误归一化。
 */

const API_BASE = '/api'
const TOKEN_KEY = 'balloon_dog_admin_token'
const ADMIN_INFO_KEY = 'balloon_dog_admin_info'
const REQUEST_TIMEOUT_MS = 20_000

/** 令牌失效事件名：AdminAuthContext 监听它来自动登出。 */
export const UNAUTHORIZED_EVENT = 'admin:unauthorized'

export class ApiError extends Error {
  readonly status: number
  readonly code: string
  readonly detail: unknown
  readonly fieldErrors: { path: string; message: string }[] | null
  readonly requestId?: string

  constructor(init: {
    status: number
    code: string
    message: string
    detail?: unknown
    fieldErrors?: { path: string; message: string }[] | null
    requestId?: string
  }) {
    super(init.message)
    this.name = 'ApiError'
    this.status = init.status
    this.code = init.code
    this.detail = init.detail ?? null
    this.fieldErrors = init.fieldErrors ?? null
    this.requestId = init.requestId
  }
}

/** 由任意异常产出可展示文案（后端 message 已经是中文短句，直接用）。 */
export function errorMessageOf(error: unknown, fallback = '操作失败，请重试'): string {
  if (error instanceof ApiError) return error.message || fallback
  if (error instanceof Error) {
    if (error.name === 'TimeoutError') return '请求超时，请检查网络后重试'
    if (error.message === 'Failed to fetch') return '无法连接服务器'
    return error.message || fallback
  }
  return fallback
}

// ---------------- 令牌 ----------------

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY)
}
export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token)
}
export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY)
}

export interface StoredAdmin {
  id: number
  username: string
  name: string
  role: string
  status?: string
  lastLoginAt?: string | null
  createdAt?: string | null
}
export function getStoredAdmin(): StoredAdmin | null {
  try {
    const raw = localStorage.getItem(ADMIN_INFO_KEY)
    return raw ? (JSON.parse(raw) as StoredAdmin) : null
  } catch {
    return null
  }
}
export function setStoredAdmin(admin: StoredAdmin): void {
  localStorage.setItem(ADMIN_INFO_KEY, JSON.stringify(admin))
}
export function clearStoredAdmin(): void {
  localStorage.removeItem(ADMIN_INFO_KEY)
}

// ---------------- 请求核心 ----------------

export type QueryValue = string | number | boolean | undefined | null

function buildUrl(path: string, query?: Record<string, QueryValue>): string {
  const url = `${API_BASE}${path}`
  if (!query) return url
  const params = new URLSearchParams()
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null && v !== '') params.append(k, String(v))
  }
  const qs = params.toString()
  return qs ? `${url}?${qs}` : url
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'
  body?: unknown
  query?: Record<string, QueryValue>
  /** 登录接口不需要令牌，也不要触发 401 全局登出 */
  skipAuth?: boolean
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, query, skipAuth = false } = options

  const headers: Record<string, string> = {}
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  if (!skipAuth) {
    const token = getToken()
    if (token) headers.Authorization = `Bearer ${token}`
  }

  let res: Response
  try {
    res = await fetch(buildUrl(path, query), {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch (error) {
    if (error instanceof DOMException && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
      throw new ApiError({ status: 0, code: 'TIMEOUT', message: '请求超时，请检查网络后重试' })
    }
    throw new ApiError({ status: 0, code: 'NETWORK_ERROR', message: '无法连接服务器' })
  }

  const text = await res.text()
  let payload: unknown = null
  if (text) {
    try {
      payload = JSON.parse(text)
    } catch {
      payload = null
    }
  }

  if (!res.ok) {
    const errBody = (payload ?? {}) as {
      title?: string
      message?: string
      detail?: unknown
      errors?: { path: string; message: string }[] | null
      request_id?: string
    }

    // 令牌失效：派发事件让 AdminAuthContext 统一登出（登录接口本身失败不触发）
    if (res.status === 401 && !skipAuth && typeof window !== 'undefined') {
      clearToken()
      clearStoredAdmin()
      window.dispatchEvent(new CustomEvent(UNAUTHORIZED_EVENT))
    }

    throw new ApiError({
      status: res.status,
      code: errBody.title || `HTTP_${res.status}`,
      message: errBody.message || defaultMessage(res.status),
      detail: errBody.detail ?? null,
      fieldErrors: errBody.errors ?? null,
      requestId: errBody.request_id,
    })
  }

  return payload as T
}

function defaultMessage(status: number): string {
  switch (status) {
    case 400:
      return '请求参数有误'
    case 403:
      return '没有权限执行此操作'
    case 404:
      return '数据不存在'
    case 409:
      return '数据冲突，请刷新后重试'
    case 422:
      return '提交内容未通过校验'
    case 429:
      return '操作过于频繁，请稍后再试'
    case 503:
      return '服务暂时不可用'
    default:
      return '服务器开小差了，请稍后重试'
  }
}

// ---------------- 格式化 ----------------

/** 后端 ISO 时间 → YYYY-MM-DD HH:mm（本地时区）。 */
export function formatDateTime(value: unknown): string {
  if (!value) return '—'
  const d = new Date(value as string)
  if (Number.isNaN(d.getTime())) return String(value)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 相对时间：「3 分钟前」；超过 7 天回落成日期。 */
export function formatRelative(value: unknown): string {
  if (!value) return '从未'
  const d = new Date(value as string)
  if (Number.isNaN(d.getTime())) return String(value)
  const diff = Date.now() - d.getTime()
  if (diff < 60_000) return '刚刚'
  const min = Math.floor(diff / 60_000)
  if (min < 60) return `${min} 分钟前`
  const hour = Math.floor(min / 60)
  if (hour < 24) return `${hour} 小时前`
  const day = Math.floor(hour / 24)
  if (day <= 7) return `${day} 天前`
  return formatDateTime(value).slice(0, 10)
}

/** 字节数 → 可读体积。 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)))
  return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

/** 比例（0-1）→ 百分比文本；null 显示破折号而不是 0%。 */
export function formatRate(rate: number | null | undefined, digits = 1): string {
  if (rate === null || rate === undefined || !Number.isFinite(rate)) return '—'
  return `${(rate * 100).toFixed(digits)}%`
}
