const API_BASE = 'http://' + location.hostname + ':3000/api'

let currentToken: string | null = null

export const setAuthToken = (token: string | null) => {
  currentToken = token
  if (token) {
    localStorage.setItem('auth_token', token)
  } else {
    localStorage.removeItem('auth_token')
  }
}

export const getAuthToken = () => {
  if (!currentToken) {
    currentToken = localStorage.getItem('auth_token')
  }
  return currentToken
}

export interface Device {
  id: string
  name: string
  model: string
  os: string
  battery: number
  status: string
  lastActive: string
  network: string
  locked: boolean
  tempUnlock: string | null
}

export interface Features {
  lockScreen: { enabled: boolean; locked: boolean }
  tempUnlock: { enabled: boolean; unlockTime: string | null }
  timePlan: { enabled: boolean; dailyLimit: number; usedToday: number }
  appLimit: { enabled: boolean; apps: Record<string, number> }
  appAudit: { enabled: boolean; pendingApps: string[] }
  webBlock: { enabled: boolean; blockedUrls: string[] }
  screenMonitor: { enabled: boolean }
  remoteHelp: { enabled: boolean }
  callSms: { enabled: boolean }
  remotePhoto: { enabled: boolean }
  remoteRecord: { enabled: boolean }
  videoRecord: { enabled: boolean }
  audioRecord: { enabled: boolean }
}

class ApiError extends Error {
  userMessage?: string
  constructor(message: string, userMessage?: string) {
    super(message)
    this.name = 'ApiError'
    this.userMessage = userMessage
  }
}

