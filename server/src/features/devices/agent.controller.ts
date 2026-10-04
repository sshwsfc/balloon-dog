import { Request, Response } from 'express';
import {
  agentCommandResultSchema,
  agentHeartbeatSchema,
  agentLocationSchema,
  agentPollQuerySchema,
  agentRegisterSchema,
} from './devices.dto';
import { devicesService } from './devices.service';
import { commandsService } from './commands.service';
import { devicesRepo } from './devices.repository';
import { prisma } from '../../prisma';
import { waitForDevice } from './devices.notifier';
import { currentDeviceId } from '../../shared/deviceScope';
import { NotFoundError } from '../../errors';
import { FEATURE_DEFS } from './devices.constants';
import { scheduleService } from '../schedule/schedule.service';
import { insightsService } from '../insights/insights.service';
import { modeService } from '../mode/mode.service';

/**
 * 设备端 Agent 接口。
 *
 * Agent 的生命周期：
 *   1. 本地生成 deviceCode + deviceSecret，调 /register 拿到 deviceToken 并持久化；
 *   2. 家长在 App 里输入 deviceCode 完成认领（此后 bound=true）；
 *   3. 循环：/heartbeat 报活 → /commands/next 长轮询领指令 → 执行 → /commands/:id/result 回报；
 *   4. 定期 /config 拉取最新管控策略（开关、时长、黑名单），在本地强制执行。
 *
 * 注意：服务端只负责「传达与收敛」，真正的锁屏/拦截/采集必须由 Agent 在设备上完成。
 */

/** POST /api/agent/register */
export async function register(req: Request, res: Response) {
  const input = agentRegisterSchema.parse(req.body);
  const result = await devicesService.registerAgent(input);
  res.status(result.created ? 201 : 200).json(result);
}

/** POST /api/agent/heartbeat */
export async function heartbeat(req: Request, res: Response) {
  const input = agentHeartbeatSchema.parse(req.body ?? {});
  const result = await devicesService.heartbeat(currentDeviceId(req), input);
  res.json(result);
}

/**
 * GET /api/agent/commands/next?wait=25
 * 长轮询领取一条指令：没有指令时挂起最多 wait 秒，有新指令会被立即唤醒。
 * 设备端因此能做到「家长一点锁屏，孩子手机立刻响应」，而不是等下一个轮询周期。
 */
export async function nextCommand(req: Request, res: Response) {
  const { wait } = agentPollQuerySchema.parse(req.query);
  const deviceId = currentDeviceId(req);

  const first = await commandsService.claimNext(deviceId);
  if (first) return res.json({ command: first });

  if (wait > 0) {
    await waitForDevice(deviceId, wait * 1000);
    const afterWake = await commandsService.claimNext(deviceId);
    if (afterWake) return res.json({ command: afterWake });
  }

  res.json({ command: null });
}

/** POST /api/agent/commands/:commandId/result */
export async function reportCommandResult(req: Request, res: Response) {
  const { status, result, error } = agentCommandResultSchema.parse(req.body);
  const deviceId = currentDeviceId(req);
  const commandId = String(req.params.commandId);

  const updated = await commandsService.submitResult(commandId, deviceId, status, result, error);
  if (!updated) throw new NotFoundError('指令', commandId);
  res.json({ success: true, ...updated });
}

/** POST /api/agent/locations */
export async function reportLocation(req: Request, res: Response) {
  const input = agentLocationSchema.parse(req.body);
  const result = await devicesService.reportLocation(currentDeviceId(req), input);
  res.status(result.deduplicated ? 200 : 201).json(result);
}

/**
 * GET /api/agent/config
 * 下发当前生效的管控策略。Agent 拿到后在本地强制执行：
 * 锁屏、每日时长、应用限额、网址黑名单、答题配置。
 */
/** 用量汇总的类型直接取自服务，避免两处字段漂移。 */
type UsageSummary = Awaited<ReturnType<typeof insightsService.usageSummary>>;

/**
 * 把服务端算出的用量汇总压成设备端要的形状。
 *
 * 「未设上限」与「上限已用完」必须区分开：前者是 unlimited，后者是 exceeded。
 * 混在一起会让设备端在家长没设限制时就把手机锁了。
 */
function budgetOf(usage: UsageSummary, kind: string) {
  const budget = usage.budgets.find((b) => b.kind === kind && !b.appName);
  if (!budget) {
    return { enabled: false, dailyLimit: 0, usedToday: usage.used[kind] ?? 0, remaining: 0, exceeded: false };
  }
  return {
    enabled: true,
    dailyLimit: budget.dailyLimit,
    usedToday: budget.usedToday,
    remaining: budget.remaining,
    exceeded: budget.exceeded,
  };
}

