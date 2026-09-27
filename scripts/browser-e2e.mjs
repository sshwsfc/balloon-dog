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

// ============================================================
// 断言与工具
// ============================================================

const results = { parent: { pass: 0, fail: 0, failures: [] }, admin: { pass: 0, fail: 0, failures: [] } }
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
  check('展示今日已用时长（真实时间规划）', /今日已使用\s*\d+\s*分钟/.test(text))
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
  } finally {
    ws.close()
    chrome.kill()
  }

  console.log('\n' + '═'.repeat(54))
  let totalFail = 0
  for (const key of ['parent', 'admin']) {
    const r = results[key]
    if (!runParent && key === 'parent') continue
    if (!runAdmin && key === 'admin') continue
    if (r.pass + r.fail === 0) continue
    totalFail += r.fail
    const label = key === 'parent' ? '家长端' : '管理后台'
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
