import { z } from 'zod';

/** 题库年级 */
export const gradeSchema = z.enum(['grade1', 'grade2', 'grade3', 'grade4', 'grade5', 'grade6']);

/** 答题类型：english 英文单词 | poetry 古诗填空 | random 随机 */
export const quizTypeSchema = z.enum(['english', 'poetry', 'random']);

export const updateQuizConfigSchema = z.object({
  enabled: z.boolean().optional(),
  quizType: quizTypeSchema.optional(),
  /** 前端历史字段名叫 questionBank，实际语义就是年级 */
  questionBank: gradeSchema.optional(),
  grade: gradeSchema.optional(),
  correctRewardMinutes: z.coerce.number().int().min(1, '奖励时长至少 1 分钟').max(120).optional(),
  randomMode: z.boolean().optional(),
});

export const quizQuestionQuerySchema = z.object({
  type: quizTypeSchema.optional(),
  grade: gradeSchema.optional(),
  /** 指定题目 id 时直接返回该题（前端「再来一题」场景不需要） */
  excludeId: z.string().trim().optional(),
});

export const quizRecordsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(20),
  type: z.string().trim().optional(),
});

/** 家长端自测答题（真实答题由设备端 Agent 提交） */
export const submitAnswerSchema = z.object({
  questionId: z.string().trim().min(1, '缺少题目 ID'),
  answer: z.coerce.number().int().min(0).max(20),
});

/** 新增题目（题库维护用） */
export const createQuestionSchema = z.object({
  type: z.enum(['english', 'poetry']),
  grade: gradeSchema,
  question: z.string().trim().min(1, '题干不能为空'),
  options: z.array(z.string().trim().min(1)).min(2, '至少 2 个选项').max(8),
  correctAnswer: z.coerce.number().int().min(0),
  explanation: z.string().trim().max(500).optional(),
});
