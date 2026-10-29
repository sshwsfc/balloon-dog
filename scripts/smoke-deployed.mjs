#!/usr/bin/env node
/**
 * 线上冒烟：用无头 Chrome 真开一遍页面，确认「能跑」而不只是「端口通」。
 *
 * 只做三件事（不登录、不造数据，可以直接对着生产跑）：
 *   1. 抓控制台报错与页面异常；
 *   2. 确认页面真的渲染出文字（不是白屏）；
 *   3. 确认后端接口在当前 origin 下可访问（/api 相对路径 → 反代 → bdog-server）。
 *
 * 用法：
 *   node scripts/smoke-deployed.mjs                       # 默认 https://bdog.gtsiot.cn
 *   node scripts/smoke-deployed.mjs http://bdog.gtsiot.cn  # 证书没装时先验 http
 *   CHROME_PATH=/path/to/chrome node scripts/smoke-deployed.mjs
 *
 * 退出码：0 全通过 / 1 有失败。
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BASE = (process.argv[2] || process.env.APP_URL || 'https://bdog.gtsiot.cn').replace(/\/+$/, '');
const CHROME =
  process.env.CHROME_PATH ||
  [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ].find((p) => fs.existsSync(p));

if (!CHROME) {
  console.error('✗ 找不到 Chrome，用 CHROME_PATH 指定');
  process.exit(1);
}

const PORT = 9333 + Math.floor(Math.random() * 200);
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bdog-smoke-'));
const results = [];

function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function cdpTargets() {
  for (let i = 0; i < 40; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await res.json();
      if (list.length > 0) return list;
    } catch {
      // 还没起来
    }
    await sleep(250);
  }
  throw new Error('Chrome 调试端口没起来');
}

/** 极简 CDP 会话：够用就好，不引依赖。 */
async function session(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error('WebSocket 连接失败'));
  });
  let id = 0;
  const pending = new Map();
  const events = [];
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    } else if (msg.method) {
      events.push(msg);
    }
  };
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      id += 1;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  return { send, events, close: () => ws.close() };
}

async function visit(page, url) {
  page.events.length = 0;
  await page.send('Page.navigate', { url });
  // 等 load 事件 + 给 SPA 一点时间渲染
  for (let i = 0; i < 60; i += 1) {
    if (page.events.some((e) => e.method === 'Page.loadEventFired')) break;
    await sleep(250);
  }
  await sleep(2500);
  const { result } = await page.send('Runtime.evaluate', {
    expression: `JSON.stringify({
      title: document.title,
      text: (document.body && document.body.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 120),
      scripts: [...document.scripts].filter(s => s.src).map(s => s.src).length,
    })`,
    returnByValue: true,
  });
  return JSON.parse(result.value);
}

const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--window-size=390,844',
    'about:blank',
  ],
  { stdio: 'ignore' },
);

