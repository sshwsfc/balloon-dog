import type { ChildDevice, QuizConfig, QuizQuestion } from '@prisma/client';
import { prisma } from '../../prisma';
import { logger } from '../../logger';
import { BadRequestError, NotFoundError } from '../../errors';
import { devicesRepo } from '../devices/devices.repository';
import * as crypto from 'node:crypto';

/** 题库对前端的视图：不返回 correctAnswer（防作弊）。 */
export function toQuestionView(q: QuizQuestion) {
  return {
    id: q.id,
    type: q.type,
    grade: q.grade,
    question: q.question,
    options: q.options,
    explanation: q.explanation,
  };
}

/** 带答案的视图 —— 仅在判定后返回。 */
export function toAnswerView(q: QuizQuestion) {
  return { ...toQuestionView(q), correctAnswer: q.correctAnswer };
}

export function toConfigView(config: QuizConfig | null, deviceId: string) {
  return {
    enabled: config?.enabled ?? false,
    quizType: config?.quizType ?? 'english',
    // questionBank 是前端历史字段名，与 grade 同义，两个都给
    grade: config?.grade ?? 'grade1',
    questionBank: config?.grade ?? 'grade1',
    correctRewardMinutes: config?.correctRewardMinutes ?? 3,
    randomMode: config?.randomMode ?? false,
    deviceId,
  };
}

/** 随机抽一题（可按类型/年级过滤）。 */
async function pickQuestion(filter: {
  type?: string;
  grade?: string;
  excludeId?: string;
}): Promise<QuizQuestion | null> {
  const where: Record<string, unknown> = {};
  if (filter.type && filter.type !== 'random') where.type = filter.type;
  if (filter.grade) where.grade = filter.grade;
  if (filter.excludeId) where.id = { not: filter.excludeId };

  const total = await prisma.quizQuestion.count({ where });
  if (total === 0) return null;

  // 先随机偏移再取一条，比把整张表读进内存高效（题库会持续增长）
  const offset = crypto.randomInt(0, total);
  const rows = await prisma.quizQuestion.findMany({ where, skip: offset, take: 1 });
  return rows[0] ?? null;
}

/**
 * 按配置抽题。
 * 过滤条件严格按 quizType + grade 来；如果该组合下没有题，逐级放宽：
 *   指定年级 → 该类型全部年级 → 全部题库。
 * 这样即使某个年级题量少，答题功能也不会「开天窗」。
 */
export async function pickQuestionForConfig(config: QuizConfig, excludeId?: string): Promise<QuizQuestion> {
  const type = config.quizType;
  const grade = config.grade;

  const byExact = await pickQuestion({ type, grade, excludeId });
  if (byExact) return byExact;

  const byType = await pickQuestion({ type, excludeId });
  if (byType) return byType;

  const any = await pickQuestion({ excludeId });
  if (any) {
    logger.warn({ msg: 'quiz fallback to any question', deviceId: config.deviceId, type, grade });
    return any;
  }

  throw new NotFoundError('题库', '当前筛选条件下没有任何题目');
}

