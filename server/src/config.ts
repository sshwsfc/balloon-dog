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
  CORS_ORIGIN: z.string().default('http://localhost:5173'),
  CLIENT_URL: z.string().default('http://localhost:5173'),

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

  // ---- 对外基址 ----
  PUBLIC_BASE_URL: z.string().default(''),

  // ---- 媒体 ----
  MEDIA_DIR: z.string().default('uploads'),
  MEDIA_MAX_SIZE_MB: z.coerce.number().positive().default(10),
  MEDIA_URL_TTL_SECONDS: z.coerce.number().int().positive().default(600),

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

/** 对外访问基址：优先 PUBLIC_BASE_URL，否则回落到本地地址。 */
export function publicBaseUrl(): string {
  return config.PUBLIC_BASE_URL.trim() || `http://localhost:${config.PORT}`;
}
