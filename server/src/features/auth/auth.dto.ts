import { z } from 'zod';

/** 国内手机号 */
const phoneSchema = z
  .string()
  .trim()
  .regex(/^1[3-9]\d{9}$/, '请输入正确的手机号');

/** 6 位数字验证码 */
const codeSchema = z
  .string()
  .trim()
  .regex(/^\d{6}$/, '验证码为 6 位数字');

/** 发送验证码：purpose 决定验证码用途，避免注册码被拿去登录。 */
export const sendCodeSchema = z.object({
  phone: phoneSchema,
  purpose: z.enum(['register', 'login', 'bind']).default('register'),
});

/** 注册：密码 + 短信验证码，两者都必填（mock 版要求填验证码却从不校验，这里是真的校验）。 */
export const registerSchema = z.object({
  phone: phoneSchema,
  password: z
    .string()
    .min(6, '密码至少 6 位')
    .max(64, '密码最多 64 位'),
  code: codeSchema,
  nickname: z.string().trim().max(30).optional(),
});

/** 登录：支持手机号或邮箱（前端传 phone 即可，identifier 兼容邮箱登录）。 */
export const loginSchema = z
  .object({
    phone: phoneSchema.optional(),
    identifier: z.string().trim().min(1).optional(),
    password: z.string().min(1, '请输入密码'),
  })
  .refine((v) => Boolean(v.phone || v.identifier), {
    message: '请输入手机号或邮箱',
    path: ['phone'],
  });

/** 短信验证码登录（无密码） */
export const smsLoginSchema = z.object({
  phone: phoneSchema,
  code: codeSchema,
});

/** 微信扫码轮询 */
export const wechatStateSchema = z.object({
  state: z.string().trim().min(1, '缺少 state'),
});

/** 联调模式模拟扫码 */
export const wechatDevScanSchema = z.object({
  state: z.string().trim().min(1, '缺少 state'),
});

/** 更新资料 */
export const updateProfileSchema = z.object({
  name: z.string().trim().min(1, '昵称不能为空').max(30).optional(),
  nickname: z.string().trim().min(1).max(30).optional(),
  email: z.string().trim().email('邮箱格式不正确').optional().or(z.literal('')),
  avatar: z.string().trim().max(500).optional(),
});

/** 修改密码 */
export const changePasswordSchema = z.object({
  oldPassword: z.string().min(1, '请输入原密码'),
  newPassword: z.string().min(6, '新密码至少 6 位').max(64),
});

/** 绑定/换绑手机号（微信注册的账号补手机号，或家长换号） */
export const bindPhoneSchema = z.object({
  phone: phoneSchema,
  code: codeSchema,
});
