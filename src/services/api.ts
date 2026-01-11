const API_BASE = 'http://localhost:3000/api'

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
  constructor(message: string, public userMessage?: string) {
    super(message)
    this.name = 'ApiError'
  }
}

class ApiService {
  private getErrorMessage(error: unknown): string {
    if (error instanceof ApiError) {
      return error.userMessage || '操作失败，请稍后重试'
    }
    if (error instanceof TypeError && error.message.includes('fetch')) {
      return '网络连接失败，请检查网络连接'
    }
    if (error instanceof Error) {
      return error.message
    }
    return '操作失败，请稍后重试'
  }

  async get<T>(endpoint: string): Promise<T> {
    try {
      const response = await fetch(`${API_BASE}${endpoint}`, {
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

  async post<T>(endpoint: string, data: any): Promise<T> {
    try {
      const response = await fetch(`${API_BASE}${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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

  async put<T>(endpoint: string, data: any): Promise<T> {
    try {
      const response = await fetch(`${API_BASE}${endpoint}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
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
}

export const api = new ApiService()
