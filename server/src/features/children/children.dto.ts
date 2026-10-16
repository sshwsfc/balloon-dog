import { z } from 'zod';

/**
 * 孩子档案与今日任务的入参校验（规划 §5.2）。
 *
 * 这里的边界值都写成人话，因为 `errorHandler` 会把第一条 zod 错误直接变成
 * 前端可展示的 `message` —— 「String must contain at most 20 character(s)」
 * 这种句子是给开发者看的，不是给家长看的。
 */

/** 出生年份：太早的年份多半是打错了，未来的年份一定是打错了。 */
const MIN_BIRTH_YEAR = 1990;

export const createChildSchema = z.object({
  name: z.string().trim().min(1, '请填写孩子的称呼').max(20, '称呼最多 20 个字'),
  // 出生「年份」而不是年龄：年龄每年都会过期，年份不会（见 schema.prisma 的注释）
  birthYear: z
    .number()
    .int()
    .min(MIN_BIRTH_YEAR, `出生年份看起来不对（应不早于 ${MIN_BIRTH_YEAR} 年）`)
    .max(new Date().getFullYear(), '出生年份不能是未来')
    .optional(),
  school: z.string().trim().max(40, '学校最多 40 个字').optional(),
  avatar: z.string().max(500).optional(),
});

export const updateChildSchema = createChildSchema
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: '没有要修改的内容' });

export const childIdSchema = z.object({ childId: z.string().min(1) });

/**
 * 把设备挂到孩子档案下（整组替换，不是增量）。
 *
 * 整组替换是有意的：界面上勾选框的语义就是「这个孩子现在有哪几台设备」，
 * 增量接口会让「取消勾选」变成一个额外的、容易漏掉的请求。
 */
export const assignDevicesSchema = z.object({
  deviceIds: z.array(z.string().min(1)).max(10, '一个孩子最多挂 10 台设备'),
});

/** 任务归属日：`YYYY-MM-DD` 字符串，不是时刻（见 schema.prisma 的注释）。 */
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export const listTasksQuerySchema = z.object({
  date: z.string().regex(DATE_PATTERN, '日期格式应为 YYYY-MM-DD').optional(),
});

export const createTaskSchema = z.object({
  title: z.string().trim().min(1, '请填写任务内容').max(50, '任务最多 50 个字'),
  date: z.string().regex(DATE_PATTERN, '日期格式应为 YYYY-MM-DD').optional(),
});

export const updateTaskSchema = z
  .object({
    title: z.string().trim().min(1, '请填写任务内容').max(50, '任务最多 50 个字').optional(),
    done: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: '没有要修改的内容' });

export const taskIdSchema = z.object({ taskId: z.string().min(1) });

/** 设备端勾掉任务。 */
export const agentTaskDoneSchema = z.object({ done: z.boolean() });
