import fs from 'node:fs';
import type { ChildDevice, ScreenInsight } from '@prisma/client';
import { prisma } from '../../prisma';
import { config } from '../../config';
import { logger } from '../../logger';
import { BadRequestError, NotFoundError } from '../../errors';
import { enqueue } from '../devices/commands.service';
import { notifyDevice } from '../devices/devices.notifier';
import { devicesRepo } from '../devices/devices.repository';
import { quizService } from '../quiz/quiz.service';
import {
  analyzeFrames,
  isTextConfigured,
  isVisionConfigured,
  completeText,
  type AnalyzeFrame,
  type InsightOutput,
} from './ai.provider';
import { analyzeHeuristically, appLabel, categoryLabel } from './ai.heuristic';
import {
  frameFilePath,
  persistBatchFrames,
  readZip,
  removeBatchFiles,
  screenBatchDiskUsageBytes,
  screenBatchRelativePath,
} from './screen.storage';

/**
 * 屏幕行为洞察的核心服务。
 *
 * <h3>一句话讲清数据流</h3>
 * 设备端每 30 秒截一张低分辨率图，攒 10 张打成 zip 上传 →
 * 这里解包落盘、登记批次 → 送 AI（或降级启发式）分析 →
 * 落 {@link ScreenInsight} → 从结论里抽出**异常提醒**与**可计数的用量片段** →
 * 按家长设的预算累计，超限就下发锁屏指令 → 家长端时间线可见。
 *
 * <h3>为什么分析要异步</h3>
 * 一次视觉模型调用可能几十秒。设备端上传完就应该立刻拿到 202，不该被分析拖住 ——
 * 否则设备端的重试逻辑会把同一个包反复上传。
 * 所以入库后立刻返回，分析在后台跑，状态在 {@code ScreenBatch.status} 上体现。
 */