export const quizService = {
  // ============================================================
  // 家长端
  // ============================================================

  async getConfig(device: ChildDevice) {
    await devicesRepo.ensureDefaults(device.id);
    const config = await devicesRepo.listQuizConfig(device.id);
    return toConfigView(config, device.id);
  },

  async updateConfig(
    device: ChildDevice,
    patch: {
      enabled?: boolean;
      quizType?: string;
      questionBank?: string;
      grade?: string;
      correctRewardMinutes?: number;
      randomMode?: boolean;
    },
  ) {
    await devicesRepo.ensureDefaults(device.id);
    const grade = patch.grade ?? patch.questionBank;
    const data = {
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      ...(patch.quizType !== undefined ? { quizType: patch.quizType } : {}),
      ...(grade !== undefined ? { grade } : {}),
      ...(patch.correctRewardMinutes !== undefined
        ? { correctRewardMinutes: patch.correctRewardMinutes }
        : {}),
      ...(patch.randomMode !== undefined ? { randomMode: patch.randomMode } : {}),
    };
    if (Object.keys(data).length === 0) throw new BadRequestError('没有需要更新的配置');

    const config = await devicesRepo.setQuizConfig(device.id, data);

    // 开关与 DeviceFeature.quizUnlock 联动，避免两处状态打架
    if (patch.enabled !== undefined) {
      await devicesRepo.setFeature(device.id, 'quizUnlock', patch.enabled);
    }
    return toConfigView(config, device.id);
  },

  /** 家长端预览题目（不含答案）。 */
  async previewQuestion(device: ChildDevice, filter: { type?: string; grade?: string; excludeId?: string }) {
    await devicesRepo.ensureDefaults(device.id);
    const config = await devicesRepo.listQuizConfig(device.id);
    const base = config ?? {
      enabled: false,
      quizType: filter.type ?? 'english',
      grade: filter.grade ?? 'grade1',
    };

    const question = await pickQuestion({
      type: filter.type ?? base.quizType,
      grade: filter.grade ?? base.grade,
      excludeId: filter.excludeId,
    });
    if (!question) throw new NotFoundError('题库', '当前筛选条件下没有任何题目');
    return toQuestionView(question);
  },

  /** 答题记录（按当前设备）。 */
  async listRecords(device: ChildDevice, limit: number, type?: string) {
    const rows = await prisma.quizRecord.findMany({
      where: { deviceId: device.id, ...(type ? { type } : {}) },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    return rows.map((r) => ({
      id: r.id,
      deviceId: r.deviceId,
      questionId: r.questionId,
      type: r.type,
      question: r.questionText,
      userAnswer: r.userAnswer,
      isCorrect: r.isCorrect,
      rewardMinutes: r.rewardMinutes,
      timestamp: r.createdAt,
    }));
  },

  /**
   * 答题统计（按当前设备）。
   * byType 固定给出 english / poetry / random 三个桶，保证前端拿到的结构稳定。
   */
  async statistics(device: ChildDevice) {
    const records = await prisma.quizRecord.findMany({
      where: { deviceId: device.id },
      select: { type: true, isCorrect: true, rewardMinutes: true },
    });

    const byType: Record<string, { total: number; correct: number; accuracy: number }> = {
      english: { total: 0, correct: 0, accuracy: 0 },
      poetry: { total: 0, correct: 0, accuracy: 0 },
      random: { total: 0, correct: 0, accuracy: 0 },
    };

    let correctCount = 0;
    let totalRewardMinutes = 0;
    for (const r of records) {
      const bucket = byType[r.type] ?? (byType[r.type] = { total: 0, correct: 0, accuracy: 0 });
      bucket.total += 1;
      if (r.isCorrect) {
        bucket.correct += 1;
        correctCount += 1;
      }
      totalRewardMinutes += r.rewardMinutes;
    }
    for (const key of Object.keys(byType)) {
      const b = byType[key];
      b.accuracy = b.total > 0 ? b.correct / b.total : 0;
    }

    const totalQuestions = records.length;
    return {
      totalQuestions,
      correctCount,
      incorrectCount: totalQuestions - correctCount,
      accuracyRate: totalQuestions > 0 ? correctCount / totalQuestions : 0,
      totalRewardMinutes,
      byType,
    };
  },

  // ============================================================
  // 答题（设备端为主，家长端自测复用同一套判定）
  // ============================================================

  /**
   * 判定答案并落库。
   *
   * 奖励逻辑：答对后把设备的「可使用时長」往后延长 rewardMinutes。
   *  - 设备当前若处于锁屏，则顺带解锁（这正是「答题解锁」的字面语义）；
   *  - 已有临时解锁时在原有到期时间上叠加，而不是覆盖，避免奖励被吞掉。
   */
  async answer(
    device: ChildDevice,
    questionId: string,
    answer: number,
    options: { recordUserId?: number | null } = {},
  ) {
    await devicesRepo.ensureDefaults(device.id);
    const config = await devicesRepo.listQuizConfig(device.id);
    if (!config?.enabled) {
      throw new BadRequestError('答题解锁功能未开启');
    }

    const question = await prisma.quizQuestion.findUnique({ where: { id: questionId } });
    if (!question) throw new NotFoundError('题目', questionId);
    if (answer < 0 || answer >= question.options.length) {
      throw new BadRequestError('选项下标超出范围');
    }

    const isCorrect = question.correctAnswer === answer;
    const rewardMinutes = isCorrect ? config.correctRewardMinutes : 0;

    const record = await prisma.quizRecord.create({
      data: {
        userId: options.recordUserId ?? device.userId ?? null,
        deviceId: device.id,
        questionId: question.id,
        type: question.type,
        questionText: question.question,
        userAnswer: answer,
        isCorrect,
        rewardMinutes,
      },
    });

    // 答对即延长可用时长：已有临时解锁时在原有到期时间上叠加，锁屏则顺带解锁
    let tempUnlockUntil = device.tempUnlockUntil;
    if (isCorrect && rewardMinutes > 0) {
      const base = Math.max(Date.now(), device.tempUnlockUntil?.getTime() ?? 0);
      const until = new Date(base + rewardMinutes * 60_000);
      await prisma.childDevice.update({
        where: { id: device.id },
        data: { locked: false, tempUnlockUntil: until },
      });
      tempUnlockUntil = until;
    }

    logger.info({
      msg: 'quiz answered',
      deviceId: device.id,
      questionId: question.id,
      isCorrect,
      rewardMinutes,
    });

    return {
      success: true,
      isCorrect,
      rewardMinutes: isCorrect ? rewardMinutes : undefined,
      correctAnswer: question.correctAnswer,
      explanation: question.explanation,
      recordId: record.id,
      tempUnlockUntil,
    };
  },

  /**
   * 设备端取题：走设备自己的 QuizConfig，并顺带把「答题是否开启」告知设备。
   */
  async nextQuestionForDevice(device: ChildDevice) {
    await devicesRepo.ensureDefaults(device.id);
    const config = await devicesRepo.listQuizConfig(device.id);
    if (!config?.enabled) {
      throw new BadRequestError('答题解锁功能未开启');
    }
    const question = await pickQuestionForConfig(config);
    return {
      enabled: true,
      rewardMinutes: config.correctRewardMinutes,
      randomMode: config.randomMode,
      question: toQuestionView(question),
    };
  },

  // ============================================================
  // 题库维护
  // ============================================================

  async createQuestion(input: {
    type: string;
    grade: string;
    question: string;
    options: string[];
    correctAnswer: number;
    explanation?: string;
  }) {
    if (input.correctAnswer >= input.options.length) {
      throw new BadRequestError('正确答案下标超出选项范围');
    }
    const created = await prisma.quizQuestion.create({
      data: {
        type: input.type,
        grade: input.grade,
        question: input.question,
        options: input.options,
        correctAnswer: input.correctAnswer,
        explanation: input.explanation ?? '',
      },
    });
    return toAnswerView(created);
  },
};
