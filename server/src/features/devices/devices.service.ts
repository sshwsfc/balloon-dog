import bcrypt from 'bcryptjs';
import type { ChildDevice } from '@prisma/client';
import { prisma } from '../../prisma';
import { logger } from '../../logger';
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from '../../errors';
import { signDeviceToken } from '../../shared/tokens';
import { humanizeLastActive, toDeviceView } from '../../shared/deviceScope';
import { devicesRepo } from './devices.repository';
import { commandsService, enqueue, snapshotState, toCommandView } from './commands.service';
import { FEATURE_DEFS, commandLabel, isFeatureKey, type CommandType } from './devices.constants';
import type { CommandStatus } from './devices.constants';

const BCRYPT_ROUNDS = 10;

/** 设备绑定数量上限：防止被刷号，也让「家长」这个身份保持合理规模。 */
const MAX_DEVICES_PER_USER = 20;

/** 前端 Features 契约需要的形状。 */
export interface FeaturesPayload {
  lockScreen: { enabled: boolean; locked: boolean };
  tempUnlock: { enabled: boolean; unlockTime: string | null };
  timePlan: { enabled: boolean; dailyLimit: number; usedToday: number };
  appLimit: { enabled: boolean; apps: Record<string, number> };
  appAudit: { enabled: boolean; pendingApps: string[] };
  webBlock: { enabled: boolean; blockedUrls: string[] };
  /** quizUnlock 及其余纯开关类功能由 FEATURE_DEFS 循环统一补齐（运行时一定存在）。 */
  quizUnlock?: { enabled: boolean };
  [key: string]: unknown;
}

function todayKey(d = new Date()): string {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x.toISOString().slice(0, 10);
}

/**
 * 把散落在 5 张表里的配置聚合成前端契约要求的 Features 对象。
 * 前端一行都不用改就能对接 —— 但底层是真表真字段，不再是 db.json 里的大对象。
 */
async function buildFeaturesPayload(device: ChildDevice): Promise<FeaturesPayload> {
  await devicesRepo.ensureDefaults(device.id);

  const [featureRows, timePlan, appLimits, pendingAudits, blockedUrls] = await Promise.all([
    devicesRepo.listFeatures(device.id),
    devicesRepo.getTimePlan(device.id),
    devicesRepo.listAppLimits(device.id),
    devicesRepo.listPendingAudits(device.id),
    devicesRepo.listBlockedUrls(device.id),
  ]);

  const enabledMap = new Map(featureRows.map((f) => [f.key, f.enabled]));

  // 每日已用时长跨天归零：读取时惰性重置，避免依赖定时任务
  let usedToday = timePlan?.usedTodayMinutes ?? 0;
  if (timePlan && todayKey(timePlan.resetAt) !== todayKey()) {
    const reset = await devicesRepo.setTimePlan(device.id, { usedTodayMinutes: 0, resetAt: new Date() });
    usedToday = reset.usedTodayMinutes;
  }

  const payload: FeaturesPayload = {
    lockScreen: { enabled: enabledMap.get('lockScreen') ?? true, locked: device.locked },
    tempUnlock: {
      enabled: enabledMap.get('tempUnlock') ?? true,
      unlockTime: device.tempUnlockUntil ? device.tempUnlockUntil.toISOString() : null,
    },
    timePlan: {
      enabled: timePlan?.enabled ?? false,
      dailyLimit: timePlan?.dailyLimitMinutes ?? 0,
      usedToday,
    },
    appLimit: {
      enabled: enabledMap.get('appLimit') ?? false,
      apps: Object.fromEntries(appLimits.filter((a) => a.enabled).map((a) => [a.appName, a.dailyLimitMinutes])),
    },
    appAudit: {
      enabled: enabledMap.get('appAudit') ?? false,
      pendingApps: pendingAudits.map((a) => a.appName),
    },
    webBlock: {
      enabled: enabledMap.get('webBlock') ?? false,
      blockedUrls: blockedUrls.filter((u) => u.enabled).map((u) => u.url),
    },
  };

  // 纯开关类功能
  for (const def of FEATURE_DEFS) {
    if (def.key in payload) continue;
    payload[def.key] = { enabled: enabledMap.get(def.key) ?? def.defaultEnabled };
  }

  return payload;
}

/**
 * 惰性处理临时解锁到期：到期后设备应回到锁定态。
 * 放在读取路径上，保证家长一打开 App 看到的就不是过期状态。
 */
