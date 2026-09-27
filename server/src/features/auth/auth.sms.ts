import crypto from 'node:crypto';
// 注意：该包在 CJS 下设置了 __esModule 却没有 default 导出，
// 必须用命名空间导入（`import x from` 会拿到 undefined）。
import * as tencentcloud from 'tencentcloud-sdk-nodejs-sms';
import { config, smsConfigured } from '../../config';
import { logger } from '../../logger';
import { prisma } from '../../prisma';
import { AppError, BadRequestError, ServiceUnavailableError, TooManyRequestsError } from '../../errors';

/**
 * 短信验证码服务。
 *
 * 与 kesi saas 的差别：验证码与限流状态**落在数据库**（SmsCode 表）而不是内存 Map。
 * 内存方案在多实例部署下会失效（请求被负载均衡打到别的实例就查不到码），
 * 且进程重启即丢失；落库后天然支持多实例，也留下了审计痕迹。
 *
 * 验证码本身不明文存储：用 HMAC-SHA256(JWT_SECRET) 做 keyed hash，
 * 即使数据库泄露也无法反推验证码。
 */

export type SmsPurpose = 'register' | 'login' | 'bind';

const PURPOSE_LABEL: Record<SmsPurpose, string> = {
  register: '注册',
  login: '登录',
  bind: '绑定手机号',
};

/** keyed hash，避免明文存码。 */
function hashCode(phone: string, purpose: SmsPurpose, code: string): string {
  return crypto
    .createHmac('sha256', config.JWT_SECRET)
    .update(`${phone}:${purpose}:${code}`)
    .digest('hex');
}

/** 生成 6 位数字验证码（用 CSPRNG，不要用 Math.random）。 */
function generateCode(): string {
  return crypto.randomInt(0, 1_000_000).toString().padStart(6, '0');
}

/** 国内手机号规范化为 E.164（+86xxxxxxxxxxx）。 */
function toE164(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.startsWith('86') && digits.length === 13) return `+${digits}`;
  return `+86${digits}`;
}

function dayStart(d = new Date()): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

/**
 * 腾讯云短信 SDK 的最小类型契约。
 * SDK 自带的类型在这种「命名空间导入 + 动态构造」的用法下很难直接用，
 * 这里只声明我们真正用到的形状，比 any 更安全也更有自文档性。
 */
interface TencentSendStatus {
  Code?: string;
  Message?: string;
}
interface TencentSendSmsResponse {
  SendStatusSet?: TencentSendStatus[];
}
interface TencentSmsClient {
  SendSms(params: Record<string, unknown>): Promise<TencentSendSmsResponse>;
}
type TencentSmsClientCtor = new (options: {
  credential: { secretId: string; secretKey: string };
  region: string;
  profile: { httpProfile: { endpoint: string } };
}) => TencentSmsClient;

// 腾讯云短信客户端（懒加载单例，避免每次发码都重建）
let smsClient: TencentSmsClient | null = null;
function getSmsClient(): TencentSmsClient {
  if (!smsClient) {
    // 该包在 CJS 下设置了 __esModule 但没有 default 导出，
    // 命名空间导入拿到的形状与 .d.ts 声明不一致，此处按最小契约断言一次。
    const sdk = tencentcloud as unknown as {
      sms: { v20210111: { Client: TencentSmsClientCtor } };
    };
    smsClient = new sdk.sms.v20210111.Client({
      credential: {
        secretId: config.TENCENTCLOUD_SECRET_ID!,
        secretKey: config.TENCENTCLOUD_SECRET_KEY!,
      },
      region: config.SMS_REGION,
      profile: { httpProfile: { endpoint: 'sms.tencentcloudapi.com' } },
    });
  }
  return smsClient;
}

/**
 * 调用腾讯云下发短信。
 * 注意：SDK 调用「成功」不代表短信真的发出 —— 必须检查 SendStatusSet[].Code === 'Ok'，
 * 模板参数不匹配、签名未审核、余额不足等都会以 resolve 的形式返回业务错误码。
 */
async function sendViaTencent(phone: string, code: string): Promise<void> {
  const minutes = Math.max(1, Math.round(config.SMS_CODE_TTL_SECONDS / 60));
  const res = await getSmsClient().SendSms({
    PhoneNumberSet: [toE164(phone)],
    SmsSdkAppId: config.SMS_SDK_APP_ID!,
    SignName: config.SMS_SIGN_NAME!,
    TemplateId: config.SMS_TEMPLATE_ID!,
    // 模板变量：[验证码, 有效分钟数]
    TemplateParamSet: [code, String(minutes)],
  });

  const status = res?.SendStatusSet?.[0];
  if (!status || status.Code !== 'Ok') {
    // 腾讯云错误详情只写日志，不返回给终端用户（避免泄露内部信息）
    logger.error({
      msg: 'sms rejected by tencent',
      phone,
      tencentCode: status?.Code,
      tencentMessage: status?.Message,
    });
    throw new AppError('短信发送失败，请稍后重试', 'SMS_SEND_FAILED', 502);
  }
}

export interface SendCodeResult {
  ttlSeconds: number;
  /** 仅在「未配置真实通道且非生产」的本地联调模式下返回。 */
  devCode?: string;
}

/**
 * 发送验证码。校验顺序：配置检查 → 重发间隔 → 每日上限 → 落库 → 下发。
 */
