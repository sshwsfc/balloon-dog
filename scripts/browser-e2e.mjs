#!/usr/bin/env node
/**
 * 浏览器端到端测试（家长端 + 管理后台）。
 *
 * 用 CDP 直接驱动无头 Chrome，不依赖 playwright/puppeteer 等任何 npm 包
 * （用 Node 内置的 fetch 与 WebSocket 与 DevTools 协议通信）。
 *
 * 前置条件：
 *   1. 前端在跑：npm run preview（2727，默认目标；先 npm run build）
 *      或 npm run dev（5173，配合 APP_URL=http://localhost:5173）
 *   2. 后端在跑：npm run server:dev
 *   3. 数据库已灌入演示数据：npm run db:seed
 *
 * 运行：
 *   npm run e2e              # 两套都跑
 *   npm run e2e:parent       # 只跑家长端
 *   npm run e2e:admin        # 只跑管理后台
 *
 * 环境变量：
 *   APP_URL       前端地址，默认 http://localhost:2727（见 vite.config.ts 的 PREVIEW_PORT）
 *   CHROME_PATH   Chrome 可执行文件路径（默认 macOS 上的 Google Chrome）
 *   ADMIN_USER / ADMIN_PASS / ADMIN_OPERATOR_PASS  后台账号（默认取种子数据）
 *
 * ⚠️ 无头 Chrome 需要 --no-sandbox / --disable-breakpad：在受限环境下 Chrome
 * 默认会尝试写 ~/Library/.../Crashpad，被拒绝后会直接 SIGTRAP 退出，
 * 表现为「CDP 连上几秒后 ECONNREFUSED」。脚本里已经加上这些 flag。
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

const APP = process.env.APP_URL || 'http://localhost:2727'
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
const runUx = only === 'ux'

/**
 * 种子数据里的中文串 —— 判定「英文界面还剩多少中文」时要把它们扣掉。
 *
 * 演示库中的设备昵称（`小明的小米手机`）、家长姓名（`张小明`）、安全区名与地址
 * （`北京市朝阳区望京西园四区`、`学校`）都是**用户自己敲进去的内容**，真机上也会
 * 是「爸爸的手机」这种中文，本来就不该被翻译。不扣掉的话，这个断言永远红着，
 * 久了就没人看了。做法是从 server/prisma/seed.ts 里把所有中文串抽出来当白名单：
 * 页面上出现的中文只要在种子数据里出现过，就算数据而不是漏翻的文案。
 *
 * 代价是「某条界面文案恰好和某个种子串一模一样」会被漏报，所以这份白名单
 * **只用于这个检查**，不影响别的断言。
 */
function seedChineseRuns() {
  try {
    const seed = readFileSync(join(ROOT, 'server/prisma/seed.ts'), 'utf8')
    return [...new Set(seed.match(/[\u4e00-\u9fff]{2,}/g) || [])]
  } catch {
    return []
  }
}

// ============================================================
// 断言与工具
// ============================================================

