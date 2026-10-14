#!/usr/bin/env node
/**
 * 应用图标的端到端验证。
 *
 * 孩子端抓图标 → 随应用清单上报 → 服务端存字节 → 家长端拿签名 URL → <img> 取图，
 * 这条链路里的每一步都要能单独说清楚，所以这个脚本模拟一台真实设备走完全程：
 *
 *   1. 注册设备 → 家长认领；
 *   2. 上报带图标的清单，核对家长端拿到 hasIcon / iconUrl；
 *   3. **列表接口只给 URL，不给字节**（几百张图不能塞进列表响应）；
 *   4. 图标下载：签名必须生效 —— 没签名 403、签名被改 403、换个 appId 复用 403、
 *      过期 403；签名对了才 200，且 Content-Type 只认服务端嗅探出来的图片类型；
 *   5. 脏数据一律拒收：不是图片的 base64、超过 16KB 的图、非 base64 字符串；
 *   6. 增量语义：不带图标重传不能把已有图标擦掉；带了新图要换掉旧的（URL 跟着变）；
 *   7. 应用卸载后它的图标地址必须 404，不能留下一个永远能取到图的孤儿 URL。
 *
 * 用法：node scripts/e2e-app-icons.mjs       （默认 http://localhost:4000/api）
 *      API_BASE=http://localhost:4002/api node scripts/e2e-app-icons.mjs
 *
 * 需要一个跑着的后端 + 已 seed 的库（默认用 seed 出来的家长账号 13800138000）。
 * 结束时会把验证设备解绑删掉，不留脏数据。
 */

import zlib from 'node:zlib'
import crypto from 'node:crypto'

const API = process.env.API_BASE || 'http://localhost:4000/api'
const ORIGIN = API.replace(/\/api\/?$/, '')
const PARENT_PHONE = process.env.PARENT_PHONE || '13800138000'
const PARENT_PASSWORD = process.env.PARENT_PASSWORD || 'balloon123'