export async function sendVerificationCode(
  phone: string,
  purpose: SmsPurpose,
): Promise<SendCodeResult> {
  // 生产环境必须配置真实通道：否则会出现「提示已发送、实际没发」的静默故障
  if (!smsConfigured && config.NODE_ENV === 'production') {
    throw new ServiceUnavailableError(
      '短信服务未配置（需 TENCENTCLOUD_SECRET_ID/KEY、SMS_SDK_APP_ID、SMS_TEMPLATE_ID、SMS_SIGN_NAME）',
      'SMS_NOT_CONFIGURED',
    );
  }

  const now = new Date();

  // 1) 重发间隔限流
  const latest = await prisma.smsCode.findFirst({
    where: { phone, purpose },
    orderBy: { createdAt: 'desc' },
  });
  if (latest) {
    const elapsed = now.getTime() - latest.createdAt.getTime();
    const minInterval = config.SMS_RESEND_INTERVAL_SECONDS * 1000;
    if (elapsed < minInterval) {
      const wait = Math.ceil((minInterval - elapsed) / 1000);
      throw new TooManyRequestsError(`发送太频繁，请 ${wait} 秒后再试`);
    }
  }

  // 2) 每日上限（同一手机号 + 同一用途）
  const sentToday = await prisma.smsCode.count({
    where: { phone, purpose, createdAt: { gte: dayStart(now) } },
  });
  if (sentToday >= config.SMS_DAILY_LIMIT) {
    throw new TooManyRequestsError(`今日发送次数已达上限（${config.SMS_DAILY_LIMIT} 次）`);
  }

  const code = generateCode();
  const expiresAt = new Date(now.getTime() + config.SMS_CODE_TTL_SECONDS * 1000);

  const record = await prisma.smsCode.create({
    data: { phone, purpose, codeHash: hashCode(phone, purpose, code), expiresAt },
  });

  // 同手机号同用途的历史未用码作废，避免同时存在多个可用码
  await prisma.smsCode.updateMany({
    where: { phone, purpose, id: { not: record.id }, consumedAt: null },
    data: { consumedAt: now },
  });

  if (smsConfigured) {
    try {
      await sendViaTencent(phone, code);
      logger.info({ msg: 'sms code sent', phone, purpose, ttl: config.SMS_CODE_TTL_SECONDS });
      return { ttlSeconds: config.SMS_CODE_TTL_SECONDS };
    } catch (err) {
      // 下发失败：立刻作废这个码（防止「没发出去但可用」），保留限流计数
      await prisma.smsCode.update({
        where: { id: record.id },
        data: { consumedAt: now },
      });
      logger.error({ msg: 'sms send failed', phone, purpose, error: (err as Error).message });
      throw err instanceof AppError
        ? err
        : new AppError('短信发送失败，请稍后重试', 'SMS_SEND_FAILED', 502);
    }
  }

  // mock 发码（仅非生产）：写入日志并回传，便于本地联调
  logger.info({ msg: 'sms code sent (mock)', phone, purpose, code, ttl: config.SMS_CODE_TTL_SECONDS });
  return { devCode: code, ttlSeconds: config.SMS_CODE_TTL_SECONDS };
}

/**
 * 校验验证码：正确且在有效期内 → 标记消费（一次性）；否则抛错。
 * 错误次数超过 SMS_MAX_VERIFY_ATTEMPTS 直接作废，防暴力枚举（6 位码只有 100 万种组合）。
 */
export async function verifyCode(phone: string, purpose: SmsPurpose, code: string): Promise<void> {
  const record = await prisma.smsCode.findFirst({
    where: { phone, purpose, consumedAt: null },
    orderBy: { createdAt: 'desc' },
  });

  if (!record) {
    throw new BadRequestError(`验证码不存在或已过期，请重新获取`);
  }
  if (record.expiresAt.getTime() < Date.now()) {
    await prisma.smsCode.update({ where: { id: record.id }, data: { consumedAt: new Date() } });
    throw new BadRequestError('验证码已过期，请重新获取');
  }
  if (record.attempts >= config.SMS_MAX_VERIFY_ATTEMPTS) {
    await prisma.smsCode.update({ where: { id: record.id }, data: { consumedAt: new Date() } });
    throw new TooManyRequestsError('验证码错误次数过多，请重新获取');
  }

  const expected = record.codeHash;
  const actual = hashCode(phone, purpose, code.trim());
  // 定长 hex 比较用 timingSafeEqual，避免时序侧信道
  const ok =
    expected.length === actual.length &&
    crypto.timingSafeEqual(Buffer.from(expected, 'utf8'), Buffer.from(actual, 'utf8'));

  if (!ok) {
    await prisma.smsCode.update({
      where: { id: record.id },
      data: { attempts: { increment: 1 } },
    });
    const left = config.SMS_MAX_VERIFY_ATTEMPTS - record.attempts - 1;
    throw new BadRequestError(
      left > 0 ? `验证码错误，还可尝试 ${left} 次` : '验证码错误次数过多，请重新获取',
    );
  }

  await prisma.smsCode.update({ where: { id: record.id }, data: { consumedAt: new Date() } });
  logger.info({ msg: 'sms code verified', phone, purpose: PURPOSE_LABEL[purpose] });
}