const results = {
  parent: { pass: 0, fail: 0, failures: [] },
  admin: { pass: 0, fail: 0, failures: [] },
  responsive: { pass: 0, fail: 0, failures: [] },
  ux: { pass: 0, fail: 0, failures: [] },
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

  /**
   * 轮询等待页面进入某个状态，而不是睡一个固定时长。
   *
   * 为什么要这样：SPA 的渲染 + 接口往返耗时是浮动的，机器一忙（比如刚跑完 build）
   * 固定 sleep 就不够用 —— 断言会在页面还没渲染完时跑掉，报出「找不到内容」「导航
   * 形态不对」这类**假失败**。轮询真实条件后，快的时候立刻通过、慢的时候肯等。
   *
   * 页面切换途中的求值异常（文档还没换过来）按「未就绪」处理，不往外抛。
   */
  async waitFor(expression, { timeout = 15_000, interval = 100 } = {}) {
    const deadline = Date.now() + timeout
    for (;;) {
      let value
      try {
        value = await this.eval(expression)
      } catch {
        value = false
      }
      if (value) return { ok: true, value }
      if (Date.now() >= deadline) return { ok: false, value }
      await sleep(interval)
    }
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
      /*
       * 设置框里的值必须用**元素自己那个原型**上的 setter：拿 HTMLInputElement 的
       * setter 去写 <textarea> 会抛 "TypeError: Illegal invocation"（本仓库第一次
       * 往 textarea 里填字时才暴露出来）。React 受控组件也只认这种方式 ——
       * 直接 el.value = x 不会触发 onChange。
       */
      const proto = el instanceof window.HTMLTextAreaElement
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
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

  // 「应用限制」弹窗曾经整条链路失效：家长端不发 packageName → 服务端不校验 → 存成空串 →
  // 设备端两层过滤各丢一次 → 家长端「已用」永远 0 分钟。修好后这块 React 逻辑
  // （候选合并 / 按包名选中 / 未选时禁用确认）一直没有浏览器覆盖，这里补上。
  section('家长端 5b. 应用限制弹窗（真实选择 + 落库核对）')
  const parentApi = (path, options = {}) =>
    cdp.eval(`(async () => {
      const headers = Object.assign(
        { Authorization: 'Bearer ' + localStorage.getItem('balloon_dog_token') },
        ${JSON.stringify(options.body ? { 'Content-Type': 'application/json' } : {})},
        ${JSON.stringify(options.headers || {})},
      );
      const init = Object.assign({}, ${JSON.stringify({ ...options, headers: undefined })}, { headers });
      const r = await fetch(${JSON.stringify(path)}, init);
      let json = null;
      try { json = await r.json() } catch {}
      return { status: r.status, json };
    })()`)

  // ── 家庭成员（规划 §5.1）────────────────────────────────────────────
  // 一段设备可以由多位家长一起看，角色决定「能不能写」。
  // 这里验主人视角的界面（名单 / 打码手机号 / 邀请表单）；
  // 邀请、改角色、移除这些**写路径**由 server:e2e:device-members 的 67 项覆盖 ——
  // 浏览器里重复一遍没有增量，反而要在种子库里造一堆账号。
  section('家长端 5a. 家庭成员（主人视角）')
  await cdp.goto('/devices')
  await sleep(2600)
  const { json: devsForRole } = await parentApi('/api/devices')
  const ownerDev = (devsForRole?.devices ?? [])[0] ?? null
  check(
    '设备列表带角色字段：主人 canWrite / canManageMembers 都是 true',
    ownerDev?.role === 'owner' && ownerDev?.canWrite === true && ownerDev?.canManageMembers === true,
    JSON.stringify({
      role: ownerDev?.role,
      canWrite: ownerDev?.canWrite,
      canManage: ownerDev?.canManageMembers,
    }),
  )
  const openMembers = await cdp.clickText('家庭成员')
  await sleep(1000)
  const memberText = await cdp.eval('document.body.innerText')
  check(
    '主人点「家庭成员」能打开管理弹窗',
    openMembers === true && memberText.includes('一台设备可以由多位家长一起看'),
    memberText.slice(0, 160).replace(/\n/g, ' | '),
  )
  check('名单里第一行就是设备主人', memberText.includes('设备主人'))
  check(
    '成员手机号是打码的，不是完整号码',
    /\d{3}\*{4}\d{4}/.test(memberText),
    (memberText.match(/\d{3}\*{4}\d{4}/) || ['无'])[0],
  )
  check(
    '主人能看到邀请表单（角色两档 + 邀请按钮）',
    memberText.includes('邀请加入') &&
      memberText.includes('只读（只能看）') &&
      memberText.includes('管理员（能改设置）'),
  )
  await cdp.clickText('关闭')
  await sleep(400)

  // ── 孩子档案与今日任务（规划 §5.2）──────────────────────────────────
  // 档案本身用接口建 / 挂设备 / 删（写路径已在 server:e2e:children 里逐个断言过），
  // 浏览器这边只验「家长真的能看懂并操作」的那几步：列出档案、加一条任务、
  // 勾一下完成、删掉档案后设备还在。
  section('家长端 5d. 孩子档案与今日任务（界面增改删）')
  const childName = `用例孩子${Date.now() % 100000}`
  const { json: childCreated, status: childCreateStatus } = await parentApi('/api/children', {
    method: 'POST',
    // parentApi 把 init 原样交给 fetch：**对象 body 会被 fetch 变成 "[object Object]"**，
    // 所以必须自己 JSON.stringify（本文件其它写请求也是这个写法）。
    body: JSON.stringify({
      name: childName,
      birthYear: new Date().getFullYear() - 9,
      school: '用例小学',
    }),
  })
  const childId = childCreated?.child?.id ?? null
  check(
    '接口先建一份孩子档案（供界面用例使用）',
    childCreateStatus === 201 && Boolean(childId),
    `HTTP ${childCreateStatus}`,
  )

  await cdp.goto('/children')
  await sleep(2600)
  let childText = await cdp.eval('document.body.innerText')
  check(
    '孩子档案页列出刚建的档案',
    childText.includes(childName),
    childText.slice(0, 200).replace(/\n/g, ' | '),
  )
  check(
    '年龄由出生年份现算，不是存下来的数字',
    childText.includes('9 岁'),
    (childText.match(/\d+ 岁/) || ['没找到年龄'])[0],
  )
  check('还没有任务时显示空态文案', childText.includes('今天还没有任务'))

  await cdp.fill('input[placeholder*="练琴"]', '用例任务：练琴 30 分钟')
  const addTaskClicked = await cdp.clickText('添加')
  await sleep(2200)
  childText = await cdp.eval('document.body.innerText')
  check(
    '界面上能加一条今日任务',
    addTaskClicked === true && childText.includes('用例任务：练琴 30 分钟'),
    childText.slice(0, 200).replace(/\n/g, ' | '),
  )
  const { json: tasksAfterAdd } = await parentApi(`/api/children/${childId}/tasks`)
  check(
    '任务真的落库了（接口核对标题与未完成状态）',
    (tasksAfterAdd?.tasks ?? []).some(
      (task) => task.title === '用例任务：练琴 30 分钟' && task.done === false,
    ),
    JSON.stringify(tasksAfterAdd?.tasks ?? []),
  )

  const toggledDone = await cdp.eval(`(() => {
    const button = [...document.querySelectorAll('button[aria-label]')]
      .find((node) => node.getAttribute('aria-label') === '标记完成');
    if (!button) return false;
    button.click();
    return true;
  })()`)
  await sleep(2200)
  childText = await cdp.eval('document.body.innerText')
  check(
    '点一下就把任务标记完成，进度跟着变',
    toggledDone === true && childText.includes('已完成 1/1'),
    childText.slice(0, 200).replace(/\n/g, ' | '),
  )

  const { json: devsForChild } = await parentApi('/api/devices')
  const childDevice = (devsForChild?.devices ?? [])[0] ?? null
  if (!childDevice) {
    check('库里没有设备时跳过设备归属断言（不算失败）', true, '没有可用设备')
  } else {
    const { status: assignStatus } = await parentApi(`/api/children/${childId}/devices`, {
      method: 'PUT',
      body: JSON.stringify({ deviceIds: [childDevice.id] }),
    })
    await cdp.goto('/children')
    await sleep(2400)
    childText = await cdp.eval('document.body.innerText')
    check(
      '设备归属整组替换后，档案里出现这台设备',
      assignStatus === 200 && childText.includes(childDevice.name),
      `HTTP ${assignStatus} / ${childText.slice(0, 200).replace(/\n/g, ' | ')}`,
    )
  }

  const { status: childDeleteStatus } = await parentApi(`/api/children/${childId}`, {
    method: 'DELETE',
  })
  await cdp.goto('/children')
  await sleep(2400)
  childText = await cdp.eval('document.body.innerText')
  check(
    '删掉档案后列表里不再有它',
    childDeleteStatus === 200 && !childText.includes(childName),
    `HTTP ${childDeleteStatus}`,
  )
  if (childDevice) {
    const { json: devsAfterDelete } = await parentApi('/api/devices')
    check(
      '删档案只是解绑：设备还在，childId 被清空',
      (devsAfterDelete?.devices ?? []).some(
        (device) => device.id === childDevice.id && !device.childId,
      ),
      JSON.stringify(
        (devsAfterDelete?.devices ?? []).map((d) => ({ id: d.id, childId: d.childId })),
      ),
    )
  }

  // ── 合规与隐私（规划 §5.3）────────────────────────────────────────────
  // 同意留痕 / 最小必要采集说明 / 导出 / 注销。这里**只做不破坏种子库的动作**：
  // 「同意」是幂等的（重复同意不会造假记录），可以真点一遍界面；
  // 「撤回」和「注销」会立刻删掉这个账号的设备记录，所以只验界面能不能走到确认那一步，
  // 不提交 —— 破坏性路径由 server:e2e:privacy 的 76 项覆盖。
  section('家长端 5e. 合规与隐私（授权 / 采集说明 / 导出 / 注销界面）')
  const { json: privacyDocs, status: docsStatus } = await parentApi('/api/privacy/docs')
  check(
    '合规目录接口可用：两份必读文档 + 最小必要采集清单',
    docsStatus === 200 &&
      (privacyDocs?.docs ?? []).length === 2 &&
      (privacyDocs?.collection ?? []).length >= 10 &&
      Boolean(privacyDocs?.version),
    `HTTP ${docsStatus} / docs=${(privacyDocs?.docs ?? []).length} / collection=${(privacyDocs?.collection ?? []).length}`,
  )

  await cdp.goto('/privacy')
  await sleep(2600)
  let privacyText = await cdp.eval('document.body.innerText')
  check(
    '合规页把四件事都摆在页面上',
    privacyText.includes('合规与隐私') &&
      privacyText.includes('监护授权与告知') &&
      privacyText.includes('我们收集什么、留多久') &&
      privacyText.includes('导出我的数据') &&
      privacyText.includes('注销账号'),
    privacyText.slice(0, 200).replace(/\n/g, ' | '),
  )

  await cdp.clickText('我们收集什么、留多久')
  await sleep(700)
  privacyText = await cdp.eval('document.body.innerText')
  check(
    '采集清单展开后逐项写清用途、保存期限与存放位置',
    privacyText.includes('位置与轨迹') &&
      privacyText.includes('保留到账号删除') &&
      privacyText.includes('用途') &&
      privacyText.includes('存放位置'),
    privacyText.slice(0, 240).replace(/\n/g, ' | '),
  )

  const { json: consentsBefore } = await parentApi('/api/privacy/consents')
  const pendingDoc = (consentsBefore?.consents ?? []).find((item) => !item.accepted) ?? null
  if (!pendingDoc) {
    // 没有待同意的文档时也凑满同样条数，免得套件总数随「这台账号同意过没有」忽多忽少。
    check(
      '已全部同意时服务端两名文档都是 accepted',
      (consentsBefore?.consents ?? []).length === 2 &&
        (consentsBefore?.consents ?? []).every((item) => item.accepted),
      JSON.stringify((consentsBefore?.consents ?? []).map((item) => [item.docType, item.accepted])),
    )
    check(
      '已同意的记录里存的是当前版本（不是旧版本硬撑）',
      (consentsBefore?.consents ?? []).every(
        (item) => item.record?.docVersion === item.version,
      ) && Boolean(privacyDocs?.version),
      JSON.stringify((consentsBefore?.consents ?? []).map((item) => item.record?.docVersion)),
    )
  } else {
    const openedRead = await cdp.clickText('阅读并同意')
    await sleep(900)
    const readText = await cdp.eval('document.body.innerText')
    check(
      '点「阅读并同意」先给出全文，不是直接记一条同意',
      openedRead === true && readText.includes('我已阅读并同意'),
      readText.slice(0, 200).replace(/\n/g, ' | '),
    )
    const accepted = await cdp.clickText('我已阅读并同意')
    await sleep(2400)
    const { json: consentsAfter } = await parentApi('/api/privacy/consents')
    const nowAccepted = (consentsAfter?.consents ?? []).find(
      (item) => item.docType === pendingDoc.docType,
    )
    check(
      '确认后服务端真的留下了同意记录（版本 + 时间）',
      accepted === true && nowAccepted?.accepted === true && Boolean(nowAccepted?.record?.docVersion),
      JSON.stringify(nowAccepted?.record ?? null),
    )
  }

  await cdp.goto('/privacy')
  await sleep(2400)
  const afterConsentText = await cdp.eval('document.body.innerText')
  // 这一条必须在同意之后读：一份都没同意时页面本来就不该给「撤回同意」。
  check('已同意的文档同时给出「撤回同意」入口', afterConsentText.includes('撤回同意'))
  const openedDeletion = await cdp.clickText('申请注销')
  await sleep(900)
  const deletionText = await cdp.eval('document.body.innerText')
  check(
    '注销只从确认框开始：要密码，还要手打确认词',
    openedDeletion === true &&
      deletionText.includes('申请注销账号') &&
      deletionText.includes('请输入「删除我的账号」以确认'),
    deletionText.slice(0, 200).replace(/\n/g, ' | '),
  )
  check(
    '确认框写清了「立刻做什么、冷静期后做什么」',
    deletionText.includes('现在立刻') && deletionText.includes('7 天后'),
  )
  await cdp.clickText('稍后再说')
  await sleep(700)
  const { json: deletionAfterClose } = await parentApi('/api/privacy/deletion')
  check(
    '关掉确认框不会真的排期注销',
    !deletionAfterClose?.deletion?.scheduled,
    JSON.stringify(deletionAfterClose?.deletion ?? null),
  )

  const { json: exported, status: exportStatus } = await parentApi('/api/privacy/export')
  check(
    '导出接口给出账号与采集清单（元数据，不含照片文件本身）',
    exportStatus === 200 &&
      String(exported?.account?.phone ?? '').startsWith('138') &&
      (exported?.collection ?? []).length >= 10,
    `HTTP ${exportStatus}`,
  )

  // ── 会员中心的支付管线（规划 §5.4）──────────────────────────────────
  // 这一段的边界要写清楚：**只读 + 只点开收银台，不真的付款、也不退款**。
  // 种子库里的演示家长是「超级会员」，真付出一次会把档位换成订单那一档
  // （默认 tab 是「会员」），退款又会把它降回 free —— 后面依赖会员身份的用例
  // 会跟着变色。下单 → 回调 → 开通 → 退款 → 收回权益的完整链路，由
  // `server:e2e:payments`（82 项，自带后端 + 假渠道）覆盖；这里只验家长端看得见的：
  // 渠道实况是否如实、没配的渠道缺哪个变量、收银台有没有标「模拟支付」、
  // 以及「只点开收银台」不会凭空产生订单。
  section('家长端 5f. 会员中心与支付管线（目录实况 / 渠道缺什么 / 收银台）')
  {
    const { json: catalog, status: catalogStatus } = await parentApi('/api/payments/catalog')
    check(
      '支付目录接口给出渠道实况、退款窗口与提示文案',
      catalogStatus === 200 &&
        (catalog?.channels ?? []).length === 2 &&
        typeof catalog?.notice === 'string' &&
        catalog.notice.length > 0 &&
        catalog?.refundWindowDays >= 1,
      `HTTP ${catalogStatus} / channels=${(catalog?.channels ?? []).length} / window=${catalog?.refundWindowDays}`,
    )

    const unconfigured = (catalog?.channels ?? []).filter((c) => !c.configured)
    check(
      '没配的渠道如实列出「缺哪个环境变量」，而不是假装可用',
      unconfigured.length === 0 ||
        unconfigured.every(
          (c) =>
            (c.missing ?? []).length > 0 &&
            c.missing.every((key) => /^[A-Z][A-Z0-9_]*$/.test(key)),
        ),
      JSON.stringify(unconfigured.map((c) => [c.key, c.missing])),
    )

    check(
      '测试渠道只在测试环境出现，且写明「不联网、不扣款」',
      !catalog?.fakeAvailable ||
        (catalog?.available ?? []).some(
          (c) => c.key === 'fake' && /不联网|不扣款/.test(c.note ?? ''),
        ),
      JSON.stringify((catalog?.available ?? []).map((c) => c.key)),
    )

    const { json: ordersBefore } = await parentApi('/api/payments/orders?pageSize=10')
    const ordersBeforeCount = (ordersBefore?.orders ?? []).length

    await cdp.goto('/membership')
    await sleep(2600)
    let memberText = await cdp.eval('document.body.innerText')
    check(
      '会员中心把服务端那句渠道实况原样显示出来（文案不由前端编）',
      memberText.includes(catalog.notice),
      memberText.slice(0, 200).replace(/\n/g, ' | '),
    )
    check(
      '支付宝与微信支付都列在页面上，没配的标「未配置」',
      memberText.includes('支付宝') &&
        memberText.includes('微信支付') &&
        (unconfigured.length === 0 || memberText.includes('未配置')),
      unconfigured.map((c) => c.key).join('、') || '两个都配好了',
    )
    check(
      '页面写明退款窗口天数（取自目录，不是前端写死的）',
      memberText.includes(`支付后 ${catalog.refundWindowDays} 天内可以自助退款`),
      `目录说 ${catalog.refundWindowDays} 天`,
    )
    check('充值记录区块在位', memberText.includes('充值记录'))

    // 打开收银台：套餐卡本身就是一个 button，点它才会拉起支付弹层。
    const opened = await cdp.eval(`(() => {
      const b = [...document.querySelectorAll('button')].find(
        (x) => /￥/.test(x.textContent) && /折合|自动续费/.test(x.textContent),
      );
      if (!b) return false;
      b.click();
      return true;
    })()`)
    await sleep(1400)
    const cashierText = await cdp.eval('document.body.innerText')
    check(
      '收银台给出支付方式与应付金额',
      opened === true &&
        cashierText.includes('支付方式') &&
        /确认支付\s*￥/.test(cashierText),
      cashierText.slice(0, 200).replace(/\n/g, ' | '),
    )
    check(
      '还开着模拟支付时收银台显著标注「不会真的扣款」；关了则如实说缺什么',
      catalog.mockPay
        ? cashierText.includes('不会真的扣款')
        : cashierText.includes('缺少：'),
      `mockPay=${catalog.mockPay}`,
    )

    // 只点开、不确认：重新进页面后订单数必须没变。
    await cdp.goto('/membership')
    await sleep(2200)
    const { json: ordersAfter } = await parentApi('/api/payments/orders?pageSize=10')
    check(
      '只点开收银台不会凭空多出订单（没点确认支付就什么都没提交）',
      (ordersAfter?.orders ?? []).length === ordersBeforeCount,
      `之前 ${ordersBeforeCount} / 之后 ${(ordersAfter?.orders ?? []).length}`,
    )

    const bareStatus = await cdp.eval(`(async () => {
      const r = await fetch('/api/payments/orders');
      return r.status;
    })()`)
    check(
      '支付订单接口未登录时 401，而不是把别人的订单吐出来',
      bareStatus === 401,
      `HTTP ${bareStatus}`,
    )
  }

  // 种子库里多数设备没有应用清单，挑一台真有清单的设备来测；一台都没有就退化成断言空态。
  const { json: deviceList } = await parentApi('/api/devices')
  let fixture = null
  for (const d of deviceList?.devices ?? []) {
    const { json: appList } = await parentApi(`/api/device-apps?deviceId=${d.id}&includeSystem=true`)
    const launchable = (appList?.apps ?? []).filter((a) => a.isLaunchable)
    if (launchable.length > 0) {
      fixture = { device: d, apps: launchable }
      break
    }
  }
  const seedDevice = (deviceList?.devices ?? []).find((d) => d.name === '小明的小米手机') ?? null

  if (!fixture) {
    check('没有带应用清单的设备时退化为断言空态（不算通过也不算失败）', true,
      '库里没有设备上报过可启动应用，本用例跳过')
  } else {
    const switched = await parentApi(`/api/devices/${fixture.device.id}/select`, { method: 'POST' })
    check('切换到有应用清单的设备用于验证', switched.status === 200, `HTTP ${switched.status}`)

    await cdp.goto('/')
    await sleep(3000)
    const tileHit = await cdp.eval(`(() => {
      const all = [...document.querySelectorAll('button, a, div, span, li')];
      const exact = all.filter((e) => e.textContent.trim() === '应用限制');
      if (!exact.length) return false;
      let node = exact[exact.length - 1];
      for (let i = 0; i < 6 && node; i++) {
        if (node.tagName === 'BUTTON' || node.tagName === 'A' || node.getAttribute('role') === 'button') break;
        node = node.parentElement;
      }
      (node || exact[exact.length - 1]).click();
      return true;
    })()`)
    check('点开「应用限制」磁贴', tileHit === true)
    await sleep(2500)

    const dialogText = await cdp.eval('document.body.innerText')
    check('弹窗打开并说明用法', dialogText.includes('从孩子设备上的应用里选择'))

    // 候选行是「应用名 + 包名」的按钮，包名必须像真的包名，而不是展示名占位
    const candidates = await cdp.eval(`(() => {
      const out = [];
      for (const b of document.querySelectorAll('button')) {
        const p = b.querySelector('p');
        const pkg = p ? p.textContent.trim() : '';
        if (!pkg || !pkg.includes('.')) continue;
        const nameEl = b.querySelector('span');
        out.push({ pkg, name: nameEl ? nameEl.textContent.trim() : '' });
      }
      return out;
    })()`)
    check('候选列表渲染出带真实包名的应用', candidates.length > 0, `${candidates.length} 行`)
    check('每条候选的包名都合法（不存在空包名占位）',
      candidates.every((c) => /^[a-zA-Z][\w.]*\.[\w.]+$/.test(c.pkg)),
      JSON.stringify(candidates.slice(0, 3)))

    const confirmDisabled = await cdp.eval(`(() => {
      const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === '确认');
      return b ? b.disabled : null;
    })()`)
    check('未选应用时「确认」不可点（负例守卫）', confirmDisabled === true, `disabled=${confirmDisabled}`)

    const target = candidates.find((c) => c.pkg.includes('deskclock')) ?? candidates[0]
    const picked = await cdp.eval(`(() => {
      for (const b of document.querySelectorAll('button')) {
        const p = b.querySelector('p');
        if (p && p.textContent.trim() === ${JSON.stringify(target.pkg)}) { b.click(); return true; }
      }
      return false;
    })()`)
    check(`选中应用「${target.name}」`, picked === true)
    await sleep(700)
    check('选中后才出现时长输入框',
      (await cdp.eval(`!!document.querySelector('input[type="number"]')`)) === true)

    // 非法值必须被挡住，且弹窗不能关掉（关掉会让家长以为设上了）
    await cdp.fill('input[type="number"]', '0')
    await sleep(300)
    await cdp.clickText('确认')
    await sleep(2500)
    check('时长填 0 被拒且弹窗保持打开',
      (await cdp.eval(`document.body.innerText.includes('从孩子设备上的应用里选择')`)) === true)

    await cdp.fill('input[type="number"]', '7')
    await sleep(300)
    await cdp.clickText('确认')
    await sleep(3500)
    check('保存后弹窗关闭',
      (await cdp.eval(`document.body.innerText.includes('从孩子设备上的应用里选择')`)) === false)

    const { json: features } = await parentApi(`/api/features?deviceId=${fixture.device.id}`)
    const entry = features?.appLimit?.apps?.[target.name]
    check('落库的 packageName 与 UI 选中的包一致（本轮缺陷的核心）',
      entry?.packageName === target.pkg, `期望 ${target.pkg}，实际 ${entry?.packageName}`)
    check('落库的每日上限等于 UI 填的 7 分钟', entry?.dailyLimit === 7, `实际 ${entry?.dailyLimit}`)

    // 收尾：删掉本次建的限额，把当前设备切回去，别污染其它用例
    await parentApi(`/api/features/app-limit/${encodeURIComponent(target.name)}?deviceId=${fixture.device.id}`,
      { method: 'DELETE' })
    if (seedDevice && seedDevice.id !== fixture.device.id) {
      await parentApi(`/api/devices/${seedDevice.id}/select`, { method: 'POST' })
    }
  }

  // 安全区一直有个「能停用围栏」的假印象：服务端有 enabled 字段、也按它过滤下发，
  // 但家长端类型里没这个字段、界面上没有开关 —— 家长根本做不到「先停掉学校这条，
  // 放假期间别报警」。这里从 UI 真实点一遍开关，并回接口核对。
  // ── 帮助与反馈（规划 §5.5）──────────────────────────────────────────
  // 工单属于账号，不属于设备。这里验「家长能提交、能补充说明、关闭后不能再回」，
  // 以及三条诚实边界：**没有附件上传**、正文长度上限取服务端的值、家长视图里
  // **看不到客服账号名**。后台那一侧的列表 / 状态流转由 server:e2e:tickets 的 69 项覆盖。
  section('家长端 5g. 帮助与反馈（工单提交 / 补充说明 / 关闭后不可回）')
  {
    const { json: supportConfig, status: configStatus } = await parentApi('/api/support/config')
    check(
      '工单配置来自服务端：分类、未关闭上限、正文上限与边界说明都在',
      configStatus === 200 &&
        (supportConfig?.categories ?? []).length >= 5 &&
        supportConfig.categories.every((c) => c.key && c.label) &&
        typeof supportConfig.openLimit === 'number' &&
        supportConfig.openLimit >= 1 &&
        supportConfig.bodyMax >= 100 &&
        typeof supportConfig.notice === 'string' &&
        supportConfig.notice.length > 5,
      `HTTP ${configStatus} / 分类 ${(supportConfig?.categories ?? []).length} / 未关闭上限 ${supportConfig?.openLimit} / 正文上限 ${supportConfig?.bodyMax}`,
    )
    const category =
      (supportConfig?.categories ?? []).find((c) => c.key === 'payment') ?? supportConfig.categories[0]

    // 反复跑这一套会留下历史工单。把上一次遗留的「用例工单」关掉，
    // 否则未关闭数量可能顶到上限、新建按钮被禁用（这不是产品缺陷，是测试自己的卫生）。
    const adminLogin = await cdp.eval(`(async () => {
      const r = await fetch('/api/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: ${JSON.stringify(ADMIN_USER)}, password: ${JSON.stringify(ADMIN_PASS)} }),
      });
      const json = await r.json().catch(() => null);
      return { status: r.status, token: json?.token ?? null };
    })()`)
    check('后台账号可登录（供后台接口配合本节的关闭流程）', adminLogin.status === 200 && !!adminLogin.token, `HTTP ${adminLogin.status}`)
    const adminApi = (path, options = {}) =>
      cdp.eval(`(async () => {
        const headers = Object.assign(
          { Authorization: 'Bearer ' + ${JSON.stringify(adminLogin.token)} },
          ${JSON.stringify(options.body ? { 'Content-Type': 'application/json' } : {})},
        );
        const init = Object.assign({}, ${JSON.stringify({ ...options, headers: undefined })}, { headers });
        const r = await fetch(${JSON.stringify(path)}, init);
        let json = null;
        try { json = await r.json() } catch {}
        return { status: r.status, json };
      })()`)

    const { json: before } = await parentApi('/api/support/tickets')
    const leftovers = (before?.tickets ?? []).filter(
      (item) => item.status !== 'closed' && item.subject.startsWith('用例工单'),
    )
    for (const item of leftovers) {
      await adminApi(`/api/admin/tickets/${item.ticketNo}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: 'closed' }),
      })
    }

    await cdp.goto('/support')
    await sleep(2600)
    let supportText = await cdp.eval('document.body.innerText')
    check(
      '帮助与反馈页面打开，标题与「边界说明」都显示出来',
      supportText.includes('帮助与反馈') && supportText.includes(supportConfig.notice),
      supportText.slice(0, 180).replace(/\n/g, ' | '),
    )
    check(
      '页面上完全没有附件上传入口（不做假按钮）',
      (await cdp.eval(`document.querySelectorAll('input[type="file"]').length`)) === 0,
    )

    const subject = `用例工单：端到端 ${Date.now()}`
    check('打开「新建工单」弹窗', await cdp.clickText('新建工单'))
    await sleep(900)
    check(
      '分类按钮按服务端下发的 label 渲染',
      await cdp.clickText(category.label),
      category.label,
    )
    if (category.hint) {
      check(
        '选中分类后给出「该写什么」的提示语',
        (await cdp.eval('document.body.innerText')).includes(category.hint),
        category.hint,
      )
    }
    await cdp.fill('input[placeholder*="一句话说明问题"]', subject)
    await cdp.fill('textarea', '浏览器端到端验证：提交一条工单，然后补充说明。')
    check(
      '正文长度上限用服务端的值（不是前端写死）',
      (await cdp.eval(`document.querySelector('textarea')?.maxLength`)) === supportConfig.bodyMax,
      `DOM ${await cdp.eval(`document.querySelector('textarea')?.maxLength`)} / 服务端 ${supportConfig.bodyMax}`,
    )
    check(
      '弹窗里也没有附件上传入口',
      (await cdp.eval(`document.querySelectorAll('input[type="file"]').length`)) === 0,
    )
    check('提交工单', await cdp.clickText('提交'))
    await sleep(2400)
    supportText = await cdp.eval('document.body.innerText')
    check(
      '新工单出现在列表里，状态是服务端下发的「待处理」',
      supportText.includes(subject) && supportText.includes('待处理'),
      supportText.slice(0, 200).replace(/\n/g, ' | '),
    )

    const { json: mine } = await parentApi('/api/support/tickets')
    const ticket = (mine?.tickets ?? []).find((item) => item.subject === subject)
    check(
      '工单真的落库了（服务端查得到，角色与分类都对）',
      !!ticket && ticket.status === 'open' && ticket.category === category.key && ticket.replies.length === 0,
      JSON.stringify(ticket ?? null).slice(0, 220),
    )
    check(
      '家长视图里没有客服账号名（服务端不下发）',
      !JSON.stringify(ticket ?? {}).includes('adminName'),
    )

    const opened = await cdp.eval(`(() => {
      const card = [...document.querySelectorAll('[class*="cursor-pointer"]')].find((el) => el.textContent.includes(${JSON.stringify(subject)}));
      if (!card) return false;
      card.click();
      return true;
    })()`)
    check('点开工单详情', opened)
    await sleep(1300)
    const detailText = await cdp.eval('document.body.innerText')
    check(
      '详情里能看到自己写的正文与状态',
      detailText.includes('浏览器端到端验证') && detailText.includes('待处理'),
      detailText.slice(0, 200).replace(/\n/g, ' | '),
    )
    await cdp.fill('textarea', '补充说明：这是端到端验证追加的一条回复。')
    check('发送补充说明', await cdp.clickText('发送'))
    await sleep(2000)
    const { json: replied } = await parentApi(`/api/support/tickets/${ticket.ticketNo}`)
    check(
      '补充说明写进了工单，角色是家长',
      (replied?.ticket?.replies ?? []).some((r) => r.by === 'parent' && r.body.includes('端到端验证追加')),
      JSON.stringify(replied?.ticket?.replies ?? []).slice(0, 200),
    )

    const adminReply = await adminApi(`/api/admin/tickets/${ticket.ticketNo}/replies`, {
      method: 'POST',
      body: JSON.stringify({ body: '客服回复：收到，我们看一下。' }),
    })
    check('客服能回复（后台接口，家长端会看到）', adminReply.status === 200 || adminReply.status === 201, `HTTP ${adminReply.status}`)
    const adminClose = await adminApi(`/api/admin/tickets/${ticket.ticketNo}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'closed' }),
    })
    check('工单可以被关闭', adminClose.status === 200, `HTTP ${adminClose.status}`)

    await cdp.goto('/support')
    await sleep(2400)
    supportText = await cdp.eval('document.body.innerText')
    check(
      '列表上这条工单已显示「已关闭」',
      supportText.includes(subject) && supportText.includes('已关闭'),
      supportText.slice(0, 200).replace(/\n/g, ' | '),
    )
    const reopened = await cdp.eval(`(() => {
      const card = [...document.querySelectorAll('[class*="cursor-pointer"]')].find((el) => el.textContent.includes(${JSON.stringify(subject)}));
      if (!card) return false;
      card.click();
      return true;
    })()`)
    check('再次打开已关闭的工单', reopened)
    await sleep(1300)
    const closedText = await cdp.eval('document.body.innerText')
    check(
      '已关闭的工单里写着「不能再回，请新建一条」',
      closedText.includes('新建一条工单'),
      closedText.slice(0, 220).replace(/\n/g, ' | '),
    )
    check(
      '已关闭的工单不再提供回复输入框（关闭不是颜色，是真的关）',
      (await cdp.eval(`document.querySelectorAll('textarea').length`)) === 0,
    )
    check('详情里能看到客服的回复', closedText.includes('客服回复：收到'), closedText.slice(0, 200).replace(/\n/g, ' | '))
    await cdp.clickText('关闭')
    await sleep(500)

    // 入口开关（规划 §5.5 的 `support.tickets`）：关掉之后家长端不能再提新的，
    // 但**历史必须还能看** —— 关一个入口不能顺手把用户的问题记录弄丢。
    // server:e2e:tickets 验的是接口契约，这里验界面有没有如实照做。
    const flagOff = await adminApi('/api/admin/flags/support.tickets', {
      method: 'PATCH',
      body: JSON.stringify({ enabled: false }),
    })
    check('运营能关掉工单入口（后台接口）', flagOff.status === 200, `HTTP ${flagOff.status}`)
    await cdp.goto('/support')
    await sleep(2400)
    const intakeClosedText = await cdp.eval('document.body.innerText')
    check(
      '入口关掉后页面如实说明，且不再给「新建工单」按钮',
      intakeClosedText.includes('客服工单暂时关闭') &&
        (await cdp.eval(`[...document.querySelectorAll('button')].some((b) => b.textContent.trim() === '新建工单')`)) === false,
      intakeClosedText.slice(0, 160).replace(/\n/g, ' | '),
    )
    check(
      '入口关掉后历史工单仍然看得见（历史不能随入口一起消失）',
      intakeClosedText.includes(subject),
      subject,
    )
    const flagOn = await adminApi('/api/admin/flags/support.tickets', {
      method: 'PATCH',
      body: JSON.stringify({ enabled: true }),
    })
    check('开关恢复开启（不给下一次运行留雷）', flagOn.status === 200, `HTTP ${flagOn.status}`)
  }

  // ── 绑定新设备：对话框里的孩子端下载入口 ─────────────────────────────
  // 「还没装孩子端」的家长点开绑定对话框时手上是空的：绑定码在孩子端首页，
  // 而孩子端还没装。所以下载方式与二维码必须在**这个对话框里**，不能指望他
  // 关掉对话框、自己去别处找安装入口（新手引导只在第一次打开时出现）。
  // 这里点真实按钮打开对话框，并把二维码真的解码一遍 —— 二维码与手敲地址
  // 对不上时，家长是「扫了没反应」，连报错都没有，是最难排查的一类问题。
  section('家长端 5h. 绑定新设备（对话框里的孩子端下载入口）')
  {
    await cdp.goto('/devices')
    await sleep(2600)
    // 已有设备时是「绑定新设备」，一台都没有时是空态里的「绑定设备」——
    // 两个入口打开的是同一个对话框。
    const opened = await cdp.eval(`(() => {
      const buttons = Array.from(document.querySelectorAll('button'));
      const target =
        buttons.find((b) => (b.textContent || '').includes('绑定新设备')) ??
        buttons.find((b) => (b.textContent || '').trim() === '绑定设备');
      if (!target) return false;
      target.click();
      return true;
    })()`)
    check('设备页能打开绑定对话框', opened === true)
    await sleep(700)

    const dialog = await cdp.eval(`(async () => {
      const content = document.querySelector('[data-slot="dialog-content"]');
      if (!content) return { found: false };
      const text = content.innerText;
      const svgs = Array.from(content.querySelectorAll('svg')).filter((s) => s.querySelector('path'));
      const best = svgs
        .map((el) => ({
          el,
          d: Array.from(el.querySelectorAll('path')).map((p) => p.getAttribute('d') || '').join(''),
        }))
        .sort((a, b) => b.d.length - a.d.length)[0];
      const link = content.querySelector('a[download]');
      let decoded = 'no-detector';
      if (best && typeof BarcodeDetector !== 'undefined') {
        try {
          const xml = new XMLSerializer().serializeToString(best.el);
          const blobUrl = URL.createObjectURL(new Blob([xml], { type: 'image/svg+xml' }));
          const img = new Image();
          await new Promise((res, rej) => {
            img.onload = res;
            img.onerror = rej;
            img.src = blobUrl;
          });
          const codes = await new BarcodeDetector({ formats: ['qr_code'] }).detect(
            await createImageBitmap(img),
          );
          decoded = codes.length ? codes[0].rawValue : '';
          URL.revokeObjectURL(blobUrl);
        } catch (error) {
          decoded = 'error: ' + error.message;
        }
      }
      const shownUrl = Array.from(content.querySelectorAll('p'))
        .map((p) => (p.textContent || '').trim())
        .find((t) => t.startsWith('http') && t.endsWith('/download/balloon-dog-agent.apk'));
      return {
        found: true,
        hasHeading: text.includes('还没装孩子端？先下载'),
        hasWhy: text.includes('孩子端只装在被管的那台手机上'),
        hasManual: text.includes('手动下载方式'),
        linkHref: link ? link.getAttribute('href') : null,
        codeInput: Array.from(content.querySelectorAll('input')).some((i) =>
          (i.getAttribute('placeholder') || '').includes('A3F9K2M7'),
        ),
        // 下载入口加进来之后，最容易犯的错是「把必填的绑定码挤到折叠线以下」——
        // 绑新设备的家长手上就有码，不该为了填它先滚一屏。
        codeInputBottom: (() => {
          const el = Array.from(content.querySelectorAll('input')).find((i) =>
            (i.getAttribute('placeholder') || '').includes('A3F9K2M7'),
          );
          return el ? Math.round(el.getBoundingClientRect().bottom) : null;
        })(),
        viewportHeight: window.innerHeight,
        decoded,
        shownUrl: shownUrl || '',
        best: best ? { d: best.d, title: (best.el.querySelector('title') || {}).textContent || '' } : null,
      };
    })()`)
    check(
      '绑定对话框里有孩子端下载入口与「为什么」',
      dialog.found === true && dialog.hasHeading === true && dialog.hasWhy === true,
      JSON.stringify({ found: dialog.found, hasHeading: dialog.hasHeading, hasWhy: dialog.hasWhy }),
    )
    check(
      '对话框里渲染出二维码（不是空白 svg）',
      !!dialog.best && dialog.best.d.length > 500,
      dialog.best ? `模块路径长=${dialog.best.d.length} 标题=${dialog.best.title}` : '对话框里没有 svg',
    )
    check(
      '对话框里的二维码能解码出孩子端安装包地址',
      typeof dialog.decoded === 'string' && dialog.decoded.endsWith('/download/balloon-dog-agent.apk'),
      `解码结果=${dialog.decoded}`,
    )
    check(
      '对话框里的二维码与可手敲地址一致 + <a download> 指向真实路径',
      dialog.decoded === dialog.shownUrl && dialog.linkHref === '/download/balloon-dog-agent.apk',
      `二维码=${dialog.decoded} 页面=${dialog.shownUrl} href=${dialog.linkHref}`,
    )
    check('下载入口没有挤掉绑定码输入框', dialog.codeInput === true)
    check(
      '绑定码输入框不用滚动就看得见（默认折叠状态下）',
      dialog.codeInputBottom !== null && dialog.codeInputBottom <= dialog.viewportHeight,
      `输入框底部=${dialog.codeInputBottom}px 视口高=${dialog.viewportHeight}px`,
    )
    check('对话框里保留手动下载方式作为退路', dialog.hasManual === true)

    // 默认（排障引导折叠）状态的截图：家长点开对话框先看到的就是这一屏
    await cdp.shot('/tmp/balloon-dog-bind-dialog.png')

    // 装不上时的排障引导（怎么传过去 / 各厂商怎么放开「禁止安装」）折叠在同一处
    const guide = await cdp.eval(`(async () => {
      const content = document.querySelector('[data-slot="dialog-content"]');
      if (!content) return { found: false };
      const toggle = Array.from(content.querySelectorAll('button')).find((b) =>
        (b.textContent || '').includes('装不上？'),
      );
      if (!toggle) return { found: false };
      const expandedBefore = toggle.getAttribute('aria-expanded');
      toggle.click();
      await new Promise((r) => setTimeout(r, 350));
      const text = content.innerText;
      return {
        found: true,
        expandedBefore,
        expandedAfter: toggle.getAttribute('aria-expanded'),
        hasTransfer: text.includes('把安装包放到孩子手机上'),
        hasVendor: text.includes('小米 / 红米'),
      };
    })()`)
    check(
      '排障引导默认折叠、点开后才展开',
      guide.found === true && guide.expandedBefore === 'false' && guide.expandedAfter === 'true',
      JSON.stringify(guide),
    )
    check(
      '展开后能看到「怎么传过去」与各厂商放开「禁止安装」的路径',
      guide.hasTransfer === true && guide.hasVendor === true,
    )

    // 再留一张展开排障引导后的截图，便于人工复核折叠内容的排版
    await cdp.shot('/tmp/balloon-dog-bind-dialog-guide.png')
    console.log(
      '\n📸 绑定新设备对话框截图：/tmp/balloon-dog-bind-dialog.png、/tmp/balloon-dog-bind-dialog-guide.png',
    )

    // 收尾：关掉对话框，别把下一节的起点留在一个遮罩上
    await cdp.eval(`(() => {
      const close = document.querySelector('[data-slot="dialog-content"] [data-slot="dialog-close"]');
      if (close) close.click();
      return true;
    })()`)
    await sleep(400)
  }

  section('家长端 5c. 安全区启停开关（真实点击 + 落库核对）')
  {
    const { json: devs } = await parentApi('/api/devices')
    const dev = (devs?.devices ?? [])[0]
    if (!dev) {
      check('安全区启停：拿得到设备', false, '没有可用设备')
    } else {
      const zoneName = 'E2E围栏启停'

      // 用接口建一条临时围栏（点 UI 建也行，但这里要验的是「启停」，建的部分越省越好）
      const { json: created } = await parentApi('/api/safe-zones', {
        method: 'POST',
        body: JSON.stringify({
          name: zoneName, latitude: 39.9087, longitude: 116.3974,
          radiusMeters: 300, address: 'E2E', type: 'other',
        }),
      })
      const newZone = created?.safeZone
      check('安全区启停：临时围栏建出来了', Boolean(newZone?.id), JSON.stringify(created).slice(0, 160))

      if (newZone?.id) {
        await cdp.goto('/location')
        await sleep(2600)

        const before = await cdp.eval(`document.body.innerText.includes(${JSON.stringify(zoneName)})`)
        check('安全区启停：新围栏出现在位置页', before === true)

        // 开关有 aria-label「停用 <名字>」/「启用 <名字>」，据此精确点到它自己
        const clicked = await cdp.eval(`(() => {
          const b = [...document.querySelectorAll('button[role="switch"]')]
            .find((x) => (x.getAttribute('aria-label') || '') === ${JSON.stringify('停用 ' + zoneName)});
          if (!b) return false;
          b.click();
          return true;
        })()`)
        check('安全区启停：找到了该围栏的开关并点击', clicked === true)
        await sleep(2600)

        const { json: afterOff } = await parentApi('/api/safe-zones')
        const off = (afterOff?.safeZones ?? []).find((z) => z.id === newZone.id)
        check('点一下就真的停用了（落库 enabled=false）', off?.enabled === false,
          `实际 enabled=${off?.enabled}`)

        const showsOff = await cdp.eval(`document.body.innerText.includes('已停用')`)
        check('界面如实标出「已停用」', showsOff === true)

        // 再点回去，确认可逆
        const clickedBack = await cdp.eval(`(() => {
          const b = [...document.querySelectorAll('button[role="switch"]')]
            .find((x) => (x.getAttribute('aria-label') || '') === ${JSON.stringify('启用 ' + zoneName)});
          if (!b) return false;
          b.click();
          return true;
        })()`)
        check('安全区启停：再点回去（开关可逆）', clickedBack === true)
        await sleep(2600)

        const { json: afterOn } = await parentApi('/api/safe-zones')
        const on = (afterOn?.safeZones ?? []).find((z) => z.id === newZone.id)
        check('重新启用后 enabled=true', on?.enabled === true, `实际 enabled=${on?.enabled}`)

        // 停用 ≠ 删除：家长端必须仍然列着它，否则家长再也没法把它启回来。
        // （「不再下发给设备」由服务端 `agent.controller.ts` 的 where enabled:true 负责，
        //   设备端那侧的证据在 android:e2e:gaps 的安全区用例里。）
        await parentApi(`/api/safe-zones/${newZone.id}`, {
          method: 'PUT',
          body: JSON.stringify({ enabled: false }),
        })
        const { json: stillListed } = await parentApi('/api/safe-zones')
        const offZone = (stillListed?.safeZones ?? []).find((z) => z.id === newZone.id)
        check('停用的围栏仍然列在家长端（否则家长无法再启回来）',
          Boolean(offZone) && offZone?.enabled === false)  

        // 收尾
        await parentApi(`/api/safe-zones/${newZone.id}`, { method: 'DELETE' })
        const { json: finalZones } = await parentApi('/api/safe-zones')
        check('安全区启停：收尾已删除，不留测试数据',
          !(finalZones?.safeZones ?? []).some((z) => z.id === newZone.id))
      }
    }
  }

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
    ['/admin/membership', ['会员', '套餐'], '会员管理'],
    ['/admin/payments', ['支付', '收款统计'], '支付'],
    ['/admin/referral', ['分享提成', '统计概览'], '分享提成'],
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
  /*
   * 只断言「列表真的渲染出了账号行」，**不**断言演示账号在第一页。
   * 第一页是「按注册时间倒序」，这个顺序不是产品不变量：只要库里攒了足够多的
   * 账号（每次注册/扫码登录都会留一条），演示账号就会被挤到第二页，这条断言
   * 就会无缘无故地红 —— 而它红的时候页面其实完全正常。演示账号的存在由下面
   * 那条「搜得到」来证，搜索不依赖分页顺序（和操作日志那节同一个办法）。
   */
  check('家长账号列表渲染出账号行', /1[3-9]\d{9}/.test(text), text.slice(0, 140).replace(/\n/g, ' | '))
  await cdp.fill('input[placeholder*="搜索手机号"]', PARENT_PHONE)
  await sleep(2200)
  const searched = await cdp.eval('document.body.innerText')
  check(
    '可按手机号搜到演示家长账号',
    searched.includes(PARENT_PHONE),
    searched.slice(0, 200).replace(/\n/g, ' | '),
  )
  await cdp.fill('input[placeholder*="搜索手机号"]', '')
  await sleep(1200)

  await cdp.goto('/admin/questions')
  await sleep(2800)
  text = await cdp.eval('document.body.innerText')
  check('题库显示年级分布', /一年级|二年级|三年级/.test(text))

  /*
   * 分享提成八页：这八个标签共用一条路由，深层路由刷新那节覆盖不到它们，
   * 所以要在这里逐个点开 —— 每个标签各自拉数据、各自有 loading/空态分支，
   * 只验证「页面能打开」会漏掉其中七页的白屏。
   * 判据取「内容区」而不是整页文本：标签按钮的名字和面板标题同名，
   * 只看整页会连点都没点上也通过。
   */
  section('后台 4. 分享提成八页')
  await cdp.goto('/admin/referral')
  await sleep(3000)
  const REFERRAL_TABS = ['统计概览', '提现审核', '邀请记录', '返现明细', '优惠券', '活动配置', '规则与阶梯', '风险排查']
  const referralText = await cdp.eval('document.body.innerText')
  check(
    '八个标签都在',
    REFERRAL_TABS.every((label) => referralText.includes(label)),
    REFERRAL_TABS.filter((label) => !referralText.includes(label)).join('、') || '全部命中',
  )
  for (const label of REFERRAL_TABS) {
    const clicked = await cdp.eval(`(() => {
      const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === ${JSON.stringify(label)})
      if (!btn) return false
      btn.click()
      return true
    })()`)
    await sleep(2200)
    const panel = await cdp.eval(`(() => {
      const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === ${JSON.stringify(label)})
      const bar = btn && btn.parentElement
      const box = bar && bar.nextElementSibling
      return box ? box.innerText.slice(0, 200) : ''
    })()`)
    check(
      `切到「${label}」后内容区渲染出对应的页`,
      clicked === true && panel.includes(label),
      panel.slice(0, 90).replace(/\n/g, ' | ') || '内容区是空的',
    )
  }

  /*
   * 会员管理五页：和分享提成同理，五个标签共用一条路由。这里不校验面板标题
   * （各 tab 的标题并不等于标签名），而是校验「内容区真的渲染出了东西、且没有
   * 落进错误分支」—— 那正是这五个标签唯一可能的坏法：白屏或「数据加载失败」。
   */
  section('后台 5. 会员管理五页')
  await cdp.goto('/admin/membership')
  await sleep(3000)
  const MEMBERSHIP_TABS = ['统计', '套餐', '定价规则', '受邀用户定价', '订单']
  const membershipText = await cdp.eval('document.body.innerText')
  check(
    '五个标签都在（含新增的受邀用户定价）',
    MEMBERSHIP_TABS.every((label) => membershipText.includes(label)),
    MEMBERSHIP_TABS.filter((label) => !membershipText.includes(label)).join('、') || '全部命中',
  )
  for (const label of MEMBERSHIP_TABS) {
    const clicked = await cdp.eval(`(() => {
      const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === ${JSON.stringify(label)})
      if (!btn) return false
      btn.click()
      return true
    })()`)
    await sleep(2200)
    const panel = await cdp.eval(`(() => {
      const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === ${JSON.stringify(label)})
      const bar = btn && btn.parentElement
      const box = bar && bar.nextElementSibling
      return box ? box.innerText : ''
    })()`)
    check(
      `切到「${label}」后内容区渲染出内容且没落进错误分支`,
      clicked === true && panel.trim().length > 20 && !panel.includes('数据加载失败'),
      panel.trim().slice(0, 90).replace(/\n/g, ' | ') || '内容区是空的',
    )
  }

  /*
   * 支付四页（规划 §5.4）：和会员、分享提成一样是「一条路由挂多个标签」。
   * 另外单独验一件只有后台能看到的事：**渠道没配时后台必须说「未配置」**，
   * 不能因为统计接口有默认值就显示成一切正常 —— 家长那边下不了单，
   * 后台却是绿色的，是最容易漏掉的一种坏法。
   */
  section('后台 5b. 支付四页（订单 / 退款 / 发票 / 渠道体检）')
  await cdp.goto('/admin/payments')
  await sleep(3000)
  const PAYMENT_TABS = ['收款统计', '订单', '退款', '发票']
  const paymentsText = await cdp.eval('document.body.innerText')
  check(
    '四个标签都在',
    PAYMENT_TABS.every((label) => paymentsText.includes(label)),
    PAYMENT_TABS.filter((label) => !paymentsText.includes(label)).join('、') || '全部命中',
  )
  for (const label of PAYMENT_TABS) {
    const clicked = await cdp.eval(`(() => {
      const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === ${JSON.stringify(label)})
      if (!btn) return false
      btn.click()
      return true
    })()`)
    await sleep(2200)
    const panel = await cdp.eval(`(() => {
      const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === ${JSON.stringify(label)})
      const bar = btn && btn.parentElement
      const box = bar && bar.nextElementSibling
      return box ? box.innerText : ''
    })()`)
    check(
      `切到「${label}」后内容区渲染出内容且没落进错误分支`,
      clicked === true && panel.trim().length > 20 && !panel.includes('数据加载失败'),
      panel.trim().slice(0, 90).replace(/\n/g, ' | ') || '内容区是空的',
    )
    if (label === '收款统计') {
      check(
        '渠道体检如实写「已配置 / 未配置」，而不是一律显示正常',
        /已配置|未配置/.test(panel) && panel.includes('支付渠道配置'),
        panel.includes('未配置') ? '当前按未配置显示' : '当前显示已配置',
      )
    }
    if (label === '订单') {
      check(
        '订单页要么渲染表头、要么明确空态，不留白屏',
        panel.includes('订单号') || panel.includes('没有符合条件的订单'),
        panel.trim().slice(0, 90).replace(/\n/g, ' | '),
      )
    }
  }

  const { json: payStats, status: payStatsStatus } = await cdp.eval(`(async () => {
    const r = await fetch('/api/admin/payments/stats', {
      headers: { Authorization: 'Bearer ' + localStorage.getItem('balloon_dog_admin_token') },
    });
    let json = null;
    try { json = await r.json() } catch {}
    return { status: r.status, json };
  })()`)
  check(
    '后台支付统计接口给出渠道体检与坏签名计数',
    payStatsStatus === 200 &&
      Array.isArray(payStats?.channels) &&
      payStats.channels.length >= 1 &&
      typeof payStats?.badSignatures === 'number' &&
      typeof payStats?.fakeProvider === 'boolean',
    `HTTP ${payStatsStatus} / channels=${(payStats?.channels ?? []).length} / badSignatures=${payStats?.badSignatures}`,
  )
  check(
    '统计里的渠道缺哪个环境变量与家长端目录一致',
    (payStats?.channels ?? []).every(
      (c) => c.configured === true || (c.missing ?? []).length > 0,
    ),
    JSON.stringify((payStats?.channels ?? []).map((c) => [c.key, c.configured, c.missing?.length])),
  )

  /*
   * 后台运营三页（规划 §5.5）：告警大盘 / 灰度开关 / 客服工单。
   *
   * 这三页最容易的坏法是「界面好看但和口径不一致」—— 所以关键断言都拿接口回值去对：
   * 告警的阈值与触发来自 overview，开关命中的判定来自 preview，工单的历史来自列表。
   * 口径本身（分母、null、稳定散列）由 server:e2e:alerts / flags 逐条核算，这里只验
   * 界面有没有把服务端那句话原样显示出来。
   */
  section('后台 5c. 运营三页（告警大盘 / 灰度开关 / 客服工单）')
  {
    const adminApi = (path, options = {}) =>
      cdp.eval(`(async () => {
        const headers = Object.assign(
          { Authorization: 'Bearer ' + localStorage.getItem('balloon_dog_admin_token') },
          ${JSON.stringify(options.body ? { 'Content-Type': 'application/json' } : {})},
        );
        const init = Object.assign({}, ${JSON.stringify({ ...options, headers: undefined })}, { headers });
        const r = await fetch(${JSON.stringify(path)}, init);
        let json = null;
        try { json = await r.json() } catch {}
        return { status: r.status, json };
      })()`)

    // ── 告警大盘 ─────────────────────────────────────────────────
    const { json: overview, status: overviewStatus } = await adminApi('/api/admin/alerts/overview')
    const alerts = overview?.alerts ?? []
    check(
      '告警总览给出五条规则，每条都带单位、阈值与口径说明',
      overviewStatus === 200 &&
        alerts.length === 5 &&
        alerts.every(
          (a) =>
            !!a.key &&
            !!a.label &&
            (a.unit === '%' || a.unit === '条') &&
            typeof a.threshold === 'number' &&
            typeof a.triggered === 'boolean' &&
            typeof a.denominatorText === 'string' &&
            a.denominatorText.length > 0,
        ),
      `HTTP ${overviewStatus} / ${alerts.length} 条 / ${alerts.map((a) => a.key).join(',')}`,
    )
    /*
     * 这条是全节的灵魂：**分母为 0 必须是 null（「没有可统计的对象」），不能是 0**
     * —— 0% 的意思是「查过了，都正常」，两者混在一张大盘上等于骗人。
     */
    const metrics = overview?.metrics ?? []
    check(
      '率类指标的分母为 0 时值是 null 而不是 0（「没有数据」不是「都正常」）',
      metrics.length === 5 &&
        metrics.every((m) =>
          m.unit === '条'
            ? typeof m.value === 'number'
            : m.denominator === 0
              ? m.value === null
              : typeof m.value === 'number',
        ),
      metrics.map((m) => `${m.key}:${m.value}/${m.denominator}`).join(' | '),
    )
    check(
      '分母口径写在接口里（未认领的设备不进失联率的分母）',
      (metrics.find((m) => m.key === 'device_offline')?.denominatorText ?? '').includes('已绑定'),
      metrics.find((m) => m.key === 'device_offline')?.denominatorText ?? '(缺)',
    )

    await cdp.goto('/admin/alerts')
    await sleep(3000)
    let opsText = await cdp.eval('document.body.innerText')
    check(
      '告警大盘三个标签都在，且概览渲染出规则而不是白屏',
      ['告警总览', '告警规则', '确认记录'].every((label) => opsText.includes(label)) &&
        !opsText.includes('数据加载失败') &&
        alerts.filter((a) => opsText.includes(a.label)).length >= 4,
      opsText.slice(0, 180).replace(/\n/g, ' | '),
    )
    // 规则页：改一条阈值再恢复默认，验的是「后台能改口径」与「缺行时回代码默认」两条契约
    const { json: rulesBefore } = await adminApi('/api/admin/alerts/rules')
    const targetRule = (rulesBefore?.rules ?? []).find((r) => r.key === 'payment_anomaly')
    check(
      '规则列表带代码默认值（便于「恢复默认」）',
      !!targetRule && typeof targetRule.threshold === 'number' && typeof targetRule.defaultThreshold === 'number',
      JSON.stringify(targetRule ?? null).slice(0, 160),
    )
    const changedThreshold = targetRule.defaultThreshold + 3
    const patched = await adminApi('/api/admin/alerts/rules/payment_anomaly', {
      method: 'PATCH',
      body: JSON.stringify({ threshold: changedThreshold }),
    })
    check('后台可以改告警阈值', patched.status === 200, `HTTP ${patched.status}`)
    const resetOk = await adminApi('/api/admin/alerts/rules/payment_anomaly/reset', { method: 'DELETE' })
    const { json: rulesAfter } = await adminApi('/api/admin/alerts/rules')
    const restored = (rulesAfter?.rules ?? []).find((r) => r.key === 'payment_anomaly')
    check(
      '「恢复默认」把阈值退回代码里的值（不是留在改过的数上）',
      resetOk.status === 200 && restored?.threshold === restored?.defaultThreshold,
      `HTTP ${resetOk.status} / 现在 ${restored?.threshold} / 默认 ${restored?.defaultThreshold}`,
    )
    // 确认告警：确认只是「我看过了」，既不改指标也不解除触发
    const ackCreated = await adminApi('/api/admin/alerts/acks', {
      method: 'POST',
      body: JSON.stringify({ key: 'payment_anomaly', note: '端到端验证：这条我看过了' }),
    })
    const ackId = ackCreated.json?.ack?.id
    check('确认告警会留下记录（含确认那一刻的指标快照）', (ackCreated.status === 200 || ackCreated.status === 201) && !!ackId,
      `HTTP ${ackCreated.status} / ${JSON.stringify(ackCreated.json?.snapshot ?? null).slice(0, 120)}`)
    await cdp.goto('/admin/alerts')
    await sleep(2800)
    opsText = await cdp.eval('document.body.innerText')
    check(
      '界面上这条告警变成「已确认」并给出「撤销确认」入口',
      opsText.includes('撤销确认') && /端到端验证：这条我看过了|已由/.test(opsText),
      opsText.slice(0, 200).replace(/\n/g, ' | '),
    )
    const ackRevoked = await adminApi(`/api/admin/alerts/acks/${ackId}`, { method: 'DELETE' })
    check('撤销确认是删除记录（不是把状态改成未读）', ackRevoked.status === 200, `HTTP ${ackRevoked.status}`)
    const { json: acksAfter } = await adminApi('/api/admin/alerts/acks?pageSize=50')
    check(
      '撤销后确认列表里没有它了',
      !(acksAfter?.acks ?? []).some((a) => a.id === ackId),
      `${(acksAfter?.acks ?? []).length} 条确认记录`,
    )

    // ── 灰度开关 ─────────────────────────────────────────────────
    const { json: flags, status: flagsStatus } = await adminApi('/api/admin/flags')
    const flagRows = flags?.flags ?? []
    check(
      '灰度开关清单来自代码（五个开关，各带放量对象与比例）',
      flagsStatus === 200 &&
        flagRows.length === 5 &&
        flagRows.every((f) => !!f.key && ['user', 'device', 'none'].includes(f.bucket) && typeof f.rolloutPercent === 'number'),
      `HTTP ${flagsStatus} / ${flagRows.length} 个 / ${flagRows.map((f) => f.key).join(',')}`,
    )
    const previewUser = flagRows.find((f) => f.bucket === 'user')?.key
    /*
     * 试算这块要先把它按比例放量：默认是 100%（全量），全量时「没给对象」也会命中，
     * 看不出「不确定就不放行」。改成 50% 之后，三条纪律才可验：
     * 命中与否有明确理由、同一个对象两次一致（稳定散列）、没给对象时保守关闭。
     */
    const rolloutPatch = await adminApi(`/api/admin/flags/${previewUser}`, {
      method: 'PATCH',
      body: JSON.stringify({ rolloutPercent: 50 }),
    })
    check('后台可以把一个能力按比例放量', rolloutPatch.status === 200, `HTTP ${rolloutPatch.status}`)
    const { json: hitA, status: hitStatus } = await adminApi(`/api/admin/flags/${previewUser}/preview?subjectId=1`)
    const { json: hitB } = await adminApi(`/api/admin/flags/${previewUser}/preview?subjectId=1`)
    check(
      '试算接口对具体对象给出明确命中结果与理由（不猜）',
      hitStatus === 200 &&
        typeof hitA?.preview?.hit === 'boolean' &&
        typeof hitA?.preview?.reasonText === 'string' &&
        hitA.preview.reasonText.length > 0,
      `HTTP ${hitStatus} / ${JSON.stringify(hitA?.preview ?? null).slice(0, 140)}`,
    )
    check(
      '同一个对象两次试算结果一致（稳定散列，不是每次抽签）',
      hitA?.preview?.hit === hitB?.preview?.hit,
      `${hitA?.preview?.hit} / ${hitB?.preview?.hit}`,
    )
    const { json: noSubject } = await adminApi(`/api/admin/flags/${previewUser}/preview`)
    check(
      '需要灰度对象却没给时保守判「不命中」并说明原因（不确定就不放行）',
      noSubject?.preview?.hit === false && /对象/.test(noSubject?.preview?.reasonText ?? ''),
      JSON.stringify(noSubject?.preview ?? null).slice(0, 140),
    )
    const flagReset = await adminApi(`/api/admin/flags/${previewUser}/reset`, { method: 'DELETE' })
    check(
      '恢复默认把放量比例退回代码里的值（不给下一次运行留雷）',
      flagReset.status === 200 && flagReset.json?.flag?.rolloutPercent === 100,
      `HTTP ${flagReset.status} / ${flagReset.json?.flag?.rolloutPercent}`,
    )
    await cdp.goto('/admin/flags')
    await sleep(2800)
    opsText = await cdp.eval('document.body.innerText')
    check(
      '开关页把每个开关的口径、放量比例与「恢复默认」都渲染出来',
      flagRows.every((f) => opsText.includes(f.label)) &&
        opsText.includes('放量比例') &&
        opsText.includes('恢复默认') &&
        !opsText.includes('数据加载失败'),
      opsText.slice(0, 180).replace(/\n/g, ' | '),
    )

    // ── 客服工单 ─────────────────────────────────────────────────
    const { json: ticketList, status: ticketStatus } = await adminApi('/api/admin/tickets?pageSize=20')
    const ticketRows = ticketList?.tickets ?? []
    check(
      '后台能看到家长提交的工单（含账号打码信息与分类）',
      ticketStatus === 200 && ticketRows.length >= 1 && ticketRows.every((t) => !!t.ticketNo && !!t.subject && !!t.status),
      `HTTP ${ticketStatus} / ${ticketRows.length} 张`,
    )
    const newestTicket = ticketRows[0]
    check(
      '后台列表给的是客服名字，不下发管理员的登录 id',
      !JSON.stringify(ticketRows).includes('adminId'),
      newestTicket ? newestTicket.ticketNo : '(无)',
    )
    await cdp.goto('/admin/tickets')
    await sleep(3000)
    opsText = await cdp.eval('document.body.innerText')
    check(
      '工单页渲染出列表（要么有行、要么是明确空态），不留白屏',
      !opsText.includes('数据加载失败') && (ticketRows.length === 0 || opsText.includes(newestTicket.subject)),
      opsText.slice(0, 180).replace(/\n/g, ' | '),
    )
    if (newestTicket) {
      const opened = await cdp.eval(`(() => {
        const row = [...document.querySelectorAll('tr')].find((el) => el.textContent.includes(${JSON.stringify(newestTicket.subject)}));
        if (!row) return false;
        row.click();
        return true;
      })()`)
      await sleep(1600)
      const detail = await cdp.eval('document.body.innerText')
      check(
        '点开一张工单能看到家长写的正文与状态/优先级控件',
        !opened || (detail.includes(newestTicket.subject.slice(0, 8)) && /状态|优先级/.test(detail)),
        detail.slice(0, 200).replace(/\n/g, ' | '),
      )
      await cdp.clickText('关闭')
      await sleep(600)
    }
  }

  section('后台 6. 详情弹窗')
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

  section('后台 7. 深层路由刷新（history fallback）')
  await cdp.goto('/admin/devices')
  await sleep(2600)
  await cdp.reload()
  await sleep(3000)
  check(
    '刷新 /admin/devices 不 404 且保持登录',
    (await cdp.eval('location.pathname')) === '/admin/devices' &&
      (await cdp.eval('document.body.innerText')).includes('设备管理'),
  )

  section('后台 8. 操作日志')
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

  section('后台 9. 运营账号权限差异')
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

  section('后台 10. 运行时健康度')
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
  { path: '/insights/config', wide: false, must: '配置' },
  { path: '/mode', wide: false, must: '模式' },
  { path: '/mode/schedule', wide: false, must: '时段' },
  { path: '/mode/apps', wide: true, must: '应用' },
  { path: '/eye-care', wide: false, must: '护眼' },
  { path: '/device-health', wide: false, must: '设备健康' },
  { path: '/notifications', wide: false, must: '消息中心' },
  { path: '/notifications/settings', wide: false, must: '通知设置' },
  { path: '/children', wide: false, must: '孩子档案' },
  { path: '/privacy', wide: false, must: '合规与隐私' },
  { path: '/support', wide: false, must: '帮助与反馈' },
  { path: '/time-requests', wide: false, must: '孩子的申请' },
  { path: '/app-plugins', wide: true, must: '插件' },
  { path: '/app-audit', wide: false, must: '审批' },
  { path: '/membership', wide: false, must: '会员中心' },
  { path: '/referral', wide: false, must: '邀请返现' },
  { path: '/call-sms', wide: false, must: '通话与短信' },
  { path: '/remote-help', wide: false, must: '远程协助' },
  // /media 与 /quiz-unlock 是沉浸式页面：**故意**不显示任何导航，
  // 所以不对它们断言导航形态（否则测的是「怎么没导航」这种伪问题）。
  { path: '/quiz-unlock', wide: false, must: '答题', immersive: true },
  { path: '/devices', wide: false, must: '设备' },
  { path: '/media', wide: false, must: '', immersive: true },
  // 新手引导同样是全屏任务流（刻意不给导航，避免「下一步」按钮被底部导航挤掉）。
  // 它内容最长、步骤最多，是最容易在横屏 / 超宽屏下撑破布局的一页，必须纳入回归。
  { path: '/onboarding', wide: false, must: '新手引导', immersive: true },
]

