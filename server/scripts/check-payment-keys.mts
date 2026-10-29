/**
 * 支付密钥自检 —— 在**部署前**回答一个渠道目录回答不了的问题：
 * 「环境变量配了，但密钥到底能不能用？」
 *
 * 为什么需要它：渠道目录（`GET /api/payments/catalog`）只看变量有没有值，
 * 所以「裸 base64 私钥」这种配置会一路显示 `configured: true`，直到家长点支付
 * 那一刻才在 `crypto.sign()` 上炸成 500。这个脚本把密钥真的读一遍、真的签一次、
 * 再验回来，把这类错误提前到部署阶段。
 *
 * 用法（在 `server/` 下）：
 *   npm run check:payment-keys                # 只做离线校验
 *   npm run check:payment-keys -- --network    # 额外用支付宝网关验一次真实权限
 *
 * 退出码：0 通过 / 1 有硬错误（密钥坏、签名对不上）。
 * 「渠道未签约」不算硬错误 —— 那是账号侧的事，脚本只把它标成 WARN。
 */
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { keyObject, gmt8Timestamp } from '../src/features/payments/payments.keys';

// `--env-file=deploy/.env.prod`：部署前用生产变量跑，不必先导出到 shell
const envFile = process.argv.find((arg) => arg.startsWith('--env-file='))?.slice('--env-file='.length);
if (envFile) {
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}

let failures = 0;
let warnings = 0;

function pass(message: string): void {
  console.log(`  ✓ ${message}`);
}

function fail(message: string): void {
  failures += 1;
  console.log(`  ✗ ${message}`);
}

function warn(message: string): void {
  warnings += 1;
  console.log(`  ! ${message}`);
}

/** 把 PEM 压成一行（环境变量里常见写法），用来验证两种形态都能解析。 */
function oneLine(pem: string): string {
  return pem.replace(/\n/g, '\\n');
}

function checkWechat(): void {
  const raw = process.env.WECHAT_PAY_PRIVATE_KEY ?? '';
  if (!raw) {
    warn('微信支付私钥未配置（WECHAT_PAY_PRIVATE_KEY），跳过');
    return;
  }
  let key: crypto.KeyObject | null = null;
  try {
    key = keyObject(raw, 'private');
    pass(`微信支付私钥可解析（${raw.includes('BEGIN') ? 'PEM' : '裸 base64'}）`);
  } catch (error) {
    fail(`微信支付私钥解析失败：${String(error).slice(0, 140)}`);
    return;
  }
  try {
    keyObject(oneLine(raw), 'private');
    pass('微信支付私钥的单行（\\n 转义）写法也可解析');
  } catch (error) {
    fail(`微信支付私钥单行写法解析失败：${String(error).slice(0, 140)}`);
  }
  const message = 'probe\ntimestamp\nnonce\nbody\n';
  const signature = crypto.sign('RSA-SHA256', Buffer.from(message, 'utf8'), key).toString('base64');
  pass('微信支付私钥能签名（RSA-SHA256）');
  if (signature.length < 100) fail('微信签名长度异常，私钥可能不是 RSA 2048');
  else pass(`签名长度合理（${signature.length} 字符）`);

  // 验签材料：公钥模式（微信支付公钥）优先，平台证书回退 —— 两者至少要有其一，
  // 否则回调一律验不过，家长付了钱订单也不会变成已支付。
  const pubRaw = process.env.WECHAT_PAY_PLATFORM_PUBLIC_KEY ?? '';
  const certRaw = process.env.WECHAT_PAY_PLATFORM_CERT ?? '';
  if (pubRaw) {
    try {
      keyObject(pubRaw, 'public');
      const kid = process.env.WECHAT_PAY_PLATFORM_PUBLIC_KEY_ID ?? '';
      if (kid) pass(`微信支付公钥可解析，公钥 ID：${kid}`);
      else warn('微信支付公钥已配，但 WECHAT_PAY_PLATFORM_PUBLIC_KEY_ID 为空（回调要靠它匹配序列号）');
    } catch (error) {
      fail(`微信支付公钥解析失败：${String(error).slice(0, 140)}`);
    }
  } else if (certRaw) {
    pass('使用平台证书验签（WECHAT_PAY_PLATFORM_CERT）');
  } else {
    fail('既没有微信支付公钥（WECHAT_PAY_PLATFORM_PUBLIC_KEY）也没有平台证书 —— 支付回调无法验签');
  }
}