async function reconcileTempUnlock(device: ChildDevice): Promise<ChildDevice> {
  if (!device.tempUnlockUntil) return device;
  if (device.tempUnlockUntil.getTime() > Date.now()) return device;
  const updated = await devicesRepo.update(device.id, {
    locked: true,
    tempUnlockUntil: null,
  });
  logger.info({ msg: 'temp unlock expired', deviceId: device.id });
  return updated;
}

/** 统一的指令下发 + 回执视图，供 lock/tempUnlock/拍照/录像等复用。 */
async function dispatchCommand(
  device: ChildDevice,
  userId: number,
  type: CommandType,
  payload: Record<string, unknown>,
  optimisticPatch: Record<string, unknown>,
) {
  const revert = snapshotState(device);

  // 先造回滚快照，再更新期望状态，最后入队
  if (Object.keys(optimisticPatch).length > 0) {
    await devicesRepo.update(device.id, optimisticPatch);
  }
  const command = await enqueue(device.id, { type, payload, revert }, userId);

  const offline = device.status !== 'online';
  const fresh = await devicesRepo.findById(device.id);
  return {
    success: true,
    command: toCommandView(command),
    device: fresh ? toDeviceView(fresh) : null,
    // 设备离线时如实告知：指令会排队，等设备上线后执行
    warning: offline
      ? `设备当前离线，${commandLabel(type)}指令会在设备上线后执行`
      : undefined,
  };
}