class ApiService {
  async get<T>(endpoint: string): Promise<T> {
    try {
      const headers: Record<string, string> = {}
      const token = getAuthToken()
      if (token) {
        headers['Authorization'] = `Bearer ${token}`
      }

      const response = await fetch(`${API_BASE}${endpoint}`, {
        headers,
        signal: AbortSignal.timeout(10000),
      })
      if (!response.ok) {
        throw new ApiError(`API Error: ${response.status}`, '获取数据失败，请稍后重试')
      }
      return response.json()
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw new ApiError('Timeout', '请求超时，请检查网络连接')
      }
      throw error
    }
  }

  async post<T>(endpoint: string, data: Record<string, unknown>): Promise<T> {
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      const token = getAuthToken()
      if (token) {
        headers['Authorization'] = `Bearer ${token}`
      }

      const response = await fetch(`${API_BASE}${endpoint}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(data),
        signal: AbortSignal.timeout(10000),
      })
      if (!response.ok) {
        throw new ApiError(`API Error: ${response.status}`, '操作失败，请稍后重试')
      }
      return response.json()
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw new ApiError('Timeout', '请求超时，请检查网络连接')
      }
      throw error
    }
  }

  async put<T>(endpoint: string, data: Record<string, unknown>): Promise<T> {
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      const token = getAuthToken()
      if (token) {
        headers['Authorization'] = `Bearer ${token}`
      }

      const response = await fetch(`${API_BASE}${endpoint}`, {
        method: 'PUT',
        headers,
        body: JSON.stringify(data),
        signal: AbortSignal.timeout(10000),
      })
      if (!response.ok) {
        throw new ApiError(`API Error: ${response.status}`, '操作失败，请稍后重试')
      }
      return response.json()
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw new ApiError('Timeout', '请求超时，请检查网络连接')
      }
      throw error
    }
  }

  async delete<T>(endpoint: string): Promise<T> {
    try {
      const response = await fetch(`${API_BASE}${endpoint}`, {
        method: 'DELETE',
        signal: AbortSignal.timeout(10000),
      })
      if (!response.ok) {
        throw new ApiError(`API Error: ${response.status}`, '操作失败，请稍后重试')
      }
      return response.json()
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw new ApiError('Timeout', '请求超时，请检查网络连接')
      }
      throw error
    }
  }

  async getDevice(): Promise<Device> {
    return this.get<Device>('/device')
  }

  async getFeatures(): Promise<Features> {
    return this.get<Features>('/features')
  }

  async lockScreen(locked: boolean): Promise<{ success: boolean }> {
    return this.post('/device/lock', { locked })
  }

  async tempUnlock(minutes: number): Promise<{ success: boolean; unlockTime: string }> {
    return this.post('/device/temp-unlock', { minutes })
  }

  async cancelTempUnlock(): Promise<{ success: boolean }> {
    return this.post('/device/cancel-temp-unlock', {})
  }

  async setTimePlan(limit: number): Promise<{ success: boolean }> {
    return this.put('/features/time-plan', { dailyLimit: limit })
  }

  async setAppLimit(appName: string, limit: number): Promise<{ success: boolean }> {
    return this.put('/features/app-limit', { appName, limit })
  }

  async auditApp(appName: string, approved: boolean): Promise<{ success: boolean }> {
    return this.post('/features/app-audit', { appName, approved })
  }

  async blockUrl(url: string): Promise<{ success: boolean }> {
    return this.post('/features/web-block', { url })
  }

  async enableFeature(feature: string, enabled: boolean): Promise<{ success: boolean }> {
    return this.put('/features', { feature, enabled })
  }

  async takePhoto(): Promise<{ success: boolean; photoUrl: string }> {
    return this.post('/device/remote-photo', {})
  }

  async startRecording(): Promise<{ success: boolean; recordingId: string }> {
    return this.post('/device/start-recording', {})
  }

  async stopRecording(recordingId: string): Promise<{ success: boolean; videoUrl: string }> {
    return this.post('/device/stop-recording', { recordingId })
  }

  async startAudioRecording(): Promise<{ success: boolean; recordingId: string }> {
    return this.post('/device/start-audio', {})
  }

  async stopAudioRecording(recordingId: string): Promise<{ success: boolean; audioUrl: string }> {
    return this.post('/device/stop-audio', { recordingId })
  }

  async getQuizConfig(): Promise<{
    enabled: boolean
    quizType: string
    questionBank?: string
    correctRewardMinutes: number
    randomMode: boolean
  }> {
    return this.get<{
      enabled: boolean
      quizType: string
      questionBank?: string
      correctRewardMinutes: number
      randomMode: boolean
    }>('/quiz/config')
  }

  async updateQuizConfig(config: {
    enabled: boolean
    quizType: string
    questionBank?: string
    correctRewardMinutes: number
    randomMode: boolean
  }): Promise<{ success: boolean }> {
    return this.put('/quiz/config', config)
  }

  async getQuizQuestion(type?: string): Promise<{
    id: string
    type: string
    question: string
    options: string[]
    correctAnswer: number
    explanation?: string
  }> {
    const endpoint = type ? `/quiz/question?type=${type}` : '/quiz/question'
    return this.get<{
      id: string
      type: string
      question: string
      options: string[]
      correctAnswer: number
      explanation?: string
    }>(endpoint)
  }

  async submitQuizAnswer(questionId: string, answer: number): Promise<{
    success: boolean
    isCorrect: boolean
    rewardMinutes?: number
  }> {
    return this.post('/quiz/answer', { questionId, answer })
  }

  async getQuizRecords(limit?: number): Promise<{
    records: Array<{
      id: string
      questionId: string
      type: string
      question: string
      userAnswer: number
      isCorrect: boolean
      timestamp: string
      rewardMinutes?: number
    }>
  }> {
    const endpoint = limit ? `/quiz/records?limit=${limit}` : '/quiz/records'
    return this.get<{
      records: Array<{
        id: string
        questionId: string
        type: string
        question: string
        userAnswer: number
        isCorrect: boolean
        timestamp: string
        rewardMinutes?: number
      }>
    }>(endpoint)
  }

  async getQuizStatistics(): Promise<{
    totalQuestions: number
    correctCount: number
    incorrectCount: number
    accuracyRate: number
    totalRewardMinutes: number
    byType: {
      english: { total: number; correct: number; accuracy: number }
      poetry: { total: number; correct: number; accuracy: number }
      random: { total: number; correct: number; accuracy: number }
    }
  }> {
    return this.get<{
      totalQuestions: number
      correctCount: number
      incorrectCount: number
      accuracyRate: number
      totalRewardMinutes: number
      byType: {
        english: { total: number; correct: number; accuracy: number }
        poetry: { total: number; correct: number; accuracy: number }
        random: { total: number; correct: number; accuracy: number }
      }
    }>('/quiz/statistics')
  }

  async register(data: {
    phone: string
    password: string
    code?: string
    wechatOpenId?: string
    wechatNickname?: string
    wechatAvatar?: string
  }): Promise<{ success: boolean; token: string; user: { id: string; name: string; phone?: string; avatar?: string } }> {
    return this.post('/auth/register', data)
  }

  async login(data: { phone: string; password: string }): Promise<{ success: boolean; token: string; user: { id: string; name: string; phone?: string; avatar?: string } }> {
    return this.post('/auth/login', data)
  }

  async wechatLogin(wechatOpenId: string, wechatNickname: string, wechatAvatar: string): Promise<{ success: boolean; token: string; user: { id: string; name: string; phone?: string; avatar?: string } }> {
    return this.post('/auth/wechat-login', { wechatOpenId, wechatNickname, wechatAvatar })
  }

  async logout(): Promise<{ success: boolean }> {
    return this.post('/auth/logout', {})
  }

  async getUserInfo(): Promise<{ id: string; name: string; phone?: string; email?: string; avatar?: string; wechatOpenId?: string; wechatNickname?: string; wechatAvatar?: string; createdAt: string }> {
    return this.get('/user/info')
  }

  async updateUser(data: { name?: string; phone?: string; email?: string; avatar?: string }): Promise<{ success: boolean; user: { id: string; name: string; phone?: string; avatar?: string } }> {
    return this.put('/user/info', data)
  }

  async getDevices(): Promise<{ devices: Array<{ id: string; userId: string; name: string; model: string; os: string; battery: number; status: 'online' | 'offline'; lastActive: string; network: string; locked: boolean; tempUnlock: string | null; avatar?: string }> }> {
    return this.get('/user/devices')
  }

  async addDevice(data: { name: string; model: string; os: string; deviceCode: string }): Promise<{ success: boolean; device: { id: string; name: string; model: string } }> {
    return this.post('/user/devices', data)
  }

  async deleteDevice(deviceId: string): Promise<{ success: boolean }> {
    return this.delete(`/user/devices/${deviceId}`)
  }

  async selectDevice(deviceId: string): Promise<{ success: boolean; device: { id: string; name: string } }> {
    return this.post('/user/select-device', { deviceId })
  }

  async sendVerificationCode(phone: string): Promise<{ success: boolean }> {
    return this.post('/auth/send-code', { phone })
  }
}

export const api = new ApiService()