function alipayContent(params: Record<string, string>): string {
  return Object.keys(params)
    .filter((k) => k !== 'sign' && params[k] !== '')
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join('&');
}

async function checkAlipay(network: boolean): Promise<void> {
  const privateRaw = process.env.ALIPAY_PRIVATE_KEY ?? '';
  const publicRaw = process.env.ALIPAY_PUBLIC_KEY ?? '';
  const appId = process.env.ALIPAY_APP_ID ?? '';
  if (!privateRaw || !publicRaw || !appId) {
    warn('支付宝应用号 / 私钥 / 公钥未配齐，跳过');
    return;
  }

  let privateKey: crypto.KeyObject;
  try {
    privateKey = keyObject(privateRaw, 'private');
    pass(`支付宝应用私钥可解析（${privateRaw.includes('BEGIN') ? 'PEM' : '裸 base64'}）`);
  } catch (error) {
    fail(`支付宝应用私钥解析失败：${String(error).slice(0, 140)}`);
    return;
  }

  let publicKey: crypto.KeyObject;
  try {
    publicKey = keyObject(publicRaw, 'public');
    pass(`支付宝公钥可解析（${publicRaw.includes('BEGIN') ? 'PEM' : '裸 base64'}）`);
  } catch (error) {
    fail(`支付宝公钥解析失败：${String(error).slice(0, 140)}`);
    return;
  }

  // 自签自验：应用私钥签出来的东西，**应用公钥**验不过（那是应用公钥，不是支付宝公钥），
  // 所以这里只用私钥签名 + 校验签名长度；公钥能不能用留给网关侧的验签去证明。
  const params: Record<string, string> = {
    app_id: appId,
    method: 'alipay.trade.wap.pay',
    charset: 'utf-8',
    sign_type: 'RSA2',
    timestamp: gmt8Timestamp(),
    version: '1.0',
    biz_content: '{"out_trade_no":"PROBE","total_amount":"0.01","subject":"probe"}',
  };
  const content = alipayContent(params);
  const signature = crypto.sign('RSA-SHA256', Buffer.from(content, 'utf8'), privateKey).toString('base64');
  if (crypto.verify('RSA-SHA256', Buffer.from(content, 'utf8'), publicKey, Buffer.from(signature, 'base64'))) {
    warn('支付宝公钥恰好能验出应用私钥的签名 —— 说明 ALIPAY_PUBLIC_KEY 填的是**应用公钥**，不是支付宝公钥');
  } else {
    pass('签名串（含 sign_type）可用应用私钥签名，且不能用配置里的公钥验回（符合预期）');
  }

  const stamp = gmt8Timestamp();
  const expected = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 19).replace('T', ' ');
  if (stamp.slice(0, 13) === expected.slice(0, 13)) pass(`支付宝 timestamp 是东八区：${stamp}`);
  else fail(`支付宝 timestamp 不是东八区：${stamp}（应为 ${expected}）`);

  if (!network) {
    pass('跳过网关权限探测（加 --network 才会真的问一次支付宝）');
    return;
  }

  try {
    await probeGateway();
  } catch (error: unknown) {
    warn(`网关探测未完成：${String(error).slice(0, 120)}`);
  }

  try {
    await probeCashier();
  } catch (error: unknown) {
    warn(`收银台探测未完成：${String(error).slice(0, 120)}`);
  }
}

/**
 * 用 `alipay.trade.query` 问一次不存在的订单：这是**没有副作用**的取证方式。
 * 三种可能的结果分别对应三种运维结论。
 */
