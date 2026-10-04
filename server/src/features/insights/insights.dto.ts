import { z } from 'zod';

/**
 * 屏幕行为洞察的入参校验。
 *
 * 分两组：设备端（上传包、取屏幕题）与家长端（设置、预算、提醒）。
 */

// ============================================================
// 设备端
// ============================================================

/** 上传包时随表单一起提交的帧元数据（JSON 字符串）。 */
export const frameMetaSchema = z.object({
  seq: z.coerce.number().int().min(0),
  capturedAt: z.coerce.date(),
  packageName: z.string().trim().max(200).default(''),
});

export const frameMetaListSchema = z.array(frameMetaSchema).max(60);

export const uploadBatchSchema = z.object({
  startedAt: z.coerce.date(),
  endedAt: z.coerce.date(),
  frames: frameMetaListSchema,
  agentVersion: z.string().trim().max(30).default(''),
});

export const screenAnswerSchema = z.object({
  questionId: z.string().trim().min(1, '缺少题目 ID'),
  answer: z.coerce.number().int().min(0).max(20),
});

// ============================================================
// 家长端
// ============================================================

export const insightQuerySchema = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  onlyRisky: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
});

export const insightIdSchema = z.object({ insightId: z.string().trim().min(1) });

export const alertQuerySchema = z.object({
  type: z
    .enum(['minor_content', 'scam_suspect', 'emotional_issue', 'game_addiction', 'high_spending'])
    .optional(),
  unreadOnly: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

export const alertIdSchema = z.object({ alertId: z.string().trim().min(1) });

/** 截屏与 AI 设置。 */
export const updateScreenConfigSchema = z
  .object({
    captureEnabled: z.boolean().optional(),
    // 30 秒一张是「看得清行为」与「不侵占存储/流量」之间的折中；
    // 下限定到 10 秒，再密就会让设备端截图本身成为耗电大户
    captureIntervalSeconds: z.coerce.number().int().min(10).max(600).optional(),
    framesPerBatch: z.coerce.number().int().min(2).max(30).optional(),
    analyzeEnabled: z.boolean().optional(),
    analyzeSampleCount: z.coerce.number().int().min(1).max(20).optional(),
    retentionDays: z.coerce.number().int().min(1).max(90).optional(),
    quizFromScreen: z.boolean().optional(),
    alertMinorContent: z.boolean().optional(),
    alertScam: z.boolean().optional(),
    alertEmotional: z.boolean().optional(),
    alertGameAddiction: z.boolean().optional(),
    alertHighSpending: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: '没有需要更新的字段' });

/** 用量上限：「今天最多玩 3 局」。 */
export const upsertBudgetSchema = z.object({
  kind: z.enum(['game_round', 'video_episode'], { required_error: '请选择限制类型' }),
  /** 留空表示对全部应用生效 */
  appName: z.string().trim().max(50).default(''),
  dailyLimit: z.coerce.number().int().min(1, '上限至少为 1').max(200),
  enabled: z.boolean().default(true),
});

export const budgetIdSchema = z.object({ budgetId: z.string().trim().min(1) });

export type InsightQuery = z.infer<typeof insightQuerySchema>;
export type AlertQuery = z.infer<typeof alertQuerySchema>;
export type UpdateScreenConfigInput = z.infer<typeof updateScreenConfigSchema>;
export type UpsertBudgetInput = z.infer<typeof upsertBudgetSchema>;
