#!/usr/bin/env node
/**
 * 浏览器端到端测试（家长端 + 管理后台）。
 *
 * 用 CDP 直接驱动无头 Chrome，不依赖 playwright/puppeteer 等任何 npm 包
 * （用 Node 内置的 fetch 与 WebSocket 与 DevTools 协议通信）。
 *
 * 前置条件：
 *   1. 后端与前端都在跑：npm run dev:all
 *   2. 数据库已灌入演示数据：npm run db:seed
 *
 * 运行：
 *   npm run e2e              # 两套都跑
 *   npm run e2e:parent       # 只跑家长端
 *   npm run e2e:admin        # 只跑管理后台
 *
 * 环境变量：
 *   APP_URL       前端地址，默认 http://localhost:5173
 *   CHROME_PATH   Chrome 可执行文件路径（默认 macOS 上的 Google Chrome）
 *   ADMIN_USER / ADMIN_PASS / ADMIN_OPERATOR_PASS  后台账号（默认取种子数据）
 *
 * ⚠️ 无头 Chrome 需要 --no-sandbox / --disable-breakpad：在受限环境下 Chrome
 * 默认会尝试写 ~/Library/.../Crashpad，被拒绝后会直接 SIGTRAP 退出，
 * 表现为「CDP 连上几秒后 ECONNREFUSED」。脚本里已经加上这些 flag。
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const APP = process.env.APP_URL || 'http://localhost:5173'
const CHROME =
  process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const DEBUG_PORT = Number(process.env.CDP_PORT || 9333)

const PARENT_PHONE = process.env.PARENT_PHONE || '13800138000'
const PARENT_PASSWORD = process.env.PARENT_PASSWORD || 'balloon123'
const ADMIN_USER = process.env.ADMIN_USER || 'admin'
const ADMIN_PASS = process.env.ADMIN_PASS || 'balloon-admin-2026'
const OPERATOR_PASS = process.env.OPERATOR_PASS || 'balloon-operator-2026'

const only = (process.argv.find((a) => a.startsWith('--only=')) || '').split('=')[1]
const runParent = !only || only === 'parent'
const runAdmin = !only || only === 'admin'
const runResponsive = only === 'responsive'

// ============================================================
// 断言与工具
// ============================================================

const results = {
  parent: { pass: 0, fail: 0, failures: [] },
  admin: { pass: 0, fail: 0, failures: [] },
  responsive: { pass: 0, fail: 0, failures: [] },
}
let suite = 'parent'

function check(name, ok, extra = '') {
  const r = results[suite]
  if (ok) {
    r.pass++
    console.log(`  \u001b[32m✓\u001b[0m ${name}`)
  } else {
    r.fail++
    r.failures.push(name)
    console.log(`  \u001b[31m✗\u001b[0m ${name}${extra ? ` — ${extra}` : ''}`)
  }
}
function section(title) {
  console.log(`\n\u001b[1m${title}\u001b[0m`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ============================================================
// CDP 客户端
// ============================================================

class CDP {
  constructor(ws) {
    this.ws = ws
    this.id = 0
    this.pending = new Map()
    this.consoleErrors = []
    this.pageErrors = []
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result)
        return
      }
      if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
        this.consoleErrors.push(msg.params.args.map((a) => a.value ?? a.description ?? '').join(' '))
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        this.pageErrors.push(msg.params.exceptionDetails?.exception?.description ?? '未知异常')
      }
    })
  }

  send(method, params = {}, sessionId) {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      const payload = { id, method, params }
      if (sessionId) payload.sessionId = sessionId
      this.ws.send(JSON.stringify(payload))
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          reject(new Error(`CDP 超时：${method}`))
        }
      }, 10_000)
    })
  }

  async eval(expression) {
    const res = await this.send(
      'Runtime.evaluate',
      { expression, awaitPromise: true, returnByValue: true },
      this.sessionId,
    )
    if (res.exceptionDetails) {
      throw new Error(`页面执行异常：${res.exceptionDetails.exception?.description || '未知'}`)
    }
    return res.result.value
  }

  async goto(path) {
    await this.send('Page.navigate', { url: `${APP}${path}` }, this.sessionId)
  }

  async reload() {
    await this.send('Page.reload', {}, this.sessionId)
  }

  async shot(file) {
    const res = await this.send('Page.captureScreenshot', { format: 'png' }, this.sessionId)
    writeFileSync(file, Buffer.from(res.data, 'base64'))
  }

  /** 用原生 setter 触发 React 的 onChange */
  fill(selector, value) {
    return this.eval(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`)
  }

  clickText(text) {
    return this.eval(`(() => {
      const el = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(text)});
      if (!el) return false;
      el.click();
      return true;
    })()`)
  }

  clearStorage(keys) {
    return this.eval(`(() => { ${keys.map((k) => `localStorage.removeItem(${JSON.stringify(k)});`).join('')} return true; })()`)
  }
}

// ============================================================
// 浏览器生命周期
// ============================================================

async function launchChrome() {
  const profile = mkdtempSync(join(tmpdir(), 'balloon-dog-e2e-'))
  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      `--remote-debugging-port=${DEBUG_PORT}`,
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      '--window-size=420,900',
      '--no-sandbox',
      '--disable-breakpad',
      '--disable-crash-reporter',
      '--disable-dev-shm-usage',
      '--crash-dumps-dir=/tmp/balloon-dog-crashes',
      'about:blank',
    ],
    { stdio: 'ignore' },
  )

  for (let i = 0; i < 80; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`)
      if (res.ok) break
    } catch {
      /* not ready */
    }
    if (i === 79) throw new Error('Chrome DevTools 端口未就绪')
    await sleep(250)
  }

  const { webSocketDebuggerUrl } = await (
    await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`)
  ).json()
  const ws = new WebSocket(webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve)
    ws.addEventListener('error', reject)
  })

  const cdp = new CDP(ws)
  const { targetInfos } = await cdp.send('Target.getTargets')
  const page = targetInfos.find((t) => t.type === 'page')
  if (!page) throw new Error('没有可用的页面 target')
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: page.targetId, flatten: true })
  cdp.sessionId = sessionId

  await cdp.send('Page.enable', {}, sessionId)
  await cdp.send('Runtime.enable', {}, sessionId)
  return { chrome, cdp, ws }
}

// ============================================================
// 家长端
// ============================================================

async function testParent(cdp) {
  suite = 'parent'
  await cdp.send(
    'Emulation.setDeviceMetricsOverride',
    { width: 420, height: 900, deviceScaleFactor: 2, mobile: true },
    cdp.sessionId,
  )

  section('家长端 1. 登录页')
  // 必须先导航到应用域名再动 localStorage —— about:blank 上读取会被浏览器拒绝
  await cdp.goto('/login')
  await sleep(2200)
  await cdp.clearStorage(['balloon_dog_token'])
  await cdp.goto('/login')
  await sleep(2500)
  const title = await cdp.eval(`document.querySelector('h1')?.textContent || ''`)
  check('页面标题渲染为「气球狗」', title.includes('气球狗'), JSON.stringify(title))
  check(
    '登录页不显示底部导航',
    (await cdp.eval(`!!document.querySelector('nav') && document.body.innerText.includes('我的')`)) === false,
  )
  let text = await cdp.eval('document.body.innerText')
  check('提供三种登录方式切换', ['密码登录', '验证码登录', '注册'].every((k) => text.includes(k)))

  section('家长端 2. 密码校验')
  await cdp.fill('input[type="tel"]', PARENT_PHONE)
  await cdp.fill('input[type="password"]', 'definitely-wrong')
  await sleep(300)
  await cdp.clickText('登录')
  await sleep(2200)
  text = await cdp.eval('document.body.innerText')
  check('错误密码被拒绝', (await cdp.eval('location.pathname')) === '/login')
  check('显示后端返回的中文错误（而非 "API Error"）', /手机号或密码错误/.test(text),
    text.slice(0, 160).replace(/\n/g, ' | '))

  section('家长端 3. 登录并加载首页')
  await cdp.fill('input[type="password"]', PARENT_PASSWORD)
  await sleep(300)
  await cdp.clickText('登录')
  await sleep(3500)
  text = await cdp.eval('document.body.innerText')
  check('进入首页', text.includes('设备监控'), text.slice(0, 120).replace(/\n/g, ' | '))
  check('展示真实设备名（来自 PostgreSQL）', text.includes('小明的小米手机'))
  check('展示设备型号', text.includes('Xiaomi 14 Pro'))
  // 首页在「模式/护眼/插件」那一轮改版过：原来的「今日已使用 N 分钟」换成了
  // 「今日使用时长」+ 一个格式化的时长值（可能显示为 1小时35分钟）。
  // 断言跟着新版式走，但**仍然要求是一个真实时长**，不是空占位。
  check(
    '展示今日使用时长（真实时间规划）',
    text.includes('今日使用时长') && /\d+\s*(小时|分钟)/.test(text),
    text.slice(0, 140).replace(/\n/g, ' | '),
  )
  check('展示基础与高级功能分组', text.includes('一键锁屏') && text.includes('远程拍照'))
  check('展示「最近指令」区块', text.includes('最近指令'))
  check('展示指令执行状态', /已完成|等待设备响应|设备执行中|执行失败|已超时/.test(text))
  check('底部导航出现', (await cdp.eval(`!!document.querySelector('nav')`)) === true)

  section('家长端 4. 网址拦截（真实读写）')
  check(
    '打开网址拦截弹窗',
    (await cdp.eval(`(() => {
      const el = [...document.querySelectorAll('button')].find(b => b.innerText.includes('网址拦截'));
      if (!el) return false; el.click(); return true;
    })()`)) === true,
  )
  await sleep(1200)
  text = await cdp.eval('document.body.innerText')
  check('列出已拦截域名', text.includes('gambling.com') || text.includes('adult-example.com'))

  const testDomain = `e2e-${Date.now().toString().slice(-6)}.com`
  await cdp.fill('input[placeholder*="gambling.com"]', testDomain)
  await sleep(200)
  await cdp.clickText('添加')
  await sleep(2200)
  text = await cdp.eval('document.body.innerText')
  check(`新增拦截域名 ${testDomain} 成功`, text.includes(testDomain))

  check(
    '点击删除按钮（原实现只是装饰性图标）',
    (await cdp.eval(`(() => {
      const item = [...document.querySelectorAll('div')].find(d => d.textContent.trim() === ${JSON.stringify(testDomain)});
      const btn = item?.querySelector('button');
      if (!btn) return false; btn.click(); return true;
    })()`)) === true,
  )
  await sleep(2200)
  // 用接口状态判定：删除成功的 toast 里也带着域名，搜文本会误判
  const blocked = await cdp.eval(`(async () => {
    const token = localStorage.getItem('balloon_dog_token');
    const res = await fetch('/api/features', { headers: { Authorization: 'Bearer ' + token } });
    return (await res.json()).webBlock.blockedUrls;
  })()`)
  check(`删除后 ${testDomain} 已从后端移除`, Array.isArray(blocked) && !blocked.includes(testDomain),
    JSON.stringify(blocked))
  await cdp.clickText('关闭')
  await sleep(600)

  section('家长端 5. 其他页面')
  await cdp.goto('/location')
  await sleep(2600)
  text = await cdp.eval('document.body.innerText')
  check('位置页展示真实定位（不再硬编码）', text.includes('位置监控') && text.includes('望京'),
    text.slice(0, 180).replace(/\n/g, ' | '))
  check('位置页按安全区标注类型', /家|学校/.test(text))

  await cdp.goto('/devices')
  await sleep(2600)
  text = await cdp.eval('document.body.innerText')
  check('设备管理页展示已绑定设备与绑定码', text.includes('设备管理') && /绑定码\s+[A-Z0-9]{6,12}/.test(text))

  await cdp.goto('/quiz-unlock')
  await sleep(2600)
  text = await cdp.eval('document.body.innerText')
  check('答题页展示真实配置与统计', text.includes('答题统计') && /总答题数/.test(text))

  await cdp.goto('/profile')
  await sleep(2600)
  text = await cdp.eval('document.body.innerText')
  check('个人中心展示登录用户与手机号', text.includes('张小明') && text.includes(PARENT_PHONE))

  section('家长端 6. 运行时健康度')
  check('没有未捕获的页面异常', cdp.pageErrors.length === 0, cdp.pageErrors.slice(0, 2).join(' | '))
  const ce = cdp.consoleErrors.filter((e) => !/favicon|DevTools|Download the React DevTools/i.test(e))
  check('没有 console error', ce.length === 0, ce.slice(0, 3).join(' | '))

  await cdp.goto('/')
  await sleep(2600)
  await cdp.shot('/tmp/balloon-dog-parent-home.png')
  console.log('\n📸 家长端截图：/tmp/balloon-dog-parent-home.png')
}

// ============================================================
// 管理后台
// ============================================================

async function testAdmin(cdp) {
  suite = 'admin'
  cdp.consoleErrors.length = 0
  cdp.pageErrors.length = 0
  await cdp.send(
    'Emulation.setDeviceMetricsOverride',
    { width: 1440, height: 960, deviceScaleFactor: 1, mobile: false },
    cdp.sessionId,
  )

  section('后台 1. 未登录守卫')
  await cdp.goto('/admin/login')
  await sleep(2200)
  await cdp.clearStorage(['balloon_dog_admin_token', 'balloon_dog_admin_info'])
  await cdp.goto('/admin')
  await sleep(2800)
  let text = await cdp.eval('document.body.innerText')
  check('未登录访问 /admin 重定向到 /admin/login', (await cdp.eval('location.pathname')) === '/admin/login')
  check('渲染后台登录页', text.includes('管理后台登录'))
  check('说明与家长端账号体系独立', text.includes('家长账号无法登录'))

  await cdp.fill('#username', PARENT_PHONE)
  await cdp.fill('#password', PARENT_PASSWORD)
  await cdp.clickText('登录')
  await sleep(2200)
  text = await cdp.eval('document.body.innerText')
  check('家长账号无法登录后台', /账号或密码错误/.test(text), text.slice(0, 160).replace(/\n/g, ' | '))

  section('后台 2. 管理员登录')
  await cdp.fill('#username', ADMIN_USER)
  await cdp.fill('#password', 'wrong-password')
  await cdp.clickText('登录')
  await sleep(2000)
  text = await cdp.eval('document.body.innerText')
  check('错误密码被拒并给出中文提示', /账号或密码错误/.test(text))

  await cdp.fill('#password', ADMIN_PASS)
  await cdp.clickText('登录')
  await sleep(3200)
  text = await cdp.eval('document.body.innerText')
  const url = await cdp.eval('location.pathname')
  check('登录成功进入数据看板', url === '/admin' || url === '/admin/', `实际 ${url}`)
  check('展示核心 KPI', ['家长账号', '孩子设备', '累计指令', '指令成功率'].every((k) => text.includes(k)))
  check('展示趋势区块', text.includes('新增家长账号') && text.includes('指令下发量'))
  check('侧栏含「管理员」菜单（超级管理员可见）', text.includes('管理员'))
  check('显示当前登录身份', text.includes('超级管理员'))

  section('后台 3. 功能页面')
  const pages = [
    ['/admin/users', ['家长账号', '全部状态'], '家长账号'],
    ['/admin/devices', ['设备管理', '绑定状态'], '设备管理'],
    ['/admin/commands', ['指令监控', '只看失败'], '指令监控'],
    ['/admin/questions', ['题库管理', '新增题目'], '题库管理'],
    ['/admin/quiz-records', ['答题记录'], '答题记录'],
    ['/admin/sms-codes', ['验证码审计'], '验证码审计'],
    ['/admin/logs', ['操作日志'], '操作日志'],
    ['/admin/settings', ['账号设置'], '账号设置'],
  ]
  for (const [path, keywords, label] of pages) {
    await cdp.goto(path)
    await sleep(2600)
    const t = await cdp.eval('document.body.innerText')
    check(`${label}页渲染正常`, keywords.every((k) => t.includes(k)), t.slice(0, 140).replace(/\n/g, ' | '))
  }

  await cdp.goto('/admin/users')
  await sleep(2800)
  text = await cdp.eval('document.body.innerText')
  check('家长账号列表显示演示账号', text.includes('张小明') || text.includes(PARENT_PHONE))

  await cdp.goto('/admin/questions')
  await sleep(2800)
  text = await cdp.eval('document.body.innerText')
  check('题库显示年级分布', /一年级|二年级|三年级/.test(text))

  section('后台 4. 详情弹窗')
  await cdp.goto('/admin/commands')
  await sleep(2800)
  check(
    '指令列表可打开详情',
    (await cdp.eval(`(() => {
      const btn = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === '详情');
      if (!btn) return false; btn.click(); return true;
    })()`)) === true,
  )
  await sleep(1200)
  text = await cdp.eval('document.body.innerText')
  check('详情展示指令参数与设备回报', text.includes('指令参数') && text.includes('设备回报'))
  await cdp.clickText('关闭')
  await sleep(600)

  section('后台 5. 深层路由刷新（history fallback）')
  await cdp.goto('/admin/devices')
  await sleep(2600)
  await cdp.reload()
  await sleep(3000)
  check(
    '刷新 /admin/devices 不 404 且保持登录',
    (await cdp.eval('location.pathname')) === '/admin/devices' &&
      (await cdp.eval('document.body.innerText')).includes('设备管理'),
  )

  section('后台 6. 操作日志')
  await cdp.goto('/admin/logs')
  await sleep(2800)
  text = await cdp.eval('document.body.innerText')
  check('日志显示操作人与来源 IP', text.includes('admin') && /127\.0\.0\.1|::1|::ffff/.test(text),
    text.slice(0, 200).replace(/\n/g, ' | '))
  // 最新 30 条未必含登录记录（冒烟测试会产生大量请求），用搜索过滤并顺带验证搜索
  await cdp.fill('input[placeholder*="搜索操作描述"]', '登录')
  await sleep(2200)
  text = await cdp.eval('document.body.innerText')
  check('可通过搜索定位到管理员登录记录', text.includes('管理员登录'), text.slice(0, 220).replace(/\n/g, ' | '))
  await cdp.fill('input[placeholder*="搜索操作描述"]', '')
  await sleep(1200)

  section('后台 7. 运营账号权限差异')
  await cdp.clearStorage(['balloon_dog_admin_token', 'balloon_dog_admin_info'])
  await cdp.goto('/admin/login')
  await sleep(2600)
  await cdp.fill('#username', 'operator')
  await cdp.fill('#password', OPERATOR_PASS)
  await cdp.clickText('登录')
  await sleep(3200)
  text = await cdp.eval('document.body.innerText')
  check('运营账号可登录', text.includes('数据看板'), text.slice(0, 140).replace(/\n/g, ' | '))
  check('运营账号不见管理员管理功能', !text.includes('新建管理员'))
  await cdp.goto('/admin/admins')
  await sleep(2600)
  const opUrl = await cdp.eval('location.pathname')
  check('运营账号直接访问 /admin/admins 被弹回看板', opUrl === '/admin' || opUrl === '/admin/',
    `实际 ${opUrl}`)

  section('后台 8. 运行时健康度')
  check('没有未捕获的页面异常', cdp.pageErrors.length === 0, cdp.pageErrors.slice(0, 2).join(' | '))
  const ce = cdp.consoleErrors.filter((e) => !/favicon|DevTools|Download the React DevTools/i.test(e))
  check('没有 console error', ce.length === 0, ce.slice(0, 3).join(' | '))

  // 恢复超管登录并截图
  await cdp.clearStorage(['balloon_dog_admin_token', 'balloon_dog_admin_info'])
  await cdp.goto('/admin/login')
  await sleep(2200)
  await cdp.fill('#username', ADMIN_USER)
  await cdp.fill('#password', ADMIN_PASS)
  await cdp.clickText('登录')
  await sleep(3400)
  await cdp.shot('/tmp/balloon-dog-admin-dashboard.png')
  await cdp.goto('/admin/users')
  await sleep(2800)
  await cdp.shot('/tmp/balloon-dog-admin-users.png')
  console.log('\n📸 后台截图：/tmp/balloon-dog-admin-dashboard.png、/tmp/balloon-dog-admin-users.png')
}

// ============================================================
// 主流程
// ============================================================

// ============================================================
// 响应式验证：多种视口下的布局体检
// ============================================================

/**
 * 视口矩阵。
 *
 * 「横屏手机」是最容易被忽略、也最容易做坏的一档：宽 844 而高只有 390，
 * 横向像平板、纵向像小屏，通栏拉伸和「底部导航吃掉十分之一屏」都会在这里现形。
 */
const RESPONSIVE_VIEWPORTS = [
  { name: '竖屏手机 390×844', width: 390, height: 844, mobile: true },
  { name: '横屏手机 844×390', width: 844, height: 390, mobile: true },
  { name: '平板横屏 1180×820', width: 1180, height: 820, mobile: false },
  { name: '桌面 1440×900', width: 1440, height: 900, mobile: false },
  { name: '超宽屏 1920×1080', width: 1920, height: 1080, mobile: false },
]

const RESPONSIVE_ROUTES = [
  { path: '/', wide: true, must: '一键锁屏' },
  { path: '/location', wide: false, must: '位置' },
  { path: '/profile', wide: false, must: '我的' },
  { path: '/schedule', wide: false, must: '锁屏' },
  { path: '/insights', wide: true, must: '洞察' },
  { path: '/mode', wide: false, must: '模式' },
  { path: '/mode/schedule', wide: false, must: '时段' },
  { path: '/mode/apps', wide: true, must: '应用' },
  { path: '/eye-care', wide: false, must: '护眼' },
  { path: '/app-plugins', wide: true, must: '插件' },
  { path: '/app-audit', wide: false, must: '审批' },
  // /media 与 /quiz-unlock 是沉浸式页面：**故意**不显示任何导航，
  // 所以不对它们断言导航形态（否则测的是「怎么没导航」这种伪问题）。
  { path: '/quiz-unlock', wide: false, must: '答题', immersive: true },
  { path: '/devices', wide: false, must: '设备' },
  { path: '/media', wide: false, must: '', immersive: true },
]

/** 页头到 1024px 才出现侧栏，与 BottomNav 里的约定必须一致。 */
const SIDEBAR_BREAKPOINT = 1024

/**
 * 找出横向溢出的元素。
 *
 * 为什么不只看 `document.documentElement.scrollWidth`：应用在 body 上设了
 * `overflow-x: hidden`，横向溢出会被**藏起来**而不是消失 —— 只看 scrollWidth
 * 会让这类问题全部漏检，而那些被裁掉的内容恰恰是用户永远看不到的。
 * 所以这里逐个元素量右边界。
 */
const OVERFLOW_PROBE = `(() => {
  const vw = window.innerWidth;
  const bad = [];

  // 祖先里如果有「横向可滚动且确实滚得动」的容器（例如筛选条 chips），
  // 里面的元素超出视口是**设计如此**，不算溢出。
  // 不加这条会误报一片，把真正的问题淹掉。
  const inScroller = (el) => {
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      const cs = getComputedStyle(p);
      if ((cs.overflowX === 'auto' || cs.overflowX === 'scroll')
          && p.scrollWidth > p.clientWidth + 1) return true;
    }
    return false;
  };

  for (const el of document.querySelectorAll('body *')) {
    if (el.closest('[data-sonner-toaster]')) continue;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    if (r.right > vw + 1 || r.left < -1) {
      if (inScroller(el)) continue;
      const cls = (typeof el.className === 'string' ? el.className : '').slice(0, 50);
      bad.push(el.tagName.toLowerCase() + (cls ? '.' + cls.split(' ')[0] : '')
        + ' [' + Math.round(r.left) + '..' + Math.round(r.right) + ']');
      if (bad.length >= 3) break;
    }
  }
  return bad;
})()`;

/**
 * 量标题栏：它必须**铺满整个可用宽度**，而标题文字仍与内容列对齐。
 *
 * 这是用户明确提的要求（「标题栏应该始终是 width 100%」）。
 * 改之前 .page-shell 的 padding-inline 把白底页头一起挤窄了，
 * 桌面上那条白条只从内容列开始，看着像没铺满。
 */
const HEADER_PROBE = `(() => {
  const shell = document.querySelector('.page-shell');
  const header = shell && shell.querySelector(':scope > .page-header');
  if (!shell || !header) return null;
  const s = shell.getBoundingClientRect();
  const h = header.getBoundingClientRect();
  const cs = getComputedStyle(shell);
  const pad = parseFloat(cs.paddingLeft) || 0;
  return {
    shellLeft: Math.round(s.left), shellRight: Math.round(s.right),
    headerLeft: Math.round(h.left), headerRight: Math.round(h.right),
    shellWidth: Math.round(s.width), headerWidth: Math.round(h.width),
    contentWidth: Math.round(s.width - pad * 2),
    pad: Math.round(pad),
    viewport: window.innerWidth,
  };
})()`;

/** 量当前页面的内容列：左右内边距是否对称、内容是否被限宽。 */
const COLUMN_PROBE = `(() => {
  const shell = document.querySelector('.page-shell');
  if (!shell) return null;
  const cs = getComputedStyle(shell);
  const padL = parseFloat(cs.paddingLeft) || 0;
  const padR = parseFloat(cs.paddingRight) || 0;
  return {
    padL: Math.round(padL),
    padR: Math.round(padR),
    contentWidth: Math.round(shell.clientWidth - padL - padR),
    viewport: window.innerWidth,
  };
})()`;

async function testResponsive(cdp) {
  suite = 'responsive'
  section('响应式 · 登录')
  await cdp.send(
    'Emulation.setDeviceMetricsOverride',
    { width: 390, height: 844, deviceScaleFactor: 2, mobile: true },
    cdp.sessionId,
  )
  await cdp.goto('/login')
  await sleep(2200)
  await cdp.clearStorage(['balloon_dog_token'])
  await cdp.goto('/login')
  await sleep(2000)
  await cdp.fill('input[type="tel"]', PARENT_PHONE)
  await cdp.fill('input[type="password"]', PARENT_PASSWORD)
  await sleep(300)
  await cdp.clickText('登录')
  await sleep(3500)
  check('响应式套件已登录', (await cdp.eval('location.pathname')) === '/')

  const problems = []
  /** 各视口下首页内容列的实测值，最后打印出来作为「确实限宽了」的证据。 */
  const columnEvidence = []

  for (const vp of RESPONSIVE_VIEWPORTS) {
    // 每一档视口都跑完整套路由：横屏与桌面是本次的重点，不能抽样
    const routes = RESPONSIVE_ROUTES
    let vpPass = 0
    section(`响应式 · ${vp.name}（${routes.length} 个页面）`)

    await cdp.send(
      'Emulation.setDeviceMetricsOverride',
      { width: vp.width, height: vp.height, deviceScaleFactor: 1, mobile: vp.mobile },
      cdp.sessionId,
    )
    await sleep(400)

    for (const route of routes) {
      await cdp.goto(route.path)
      await sleep(vp.mobile ? 1400 : 1100)

      const label = `${vp.name} ${route.path}`

      // 1) 不能有元素横向溢出视口
      const overflow = await cdp.eval(OVERFLOW_PROBE)
      if (overflow && overflow.length) {
        problems.push(`${label} 横向溢出：${overflow.join(' / ')}`)
      } else {
        vpPass++
      }

      // 2) 宽屏下内容必须居中限宽；窄屏下不应出现莫名留白
      const col = await cdp.eval(COLUMN_PROBE)
      if (col) {
        if (vp.width >= 768) {
          // 要断言的是「内容被限宽且左右对称」。
          // 不再要求 padL 一定 > 0：≥1024px 时左侧栏已经占掉 224px，
          // 剩余宽度可能正好等于上限（1180-224=956 ≈ 60rem=960），此时不该有额外留白。
          // 真正的病是「通栏拉伸」，而 bounded 已经把它挡住了。
          const symmetric = Math.abs(col.padL - col.padR) <= 1
          const bounded = col.contentWidth <= (route.wide ? 60 * 16 : 48 * 16) + 2
          if (!(symmetric && bounded)) {
            problems.push(
              `${label} 内容列异常：padL=${col.padL} padR=${col.padR} `
              + `content=${col.contentWidth}（应左右对称且不超过 ${route.wide ? 60 : 48}rem）`,
            )
          } else {
            vpPass++
          }
        } else if (col.padL !== 0 || col.padR !== 0) {
          problems.push(`${label} 窄屏不该有左右留白：padL=${col.padL} padR=${col.padR}`)
        } else {
          vpPass++
        }
      }

      // 顺手留几张截图：断言只证明「没有溢出」，证明不了「好不好看」。
      // 布局类改动必须用眼睛过一遍，这里把关键页面 × 关键视口落盘。
      const SHOT_ROUTES = ['/', '/mode/schedule', '/app-plugins']
      const SHOT_VIEWPORTS = ['横屏手机 844×390', '桌面 1440×900']
      if (SHOT_ROUTES.includes(route.path) && SHOT_VIEWPORTS.includes(vp.name)) {
        const slug = route.path === '/' ? 'home' : route.path.replace(/\//g, '-').replace(/^-/, '')
        const vpSlug = vp.name.includes('横屏') ? 'landscape' : 'desktop'
        try {
          await cdp.shot(`/tmp/resp-${slug}-${vpSlug}.png`)
        } catch {
          // 截图失败不影响断言
        }
      }

      // 3) 记下首页的内容列实测值 —— 让「确实限了宽」这件事在输出里看得见，
      //    而不是只留下一句「通过」。测试通过但说不出量到了什么，是不可信的。
      if (route.path === '/') {
        columnEvidence.push({ viewport: vp.name, width: vp.width, col })
      }

      // 4) 标题栏必须铺满整个可用宽度
      const header = await cdp.eval(HEADER_PROBE)
      if (header) {
        const flush = Math.abs(header.headerLeft - header.shellLeft) <= 1
          && Math.abs(header.headerRight - header.shellRight) <= 1
        if (!flush) {
          problems.push(
            `${label} 标题栏没铺满：shell=[${header.shellLeft}..${header.shellRight}] `
            + `header=[${header.headerLeft}..${header.headerRight}]`,
          )
        } else if (header.pad > 8 && header.headerWidth < header.contentWidth + 8) {
          // 只有在**确实存在留白**时才要求标题栏比内容列宽。
          // pad=0 的视口（例如 1180px 平板：可用 956px 已经小于 --wide 的 960px 上限）
          // 本来就无处可铺，此时 headerWidth === contentWidth 是正确的，不是 bug。
          problems.push(
            `${label} 标题栏宽度与内容列相同（${header.headerWidth}px），负 margin 未生效`,
          )
        } else {
          vpPass++
        }
      } else {
        vpPass++ // 该页面没有标题栏
      }

      // 5) 导航形态必须与断点一致
      const nav = await cdp.eval(`(() => {
        const bars = [...document.querySelectorAll('nav')];
        const bottom = bars.find(n => n.className.includes('fixed bottom-0'));
        const side = bars.find(n => n.className.includes('h-screen w-56'));
        const visible = (el) => !!el && getComputedStyle(el).display !== 'none';
        return { bottom: visible(bottom), side: visible(side) };
      })()`)
      if (route.immersive) {
        // 沉浸式页面：两种导航都不该出现
        if (nav.side || nav.bottom) {
          problems.push(`${label} 沉浸式页面不该出现导航：${JSON.stringify(nav)}`)
        } else {
          vpPass++
        }
      } else {
        const wantSidebar = vp.width >= SIDEBAR_BREAKPOINT
        if (wantSidebar ? !nav.side || nav.bottom : nav.side || !nav.bottom) {
          problems.push(`${label} 导航形态不对：期望${wantSidebar ? '侧栏' : '底栏'}，实得 ${JSON.stringify(nav)}`)
        } else {
          vpPass++
        }
      }

      // 6) 关键内容确实渲染出来了（不是被裁成空白）
      if (route.must) {
        const text = await cdp.eval('document.body.innerText')
        if (!text.includes(route.must)) {
          problems.push(`${label} 页面上找不到「${route.must}」`)
        } else {
          vpPass++
        }
      }
    }

    const total = routes.length * 4 + routes.filter((r) => r.must).length
    console.log(`  ${vpPass}/${total} 项通过`)
  }

  section('响应式 · 内容列实测（首页）')
  for (const e of columnEvidence) {
    if (!e.col) continue
    const side = e.width >= SIDEBAR_BREAKPOINT ? '（左侧栏已占 224px）' : ''
    console.log(
      `  ${e.viewport.padEnd(18)} 视口 ${String(e.width).padStart(4)}px → `
      + `内容 ${String(e.col.contentWidth).padStart(4)}px `
      + `左右留白 ${e.col.padL}/${e.col.padR}${side}`,
    )
  }

  // 「测试本身是否有效」的自检：宽屏下内容必须**严格窄于**可用区域，
  // 否则说明限宽根本没生效、上面那些 bounded 断言只是因为页面恰好不宽。
  // 这一条能挡住「选择器写错、探针量了个空元素」这类假通过。
  const desktop = columnEvidence.find((e) => e.width >= 1440)
  const homeShell = await cdp.eval(`!!document.querySelector('.page-shell')`)
  check('页面确实使用了统一的 .page-shell 容器（探针没量错东西）', homeShell === true)
  check(
    '宽屏下内容列确实窄于可用区域（限宽真实生效）',
    Boolean(desktop && desktop.col && desktop.col.contentWidth < desktop.width - 224 + 2),
    desktop?.col ? `content=${desktop.col.contentWidth} viewport=${desktop.width}` : '未取到测量值',
  )

  section('响应式 · 汇总')
  const total = problems.length
  results.responsive.pass += total === 0 ? 1 : 0
  if (total === 0) {
    console.log('  \u001b[32m✓\u001b[0m 所有视口下均无横向溢出、内容列居中限宽、导航形态正确')
  } else {
    results.responsive.fail += 1
    for (const p of problems.slice(0, 40)) console.log(`  \u001b[31m✗\u001b[0m ${p}`)
    if (problems.length > 40) console.log(`  … 另有 ${problems.length - 40} 条`)
    results.responsive.failures.push(...problems.slice(0, 40))
  }
}

async function main() {
  console.log(`\n🧪 浏览器端到端测试 → ${APP}\n`)

  try {
    const health = await fetch(APP)
    if (!health.ok) throw new Error(`HTTP ${health.status}`)
  } catch (err) {
    console.error(`\u001b[31m无法访问前端（${APP}）：${err.message}\u001b[0m`)
    console.error('请先执行：npm run dev:all')
    process.exit(1)
  }

  const watchdog = setTimeout(() => {
    console.error('\n⏱  超过 300 秒仍未完成，强制结束')
    process.exit(1)
  }, 300_000)
  watchdog.unref?.()

  const { chrome, cdp, ws } = await launchChrome()

  try {
    if (runParent) await testParent(cdp)
    if (runAdmin) await testAdmin(cdp)
    if (runResponsive) await testResponsive(cdp)
  } finally {
    ws.close()
    chrome.kill()
  }

  console.log('\n' + '═'.repeat(54))
  let totalFail = 0
  for (const key of ['parent', 'admin', 'responsive']) {
    const r = results[key]
    if (!runParent && key === 'parent') continue
    if (!runAdmin && key === 'admin') continue
    if (!runResponsive && key === 'responsive') continue
    if (r.pass + r.fail === 0) continue
    totalFail += r.fail
    const label = { parent: '家长端', admin: '管理后台', responsive: '响应式' }[key]
    if (r.fail === 0) {
      console.log(`\u001b[32m${label}：全部通过（${r.pass} 项）\u001b[0m`)
    } else {
      console.log(`\u001b[31m${label}：失败 ${r.fail} 项\u001b[0m · 通过 ${r.pass} 项`)
      for (const f of r.failures) console.log(`  · ${f}`)
    }
  }
  console.log('═'.repeat(54) + '\n')
  process.exit(totalFail === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('\nE2E 异常中断：', err.message)
  process.exit(1)
})