async function probeGateway(): Promise<void> {
  const gateway = process.env.ALIPAY_GATEWAY || 'https://openapi.alipay.com/gateway.do';
  const params: Record<string, string> = {
    app_id: process.env.ALIPAY_APP_ID ?? '',
    method: 'alipay.trade.query',
    charset: 'utf-8',
    sign_type: 'RSA2',
    timestamp: gmt8Timestamp(),
    version: '1.0',
    biz_content: '{"out_trade_no":"PROBE_NOT_EXIST"}',
  };
  const content = alipayContent(params);
  params.sign = crypto
    .sign('RSA-SHA256', Buffer.from(content, 'utf8'), keyObject(process.env.ALIPAY_PRIVATE_KEY ?? '', 'private'))
    .toString('base64');
  const response = await fetch(gateway, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8' },
    body: new URLSearchParams(params).toString(),
  });
  const text = await response.text();
  if (response.status >= 400) {
    fail(`网关返回 ${response.status}：${text.slice(0, 140)}`);
    return;
  }
  let node: { code?: string; sub_code?: string; sub_msg?: string; msg?: string } = {};
  try {
    node = (JSON.parse(text) as { alipay_trade_query_response?: typeof node }).alipay_trade_query_response ?? {};
  } catch {
    warn(`网关返回的不是 JSON：${text.slice(0, 120)}`);
    return;
  }
  if (node.sub_code === 'ACQ.TRADE_NOT_EXIST') {
    pass('网关接受签名与时间戳（查询不存在的订单返回 ACQ.TRADE_NOT_EXIST，属预期）');
    return;
  }
  if (node.code === '10000') {
    pass('网关接受签名（查询成功）');
    return;
  }
  const reason = String(node.sub_code ?? node.code ?? '未知');
  if (/insufficient-isv-permissions|ACCESS_FORBIDDEN|isv\.invalid|invalid-signature/i.test(reason + (node.sub_msg ?? ''))) {
    warn(`网关拒绝：${reason} —— 商户平台未签约支付产品 / 应用未获接口授权（账号侧处理）`);
    return;
  }
  fail(`网关拒绝：${reason} ${node.sub_msg ?? ''}`);
}

/**
 * 收银台预检：把 `wap.pay` 的跳转链接自己取一次。
 *
 * 这一步和网关查询是两件不同的事 —— `alipay.trade.query` 只要签名对就能问，
 * 而**跳收银台**还要「应用签约了该产品」或「商户授权给应用」。
 * 所以查询通过、付款却报错是很常见的组合，必须单独探测。
 */
async function probeCashier(): Promise<void> {
  const gateway = process.env.ALIPAY_GATEWAY || 'https://openapi.alipay.com/gateway.do';
  const params: Record<string, string> = {
    app_id: process.env.ALIPAY_APP_ID ?? '',
    method: 'alipay.trade.wap.pay',
    charset: 'utf-8',
    sign_type: 'RSA2',
    timestamp: gmt8Timestamp(),
    version: '1.0',
    biz_content: '{"out_trade_no":"PROBE_NOT_EXIST","total_amount":"0.01","subject":"probe","product_code":"QUICK_WAP_WAY"}',
  };
  if (process.env.ALIPAY_APP_AUTH_TOKEN) params.app_auth_token = process.env.ALIPAY_APP_AUTH_TOKEN;
  const content = alipayContent(params);
  params.sign = crypto
    .sign('RSA-SHA256', Buffer.from(content, 'utf8'), keyObject(process.env.ALIPAY_PRIVATE_KEY ?? '', 'private'))
    .toString('base64');
  const url = `${gateway}?${new URLSearchParams(params).toString()}`;
  const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(8000) });
  const location = response.headers.get('location') ?? '';
  const text = response.status >= 400 ? '' : await response.text();
  const tokenHint = process.env.ALIPAY_APP_AUTH_TOKEN
    ? '已配置 ALIPAY_APP_AUTH_TOKEN'
    : '未配置 ALIPAY_APP_AUTH_TOKEN';
  if (location.includes('appAssign.htm')) {
    warn(`收银台跳到了应用授权页 —— 这是第三方应用且商户没授权（${tokenHint}）`);
    return;
  }
  if (/insufficient-isv-permissions|ISV权限不足/.test(text)) {
    warn(`收银台拒绝：未签约「手机网站支付」（insufficient-isv-permissions，${tokenHint}）`);
    return;
  }
  if (/invalid-signature/.test(text)) {
    fail('收银台拒绝：invalid-signature（签名规则有问题，看 ALIPAY_PUBLIC_KEY / sign_type）');
    return;
  }
  if (response.status >= 400) {
    warn(`收银台探测返回 ${response.status}，未能判定权限状态`);
    return;
  }
  pass('收银台可以打开（应用已具备该支付产品的权限）');
}

const network = process.argv.includes('--network');
console.log('支付密钥自检');
checkWechat();
await checkAlipay(network);
console.log(
  failures === 0
    ? `结果：通过${warnings > 0 ? `（${warnings} 条提醒）` : ''}`
    : `结果：${failures} 项失败${warnings > 0 ? `，${warnings} 条提醒` : ''}`,
);
process.exitCode = failures === 0 ? 0 : 1;
