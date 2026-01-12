import express from 'express'
import cors from 'cors'
import { readFileSync, writeFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const app = express()
const PORT = 3000

app.use(cors())
app.use(express.json())

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const dbPath = join(__dirname, 'src/mock/db.json')

const db = JSON.parse(readFileSync(dbPath, 'utf-8'))

const saveDb = () => {
  writeFileSync(dbPath, JSON.stringify(db, null, 2))
}

app.get('/api/device', (req, res) => {
  res.json(db.device)
})

app.get('/api/features', (req, res) => {
  res.json(db.features)
})

app.post('/api/device/lock', (req, res) => {
  const { locked } = req.body
  db.device.locked = locked
  db.features.lockScreen.locked = locked
  saveDb()
  res.json({ success: true })
})

app.post('/api/device/temp-unlock', (req, res) => {
  const { minutes } = req.body
  const now = new Date()
  const unlockTime = new Date(now.getTime() + minutes * 60000)
  db.device.tempUnlock = unlockTime.toISOString()
  db.features.tempUnlock.unlockTime = unlockTime.toISOString()
  db.device.locked = false
  db.features.lockScreen.locked = false
  saveDb()
  res.json({ success: true, unlockTime: unlockTime.toISOString() })
})

app.post('/api/device/cancel-temp-unlock', (req, res) => {
  db.device.tempUnlock = null
  db.features.tempUnlock.unlockTime = null
  db.device.locked = true
  db.features.lockScreen.locked = true
  saveDb()
  res.json({ success: true })
})

app.put('/api/features/time-plan', (req, res) => {
  const { dailyLimit } = req.body
  db.features.timePlan.dailyLimit = dailyLimit
  saveDb()
  res.json({ success: true })
})

app.put('/api/features/app-limit', (req, res) => {
  const { appName, limit } = req.body
  db.features.appLimit.apps[appName] = limit
  saveDb()
  res.json({ success: true })
})

app.post('/api/features/app-audit', (req, res) => {
  const { appName, approved } = req.body
  if (approved) {
    db.features.appLimit.apps[appName] = 60
  }
  db.features.appAudit.pendingApps = db.features.appAudit.pendingApps.filter((app: string) => app !== appName)
  saveDb()
  res.json({ success: true })
})

app.post('/api/features/web-block', (req, res) => {
  const { url } = req.body
  if (!db.features.webBlock.blockedUrls.includes(url)) {
    db.features.webBlock.blockedUrls.push(url)
    saveDb()
  }
  res.json({ success: true })
})

app.put('/api/features', (req, res) => {
  const { feature, enabled } = req.body
  if (db.features[feature as keyof typeof db.features]) {
    const featureKey = feature as keyof typeof db.features
    if (typeof db.features[featureKey] === 'object' && 'enabled' in db.features[featureKey]) {
      ;(db.features[featureKey] as { enabled: boolean }).enabled = enabled
      saveDb()
    }
  }
  res.json({ success: true })
})

app.post('/api/device/remote-photo', (req, res) => {
  res.json({ success: true, photoUrl: '/mock-photo.jpg' })
})

app.post('/api/device/start-recording', (req, res) => {
  const recordingId = `rec-${Date.now()}`
  res.json({ success: true, recordingId })
})

app.post('/api/device/stop-recording', (req, res) => {
  res.json({ success: true, videoUrl: '/mock-video.mp4' })
})

app.post('/api/device/start-audio', (req, res) => {
  const recordingId = `audio-${Date.now()}`
  res.json({ success: true, recordingId })
})

app.post('/api/device/stop-audio', (req, res) => {
  res.json({ success: true, audioUrl: '/mock-audio.mp3' })
})

app.get('/api/quiz/config', (req, res) => {
  res.json(db.quizConfig)
})

app.put('/api/quiz/config', (req, res) => {
  const { enabled, quizType, questionBank, correctRewardMinutes, randomMode } = req.body
  db.quizConfig = { enabled, quizType, questionBank, correctRewardMinutes, randomMode }
  db.features.quizUnlock.enabled = enabled
  saveDb()
  res.json({ success: true })
})

app.get('/api/quiz/question', (req, res) => {
  const { type } = req.query
  const quizType = type || db.quizConfig.quizType
  let question

  if (quizType === 'random') {
    const allQuestions = [...db.quizQuestions.english, ...db.quizQuestions.poetry]
    question = allQuestions[Math.floor(Math.random() * allQuestions.length)]
  } else if (db.quizQuestions[quizType as keyof typeof db.quizQuestions]) {
    const questions = db.quizQuestions[quizType as keyof typeof db.quizQuestions] as Array<{ id: string; type: string; question: string; options: string[]; correctAnswer: number }>
    question = questions[Math.floor(Math.random() * questions.length)]
  } else {
    const questions = db.quizQuestions.english
    question = questions[Math.floor(Math.random() * questions.length)]
  }

  res.json(question || { id: '', type: '', question: '', options: [], correctAnswer: 0 })
})

app.post('/api/quiz/answer', (req, res) => {
  const { questionId, answer } = req.body
  let isCorrect = false
  let rewardMinutes = 0

  const allQuestions = [...db.quizQuestions.english, ...db.quizQuestions.poetry]
  const question = allQuestions.find((q: { id: string; type: string; question: string; options: string[]; correctAnswer: number }) => q.id === questionId)

  if (question) {
    isCorrect = question.correctAnswer === answer
    if (isCorrect) {
      rewardMinutes = db.quizConfig.correctRewardMinutes
    }
  }

  const record = {
    id: `record-${Date.now()}`,
    questionId,
    type: question?.type || 'english',
    question: question?.question || '',
    userAnswer: answer,
    isCorrect,
    timestamp: new Date().toISOString(),
    rewardMinutes: isCorrect ? rewardMinutes : undefined
  }

  db.quizRecords.unshift(record)
  saveDb()

  res.json({ success: true, isCorrect, rewardMinutes: isCorrect ? rewardMinutes : undefined })
})

app.get('/api/quiz/records', (req, res) => {
  const limit = parseInt(req.query.limit as string) || 20
  res.json({ records: db.quizRecords.slice(0, limit) })
})

app.get('/api/quiz/statistics', (req, res) => {
  const records = db.quizRecords
  const totalQuestions = records.length
  const correctCount = records.filter((r: { isCorrect: boolean }) => r.isCorrect).length
  const incorrectCount = totalQuestions - correctCount
  const accuracyRate = totalQuestions > 0 ? correctCount / totalQuestions : 0
  const totalRewardMinutes = records.reduce((sum: number, r: { rewardMinutes?: number }) => sum + (r.rewardMinutes || 0), 0)

  const byType: Record<string, { total: number; correct: number; accuracy: number }> = {
    english: { total: 0, correct: 0, accuracy: 0 },
    poetry: { total: 0, correct: 0, accuracy: 0 },
    random: { total: 0, correct: 0, accuracy: 0 }
  }

  records.forEach((r: { type: string; isCorrect: boolean }) => {
    const type = r.type
    if (!byType[type]) return
    byType[type].total++
    if (r.isCorrect) byType[type].correct++
  })

  Object.keys(byType).forEach(type => {
    byType[type].accuracy = byType[type].total > 0 ? byType[type].correct / byType[type].total : 0
  })

  res.json({
    totalQuestions,
    correctCount,
    incorrectCount,
    accuracyRate,
    totalRewardMinutes,
    byType
  })
})

app.listen(PORT, () => {
  console.log(`Mock server running on http://localhost:${PORT}`)
})

const verifyToken = (req: any, res: any, next: () => void) => {
  const authHeader = req.headers.authorization
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, message: '未授权' })
  }
  const token = authHeader.substring(7)
  const user = db.users.find((u: any) => u.id === token.replace('token_', ''))
  if (!user) {
    return res.status(401).json({ success: false, message: '无效的令牌' })
  }
  req.user = user
  next()
}

