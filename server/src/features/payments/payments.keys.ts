import crypto from 'node:crypto';

/** 环境变量里的 PEM 常常写成一行（\n 转义），两种写法都接受。 */
export function pem(raw: string): string {
  const text = raw.includes('\\n') ? raw.replace(/\\n/g, '\n') : raw;
  return text.trim();
}

/**
 * 把它读成真正的 KeyObject。
 *
 * 微信商户平台导出的私钥是完整 PEM（带 BEGIN/END 头），而支付宝密钥工具导出的
 * 常常**只有裸 base64**（首尾没有 `-----BEGIN … -----`）。直接把它丢给
 * `crypto.sign()` 会抛 `DECODER routines::unsupported` —— 这是生产上「支付宝支付
 * 一点就 500」的真凶：渠道目录只看「配了没有」，看不出密钥根本解析不了。
 * 所以这里两种形态都接受：没有 PEM 头的就按常见编码补上再试。
 */
export function keyObject(raw: string, kind: 'private' | 'public'): crypto.KeyObject {
  const text = raw.includes('\\n') ? raw.replace(/\\n/g, '\n') : raw;
  const body = text.trim();
  if (!body) throw new Error(`缺少${kind === 'private' ? '私钥' : '公钥'}配置`);
  const make = kind === 'private' ? crypto.createPrivateKey : crypto.createPublicKey;
  if (body.includes('-----BEGIN')) {
    try {
      return make(body);
    } catch (error) {
      // PKCS#8 与 PKCS#1 的头不一样，头写错时再按另一种编码试一次
      const bare = body.replace(/-----(BEGIN|END)[^-]+-----/g, '').replace(/\s+/g, '');
      return wrapAndParse(make, bare, kind, String(error));
    }
  }
  return wrapAndParse(make, body.replace(/\s+/g, ''), kind, '密钥没有 PEM 头');
}

function wrapAndParse(
  make: (input: string) => crypto.KeyObject,
  base64: string,
  kind: 'private' | 'public',
  firstError: string,
): crypto.KeyObject {
  const labels =
    kind === 'private' ? ['PRIVATE KEY', 'RSA PRIVATE KEY'] : ['PUBLIC KEY', 'RSA PUBLIC KEY'];
  const wrapped = base64.match(/.{1,64}/g) ?? [];
  let last = firstError;
  for (const label of labels) {
    const candidate = `-----BEGIN ${label}-----\n${wrapped.join('\n')}\n-----END ${label}-----\n`;
    try {
      return make(candidate);
    } catch (error) {
      last = String(error);
    }
  }
  throw new Error(`密钥解析失败（${kind === 'private' ? '私钥' : '公钥'}）：${last.slice(0, 120)}`);
}

/**
 * 支付宝的 `timestamp` 必须是**东八区**的 `yyyy-MM-dd HH:mm:ss`。
 * 用 `toISOString()` 直接切是 UTC，比北京时间慢 8 小时 —— 网关目前对 query 类接口
 * 容错，但对 pay 类接口会因为时间偏差拒绝，所以这里显式按 UTC+8 生成。
 */
export function gmt8Timestamp(now: Date = new Date()): string {
  const shifted = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  return shifted.toISOString().slice(0, 19).replace('T', ' ');
}

