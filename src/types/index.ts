export interface ChildDevice {
  id: string
  userId: string
  name: string
  model: string
  os: string
  battery: number
  status: 'online' | 'offline'
  lastActive: string
  network: string
  locked: boolean
  tempUnlock: string | null
  avatar?: string
}

export interface User {
  id: string
  name: string
  phone?: string
  email?: string
  avatar?: string
  wechatOpenId?: string
  wechatNickname?: string
  wechatAvatar?: string
  createdAt: string
}

export interface LoginResponse {
  token: string
  user: User
}

export interface RegisterRequest {
  phone: string
  password: string
  code?: string
  wechatOpenId?: string
  wechatNickname?: string
  wechatAvatar?: string
}

export interface LoginRequest {
  phone: string
  password: string
}

export interface Feature {
  id: string
  name: string
  description: string
  icon: string
  type: 'basic' | 'advanced'
  enabled: boolean
}

export interface Location {
  id: string
  latitude: number
  longitude: number
  address: string
  timestamp: string
  type: 'home' | 'school' | 'other'
}

export interface UserProfile {
  id: string
  name: string
  email: string
  phone: string
  avatar?: string
  children: ChildDevice[]
}

export type QuizType = 'english' | 'poetry' | 'random'

export type QuestionBank = 'grade1' | 'grade2' | 'grade3' | 'grade4' | 'grade5' | 'grade6'

export interface QuizConfig {
  enabled: boolean
  quizType: string
  questionBank?: string
  correctRewardMinutes: number
  randomMode: boolean
}

export interface QuizQuestion {
  id: string
  type: QuizType
  question: string
  options: string[]
  correctAnswer: number
  explanation?: string
}

export interface QuizRecord {
  id: string
  childId?: string
  questionId: string
  type: string
  question: string
  userAnswer: number
  isCorrect: boolean
  timestamp: string
  rewardMinutes?: number
}

export interface QuizStatistics {
  totalQuestions: number
  correctCount: number
  incorrectCount: number
  accuracyRate: number
  totalRewardMinutes: number
  recentRecords?: QuizRecord[]
  byType: {
    [key in QuizType]: {
      total: number
      correct: number
      accuracy: number
    }
  }
}
