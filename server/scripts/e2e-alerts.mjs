#!/usr/bin/env node
/**
 * 后台告警大盘端到端验证（规划 §5.5）。
 *
 * 这个脚本最重要的一条是**自己独立重算一遍数字**：先把大盘读一遍当前基线，
 * 再往库里造一批**可控**的数据（在线/失联/从未连接三种设备、好坏两种体检快照、
 * 成功/失败/超时三种指令、坏签名的支付事件、重试三次仍失败的通知投递），
 * 然后断言每个指标的增量与口径完全对得上。
 *
 * 刻意验的几条「最容易写错」的规则（都写在 `alerts.constants.ts` 的口径注释里）：
 *   1. **分母写清楚**：失联率只算已绑定设备，`never`（从未连接）不算失联，
 *      但它进分母 —— 未认领的注册记录会把失联率稀释成永远正常；
 *   2. **分母为 0 时是 `null` 而不是 `0`**：界面显示「—」而不是「0%」，
 *      「查过了都正常」与「没有可统计对象」不是一件事；
 *   3. **率类指标独立重算**：`value === round(numerator/denominator*1000)/10`，
 *      计数类指标 `value === numerator === denominator`；
 *   4. **确认告警不改指标、也不打扰家长**：快照由服务端在确认那一刻算（前端传的不作数），
 *      确认一条告警不会给任何家长写通知 —— 这个能力不出站。
 *
 * 这个脚本**自己拉起一个后端实例**（:4104），造的数据全部挂在一次性家长账号上，
 * 结束（含中途抛错）时删账号、删造出来的支付事件、把改过的规则复位。
 *
 * 用法：node scripts/e2e-alerts.mjs
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = path.resolve(HERE, '..');

const APP_PORT = Number(process.env.ALERTS_E2E_PORT || 4104);
const API = `http://127.0.0.1:${APP_PORT}/api`;
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'balloon-admin-2026';
const EVENT_PREFIX = `E2EALERT-${Date.now()}`;

const DEFAULTS = {
  device_offline: { threshold: 30, severity: 'danger', windowMinutes: 0, unit: '%' },
  control_gap: { threshold: 30, severity: 'warn', windowMinutes: 0, unit: '%' },
  command_failure: { threshold: 20, severity: 'warn', windowMinutes: 60, unit: '%' },
  payment_anomaly: { threshold: 1, severity: 'danger', windowMinutes: 60, unit: '条' },
  notify_failure: { threshold: 5, severity: 'warn', windowMinutes: 60, unit: '条' },
};

let passed = 0;
let failed = 0;
const ok = (m) => { passed++; console.log(`  \x1b[32m✓\x1b[0m ${m}`) };
const bad = (m, extra = '') => { failed++; console.log(`  \x1b[31m✗\x1b[0m ${m}${extra ? ` — ${extra}` : ''}`) };
const check = (c, m, extra = '') => (c ? ok(m) : bad(m, extra));
const step = (t) => console.log(`\n\x1b[1m${t}\x1b[0m`);

const round1 = (n) => Math.round(n * 10) / 10;

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

const metricOf = (overview, key) => overview.metrics.find((m) => m.key === key);
const alertOf = (overview, key) => overview.alerts.find((a) => a.key === key);

async function main() {
  console.log('\x1b[1m气球狗 · 告警大盘端到端验证（§5.5）\x1b[0m');
  console.log(`  后端 ${API}`);

  const appChild = spawn('npx', ['tsx', 'src/server.ts'], {
    cwd: SERVER_DIR,
    env: { ...process.env, PORT: String(APP_PORT), NODE_ENV: 'test', RATE_LIMIT_MAX: '100000' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(appChild);
  appChild.stdout.on('data', (d) => { appLogRef.value += String(d) });
  appChild.stderr.on('data', (d) => { appLogRef.value += String(d) });

  try {
    await waitFor(`http://127.0.0.1:${APP_PORT}/health`, '后端');
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
  if (!prisma) {
    console.error('\x1b[31m这个脚本需要 @prisma/client 直连数据库来造可控数据与独立重算。\x1b[0m');
    console.error('先在 server/ 目录跑一次 npx prisma generate（并保证数据库已迁移）再运行。');
    shutdown();
    process.exit(1);
  }

  const admin = await must('POST', '/admin/login', {
    body: { username: ADMIN_USER, password: ADMIN_PASSWORD },
  });
  const adminToken = admin.token;

  // 一次性家长：设备 / 体检 / 指令 / 通知都挂在它下面，最后删账号级联清干净。
  const phone = `134${String(Date.now()).slice(-8)}`;
  const sent = await must('POST', '/auth/send-code', { body: { phone, purpose: 'register' } });
  const reg = await must('POST', '/auth/register', {
    body: { phone, password: 'e2e-alerts-123', code: sent.devCode, nickname: '告警E2E' },
  });
  const parent = { token: reg.token, userId: reg.user?.id };

  const ackIds = [];
  const resetRules = async () => {
    for (const key of Object.keys(DEFAULTS)) {
      const r = await api('DELETE', `/admin/alerts/rules/${key}/reset`, { token: adminToken });
      if (!r.ok) console.log(`  \x1b[33m•\x1b[0m 复位规则 ${key} → ${r.status}`);
    }
  };

  try {
    // ----------------------------------------------------------
    step('1. 规则自述：五条口径、默认阈值、单位与窗口');

    const rules = (await must('GET', '/admin/alerts/rules', { token: adminToken })).rules;
    check(rules.length === 5, `五条规则都在（${rules.length}）`);
    for (const [key, def] of Object.entries(DEFAULTS)) {
      const rule = rules.find((r) => r.key === key);
      check(
        rule && rule.threshold === def.threshold && rule.severity === def.severity && rule.windowMinutes === def.windowMinutes && rule.unit === def.unit,
        `${rule?.label ?? key} 的默认值与代码定义一致（阈值 ${def.threshold}${def.unit} / ${def.severity} / 窗口 ${def.windowMinutes} 分钟）`,
      );
      check(
        typeof rule?.denominatorText === 'string' && rule.denominatorText.length > 10,
        `${rule?.label ?? key} 写清了分母是什么：${rule?.denominatorText?.slice(0, 40)}…`,
      );
    }

    const baseline = await must('GET', '/admin/alerts/overview', { token: adminToken });
    check(typeof baseline.generatedAt === 'string', '大盘每次都给出生成时间（读时计算，没有后台扫描任务）');
    check(baseline.metrics.length === 5 && baseline.alerts.length === 5, '五个指标 + 五条告警视图');

    // ----------------------------------------------------------
    step('2. 造可控数据：在线 / 失联 / 从未连接 三种设备');

    const baseOffline = metricOf(baseline, 'device_offline');

    // 这里直接落库，而不是走 /devices/bind：免费账号绑第二台设备会被会员门禁拦下
    // （「绑定多台手机」是会员权益），而大盘读的就是 ChildDevice 行本身。
    // lastActiveAt 也只能直连数据库回拨 —— 没有任何 HTTP 接口能造出「失联 48 小时」。
    const mkDevice = (name, code, lastActiveAt, status) =>
      prisma.childDevice.create({
        data: {
          userId: parent.userId,
          name,
          model: 'E2E Alert Phone',
          os: 'Android',
          osVersion: '14',
          deviceCode: code,
          deviceSecretHash: 'e2e-not-a-real-hash',
          boundAt: new Date(),
          lastActiveAt,
          status,
        },
      });
    const codeOf = (tag) => `EA${tag}${String(Date.now()).slice(-5)}`.toUpperCase();

    const devOnline = await mkDevice('E2E告警-在线', codeOf('ON'), new Date(Date.now() - 60_000), 'online');
    const devLost = await mkDevice('E2E告警-已失联', codeOf('LS'), new Date(Date.now() - 48 * 3600_000), 'online');
    const devNever = await mkDevice('E2E告警-从未连接', codeOf('NV'), null, 'offline');
    ok(`三台可控设备已落库（在线 / 失联 48h / 从未连接）`);

    const afterDevices = await must('GET', '/admin/alerts/overview', { token: adminToken });
    const offline = metricOf(afterDevices, 'device_offline');
    check(
      offline.numerator === baseOffline.numerator + 1,
      `只有「已失联」那台进分子（${baseOffline.numerator} → ${offline.numerator}）`,
    );
    check(
      offline.denominator === baseOffline.denominator + 3,
      `三台都进分母（已绑定设备 ${baseOffline.denominator} → ${offline.denominator}）`,
    );
    check(
      offline.value === round1((offline.numerator / offline.denominator) * 100),
      `失联率 = 分子 ÷ 分母（${offline.numerator}/${offline.denominator} → ${offline.value}%）`,
    );
    check(
      devNever.lastActiveAt === null && offline.numerator === baseOffline.numerator + 1,
      '「从未连接」不算失联 —— 它单独一列，不能和「失联」混为一谈',
    );

    // ----------------------------------------------------------
    step('3. 造可控数据：好坏两种体检快照 + 三档指令结果');

    const baseGap = metricOf(afterDevices, 'control_gap');
    const baseCmd = metricOf(afterDevices, 'command_failure');

    await prisma.deviceHealth.create({
      data: { deviceId: devLost.id, level: 'warn', openGaps: 2, serviceRunning: true, gaps: [{ label: '无障碍服务未开启' }] },
    });
    await prisma.deviceHealth.create({
      data: { deviceId: devOnline.id, level: 'ok', openGaps: 0, serviceRunning: true, gaps: [] },
    });

    const finishedAt = new Date();
    const mkCommand = (status, error = '') =>
      prisma.deviceCommand.create({
        data: { deviceId: devOnline.id, type: 'lock', status, error, finishedAt, expiresAt: new Date(Date.now() + 300_000) },
      });
    await mkCommand('failed', '设备端回报：权限被拒绝');
    await mkCommand('expired');
    await mkCommand('success');
    await mkCommand('success');

    const afterHealth = await must('GET', '/admin/alerts/overview', { token: adminToken });
    const gap = metricOf(afterHealth, 'control_gap');
    check(gap.denominator === baseGap.denominator + 2, `只有报过体检的设备进分母（${baseGap.denominator} → ${gap.denominator}）`);
    check(gap.numerator === baseGap.numerator + 1, `有缺口的那台进分子（${baseGap.numerator} → ${gap.numerator}）`);
    check(gap.windowMinutes === 0, '体检是即时快照，没有窗口');

    const cmd = metricOf(afterHealth, 'command_failure');
    check(cmd.denominator === baseCmd.denominator + 4, `四条指令都进分母（${baseCmd.denominator} → ${cmd.denominator}）`);
    check(cmd.numerator === baseCmd.numerator + 2, `失败 + 超时各算一条（${baseCmd.numerator} → ${cmd.numerator}）`);
    check(cmd.windowMinutes === 60, '指令失败率默认看 60 分钟窗口');
    check(cmd.value === round1((cmd.numerator / cmd.denominator) * 100), `指令失败率独立重算一致（${cmd.value}%）`);

    // ----------------------------------------------------------
    step('4. 造可控数据：支付异常与通知投递失败（计数类）');

    const basePay = metricOf(afterHealth, 'payment_anomaly');
    const baseNotify = metricOf(afterHealth, 'notify_failure');

    await prisma.paymentEvent.createMany({
      data: [
        { orderNo: `${EVENT_PREFIX}-1`, provider: 'wechat', kind: 'notify', signatureOk: false, result: 'bad_signature', detail: '回调签名不匹配' },
        { orderNo: `${EVENT_PREFIX}-2`, provider: 'alipay', kind: 'notify', signatureOk: true, result: 'amount_mismatch', detail: '金额不符' },
        { orderNo: `${EVENT_PREFIX}-3`, provider: 'fake', kind: 'notify', signatureOk: true, result: 'ok', detail: '正常回调' },
      ],
    });

    const notification = await prisma.notification.create({
      data: {
        userId: parent.userId,
        type: 'device_lost',
        level: 'danger',
        title: '{{v0}} 已失联',
        titleParams: ['E2E告警-已失联'],
        body: '',
        dedupeKey: `e2e-alert-${EVENT_PREFIX}`,
      },
    });
    await prisma.notificationDelivery.createMany({
      data: [
        { notificationId: notification.id, channel: 'wechat', status: 'failed', attempts: 3, lastError: '微信返回 40001' },
        { notificationId: notification.id, channel: 'email', status: 'pending', attempts: 2, lastError: '还没有到重试上限' },
        { notificationId: notification.id, channel: 'sms', status: 'pending', attempts: 3, lastError: '' },
      ],
    });

    const afterCounts = await must('GET', '/admin/alerts/overview', { token: adminToken });
    const pay = metricOf(afterCounts, 'payment_anomaly');
    const notify = metricOf(afterCounts, 'notify_failure');
    check(pay.value === basePay.value + 2, `支付异常按条数涨（${basePay.value} → ${pay.value}），正常的 ok 事件不算`);
    check(
      pay.value === pay.numerator && pay.numerator === pay.denominator,
      '计数类指标的分子分母都是同一个数（它没有「率」的分母）',
    );
    check(notify.value === baseNotify.value + 1, `只有「试 3 次且 lastError 非空」的那条算失败（${baseNotify.value} → ${notify.value}）`);
    check(pay.numerator >= 2 && pay.samples.length <= 5, `样本最多 5 条，但事故规模按真实条数统计（numerator=${pay.numerator}）`);

    // ----------------------------------------------------------
    step('5. 口径不变量：分母为 0 用 null、计数类三值一致、触发条件独立重算');

    const view = await must('GET', '/admin/alerts/overview', { token: adminToken });
    let invariantOk = true;
    for (const m of view.metrics) {
      if (m.unit === '%') {
        if (m.denominator === 0 ? m.value !== null : m.value !== round1((m.numerator / m.denominator) * 100)) invariantOk = false;
      } else if (m.value !== m.numerator || m.numerator !== m.denominator) {
        invariantOk = false;
      }
    }
    check(invariantOk, '五个指标的「分母为 0 → null」「率 = 分子÷分母」「计数类三值一致」全部成立');

    check(
      view.alerts.every((a) => a.triggered === (a.enabled && a.value != null && a.value >= a.threshold)),
      '每一条 triggered 都等于（启用 && 有值 && 达到阈值）—— 界面不会自己编触发状态',
    );
    check(
      view.alerts.every((a) => (a.triggered ? a.samples.length > 0 : a.samples.length === 0)),
      '没触发的告警不展示样本（避免「全都列出来」淹没真正的异常）',
    );
    const firstUntriggered = view.alerts.findIndex((a) => !a.triggered);
    check(
      firstUntriggered === -1 || view.alerts.slice(0, firstUntriggered).every((a) => a.triggered),
      '触发的排在最前，没触发的沉底',
    );

    // ----------------------------------------------------------
    step('6. 改阈值 / 关规则：触发状态跟着变，指标不变');

    const payNow = metricOf(view, 'payment_anomaly');
    const above = await api('PATCH', '/admin/alerts/rules/payment_anomaly', {
      token: adminToken,
      body: { threshold: payNow.numerator + 5 },
    });
    check(above.ok && above.body.rule.threshold === payNow.numerator + 5, '把阈值调到当前条数之上');
    const afterAbove = await must('GET', '/admin/alerts/overview', { token: adminToken });
    check(alertOf(afterAbove, 'payment_anomaly').triggered === false, '调高阈值后不再触发（指标本身没变）');
    check(metricOf(afterAbove, 'payment_anomaly').value === payNow.value, '改阈值不会改变指标数值');

    await must('PATCH', '/admin/alerts/rules/payment_anomaly', { token: adminToken, body: { threshold: 1 } });
    const afterBelow = await must('GET', '/admin/alerts/overview', { token: adminToken });
    check(alertOf(afterBelow, 'payment_anomaly').triggered === true, '阈值调回 1 又触发');

    await must('PATCH', '/admin/alerts/rules/payment_anomaly', { token: adminToken, body: { enabled: false } });
    const afterDisabled = await must('GET', '/admin/alerts/overview', { token: adminToken });
    check(
      alertOf(afterDisabled, 'payment_anomaly').triggered === false && metricOf(afterDisabled, 'payment_anomaly').value === payNow.value,
      '关掉规则后不触发，但指标照样算（关的是告警，不是监控）',
    );
    await must('PATCH', '/admin/alerts/rules/payment_anomaly', { token: adminToken, body: { enabled: true } });

    // ----------------------------------------------------------
    step('7. 规则参数校验：快照指标没有窗口、未知规则不静默');

    const badThreshold = await api('PATCH', '/admin/alerts/rules/payment_anomaly', { token: adminToken, body: { threshold: 100_001 } });
    check(badThreshold.status === 422, '阈值超出范围 → 422');
    const badWindow = await api('PATCH', '/admin/alerts/rules/payment_anomaly', { token: adminToken, body: { windowMinutes: 2000 } });
    check(badWindow.status === 422, '窗口超出 1440 分钟 → 422');
    const pointWindow = await api('PATCH', '/admin/alerts/rules/control_gap', { token: adminToken, body: { windowMinutes: 30 } });
    check(pointWindow.status === 400, '给「即时快照」型指标配统计窗口 → 400，而不是被默默接受');
    const badSeverity = await api('PATCH', '/admin/alerts/rules/control_gap', { token: adminToken, body: { severity: 'critical' } });
    check(badSeverity.status === 422, '未知严重度 → 422');
    const unknownRule = await api('PATCH', '/admin/alerts/rules/nope_nope', { token: adminToken, body: { threshold: 1 } });
    check(unknownRule.status === 404, '未知规则 key → 404');
    const resetRule = await api('DELETE', '/admin/alerts/rules/payment_anomaly/reset', { token: adminToken });
    check(resetRule.ok && resetRule.body.rule.threshold === 1 && resetRule.body.rule.enabled === true, 'reset 把规则恢复成代码默认值');

    // ----------------------------------------------------------
    step('8. 确认告警：快照由服务端算，确认不等于放行');

    const fakeSnapshot = await api('POST', '/admin/alerts/acks', {
      token: adminToken,
      body: { key: 'payment_anomaly', note: '我来看看', snapshot: { value: 0 } },
    });
    check(fakeSnapshot.status === 422, '前端传 snapshot 会被拒（确认记录必须记「当时实际是多少」）', String(fakeSnapshot.status));

    const beforeNotifyCount = await prisma.notification.count();
    const acked = await api('POST', '/admin/alerts/acks', {
      token: adminToken,
      body: { key: 'payment_anomaly', note: '已知悉：疑似有人试签名，正在看回调日志' },
    });
    check(acked.status === 201, '确认一条告警 → 201', String(acked.status));
    const ackId = acked.body?.ack?.id;
    if (ackId) ackIds.push(ackId);
    const snapshot = acked.body?.ack?.snapshot ?? {};
    const payAfterReset = metricOf(await must('GET', '/admin/alerts/overview', { token: adminToken }), 'payment_anomaly');
    check(snapshot.numerator === payAfterReset.numerator && snapshot.value === payAfterReset.value, '快照里的数字与服务端此刻算的一致');
    check(snapshot.threshold === 1 && typeof snapshot.at === 'string', '快照记下了当时的阈值与时间');
    check(acked.body?.ack?.adminName === ADMIN_USER, '确认记录带确认人');

    const afterAck = await must('GET', '/admin/alerts/overview', { token: adminToken });
    const ackedAlert = alertOf(afterAck, 'payment_anomaly');
    check(ackedAlert.ack?.id === ackId && /正在看回调日志/.test(ackedAlert.ack?.note ?? ''), '大盘上能看到这条确认与备注');
    check(ackedAlert.triggered === true, '确认过不等于放行：只要还达到阈值，它仍然是触发状态');
    const afterNotifyCount = await prisma.notification.count();
    check(afterNotifyCount === beforeNotifyCount, '确认告警不会给任何家长写通知（这个能力不出站、不打扰家长）');

    const ackList = await must('GET', '/admin/alerts/acks', { token: adminToken });
    check(ackList.acks.some((a) => a.id === ackId) && ackList.acks.find((a) => a.id === ackId)?.label === '支付异常', '确认记录列表里能查到它');

    const ackAgain = await api('POST', '/admin/alerts/acks', {
      token: adminToken,
      body: { key: 'payment_anomaly', note: '改个备注：已经定位到是第三方压测' },
    });
    check(ackAgain.status === 201 && ackAgain.body?.ack?.id === ackId, '同一条告警可以重复确认（更新备注与快照，不是堆一堆记录）');

    const deleted = await api('DELETE', `/admin/alerts/acks/${ackId}`, { token: adminToken });
    check(deleted.ok, '可以撤销确认');
    const afterDelete = await must('GET', '/admin/alerts/overview', { token: adminToken });
    check(alertOf(afterDelete, 'payment_anomaly').ack === null, '撤销后大盘上的确认标记消失');
    const deleteUnknown = await api('DELETE', '/admin/alerts/acks/no-such-ack', { token: adminToken });
    check(deleteUnknown.status === 404, '删除不存在的确认 → 404');

    // ----------------------------------------------------------
    step('9. 权限：家长进不来，且这个能力不出站');

    const parentRead = await api('GET', '/admin/alerts/overview', { token: parent.token });
    check(parentRead.status === 401 || parentRead.status === 403, '家长 token 读大盘 → 401/403', String(parentRead.status));
    const parentAck = await api('POST', '/admin/alerts/acks', { token: parent.token, body: { key: 'payment_anomaly' } });
    check(parentAck.status === 401 || parentAck.status === 403, '家长 token 确认告警 → 401/403');
    const overviewJson = JSON.stringify(view);
    check(
      !/sendSms|sendWechat|phoneNumber|mobile\b/.test(overviewJson),
      '大盘响应里没有「往外发」的字段 —— 文档也如实写着告警不出站',
    );
    check(
      view.alerts.every((a) => typeof a.note === 'string' && a.note.length > 0),
      '每条告警都带一句给人看的说明（数字要能解释，不然大盘只会制造焦虑）',
    );

    // ----------------------------------------------------------
    step('10. 清理：删账号 + 删造出来的支付事件 + 复位规则');

    await prisma.notification.deleteMany({ where: { userId: parent.userId } });
    await prisma.paymentEvent.deleteMany({ where: { orderNo: { startsWith: EVENT_PREFIX } } });
    const deletedUser = await api('DELETE', `/admin/users/${parent.userId}`, { token: adminToken });
    check(deletedUser.ok || deletedUser.status === 404, '一次性家长账号已删除');
    await resetRules();
    const rulesAfter = (await must('GET', '/admin/alerts/rules', { token: adminToken })).rules;
    check(
      rulesAfter.every((r) => r.threshold === DEFAULTS[r.key].threshold && r.enabled === true && r.windowMinutes === DEFAULTS[r.key].windowMinutes),
      '脚本结束时五条规则全部复位（中断也不会留下被改过的阈值）',
    );
    const eventsLeft = await prisma.paymentEvent.count({ where: { orderNo: { startsWith: EVENT_PREFIX } } });
    check(eventsLeft === 0, '造出来的支付事件已删除');
  } finally {
    for (const id of ackIds) {
      await api('DELETE', `/admin/alerts/acks/${id}`, { token: adminToken }).catch(() => {});
    }
    await resetRules().catch(() => {});
    if (prisma) {
      await prisma.paymentEvent.deleteMany({ where: { orderNo: { startsWith: EVENT_PREFIX } } }).catch(() => {});
      await prisma.$disconnect().catch(() => {});
    }
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
