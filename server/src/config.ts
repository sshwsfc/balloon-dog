import { z } from 'zod';

/**
 * 集中式、强类型、启动即校验（fail-fast）的配置。
 * 任何缺失/非法的变量都会在进程启动阶段抛错，避免运行到某个接口才暴露问题。
 */
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL 不能为空'),

  // ---- 认证 ----
  JWT_SECRET: z.string().min(32, 'JWT_SECRET 至少 32 位，生产环境请用随机长字符串'),
  ACCESS_TOKEN_TTL: z.string().default('7d'),
  DEVICE_TOKEN_TTL: z.string().default('365d'),
  ADMIN_TOKEN_TTL: z.string().default('12h'),

  // ---- 跨域与前端地址 ----
  // 家长端有两个端口（见 vite.config.ts）：对外站点 2727（vite preview）、本机开发 5173
  // （vite dev，被占用时 Vite 会自动 +1）。CORS 两个都放行；CLIENT_URL（登录回跳）用对外的那个。
  CORS_ORIGIN: z
    .string()
    .default(
      'http://localhost:2727,http://127.0.0.1:2727,http://localhost:5173,http://127.0.0.1:5173',
    ),
  CLIENT_URL: z.string().default('http://localhost:2727'),

  // ---- 限流 ----
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(300),
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(30),
  // 后台登录失败尝试的每分钟上限（成功登录不计入）
  ADMIN_LOGIN_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(10),

  // ---- 短信验证码 ----
  SMS_CODE_TTL_SECONDS: z.coerce.number().int().positive().default(300),
  SMS_RESEND_INTERVAL_SECONDS: z.coerce.number().int().positive().default(60),
  SMS_DAILY_LIMIT: z.coerce.number().int().positive().default(10),
  SMS_MAX_VERIFY_ATTEMPTS: z.coerce.number().int().positive().default(5),
  TENCENTCLOUD_SECRET_ID: z.string().optional(),
  TENCENTCLOUD_SECRET_KEY: z.string().optional(),
  SMS_SDK_APP_ID: z.string().optional(),
  SMS_TEMPLATE_ID: z.string().optional(),
  SMS_SIGN_NAME: z.string().optional(),
  SMS_REGION: z.string().default('ap-beijing'),

  // ---- 微信登录 ----
  WECHAT_LOGIN_APP_ID: z.string().optional(),
  WECHAT_LOGIN_APP_SECRET: z.string().optional(),
  WECHAT_LOGIN_REDIRECT_URI: z.string().optional(),

  // ---- 微信服务号模板消息（推送通道，规划 §2.1 第二档）----
  /**
   * 模板消息的模板 ID：在公众号后台「模板消息」里建一个模板后填进来。
   * **字段名（first / keyword1 / …）是模板作者定的**，本项目按
   * `first`=标题、`keyword1`=标题、`keyword2`=正文、`remark`=提示的约定发送，
   * 建模板时要对上（对不上微信会回 47003，投递记录里会留原文）。
   */
  WECHAT_TEMPLATE_ID: z.string().optional(),
  /**
   * 微信开放接口的基址。默认官方 `https://api.weixin.qq.com`；
   * 本地联调指向 `server/scripts/mock-wechat-server.mjs`，这样
   * 「取 access_token → 发模板消息 → 令牌过期后重试」整条路径**不需要真公众号**就能验证。
   */
  WECHAT_API_BASE_URL: z.string().optional(),
  /** 模板消息点开后的跳转基址；不填就复用 CLIENT_URL / PUBLIC_BASE_URL。 */
  WECHAT_TEMPLATE_LINK_BASE: z.string().optional(),

  // ---- 对外基址 ----
  PUBLIC_BASE_URL: z.string().default(''),

  // ---- 媒体 ----
  MEDIA_DIR: z.string().default('uploads'),
  MEDIA_MAX_SIZE_MB: z.coerce.number().positive().default(10),
  MEDIA_URL_TTL_SECONDS: z.coerce.number().int().positive().default(600),

  // ---- 会员 / 支付 ----
  /**
   * 是否启用内置的**模拟支付**。
   *
   * 默认 true：本项目还没有接入真实支付宝/微信渠道，先跑通「下单 → 支付 → 会员生效」
   * 的完整链路。设成 false 时支付接口会拒绝服务（503）—— 这是故意留的一道闸：
   * 避免上线后还以为在跑真支付，其实仍然是模拟。
   */
  MEMBERSHIP_MOCK_PAY: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  /** 订单存活时间（秒），过期订单不能再支付 */
  MEMBERSHIP_ORDER_TTL_SECONDS: z.coerce.number().int().positive().default(1800),
  /** 连续包月的宽限期（天）：扣款失败后仍保留会员身份的天数 */
  MEMBERSHIP_RENEW_GRACE_DAYS: z.coerce.number().int().positive().default(31),

  // ---- 真实支付渠道（规划 §5.4）----
  //
  // 这一组全部是**空的配置位**：没填，家长端就如实显示「支付渠道未配置」并列出缺哪几个变量，
  // 而不是给一个点了没反应的按钮。填齐某一组之后，该渠道才会出现在可支付列表里。
  // 订单、会员生效、退款、发票的逻辑与渠道无关（见 features/payments 与 membership.service），
  // 换渠道只影响这一层的签名与报文。
  /** 微信支付 v3 商户号 */
  WECHAT_PAY_MCH_ID: z.string().default(''),
  /** 微信支付 v3 绑定的 appid（公众号 / 小程序） */
  WECHAT_PAY_APP_ID: z.string().default(''),
  /** 微信支付 v3 APIv3 密钥（32 位，用于回调报文 AES-256-GCM 解密） */
  WECHAT_PAY_API_V3_KEY: z.string().default(''),
  /** 商户 API 证书序列号 */
  WECHAT_PAY_SERIAL_NO: z.string().default(''),
  /** 商户 API 私钥（PEM，可整段粘贴；换行也可以写成 \n） */
  WECHAT_PAY_PRIVATE_KEY: z.string().default(''),
  /**
   * 微信支付平台证书（PEM）。用于**校验回调签名** —— 没有它就等于任何人都能伪造
   * 「已支付」回调，所以宁可让回调 503，也不放过未验签的通知。
   */
  WECHAT_PAY_PLATFORM_CERT: z.string().default(''),
  /** 支付结果通知地址（必须 https 且公网可达） */
  WECHAT_PAY_NOTIFY_URL: z.string().default(''),
  /** 支付宝 appid */
  ALIPAY_APP_ID: z.string().default(''),
  /** 支付宝应用私钥（PEM，RSA2 签名） */
  ALIPAY_PRIVATE_KEY: z.string().default(''),
  /** 支付宝公钥（PEM，用于校验回调签名） */
  ALIPAY_PUBLIC_KEY: z.string().default(''),
  ALIPAY_NOTIFY_URL: z.string().default(''),
  ALIPAY_GATEWAY: z.string().default('https://openapi.alipay.com/gateway.do'),
  /**
   * **仅用于自动化测试**的假支付渠道：不联网、不签名，把「预支付载荷」原样回给调用方，
   * 回调签名简单地取 md5。生产环境（NODE_ENV=production）下会被硬拒 ——
   * 一个能被伪造的支付渠道绝不能因为环境变量写错就上线。
   */
  PAYMENT_FAKE_PROVIDER: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  /**
   * 家长自助退款的窗口（天）。超过窗口就只能走客服，后台仍然可以发起退款 ——
   * 自助窗口是给「刚买错了」用的，不是给「用了一个月想退」用的。
   */
  /** 客服联系方式（家长端工单页展示）。空 = 还没配，界面如实留白 */
  SUPPORT_CONTACT: z.string().default(''),
  PAYMENT_REFUND_WINDOW_DAYS: z.coerce.number().int().positive().default(7),

  // ---- 屏幕行为 AI 洞察 ----
  // 截屏包（10 张低分辨率 JPEG 的 zip）通常 200~400 KB，给 8 MB 足够宽松
  SCREEN_BATCH_MAX_SIZE_MB: z.coerce.number().positive().default(8),
  /** 一个包里最多接受多少张帧，防止构造一个大包打爆磁盘 */
  SCREEN_BATCH_MAX_FRAMES: z.coerce.number().int().positive().default(30),
  /** 帧图保留天数（配置里还能按设备覆盖，这里是不设时的默认值） */
  SCREEN_FRAME_RETENTION_DAYS: z.coerce.number().int().positive().default(7),

  /**
   * AI 视觉分析。任何 OpenAI 兼容的 /v1 都可以：DeepSeek、DashScope 兼容模式、
   * 智谱 GLM-4V、本地 Ollama/vLLM 等。
   *
   * <b>没有配置 AI_API_KEY 时不会伪造分析结果</b>：批次会被标成 skipped，
   * 家长端明确显示「未配置 AI」。这是本工程一以贯之的原则 ——
   * 宁可说不知道，也不给一个看起来像结论的东西。
   */
  AI_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  AI_BASE_URL: z.string().default(''),
  AI_API_KEY: z.string().default(''),
  AI_VISION_MODEL: z.string().default(''),
  AI_TEXT_MODEL: z.string().default(''),
  AI_TIMEOUT_MS: z.coerce.number().int().positive().default(90_000),
  /** 每个包最多送几张给模型（成本控制，均匀采样） */
  AI_MAX_FRAMES_PER_BATCH: z.coerce.number().int().positive().default(6),
  /**
   * 未配置 AI 时是否启用「启发式降级分析」。
   *
   * 它<b>不是 AI</b>：只根据设备端上报的前台包名做分类与时长估算，
   * 结果里 provider='heuristic'，家长端会明确标注「启发式推断，非 AI 分析」。
   * 开着它的意义是让整条链路在没有 key 的环境里也能被完整验证。
   */
  AI_HEURISTIC_FALLBACK: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),

  // ---- 设备指令队列 ----
  COMMAND_TTL_SECONDS: z.coerce.number().int().positive().default(300),
  COMMAND_SWEEP_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),

  // ---- 日志 ----
  LOG_LEVEL: z.string().optional(),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  // 这里必须用 console：logger 自身依赖 config，此刻还不能用
  process.stderr.write(
    `❌ 环境变量校验失败：${JSON.stringify(parsed.error.flatten().fieldErrors, null, 2)}\n`,
  );
  throw new Error('Invalid environment configuration');
}

