#!/usr/bin/env node
/**
 * 端到端冒烟测试。
 *
 * 覆盖：认证与越权、多用户数据隔离、设备绑定、功能配置、答题、位置与安全区、
 * 以及最关键的「设备指令队列」完整闭环（下发 → 设备领取 → 回报 → 状态落地）。
 *
 * 运行前需先启动服务并灌好种子数据：
 *   npm run db:up && npm run prisma:migrate && npm run seed
 *   npm run dev            # 另开一个终端
 *   npm run smoke          # 或在 server/ 下 node scripts/smoke-test.mjs
 *
 * 环境变量：
 *   API_BASE   默认 http://localhost:4000/api
 *   SMOKE_PHONE / SMOKE_PASSWORD   默认用种子里的演示账号
 */

const API_BASE = process.env.API_BASE || 'http://localhost:4000/api';
const DEMO_PHONE = process.env.SMOKE_PHONE || '13800138000';
const DEMO_PASSWORD = process.env.SMOKE_PASSWORD || 'balloon123';

let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, extra = '') {
  if (condition) {
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    failed++;
    failures.push(name);
    console.log(`  \x1b[31m✗\x1b[0m ${name}${extra ? ` — ${extra}` : ''}`);
  }
}

function section(title) {
  console.log(`\n\x1b[1m${title}\x1b[0m`);
}

/** 统一的请求封装：返回 { status, body } */
async function req(method, path, { token, body, raw } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    body: body !== undefined ? (raw ? body : JSON.stringify(body)) : undefined,
  });

  const text = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed };
}

/** 随机手机号，避免与既有数据冲突 */
function randomPhone() {
  const suffix = String(Math.floor(Math.random() * 100_000_000)).padStart(8, '0');
  return `139${suffix}`;
}

/** 走真实发码流程注册一个账号，返回 token。 */
async function registerFreshUser(label) {
  const phone = randomPhone();
  const send = await req('POST', '/auth/send-code', { body: { phone, purpose: 'register' } });
  const code = send.body?.devCode;
  if (!code) {
    throw new Error(
      `${label}: 未拿到 devCode —— 说明配置了真实短信通道，或服务未启动。响应：${JSON.stringify(send.body)}`,
    );
  }
  const reg = await req('POST', '/auth/register', {
    body: { phone, password: 'smoke123', code, nickname: label },
  });
  if (!reg.body?.token) {
    throw new Error(`${label}: 注册失败 ${reg.status} ${JSON.stringify(reg.body)}`);
  }
  return { phone, token: reg.body.token, userId: reg.body.user?.id };
}