export async function getConfig(req: Request, res: Response) {
  const deviceId = currentDeviceId(req);
  const device = await devicesRepo.findById(deviceId);
  if (!device) throw new NotFoundError('设备', deviceId);
  if (!device.userId) {
    // 还没被家长认领：只回最基本的信息，不下发任何管控策略
    return res.json({
      bound: false,
      deviceId: device.id,
      deviceCode: device.deviceCode,
      serverTime: new Date().toISOString(),
      message: '设备尚未被家长绑定，请在家长端输入此设备码完成绑定',
    });
  }

  await devicesRepo.ensureDefaults(device.id);
  const [featureRows, timePlan, appLimits, blockedUrls, quizConfig, lockPolicy, screenConfig, usage,
    modePayload, eyeCare, pluginRules] =
    await Promise.all([
    devicesRepo.listFeatures(device.id),
    devicesRepo.getTimePlan(device.id),
    devicesRepo.listAppLimits(device.id),
    devicesRepo.listBlockedUrls(device.id),
    devicesRepo.listQuizConfig(device.id),
    // 锁屏强度 + 定时时间表：设备端据此在本地强制锁屏 / 解锁
    scheduleService.buildAgentPayload(device.id),
    // 屏幕行为洞察：截屏与 AI 设置
    prisma.screenMonitorConfig.findUnique({ where: { deviceId: device.id } }),
    // 今日用量与额度。
    //
    // 注意区分两件事：
    //  - **每日时长**（timePlan）设备端会本地兜底锁屏；
    //  - **局数 / 集数预算**只在这里下发用于展示，设备端**不做本地兜底**
    //    （LockState.Inputs 里没有对应项）。超限是靠服务端下发 lock 指令实现的，
    //    所以设备离线期间预算拦不住 —— 详见 docs/FEATURE-STATUS.md §3.4。
    insightsService.usageSummary(device),
    // 学习模式 / 普通模式：规则原样下发，Android 侧本地求值（断网也要能算）
    modeService.buildModePayload(device),
    // 护眼设置
    modeService.getEyeCare(device),
    // 应用插件管控：只下发与默认值不同的项
    modeService.buildPluginRules(device),
  ]);

  const enabledFeatures = featureRows.filter((f) => f.enabled).map((f) => f.key);
  const used = timePlan?.usedTodayMinutes ?? 0;
  const limit = timePlan?.dailyLimitMinutes ?? 0;

  res.json({
    bound: true,
    deviceId: device.id,
    serverTime: new Date().toISOString(),
    locked: device.locked,
    tempUnlockUntil: device.tempUnlockUntil,
    features: enabledFeatures,
    // 附带元数据，方便 Agent 端做设置页展示
    featureCatalog: FEATURE_DEFS.map((f) => ({ key: f.key, label: f.label, group: f.group })),
    timePlan: {
      enabled: timePlan?.enabled ?? false,
      dailyLimitMinutes: limit,
      usedTodayMinutes: used,
      // 0 表示不限；负数由服务端夹到 0，避免 Agent 端出现「剩余 -30 分钟」
      remainingMinutes: limit > 0 ? Math.max(0, limit - used) : 0,
      unlimited: limit === 0,
    },
    appLimits: appLimits
      .filter((a) => a.enabled)
      .map((a) => ({
        appName: a.appName,
        packageName: a.packageName,
        dailyLimitMinutes: a.dailyLimitMinutes,
      })),
    blockedUrls: blockedUrls.filter((u) => u.enabled).map((u) => u.url),
    // 模式切换：规则原样下发，设备端本地求值
    mode: modePayload,
    // 护眼设置
    eyeCare: {
      enabled: eyeCare.enabled,
      continuousMinutes: eyeCare.continuousMinutes,
      restMinutes: eyeCare.restMinutes,
      nightStartHour: eyeCare.nightStartHour,
      nightEndHour: eyeCare.nightEndHour,
      nightLockEnabled: eyeCare.nightLockEnabled,
      maxBrightnessPercent: eyeCare.maxBrightnessPercent,
    },
    // 应用插件管控：只包含被家长改动过的项
    appPlugins: pluginRules,
    quiz: {
      enabled: quizConfig?.enabled ?? false,
      quizType: quizConfig?.quizType ?? 'english',
      grade: quizConfig?.grade ?? 'grade1',
      rewardMinutes: quizConfig?.correctRewardMinutes ?? 3,
      randomMode: quizConfig?.randomMode ?? false,
    },
    // 屏幕行为洞察。
    //
    // 注意 usageBudget 的计数来自服务端的 AI 分析（设备端自己数不准 ——
    // 判断「这一局打完了没」需要看画面）。设备端拿到的是权威计数，
    // **当前只用于界面展示**；真正拦住孩子的是服务端在超限后下发的 lock 指令。
    // （原先这里写的是「用于离线兜底锁屏」，但设备端并没有实现该兜底。）
    screenMonitor: {
      captureEnabled: screenConfig?.captureEnabled ?? false,
      captureIntervalSeconds: screenConfig?.captureIntervalSeconds ?? 30,
      framesPerBatch: screenConfig?.framesPerBatch ?? 10,
      quizFromScreen: screenConfig?.quizFromScreen ?? false,
      usageBudget: {
        gameRounds: budgetOf(usage, 'game_round'),
        videoEpisodes: budgetOf(usage, 'video_episode'),
      },
    },
    // 锁屏策略与时间表。字段名与家长端 /api/lock-policy、/api/schedules 保持一致，
    // 三端共用一套语义，避免「家长端显示的和设备端执行的不是一回事」。
    lockPolicy: {
      strength: lockPolicy.strength,
      countdownSeconds: lockPolicy.countdownSeconds,
      scheduleEnabled: lockPolicy.scheduleEnabled,
      schedule: lockPolicy.schedule,
    },
  });
}