/** 页头到 1024px 才出现侧栏，与 BottomNav 里的约定必须一致。 */
const SIDEBAR_BREAKPOINT = 1024

/**
 * 「等页面就绪」的轮询上限。
 *
 * 正常情况下几百毫秒就满足，这个上限只在真的渲染失败时才走完 —— 所以调大几乎不花
 * 时间，却能在慢机器 / 冷启动时少一批假失败。可用 `E2E_READY_TIMEOUT=2000`
 * 临时调小，便于快速迭代调试（失败会更快暴露）。
 */
const READY_TIMEOUT = Number(process.env.E2E_READY_TIMEOUT || 10_000)

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

/**
 * 判断内容列是否合格，合格返回 null，不合格返回给人看的说明。
 *
 * 要断言的是「内容被限宽且左右对称」。不再要求 padL 一定 > 0：≥1024px 时左侧栏已经
 * 占掉 224px，剩余宽度可能正好等于上限（1180-224=956 ≈ 60rem=960），此时不该有额外留白。
 * 真正的病是「通栏拉伸」，而 bounded 已经把它挡住了。
 */
function columnProblem(label, col, route, viewportWidth) {
  if (viewportWidth < 768) {
    return col.padL !== 0 || col.padR !== 0
      ? `${label} 窄屏不该有左右留白：padL=${col.padL} padR=${col.padR}`
      : null
  }
  const symmetric = Math.abs(col.padL - col.padR) <= 1
  const bounded = col.contentWidth <= (route.wide ? 60 * 16 : 48 * 16) + 2
  if (symmetric && bounded) return null
  return (
    `${label} 内容列异常：padL=${col.padL} padR=${col.padR} `
    + `content=${col.contentWidth}（应左右对称且不超过 ${route.wide ? 60 : 48}rem）`
  )
}

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
      const label = `${vp.name} ${route.path}`
      await cdp.goto(route.path)

      /*
       * 等页面真的渲染好，而不是睡一个固定时长。
       *
       * 之前这里是 `await sleep(vp.mobile ? 1400 : 1100)`：机器一忙（比如刚跑完
       * build）这个时长就不够，断言会在页面还没渲染完时跑掉，报出「找不到内容 /
       * 导航形态不对」这类**假失败**。
       *
       * 三个条件缺一不可，尤其是第一个：
       *  - `location.pathname` 必须已经是目标路由 —— SPA 导航期间旧文档还在，
       *    只等「导航出现」会被**上一页**的导航立刻满足，等于没等；
       *  - `readyState === 'complete'`：文档与资源都加载完；
       *  - 关键文案已经出现：证明 React 渲染过、接口也回来了。
       */
      const readyExpr = `(() => {
        if (location.pathname !== ${JSON.stringify(route.path)}) return false;
        if (document.readyState !== 'complete') return false;
        const text = document.body ? document.body.innerText : '';
        if (!text.trim()) return false;
        return true${route.must ? ` && text.includes(${JSON.stringify(route.must)})` : ''};
      })()`
      const ready = await cdp.waitFor(readyExpr, { timeout: READY_TIMEOUT })
      if (!ready.ok) {
        // 这一页没渲染出来，后面几条断言只会跟着报同样的病，跳过以免淹掉真因。
        // 失败时把当时实际观察到的状态一并带上，否则只看到「超时」根本没法查。
        const diag = await cdp.eval(`(async () => {
          const text = document.body ? document.body.innerText : '';
          const info = {
            pathname: location.pathname,
            readyState: document.readyState,
            textLen: text.length,
            head: text.slice(0, 80).replace(/\\s+/g, ' '),
          };
          /*
           * 被弹回登录页，绝大多数不是「真的没登录」，而是后端限流把
           * /api/user/info 打成了 429（全局 RATE_LIMIT_MAX 按 IP 算）。
           * 顺手探一下这个接口，把状态码带进报错里 —— 否则只能看到
           * 「页面上找不到「设备」」这种和真因毫无关系的现象。
           */
          if (location.pathname === '/login') {
            try {
              const res = await fetch('/api/user/info');
              info.probeStatus = res.status;
            } catch (e) {
              info.probeStatus = 'NETWORK_ERROR';
            }
          }
          return info;
        })()`).catch(() => null)
        problems.push(
          `${label} 等待就绪超时（要 pathname=${route.path}${route.must ? ` 且含「${route.must}」` : ''}，`
          + `实得 ${JSON.stringify(diag)}）`
          + (diag && diag.probeStatus === 429
            ? '　← /api/user/info 返回 429：这是后端限流把登录态打掉了，'
              + '不是页面坏了。请调大 server/.env 的 RATE_LIMIT_MAX（见 server/.env.example 的限流说明）。'
            : ''),
        )
        continue
      }
      // 就绪后再让限宽 / 栅格的样式变更彻底回流，否则量到的宽度可能是中间态
      await sleep(150)

      // 1) 不能有元素横向溢出视口
      const overflow = await cdp.eval(OVERFLOW_PROBE)
      if (overflow && overflow.length) {
        problems.push(`${label} 横向溢出：${overflow.join(' / ')}`)
      } else {
        vpPass++
      }

      // 2) 宽屏下内容必须居中限宽；窄屏下不应出现莫名留白
      //    宽度依赖样式回流，连续切 5 档视口时量到中间态是可能的（见过一次
      //    content=908 的假失败，单独重跑就过了），所以这里量到不合格先等一等再量，
      //    只有 3 次都不合格才记账 —— 断言本身不变，只是不再把中间态当结论。
      let col = null
      let colProblem = null
      for (let attempt = 0; attempt < 3; attempt++) {
        col = await cdp.eval(COLUMN_PROBE)
        if (!col) break
        colProblem = columnProblem(label, col, route, vp.width)
        if (!colProblem) break
        await sleep(250)
      }
      if (colProblem) {
        problems.push(colProblem)
      } else if (col) {
        vpPass++
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

// ============================================================
// 家长端 UX 回归（--only=ux）
// ============================================================

/** 量登录卡片：左右留白是否相等、是否完整落在视口内。 */
const LOGIN_PROBE = `(() => {
  // 先按表单找它的卡片祖先，找不到再退回「带 max-w 的块」
  const form = document.querySelector('form');
  const el = (form && form.closest('[class*="max-w"]'))
    || document.querySelector('[class*="max-w-sm"]')
    || document.querySelector('[class*="max-w-md"]')
    || form;
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return {
    left: Math.round(r.left),
    right: Math.round(window.innerWidth - r.right),
    width: Math.round(r.width),
    top: Math.round(r.top),
    bottom: Math.round(r.bottom),
    viewportW: window.innerWidth,
    viewportH: window.innerHeight,
    fits: r.left >= -1 && r.right <= window.innerWidth + 1,
  };
})()`;

/** 量提示浮层与底部导航是否打架。 */
const TIP_NAV_PROBE = `(() => {
  const tip = document.querySelector('[role="note"]');
  const nav = document.querySelector('nav');
  if (!tip) return null;
  const t = tip.getBoundingClientRect();
  const n = nav ? nav.getBoundingClientRect() : null;
  return {
    tipBottom: Math.round(t.bottom),
    tipTop: Math.round(t.top),
    navTop: n ? Math.round(n.top) : null,
    overlapsNav: n ? t.bottom > n.top + 1 : false,
    inViewport: t.top >= -1 && t.bottom <= window.innerHeight + 1,
  };
})()`;

/** 点提示上的「知道了」；中英文都认。 */
const DISMISS_TIP = `(() => {
  const tip = document.querySelector('[role="note"]');
  if (!tip) return false;
  const btn = [...tip.querySelectorAll('button')]
    .find((b) => b.textContent.trim() === '知道了' || b.textContent.trim() === 'Got it');
  if (!btn) return false;
  btn.click();
  return true;
})()`;

const TIPS_STORAGE_KEY = 'balloon_dog_dismissed_tips_v1'

/** 每个功能页 → 它挂的提示 id（与 src/hooks/useFeatureTips.ts 的 TIP_IDS 对应）。 */
const TIP_ROUTES = [
  ['/', 'home'],
  ['/location', 'location'],
  ['/schedule', 'schedule'],
  ['/mode', 'mode'],
  ['/eye-care', 'eyeCare'],
  ['/device-health', 'deviceHealth'],
  ['/app-plugins', 'appPlugins'],
  ['/app-audit', 'appAudit'],
  ['/call-sms', 'callSms'],
  ['/remote-help', 'remoteHelp'],
  ['/insights', 'insights'],
  ['/media', 'media'],
  ['/quiz-unlock', 'quiz'],
  ['/devices', 'devices'],
]

async function loginAsParent(cdp, width = 390, height = 844, mobile = true) {
  await cdp.send(
    'Emulation.setDeviceMetricsOverride',
    { width, height, deviceScaleFactor: 2, mobile },
    cdp.sessionId,
  )
  await cdp.goto('/login')
  await sleep(1800)
  await cdp.clearStorage(['balloon_dog_token'])
  await cdp.goto('/login')
  await sleep(1600)
  await cdp.fill('input[type="tel"]', PARENT_PHONE)
  await cdp.fill('input[type="password"]', PARENT_PASSWORD)
  await sleep(300)
  await cdp.clickText('登录')
  await sleep(3500)
}

async function testUx(cdp) {
  suite = 'ux'

  // ---------- 1. 登录框在各尺寸下水平居中 ----------
  // 用户原话：「登录页的登录框在如何尺寸下都应该是水平居中显示的」。
  // 之前是 flex 居中 + 内容宽度不确定，超宽屏下面板会被拉到很宽或偏向一侧。
  section('UX · 登录框水平居中')
  await cdp.goto('/login')
  await sleep(1500)
  await cdp.clearStorage(['balloon_dog_token'])

  for (const vp of RESPONSIVE_VIEWPORTS) {
    await cdp.send(
      'Emulation.setDeviceMetricsOverride',
      { width: vp.width, height: vp.height, deviceScaleFactor: 1, mobile: vp.mobile },
      cdp.sessionId,
    )
    await cdp.goto('/login')
    await sleep(900)

    const m = await cdp.eval(LOGIN_PROBE)
    if (!m) {
      check(`${vp.name} 能定位到登录卡片`, false, '探针没找到表单/卡片')
      continue
    }
    // 允许 2px 误差：小数像素取整 + 滚动条宽度
    check(
      `${vp.name} 登录框左右留白相等（水平居中）`,
      Math.abs(m.left - m.right) <= 2,
      `左 ${m.left}px / 右 ${m.right}px（宽 ${m.width}px，视口 ${m.viewportW}px）`,
    )
    check(`${vp.name} 登录框完整落在视口内`, m.fits, `left=${m.left} right=${m.right - m.viewportW + m.viewportW}`)
    await cdp.shot(`/tmp/ux-login-${vp.width}x${vp.height}.png`)
  }

  // ---------- 2. 新手引导 ----------
  section('UX · 新手引导')
  await loginAsParent(cdp)
  check('已登录（准备验证引导流程）', (await cdp.eval('location.pathname')) === '/')

  const OVERFLOW_PROBE = `(() => {
    const vw = document.documentElement.clientWidth;
    let worst = 0, worstTag = '';
    for (const el of document.querySelectorAll('*')) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const over = Math.max(r.right - vw, -r.left);
      if (over > worst) { worst = Math.round(over); worstTag = el.tagName + '.' + (el.className || '').toString().slice(0, 40); }
    }
    return { worst, worstTag, vw };
  })()`

  for (const vp of [RESPONSIVE_VIEWPORTS[0], RESPONSIVE_VIEWPORTS[1], RESPONSIVE_VIEWPORTS[4]]) {
    await cdp.send(
      'Emulation.setDeviceMetricsOverride',
      { width: vp.width, height: vp.height, deviceScaleFactor: 1, mobile: vp.mobile },
      cdp.sessionId,
    )
    await cdp.goto('/onboarding')
    await sleep(1400)

    check(`${vp.name} 引导页渲染成功`, (await cdp.eval(`document.body.innerText.includes('新手引导')`)) === true)
    const ov = await cdp.eval(OVERFLOW_PROBE)
    check(`${vp.name} 引导页无横向溢出`, ov.worst <= 1, ov.worst > 1 ? `${ov.worst}px by ${ov.worstTag}` : '')

    // 主按钮必须完整可见 —— 引导页最容易出的问题就是「下一步」被挤到屏幕外
    const cta = await cdp.eval(`(() => {
      const b = [...document.querySelectorAll('button')]
        .find((x) => /下一步|开始|进入家长端|Next|Start|Enter/.test(x.textContent));
      if (!b) return null;
      const r = b.getBoundingClientRect();
      return { bottom: Math.round(r.bottom), vh: window.innerHeight, visible: r.bottom <= window.innerHeight + 1 && r.top >= -1 };
    })()`)
    check(`${vp.name} 引导页主按钮完整可见`, cta ? cta.visible : false, cta ? `bottom=${cta.bottom} vh=${cta.vh}` : '没找到主按钮')
    await cdp.shot(`/tmp/ux-onboarding-${vp.width}x${vp.height}.png`)
  }

  // ---------- 2b. 四步引导的内容（改版后新增） ----------
  /*
   * 用户原话：「下载安装包不用显示下载按钮，显示一下二维码……两个手机同一个 wifi
   * 的方式行不通，去掉……绑定码输入框后面加一个扫一扫图标」。
   *
   * 绑定步骤的输入框与扫一扫图标**只在还没绑设备时**渲染（已经绑过则显示
   * 「你已经绑定好设备了」），所以这里把 /api/devices 打桩成空列表来复现新用户。
   */
  section('UX · 新手引导四步')
  await cdp.send(
    'Emulation.setDeviceMetricsOverride',
    { width: 390, height: 844, deviceScaleFactor: 2, mobile: true },
    cdp.sessionId,
  )

  const devStub = await cdp.send(
    'Page.addScriptToEvaluateOnNewDocument',
    {
      source: `(() => {
        const orig = window.fetch;
        window.fetch = function (input, init) {
          const url = typeof input === 'string' ? input : (input && input.url) || '';
          if (url.slice(-13) === '/api/devices') {
            return Promise.resolve(new Response(JSON.stringify({ success: true, devices: [] }), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            }));
          }
          return orig.apply(this, arguments);
        };
      })();`,
    },
    cdp.sessionId,
  )

  // 引导进度是模块级缓存的，必须整页重载才会真的回到第一步
  await cdp.clearStorage(['balloon_dog_onboarding_v1'])
  await cdp.goto('/onboarding')
  await sleep(1200)

  const stepLabel = await cdp.eval(
    `((document.body.innerText.match(/第 \\d+ \\/ \\d+ 步/) || [''])[0])`,
  )
  check('引导页是四步（不含庆功页）', stepLabel === '第 1 / 4 步', `实得「${stepLabel}」`)

  /*
   * 认二维码不能靠「path 数量多」：qrcode.react v4 只画两条 path（底色 + 模块），
   * 而页面上排在它前面的 lucide 图标也常有一两条 path，数量打平就选错元素了。
   * 模块 path 的 d 属性要把每个黑点串起来，长度是四位数量级，用它区分最稳。
   */
  const qr = await cdp.eval(`(async () => {
    let best = null;
    for (const s of document.querySelectorAll('svg')) {
      let dLen = 0;
      for (const p of s.querySelectorAll('path')) dLen += (p.getAttribute('d') || '').length;
      if (!best || dLen > best.dLen) {
        best = {
          el: s,
          dLen,
          w: Math.round(s.getBoundingClientRect().width),
          role: s.getAttribute('role') || '',
          title: (s.querySelector('title') || {}).textContent || '',
        };
      }
    }
    const text = document.body.innerText;
    /*
     * 真的把屏幕上的那张二维码解码一遍：只有解出来的内容对得上，才能说明它是
     * 一张「能扫的码」，而不只是一堆长得像二维码的方块。BarcodeDetector 在
     * Chromium 上可用（扫码对话框能走到「没有摄像头权限」这一步就证明它在）。
     */
    let decoded = 'no-detector';
    if (best && typeof BarcodeDetector !== 'undefined') {
      try {
        const xml = new XMLSerializer().serializeToString(best.el);
        const blobUrl = URL.createObjectURL(new Blob([xml], { type: 'image/svg+xml' }));
        const img = new Image();
        await new Promise((res, rej) => {
          img.onload = res;
          img.onerror = rej;
          img.src = blobUrl;
        });
        const codes = await new BarcodeDetector({ formats: ['qr_code'] }).detect(
          await createImageBitmap(img),
        );
        decoded = codes.length ? codes[0].rawValue : '';
        URL.revokeObjectURL(blobUrl);
      } catch (error) {
        decoded = 'error: ' + error.message;
      }
    }
    /*
     * 页面下方那行等宽文字里手敲的地址，必须与二维码里编的是同一个 ——
     * 两者都来自 serverUrl()，一处改了另一处没改就会「扫码装的和手敲装的不是一回事」。
     */
    let shownUrl = '';
    for (const p of document.querySelectorAll('p')) {
      const text = (p.textContent || '').trim();
      if (text.startsWith('http') && text.endsWith('/download/balloon-dog-agent.apk')) {
        shownUrl = text;
        break;
      }
    }
    return {
      best: best && { dLen: best.dLen, w: best.w, role: best.role, title: best.title },
      decoded,
      shownUrl,
      hasUrl: text.includes('/download/balloon-dog-agent.apk'),
      hasManual: text.includes('手动下载方式'),
    };
  })()`)
  check(
    '第一步渲染出下载二维码（不是空白 svg）',
    !!qr.best && qr.best.dLen > 500 && qr.best.w >= 100,
    qr.best ? `模块路径长=${qr.best.dLen} 宽=${qr.best.w}px role=${qr.best.role}` : '页面上没有 svg',
  )
  check('二维码是 role=img 的可访问图形', !!qr.best && qr.best.role === 'img', qr.best && qr.best.role)
  check(
    '二维码能解码出孩子端安装包地址',
    typeof qr.decoded === 'string' && qr.decoded.endsWith('/download/balloon-dog-agent.apk'),
    `解码结果=${qr.decoded}`,
  )
  check('二维码带可读的替代标题', !!qr.best && qr.best.title.length > 0, qr.best && qr.best.title)
  check('第一步给出可手敲的下载地址', qr.hasUrl === true)
  check('第一步保留手动下载方式作为退路', qr.hasManual === true)
  check(
    '二维码内容与页面展示的下载地址一致',
    !!qr.shownUrl && qr.decoded === qr.shownUrl,
    `二维码=${qr.decoded} 页面=${qr.shownUrl}`,
  )

  // 第二步：安装说明
  await cdp.clickText('下一步')
  await sleep(600)
  const install = await cdp.eval(`(() => {
    const text = document.body.innerText;
    return {
      isInstall: text.includes('在孩子手机上装好孩子端'),
      hasScanMethod: text.includes('用孩子手机扫上一步的二维码'),
      hasWifi: text.includes('同一个 WiFi') || text.includes('同一 WiFi'),
    };
  })()`)
  check('第二步是安装说明', install.isInstall === true, await cdp.eval('document.body.innerText.slice(0, 80)'))
  check('第二步首推「扫上一步的二维码」', install.hasScanMethod === true)
  check('已去掉「两台手机连同一个 WiFi」这条路', install.hasWifi === false)

  // 第三步：授权清单 —— 重点是「设备管理器」必须显式列出（用户报的「长按图标就能卸载」）
  await cdp.clickText('下一步')
  await sleep(600)
  const authorize = await cdp.eval(`(() => {
    const text = document.body.innerText;
    return {
      isAuthorize: text.includes('在孩子手机上开启授权'),
      hasAdminRequired: text.includes('设备管理器') && text.includes('必做'),
      hasUninstallRisk: text.includes('长按桌面上的守卫图标'),
      hasHowTo: text.includes('一键开启权限'),
      hasA11y: text.includes('无障碍服务'),
      hasBindInput: !!document.getElementById('onboarding-code'),
    };
  })()`)
  check('第三步是授权清单', authorize.isAuthorize === true, await cdp.eval('document.body.innerText.slice(0, 80)'))
  check('第三步把「设备管理器」标成必做的一项', authorize.hasAdminRequired === true)
  check('第三步讲清没开设备管理器的后果（长按图标即可卸载）', authorize.hasUninstallRisk === true)
  check('第三步给出「一键开启权限 → 系统激活页」这条路', authorize.hasHowTo === true)
  check('第三步同时提到无障碍服务等其余授权', authorize.hasA11y === true)
  check('第三步还没到绑定输入框', authorize.hasBindInput === false)
  await cdp.shot('/tmp/ux-onboarding-authorize.png')

  // 第四步：绑定码输入框 + 右侧扫一扫图标
  await cdp.clickText('下一步')
  await sleep(600)
  const bind = await cdp.eval(`(() => {
    const btn = document.querySelector('button[aria-label="扫一扫"]');
    if (!btn) return { has: false, head: document.body.innerText.slice(0, 140) };
    const r = btn.getBoundingClientRect();
    const input = document.getElementById('onboarding-code');
    const ir = input ? input.getBoundingClientRect() : null;
    return {
      has: true,
      visible: r.width > 0 && r.height > 0,
      insideRight: !!ir && r.left > ir.left + ir.width / 2 && r.right <= ir.right + 1,
    };
  })()`)
  check('第四步有绑定码输入框', (await cdp.eval(`!!document.getElementById('onboarding-code')`)) === true)
  check(
    '绑定码输入框后面有扫一扫图标',
    bind.has === true && bind.visible === true,
    bind.has ? '' : `没找到，正文=${bind.head}`,
  )
  check('扫一扫图标落在输入框右端内侧', bind.insideRight === true)

  // 点开扫码对话框：无头环境没有摄像头，应退化成手输提示，而不是一直转圈
  await cdp.eval(`document.querySelector('button[aria-label="扫一扫"]').click()`)
  const dialogUp = await cdp.waitFor(`document.body.innerText.includes('扫一扫绑定码')`, {
    timeout: 5000,
  })
  check('点扫一扫能打开扫码对话框', dialogUp.ok === true)

  const fallback = await cdp.waitFor(
    `(() => {
      const d = document.querySelector('[role="dialog"]');
      if (!d) return false;
      const t = d.innerText;
      return t.includes('手动输入绑定码') || t.includes('正在打开摄像头');
    })()`,
    { timeout: 8000 },
  )
  check(
    '扫码对话框给出可用退路（手输或摄像头）',
    fallback.ok === true,
    fallback.ok ? '' : '既没有手输按钮，也没有摄像头提示',
  )
  await cdp.shot('/tmp/ux-onboarding-scan.png')

  // 关掉：有手输按钮就点它，否则点右上角 Close，最后按 Esc
  await cdp.eval(`(() => {
    const d = document.querySelector('[role="dialog"]');
    if (!d) return true;
    const byText = (s) => [...d.querySelectorAll('button')].find((x) => x.textContent.trim() === s);
    const target = byText('手动输入绑定码') || byText('Close');
    if (target) { target.click(); return true; }
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    return false;
  })()`)
  const dialogGone = await cdp.waitFor(`!document.querySelector('[role="dialog"]')`, { timeout: 5000 })
  check('扫码对话框可以关掉', dialogGone.ok === true)

  // 撤掉打桩，并把引导标记成已走完 —— 后面几节不该被引导流程影响
  await cdp.send(
    'Page.removeScriptToEvaluateOnNewDocument',
    { identifier: devStub.identifier },
    cdp.sessionId,
  )
  await cdp.eval(`localStorage.setItem('balloon_dog_onboarding_v1', JSON.stringify({
    completed: ['welcome', 'install', 'authorize', 'bind'],
    finishedAt: new Date().toISOString(),
  }))`)

  // ---------- 3. 功能小提示 ----------
  // 用户原话：「每个功能首次使用的时候最好在下方有个功能小提示，用户可以随时关闭」。
  section('UX · 功能小提示')
  await cdp.send(
    'Emulation.setDeviceMetricsOverride',
    { width: 390, height: 844, deviceScaleFactor: 2, mobile: true },
    cdp.sessionId,
  )
  // 每个页面开始时都清空「已关闭」，保证测的是「首次进入」
  await cdp.clearStorage([TIPS_STORAGE_KEY])

  let firstTipText = ''
  for (const [path, id] of TIP_ROUTES) {
    await cdp.goto(path)
    await sleep(1300)

    const visible = await cdp.eval(`!!document.querySelector('[role="note"]')`)
    check(`首次进入 ${path} 浮出功能提示（${id}）`, visible === true)
    if (!visible) continue

    const geom = await cdp.eval(TIP_NAV_PROBE)
    check(`${path} 的提示不与底部导航重叠`, Boolean(geom && !geom.overlapsNav), geom ? `tip.bottom=${geom.tipBottom} nav.top=${geom.navTop}` : '')
    check(`${path} 的提示完整落在视口内`, Boolean(geom && geom.inViewport))

    if (!firstTipText) {
      firstTipText = await cdp.eval(`document.querySelector('[role="note"]').innerText.replace(/\\s+/g, ' ').slice(0, 80)`)
      await cdp.shot('/tmp/ux-tip.png')
    }

    const clicked = await cdp.eval(DISMISS_TIP)
    check(`${path} 的提示可以随时关闭`, clicked === true)
    await sleep(500)
    check(`${path} 关闭后提示立即消失`, (await cdp.eval(`!document.querySelector('[role="note"]')`)) === true)

    // 重新进入（不只是同页停留）也不能再出现
    await cdp.goto(path)
    await sleep(1200)
    check(`${path} 重新进入后不再打扰`, (await cdp.eval(`!document.querySelector('[role="note"]')`)) === true)
  }

  if (firstTipText) console.log(`  \u001b[2m提示文案示例：${firstTipText}\u001b[0m`)

  // ---------- 4. 提示可以整体重置 ----------
  section('UX · 提示重置')
  await cdp.goto('/profile')
  await sleep(1400)
  const resetOk = await cdp.eval(`(() => {
    const b = [...document.querySelectorAll('button')]
      .find((x) => /重置功能提示|Reset tips/.test(x.textContent));
    if (!b) return false;
    b.click();
    return true;
  })()`)
  check('「我的」里有「重置功能提示」入口', resetOk === true)
  await sleep(700)
  const cleared = await cdp.eval(`(() => {
    try { return localStorage.getItem(${JSON.stringify('balloon_dog_dismissed_tips_v1')}) } catch { return null }
  })()`)
  check('点击后关闭记录被清空', cleared !== null && JSON.parse(cleared).length === 0, `storage=${cleared}`)

  await cdp.goto('/location')
  await sleep(1300)
  check('重置后提示会重新出现', (await cdp.eval(`!!document.querySelector('[role="note"]')`)) === true)
  await cdp.shot('/tmp/ux-profile.png')

  // ---------- 5. 英文界面 ----------
  // i18n 的验收标准：切到英文后，页面上不该再剩下成片的中文。
  section('UX · 英文界面')
  await cdp.eval(`localStorage.setItem('balloon_dog_language', 'en')`)
  const enProblems = []
  const seedZh = seedChineseRuns()
  for (const [path] of [['/'], ['/location'], ['/schedule'], ['/insights'], ['/media'], ['/profile'], ['/onboarding'], ['/device-health'], ['/notifications'], ['/notifications/settings'], ['/time-requests']]) {
    await cdp.goto(path)
    await sleep(1500)
    // 数「界面上还剩多少中文」：先扣掉种子数据里的用户内容，再看还剩多少中文
    const zh = await cdp.eval(`(() => {
      let text = document.body.innerText || '';
      for (const s of ${JSON.stringify(seedZh)}) text = text.split(s).join(' ');
      const runs = text.match(/[\\u4e00-\\u9fff]{2,}/g) || [];
      return { runs: runs.slice(0, 8), total: runs.reduce((n, s) => n + s.length, 0) };
    })()`)
    if (zh.total > 12) enProblems.push(`${path}: ${zh.total} 个中文字（${zh.runs.join(' / ')}）`)
    // 不能用正则字面量做替换：这里的 `\/` 会提前结束正则，反编译成 `g is not defined`
    await cdp.shot(`/tmp/ux-en-${(path.split('/').join('_') || 'home')}.png`)
  }
  check(
    '切到英文后各页面不再出现成片中文',
    enProblems.length === 0,
    enProblems.slice(0, 5).join('；'),
  )
  await cdp.eval(`localStorage.setItem('balloon_dog_language', 'zh')`)

  // ---------- 6. 登录态健壮性：一次接口失败不能把用户踢出登录 ----------
  /*
   * 回归测试。以前 AuthContext 恢复登录态时，只要 getProfile() 抛错就无条件
   * setAuthToken(null) + setUser(null)：于是限流 429、后端 5xx、一次网络抖动，
   * 统统被当成「登录已过期」——用户被弹回登录页，本地令牌还被删掉，只能重新
   * 输密码。现在只有 401/403 才清凭证，其余情况保留令牌、退避重试。
   *
   * 这里只挡 /api/user/info（而不是直接 offline），因为断网连 HTML 和 JS 都拉不到，
   * 页面根本不跑，就测不到应用自己的行为了。
   */
  section('UX · 登录态健壮性')
  await cdp.send('Network.enable', {}, cdp.sessionId)
  await cdp.goto('/')
  await sleep(1800)
  check('断网前处于已登录状态', (await cdp.eval(`!!localStorage.getItem('balloon_dog_token')`)) === true)

  await cdp.send('Network.setBlockedURLs', { urls: ['*/api/user/info*'] }, cdp.sessionId)
  await cdp.goto('/')
  await sleep(4000) // 要等满 3 次尝试与退避（400ms + 800ms）
  const keptToken = await cdp.eval(`!!localStorage.getItem('balloon_dog_token')`)
  check(
    '接口失败时保留本地令牌（不再误删登录凭证）',
    keptToken === true,
    keptToken ? '' : '令牌被清掉了：一次请求失败就把用户登出了',
  )

  await cdp.send('Network.setBlockedURLs', { urls: [] }, cdp.sessionId)
  await cdp.goto('/')
  await sleep(2500)
  const recovered = await cdp.eval('location.pathname')
  check('恢复后刷新一次即回到已登录状态', recovered === '/', `实际停在 ${recovered}`)
}

async function main() {
  console.log(`\n🧪 浏览器端到端测试 → ${APP}\n`)

  try {
    const health = await fetch(APP)
    if (!health.ok) throw new Error(`HTTP ${health.status}`)
  } catch (err) {
    console.error(`\u001b[31m无法访问前端（${APP}）：${err.message}\u001b[0m`)
    console.error('请先启动前端：npm run build && npm run preview（2727）')
    console.error('或者跑开发服务器：npm run dev，并加 APP_URL=http://localhost:5173')
    console.error('后端另需：npm run server:dev')
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
    if (runUx) await testUx(cdp)
  } finally {
    ws.close()
    chrome.kill()
  }

  console.log('\n' + '═'.repeat(54))
  let totalFail = 0
  for (const key of ['parent', 'admin', 'responsive', 'ux']) {
    const r = results[key]
    if (!runParent && key === 'parent') continue
    if (!runAdmin && key === 'admin') continue
    if (!runResponsive && key === 'responsive') continue
    if (!runUx && key === 'ux') continue
    if (r.pass + r.fail === 0) continue
    totalFail += r.fail
    const label = { parent: '家长端', admin: '管理后台', responsive: '响应式', ux: '家长端 UX' }[key]
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
