#!/usr/bin/env node
/**
 * 灰度开关端到端验证（规划 §5.5）。
 *
 * §5.5 的开关不是「配置项」而是**放量装置**，所以这个脚本盯的是四件容易写错的事：
 *
 *   1. **同一个对象每次都命中同一个结果**：预览三次、结论必须一模一样 ——
 *      开关每次刷新都翻脸，运营就没法拿它做放量（用 md5 稳定哈希，不是随机数）；
 *   2. **白名单能压过关闭**：`enabled=false` + 白名单里有这个账号 → 仍然命中，
 *      而且 `reason` 要如实说是「白名单」而不是「放量」；
 *   3. **没建行 = 代码默认值**：迁移会播种，但运维把行删了不能让功能消失 ——
 *      开关读不到行时必须回落到代码默认（这条要用 prisma 直删来验，拿不到就响亮跳过）；
 *   4. **开关真的接到了业务上**：关掉支付宝 → 家长端支付目录里不再有它、下单 503；
 *      关掉自助退款 → 家长 403 而后台人工退款照样能用（关的是「自助」，不是「退款」）。
 *
 * 这个脚本**自己拉起一个后端实例**（:4103），因为需要 `PAYMENT_FAKE_PROVIDER=true`
 * 才能在不接真实商户号的情况下把「已支付订单」造出来（退款开关要在已支付订单上验）。
 *
 * 开关是**全局状态**：脚本在结束（包括中途抛错）时会把五个开关全部 reset 回代码默认，
 * 避免一次中断的运行留下关闭的渠道，毒化后面的套件（referral 有过这个教训）。
 *
 * 用法：node scripts/e2e-flags.mjs
 */

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = path.resolve(HERE, '..');

const APP_PORT = Number(process.env.FLAGS_E2E_PORT || 4103);
const API = `http://127.0.0.1:${APP_PORT}/api`;
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'balloon-admin-2026';
const FAKE_SECRET = 'fake-secret';
const ALL_FLAGS = [
  'pay.channel.alipay',
  'pay.channel.wechat',
  'pay.refund.selfservice',
  'notify.wechat.dispatch',
  'support.tickets',
];

let passed = 0;
let failed = 0;
const ok = (m) => { passed++; console.log(`  \x1b[32m✓\x1b[0m ${m}`) };
const bad = (m, extra = '') => { failed++; console.log(`  \x1b[31m✗\x1b[0m ${m}${extra ? ` — ${extra}` : ''}`) };
const check = (c, m, extra = '') => (c ? ok(m) : bad(m, extra));
const step = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);

