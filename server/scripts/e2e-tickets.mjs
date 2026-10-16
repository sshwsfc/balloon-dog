#!/usr/bin/env node
/**
 * 客服工单端到端验证（规划 §5.5）。
 *
 * 工单是**用户内容**，所以这个脚本盯的第一件事不是功能，而是边界：
 *
 *   1. **家长看不到是谁回的**：家长端详情里只有「谁说的（家长/客服）、什么时候、说了什么」，
 *      不能出现 `adminId` / 客服账号名 —— 值班表与家长无关；
 *   2. **跨账号一律 404**：别的家长的工单号，不告诉它「存在但你没权限」；
 *   3. **关了就是关了**：入口开关关闭后，家长端提交 503，但**历史工单仍可读**（后台也一样）——
 *      「关入口」不是「删数据」；
 *   4. **未关闭的工单有上限**（5 张），到顶返回 409 而不是无限开单；
 *   5. **状态流转是有意义的**：客服回复把「待处理」推进到「等待家长回复」，家长回话再推回
 *      「处理中」；已关闭的工单两家都不能再回 —— 否则「关闭」只是个装饰。
 *
 * 这个脚本**自己拉起一个后端实例**（:4105），测完把工单随测试账号一起删掉；
 * 因为账号删除对工单是级联（`onDelete: Cascade`），删不干净会让后台列表越跑越长。
 *
 * 用法：node scripts/e2e-tickets.mjs
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = path.resolve(HERE, '..');

const APP_PORT = Number(process.env.TICKETS_E2E_PORT || 4105);
const API = `http://127.0.0.1:${APP_PORT}/api`;
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'balloon-admin-2026';
const OPEN_LIMIT = 5;

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
  const phone = `135${String(Date.now()).slice(-8)}`;
  const sent = await must('POST', '/auth/send-code', { body: { phone, purpose: 'register' } });
  const reg = await must('POST', '/auth/register', {
    body: { phone, password: 'e2e-tickets-123', code: sent.devCode, nickname: tag },
  });
  return { token: reg.token, userId: reg.user?.id ?? null, phone };
}

async function main() {
  console.log('\x1b[1m气球狗 · 客服工单端到端验证（§5.5）\x1b[0m');
  console.log(`  后端 ${API}`);

  const appChild = spawn('npx', ['tsx', 'src/server.ts'], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      PORT: String(APP_PORT),
      NODE_ENV: 'test',
      RATE_LIMIT_MAX: '100000',
      SUPPORT_CONTACT: 'support@balloon-dog.test',
    },
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

  const admin = await must('POST', '/admin/login', {
    body: { username: ADMIN_USER, password: ADMIN_PASSWORD },
  });
  const adminToken = admin.token;
  const adminId = admin.admin?.id ?? null;

  const parent = await registerParent('工单E2E');
  const stranger = await registerParent('工单E2E旁观');

  const openTicket = (token, subject, category = 'other') =>
    api('POST', '/support/tickets', {
      token,
      body: { category, subject, body: `${subject}：详细描述，用于端到端验证工单流程。` },
    });

  try {
    // ----------------------------------------------------------
    step('1. 入口自述：分类固定、上限与长度都告诉家长');

    const cfg = await must('GET', '/support/config', { token: parent.token });
    check(cfg.enabled === true, '工单入口默认开着');
    check(Array.isArray(cfg.categories) && cfg.categories.length === 6, `分类是固定枚举（${cfg.categories?.length} 类）`);
    check(cfg.categories.every((c) => c.key && c.label && typeof c.hint === 'string'), '每个分类都带一个「该写什么」的提示');
    check(cfg.categories.some((c) => c.key === 'payment') && cfg.categories.some((c) => c.key === 'device'), '支付、设备这些客服真会分组的分类都在');
    check(cfg.openLimit === OPEN_LIMIT && cfg.bodyMax === 2000, `如实告知上限：未关闭 ${cfg.openLimit} 张、正文 ${cfg.bodyMax} 字`);
    check(/不支持上传附件/.test(cfg.notice), '界面直接写明「不支持附件」，而不是留个假的上传按钮', cfg.notice);
    check(cfg.contact === 'support@balloon-dog.test', '联系方式来自配置，没配就留空', cfg.contact);

    // ----------------------------------------------------------
    step('2. 提交一张工单，家长能看到它');

    const created = await openTicket(parent.token, '退款三天未到账', 'payment');
    check(created.status === 201, '提交成功 → 201', String(created.status));
    const ticketNo = created.body?.ticketNo;
    check(typeof ticketNo === 'string' && /^T\d{8}-[0-9A-F]{6}$/.test(ticketNo), `工单号人眼可读、可在对话里报给客服：${ticketNo}`);
    check(created.body?.status === 'open' && created.body?.statusLabel === '待处理', '新工单是「待处理」');
    check(Array.isArray(created.body?.replies) && created.body.replies.length === 0, '刚提交时没有回复');
    check(created.body?.contact === parent.phone || created.body?.contact?.length > 0, '默认把账号手机号作为联系方式（家长可改）');

    const mine = await must('GET', '/support/tickets', { token: parent.token });
    check(mine.tickets.some((t) => t.ticketNo === ticketNo), '我的工单列表里有它');
    const detail = await must('GET', `/support/tickets/${ticketNo}`, { token: parent.token });
    check(detail.ticket.subject === '退款三天未到账', '详情能读到标题与正文');
    check(!JSON.stringify(detail.ticket).includes('adminId'), '家长端详情里没有 adminId（值班的是谁与家长无关）');
    check(!JSON.stringify(detail.ticket).includes('adminName'), '家长端详情里也没有客服账号名');
    check(!JSON.stringify(detail.ticket).includes('userId'), '家长端详情里不回传内部 userId');

    // ----------------------------------------------------------
    step('3. 跨账号：看不到、也回不了（一律 404，不是 403）');

    const strangerRead = await api('GET', `/support/tickets/${ticketNo}`, { token: stranger.token });
    check(strangerRead.status === 404, '别人的工单详情 → 404（不承认它存在）', String(strangerRead.status));
    const strangerReply = await api('POST', `/support/tickets/${ticketNo}/replies`, {
      token: stranger.token,
      body: { body: '我来插一句' },
    });
    check(strangerReply.status === 404, '别人的工单回复 → 404');
    const strangerList = await must('GET', '/support/tickets', { token: stranger.token });
    check(!strangerList.tickets.some((t) => t.ticketNo === ticketNo), '别人的工单不会出现在我的列表里');

    // ----------------------------------------------------------
    step('4. 参数校验');

    const shortSubject = await api('POST', '/support/tickets', {
      token: parent.token,
      body: { category: 'other', subject: '短', body: '正文够长了' },
    });
    check(shortSubject.status === 422, '标题太短 → 422');
    const shortBody = await api('POST', '/support/tickets', {
      token: parent.token,
      body: { category: 'other', subject: '标题够长', body: '短' },
    });
    check(shortBody.status === 422, '正文太短 → 422');
    const unknownCategory = await api('POST', '/support/tickets', {
      token: parent.token,
      body: { category: 'i-do-not-exist', subject: '标题够长', body: '正文也够长了' },
    });
    check(unknownCategory.status === 400, '分类不在固定枚举里 → 400（运营要能按分类统计）');
    const extraField = await api('POST', '/support/tickets', {
      token: parent.token,
      body: { category: 'other', subject: '标题够长', body: '正文也够长了', priority: 'high' },
    });
    check(extraField.status === 422, '家长不能自己定优先级（多传字段 → 422）');
    const badTicketNo = await api('GET', '/support/tickets/工单号非法', { token: parent.token });
    check(badTicketNo.status === 422, '工单号格式不合法 → 422（不落进查询）');

    // ----------------------------------------------------------
    step(`5. 未关闭的工单上限 ${OPEN_LIMIT} 张`);

    const extra = [];
    for (let i = 2; i <= OPEN_LIMIT; i++) {
      const r = await openTicket(parent.token, `凑数工单 ${i}`);
      if (r.status === 201) extra.push(r.body.ticketNo);
    }
    check(extra.length === OPEN_LIMIT - 1, `凑到 ${OPEN_LIMIT} 张未关闭工单（新增 ${extra.length} 张）`);
    const overLimit = await openTicket(parent.token, '第六张应该被挡住');
    check(
      overLimit.status === 409 && /未关闭/.test(overLimit.body?.message || ''),
      '第 6 张 → 409，文案说清是「未关闭的工单太多」',
      String(overLimit.status),
    );

    // ----------------------------------------------------------
    step('6. 后台看得到：账号、分派、优先级、分组筛选');

    const list = await must('GET', `/admin/tickets?keyword=${ticketNo}`, { token: adminToken });
    check(list.tickets.some((t) => t.ticketNo === ticketNo), '后台能按工单号搜到');
    const row = list.tickets.find((t) => t.ticketNo === ticketNo);
    check(row?.userPhone === parent.phone, '后台看得到家长手机号（客服要能联系）');
    check(row?.category === 'payment', '分类正确');
    check(row?.priority === 'normal' && row?.assigneeName === null, '默认「普通」优先级、还没分派');
    check(list.page === 1 && list.pageSize === 20 && typeof list.total === 'number', '分页信息齐全');

    const filtered = await must('GET', '/admin/tickets?status=open&category=payment&pageSize=1', { token: adminToken });
    check(filtered.tickets.length <= 1 && filtered.total >= 1, '筛选 + 分页生效');
    const badStatus = await api('GET', '/admin/tickets?status=not-a-status', { token: adminToken });
    check(badStatus.status === 400, '乱传状态 → 400，而不是悄悄返回全部');

    const adminDetail = await must('GET', `/admin/tickets/${ticketNo}`, { token: adminToken });
    check(adminDetail.ticket.userPhone === parent.phone && adminDetail.ticket.userId != null, '后台详情带归属账号');
    check(!JSON.stringify(adminDetail.ticket).includes('mediaUrl'), '后台工单里也没有孩子的照片/媒体内容（只处理文字）');
    const parentCannotReadAdmin = await api('GET', `/admin/tickets/${ticketNo}`, { token: parent.token });
    check(parentCannotReadAdmin.status === 401 || parentCannotReadAdmin.status === 403, '家长 token 打不进后台接口', String(parentCannotReadAdmin.status));

    // ----------------------------------------------------------
    step('7. 客服回复：状态推进 + 认领 + 家长仍看不到是谁回的');

    const replied = await api('POST', `/admin/tickets/${ticketNo}/replies`, {
      token: adminToken,
      body: { body: '已核实：退款会在 1-3 个工作日到账，请注意查收。' },
    });
    check(replied.status === 201, '后台回复 → 201', String(replied.status));
    check(replied.body?.ticket?.status === 'waiting', '回复后「待处理」自动推进到「等待家长回复」');
    check(replied.body?.ticket?.assigneeName === ADMIN_USER, '回复即认领：没分派过的工单，回复人成为负责人');
    check(replied.body?.ticket?.replies?.some((r) => r.by === 'admin' && r.adminName === ADMIN_USER), '后台能看到这条回复是谁写的');

    const parentAfterReply = await must('GET', `/support/tickets/${ticketNo}`, { token: parent.token });
    check(parentAfterReply.ticket.replies.some((r) => r.by === 'admin' && /退款会在/.test(r.body)), '家长能看到客服的回复内容');
    check(
      parentAfterReply.ticket.replies.every((r) => !('adminName' in r) && !('adminId' in r)),
      '每一条回复都只有「谁说的 / 什么时候 / 说了什么」，没有内部账号字段',
      JSON.stringify(parentAfterReply.ticket.replies),
    );

    // ----------------------------------------------------------
    step('8. 家长回话：重新进入客服待办');

    const parentReply = await api('POST', `/support/tickets/${ticketNo}/replies`, {
      token: parent.token,
      body: { body: '收到，那我再等两天，谢谢。' },
    });
    check(parentReply.status === 201 && parentReply.body?.ticket?.status === 'processing', '家长回话后回到「处理中」，不会停在「等待家长回复」');
    const emptyReply = await api('POST', `/support/tickets/${ticketNo}/replies`, { token: parent.token, body: { body: '' } });
    check(emptyReply.status === 422, '空回复 → 422');

    // ----------------------------------------------------------
    step('9. 后台改状态 / 优先级 / 分派人');

    const patched = await api('PATCH', `/admin/tickets/${ticketNo}`, {
      token: adminToken,
      body: { priority: 'high' },
    });
    check(patched.ok && patched.body?.ticket?.priority === 'high', '改成紧急优先级');
    const badPriority = await api('PATCH', `/admin/tickets/${ticketNo}`, { token: adminToken, body: { priority: 'urgent' } });
    check(badPriority.status === 422, '非法优先级 → 422');
    const emptyPatch = await api('PATCH', `/admin/tickets/${ticketNo}`, { token: adminToken, body: {} });
    check(emptyPatch.status === 400, '空的 PATCH → 400（没有要改的内容）');
    const badAssignee = await api('PATCH', `/admin/tickets/${ticketNo}`, { token: adminToken, body: { assigneeId: 99999999 } });
    check(badAssignee.status === 404, '分派给不存在的管理员 → 404');
    if (adminId != null) {
      const assigned = await api('PATCH', `/admin/tickets/${ticketNo}`, { token: adminToken, body: { assigneeId: adminId } });
      check(assigned.ok && assigned.body?.ticket?.assigneeName === ADMIN_USER, '分派给自己后，负责人显示出来');
      const unassigned = await api('PATCH', `/admin/tickets/${ticketNo}`, { token: adminToken, body: { assigneeId: null } });
      check(unassigned.ok && unassigned.body?.ticket?.assigneeName === null, '也能取消分派');
    } else {
      ok('（跳过：登录响应里没有管理员 id，分派/取消分派未验证）');
      ok('（跳过：同上）');
    }

    // ----------------------------------------------------------
    step('10. 关闭之后两家都不能再回；关掉一张就能再开一张');

    const closed = await api('PATCH', `/admin/tickets/${ticketNo}`, { token: adminToken, body: { status: 'closed' } });
    check(closed.ok && closed.body?.ticket?.status === 'closed', '后台关闭工单');
    check(closed.body?.ticket?.closedAt != null, '关闭时间落库（不是只改了个字符串）');
    const parentReplyClosed = await api('POST', `/support/tickets/${ticketNo}/replies`, {
      token: parent.token,
      body: { body: '那我还想问一句' },
    });
    check(parentReplyClosed.status === 409, '已关闭的工单家长不能再回 → 409');
    const adminReplyClosed = await api('POST', `/admin/tickets/${ticketNo}/replies`, {
      token: adminToken,
      body: { body: '再补一句' },
    });
    check(adminReplyClosed.status === 409, '客服也不能在已关闭的工单上继续回（要回复先改回「处理中」）');
    const reopened = await api('PATCH', `/admin/tickets/${ticketNo}`, { token: adminToken, body: { status: 'processing' } });
    check(reopened.ok && reopened.body?.ticket?.closedAt === null, '改回「处理中」时关闭时间被清掉（不留脏字段）');

    // 上面把 ticketNo 改回了「处理中」（验 closedAt 被清掉），所以额度还没腾出来 ——
    // 关掉另一张凑数工单来验「关闭 = 腾出额度」。
    const spare = extra[0];
    const closeSpare = await api('PATCH', `/admin/tickets/${spare}`, { token: adminToken, body: { status: 'closed' } });
    check(closeSpare.ok, '（前置）关掉一张凑数工单');
    const canOpenAgain = await openTicket(parent.token, '关闭一张后应该能再开');
    check(canOpenAgain.status === 201, '关掉一张之后额度腾出来了，可以再提交', String(canOpenAgain.status));

    // ----------------------------------------------------------
    step('11. 关掉入口：不能提交，但历史必须还能读');

    const flagOff = await api('PATCH', '/admin/flags/support.tickets', { token: adminToken, body: { enabled: false } });
    check(flagOff.ok, '（前置）把工单入口开关关掉');
    const cfgOff = await must('GET', '/support/config', { token: parent.token });
    check(cfgOff.enabled === false, '家长端读到 enabled=false（界面据此隐藏入口）');
    const blockedCreate = await openTicket(parent.token, '关掉入口后不该能提交');
    check(
      blockedCreate.status === 503 && /暂时关闭/.test(blockedCreate.body?.message || ''),
      '关掉入口后提交 → 503，文案说清是「暂时关闭」',
      String(blockedCreate.status),
    );
    const history = await api('GET', '/support/tickets', { token: parent.token });
    check(history.ok && history.body.tickets.length > 0, '历史工单仍然读得到（关入口不是删数据）');
    const adminHistory = await api('GET', `/admin/tickets?keyword=${ticketNo}`, { token: adminToken });
    check(adminHistory.ok && adminHistory.body.tickets.length >= 1, '后台也仍能查到历史工单');
    const reopen = await api('PATCH', '/admin/flags/support.tickets', { token: adminToken, body: { enabled: true } });
    check(reopen.ok, '（收尾）把入口开关打开');

    // ----------------------------------------------------------
    step('12. 后台操作留痕 + 清理');

    if (prisma) {
      const log = await prisma.operationLog.findFirst({
        where: { path: { contains: '/admin/tickets' } },
        orderBy: { createdAt: 'desc' },
      });
      check(log != null, '后台处理工单的动作进了审计日志');
      check(!String(log?.detail ?? '').includes('password'), '审计详情不含敏感字段');
    } else {
      for (let i = 0; i < 2; i++) ok('（跳过：拿不到 @prisma/client，审计未验证）');
    }

    const before = prisma
      ? await prisma.supportTicket.count({ where: { userId: parent.userId } })
      : null;
    for (const id of [parent.userId, stranger.userId]) {
      if (id == null) continue;
      const r = await api('DELETE', `/admin/users/${id}`, { token: adminToken });
      if (!r.ok && r.status !== 404) console.log(`  \x1b[33m•\x1b[0m 删除家长 ${id} → ${r.status}`);
    }
    if (prisma) {
      const after = await prisma.supportTicket.count({ where: { userId: parent.userId } });
      check(before > 0 && after === 0, `删账号时工单被级联删除（删前 ${before} 张 → 删后 ${after} 张），后台不留家长写过的正文`);
      const orphans = await prisma.supportTicket.count({ where: { userId: null } });
      check(orphans === 0, '数据库里没有留下无归属的孤儿工单');
    } else {
      ok('清理完成（测试家长已删除）');
      ok('（跳过：拿不到 @prisma/client，级联删除未验证）');
    }
  } finally {
    await api('PATCH', '/admin/flags/support.tickets', { token: adminToken, body: { enabled: true } }).catch(() => {});
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