app.post('/api/auth/send-code', (req, res) => {
  const { phone } = req.body
  console.log(`验证码已发送到: ${phone}`)
  res.json({ success: true })
})

app.post('/api/auth/register', (req, res) => {
  const { phone, password, code, wechatOpenId, wechatNickname, wechatAvatar } = req.body

  const existingUser = db.users.find((u: any) => u.phone === phone)
  if (existingUser) {
    return res.status(400).json({ success: false, message: '手机号已注册' })
  }

  const newUser = {
    id: `user${Date.now()}`,
    name: wechatNickname || '用户',
    phone,
    avatar: wechatAvatar || `https://api.dicebear.com/7.x/avataaars/svg?seed=${phone}`,
    wechatOpenId,
    wechatNickname,
    wechatAvatar,
    createdAt: new Date().toISOString()
  }

  db.users.push(newUser)
  saveDb()

  const token = `token_${newUser.id}`
  res.json({
    success: true,
    token,
    user: {
      id: newUser.id,
      name: newUser.name,
      phone: newUser.phone,
      avatar: newUser.avatar
    }
  })
})

app.post('/api/auth/login', (req, res) => {
  const { phone, password } = req.body

  const user = db.users.find((u: any) => u.phone === phone)
  if (!user) {
    return res.status(400).json({ success: false, message: '用户不存在' })
  }

  const token = `token_${user.id}`
  res.json({
    success: true,
    token,
    user: {
      id: user.id,
      name: user.name,
      phone: user.phone,
      avatar: user.avatar
    }
  })
})