export const insightsService = {
  // ============================================================
  // 设备端：接收一个包
  // ============================================================

  async ingestBatch(
    device: ChildDevice,
    input: {
      zip: Buffer;
      startedAt: Date;
      endedAt: Date;
      frames: { seq: number; capturedAt: Date; packageName: string }[];
      agentVersion: string;
    },
  ) {
    if (input.frames.length === 0) {
      throw new BadRequestError('包里没有任何帧的元数据，无法登记批次');
    }
    if (input.frames.length > config.SCREEN_BATCH_MAX_FRAMES) {
      throw new BadRequestError(
        `一个包最多 ${config.SCREEN_BATCH_MAX_FRAMES} 张，收到 ${input.frames.length} 张`,
      );
    }

    // 1) 解包。只取图片条目，其余（manifest.json 等）忽略
    const entries = readZip(input.zip);
    const imageEntries = entries.filter((entry) => /\.(jpe?g|png|webp)$/i.test(entry.name));
    if (imageEntries.length === 0) {
      throw new BadRequestError('包里没有可用的图片文件');
    }
    // 按文件名排序，保证与元数据的顺序一致（frame-0000.jpg / frame-0001.jpg …）
    imageEntries.sort((a, b) => a.name.localeCompare(b.name));

    // 2) 先建批次记录，拿到 id 后再落盘（目录名用 batchId，避免并发冲突）
    const batch = await prisma.screenBatch.create({
      data: {
        deviceId: device.id,
        startedAt: input.startedAt,
        endedAt: input.endedAt,
        expectedFrames: input.frames.length,
        actualFrames: imageEntries.length,
        sizeBytes: input.zip.length,
        status: 'pending',
      },
    });

    try {
      const persisted = persistBatchFrames(
        batch.id,
        imageEntries.map((entry, index) => ({ seq: index, data: entry.data })),
      );

      // 3) 登记每一帧。元数据里多余的项直接忽略（以实际图片为准）
      await prisma.$transaction(
        persisted.files.map((file) => {
          const meta = input.frames[file.seq];
          return prisma.screenFrame.create({
            data: {
              batchId: batch.id,
              seq: file.seq,
              capturedAt: meta?.capturedAt ?? input.startedAt,
              packageName: meta?.packageName ?? '',
              storagePath: `${screenBatchRelativePath(batch.id)}/${file.filename}`,
              sizeBytes: file.sizeBytes,
            },
          });
        }),
      );

      await prisma.screenBatch.update({
        where: { id: batch.id },
        data: {
          storagePath: screenBatchRelativePath(batch.id),
          actualFrames: persisted.files.length,
        },
      });
    } catch (error) {
      // 落盘或入库失败：把半成品收拾干净，别留孤儿目录
      removeBatchFiles(batch.id);
      await prisma.screenBatch
        .update({
          where: { id: batch.id },
          data: {
            status: 'failed',
            failReason: error instanceof Error ? error.message : String(error),
          },
        })
        .catch(() => undefined);
      throw error;
    }

    logger.info({
      msg: 'screen batch ingested',
      deviceId: device.id,
      batchId: batch.id,
      frames: imageEntries.length,
      bytes: input.zip.length,
    });

    // 4) 后台分析：不阻塞设备端
    void this.analyzeBatch(batch.id).catch((error) => {
      logger.error({ msg: 'screen batch analyze crashed', batchId: batch.id, error });
    });

    return {
      success: true,
      batchId: batch.id,
      frames: imageEntries.length,
      analysis: analyzeExpectation(device.id),
    };
  },

  // ============================================================
  // 分析
  // ============================================================

  async analyzeBatch(batchId: string): Promise<ScreenInsight | null> {
    const batch = await prisma.screenBatch.findUnique({
      where: { id: batchId },
      include: { frames: { orderBy: { seq: 'asc' } }, device: true },
    });
    if (!batch) throw new NotFoundError('截屏批次', batchId);
    if (batch.status === 'analyzing' || batch.status === 'done') return null;

    const screenConfig = await prisma.screenMonitorConfig.findUnique({
      where: { deviceId: batch.deviceId },
    });
    const analyzeEnabled = screenConfig?.analyzeEnabled ?? true;

    await prisma.screenBatch.update({ where: { id: batchId }, data: { status: 'analyzing' } });

    if (!analyzeEnabled) {
      await prisma.screenBatch.update({
        where: { id: batchId },
        data: { status: 'skipped', failReason: '家长关闭了 AI 分析', provider: 'disabled' },
      });
      return null;
    }

    // 均匀采样，控制成本：10 张里挑 6 张，首尾一定保留
    const sampleCount = Math.min(
      screenConfig?.analyzeSampleCount ?? config.AI_MAX_FRAMES_PER_BATCH,
      config.AI_MAX_FRAMES_PER_BATCH,
      batch.frames.length,
    );
    const sampled = pickEvenly(batch.frames, sampleCount);

    const analyzeFramesInput: AnalyzeFrame[] = [];
    for (const frame of sampled) {
      try {
        const buffer = fs.readFileSync(frameFilePath(frame.storagePath));
        analyzeFramesInput.push({
          seq: frame.seq,
          base64: buffer.toString('base64'),
          capturedAt: frame.capturedAt,
          packageName: frame.packageName,
        });
      } catch {
        logger.warn({ msg: 'screen frame missing on disk', frameId: frame.id });
      }
    }

    const quizConfig = await devicesRepo.listQuizConfig(batch.deviceId);
    const result = isVisionConfigured()
      ? await analyzeFrames(analyzeFramesInput, {
          deviceName: batch.device.name,
          grade: quizConfig?.grade,
        })
      : config.AI_HEURISTIC_FALLBACK
        ? analyzeHeuristically(analyzeFramesInput)
        : {
            provider: 'disabled',
            model: '',
            status: 'skipped' as const,
            output: null,
            raw: '',
            error: '未配置 AI 视觉模型，且已关闭启发式降级',
            promptTokens: 0,
            completionTokens: 0,
            elapsedMs: 0,
          };

    if (!result.output) {
      await prisma.screenBatch.update({
        where: { id: batchId },
        data: {
          status: result.status === 'skipped' ? 'skipped' : 'failed',
          failReason: result.error,
          provider: result.provider,
          model: result.model,
          analysisMs: result.elapsedMs,
        },
      });
      logger.warn({ msg: 'screen batch not analyzed', batchId, status: result.status });
      return null;
    }

    const insight = await prisma.screenInsight.create({
      data: {
        batchId,
        deviceId: batch.deviceId,
        summary: result.output.summary,
        activities: result.output.activities as never,
        games: result.output.games as never,
        videos: result.output.videos as never,
        contentFlags: result.output.contentFlags as never,
        topics: result.output.topics as never,
        keywords: result.output.keywords.slice(0, 50),
        riskLevel: result.output.riskLevel,
        provider: result.provider,
        model: result.model,
        promptTokens: result.promptTokens,
        completionTokens: result.completionTokens,
        rawJson: result.raw.slice(0, 20_000),
      },
    });

    await prisma.screenBatch.update({
      where: { id: batchId },
      data: {
        status: 'done',
        provider: result.provider,
        model: result.model,
        analysisMs: result.elapsedMs,
        failReason: '',
      },
    });

    // 从结论里抽异常提醒与可计数用量，再按预算判断要不要锁屏
    await this.extractAlerts(batch.deviceId, insight, result.output, screenConfig);
    await this.recordEpisodes(batch.deviceId, insight, result.output);
    await this.enforceBudgets(batch.deviceId);
    await this.generateScreenQuiz(batch.deviceId, insight, result.output, quizConfig?.grade);

    logger.info({
      msg: 'screen batch analyzed',
      batchId,
      provider: result.provider,
      riskLevel: result.output.riskLevel,
    });
    return insight;
  },

  // ============================================================
  // 异常提醒
  // ============================================================

  async extractAlerts(
    deviceId: string,
    insight: ScreenInsight,
    output: InsightOutput,
    screenConfig: { alertMinorContent: boolean; alertScam: boolean; alertEmotional: boolean; alertGameAddiction: boolean; alertHighSpending: boolean } | null,
  ) {
    const switches = screenConfig ?? {
      alertMinorContent: true,
      alertScam: true,
      alertEmotional: true,
      alertGameAddiction: true,
      alertHighSpending: true,
    };

    interface Candidate {
      type: string;
      enabled: boolean;
      severity: 'low' | 'medium' | 'high';
      title: string;
      detail: string;
      evidence: string;
    }

    const flags = output.contentFlags;
    const candidates: Candidate[] = [
      {
        type: 'minor_content',
        enabled: switches.alertMinorContent,
        severity: 'high',
        title: '疑似接触不适龄内容',
        detail: output.summary,
        evidence: flags.minorContent ? 'AI 判定画面存在不适龄内容' : '',
      },
      {
        type: 'scam_suspect',
        enabled: switches.alertScam,
        severity: 'high',
        title: '疑似遭遇诈骗',
        detail: output.summary,
        evidence: flags.scamSuspect?.evidence ?? '',
      },
      {
        type: 'emotional_issue',
        enabled: switches.alertEmotional,
        severity: 'high',
        title: '疑似情绪问题',
        detail: output.summary,
        evidence: flags.emotionalIssue?.evidence ?? '',
      },
      {
        type: 'game_addiction',
        enabled: switches.alertGameAddiction,
        severity: 'medium',
        title: '游戏时间偏长',
        detail: output.summary,
        evidence: flags.gameAddiction?.evidence ?? '',
      },
      {
        type: 'high_spending',
        enabled: switches.alertHighSpending,
        severity: 'medium',
        title: '疑似高额消费',
        detail: output.summary,
        evidence: flags.highSpending?.evidence ?? '',
      },
    ];

    const toCreate = candidates.filter((candidate) => {
      if (!candidate.enabled) return false;
      if (candidate.type === 'minor_content') return flags.minorContent;
      if (candidate.type === 'scam_suspect') return Boolean(flags.scamSuspect?.detected);
      if (candidate.type === 'emotional_issue') return Boolean(flags.emotionalIssue?.detected);
      if (candidate.type === 'game_addiction') return Boolean(flags.gameAddiction?.detected);
      if (candidate.type === 'high_spending') return Boolean(flags.highSpending?.detected);
      return false;
    });

    if (toCreate.length === 0) return;

    // 同一设备同一类型 30 分钟内不重复提醒：一个持续行为会产生很多个包，
    // 每个包都推一条会让家长端被同一件事刷屏
    const since = new Date(Date.now() - 30 * 60_000);
    for (const candidate of toCreate) {
      const existing = await prisma.usageAlert.findFirst({
        where: { deviceId, type: candidate.type, createdAt: { gte: since } },
        select: { id: true },
      });
      if (existing) continue;

      await prisma.usageAlert.create({
        data: {
          deviceId,
          insightId: insight.id,
          type: candidate.type,
          severity: candidate.severity,
          title: candidate.title,
          detail: candidate.detail.slice(0, 500),
          evidence: candidate.evidence.slice(0, 500),
        },
      });
      logger.warn({ msg: 'usage alert created', deviceId, type: candidate.type });
    }
  },

  // ============================================================
  // 用量片段（玩几局 / 看几集）
  // ============================================================

  /**
   * 把 AI 结论里的「打完一局」「看完一集」落成可计数的事实。
   *
   * 只有 {@code confidence >= 0.5} 才计数：宁可少算一局，也不要把
   * 一次误判变成「孩子的额度被白白扣掉」。局数直接关系到能不能继续用手机，
   * 误判的代价比漏判高得多。
   */
  async recordEpisodes(deviceId: string, insight: ScreenInsight, output: InsightOutput) {
    const occurredAt = insight.createdAt;
    const dayKey = dayKeyOf(occurredAt);

    for (const game of output.games) {
      if (!game.roundCompleted || game.confidence < 0.5) continue;
      await prisma.usageEpisode.create({
        data: {
          deviceId,
          insightId: insight.id,
          kind: 'game_round',
          appName: game.name,
          packageName: output.activities.find((a) => a.category === 'game')?.packageName ?? '',
          count: 1,
          confidence: game.confidence,
          evidence: game.evidence,
          occurredAt,
          dayKey,
        },
      });
      logger.info({ msg: 'game round recorded', deviceId, game: game.name });
    }

    for (const video of output.videos) {
      if (!video.episodeCompleted || video.confidence < 0.5) continue;
      await prisma.usageEpisode.create({
        data: {
          deviceId,
          insightId: insight.id,
          kind: 'video_episode',
          appName: video.name,
          packageName: output.activities.find((a) => a.category === 'video')?.packageName ?? '',
          count: 1,
          confidence: video.confidence,
          evidence: video.evidence,
          occurredAt,
          dayKey,
        },
      });
      logger.info({ msg: 'video episode recorded', deviceId, video: video.name });
    }
  },

  /**
   * 按预算判断是否超限，超了就下发锁屏指令。
   *
   * <p>锁屏走的是既有的指令队列（而不是直接改设备状态）：设备可能离线，
   * 队列能保证它上线后立刻执行；而且家长端在指令历史里能看到「因为额度用尽被锁」。
   */
  async enforceBudgets(deviceId: string) {
    const device = await prisma.childDevice.findUnique({ where: { id: deviceId } });
    if (!device || !device.userId) return;

    const summary = await this.usageSummary({ id: deviceId } as ChildDevice);
    const exceeded = summary.budgets.filter((budget) => budget.exceeded);
    if (exceeded.length === 0) return;
    if (device.locked) return; // 已经锁着就不用再下发

    const reason = exceeded
      .map((budget) =>
        budget.kind === 'game_round'
          ? `今日游戏局数已达上限（${budget.usedToday}/${budget.dailyLimit} 局）`
          : `今日观看集数已达上限（${budget.usedToday}/${budget.dailyLimit} 集）`,
      )
      .join('；');

    const revert = {
      locked: device.locked,
      tempUnlockUntil: device.tempUnlockUntil ? device.tempUnlockUntil.toISOString() : null,
    };

    await prisma.childDevice.update({
      where: { id: deviceId },
      data: { locked: true, tempUnlockUntil: null },
    });
    await enqueue(
      deviceId,
      { type: 'lock', payload: { reason: 'usage_budget', message: reason }, revert },
      device.userId,
    );
    notifyDevice(deviceId);

    logger.warn({ msg: 'device locked by usage budget', deviceId, reason });
  },

  // ============================================================
  // 屏幕答题（需求 8）
  // ============================================================

  /**
   * 由洞察结果生成「跟屏幕内容相关」的题。
   *
   * <p>有文本模型时让模型出题（能覆盖古诗、数学这些需要理解上下文的情形）；
   * 没有模型时用一条确定性规则兜底：把屏幕上的英文单词直接造成选择题。
   * 兜底题一定标注 {@code sourceTerm}，家长端能看出它来自哪张屏。
   */
  async generateScreenQuiz(
    deviceId: string,
    insight: ScreenInsight,
    output: InsightOutput,
    grade?: string,
  ) {
    const screenConfig = await prisma.screenMonitorConfig.findUnique({ where: { deviceId } });
    if (!screenConfig?.quizFromScreen) return;

    const topics = (output.topics ?? []).filter((topic) => topic.term).slice(0, 3);
    const targetGrade = grade ?? 'grade1';
    if (topics.length === 0 && output.keywords.length === 0) return;

    if (isTextConfigured() && topics.length > 0) {
      const prompt = [
        `孩子年级：${targetGrade}`,
        `屏幕内容摘要：${output.summary}`,
        `屏幕上出现的知识点：${JSON.stringify(topics)}`,
        '',
        '请据此出 1 道适合该年级的选择题（4 个选项），必须与上述屏幕内容直接相关。',
        '只返回 JSON：{"subject":"english|poetry|math|general","question":"","options":["","","",""],"correctAnswer":0,"explanation":"","sourceTerm":""}',
      ].join('\n');

      const completion = await completeText(
        prompt,
        '你是小学老师，负责根据孩子正在看的内容出题巩固学习。只返回 JSON，不要任何多余文字。',
      );
      if (completion.ok) {
        const parsed = tryParseQuestion(completion.content);
        if (parsed) {
          await prisma.screenQuizQuestion.create({
            data: {
              deviceId,
              insightId: insight.id,
              grade: targetGrade,
              subject: parsed.subject,
              question: parsed.question,
              options: parsed.options,
              correctAnswer: parsed.correctAnswer,
              explanation: parsed.explanation,
              sourceTerm: parsed.sourceTerm,
            },
          });
          return;
        }
      }
      logger.warn({ msg: 'screen quiz generation via AI failed, fallback to rule', deviceId });
    }

    // 规则兜底：用屏幕上的英文单词做「选出正确含义」
    const englishTopic = topics.find((topic) => topic.subject === 'english' && topic.meaning);
    if (englishTopic) {
      await prisma.screenQuizQuestion.create({
        data: {
          deviceId,
          insightId: insight.id,
          grade: targetGrade,
          subject: 'english',
          question: `刚才屏幕上出现了「${englishTopic.term}」，它的意思是？`,
          options: shuffledOptions(englishTopic.meaning),
          correctAnswer: 0,
          explanation: `${englishTopic.term} = ${englishTopic.meaning}`,
          sourceTerm: englishTopic.term,
        },
      });
    }
  },

  /** 设备端取题：优先屏幕题，没有则回退到普通题库。 */
  async nextScreenQuestion(device: ChildDevice) {
    const pending = await prisma.screenQuizQuestion.findFirst({
      where: { deviceId: device.id, usedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    if (pending) {
      await prisma.screenQuizQuestion.update({
        where: { id: pending.id },
        data: { usedAt: new Date() },
      });
      return {
        source: 'screen',
        enabled: true,
        question: {
          id: pending.id,
          type: pending.subject,
          grade: pending.grade,
          question: pending.question,
          options: pending.options,
          explanation: '',
        },
      };
    }

    // 回退：复用既有题库取题逻辑，形状保持一致
    const fallback = await quizService.nextQuestionForDevice(device);
    return { source: 'bank', ...fallback };
  },

  /** 设备端交卷：屏幕题自行判定（不经过题库表），普通题走原逻辑。 */
  async answerScreenQuestion(device: ChildDevice, questionId: string, answer: number) {
    const screenQuestion = await prisma.screenQuizQuestion.findUnique({ where: { id: questionId } });
    if (!screenQuestion || screenQuestion.deviceId !== device.id) {
      // 不是屏幕题 → 交给题库判定
      return quizService.answer(device, questionId, answer);
    }

    const config = await devicesRepo.listQuizConfig(device.id);
    if (!config?.enabled) throw new BadRequestError('答题解锁功能未开启');
    if (answer < 0 || answer >= screenQuestion.options.length) {
      throw new BadRequestError('选项下标超出范围');
    }

    const isCorrect = screenQuestion.correctAnswer === answer;
    const rewardMinutes = isCorrect ? config.correctRewardMinutes : 0;

    const record = await prisma.quizRecord.create({
      data: {
        userId: device.userId ?? null,
        deviceId: device.id,
        questionId: screenQuestion.id,
        type: screenQuestion.subject,
        questionText: screenQuestion.question,
        userAnswer: answer,
        isCorrect,
        rewardMinutes,
      },
    });

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

    logger.info({ msg: 'screen quiz answered', deviceId: device.id, isCorrect, rewardMinutes });

    return {
      success: true,
      isCorrect,
      rewardMinutes: isCorrect ? rewardMinutes : undefined,
      correctAnswer: screenQuestion.correctAnswer,
      explanation: screenQuestion.explanation,
      recordId: record.id,
      tempUnlockUntil,
    };
  },

  // ============================================================
  // 家长端：洞察时间线
  // ============================================================

  async listInsights(
    device: ChildDevice,
    query: { from?: Date; to?: Date; limit: number; onlyRisky: boolean },
  ) {
    const rows = await prisma.screenInsight.findMany({
      where: {
        deviceId: device.id,
        ...(query.from || query.to
          ? {
              createdAt: {
                ...(query.from ? { gte: query.from } : {}),
                ...(query.to ? { lte: query.to } : {}),
              },
            }
          : {}),
        ...(query.onlyRisky ? { riskLevel: { in: ['medium', 'high'] } } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: query.limit,
      include: { batch: { select: { startedAt: true, endedAt: true, actualFrames: true } } },
    });

    const items = rows.map((row) => toInsightView(row));
    const unreadAlerts = await prisma.usageAlert.count({
      where: { deviceId: device.id, readAt: null },
    });

    return {
      items,
      unreadAlerts,
      aiAvailable: isVisionConfigured(),
      aiNote: isVisionConfigured()
        ? `AI 分析已启用（${config.AI_VISION_MODEL}）`
        : config.AI_HEURISTIC_FALLBACK
          ? '未配置 AI：当前为启发式推断（只看前台应用与时长），画面内容无法判断'
          : '未配置 AI：截图已上传但不会分析',
    };
  },

  async getInsight(device: ChildDevice, insightId: string) {
    const row = await prisma.screenInsight.findFirst({
      where: { id: insightId, deviceId: device.id },
      include: {
        batch: { include: { frames: { orderBy: { seq: 'asc' } } } },
        alerts: true,
        episodes: true,
      },
    });
    if (!row) throw new NotFoundError('洞察记录', insightId);

    return {
      ...toInsightView(row),
      // 帧时间线：只给「时间 + 前台应用」，不给原图 URL。
      // 原图是孩子屏幕内容，家长端默认不可浏览（见 README 隐私约定）。
      frames: row.batch.frames.map((frame) => ({
        seq: frame.seq,
        capturedAt: frame.capturedAt,
        packageName: frame.packageName,
        appLabel: appLabel(frame.packageName),
      })),
      alerts: row.alerts.map(toAlertView),
      episodes: row.episodes.map(toEpisodeView),
      rawJson: row.rawJson,
    };
  },

  async reanalyze(device: ChildDevice, insightId: string) {
    const row = await prisma.screenInsight.findFirst({
      where: { id: insightId, deviceId: device.id },
      select: { batchId: true },
    });
    if (!row) throw new NotFoundError('洞察记录', insightId);

    // 清掉旧结论，让 analyzeBatch 能重跑（它有 done 早退保护）
    await prisma.usageAlert.deleteMany({ where: { insightId } });
    await prisma.usageEpisode.deleteMany({ where: { insightId } });
    await prisma.screenInsight.delete({ where: { id: insightId } });
    await prisma.screenBatch.update({
      where: { id: row.batchId },
      data: { status: 'pending', failReason: '' },
    });

    void this.analyzeBatch(row.batchId).catch((error) => {
      logger.error({ msg: 'reanalyze failed', batchId: row.batchId, error });
    });
    return { success: true, batchId: row.batchId };
  },

  // ============================================================
  // 家长端：异常提醒
  // ============================================================

  async listAlerts(
    device: ChildDevice,
    query: { type?: string; unreadOnly: boolean; limit: number },
  ) {
    const rows = await prisma.usageAlert.findMany({
      where: {
        deviceId: device.id,
        ...(query.type ? { type: query.type } : {}),
        ...(query.unreadOnly ? { readAt: null } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: query.limit,
    });
    const unread = await prisma.usageAlert.count({ where: { deviceId: device.id, readAt: null } });
    return { items: rows.map(toAlertView), unread };
  },

  async markAlertRead(device: ChildDevice, alertId: string) {
    const alert = await prisma.usageAlert.findFirst({ where: { id: alertId, deviceId: device.id } });
    if (!alert) throw new NotFoundError('提醒', alertId);
    const updated = await prisma.usageAlert.update({
      where: { id: alertId },
      data: { readAt: alert.readAt ?? new Date() },
    });
    return { success: true, alert: toAlertView(updated) };
  },

  async markAllAlertsRead(device: ChildDevice) {
    const result = await prisma.usageAlert.updateMany({
      where: { deviceId: device.id, readAt: null },
      data: { readAt: new Date() },
    });
    return { success: true, updated: result.count };
  },

  // ============================================================
  // 家长端：截屏与 AI 设置
  // ============================================================

  async getScreenConfig(device: ChildDevice) {
    const row = await prisma.screenMonitorConfig.upsert({
      where: { deviceId: device.id },
      create: { deviceId: device.id },
      update: {},
    });
    return toScreenConfigView(row, isVisionConfigured(), config.AI_HEURISTIC_FALLBACK);
  },

  async updateScreenConfig(
    device: ChildDevice,
    patch: Record<string, boolean | number | undefined>,
  ) {
    const row = await prisma.screenMonitorConfig.upsert({
      where: { deviceId: device.id },
      create: { deviceId: device.id, ...patch },
      update: patch,
    });
    logger.info({ msg: 'screen monitor config updated', deviceId: device.id, ...patch });
    return toScreenConfigView(row, isVisionConfigured(), config.AI_HEURISTIC_FALLBACK);
  },

  // ============================================================
  // 家长端：用量预算
  // ============================================================

  async listBudgets(device: ChildDevice) {
    const rows = await prisma.usageBudget.findMany({
      where: { deviceId: device.id },
      orderBy: [{ kind: 'asc' }, { appName: 'asc' }],
    });
    const today = await this.todayCounts(device.id);
    return {
      items: rows.map((row) => ({
        id: row.id,
        kind: row.kind,
        appName: row.appName,
        dailyLimit: row.dailyLimit,
        enabled: row.enabled,
        usedToday: today[row.kind] ?? 0,
      })),
    };
  },

  async upsertBudget(
    device: ChildDevice,
    input: { kind: string; appName: string; dailyLimit: number; enabled: boolean },
  ) {
    const row = await prisma.usageBudget.upsert({
      where: {
        deviceId_kind_appName: {
          deviceId: device.id,
          kind: input.kind,
          appName: input.appName,
        },
      },
      create: { deviceId: device.id, ...input },
      update: { dailyLimit: input.dailyLimit, enabled: input.enabled },
    });
    return {
      success: true,
      budget: {
        id: row.id,
        kind: row.kind,
        appName: row.appName,
        dailyLimit: row.dailyLimit,
        enabled: row.enabled,
      },
    };
  },

  async removeBudget(device: ChildDevice, budgetId: string) {
    const row = await prisma.usageBudget.findFirst({
      where: { id: budgetId, deviceId: device.id },
    });
    if (!row) throw new NotFoundError('用量上限', budgetId);
    await prisma.usageBudget.delete({ where: { id: budgetId } });
    return { success: true };
  },

  /** 今日已用 / 额度 / 是否超限 —— 家长端首页与设备端 config 都用它。 */
  async usageSummary(device: ChildDevice) {
    const [budgets, today] = await Promise.all([
      prisma.usageBudget.findMany({ where: { deviceId: device.id, enabled: true } }),
      this.todayCounts(device.id),
    ]);

    return {
      dayKey: dayKeyOf(new Date()),
      used: today,
      budgets: budgets.map((budget) => {
        const usedToday = today[budget.kind] ?? 0;
        return {
          id: budget.id,
          kind: budget.kind,
          appName: budget.appName,
          dailyLimit: budget.dailyLimit,
          usedToday,
          remaining: Math.max(0, budget.dailyLimit - usedToday),
          exceeded: usedToday >= budget.dailyLimit,
        };
      }),
    };
  },

  async todayCounts(deviceId: string): Promise<Record<string, number>> {
    const rows = await prisma.usageEpisode.groupBy({
      by: ['kind'],
      where: { deviceId, dayKey: dayKeyOf(new Date()) },
      _sum: { count: true },
    });
    const result: Record<string, number> = {};
    for (const row of rows) {
      result[row.kind] = row._sum.count ?? 0;
    }
    return result;
  },

  // ============================================================
  // 维护
  // ============================================================

  /** 清理过期帧图与批次（由 server.ts 的定时任务调用）。 */
  async purgeExpired(): Promise<{ batches: number; bytes: number }> {
    const now = Date.now();
    const configs = await prisma.screenMonitorConfig.findMany();
    const retentionByDevice = new Map(configs.map((c) => [c.deviceId, c.retentionDays]));

    const batches = await prisma.screenBatch.findMany({
      where: { status: { not: 'analyzing' } },
      select: { id: true, deviceId: true, createdAt: true, sizeBytes: true },
      orderBy: { createdAt: 'asc' },
      take: 500,
    });

    let removed = 0;
    let bytes = 0;
    for (const batch of batches) {
      const days =
        retentionByDevice.get(batch.deviceId) ?? config.SCREEN_FRAME_RETENTION_DAYS;
      if (now - batch.createdAt.getTime() < days * 86_400_000) continue;
      removeBatchFiles(batch.id);
      await prisma.screenBatch.delete({ where: { id: batch.id } });
      removed += 1;
      bytes += batch.sizeBytes;
    }

    if (removed > 0) logger.info({ msg: 'screen batches purged', removed, bytes });
    return { batches: removed, bytes };
  },

  diskUsageBytes(): number {
    return screenBatchDiskUsageBytes();
  },
};

// ============================================================
// 视图与工具
// ============================================================

function analyzeExpectation(deviceId: string) {
  void deviceId;
  if (isVisionConfigured()) {
    return { status: 'queued', provider: 'openai-compatible', model: config.AI_VISION_MODEL };
  }
  if (config.AI_HEURISTIC_FALLBACK) {
    return {
      status: 'queued',
      provider: 'heuristic',
      model: 'package-heuristic-v1',
      note: '未配置 AI，将使用启发式推断（无法判断画面内容）',
    };
  }
  return { status: 'skipped', provider: 'disabled', note: '未配置 AI 分析' };
}

function toInsightView(row: ScreenInsight & { batch?: { startedAt: Date; endedAt: Date; actualFrames: number } }) {
  const games = (row.games ?? []) as { name: string; scene: string; roundCompleted: boolean; confidence: number }[];
  const videos = (row.videos ?? []) as { name: string; episodeCompleted: boolean; confidence: number }[];
  return {
    id: row.id,
    batchId: row.batchId,
    deviceId: row.deviceId,
    createdAt: row.createdAt,
    summary: row.summary,
    riskLevel: row.riskLevel,
    activities: row.activities ?? [],
    games,
    videos,
    keywords: row.keywords,
    topics: row.topics ?? [],
    provider: row.provider,
    model: row.model,
    /** 家长端据此显示「启发式推断，非 AI 分析」 */
    isAi: row.provider === 'openai-compatible',
    periodFrom: row.batch?.startedAt ?? null,
    periodTo: row.batch?.endedAt ?? null,
    frameCount: row.batch?.actualFrames ?? 0,
    completedRounds: games.filter((g) => g.roundCompleted).length,
    completedEpisodes: videos.filter((v) => v.episodeCompleted).length,
  };
}

function toAlertView(row: {
  id: string;
  deviceId: string;
  insightId: string | null;
  type: string;
  severity: string;
  title: string;
  detail: string;
  evidence: string;
  readAt: Date | null;
  createdAt: Date;
}) {
  return {
    id: row.id,
    deviceId: row.deviceId,
    insightId: row.insightId,
    type: row.type,
    typeLabel: ALERT_TYPE_LABELS[row.type] ?? row.type,
    severity: row.severity,
    title: row.title,
    detail: row.detail,
    evidence: row.evidence,
    read: row.readAt !== null,
    readAt: row.readAt,
    createdAt: row.createdAt,
  };
}

function toEpisodeView(row: {
  id: string;
  kind: string;
  appName: string;
  count: number;
  confidence: number;
  evidence: string;
  occurredAt: Date;
}) {
  return {
    id: row.id,
    kind: row.kind,
    kindLabel: row.kind === 'game_round' ? '游戏局数' : '观看集数',
    appName: row.appName,
    count: row.count,
    confidence: row.confidence,
    evidence: row.evidence,
    occurredAt: row.occurredAt,
  };
}

function toScreenConfigView(
  row: {
    captureEnabled: boolean;
    captureIntervalSeconds: number;
    framesPerBatch: number;
    analyzeEnabled: boolean;
    analyzeSampleCount: number;
    retentionDays: number;
    quizFromScreen: boolean;
    alertMinorContent: boolean;
    alertScam: boolean;
    alertEmotional: boolean;
    alertGameAddiction: boolean;
    alertHighSpending: boolean;
  },
  aiAvailable: boolean,
  heuristicFallback: boolean,
) {
  return {
    captureEnabled: row.captureEnabled,
    captureIntervalSeconds: row.captureIntervalSeconds,
    framesPerBatch: row.framesPerBatch,
    analyzeEnabled: row.analyzeEnabled,
    analyzeSampleCount: row.analyzeSampleCount,
    retentionDays: row.retentionDays,
    quizFromScreen: row.quizFromScreen,
    alertMinorContent: row.alertMinorContent,
    alertScam: row.alertScam,
    alertEmotional: row.alertEmotional,
    alertGameAddiction: row.alertGameAddiction,
    alertHighSpending: row.alertHighSpending,
    aiAvailable,
    /** 家长端据此提示「当前没有真正的 AI，只有启发式推断」 */
    analysisMode: aiAvailable ? 'ai' : heuristicFallback ? 'heuristic' : 'disabled',
    analysisNote: aiAvailable
      ? `已连接 AI 视觉模型（${config.AI_VISION_MODEL}）。截图会发送至该服务用于分析。`
      : heuristicFallback
        ? '未配置 AI：当前只根据前台应用与时长做启发式推断，无法判断画面内容，也无法统计游戏局数与动画集数。'
        : '未配置 AI：截图会上传但不会分析。',
  };
}

export const ALERT_TYPE_LABELS: Record<string, string> = {
  minor_content: '不适龄内容',
  scam_suspect: '疑似诈骗',
  emotional_issue: '情绪问题',
  game_addiction: '游戏沉迷',
  high_spending: '高额消费',
};

/** 均匀取出 count 个元素，首尾一定保留。 */
function pickEvenly<T>(items: T[], count: number): T[] {
  if (count >= items.length) return items;
  if (count <= 1) return [items[0]];
  const result: T[] = [];
  for (let i = 0; i < count; i++) {
    const index = Math.round((i * (items.length - 1)) / (count - 1));
    result.push(items[index]);
  }
  return result;
}

/**
 * 「今天」的键。
 *
 * <p>用服务器本地日，与 `todayKey`/作息表的既有口径保持一致。
 * 跨时区部署时「今天」会与设备本地日有偏差，这一点在 README 的已知边界里写明。
 */
export function dayKeyOf(date: Date): string {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d.toISOString().slice(0, 10);
}

/**
 * 规则兜底出题时的干扰项。
 *
 * 刻意只用固定的一小组常见词：这是「没有 AI 时也能出题」的最低保障，
 * 不是要替代真正的出题。正确答案固定放 0 位，由调用方标注 sourceTerm。
 */
function shuffledOptions(correct: string): string[] {
  const distractors = ['跑', '蓝色', '桌子', '唱歌'].filter((word) => word !== correct).slice(0, 3);
  return [correct, ...distractors];
}

function tryParseQuestion(content: string): {
  subject: string;
  question: string;
  options: string[];
  correctAnswer: number;
  explanation: string;
  sourceTerm: string;
} | null {
  const first = content.indexOf('{');
  const last = content.lastIndexOf('}');
  if (first < 0 || last <= first) return null;
  try {
    const parsed = JSON.parse(content.slice(first, last + 1)) as Record<string, unknown>;
    const question = typeof parsed.question === 'string' ? parsed.question.trim() : '';
    const options = Array.isArray(parsed.options)
      ? parsed.options.filter((o): o is string => typeof o === 'string' && o.trim().length > 0)
      : [];
    const correctAnswer = Number(parsed.correctAnswer);
    if (!question || options.length < 2 || !Number.isInteger(correctAnswer)) return null;
    if (correctAnswer < 0 || correctAnswer >= options.length) return null;
    return {
      subject: typeof parsed.subject === 'string' ? parsed.subject : 'general',
      question,
      options,
      correctAnswer,
      explanation: typeof parsed.explanation === 'string' ? parsed.explanation : '',
      sourceTerm: typeof parsed.sourceTerm === 'string' ? parsed.sourceTerm : '',
    };
  } catch {
    return null;
  }
}

export { appLabel, categoryLabel };
