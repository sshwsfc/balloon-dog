import { z } from 'zod';

/**
 * 定时锁屏 / 定时解锁时间表的入参校验。
 *
 * 时间一律用「从 00:00 起的分钟数」表示，而不是 "22:00" 这种字符串：
 *  - 设备端要做「现在处于哪个时段」的逐分钟求值，整数比较最不容易出错；
 *  - 跨天（22:00 → 次日 07:00）用 endMinute < startMinute 直接表达，
 *    不需要额外字段，也不需要处理时区字符串解析。
 */

/** 与 JS Date.getDay() 一致：0=周日 … 6=周六。 */
export const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6] as const;

const minuteOfDay = z.coerce.number().int().min(0, '时间不能早于 00:00').max(1439);
/** 1440 表示当天 24:00（即覆盖到午夜），因此比 start 多一个取值。 */
const minuteEndOfDay = z.coerce.number().int().min(1, '结束时间不能是 00:00').max(1440);

export const createScheduleSchema = z
  .object({
    name: z.string().trim().max(30, '名称最多 30 个字').default(''),
    action: z.enum(['lock', 'unlock'], { required_error: '请选择动作类型' }),
    daysOfWeek: z
      .array(z.coerce.number().int().min(0).max(6))
      .min(1, '请至少选择一天')
      .max(7),
    startMinute: minuteOfDay,
    endMinute: minuteEndOfDay,
    enabled: z.boolean().default(true),
  })
  .refine((v) => v.startMinute !== v.endMinute, {
    // start === end 是零长度时段，几乎总是用户填错（想表达「全天」应该用 0 → 1440）
    message: '开始时间与结束时间不能相同（全天请填 00:00 → 24:00）',
    path: ['endMinute'],
  });

export const updateScheduleSchema = z
  .object({
    name: z.string().trim().max(30).optional(),
    action: z.enum(['lock', 'unlock']).optional(),
    daysOfWeek: z.array(z.coerce.number().int().min(0).max(6)).min(1).max(7).optional(),
    startMinute: minuteOfDay.optional(),
    endMinute: minuteEndOfDay.optional(),
    enabled: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: '没有需要更新的字段' });

export const scheduleIdSchema = z.object({ scheduleId: z.string().trim().min(1) });

/**
 * 锁屏强度策略。
 *
 * `strength`：
 *  - `kiosk`    默认。用 Lock Task 把设备钉在锁定页，可远程即时解锁；
 *  - `password` 最高强度。锁定瞬间把系统锁屏密码改成随机值，连系统锁屏都进不去。
 *               风险很高（网络不可用时只能靠设备上的应急密码），设备端会强制要求
 *               先设置应急密码才允许启用。
 *
 * `countdownSeconds` 是锁屏前透明悬浮窗的预告时长，0 表示不预告。
 */
export const updateLockPolicySchema = z
  .object({
    strength: z.enum(['kiosk', 'password']).optional(),
    countdownSeconds: z.coerce.number().int().min(0).max(600).optional(),
    scheduleEnabled: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: '没有需要更新的字段' });

export type CreateScheduleInput = z.infer<typeof createScheduleSchema>;
export type UpdateScheduleInput = z.infer<typeof updateScheduleSchema>;
export type UpdateLockPolicyInput = z.infer<typeof updateLockPolicySchema>;
