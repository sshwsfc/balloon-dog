import { z } from 'zod';
import { COMMAND_STATUSES, COMMAND_TYPES } from '../devices/devices.constants';

/** 通用分页 */
const pageSchema = {
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().max(200).optional(),
};

/** 通用搜索词（去空白；空串视为不传） */
const qSchema = z
  .string()
  .trim()
  .optional()
  .transform((v) => (v === '' ? undefined : v));

// ============================================================
// 认证
// ============================================================

export const adminLoginSchema = z.object({
  username: z.string().trim().min(1, '请输入管理员账号').max(50),
  password: z.string().min(1, '请输入密码').max(128),
});

export const adminChangeOwnPasswordSchema = z.object({
  oldPassword: z.string().min(1, '请输入原密码'),
  newPassword: z.string().min(8, '新密码至少 8 位').max(128),
});

// ============================================================
// 管理员账号管理
// ============================================================

export const createAdminSchema = z.object({
  username: z
    .string()
    .trim()
    .min(3, '账号至少 3 个字符')
    .max(50, '账号最多 50 个字符')
    .regex(/^[a-zA-Z0-9_.-]+$/, '账号只能包含字母、数字、下划线、点和短横线'),
  password: z.string().min(8, '密码至少 8 位').max(128),
  name: z.string().trim().max(30).optional(),
  role: z.enum(['super', 'operator']).default('operator'),
});

export const resetAdminPasswordSchema = z.object({
  password: z.string().min(8, '密码至少 8 位').max(128),
});

export const setAdminStatusSchema = z.object({
  status: z.enum(['active', 'disabled']),
});

// ============================================================
// 数据看板
// ============================================================

export const statsQuerySchema = z.object({
  /** 趋势区间的天数，默认 30 天，最多 180 天 */
  days: z.coerce.number().int().min(7).max(180).default(30),
});

// ============================================================
// 家长用户管理
// ============================================================

export const listUsersQuerySchema = z.object({
  ...pageSchema,
  q: qSchema,
  status: z.enum(['active', 'disabled']).optional(),
});

export const setUserStatusSchema = z.object({
  status: z.enum(['active', 'disabled']),
  /** 禁用原因（会写进操作日志，便于事后追溯） */
  reason: z.string().trim().max(200).optional(),
});

// ============================================================
// 设备管理
// ============================================================

export const listDevicesQuerySchema = z.object({
  ...pageSchema,
  q: qSchema,
  /** bound=true 只看已认领；false 只看待认领 */
  bound: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true')),
  status: z.enum(['online', 'offline']).optional(),
  locked: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true')),
  userId: z.coerce.number().int().positive().optional(),
});

// ============================================================
// 指令监控
// ============================================================

export const listCommandsQuerySchema = z.object({
  ...pageSchema,
  status: z.enum(COMMAND_STATUSES).optional(),
  type: z.enum(COMMAND_TYPES).optional(),
  deviceId: z.string().trim().optional(),
  userId: z.coerce.number().int().positive().optional(),
  /** onlyFailed=true 时只看 failed/expired，用于快速排查 */
  onlyFailed: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
});

// ============================================================
// 题库管理
// ============================================================

export const listQuestionsQuerySchema = z.object({
  ...pageSchema,
  type: z.enum(['english', 'poetry']).optional(),
  grade: z.enum(['grade1', 'grade2', 'grade3', 'grade4', 'grade5', 'grade6']).optional(),
  q: qSchema,
});

const questionFields = {
  type: z.enum(['english', 'poetry']),
  grade: z.enum(['grade1', 'grade2', 'grade3', 'grade4', 'grade5', 'grade6']),
  question: z.string().trim().min(1, '题干不能为空').max(300, '题干过长'),
  options: z.array(z.string().trim().min(1, '选项不能为空')).min(2, '至少 2 个选项').max(8, '最多 8 个选项'),
  correctAnswer: z.coerce.number().int().min(0),
  explanation: z.string().trim().max(500).optional(),
};

export const createQuestionSchema = z
  .object(questionFields)
  .refine((v) => v.correctAnswer < v.options.length, {
    message: '正确答案下标超出选项范围',
    path: ['correctAnswer'],
  });

export const updateQuestionSchema = z
  .object(questionFields)
  .partial()
  .refine(
    (v) => v.correctAnswer === undefined || v.options === undefined || v.correctAnswer < v.options.length,
    { message: '正确答案下标超出选项范围', path: ['correctAnswer'] },
  );

// ============================================================
// 答题记录
// ============================================================

export const listQuizRecordsQuerySchema = z.object({
  ...pageSchema,
  deviceId: z.string().trim().optional(),
  userId: z.coerce.number().int().positive().optional(),
  type: z.enum(['english', 'poetry']).optional(),
  isCorrect: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true')),
});

// ============================================================
// 短信验证码审计
// ============================================================

export const listSmsCodesQuerySchema = z.object({
  ...pageSchema,
  phone: qSchema,
  purpose: z.enum(['register', 'login', 'bind']).optional(),
  /** state=pending 未使用 | consumed 已使用 | expired 已过期 */
  state: z.enum(['pending', 'consumed', 'expired']).optional(),
});

// ============================================================
// 操作日志
// ============================================================

export const listLogsQuerySchema = z.object({
  ...pageSchema,
  adminId: z.coerce.number().int().positive().optional(),
  action: qSchema,
  status: z.coerce.number().int().min(100).max(599).optional(),
  /** 只看失败操作（排查「谁做了什么但没成功」） */
  onlyFailed: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
});
