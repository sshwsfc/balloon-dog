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

let db = JSON.parse(readFileSync(dbPath, 'utf-8'))

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
    ;(db.features as any)[feature].enabled = enabled
    saveDb()
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

app.listen(PORT, () => {
  console.log(`Mock server running on http://localhost:${PORT}`)
})