let exitCode = 0;
try {
  const targets = await cdpTargets();
  const wsUrl = targets.find((t) => t.type === 'page')?.webSocketDebuggerUrl;
  if (!wsUrl) throw new Error('没有可用的页面 target');
  const page = await session(wsUrl);
  await page.send('Page.enable');
  await page.send('Runtime.enable');
  await page.send('Log.enable');
  await page.send('Network.enable');

  console.log(`线上冒烟：${BASE}`);

  // 1. 家长端首页 → 应该被重定向到 /login
  const home = await visit(page, `${BASE}/`);
  const homeErrors = page.events
    .filter(
      (e) =>
        (e.method === 'Runtime.exceptionThrown') ||
        (e.method === 'Log.entryAdded' && e.params.entry.level === 'error') ||
        (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error'),
    )
    .map((e) =>
      e.method === 'Log.entryAdded'
        ? e.params.entry.text
        : e.method === 'Runtime.consoleAPICalled'
          ? e.params.args.map((a) => a.value ?? a.description).join(' ')
          : e.params.exceptionDetails?.exception?.description || 'exception',
    )
    .filter((t) => !/favicon|Failed to load resource: the server responded with a status of 401/i.test(t));

  check('家长端能打开（JS 执行、有文字）', home.text.length > 20, home.text.slice(0, 60));
  check('落到登录页', /气球狗|登录|手机号/.test(home.text), `title=${home.title}`);
  check('控制台无报错', homeErrors.length === 0, homeErrors.slice(0, 2).join(' | '));

  // 可选：把家长端首页存一张图，便于把「线上长什么样」留档
  if (process.env.SMOKE_SHOT) {
    const shot = await page.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(process.env.SMOKE_SHOT, Buffer.from(shot.data, 'base64'));
    console.log(`  · 截图 → ${process.env.SMOKE_SHOT}`);
  }

  // 2. 管理后台
  const admin = await visit(page, `${BASE}/admin/login`);
  const adminErrors = page.events
    .filter(
      (e) =>
        e.method === 'Runtime.exceptionThrown' ||
        (e.method === 'Log.entryAdded' && e.params.entry.level === 'error'),
    )
    .map((e) => (e.params.entry?.text || e.params.exceptionDetails?.exception?.description || 'exception'))
    .filter((t) => !/favicon/i.test(t));
  check('管理后台能打开', admin.text.length > 20, admin.text.slice(0, 60));
  check('管理后台控制台无报错', adminErrors.length === 0, adminErrors.slice(0, 2).join(' | '));

  // 3. 接口连通（相对路径 /api → 反代 → 后端；未登录应 401 且是 JSON）
  const api = await page.send('Runtime.evaluate', {
    expression: `fetch('/api/payments/catalog').then(r => r.text().then(t => JSON.stringify({status: r.status, body: t.slice(0, 80)}))).catch(e => JSON.stringify({status: 0, body: String(e)}))`,
    awaitPromise: true,
    returnByValue: true,
  });
  const apiRes = JSON.parse(api.result.value);
  check('接口走同源反代（未登录 401 JSON）', apiRes.status === 401 && apiRes.body.includes('UNAUTHORIZED'), `${apiRes.status} ${apiRes.body.slice(0, 40)}`);

  // 4. 安装包可下载且是真 APK（ZIP 魔数 PK）
  const apk = await page.send('Runtime.evaluate', {
    expression: `fetch('/download/balloon-dog-agent.apk').then(r => r.arrayBuffer()).then(b => JSON.stringify({status: 200, size: b.byteLength, isZip: new DataView(b).getUint8(0) === 0x50 && new DataView(b).getUint8(1) === 0x4b})).catch(e => JSON.stringify({status: 0, size: 0, isZip: false}))`,
    awaitPromise: true,
    returnByValue: true,
  });
  const apkRes = JSON.parse(apk.result.value);
  check(
    '安装包可下载且是真 APK',
    apkRes.isZip && apkRes.size > 1_000_000,
    `${(apkRes.size / 1024 / 1024).toFixed(1)}MB, PK=${apkRes.isZip}`,
  );

  // 5. 可选：真登录一遍（需要事先存在的账号；只填 SMOKE_PHONE / SMOKE_PASSWORD 时执行）
  //    这一步证明的是「登录 → JWT 落盘 → 受保护页面拿到数据」整条链在生产上通。
  if (process.env.SMOKE_PHONE && process.env.SMOKE_PASSWORD) {
    await visit(page, `${BASE}/login`);
    const filled = await page.send('Runtime.evaluate', {
      expression: `(() => {
        const setVal = (el, v) => {
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          setter.call(el, v);
          el.dispatchEvent(new Event('input', { bubbles: true }));
        };
        const inputs = [...document.querySelectorAll('input')].filter(i => i.type !== 'hidden');
        if (inputs.length < 2) return JSON.stringify({ ok: false, why: 'input 不足' });
        setVal(inputs[0], ${JSON.stringify(process.env.SMOKE_PHONE)});
        setVal(inputs[1], ${JSON.stringify(process.env.SMOKE_PASSWORD)});
        const btn = [...document.querySelectorAll('button')].find(b => /^登\s*录$/.test((b.innerText || '').trim()));
        if (!btn) return JSON.stringify({ ok: false, why: '找不到登录按钮' });
        btn.click();
        return JSON.stringify({ ok: true, inputs: inputs.length });
      })()`,
      returnByValue: true,
    });
    const fillRes = JSON.parse(filled.result.value);
    check('登录表单可填写并提交', fillRes.ok, fillRes.why || '');
    await sleep(4000);
    const after = await page.send('Runtime.evaluate', {
      expression: `JSON.stringify({ url: location.pathname, text: (document.body.innerText||'').replace(/\\s+/g,' ').trim().slice(0, 160), token: Boolean(localStorage.getItem('balloon_dog_token')) })`,
      returnByValue: true,
    });
    const land = JSON.parse(after.result.value);
    check('登录成功并离开 /login', land.url !== '/login' && land.token, `path=${land.url} token=${land.token}`);
    check('首页拿到真实内容', land.text.length > 20, land.text.slice(0, 70));
  }

  page.close();
  if (results.some((r) => !r.ok)) exitCode = 1;
} catch (error) {
  console.error(`✗ 冒烟异常：${error.message}`);
  exitCode = 1;
} finally {
  chrome.kill('SIGKILL');
  // Chrome 被杀掉时还在往 profile 目录里写，直接 rm 会偶发 ENOTEMPTY —— 重试几次再算了
  try {
    fs.rmSync(profileDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 120 });
  } catch {
    // 临时目录残留不影响结论
  }
}

console.log(exitCode === 0 ? '\n✓ 线上冒烟全部通过' : '\n✗ 线上冒烟有失败项');
process.exit(exitCode);