export const devicesService = {
  // ============================================================
  // 家长端
  // ============================================================

  async listDevices(userId: number) {
    const devices = await devicesRepo.listByUser(userId);
    // 补齐附属记录，避免新绑定设备缺功能行
    await Promise.all(devices.map((d) => devicesRepo.ensureDefaults(d.id)));
    return devices.map(toDeviceView);
  },

  async getDeviceView(userId: number, device: ChildDevice) {
    const reconciled = await reconcileTempUnlock(device);
    return toDeviceView(reconciled);
  },

  async getFeatures(device: ChildDevice) {
    const reconciled = await reconcileTempUnlock(device);
    return buildFeaturesPayload(reconciled);
  },

  /**
   * 凭绑定码认领设备。
   * 幂等：已属于自己的设备重复绑定不报错；已属于别人的设备明确拒绝。
   */
  async bindDevice(userId: number, deviceCode: string, name?: string) {
    const device = await devicesRepo.findByCode(deviceCode);
    if (!device) {
      throw new NotFoundError('绑定码对应的设备', deviceCode);
    }

    if (device.userId === userId) {
      // 重复提交：直接补默认配置并返回
      await devicesRepo.ensureDefaults(device.id);
      const fresh = await devicesRepo.findById(device.id);
      return { success: true, alreadyBound: true, device: toDeviceView(fresh!) };
    }
    if (device.userId) {
      throw new ConflictError('该设备已被其他账号绑定，请先在对方账号中解绑');
    }

    const count = await devicesRepo.countByUser(userId);
    if (count >= MAX_DEVICES_PER_USER) {
      throw new BadRequestError(`最多只能绑定 ${MAX_DEVICES_PER_USER} 台设备`);
    }

    const bound = await devicesRepo.bindToUser(device.id, userId, name?.trim() || undefined);
    await devicesRepo.ensureDefaults(bound.id);

    // 首个设备自动设为当前设备
    if (count === 0) {
      await prisma.user.update({ where: { id: userId }, data: { activeDeviceId: bound.id } });
    }

    logger.info({ msg: 'device bound', userId, deviceId: bound.id, deviceCode });
    return { success: true, alreadyBound: false, device: toDeviceView(bound) };
  },

  async updateDevice(userId: number, deviceId: string, data: { name?: string; avatar?: string }) {
    if (Object.keys(data).length === 0) throw new BadRequestError('没有需要更新的字段');
    const device = await this.requireOwned(userId, deviceId);
    const updated = await devicesRepo.update(device.id, data);
    return { success: true, device: toDeviceView(updated) };
  },

  /** 解绑设备：同时清理该设备的指令/位置/媒体等关联数据（onDelete: Cascade 已覆盖）。 */
  async removeDevice(userId: number, deviceId: string) {
    const device = await this.requireOwned(userId, deviceId);
    await devicesRepo.remove(device.id);

    // activeDeviceId 指向已删除设备时，顺手切到剩余的第一台
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { activeDeviceId: true } });
    if (user?.activeDeviceId === device.id) {
      const next = await prisma.childDevice.findFirst({ where: { userId }, orderBy: { createdAt: 'asc' } });
      await prisma.user.update({ where: { id: userId }, data: { activeDeviceId: next?.id ?? null } });
    }

    logger.info({ msg: 'device removed', userId, deviceId: device.id });
    return { success: true };
  },

  async selectDevice(userId: number, deviceId: string) {
    const device = await this.requireOwned(userId, deviceId);
    await prisma.user.update({ where: { id: userId }, data: { activeDeviceId: device.id } });
    return { success: true, device: toDeviceView(device) };
  },

  // ============================================================
  // 功能配置
  // ============================================================

  async setFeature(userId: number, deviceId: string, key: string, enabled: boolean) {
    if (!isFeatureKey(key)) throw new BadRequestError(`未知的功能标识：${key}`);
    const device = await this.requireOwned(userId, deviceId);
    await devicesRepo.setFeature(device.id, key, enabled);

    // 打开/关闭答题解锁时同步 QuizConfig，避免两处状态不一致
    if (key === 'quizUnlock') {
      await devicesRepo.setQuizConfig(device.id, { enabled });
    }
    // 时间规划开关与 TimePlan.enabled 联动
    if (key === 'timePlan') {
      await devicesRepo.setTimePlan(device.id, { enabled });
    }
    return { success: true };
  },

  async setTimePlan(userId: number, deviceId: string, dailyLimitMinutes: number, enabled?: boolean) {
    const device = await this.requireOwned(userId, deviceId);
    await devicesRepo.setTimePlan(device.id, {
      dailyLimitMinutes,
      ...(enabled !== undefined ? { enabled } : {}),
    });
    // 时间规划一旦设置，就把对应开关打开
    await devicesRepo.setFeature(device.id, 'timePlan', true);
    return { success: true };
  },

  async setAppLimit(userId: number, deviceId: string, appName: string, limit: number) {
    const device = await this.requireOwned(userId, deviceId);
    await devicesRepo.upsertAppLimit(device.id, appName, { dailyLimitMinutes: limit });
    await devicesRepo.setFeature(device.id, 'appLimit', true);
    return { success: true };
  },

  async removeAppLimit(userId: number, deviceId: string, appName: string) {
    const device = await this.requireOwned(userId, deviceId);
    await devicesRepo.removeAppLimit(device.id, appName);
    return { success: true };
  },

  /**
   * 应用审核。批准后同时写入一条 60 分钟的应用时长限制 —— 与 mock 版行为一致，
   * 但区别是：批准的是真实存在的那条 pending 申请，而不是凭空构造记录。
   */
  async auditApp(userId: number, deviceId: string, appName: string, approved: boolean, reason = '') {
    const device = await this.requireOwned(userId, deviceId);
    const request = await devicesRepo.findAudit(device.id, appName);
    if (!request) throw new NotFoundError('待审核的应用申请', appName);

    await devicesRepo.reviewAudit(request.id, approved ? 'approved' : 'rejected', reason);
    if (approved) {
      await devicesRepo.upsertAppLimit(device.id, appName, {
        dailyLimitMinutes: 60,
        packageName: request.packageName,
      });
    }
    logger.info({ msg: 'app audit reviewed', deviceId: device.id, appName, approved });
    return { success: true };
  },

  async blockUrl(userId: number, deviceId: string, url: string) {
    const device = await this.requireOwned(userId, deviceId);
    // 归一化：去掉协议与路径，只留主机名，避免 "https://a.com/x" 与 "a.com" 重复拦截
    const normalized = url
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/\/.*$/, '');
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(normalized)) {
      throw new BadRequestError('请输入有效的域名，例如 gambling.com');
    }
    await devicesRepo.addBlockedUrl(device.id, normalized);
    await devicesRepo.setFeature(device.id, 'webBlock', true);
    return { success: true, url: normalized };
  },

  async unblockUrl(userId: number, deviceId: string, url: string) {
    const device = await this.requireOwned(userId, deviceId);
    await devicesRepo.removeBlockedUrl(device.id, url.trim().toLowerCase());
    return { success: true };
  },

  // ============================================================
  // 指令下发
  // ============================================================

  async lock(userId: number, device: ChildDevice, locked: boolean) {
    const reconciled = await reconcileTempUnlock(device);
    if (reconciled.locked === locked && !reconciled.tempUnlockUntil) {
      return { success: true, noop: true, command: null, device: toDeviceView(reconciled) };
    }
    // 关键：锁定必须<b>同时清掉 tempUnlockUntil</b>。
    // 否则「家长先点临时解锁（+30 分钟）、随后又点锁定」会锁不上 ——
    // 设备端把 tempUnlockUntil 当作优先级最高的放行依据，服务端没清，
    // 设备就会继续认为自己在放行期内，远程锁定静默失效。
    return dispatchCommand(
      reconciled,
      userId,
      locked ? 'lock' : 'unlock',
      {},
      locked
        ? { locked: true, tempUnlockUntil: null }
        : { locked: false, tempUnlockUntil: null },
    );
  },

  async tempUnlock(userId: number, device: ChildDevice, minutes: number) {
    const until = new Date(Date.now() + minutes * 60_000);
    return dispatchCommand(
      device,
      userId,
      'temp_unlock',
      { minutes, until: until.toISOString() },
      { locked: false, tempUnlockUntil: until },
    );
  },

  async cancelTempUnlock(userId: number, device: ChildDevice) {
    if (!device.tempUnlockUntil) {
      throw new BadRequestError('设备当前没有处于临时解锁状态');
    }
    return dispatchCommand(
      device,
      userId,
      'cancel_temp_unlock',
      {},
      { locked: true, tempUnlockUntil: null },
    );
  },

  /** 远程拍照 / 屏幕截图 / 录像 / 录音 —— 全部走指令队列。 */
  async requestCapture(
    userId: number,
    device: ChildDevice,
    type: 'remote_photo' | 'screenshot' | 'start_recording' | 'start_audio',
    payload: Record<string, unknown> = {},
  ) {
    // 这些能力必须在设备上真实执行，因此要求对应功能开关已打开
    const featureKey =
      type === 'remote_photo'
        ? 'remotePhoto'
        : type === 'screenshot'
          ? 'screenMonitor'
          : type === 'start_recording'
            ? 'videoRecord'
            : 'remoteRecord';
    await requireFeatureEnabled(device.id, featureKey);

    return dispatchCommand(device, userId, type, payload, {});
  },

  /**
   * 让设备重新上报已安装应用清单。
   *
   * 这是**唯一**一条「读类」指令：它不改变设备状态，只是让设备把清单发上来，
   * 好让家长端的「选择应用 / 功能管控」看到最新安装情况。
   * 仍然走指令队列而不是直接返回成功 —— 因为清单只有设备自己知道，
   * 服务端凭空回一个「已刷新」就是撒谎。
   */
  async requestAppSync(userId: number, device: ChildDevice) {
    return dispatchCommand(device, userId, 'sync_apps', {}, {});
  },

  async stopCapture(
    userId: number,
    device: ChildDevice,
    type: 'stop_recording' | 'stop_audio',
    recordingId: string,
  ) {
    // 只允许停止这台设备上确实存在过的录制
    const started = await prisma.deviceCommand.findFirst({
      where: {
        deviceId: device.id,
        type: type === 'stop_recording' ? 'start_recording' : 'start_audio',
        status: 'succeeded',
      },
      orderBy: { createdAt: 'desc' },
    });
    if (!started) throw new BadRequestError('该设备上没有正在进行的录制');
    const startedResult = started.result as { recordingId?: unknown } | null;
    const expectedId = typeof startedResult?.recordingId === 'string' ? startedResult.recordingId : undefined;
    if (expectedId && expectedId !== recordingId) {
      throw new BadRequestError('录制 ID 不匹配，可能已结束');
    }
    return dispatchCommand(device, userId, type, { recordingId }, {});
  },

  // ============================================================
  // 指令查询
  // ============================================================

  listCommands(device: ChildDevice, status: CommandStatus | undefined, limit: number) {
    return commandsService.list(device.id, status, limit);
  },

  cancelCommand(device: ChildDevice, commandId: string) {
    return commandsService.cancel(commandId, device.id);
  },

  // ============================================================
  // 设备端 Agent
  // ============================================================

  /**
   * 设备端注册（幂等）。
   * - 设备码不存在 → 新建一条待认领设备；
   * - 已存在 → 必须携带正确的 deviceSecret 才能续订令牌（防止别人拿设备码冒充）。
   */
  async registerAgent(input: {
    deviceCode: string;
    deviceSecret: string;
    name?: string;
    model: string;
    os: string;
    osVersion: string;
    agentVersion: string;
  }) {
    const existing = await devicesRepo.findByCode(input.deviceCode);

    if (existing) {
      const ok = await bcrypt.compare(input.deviceSecret, existing.deviceSecretHash);
      if (!ok) {
        logger.warn({ msg: 'agent register rejected: bad secret', deviceCode: input.deviceCode });
        throw new ForbiddenError('设备密钥不匹配，请清除本地数据后重新配对');
      }
      const updated = await devicesRepo.update(existing.id, {
        model: input.model,
        os: input.os,
        osVersion: input.osVersion,
        agentVersion: input.agentVersion,
        status: 'online',
        lastActiveAt: new Date(),
      });
      await devicesRepo.ensureDefaults(updated.id);
      return {
        success: true,
        created: false,
        deviceToken: signDeviceToken(updated.id, updated.userId),
        deviceId: updated.id,
        deviceCode: updated.deviceCode,
        bound: Boolean(updated.userId),
      };
    }

    const created = await devicesRepo.createUnbound({
      deviceCode: input.deviceCode,
      deviceSecretHash: await bcrypt.hash(input.deviceSecret, BCRYPT_ROUNDS),
      name: input.name?.trim() || `${input.model || '孩子'}的手机`,
      model: input.model,
      os: input.os,
      osVersion: input.osVersion,
      agentVersion: input.agentVersion,
    });
    await devicesRepo.ensureDefaults(created.id);

    logger.info({ msg: 'agent registered', deviceId: created.id, deviceCode: created.deviceCode });
    return {
      success: true,
      created: true,
      deviceToken: signDeviceToken(created.id, created.userId),
      deviceId: created.id,
      deviceCode: created.deviceCode,
      bound: false,
    };
  },

  /** 设备心跳：刷新在线状态、电量、网络。 */
  async heartbeat(
    deviceId: string,
    input: {
      battery?: number;
      network?: string;
      agentVersion?: string;
      effectiveLocked?: boolean;
      lockReason?: string;
    },
  ) {
    const updated = await devicesRepo.update(deviceId, {
      status: 'online',
      lastActiveAt: new Date(),
      ...(input.battery !== undefined ? { battery: input.battery } : {}),
      ...(input.network !== undefined ? { network: input.network } : {}),
      ...(input.agentVersion !== undefined ? { agentVersion: input.agentVersion } : {}),
      ...(input.effectiveLocked !== undefined ? { effectiveLocked: input.effectiveLocked } : {}),
      ...(input.lockReason !== undefined ? { lockReason: input.lockReason } : {}),
    });
    return {
      success: true,
      serverTime: new Date().toISOString(),
      bound: Boolean(updated.userId),
      // 回给设备的是<b>期望</b>状态，供设备端与服务端对齐
      locked: updated.locked,
      tempUnlockUntil: updated.tempUnlockUntil,
    };
  },

  /** 设备上报位置。抽稀：同一设备 30 秒内重复上报只留一条，防止轨迹表被心跳式上报撑爆。 */
  async reportLocation(
    deviceId: string,
    input: { latitude: number; longitude: number; accuracy?: number; address?: string; recordedAt?: Date },
  ) {
    const recordedAt = input.recordedAt ?? new Date();
    const recent = await prisma.locationRecord.findFirst({
      where: { deviceId },
      orderBy: { recordedAt: 'desc' },
    });
    if (recent && recordedAt.getTime() - recent.recordedAt.getTime() < 30_000) {
      const updated = await prisma.locationRecord.update({
        where: { id: recent.id },
        data: {
          latitude: input.latitude,
          longitude: input.longitude,
          accuracy: input.accuracy ?? 0,
          address: input.address ?? recent.address,
          recordedAt,
        },
      });
      return { success: true, deduplicated: true, location: updated };
    }

    const location = await prisma.locationRecord.create({
      data: {
        deviceId,
        latitude: input.latitude,
        longitude: input.longitude,
        accuracy: input.accuracy ?? 0,
        address: input.address ?? '',
        recordedAt,
      },
    });
    return { success: true, deduplicated: false, location };
  },

  // ============================================================
  // 内部辅助
  // ============================================================

  /** 归属校验的统一入口（越权一律 403）。 */
  async requireOwned(userId: number, deviceId: string): Promise<ChildDevice> {
    const device = await devicesRepo.findById(deviceId);
    if (!device) throw new NotFoundError('设备', deviceId);
    if (device.userId !== userId) throw new ForbiddenError('无权操作该设备');
    return device;
  },
};

/** 确认设备上某个功能开关已打开，否则拒绝下发对应指令。 */
async function requireFeatureEnabled(deviceId: string, featureKey: string): Promise<void> {
  const row = await prisma.deviceFeature.findUnique({
    where: { deviceId_key: { deviceId, key: featureKey } },
  });
  if (!row?.enabled) {
    const def = FEATURE_DEFS.find((f) => f.key === featureKey);
    throw new BadRequestError(`请先开启「${def?.label ?? featureKey}」功能`);
  }
}

export { buildFeaturesPayload, reconcileTempUnlock, todayKey, humanizeLastActive };