export const config = parsed.data;
export type AppConfig = typeof config;

/** 是否配置了真实腾讯云短信通道（缺一即视为未配置）。 */
export const smsConfigured = Boolean(
  config.TENCENTCLOUD_SECRET_ID &&
    config.TENCENTCLOUD_SECRET_KEY &&
    config.SMS_SDK_APP_ID &&
    config.SMS_TEMPLATE_ID &&
    config.SMS_SIGN_NAME,
);

/** 是否配置了真实微信登录（AppID + AppSecret 齐备）。 */
export const wechatLoginConfigured = Boolean(
  config.WECHAT_LOGIN_APP_ID && config.WECHAT_LOGIN_APP_SECRET,
);

/**
 * 是否配置了微信服务号模板消息（AppID + AppSecret + 模板 ID 三者齐备）。
 *
 * 与 `wechatLoginConfigured` 分开判断：能用微信扫码登录（网页授权）
 * 不等于能发模板消息（公众号必须建过模板）。家长端的偏好页显示的是**这一个**，
 * 否则会出现「界面说能用、点了却发不出去」。
 */
export const wechatTemplateConfigured = Boolean(
  config.WECHAT_LOGIN_APP_ID && config.WECHAT_LOGIN_APP_SECRET && config.WECHAT_TEMPLATE_ID,
);

/**
 * 微信开放接口基址（去尾部斜杠）。
 *
 * 抽成函数而不是常量：`config` 在测试/联调里可能被改，读的地方应该拿到当前值。
 */
export function wechatApiBase(): string {
  const raw = (config.WECHAT_API_BASE_URL || '').trim() || 'https://api.weixin.qq.com';
  return raw.replace(/\/+$/, '');
}

/** 模板消息点开后要跳到哪（家长端消息中心）。 */
export function wechatTemplateLinkBase(): string {
  const configured = (config.WECHAT_TEMPLATE_LINK_BASE || '').trim();
  if (configured) return configured.replace(/\/+$/, '');
  const client = (config.CLIENT_URL || '').trim();
  if (client) return client.replace(/\/+$/, '');
  return publicBaseUrl();
}

/** 对外访问基址：优先 PUBLIC_BASE_URL，否则回落到本地地址。 */
export function publicBaseUrl(): string {
  return config.PUBLIC_BASE_URL.trim() || `http://localhost:${config.PORT}`;
}
