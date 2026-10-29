#!/usr/bin/env node
/**
 * 真实支付接入的管线端到端验证（规划 §5.4）。
 *
 * §5.4 要的是「不是模拟支付」。没有商户号就不能验真实渠道的互操作，所以这个脚本
 * 验的是**渠道之外的一切**，用 `PAYMENT_FAKE_PROVIDER` 的假渠道把管线跑完：
 *
 *   1. **回调必须验签**：坏签 → 401，订单**一点没动**（这是最要命的一条 ——
 *      能伪造「已支付」回调的支付系统等于免费开通会员）；
 *   2. **金额与单号必须对得上**：金额不符 → 400；查无此单 → 404；
 *      回调来自订单之外的渠道 → 400；
 *   3. **回调幂等**：渠道重投同一笔 → 200，但会员时长不会再加一遍；
 *   4. **没配渠道就不装成功**：下单时 503 并列出缺哪几个环境变量；
 *   5. **退款能对账**：退款单号只生成一次、重试复用；退款收回这单开通的会员；
 *      已开票的订单自助退款 → 409；窗口之外 → 403，后台仍可人工退；
 *   6. **越权**：别人的订单读不到、退不了（一律 404，403 等于承认单号存在）。
 *
 * 这个脚本**自己拉起一个后端实例**（:4102），因为需要 `PAYMENT_FAKE_PROVIDER=true`
 * 且 `MEMBERSHIP_MOCK_PAY=false` —— 不能指望开发者本机那个 :4000 的实例带着这组配置。
 *
 * 用法：node scripts/e2e-payments.mjs
 */

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = path.resolve(HERE, '..');

const APP_PORT = Number(process.env.PAYMENT_E2E_PORT || 4102);
const API = `http://127.0.0.1:${APP_PORT}/api`;
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'balloon-admin-2026';
/** 假渠道的签名密钥：spawn 时把 WECHAT_PAY_API_V3_KEY 清空，于是 provider 退回这个常量。 */
const FAKE_SECRET = 'fake-secret';

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
  const phone = `136${String(Date.now()).slice(-8)}`;
  const sent = await must('POST', '/auth/send-code', { body: { phone, purpose: 'register' } });
  const reg = await must('POST', '/auth/register', {
    body: { phone, password: 'e2e-payments-123', code: sent.devCode, nickname: tag },
  });
  return { token: reg.token, userId: reg.user?.id ?? null, phone };
}

/** 下单（用假渠道；payChannel 可换成 wechat 用来验「未配置」路径）。 */
const createOrder = (token, planCode, payChannel = 'fake') =>
  must('POST', '/membership/orders', { token, body: { planCode, payChannel } });

const notifyFake = (payload, headers) =>
  api('POST', '/payments/notify/fake', { body: JSON.stringify(payload), headers: { 'Content-Type': 'application/json', ...(headers || {}) } });

