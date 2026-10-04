import { z } from 'zod';

/**
 * 模式切换 / 护眼 / 应用插件管控的入参校验。
 *
 * 全部字段都给了明确上下界：这几项直接决定孩子手机能不能用，
 * 一个越界的 `continuousMinutes: 0` 或 `hour: 99` 就可能让设备行为变得无法解释。
 */

/** 一天 24 小时、一周 7 天，格子总数就是 168。 */
export const MAX_SLOTS = 168;

export const updateModeSchema = z.object({
  /** null 表示「跟随时段规划」；显式传 study/normal 表示手动锁定模式 */
  manualMode: z.enum(['study', 'normal']).nullable().optional(),
  scheduleEnabled: z.boolean().optional(),
});

export const studySlotSchema = z.object({
  dayOfWeek: z.coerce.number().int().min(0).max(6),
  hour: z.coerce.number().int().min(0).max(23),
});

export const replaceSlotsSchema = z.object({
  /** 整表替换：前端把当前选中的格子一次性提交。传空数组 = 一格都没选（全天学习模式） */
  slots: z.array(studySlotSchema).max(MAX_SLOTS),
});

export const addModeAppSchema = z.object({
  packageName: z.string().trim().min(1, '缺少包名').max(200),
  appName: z.string().trim().max(100).optional(),
  group: z.enum(['study', 'normal']).default('study'),
});

export const modeAppIdSchema = z.object({
  id: z.string().trim().min(1, '缺少记录 ID'),
});

export const updateEyeCareSchema = z.object({
  enabled: z.boolean().optional(),
  /** 连续用眼提醒：5 分钟 ~ 4 小时 */
  continuousMinutes: z.coerce.number().int().min(5).max(240).optional(),
  /** 强制休息时长：1 ~ 60 分钟 */
  restMinutes: z.coerce.number().int().min(1).max(60).optional(),
  nightStartHour: z.coerce.number().int().min(0).max(23).optional(),
  nightEndHour: z.coerce.number().int().min(0).max(23).optional(),
  nightLockEnabled: z.boolean().optional(),
  /** 亮度上限：0=不限制；否则 10~100 */
  maxBrightnessPercent: z.coerce.number().int().min(0).max(100).optional(),
});

export const updatePluginsSchema = z.object({
  /** 一次可以提交多项，家长端「全部关闭」之类的批量操作就靠它 */
  items: z
    .array(
      z.object({
        packageName: z.string().trim().min(1).max(200),
        pluginKey: z.string().trim().min(1).max(100),
        enabled: z.boolean(),
      }),
    )
    .min(1, '至少提交一项')
    .max(200),
});

/**
 * 把查询串里的 "true"/"false" 正确转成布尔。
 *
 * <p>**不能用 `z.coerce.boolean()`**：它走的是 JS 的 `Boolean(value)`，
 * 而 `Boolean("false") === true` —— 于是 `?includeSystem=false` 会变成「包含系统应用」，
 * 与字面意思正好相反。这类「看起来对、实际取反」的坑非常难查，所以单独写一个。
 */
const queryBoolean = z
  .union([z.boolean(), z.string()])
  .transform((v) => {
    if (typeof v === 'boolean') return v;
    const s = v.trim().toLowerCase();
    if (s === 'true' || s === '1' || s === '') return true;
    if (s === 'false' || s === '0') return false;
    return undefined;
  })
  .optional();

export const deviceAppQuerySchema = z.object({
  /** 按应用名或包名模糊搜索 */
  q: z.string().trim().max(100).optional(),
  /** 是否包含系统应用，默认不含 */
  includeSystem: queryBoolean,
});

export const deviceEventQuerySchema = z.object({
  type: z.string().trim().max(50).optional(),
});

// ============================================================
// 设备端上报
// ============================================================

export const reportAppsSchema = z.object({
  apps: z
    .array(
      z.object({
        packageName: z.string().trim().min(1).max(200),
        appName: z.string().trim().max(100).default(''),
        isSystem: z.boolean().default(false),
        isLaunchable: z.boolean().default(true),
      }),
    )
    .max(2000, '单次上报的应用数量超出上限'),
});

export const reportEventsSchema = z.object({
  events: z
    .array(
      z.object({
        type: z.string().trim().min(1).max(50),
        detail: z.string().trim().max(300).default(''),
        /** 设备端事件发生时刻（毫秒时间戳）；缺失则用服务端当前时间 */
        at: z.coerce.number().int().positive().optional(),
      }),
    )
    .min(1)
    .max(200),
});

export type UpdateModeInput = z.infer<typeof updateModeSchema>;
export type StudySlotInput = z.infer<typeof studySlotSchema>;
export type AddModeAppInput = z.infer<typeof addModeAppSchema>;
export type UpdateEyeCareInput = z.infer<typeof updateEyeCareSchema>;
export type UpdatePluginsInput = z.infer<typeof updatePluginsSchema>;
export type ReportAppsInput = z.infer<typeof reportAppsSchema>;
export type ReportEventsInput = z.infer<typeof reportEventsSchema>;