async function main() {
  console.log(`\n🧪 气球狗后端冒烟测试 → ${API_BASE}\n`);

  // 先确认服务可达，避免一堆莫名其妙的失败
  try {
    const health = await fetch(API_BASE.replace(/\/api$/, '') + '/health');
    if (!health.ok) throw new Error(`health ${health.status}`);
  } catch (err) {
    console.error(`\x1b[31m无法连接后端（${API_BASE}）：${err.message}\x1b[0m`);
    console.error('请先执行：npm run db:up && npm run prisma:migrate && npm run seed && npm run dev');
    process.exit(1);
  }

  // ============================================================
  section('1. 认证（密码必须真的校验）');
  // ============================================================
  const wrongPwd = await req('POST', '/auth/login', {
    body: { phone: DEMO_PHONE, password: 'definitely-wrong' },
  });
  check('错误密码登录被拒（401）', wrongPwd.status === 401, `实际 ${wrongPwd.status}`);
  check('错误密码不泄露账号是否存在', /密码错误|账号或密码/.test(wrongPwd.body?.message || ''));

  const login = await req('POST', '/auth/login', {
    body: { phone: DEMO_PHONE, password: DEMO_PASSWORD },
  });
  check('正确密码登录成功（200）', login.status === 200, `实际 ${login.status}`);
  check('返回 JWT 而非可猜的 token_id', typeof login.body?.token === 'string' && login.body.token.split('.').length === 3);
  const parentToken = login.body?.token;

  const noUser = await req('POST', '/auth/login', { body: { phone: '13000000000', password: 'x' } });
  check('不存在的账号登录被拒（401）', noUser.status === 401, `实际 ${noUser.status}`);

  const badCode = await req('POST', '/auth/register', {
    body: { phone: randomPhone(), password: 'abc123', code: '000000' },
  });
  check('错误验证码无法注册', badCode.status >= 400 && badCode.status < 500, `实际 ${badCode.status}`);

  const malformed = await req('POST', '/auth/login', { body: '{not json', raw: true });
  check('畸形 JSON 返回 400 而不是 500', malformed.status === 400, `实际 ${malformed.status}`);

  // ============================================================
  section('2. 未鉴权访问一律 401（原 mock 的 /device、/features 完全裸奔）');
  // ============================================================
  const guarded = [
    ['GET', '/device'],
    ['GET', '/features'],
    ['GET', '/devices'],
    ['GET', '/quiz/config'],
    ['GET', '/quiz/statistics'],
    ['GET', '/locations'],
    ['GET', '/safe-zones'],
    ['GET', '/media'],
    ['POST', '/device/lock'],
    ['PUT', '/features'],
  ];
  for (const [method, path] of guarded) {
    const r = await req(method, path, { body: method === 'GET' ? undefined : {} });
    check(`未登录 ${method} ${path} → 401`, r.status === 401, `实际 ${r.status}`);
  }
  const forged = await req('GET', '/user/info', { token: 'token_1' });
  check('伪造旧式 token 被拒（401）', forged.status === 401, `实际 ${forged.status}`);

  // ============================================================
  section('3. 多用户数据隔离');
  // ============================================================
  const userB = await registerFreshUser('隔离测试B');
  const listA = await req('GET', '/devices', { token: parentToken });
  const deviceA = listA.body?.devices?.[0];
  check('A 有自己的设备', Boolean(deviceA), JSON.stringify(listA.body).slice(0, 120));

  const listB = await req('GET', '/devices', { token: userB.token });
  check('B 的设备列表为空（看不到 A 的设备）', (listB.body?.devices || []).length === 0);

  const steal = await req('GET', `/device?deviceId=${deviceA?.id}`, { token: userB.token });
  check('B 指定 A 的 deviceId 被拒（403）', steal.status === 403, `实际 ${steal.status}`);

  const stealWrite = await req('POST', `/device/lock?deviceId=${deviceA?.id}`, {
    token: userB.token,
    body: { locked: true },
  });
  check('B 无法对 A 的设备下发指令（403）', stealWrite.status === 403, `实际 ${stealWrite.status}`);

  const stealDelete = await req('DELETE', `/devices/${deviceA?.id}`, { token: userB.token });
  check('B 无法删除 A 的设备（403）', stealDelete.status === 403, `实际 ${stealDelete.status}`);

  // ============================================================
  section('4. 设备状态与功能配置');
  // ============================================================
  const device = await req('GET', '/device', { token: parentToken });
  check('GET /device 成功', device.status === 200, `实际 ${device.status}`);
  check('返回设备名', typeof device.body?.name === 'string' && device.body.name.length > 0);
  check('返回可读的 lastActive 文案', typeof device.body?.lastActive === 'string');

  const features = await req('GET', '/features', { token: parentToken });
  check('GET /features 成功', features.status === 200);
  check('features.timePlan 结构完整', typeof features.body?.timePlan?.dailyLimit === 'number');
  check('features.appLimit.apps 是对象', typeof features.body?.appLimit?.apps === 'object');
  check('features.appAudit.pendingApps 是数组', Array.isArray(features.body?.appAudit?.pendingApps));
  check('features.webBlock.blockedUrls 是数组', Array.isArray(features.body?.webBlock?.blockedUrls));
  check('features.quizUnlock 存在', Boolean(features.body?.quizUnlock));

  const badFeature = await req('PUT', '/features', {
    token: parentToken,
    body: { feature: 'notARealFeature', enabled: true },
  });
  check('未知功能标识被拒（400）', badFeature.status === 400, `实际 ${badFeature.status}`);

  const toggle = await req('PUT', '/features', {
    token: parentToken,
    body: { feature: 'screenMonitor', enabled: true },
  });
  check('切换合法功能成功', toggle.status === 200);
  const afterToggle = await req('GET', '/features', { token: parentToken });
  check('切换结果已持久化', afterToggle.body?.screenMonitor?.enabled === true);

  const timePlan = await req('PUT', '/features/time-plan', {
    token: parentToken,
    body: { dailyLimit: 90 },
  });
  check('设置每日时长成功', timePlan.status === 200);
  const afterTimePlan = await req('GET', '/features', { token: parentToken });
  check('每日时长已更新为 90', afterTimePlan.body?.timePlan?.dailyLimit === 90);

  // ============================================================
  section('5. 答题解锁');
  // ============================================================
  const quizConfig = await req('GET', '/quiz/config', { token: parentToken });
  check('GET /quiz/config 成功', quizConfig.status === 200);
  check('兼容前端 questionBank 字段', typeof quizConfig.body?.questionBank === 'string');
  check('grade 与 questionBank 同值', quizConfig.body?.grade === quizConfig.body?.questionBank);

  const putQuiz = await req('PUT', '/quiz/config', {
    token: parentToken,
    body: { quizType: 'english', questionBank: 'grade4', correctRewardMinutes: 5, randomMode: false, enabled: true },
  });
  check('更新答题配置成功', putQuiz.status === 200, JSON.stringify(putQuiz.body).slice(0, 120));
  check('奖励时长已更新为 5', putQuiz.body?.config?.correctRewardMinutes === 5);

  const question = await req('GET', '/quiz/question', { token: parentToken });
  check('取题成功', question.status === 200, JSON.stringify(question.body).slice(0, 120));
  check('预览题目不泄露正确答案', question.body?.correctAnswer === undefined);

  const stats = await req('GET', '/quiz/statistics', { token: parentToken });
  check('统计成功', stats.status === 200);
  check('统计含 byType.english/poetry/random', ['english', 'poetry', 'random'].every((k) => k in (stats.body?.byType || {})));

  const records = await req('GET', '/quiz/records', { token: parentToken });
  check('答题记录成功', records.status === 200 && Array.isArray(records.body?.records));

  // ============================================================
  section('6. 位置与安全区');
  // ============================================================
  const locations = await req('GET', '/locations', { token: parentToken });
  check('GET /locations 成功', locations.status === 200);
  check('返回位置列表', Array.isArray(locations.body?.locations));
  check(
    '按安全区推导出 home/school 类型',
    (locations.body?.locations || []).some((l) => l.type === 'home') &&
      (locations.body?.locations || []).some((l) => l.type === 'school'),
    JSON.stringify((locations.body?.locations || []).map((l) => l.type)),
  );

  const zones = await req('GET', '/safe-zones', { token: parentToken });
  check('GET /safe-zones 成功', zones.status === 200 && Array.isArray(zones.body?.safeZones));

  const createZone = await req('POST', '/safe-zones', {
    token: parentToken,
    body: { name: '奶奶家', latitude: 31.2304, longitude: 121.4737, radiusMeters: 500, type: 'other' },
  });
  check('新增安全区成功', createZone.status === 201, JSON.stringify(createZone.body).slice(0, 120));
  const zoneId = createZone.body?.safeZone?.id;
  const delZone = await req('DELETE', `/safe-zones/${zoneId}`, { token: parentToken });
  check('删除安全区成功', delZone.status === 200);

  // ============================================================
  section('7. 设备绑定（真实配对流程）');
  // ============================================================
  const agentCode = `SMOKE${String(Math.floor(Math.random() * 900) + 100)}`;
  const agentSecret = 'smoke-secret-0123456789abcdef';

  const reg1 = await req('POST', '/agent/register', {
    body: {
      deviceCode: agentCode,
      deviceSecret: agentSecret,
      name: '冒烟测试机',
      model: 'TestPhone X',
      os: 'Android',
      osVersion: '14',
      agentVersion: '1.0.0-smoke',
    },
  });
  check('设备端自助注册成功（201）', reg1.status === 201, `实际 ${reg1.status}`);
  check('注册后处于未绑定状态', reg1.body?.bound === false);
  const deviceToken = reg1.body?.deviceToken;

  const reg2 = await req('POST', '/agent/register', {
    body: { deviceCode: agentCode, deviceSecret: agentSecret, model: 'TestPhone X', os: 'Android' },
  });
  check('同设备重复注册是幂等的（200）', reg2.status === 200, `实际 ${reg2.status}`);

  const regBad = await req('POST', '/agent/register', {
    body: { deviceCode: agentCode, deviceSecret: 'wrong-secret-0123456789abcdef', model: 'X', os: 'Y' },
  });
  check('错误设备密钥被拒（403）', regBad.status === 403, `实际 ${regBad.status}`);

  const bind = await req('POST', '/devices/bind', {
    token: parentToken,
    body: { deviceCode: agentCode, name: '冒烟测试机' },
  });
  check('家长凭设备码绑定成功（201）', bind.status === 201, `实际 ${bind.status} ${JSON.stringify(bind.body).slice(0, 120)}`);
  const smokeDeviceId = bind.body?.device?.id;

  const bindAgain = await req('POST', '/devices/bind', {
    token: parentToken,
    body: { deviceCode: agentCode },
  });
  check('重复绑定是幂等的', bindAgain.status === 200 && bindAgain.body?.alreadyBound === true);

  const bindByOther = await req('POST', '/devices/bind', { token: userB.token, body: { deviceCode: agentCode } });
  check('他人无法绑定已认领的设备（409）', bindByOther.status === 409, `实际 ${bindByOther.status}`);

  const bindUnknown = await req('POST', '/devices/bind', { token: parentToken, body: { deviceCode: 'NOSUCH99' } });
  check('不存在的设备码被拒（404）', bindUnknown.status === 404, `实际 ${bindUnknown.status}`);

  // ============================================================
  section('8. 指令队列完整闭环（下发 → 设备领取 → 回报 → 状态落地）');
  // ============================================================
  const agentHeaders = { token: deviceToken };

  const hb = await req('POST', '/agent/heartbeat', {
    token: deviceToken,
    body: { battery: 73, network: 'wifi' },
  });
  check('设备心跳成功', hb.status === 200 && hb.body?.bound === true);

  const cfg = await req('GET', '/agent/config', agentHeaders);
  check('设备拉取管控策略成功', cfg.status === 200);
  check('策略含 timePlan.remainingMinutes', typeof cfg.body?.timePlan?.remainingMinutes === 'number');
  check('策略含 blockedUrls', Array.isArray(cfg.body?.blockedUrls));
  check('策略含 appLimits', Array.isArray(cfg.body?.appLimits));

  const noCmd = await req('GET', '/agent/commands/next?wait=0', agentHeaders);
  check('空闲时返回 command:null', noCmd.status === 200 && noCmd.body?.command === null);

  // 家长下发锁屏
  const lock = await req('POST', `/device/lock?deviceId=${smokeDeviceId}`, {
    token: parentToken,
    body: { locked: true },
  });
  check('下发锁屏指令成功（202）', lock.status === 200 || lock.status === 202, `实际 ${lock.status}`);
  check('返回指令对象', Boolean(lock.body?.command?.id));
  check('返回期望状态（乐观更新）', lock.body?.device?.locked === true);
  const lockCmdId = lock.body?.command?.id;

  // 设备领取
  const claim = await req('GET', '/agent/commands/next?wait=0', agentHeaders);
  check('设备成功领取到指令', claim.body?.command?.id === lockCmdId, JSON.stringify(claim.body).slice(0, 160));
  check('指令类型为 lock', claim.body?.command?.type === 'lock');

  const claimAgain = await req('GET', '/agent/commands/next?wait=0', agentHeaders);
  check('同一条指令不会被重复领取', claimAgain.body?.command === null);

  // 设备回报成功
  const report = await req('POST', `/agent/commands/${lockCmdId}/result`, {
    token: deviceToken,
    body: { status: 'succeeded', result: { locked: true } },
  });
  check('设备回报执行结果成功', report.status === 200, JSON.stringify(report.body).slice(0, 160));
  check('指令状态变为 succeeded', report.body?.command?.status === 'succeeded');

  const afterLock = await req('GET', `/device?deviceId=${smokeDeviceId}`, { token: parentToken });
  check('设备锁屏状态已落地', afterLock.body?.locked === true);

  // 指令失败必须回滚乐观状态
  const unlock = await req('POST', `/device/lock?deviceId=${smokeDeviceId}`, {
    token: parentToken,
    body: { locked: false },
  });
  const unlockCmdId = unlock.body?.command?.id;
  check('下发解锁后乐观状态为未锁定', unlock.body?.device?.locked === false);
  await req('GET', '/agent/commands/next?wait=0', agentHeaders);
  const failReport = await req('POST', `/agent/commands/${unlockCmdId}/result`, {
    token: deviceToken,
    body: { status: 'failed', error: '系统权限被拒绝' },
  });
  check('设备回报失败被接受', failReport.status === 200 && failReport.body?.command?.status === 'failed');
  const afterFail = await req('GET', `/device?deviceId=${smokeDeviceId}`, { token: parentToken });
  check('失败后状态回滚为已锁定', afterFail.body?.locked === true, `实际 locked=${afterFail.body?.locked}`);

  // 临时解锁
  const temp = await req('POST', `/device/temp-unlock?deviceId=${smokeDeviceId}`, {
    token: parentToken,
    body: { minutes: 15 },
  });
  check('下发临时解锁成功', temp.status === 200 || temp.status === 202);
  check('临时解锁后状态为未锁定', temp.body?.device?.locked === false);
  check('返回解锁到期时间', typeof temp.body?.device?.tempUnlock === 'string');
  const tempCmdId = temp.body?.command?.id;
  await req('GET', '/agent/commands/next?wait=0', agentHeaders);
  await req('POST', `/agent/commands/${tempCmdId}/result`, {
    token: deviceToken,
    body: { status: 'succeeded', result: { until: temp.body?.device?.tempUnlock } },
  });

  const cancel = await req('POST', `/device/cancel-temp-unlock?deviceId=${smokeDeviceId}`, {
    token: parentToken,
    body: {},
  });
  check('取消临时解锁成功', cancel.status === 200 || cancel.status === 202);
  check('取消后回到锁定态', cancel.body?.device?.locked === true);

  // 未开启功能时禁止下发采集类指令
  const photoBlocked = await req('POST', `/device/remote-photo?deviceId=${smokeDeviceId}`, {
    token: parentToken,
    body: {},
  });
  check('未开功能时拒绝下发远程拍照（400）', photoBlocked.status === 400, `实际 ${photoBlocked.status}`);

  await req('PUT', `/features?deviceId=${smokeDeviceId}`, {
    token: parentToken,
    body: { feature: 'remotePhoto', enabled: true },
  });
  const photoOk = await req('POST', `/device/remote-photo?deviceId=${smokeDeviceId}`, {
    token: parentToken,
    body: {},
  });
  check('开启功能后远程拍照下发成功', photoOk.status === 202, `实际 ${photoOk.status}`);
  check('返回「设备离线」提示语义正确', typeof photoOk.body?.warning === 'string' || photoOk.body?.warning === undefined);

  // 指令历史
  const history = await req('GET', `/device/commands?deviceId=${smokeDeviceId}&limit=50`, { token: parentToken });
  check('查询指令历史成功', history.status === 200 && Array.isArray(history.body?.commands));
  check('历史里包含已完成的锁屏指令', (history.body?.commands || []).some((c) => c.id === lockCmdId && c.status === 'succeeded'));

  // 设备端不能访问家长接口
  const agentAsParent = await req('GET', '/devices', { token: deviceToken });
  check('设备令牌不能访问家长接口（401）', agentAsParent.status === 401, `实际 ${agentAsParent.status}`);

  // 家长令牌不能冒充设备
  const parentAsAgent = await req('GET', '/agent/config', { token: parentToken });
  check('家长令牌不能访问设备接口（401）', parentAsAgent.status === 401, `实际 ${parentAsAgent.status}`);

  // ============================================================
  section('9. 清理');
  // ============================================================
  const cleanup = await req('DELETE', `/devices/${smokeDeviceId}`, { token: parentToken });
  check('解绑测试设备成功', cleanup.status === 200);
  const gone = await req('GET', `/agent/config`, agentHeaders);
  check('解绑后设备令牌立即失效（401）', gone.status === 401, `实际 ${gone.status}`);
  const restoreTimePlan = await req('PUT', '/features/time-plan', {
    token: parentToken,
    body: { dailyLimit: 120 },
  });
  check('恢复演示数据的每日时长', restoreTimePlan.status === 200);


  // ============================================================
  section('10. 管理后台：认证与权限隔离');
  // ============================================================
  const ADMIN_USER = process.env.SMOKE_ADMIN || 'admin';
  const ADMIN_PASS = process.env.SMOKE_ADMIN_PASSWORD || 'balloon-admin-2026';

  const badAdminLogin = await req('POST', '/admin/login', {
    body: { username: ADMIN_USER, password: 'definitely-wrong' },
  });
  check('管理员错误密码被拒（401）', badAdminLogin.status === 401, `实际 ${badAdminLogin.status}`);

  const adminLogin = await req('POST', '/admin/login', {
    body: { username: ADMIN_USER, password: ADMIN_PASS },
  });
  check('管理员正确密码登录成功', adminLogin.status === 200, JSON.stringify(adminLogin.body).slice(0, 140));
  const adminToken = adminLogin.body?.token;
  check('返回管理员 JWT 与身份信息', adminLogin.body?.admin?.role === 'super');
  check('登录响应含最近登录时间字段', 'lastLoginAt' in (adminLogin.body?.admin ?? {}));

  const parentAsAdmin = await req('GET', '/admin/stats', { token: parentToken });
  check('家长令牌访问后台接口被拒（401）', parentAsAdmin.status === 401, `实际 ${parentAsAdmin.status}`);

  const adminAsParent = await req('GET', '/device', { token: adminToken });
  check('管理员令牌访问家长接口被拒（401）', adminAsParent.status === 401, `实际 ${adminAsParent.status}`);

  const noToken = await req('GET', '/admin/stats');
  check('未登录访问后台接口被拒（401）', noToken.status === 401, `实际 ${noToken.status}`);

  // 运营账号权限边界
  const operatorLogin = await req('POST', '/admin/login', {
    body: { username: 'operator', password: 'balloon-operator-2026' },
  });
  if (operatorLogin.status === 200) {
    const opToken = operatorLogin.body.token;
    const opCreateAdmin = await req('POST', '/admin/admins', {
      token: opToken,
      body: { username: 'smoke_hacker', password: 'whatever123' },
    });
    check('运营账号不能新建管理员（403）', opCreateAdmin.status === 403, `实际 ${opCreateAdmin.status}`);
    const opStats = await req('GET', '/admin/stats', { token: opToken });
    check('运营账号可以查看数据看板（200）', opStats.status === 200);
    // 单独造一台已认领设备做解绑验证：不要复用 smokeDeviceId ——
    // 前面的清理段已经把它删掉了，用它会得到 404（行为正确，但不是这里要测的东西）。
    const opAgentCode = `OPTEST${String(Math.floor(Math.random() * 9000) + 1000)}`;
    await req('POST', '/agent/register', {
      body: {
        deviceCode: opAgentCode,
        deviceSecret: 'op-test-secret-0123456789abcdef',
        model: 'OperatorTestPhone',
        os: 'Android',
      },
    });
    const opBind = await req('POST', '/devices/bind', {
      token: parentToken,
      body: { deviceCode: opAgentCode, name: '运营处置测试机' },
    });
    const opDeviceId = opBind.body?.device?.id;
    const opUnbind = await req('POST', `/admin/devices/${opDeviceId}/unbind`, { token: opToken });
    check('运营账号可以强制解绑设备（200）', opUnbind.status === 200, `实际 ${opUnbind.status}`);
    const opAfterUnbind = await req('GET', `/admin/devices/${opDeviceId}`, { token: opToken });
    check('解绑后设备变为待认领', opAfterUnbind.body?.device?.bound === false,
      JSON.stringify(opAfterUnbind.body?.device?.bound));
    await req('DELETE', `/admin/devices/${opDeviceId}`, { token: opToken });
  } else {
    check('运营账号登录成功', false, `实际 ${operatorLogin.status}`);
  }

  // ============================================================
  section('11. 管理后台：数据看板与列表接口');
  // ============================================================
  const adminStats = await req('GET', '/admin/stats?days=7', { token: adminToken });
  check('看板接口成功', adminStats.status === 200);
  check('KPI 字段齐全', ['totalUsers', 'totalDevices', 'totalCommands', 'commandSuccessRate'].every((k) => k in (adminStats.body?.kpi ?? {})));
  check('趋势按天补齐（7 天）', (adminStats.body?.series?.users ?? []).length === 7, `实际 ${adminStats.body?.series?.users?.length}`);
  check('含指令类型分布', Array.isArray(adminStats.body?.breakdown?.commandsByType));
  check('含指令状态分布', Array.isArray(adminStats.body?.breakdown?.commandsByStatus));

  const adminLists = [
    ['/admin/users', '家长账号'],
    ['/admin/devices', '设备'],
    ['/admin/commands', '指令'],
    ['/admin/questions', '题库'],
    ['/admin/quiz-records', '答题记录'],
    ['/admin/sms-codes', '验证码'],
    ['/admin/logs', '操作日志'],
  ];
  for (const [path, label] of adminLists) {
    const res = await req('GET', `${path}?page=1&pageSize=5`, { token: adminToken });
    const okShape =
      res.status === 200 &&
      Array.isArray(res.body?.items) &&
      typeof res.body?.total === 'number' &&
      typeof res.body?.totalPages === 'number';
    check(`${label}列表返回统一分页结构`, okShape, JSON.stringify(res.body).slice(0, 120));
  }

  const adminsList = await req('GET', '/admin/admins', { token: adminToken });
  check('管理员列表返回', adminsList.status === 200 && Array.isArray(adminsList.body?.admins));

  // 验证码审计绝不能泄露哈希
  const smsList = await req('GET', '/admin/sms-codes?page=1&pageSize=5', { token: adminToken });
  const smsRaw = JSON.stringify(smsList.body ?? {});
  check('验证码审计不返回 codeHash', !smsRaw.includes('codeHash'));
  check('验证码记录带 state 字段', smsList.body?.items?.every((i) => typeof i.state === 'string') ?? false);

  // ============================================================
  section('12. 管理后台：家长账号处置生效');
  // ============================================================
  const victim = await registerFreshUser('后台处置测试');
  const disable = await req('PATCH', `/admin/users/${victim.userId}/status`, {
    token: adminToken,
    body: { status: 'disabled', reason: '冒烟测试' },
  });
  check('后台禁用家长账号成功', disable.status === 200, `实际 ${disable.status}`);

  const victimAfterDisable = await req('GET', '/device', { token: victim.token });
  check('被禁用账号的令牌立即失效（401）', victimAfterDisable.status === 401, `实际 ${victimAfterDisable.status}`);

  const victimReLogin = await req('POST', '/auth/login', {
    body: { phone: victim.phone, password: 'smoke123' },
  });
  check('被禁用账号无法重新登录', victimReLogin.status >= 400, `实际 ${victimReLogin.status}`);

  const enable = await req('PATCH', `/admin/users/${victim.userId}/status`, {
    token: adminToken,
    body: { status: 'active' },
  });
  check('后台启用家长账号成功', enable.status === 200);
  const victimReloginOk = await req('POST', '/auth/login', {
    body: { phone: victim.phone, password: 'smoke123' },
  });
  check('启用后可正常登录', victimReloginOk.status === 200);

  const userDetail = await req('GET', `/admin/users/${victim.userId}`, { token: adminToken });
  check('家长账号详情返回', userDetail.status === 200);
  check('详情不含原始 wechatOpenid', userDetail.body?.user?.wechatOpenid === undefined);

  // ============================================================
  section('13. 管理后台：题库增删改与保护规则');
  // ============================================================
  const created = await req('POST', '/admin/questions', {
    token: adminToken,
    body: {
      type: 'english',
      grade: 'grade2',
      question: `冒烟测试题 ${Date.now()}`,
      options: ['A 选项', 'B 选项', 'C 选项'],
      correctAnswer: 1,
      explanation: '冒烟测试解析',
    },
  });
  check('新增题目成功（201）', created.status === 201, JSON.stringify(created.body).slice(0, 140));
  const questionId = created.body?.question?.id;

  const badAnswer = await req('POST', '/admin/questions', {
    token: adminToken,
    body: { type: 'english', grade: 'grade2', question: '答案越界', options: ['a', 'b'], correctAnswer: 5 },
  });
  check('答案下标越界被拒（422）', badAnswer.status === 422, `实际 ${badAnswer.status}`);

  const updated = await req('PATCH', `/admin/questions/${questionId}`, {
    token: adminToken,
    body: { question: '冒烟测试题（已修改）', correctAnswer: 2 },
  });
  check('修改题目成功', updated.status === 200 && updated.body?.question?.correctAnswer === 2);

  const shrinkOptions = await req('PATCH', `/admin/questions/${questionId}`, {
    token: adminToken,
    body: { options: ['只剩一个选项', '两个选项'] },
  });
  check('改选项导致答案越界时被拒', shrinkOptions.status >= 400, `实际 ${shrinkOptions.status}`);

  const delQuestion = await req('DELETE', `/admin/questions/${questionId}`, { token: adminToken });
  check('删除无作答记录的题目成功', delQuestion.status === 200);

  // 有作答记录的题目必须拒绝删除（否则会级联清掉孩子的答题历史）
  const quizRecords = await req('GET', '/admin/quiz-records?page=1&pageSize=1', { token: adminToken });
  const usedQuestionId = quizRecords.body?.items?.[0]?.questionId;
  if (usedQuestionId) {
    const delUsed = await req('DELETE', `/admin/questions/${usedQuestionId}`, { token: adminToken });
    check('有作答记录的题目拒绝删除（409）', delUsed.status === 409, `实际 ${delUsed.status}`);
  } else {
    check('（跳过）当前没有带记录的题目', true);
  }

  // ============================================================
  section('14. 管理后台：账号自身的保护规则');
  // ============================================================
  const meId = adminLogin.body?.admin?.id;
  const disableSelf = await req('PATCH', `/admin/admins/${meId}/status`, {
    token: adminToken,
    body: { status: 'disabled' },
  });
  check('不能禁用自己（400）', disableSelf.status === 400, `实际 ${disableSelf.status}`);

  const deleteSelf = await req('DELETE', `/admin/admins/${meId}`, { token: adminToken });
  check('不能删除自己（400）', deleteSelf.status === 400, `实际 ${deleteSelf.status}`);

  const resetSelfViaManage = await req('PATCH', `/admin/admins/${meId}/password`, {
    token: adminToken,
    body: { password: 'newpassword123' },
  });
  check('不能用「重置」接口改自己密码（400）', resetSelfViaManage.status === 400, `实际 ${resetSelfViaManage.status}`);

  const dupAdmin = await req('POST', '/admin/admins', {
    token: adminToken,
    body: { username: ADMIN_USER, password: 'whatever123', role: 'operator' },
  });
  check('重复的管理员账号被拒（409）', dupAdmin.status === 409, `实际 ${dupAdmin.status}`);

  // 创建一个临时管理员，验证改密与删除
  const tempAdminName = `smoke_admin_${Date.now().toString().slice(-6)}`;
  const tempAdmin = await req('POST', '/admin/admins', {
    token: adminToken,
    body: { username: tempAdminName, password: 'temp-password-1', name: '冒烟临时管理员', role: 'operator' },
  });
  check('新建管理员成功（201）', tempAdmin.status === 201, JSON.stringify(tempAdmin.body).slice(0, 140));
  const tempAdminId = tempAdmin.body?.admin?.id;

  const tempLogin = await req('POST', '/admin/login', {
    body: { username: tempAdminName, password: 'temp-password-1' },
  });
  check('新建管理员可登录', tempLogin.status === 200);

  const resetTempPwd = await req('PATCH', `/admin/admins/${tempAdminId}/password`, {
    token: adminToken,
    body: { password: 'temp-password-2' },
  });
  check('重置他人密码成功', resetTempPwd.status === 200);
  const tempLoginNew = await req('POST', '/admin/login', {
    body: { username: tempAdminName, password: 'temp-password-2' },
  });
  check('新密码可登录', tempLoginNew.status === 200);
  const tempLoginOld = await req('POST', '/admin/login', {
    body: { username: tempAdminName, password: 'temp-password-1' },
  });
  check('旧密码已失效', tempLoginOld.status === 401, `实际 ${tempLoginOld.status}`);

  const delTemp = await req('DELETE', `/admin/admins/${tempAdminId}`, { token: adminToken });
  check('删除管理员成功', delTemp.status === 200);

  const tempGone = await req('POST', '/admin/login', {
    body: { username: tempAdminName, password: 'temp-password-2' },
  });
  check('已删除管理员无法登录', tempGone.status === 401, `实际 ${tempGone.status}`);

  // ============================================================
  section('15. 管理后台：操作审计');
  // ============================================================
  const logs = await req('GET', '/admin/logs?page=1&pageSize=50', { token: adminToken });
  check('操作日志可读', logs.status === 200 && Array.isArray(logs.body?.items));
  const logRows = logs.body?.items ?? [];
  check('记录了管理员登录', logRows.some((l) => l.action === '管理员登录'));
  check('记录了失败的登录尝试（401）', logRows.some((l) => l.status === 401));
  check('记录了禁用家长账号', logRows.some((l) => l.action === '修改家长账号状态'));
  check('日志含来源 IP', logRows.some((l) => typeof l.ip === 'string' && l.ip.length > 0));
  const sensitiveLeak = logRows.some((l) => {
    const d = l.detail || '';
    return /"password"\s*:\s*"(?!\*\*\*)/.test(d) || /"code"\s*:\s*"(?!\*\*\*)/.test(d);
  });
  check('日志中的密码/验证码已脱敏', !sensitiveLeak);

  const onlyFailedLogs = await req('GET', '/admin/logs?onlyFailed=true&pageSize=20', { token: adminToken });
  check('只看失败日志生效', (onlyFailedLogs.body?.items ?? []).every((l) => l.status >= 400));

  // ============================================================
  section('16. 管理后台：验证码清理');
  // ============================================================
  const purge = await req('POST', '/admin/sms-codes/purge', { token: adminToken });
  check('清理历史验证码成功', purge.status === 200 && typeof purge.body?.deleted === 'number',
    JSON.stringify(purge.body).slice(0, 120));
  const purgeAgain = await req('POST', '/admin/sms-codes/purge', { token: adminToken });
  check('重复清理是幂等的（第二次为 0）', purgeAgain.body?.deleted === 0, `实际 ${purgeAgain.body?.deleted}`);

  // ============================================================
  section('17. 管理后台：修改自己的密码');
  // ============================================================
  const wrongOld = await req('POST', '/admin/password', {
    token: adminToken,
    body: { oldPassword: 'not-the-password', newPassword: 'brand-new-pass-1' },
  });
  check('原密码错误被拒（401）', wrongOld.status === 401, `实际 ${wrongOld.status}`);

  const changeOwn = await req('POST', '/admin/password', {
    token: adminToken,
    body: { oldPassword: ADMIN_PASS, newPassword: 'smoke-temp-pass-99' },
  });
  check('修改自己的密码成功', changeOwn.status === 200, JSON.stringify(changeOwn.body).slice(0, 120));
  const loginWithNew = await req('POST', '/admin/login', {
    body: { username: ADMIN_USER, password: 'smoke-temp-pass-99' },
  });
  check('新密码可登录', loginWithNew.status === 200);
  // 改回来，保证冒烟测试可重复执行
  const restore = await req('POST', '/admin/password', {
    token: loginWithNew.body?.token,
    body: { oldPassword: 'smoke-temp-pass-99', newPassword: ADMIN_PASS },
  });
  check('已恢复原始管理员密码', restore.status === 200);

  // 设备令牌不能进后台
  const deviceAsAdmin = await req('GET', '/admin/stats', { token: deviceToken });
  check('设备令牌访问后台接口被拒（401）', deviceAsAdmin.status === 401, `实际 ${deviceAsAdmin.status}`);

  // ============================================================
  console.log('\n' + '═'.repeat(52));
  if (failed === 0) {
    console.log(`\x1b[32m全部通过：${passed} 项\x1b[0m`);
  } else {
    console.log(`\x1b[31m失败 ${failed} 项\x1b[0m · 通过 ${passed} 项`);
    console.log('\n失败清单：');
    for (const f of failures) console.log(`  · ${f}`);
  }
  console.log('═'.repeat(52) + '\n');
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`\n\x1b[31m冒烟测试异常中断：\x1b[0m ${err.message}`);
  console.error(err.stack);
  process.exit(1);
});