app.post('/api/auth/wechat-login', (req, res) => {
  const { wechatOpenId, wechatNickname, wechatAvatar } = req.body

  let user = db.users.find((u: any) => u.wechatOpenId === wechatOpenId)

  if (!user) {
    user = {
      id: `user${Date.now()}`,
      name: wechatNickname || '微信用户',
      avatar: wechatAvatar || `https://api.dicebear.com/7.x/avataaars/svg?seed=${wechatOpenId}`,
      wechatOpenId,
      wechatNickname,
      wechatAvatar,
      createdAt: new Date().toISOString()
    }
    db.users.push(user)
    saveDb()
  }

  const token = `token_${user.id}`
  res.json({
    success: true,
    token,
    user: {
      id: user.id,
      name: user.name,
      avatar: user.avatar
    }
  })
})

app.post('/api/auth/logout', (req, res) => {
  res.json({ success: true })
})

app.get('/api/user/info', verifyToken, (req: any, res: any) => {
  res.json(req.user)
})

app.put('/api/user/info', verifyToken, (req: any, res: any) => {
  const { name, phone, email, avatar } = req.body

  const userIndex = db.users.findIndex((u: any) => u.id === req.user.id)
  if (userIndex >= 0) {
    if (name) db.users[userIndex].name = name
    if (phone) db.users[userIndex].phone = phone
    if (email) db.users[userIndex].email = email
    if (avatar) db.users[userIndex].avatar = avatar
    saveDb()
    res.json({
      success: true,
      user: {
        id: db.users[userIndex].id,
        name: db.users[userIndex].name,
        phone: db.users[userIndex].phone,
        avatar: db.users[userIndex].avatar
      }
    })
  } else {
    res.status(404).json({ success: false, message: '用户不存在' })
  }
})

app.get('/api/user/devices', verifyToken, (req: any, res: any) => {
  const userDevices = db.devices.filter((d: any) => d.userId === req.user.id)
  res.json({ devices: userDevices })
})

app.post('/api/user/devices', verifyToken, (req: any, res: any) => {
  const { name, model, os, deviceCode } = req.body

  const newDevice = {
    id: `device${Date.now()}`,
    userId: req.user.id,
    name,
    model: model || 'Unknown',
    os: os || 'Unknown',
    battery: 100,
    status: 'online',
    lastActive: '刚刚',
    network: 'wifi',
    locked: false,
    tempUnlock: null,
    avatar: `https://api.dicebear.com/7.x/identicon/svg?seed=${Date.now()}`
  }

  db.devices.push(newDevice)
  db.device = { ...db.device, ...newDevice }
  saveDb()

  res.json({
    success: true,
    device: {
      id: newDevice.id,
      name: newDevice.name,
      model: newDevice.model
    }
  })
})

app.delete('/api/user/devices/:deviceId', verifyToken, (req: any, res: any) => {
  const { deviceId } = req.params

  const device = db.devices.find((d: any) => d.id === deviceId && d.userId === req.user.id)
  if (!device) {
    return res.status(404).json({ success: false, message: '设备不存在' })
  }

  db.devices = db.devices.filter((d: any) => d.id !== deviceId)
  saveDb()

  res.json({ success: true })
})

app.post('/api/user/select-device', verifyToken, (req: any, res: any) => {
  const { deviceId } = req.body

  const device = db.devices.find((d: any) => d.id === deviceId && d.userId === req.user.id)
  if (!device) {
    return res.status(404).json({ success: false, message: '设备不存在' })
  }

  db.device = { ...device }
  saveDb()

  res.json({
    success: true,
    device: {
      id: device.id,
      name: device.name
    }
  })
})