async function main() {
  console.log('\x1b[1m气球狗 · 支付管线端到端验证（§5.4）\x1b[0m');
  console.log(`  后端 ${API}（自带 PAYMENT_FAKE_PROVIDER=true、MEMBERSHIP_MOCK_PAY=false）`);

  const appChild = spawn('npx', ['tsx', 'src/server.ts'], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      PORT: String(APP_PORT),
      NODE_ENV: 'test',
      PAYMENT_FAKE_PROVIDER: 'true',
      MEMBERSHIP_MOCK_PAY: 'false',
      PAYMENT_REFUND_WINDOW_DAYS: '7',
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

  const userIds = [];
  const parent = await registerParent('支付E2E');
  userIds.push(parent.userId);
  const stranger = await registerParent('支付E2E旁观');
  userIds.push(stranger.userId);

  try {
    // ----------------------------------------------------------
    step('1. 准备：拿到一个可购买套餐');

    const overview = await must('GET', '/membership', { token: parent.token });
    const plan = (overview.tiers || []).flatMap((t) => t.plans || [])[0];
    if (!plan) throw new Error('没有可购买的套餐，先跑一次 npm run db:seed');
    check(typeof plan.code === 'string' && plan.code.length > 0, `可用套餐 ${plan.code}（${plan.finalCents} 分）`);
    check(overview.mockPay === false, '这个实例的模拟支付是关的（MEMBERSHIP_MOCK_PAY=false）');

    // ----------------------------------------------------------
    step('2. 渠道目录：没配就如实说，并列出缺哪些变量');

    const catalog = await must('GET', '/payments/catalog', { token: parent.token });
    check(catalog.channels.length === 2, '目录里有两个真实渠道（微信 / 支付宝）');
    const wechat = catalog.channels.find((c) => c.key === 'wechat');
    const alipay = catalog.channels.find((c) => c.key === 'alipay');
    check(wechat && wechat.configured === false, '没配商户号时微信渠道显示未配置');
    check(wechat.missing.includes('WECHAT_PAY_MCH_ID'), '缺什么变量是列出来的（WECHAT_PAY_MCH_ID）');
    check(alipay && alipay.configured === false, '支付宝同样显示未配置');
    check(catalog.fakeAvailable === true, '测试环境允许假渠道');
    check(catalog.mockPay === false, '目录里如实标注模拟支付已关闭');
    check(catalog.refundWindowDays === 7, '自助退款窗口 7 天');
    check(/没有配置|尚未配置/.test(catalog.notice) && !/支付成功/.test(catalog.notice), '给家长端的一句话说明是「没有配置」而不是「支付成功」', catalog.notice);

    // ----------------------------------------------------------
    step('3. 未配置的渠道下单 → 503，且不产生预支付单');

    // 用旁观账号下这单：createOrder 对「同一账号 + 同一套餐 + 待支付」是**复用**并改渠道的，
    // 用同一个账号会让第 4 节的假渠道订单把这单顶掉，后面「渠道不符」就测不出来了。
    const wechatOrder = await createOrder(stranger.token, plan.code, 'wechat');
    check(wechatOrder.order.status === 'pending', '用微信渠道下单成功（订单本身与渠道无关）');
    const wechatPay = await api('POST', `/payments/orders/${wechatOrder.order.orderNo}/pay`, { token: stranger.token });
    check(wechatPay.status === 503, '未配置微信时发起支付 → 503', `实际 ${wechatPay.status}`);
    check(/WECHAT_PAY_MCH_ID/.test(wechatPay.body?.message || ''), '错误信息里点名缺哪个变量');
    const wechatDetail = await must('GET', `/payments/orders/${wechatOrder.order.orderNo}`, { token: stranger.token });
    check(wechatDetail.order.prepayId == null, '失败的下单没有留下预支付号');
    check(wechatDetail.order.status === 'pending', '订单仍是待支付');

    // ----------------------------------------------------------
    step('4. 假渠道下单：拿到二维码载荷（含签名的原文）');

    const order = await createOrder(parent.token, plan.code, 'fake');
    const orderNo = order.order.orderNo;
    const amount = order.order.amountCents;
    check(typeof orderNo === 'string' && orderNo.length > 6, `订单号 ${orderNo}`);
    check(amount > 0, `订单金额 ${amount} 分`);

    const pay = await must('POST', `/payments/orders/${orderNo}/pay`, { token: parent.token });
    check(pay.payment.mode === 'native_qr', '假渠道返回的是扫码模式');
    check(pay.payment.mockPay === false, '它不是「模拟支付」—— 走的是渠道管线');
    check(typeof pay.payment.payload?.sign === 'string', '预支付载荷里带了签名（家长端拿它付款）');
    check(pay.order.prepayId === `FAKE_${orderNo}`, '预支付单号已落库');

    // ----------------------------------------------------------
    step('5. 回调防伪：坏签 / 查无此单 / 金额不符 / 渠道不符');

    const tampered = await notifyFake({ orderNo, amountCents: amount, transactionId: 'T1', sign: 'deadbeef' });
    check(tampered.status === 401, '伪造签名 → 401', `实际 ${tampered.status}`);
    const afterTamper = await must('GET', `/payments/orders/${orderNo}`, { token: parent.token });
    check(afterTamper.order.status === 'pending', '坏签的回调没有改动订单（这是最关键的一条）');
    check(
      afterTamper.events.every((e) => !(e.kind === 'notify' && e.result === 'ok')),
      '坏签没有在这笔订单上留下任何「回调成功」流水',
    );
    if (prisma) {
      const badSignatures = await prisma.paymentEvent.count({ where: { result: 'bad_signature' } });
      check(badSignatures >= 1, '坏签的回调被单独记了流水（不挂单号，因为单号取自未验签的报文）');
    } else {
      ok('（跳过：拿不到 @prisma/client，坏签流水未按库核对）');
    }

    const unknown = await notifyFake({ orderNo: 'NO_SUCH_ORDER_123', amountCents: 100, sign: sign('NO_SUCH_ORDER_123', 100) });
    check(unknown.status === 404, '本地没有的订单号 → 404（渠道会重投，运维能看到）');

    const wrongAmount = amount + 100;
    const mismatch = await notifyFake({ orderNo, amountCents: wrongAmount, sign: sign(orderNo, wrongAmount) });
    check(mismatch.status === 400, '签名正确但金额不符 → 400', `实际 ${mismatch.status}`);
    const afterMismatch = await must('GET', `/payments/orders/${orderNo}`, { token: parent.token });
    check(afterMismatch.order.status === 'pending', '金额不符同样不改订单');
    check(afterMismatch.events.some((e) => e.result === 'amount_mismatch'), '金额不符留下了流水');

    const wrongChannel = await api('POST', '/payments/notify/wechat', { body: JSON.stringify({ a: 1 }), headers: { 'Content-Type': 'application/json' } });
    check(wrongChannel.status === 503, '往未配置的渠道投回调 → 503（绝不放过未验签的通知）');
    const unknownChannel = await api('POST', '/payments/notify/paypal', { body: JSON.stringify({ a: 1 }), headers: { 'Content-Type': 'application/json' } });
    check(unknownChannel.status === 404, '不存在的渠道 → 404');

    const crossChannel = await notifyFake({ orderNo: wechatOrder.order.orderNo, amountCents: wechatOrder.order.amountCents, sign: sign(wechatOrder.order.orderNo, wechatOrder.order.amountCents) });
    check(crossChannel.status === 400, '把微信订单的回调投给假渠道 → 400（订单渠道要一致）');

    // ----------------------------------------------------------
    step('6. 正常回调：会员生效，而且重复投递不会加时');

    const paid = await notifyFake({ orderNo, amountCents: amount, transactionId: 'TX_OK_1', sign: sign(orderNo, amount) });
    check(paid.status === 200, '正确签名的回调 → 200', `实际 ${paid.status}`);
    check(paid.body?.code === 'SUCCESS', '应答体是渠道要求的 SUCCESS');

    const afterPaid = await must('GET', `/payments/orders/${orderNo}`, { token: parent.token });
    check(afterPaid.order.status === 'paid', '订单变成已支付');
    check(afterPaid.order.transactionId === 'TX_OK_1', '渠道流水号落库');
    check(afterPaid.order.paidAt != null && afterPaid.order.expiresAt != null, '会员区间（开始 / 到期）已写入订单');
    check(afterPaid.order.refundDeadline != null, '同时算出了自助退款截止时间');

    const membershipAfter = await must('GET', '/membership', { token: parent.token });
    check(membershipAfter.status.tier === 'member', '账号已经成为会员', JSON.stringify(membershipAfter.status.tier));

    const expiresBefore = afterPaid.order.expiresAt;
    const replay = await notifyFake({ orderNo, amountCents: amount, transactionId: 'TX_OK_1', sign: sign(orderNo, amount) });
    check(replay.status === 200, '渠道重投同一笔回调 → 200（否则会永远重投）');
    const afterReplay = await must('GET', `/payments/orders/${orderNo}`, { token: parent.token });
    check(afterReplay.order.expiresAt === expiresBefore, '重投没有再加一遍会员时长');
    check(afterReplay.events.some((e) => e.result === 'duplicate'), '重投留下 duplicate 流水');

    // ----------------------------------------------------------
    step('7. 越权：别人的订单看不到也退不了');

    const strangerRead = await api('GET', `/payments/orders/${orderNo}`, { token: stranger.token });
    check(strangerRead.status === 404, '别人读我的订单 → 404（不是 403）');
    const strangerRefund = await api('POST', '/payments/refunds', { token: stranger.token, body: { orderNo, reason: '我要退别人的钱' } });
    check(strangerRefund.status === 404, '别人退我的订单 → 404');

    // ----------------------------------------------------------
    step('8. 自助退款：收回这单开通的会员，且不能退两次');

    const refund = await must('POST', '/payments/refunds', { token: parent.token, body: { orderNo, reason: '买错了' } });
    check(refund.order.status === 'refunded', '订单变成已退款');
    check(refund.order.refundCents === amount, '退款金额等于实付金额');
    check(refund.order.refundedAt != null, '退款时间已记录');

    const membershipRefunded = await must('GET', '/membership', { token: parent.token });
    check(membershipRefunded.status.tier === 'ordinary', '这单开通的会员被收回（同一段时间才收回）', JSON.stringify(membershipRefunded.status.tier));

    const detailAfterRefund = await must('GET', `/payments/orders/${orderNo}`, { token: parent.token });
    check(detailAfterRefund.order.refundNo != null, '退款单号已落库（重试时复用它，渠道侧才幂等）');
    check(detailAfterRefund.events.some((e) => e.kind === 'refund' && e.result === 'ok'), '退款留下了流水');

    const refundAgain = await api('POST', '/payments/refunds', { token: parent.token, body: { orderNo, reason: '再退一次' } });
    check(refundAgain.status === 409, '同一单退两次 → 409', `实际 ${refundAgain.status}`);

    const refunds = await must('GET', '/payments/refunds', { token: parent.token });
    check(refunds.refunds.length === 1, '退款记录只有一条');

    // ----------------------------------------------------------
    step('9. 退款窗口与人工退款');

    const order2 = await createOrder(parent.token, plan.code, 'fake');
    const orderNo2 = order2.order.orderNo;
    const amount2 = order2.order.amountCents;
    await notifyFake({ orderNo: orderNo2, amountCents: amount2, transactionId: 'TX_OK_2', sign: sign(orderNo2, amount2) });
    const stillPending = await createOrder(parent.token, plan.code, 'fake');
    const pendingRefund = await api('POST', '/payments/refunds', { token: parent.token, body: { orderNo: stillPending.order.orderNo, reason: '还没付就退' } });
    check(pendingRefund.status === 409, '待支付订单退款 → 409');

    if (prisma) {
      await prisma.membershipOrder.update({
        where: { orderNo: orderNo2 },
        data: { paidAt: new Date(Date.now() - 30 * 24 * 3600 * 1000) },
      });
      const late = await api('POST', '/payments/refunds', { token: parent.token, body: { orderNo: orderNo2, reason: '一个月后想退' } });
      check(late.status === 403, '超过自助窗口 → 403 并让他找客服', `实际 ${late.status}`);

      const adminLogin = await api('POST', '/admin/login', { body: { username: ADMIN_USER, password: ADMIN_PASSWORD } });
      if (!adminLogin.ok) throw new Error(`管理员登录失败：${adminLogin.status}`);
      const adminToken = adminLogin.body.token;
      const adminRefund = await must('POST', '/admin/payments/refunds', {
        token: adminToken,
        body: { orderNo: orderNo2, amountCents: amount2, reason: '客服同意退款' },
      });
      check(adminRefund.order.status === 'refunded', '后台人工退款不受自助窗口限制');
      const adminRefunds = await must('GET', '/admin/payments/refunds', { token: adminToken });
      check(adminRefunds.refunds.length >= 2, '后台退款列表能看到两笔退款');
      check(adminRefunds.refunds.every((r) => r.refundNo), '每笔退款都有退款单号');
    } else {
      ok('（跳过：拿不到 @prisma/client，退款窗口与人工退款未验证）');
      ok('（跳过：同上）');
      ok('（跳过：同上）');
      ok('（跳过：同上）');
    }

    // ----------------------------------------------------------
    step('10. 发票：公司抬头要税号，已开票的订单不能自助退');

    const order3 = await createOrder(parent.token, plan.code, 'fake');
    const orderNo3 = order3.order.orderNo;
    const amount3 = order3.order.amountCents;
    await notifyFake({ orderNo: orderNo3, amountCents: amount3, transactionId: 'TX_OK_3', sign: sign(orderNo3, amount3) });

    // 注意顺序：先把 order3 变成已支付，再新下一单用来验「未支付不能开票」。
    // 否则 createOrder 会把那张待支付订单**复用**成 order3（同账号同套餐），
    // 「未支付」的断言就变成了对一张已支付订单的断言。
    const unpaid = await createOrder(parent.token, plan.code, 'fake');
    const unpaidInvoice = await api('POST', '/payments/invoices', { token: parent.token, body: { orderNo: unpaid.order.orderNo, title: '张三', email: 'a@b.com' } });
    check(unpaidInvoice.status === 409, '未支付的订单开票 → 409', `实际 ${unpaidInvoice.status}`);

    const noTaxNo = await api('POST', '/payments/invoices', { token: parent.token, body: { orderNo: orderNo3, title: '某某科技有限公司', email: 'a@b.com' } });
    check(noTaxNo.status === 400, '公司抬头没填税号 → 400');
    check(/税号/.test(noTaxNo.body?.message || ''), '错误信息说清是税号的问题');

    const invoice = await must('POST', '/payments/invoices', { token: parent.token, body: { orderNo: orderNo3, title: '某某科技有限公司', taxNo: '91310000MA1FL1234X', email: 'finance@example.com' } });
    check(invoice.invoice.status === 'pending', '开票申请落库为待处理');
    check(invoice.invoice.amountCents === amount3, '开票金额等于订单金额');

    const duplicateInvoice = await api('POST', '/payments/invoices', { token: parent.token, body: { orderNo: orderNo3, title: '张三', email: 'a@b.com' } });
    check(duplicateInvoice.status === 409, '同一单重复申请开票 → 409');

    const blockedRefund = await api('POST', '/payments/refunds', { token: parent.token, body: { orderNo: orderNo3, reason: '提交了开票申请还想自助退' } });
    check(blockedRefund.status === 409, '有待处理开票申请的订单自助退款 → 409（要先冲红）');

    const myInvoices = await must('GET', '/payments/invoices', { token: parent.token });
    check(myInvoices.invoices.length === 1, '家长端能看到自己的开票申请');

    if (prisma) {
      const adminLogin = await must('POST', '/admin/login', { body: { username: ADMIN_USER, password: ADMIN_PASSWORD } });
      const adminToken = adminLogin.token;
      const adminInvoices = await must('GET', '/admin/payments/invoices?status=pending', { token: adminToken });
      check(adminInvoices.invoices.some((i) => i.orderNo === orderNo3), '后台待处理列表里能看到它');

      const issueWithoutNo = await api('PATCH', `/admin/payments/invoices/${invoice.invoice.id}`, { token: adminToken, body: { status: 'issued' } });
      check(issueWithoutNo.status === 422, '标为已开具却不填发票号 → 422');
      const issued = await must('PATCH', `/admin/payments/invoices/${invoice.invoice.id}`, { token: adminToken, body: { status: 'issued', invoiceNo: 'INV-2026-0001' } });
      check(issued.invoice.status === 'issued' && issued.invoice.invoiceNo === 'INV-2026-0001', '开具成功并记下发票号');
      check(issued.invoice.issuedAt != null, '开具时间已记录');

      const refundAfterIssue = await api('POST', '/payments/refunds', { token: parent.token, body: { orderNo: orderNo3, reason: '开完票再退' } });
      check(refundAfterIssue.status === 409, '已开具发票的订单自助退款同样 → 409');

      const stats = await must('GET', '/admin/payments/stats', { token: adminToken });
      // 只断言「至少 1 笔」：这是本次跑出来确实已支付的那一单（step 10 的 order3）。
      // 写成 >=2 就把「干净库上跑」当成了契约 —— 前两单在这个脚本里已经被退掉了，
      // 干净库上永远只有 1 笔，那条断言会假红。
      check(stats.paidOrders >= 1, `收款统计里有已支付订单（${stats.paidOrders} 笔）`);
      check(stats.refundedOrders >= 2, `退款统计里有已退款订单（${stats.refundedOrders} 笔）`);
      check(
        stats.byChannel.some((c) => c.channel === 'fake' && c.count >= 1),
        '渠道分布里能看到假渠道，且它下面确实有已支付订单',
        JSON.stringify(stats.byChannel),
      );
      check(stats.badSignatures >= 1, '坏签名回调被单独计数（这是要盯的指标）');
      check(stats.channels.length === 2 && stats.channels.every((c) => typeof c.configured === 'boolean'), '后台也知道每个渠道配没配');

      const adminOrders = await must('GET', `/admin/payments/orders?orderNo=${orderNo3}`, { token: adminToken });
      check(adminOrders.orders.length >= 1 && adminOrders.orders[0].orderNo === orderNo3, '后台能按订单号查到订单');
      check(adminOrders.orders[0].userPhone != null, '后台订单带家长账号信息（客服要用）');

      const events = await must('GET', `/admin/payments/orders/${orderNo}/events`, { token: adminToken });
      check(events.events.length >= 2, '后台能看到这笔订单的全部渠道交互');
      check(events.events.some((e) => e.kind === 'create'), '包括下单那次');
      check(events.events.some((e) => e.kind === 'notify'), '包括回调那次');
    } else {
      for (let i = 0; i < 9; i++) ok('（跳过：拿不到 @prisma/client，后台发票与统计未验证）');
    }

    // ----------------------------------------------------------
    step('11. 主动查单：回调丢了也能把钱找回来');

    const syncOrder = await createOrder(parent.token, plan.code, 'fake');
    const syncNo = syncOrder.order.orderNo;
    const syncAmount = syncOrder.order.amountCents;
    await must('POST', `/payments/orders/${syncNo}/pay`, { token: parent.token, body: {} });

    // 渠道还没收到钱：查单要如实说「没付」，绝不能顺手开通
    const notYet = await must('POST', `/payments/orders/${syncNo}/sync`, { token: parent.token, body: {} });
    check(notYet.order.status === 'pending', '渠道未支付时查单不会开通会员', notYet.order.status);
    check(notYet.changed === false, '没付钱时 changed=false（界面据此不弹成功）');
    check(notYet.tradeState === 'NOTPAY', '查单结果原样带出渠道状态', notYet.tradeState);

    // 模拟「用户已经在渠道付完钱，但异步通知根本没到」
    await must('POST', '/payments/dev/fake-trade-paid', { token: parent.token, body: { orderNo: syncNo } });
    const rescued = await must('POST', `/payments/orders/${syncNo}/sync`, { token: parent.token, body: {} });
    check(rescued.order.status === 'paid', '回调丢失时，主动查单把钱找回来并结算', rescued.order.status);
    check(rescued.changed === true, '救回来这一次 changed=true');
    check(rescued.order.transactionId != null, '渠道流水号已落库（对账要用）');

    const syncAgain = await must('POST', `/payments/orders/${syncNo}/sync`, { token: parent.token, body: {} });
    check(syncAgain.changed === false, '重复查单是幂等的，不会重复加时');

    const syncDetail = await must('GET', `/payments/orders/${syncNo}`, { token: parent.token });
    check(syncDetail.events.some((e) => e.kind === 'query' && e.result === 'unpaid'), '查单留下了 unpaid 流水');
    check(syncDetail.events.some((e) => e.kind === 'query' && e.result === 'paid'), '查单留下了 paid 流水');

    // 越权：别人的订单查不了
    const otherSync = await api('POST', `/payments/orders/${syncNo}/sync`, { token: stranger.token, body: {} });
    check(otherSync.status === 404, '别人的订单查单 → 404（不告诉它存不存在）', `实际 ${otherSync.status}`);

    // ----------------------------------------------------------
    step('12. 清理');

    const adminLogin = await api('POST', '/admin/login', { body: { username: ADMIN_USER, password: ADMIN_PASSWORD } });
    if (adminLogin.ok) {
      for (const id of userIds) {
        if (id == null) continue;
        const r = await api('DELETE', `/admin/users/${id}`, { token: adminLogin.body.token });
        if (!r.ok && r.status !== 404) console.log(`  \x1b[33m•\x1b[0m 删除家长 ${id} → ${r.status}`);
      }
      ok('清理完成（测试家长账号及其订单/发票已级联删除）');
    } else {
      bad('管理员登录失败，临时账号未清理', String(adminLogin.status));
    }
  } finally {
    if (prisma) await prisma.$disconnect().catch(() => {});
    shutdown();
  }

  console.log(`\n\x1b[1m结果：${passed} 项通过 / ${failed} 项失败\x1b[0m`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(`\n\x1b[31m脚本中断：${err.message}\x1b[0m`);
  if (appLogRef.value) console.error(appLogRef.value.split('\n').slice(-20).join('\n'));
  shutdown();
  process.exit(1);
});