async function api(method, pathname, { body, token, headers: extraHeaders } = {}) {
  const headers = { ...(extraHeaders || {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${API}${pathname}`, {
    method,
    headers,
    body: body !== undefined ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null } catch { parsed = text }
  return { ok: res.ok, status: res.status, body: parsed, text };
}

const must = async (method, pathname, options) => {
  const r = await api(method, pathname, options);
  if (!r.ok) throw new Error(`${method} ${pathname} → ${r.status} ${r.body?.message || r.text}`);
  return r.body;
};

const sign = (orderNo, amountCents) =>
  crypto.createHash('md5').update(`${orderNo}:${amountCents}:${FAKE_SECRET}`).digest('hex');

const notifyFake = (payload) =>
  api('POST', '/payments/notify/fake', {
    body: JSON.stringify(payload),
    headers: { 'Content-Type': 'application/json' },
  });

function waitFor(url, label, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  return (async () => {
    let lastError = 'timeout';
    while (Date.now() < deadline) {
      try {
        const res = await fetch(url);
        if (res.ok) return;
        lastError = `HTTP ${res.status}`;
      } catch (error) {
        lastError = error.message;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(`${label} 在 ${timeoutMs / 1000}s 内没有就绪（${lastError}）`);
  })();
}

const children = [];
const appLogRef = { value: '' };
function shutdown() {
  for (const child of children) {
    try { child.kill('SIGTERM') } catch { /* 已经退了 */ }
  }
}

async function registerParent(tag) {
  const phone = `137${String(Date.now()).slice(-8)}`;
  const sent = await must('POST', '/auth/send-code', { body: { phone, purpose: 'register' } });
  const reg = await must('POST', '/auth/register', {
    body: { phone, password: 'e2e-flags-123', code: sent.devCode, nickname: tag },
  });
  return { token: reg.token, userId: reg.user?.id ?? null, phone };
}

async function main() {
  console.log('\x1b[1m气球狗 · 灰度开关端到端验证（§5.5）\x1b[0m');
  console.log(`  后端 ${API}（自带 PAYMENT_FAKE_PROVIDER=true）`);

  const appChild = spawn('npx', ['tsx', 'src/server.ts'], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      PORT: String(APP_PORT),
      NODE_ENV: 'test',
      PAYMENT_FAKE_PROVIDER: 'true',
      MEMBERSHIP_MOCK_PAY: 'false',
      WECHAT_PAY_API_V3_KEY: '',
      RATE_LIMIT_MAX: '100000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(appChild);
  appChild.stdout.on('data', (d) => { appLogRef.value += String(d) });
  appChild.stderr.on('data', (d) => { appLogRef.value += String(d) });

  try {
    await waitFor(`http://127.0.0.1:${APP_PORT}/health`, '带假支付渠道的后端');
    ok(`后端实例已就绪（:${APP_PORT}，共用同一个库）`);
  } catch (error) {
    console.error(`\x1b[31m拉起失败：\x1b[0m ${error.message}`);
    if (appLogRef.value) console.error(appLogRef.value.split('\n').slice(-20).join('\n'));
    shutdown();
    process.exit(1);
  }

  let prisma = null;
  try {
    const mod = await import('@prisma/client');
    prisma = new mod.PrismaClient();
    await prisma.$queryRaw`SELECT 1`;
  } catch {
    prisma = null;
  }

  const admin = await must('POST', '/admin/login', {
    body: { username: ADMIN_USER, password: ADMIN_PASSWORD },
  });
  const adminToken = admin.token;

  const parent = await registerParent('开关E2E');
  const stranger = await registerParent('开关E2E旁观');
  const userIds = [parent.userId, stranger.userId];

  const patch = (key, body) => must('PATCH', `/admin/flags/${key}`, { token: adminToken, body });
  const preview = (key, subjectId) =>
    must('GET', `/admin/flags/${key}/preview${subjectId != null ? `?subjectId=${subjectId}` : ''}`, {
      token: adminToken,
    }).then((r) => r.preview);
  const resetAll = async () => {
    for (const key of ALL_FLAGS) {
      const r = await api('DELETE', `/admin/flags/${key}/reset`, { token: adminToken });
      if (!r.ok) console.log(`  \x1b[33m•\x1b[0m 复位 ${key} → ${r.status}`);
    }
  };

  try {
    // ----------------------------------------------------------
    step('1. 准备：套餐 + 管理员能读开关列表');

    const overview = await must('GET', '/membership', { token: parent.token });
    const plan = (overview.tiers || []).flatMap((t) => t.plans || [])[0];
    if (!plan) throw new Error('没有可购买的套餐，先跑一次 npm run db:seed');
    check(typeof plan.code === 'string', `可用套餐 ${plan.code}（${plan.finalCents} 分）`);

    // ----------------------------------------------------------
    step('2. 默认值来自代码，而不是「数据库里没有就是关」');

    const list = await must('GET', '/admin/flags', { token: adminToken });
    check(list.flags.length === ALL_FLAGS.length, `五个开关都在（${list.flags.length}）`);

    const alipay = list.flags.find((f) => f.key === 'pay.channel.alipay');
    const selfRefund = list.flags.find((f) => f.key === 'pay.refund.selfservice');
    check(alipay && alipay.enabled === true && alipay.rolloutPercent === 100, '支付渠道开关默认 100% 开放（不搞暗放量）');
    check(alipay && alipay.bucket === 'user', '渠道开关按账号分桶（bucket=user）');
    check(selfRefund && selfRefund.enabled === true, '自助退款默认开着');
    check(selfRefund && selfRefund.bucket === 'none', '纯开关型功能不编造放量维度（bucket=none）');
    check(
      list.flags.every((f) => typeof f.wiredAt === 'string' && f.wiredAt.length > 0),
      '每个开关都写明「接到哪儿了」——让人知道关掉会影响什么',
    );

    // ----------------------------------------------------------
    step('3. 同一个对象每次命中同一个结果（稳定哈希，不是随机数）');

    await patch('pay.channel.alipay', { rolloutPercent: 50, enabled: true });
    const first = await preview('pay.channel.alipay', '12345');
    const second = await preview('pay.channel.alipay', '12345');
    const third = await preview('pay.channel.alipay', '12345');
    check(first.hit === second.hit && second.hit === third.hit, '同一个账号预览三次结论一致（前两次刷新不会翻脸）');
    check(typeof first.reasonText === 'string' && first.reasonText.length > 0, `命不命中都给出人能读懂的原因：${first.reasonText}`);

    await patch('pay.channel.alipay', { rolloutPercent: 100 });
    const allHit = [];
    for (let i = 0; i < 5; i++) allHit.push((await preview('pay.channel.alipay', 9000 + i)).hit);
    check(allHit.every(Boolean), '放到 100% 时每个账号都命中');

    await patch('pay.channel.alipay', { rolloutPercent: 0 });
    const noneHit = [];
    for (let i = 0; i < 5; i++) noneHit.push((await preview('pay.channel.alipay', 9100 + i)).hit);
    check(noneHit.every((h) => h === false), '放到 0% 时一个都不命中');
    check((await preview('pay.channel.alipay', 9100)).reason === 'rollout_zero', '0% 的原因如实说是「放量 0%」');

    await patch('pay.channel.alipay', { rolloutPercent: 50 });
    let hits = 0;
    for (let i = 0; i < 40; i++) if ((await preview('pay.channel.alipay', 20000 + i)).hit) hits++;
    check(hits > 5 && hits < 35, `50% 放量在 40 个账号上落在合理区间（命中 ${hits} 个）`);

    const noSubject = await preview('pay.channel.alipay', null);
    check(noSubject.hit === false && noSubject.reason === 'missing_subject', '需要按账号分桶却没给账号 → 不命中，而不是随便放行');

    // ----------------------------------------------------------
    step('4. 白名单压过关闭；不在名单里就老实说被关了');

    await patch('pay.channel.alipay', { enabled: false, allowIds: ['777', '888'] });
    const allowed = await preview('pay.channel.alipay', '777');
    check(allowed.hit === true && allowed.reason === 'allowlisted', '总开关关着，白名单里的账号仍然命中（理由是「白名单」）');
    const denied = await preview('pay.channel.alipay', '999');
    check(denied.hit === false && denied.reason === 'flag_disabled', '不在白名单里的账号被拒，理由是「开关已关闭」');

    // ----------------------------------------------------------
    step('5. 数据库里没有这行 = 用代码默认值（运维删行不能让功能消失）');

    if (prisma) {
      await prisma.runtimeFlag.deleteMany({ where: { key: 'pay.channel.alipay' } });
      const afterDelete = await preview('pay.channel.alipay', '999');
      check(afterDelete.hit === true, '删掉行之后回到代码默认值（仍开放），不是默认关闭');
      check(afterDelete.usingDefaults === true, '并且如实标注「当前用的是代码默认值」');
      const rows = await prisma.runtimeFlag.findMany({ where: { key: 'pay.channel.alipay' } });
      check(rows.length === 0, '读操作不写库（预览不会偷偷把行建回来）');
      const listAfterDelete = await must('GET', '/admin/flags', { token: adminToken });
      check(
        listAfterDelete.flags.find((f) => f.key === 'pay.channel.alipay')?.usingDefaults === true,
        '列表里如实标注「这一行还没落库、用的是代码默认值」（后台可据此一键落库）',
      );
      check(
        listAfterDelete.flags.find((f) => f.key === 'pay.channel.alipay')?.enabled === true,
        '落库与否不影响「现在生效的是什么」',
      );
      await patch('pay.channel.alipay', { enabled: false, allowIds: [] });
    } else {
      for (let i = 0; i < 5; i++) ok('（跳过：拿不到 @prisma/client，删行回落默认值未验证）');
    }

    // ----------------------------------------------------------
    step('6. 开关真的接到了支付目录和下单上');

    const catalogClosed = await must('GET', '/payments/catalog', { token: parent.token });
    const alipayRow = catalogClosed.channels.find((c) => c.key === 'alipay');
    check(alipayRow && alipayRow.enabled === false, '目录里支付宝标成「已被开关关闭」');
    check(!catalogClosed.available.some((c) => c.key === 'alipay'), '不可用渠道不出现在「可支付」列表里（前端不会画出扫不出来的码）');
    check(/运营开关关闭/.test(catalogClosed.notice), '给家长的一句话里说明了是被运营关闭', catalogClosed.notice);
    check(catalogClosed.available.some((c) => c.key === 'fake'), '测试渠道不受渠道开关影响（由 fakeProviderAllowed 单独把关）');

    const order = await must('POST', '/membership/orders', {
      token: parent.token,
      body: { planCode: plan.code, payChannel: 'alipay' },
    });
    const orderNo = order.order.orderNo;
    const closedPay = await api('POST', `/payments/orders/${orderNo}/pay`, { token: parent.token, body: {} });
    check(closedPay.status === 503 && /运营开关关闭/.test(closedPay.body?.message || ''), '被关闭的渠道下单 → 503，文案说清是开关而不是「参数错误」');

    await patch('pay.channel.alipay', { enabled: true, rolloutPercent: 100, allowIds: [] });
    const reopenedPay = await api('POST', `/payments/orders/${orderNo}/pay`, { token: parent.token, body: {} });
    check(reopenedPay.status === 503 && /尚未配置/.test(reopenedPay.body?.message || ''), '开关开了之后挡在前面的是「没配商户号」，而不是开关');
    const catalogOpen = await must('GET', '/payments/catalog', { token: parent.token });
    check(catalogOpen.channels.find((c) => c.key === 'alipay').enabled === true, '目录里支付宝恢复「开放」');

    // ----------------------------------------------------------
    step('7. 自助退款开关：关掉的是「自助」，不是「退款」');

    // 用假渠道把一单付掉（假渠道的开关是 PAYMENT_FAKE_PROVIDER，不是 RuntimeFlag）
    const payable = await must('POST', '/membership/orders', {
      token: parent.token,
      body: { planCode: plan.code, payChannel: 'fake' },
    });
    const paidOrderNo = payable.order.orderNo;
    const amount = payable.order.amountCents;
    await must('POST', `/payments/orders/${paidOrderNo}/pay`, { token: parent.token, body: {} });
    const paid = await notifyFake({ orderNo: paidOrderNo, amountCents: amount, transactionId: 'TX_FLAG_1', sign: sign(paidOrderNo, amount) });
    check(paid.status === 200, '（前置）假渠道回调把这单变成已支付');
    check(
      (await must('GET', `/payments/orders/${paidOrderNo}`, { token: parent.token })).order.canRefund === true,
      '（前置）已支付订单此时可以自助退款',
    );

    await patch('pay.refund.selfservice', { enabled: false });
    const blocked = await api('POST', '/payments/refunds', {
      token: parent.token,
      body: { orderNo: paidOrderNo, reason: '开关关闭时不该让我退' },
    });
    check(blocked.status === 403 && /自助退款/.test(blocked.body?.message || ''), '关掉自助退款 → 家长自助退款 403，文案指向客服');
    const adminRefund = await api('POST', '/admin/payments/refunds', {
      token: adminToken,
      body: { orderNo: paidOrderNo, amountCents: amount, reason: '后台人工退款不受自助开关影响' },
    });
    check(adminRefund.ok, '后台人工退款**不受**开关影响（关的是自助，不是退款）', String(adminRefund.status));
    check(
      adminRefund.ok && adminRefund.body?.order?.status === 'refunded',
      '人工退款后订单状态是已退款',
    );

    await patch('pay.refund.selfservice', { enabled: true });
    const payable2 = await must('POST', '/membership/orders', {
      token: parent.token,
      body: { planCode: plan.code, payChannel: 'fake' },
    });
    const paidOrderNo2 = payable2.order.orderNo;
    const amount2 = payable2.order.amountCents;
    await must('POST', `/payments/orders/${paidOrderNo2}/pay`, { token: parent.token, body: {} });
    await notifyFake({ orderNo: paidOrderNo2, amountCents: amount2, transactionId: 'TX_FLAG_2', sign: sign(paidOrderNo2, amount2) });
    const selfRefundOk = await api('POST', '/payments/refunds', {
      token: parent.token,
      body: { orderNo: paidOrderNo2, reason: '开关开着，自助退款应该能用' },
    });
    check(
      selfRefundOk.ok && selfRefundOk.body?.order?.status === 'refunded',
      '开关开着时自助退款恢复正常',
      `${selfRefundOk.status} ${selfRefundOk.body?.message || ''}`,
    );

    // ----------------------------------------------------------
    step('8. 不认识的开关 key 不会被当成「关闭」静默放过');

    const unknown = await api('GET', '/admin/flags/nope.not.exists/preview', { token: adminToken });
    check(unknown.status === 404, '预览不存在的开关 → 404');
    const unknownPatch = await api('PATCH', '/admin/flags/nope.not.exists', { token: adminToken, body: { enabled: false } });
    check(unknownPatch.status === 404, '改不存在的开关 → 404（不是悄悄建一行）');
    const badKey = await api('PATCH', '/admin/flags/NotAKey', { token: adminToken, body: { enabled: false } });
    check(badKey.status === 422, 'key 形状不合法 → 422');
    const badPercent = await api('PATCH', '/admin/flags/pay.channel.wechat', { token: adminToken, body: { rolloutPercent: 150 } });
    check(badPercent.status === 422, '放量百分比超出 0-100 → 422');

    // ----------------------------------------------------------
    step('9. reset 回到代码默认值');

    await patch('pay.channel.wechat', { enabled: false, rolloutPercent: 30 });
    const afterReset = await must('DELETE', '/admin/flags/pay.channel.wechat/reset', { token: adminToken });
    check(
      afterReset.flag.enabled === true && afterReset.flag.rolloutPercent === 100,
      'reset 之后回到代码默认（开放 / 100%）',
    );

    // ----------------------------------------------------------
    step('10. 改开关要留痕');

    if (prisma) {
      const log = await prisma.operationLog.findFirst({
        where: { path: { contains: '/admin/flags' }, method: 'PATCH' },
        orderBy: { createdAt: 'desc' },
      });
      check(log != null, '改开关的那次 PATCH 进了操作日志（审计不落空）');
      check(log != null && log.status === 200, '审计里记的是真实响应码', log ? String(log.status) : '');
      check(
        !String(log?.detail ?? '').includes('password'),
        '审计详情里不含密码等敏感字段',
      );
    } else {
      for (let i = 0; i < 2; i++) ok('（跳过：拿不到 @prisma/client，操作日志未验证）');
    }

    // ----------------------------------------------------------
    step('11. 清理');

    await resetAll();
    const listAfter = await must('GET', '/admin/flags', { token: adminToken });
    check(
      listAfter.flags.every((f) => f.enabled === true && f.rolloutPercent === 100 && (f.allowIds || []).length === 0),
      '脚本结束时五个开关全部复位（中断也不会留下关闭的渠道）',
    );
    for (const id of userIds) {
      if (id == null) continue;
      const r = await api('DELETE', `/admin/users/${id}`, { token: adminToken });
      if (!r.ok && r.status !== 404) console.log(`  \x1b[33m•\x1b[0m 删除家长 ${id} → ${r.status}`);
    }
    ok('清理完成（测试家长及其订单已级联删除）');
  } finally {
    await resetAll().catch(() => {});
    if (prisma) await prisma.$disconnect().catch(() => {});
    shutdown();
  }

  console.log(`\n\x1b[1m结果：${passed} 项通过 / ${failed} 项失败\x1b[0m`);
  if (failed > 0) process.exit(1);
}

main().catch(async (err) => {
  console.error(`\n\x1b[31m脚本中断：${err.message}\x1b[0m`);
  if (appLogRef.value) console.error(appLogRef.value.split('\n').slice(-20).join('\n'));
  shutdown();
  process.exit(1);
});