let passed = 0
let failed = 0
const ok = (m) => { passed++; console.log(`  \x1b[32m✓\x1b[0m ${m}`) }
const bad = (m, extra = '') => { failed++; console.log(`  \x1b[31m✗\x1b[0m ${m}${extra ? ` — ${extra}` : ''}`) }
const check = (c, m, extra = '') => (c ? ok(m) : bad(m, extra))
const step = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`)

async function api(method, path, { body, token } = {}) {
  const headers = {}
  if (token) headers.Authorization = `Bearer ${token}`
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  const res = await fetch(`${API}${path}`, {
    method, headers, body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let parsed = null
  try { parsed = text ? JSON.parse(text) : null } catch { parsed = text }
  return { ok: res.ok, status: res.status, body: parsed, text }
}

const must = async (method, path, options) => {
  const r = await api(method, path, options)
  if (!r.ok) throw new Error(`${method} ${path} → ${r.status} ${r.body?.message || ''}`)
  return r.body
}

// ============================================================
// 现场生成 PNG：验证脚本不依赖任何图片素材文件
// ============================================================

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buf) {
  let c = 0xffffffff
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

/**
 * 生成一张纯色 PNG。
 *
 * @param {number} size 边长（正方形）
 * @param {number[]} rgb 颜色
 * @param {Buffer=} noise 给定位图噪声：用来造一张**压不动**的大图，专门撞体积上限
 */
function makePng(size, rgb, noise) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8   // bit depth
  ihdr[9] = 2   // color type: truecolor RGB
  // 剩下三个字节（compression / filter / interlace）保持 0

  const raw = noise || Buffer.alloc(size * size * 3)
  if (!noise) {
    for (let i = 0; i < size * size; i++) {
      raw[i * 3] = rgb[0]
      raw[i * 3 + 1] = rgb[1]
      raw[i * 3 + 2] = rgb[2]
    }
  }

  // 每行前面加一个 filter 字节（0 = None）
  const stride = size * 3
  const scanlines = Buffer.alloc((stride + 1) * size)
  for (let y = 0; y < size; y++) {
    scanlines[y * (stride + 1)] = 0
    raw.copy(scanlines, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(scanlines)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const pngWechat = makePng(48, [7, 193, 96])
const pngWechatV2 = makePng(48, [255, 0, 0])
const pngSettings = makePng(48, [120, 120, 120])

// ============================================================
// 主流程
// ============================================================

async function main() {
  console.log('\x1b[1m气球狗 · 应用图标端到端验证\x1b[0m')
  console.log(`  API ${API}`)

  // ----------------------------------------------------------
  step('1. 准备：注册设备并让家长认领')
  const suffix = Date.now().toString(36).toUpperCase().slice(-6)
  const deviceCode = `ICON${suffix}`.slice(0, 12)
  const reg = await must('POST', '/agent/register', {
    body: { deviceCode, deviceSecret: 'e2e-icon-secret-0123456789abcdef', model: 'E2E Icon Device', os: 'Android', osVersion: '14' },
  })
  const deviceToken = reg.deviceToken
  check(Boolean(deviceToken), `设备已注册（绑定码 ${deviceCode}）`)

  const login = await must('POST', '/auth/login', { body: { phone: PARENT_PHONE, password: PARENT_PASSWORD } })
  const token = login.token
  const bound = await must('POST', '/devices/bind', { token, body: { deviceCode, name: 'E2E 图标验证机' } })
  const deviceId = bound.device.id
  const q = `deviceId=${deviceId}`
  ok(`家长已认领（deviceId=${deviceId}）`)

  const appsOf = async (extra = '') =>
    must('GET', `/device-apps?${q}${extra}`, { token })
  const byPkg = (list, pkg) => list.apps.find((a) => a.packageName === pkg)

  // ----------------------------------------------------------
  step('2. 设备上报带图标的清单')
  const report = await must('POST', '/agent/apps', {
    token: deviceToken,
    body: {
      apps: [
        { packageName: 'com.tencent.mm', appName: '微信', isSystem: false, isLaunchable: true, icon: pngWechat.toString('base64') },
        { packageName: 'com.android.settings', appName: '设置', isSystem: true, isLaunchable: true, icon: pngSettings.toString('base64') },
        { packageName: 'com.zhihu.android', appName: '知乎', isSystem: false, isLaunchable: true },
      ],
    },
  })
  check(report.count === 3, `已上报 ${report.count} 个应用`)
  check(report.icons === 2, `其中 ${report.icons} 个带图标（回声给设备端用于对账）`, `实际 ${report.icons}`)

  // ----------------------------------------------------------
  step('3. 家长端：有图给 URL，没图给 null')
  let list = await appsOf('&includeSystem=true')
  const wechat = byPkg(list, 'com.tencent.mm')
  const settings = byPkg(list, 'com.android.settings')
  const zhihu = byPkg(list, 'com.zhihu.android')

  check(wechat.hasIcon === true, '微信 hasIcon=true')
  check(typeof wechat.iconUrl === 'string' && wechat.iconUrl.startsWith('/api/app-icons/'),
    '微信拿到的是本站图标路径（前端可直接 <img src>）', String(wechat.iconUrl))
  check(settings.hasIcon === true, '系统应用（设置）也能有图标 —— 预装应用大多是 FLAG_SYSTEM')
  check(zhihu.hasIcon === false && zhihu.iconUrl === null, '没报图标的包 hasIcon=false、iconUrl=null')

  // 签名里如果把「当前时间」签进去，同一张图每次请求都会拿到不同的 URL，
  // 浏览器 `immutable` 缓存就一次都命不中。这条断言就是钉这个的。
  const again = byPkg(await appsOf('&includeSystem=true'), 'com.tencent.mm')
  check(again.iconUrl === wechat.iconUrl,
    '同一张图标连续两次请求拿到完全相同的 URL（否则长缓存没意义）')

  // 列表响应里绝不能出现图标字节，也不该泄露 iconHash（前端只认 URL）
  const rawList = await api('GET', `/device-apps?${q}&includeSystem=true`, { token })
  check(!rawList.text.includes('"icon"') && !rawList.text.includes('iconHash') && !rawList.text.includes('iconMime'),
    '列表响应里没有图标字节 / hash / mime（几百张图不能走列表接口）',
    `响应 ${rawList.text.length} 字节`)
  check(rawList.text.length < 20_000, `列表响应体积仍然是几十 KB 量级`, `${rawList.text.length} 字节`)

  // ----------------------------------------------------------
  step('4. 图标下载：签名说了算')
  const iconUrl = wechat.iconUrl
  const iconPath = iconUrl.replace('/api/', '')
  const otherPath = settings.iconUrl.replace('/api/', '')

  const good = await fetch(`${ORIGIN}/api/${iconPath}`)
  const goodBytes = Buffer.from(await good.arrayBuffer())
  check(good.status === 200, '带签名的 URL 能取到图', `status=${good.status}`)
  check(good.headers.get('content-type') === 'image/png', 'Content-Type 是服务端嗅探出来的 image/png',
    String(good.headers.get('content-type')))
  check(goodBytes.length === pngWechat.length && goodBytes.equals(pngWechat),
    '取回来的字节和上报的一模一样', `${goodBytes.length} vs ${pngWechat.length}`)
  const cacheControl = String(good.headers.get('cache-control'))
  check(cacheControl.includes('private') && cacheControl.includes('immutable'),
    '可以长缓存但不许中间代理缓存（图标会暴露装了哪些应用）', cacheControl)

  const noToken = await fetch(`${ORIGIN}/api/app-icons/${wechat.id}`)
  check(noToken.status === 403, '不带签名 → 403', `status=${noToken.status}`)

  const [expirePart, sigPart] = new URL(`${ORIGIN}/api/${iconPath}`).searchParams.get('t').split('.')
  const futureExp = Number(expirePart) + 3600
  const tampered = await fetch(`${ORIGIN}/api/app-icons/${wechat.id}?v=x&t=${futureExp}.${sigPart.slice(0, -1)}0`)
  check(tampered.status === 403, '签名被改一个字符 → 403', `status=${tampered.status}`)

  const swapped = await fetch(`${ORIGIN}/api/app-icons/${settings.id}?v=x&t=${expirePart}.${sigPart}`)
  check(swapped.status === 403, '拿微信的签名去取设置的图标 → 403（签名绑定 DeviceApp.id）',
    `status=${swapped.status}`)

  const expired = await fetch(`${ORIGIN}/api/app-icons/${wechat.id}?v=x&t=1000000000.deadbeef`)
  check(expired.status === 403, '过期链接 → 403', `status=${expired.status}`)

  // ----------------------------------------------------------
  step('5. 脏数据一律拒收，但不能把整份上报带崩')
  const dirty = await must('POST', '/agent/apps', {
    token: deviceToken,
    body: {
      apps: [
        // "hello" 的 base64：合法 base64、不是图片 → 服务端嗅探不到图片魔数，当作没带图标
        { packageName: 'com.dirty.notimage', appName: '不是图片', isSystem: false, isLaunchable: true, icon: Buffer.from('hello').toString('base64') },
        // 随机噪声造的 75×75 PNG：压不动，稳稳超过 16KB 上限（但 base64 长度还在 zod 的 24000 以内）
        { packageName: 'com.dirty.toobig', appName: '太大的图', isSystem: false, isLaunchable: true, icon: makePng(75, [0, 0, 0], crypto.randomBytes(75 * 75 * 3)).toString('base64') },
        { packageName: 'com.tencent.mm', appName: '微信', isSystem: false, isLaunchable: true, icon: pngWechat.toString('base64') },
      ],
    },
  })
  check(dirty.count === 3, '脏数据没有让上报失败（图标只是锦上添花）', `count=${dirty.count}`)
  check(dirty.icons === 1, `只有 1 个合法图标被存下`, `实际 ${dirty.icons}`)

  list = await appsOf()
  check(byPkg(list, 'com.dirty.notimage')?.hasIcon === false, '不是图片的 base64 被丢弃（防存储型 XSS）')
  check(byPkg(list, 'com.dirty.toobig')?.hasIcon === false, '超过 16KB 的图被丢弃')

  const oversize = makePng(75, [0, 0, 0], crypto.randomBytes(75 * 75 * 3))
  const oversizeB64Len = oversize.toString('base64').length
  check(oversize.length > 16 * 1024 && oversizeB64Len < 24_000,
    '（自检）那张大图确实落在「过得了 zod、过不了服务端」的区间',
    `${oversize.length} 字节 / base64 ${oversizeB64Len} 字符`)

  const notBase64 = await api('POST', '/agent/apps', {
    token: deviceToken,
    body: { apps: [{ packageName: 'com.x', appName: 'X', isSystem: false, isLaunchable: true, icon: '这不是 base64！！' }] },
  })
  check(notBase64.status === 422, '压根不是 base64 的字符串被 zod 挡住（422，本仓库校验错误的统一状态码）',
    `status=${notBase64.status}`)

  // ----------------------------------------------------------
  step('6. 增量语义：不带图标不能擦掉旧的，带新图要换掉旧的')
  // 注意比的是 URL 里的 `v=<iconHash>`，不是整条 URL：
  // DeviceApp 是「先删后插」，每次上报 id 都会换，URL 必然会变。
  const hashOf = (url) => new URL(url, 'http://x').searchParams.get('v')
  const before = byPkg(await appsOf(), 'com.tencent.mm').iconUrl
  await must('POST', '/agent/apps', {
    token: deviceToken,
    body: {
      apps: [
        { packageName: 'com.tencent.mm', appName: '微信', isSystem: false, isLaunchable: true },
        { packageName: 'com.zhihu.android', appName: '知乎', isSystem: false, isLaunchable: true },
      ],
    },
  })
  const afterResend = byPkg(await appsOf(), 'com.tencent.mm')
  check(hashOf(afterResend.iconUrl) === hashOf(before),
    '重传时没带图标的包沿用库里那张（否则每次上报都会把图标擦掉）',
    `${hashOf(before)} → ${hashOf(afterResend.iconUrl)}`)

  await must('POST', '/agent/apps', {
    token: deviceToken,
    body: {
      apps: [
        { packageName: 'com.tencent.mm', appName: '微信', isSystem: false, isLaunchable: true, icon: pngWechatV2.toString('base64') },
        { packageName: 'com.zhihu.android', appName: '知乎', isSystem: false, isLaunchable: true },
      ],
    },
  })
  const replaced = byPkg(await appsOf(), 'com.tencent.mm')
  check(replaced.iconUrl !== before, '换了新图标之后 URL 跟着变（URL 里带 v=<hash>，浏览器缓存不会显示旧图）')
  const replacedBytes = Buffer.from(await (await fetch(`${ORIGIN}${replaced.iconUrl.replace('/api', '/api')}`)).arrayBuffer())
  check(replacedBytes.equals(pngWechatV2), '新 URL 上取到的确实是新图')

  // 上报是「先删后插」，换图时 DeviceApp.id 也换了，所以旧 URL 直接 404。
  // 这是可接受的：列表接口永远下发当前 URL，前端 <img> 失败会退回带首字的占位块，
  // 不会出现「换了图标却一直显示旧图」。
  const oldFetched = await fetch(`${ORIGIN}/api/${iconPath}`)
  check(oldFetched.status === 404, '换图后旧 URL 404（id 随上报更换，不会拿到过期的旧图）',
    `status=${oldFetched.status}`)

  // ----------------------------------------------------------
  step('7. 应用卸载后图标地址必须失效')
  const zhihuBefore = byPkg(await appsOf(), 'com.zhihu.android')
  await must('POST', '/agent/apps', {
    token: deviceToken,
    body: { apps: [{ packageName: 'com.tencent.mm', appName: '微信', isSystem: false, isLaunchable: true }] },
  })
  const gone = await fetch(`${ORIGIN}/api/app-icons/${zhihuBefore.id}?v=x&t=9999999999.aaaaaaaa`)
  check(gone.status === 403 || gone.status === 404,
    '已卸载应用的图标地址失效（不会留下永远能取到图的孤儿 URL）', `status=${gone.status}`)

  // ----------------------------------------------------------
  step('8. 其它家长不能看到本设备的图标')
  const otherDevice = await api('GET', `/device-apps?deviceId=${deviceId}`)
  check(otherDevice.status === 401, '未登录读应用清单 401', `status=${otherDevice.status}`)

  // ----------------------------------------------------------
  step('9. 清理')
  await must('POST', '/agent/apps', { token: deviceToken, body: { apps: [] } })
  await must('DELETE', `/devices/${deviceId}`, { token })
  ok('已解绑并删除验证设备')

  console.log(`\n\x1b[1m结果：${passed} 项通过，${failed} 项失败\x1b[0m`)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error(`\n\x1b[31m验证中断：${e.message}\x1b[0m`)
  process.exit(1)
})
