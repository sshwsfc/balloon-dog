export interface ChildDevice {
  id: string
  name: string
  model: string
  battery: number
  status: 'online' | 'offline'
  lastActive: string
  avatar?: string
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
