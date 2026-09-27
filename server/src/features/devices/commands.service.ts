import type { ChildDevice, DeviceCommand, Prisma } from '@prisma/client';
import { prisma } from '../../prisma';
import { logger } from '../../logger';
import { config } from '../../config';
import { commandLabel, isCommandType, type CommandType } from './devices.constants';
import { notifyDevice } from './devices.notifier';

/**
 * 设备指令队列。
 *
 * 这是「真实可用」与 mock 的分水岭：远程锁屏/拍照/录像这类能力，
 * 后端**无法自己完成**，必须有设备端 Agent 真正执行。
 * 所以后端只做三件事：
 *   1. 把指令以 pending 状态入队（带过期时间）；
 *   2. 设备端长轮询 claimNext() 领取，状态转 dispatched（用 compare-and-set 防并发重复领取）；
 *   3. 设备端 submitResult() 回报，状态转 succeeded/failed，并落地对应的状态变更。
 *
 * 家长端看到的 locked / tempUnlockUntil 是「期望状态」：下发时立即更新（保证 UI 即时反馈），
 * 若指令失败或过期则回滚到下发前的快照。
 */

/** 指令入队时的参数，附带回滚快照。 */
export interface EnqueueInput {
  type: CommandType;
  /** 业务参数，如临时解锁的 until。 */
  payload?: Record<string, unknown>;
  /** 下发前设备状态快照，用于指令失败/过期时回滚。 */
  revert?: Record<string, unknown>;
}

function commandExpiry(): Date {
  return new Date(Date.now() + config.COMMAND_TTL_SECONDS * 1000);
}

/**
 * 入队一条指令。调用方负责已做过设备归属校验。
 */
export async function enqueue(
  deviceId: string,
  input: EnqueueInput,
  requestedBy: number,
): Promise<DeviceCommand> {
  if (!isCommandType(input.type)) {
    throw new Error(`未知指令类型：${input.type}`);
  }
  const payload = {
    ...(input.payload ?? {}),
    ...(input.revert ? { __revert: input.revert } : {}),
  } as Prisma.InputJsonValue;

  const command = await prisma.deviceCommand.create({
    data: {
      deviceId,
      type: input.type,
      payload,
      requestedBy,
      expiresAt: commandExpiry(),
    },
  });

  logger.info({
    msg: 'command enqueued',
    deviceId,
    commandId: command.id,
    type: command.type,
    label: commandLabel(command.type),
  });

  // 唤醒可能正在长轮询的设备端
  notifyDevice(deviceId);
  return command;
}

export function toCommandView(c: DeviceCommand) {
  const payload = (c.payload ?? {}) as Record<string, unknown>;
  // __revert 是内部字段，不对外暴露
  const { __revert, ...publicPayload } = payload;
  return {
    id: c.id,
    deviceId: c.deviceId,
    type: c.type,
    label: commandLabel(c.type),
    payload: publicPayload,
    status: c.status,
    result: c.result ?? null,
    error: c.error,
    createdAt: c.createdAt,
    dispatchedAt: c.dispatchedAt,
    finishedAt: c.finishedAt,
    expiresAt: c.expiresAt,
  };
}

export const commandsService = {
  /** 家长端：查询某台设备的指令历史。 */
  async list(deviceId: string, status: string | undefined, limit: number) {
    const rows = await prisma.deviceCommand.findMany({
      where: { deviceId, ...(status ? { status } : {}) },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    return rows.map(toCommandView);
  },

  /** 家长端：撤销一条还没被设备领取的指令，并回滚状态。 */
  async cancel(commandId: string, deviceId: string) {
    const command = await prisma.deviceCommand.findFirst({ where: { id: commandId, deviceId } });
    if (!command) return null;
    if (command.status !== 'pending') {
      // 已经领取/完成的指令撤销没有意义，直接返回现状让前端提示
      return { command: toCommandView(command), cancelled: false };
    }
    const updated = await prisma.deviceCommand.update({
      where: { id: commandId },
      data: { status: 'cancelled', finishedAt: new Date(), error: '家长已撤销' },
    });
    await revertDeviceState(deviceId, command);
    logger.info({ msg: 'command cancelled', deviceId, commandId });
    return { command: toCommandView(updated), cancelled: true };
  },

  /**
   * 设备端：领取下一条待执行指令。
   * 用 updateMany 做 compare-and-set，避免同一设备多进程/多请求重复领取同一条指令。
   */
  async claimNext(deviceId: string): Promise<ReturnType<typeof toCommandView> | null> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const candidate = await prisma.deviceCommand.findFirst({
        where: { deviceId, status: 'pending', expiresAt: { gt: new Date() } },
        orderBy: { createdAt: 'asc' },
      });
      if (!candidate) return null;

      const claimed = await prisma.deviceCommand.updateMany({
        where: { id: candidate.id, status: 'pending' },
        data: { status: 'dispatched', dispatchedAt: new Date() },
      });
      if (claimed.count === 1) {
        const fresh = await prisma.deviceCommand.findUnique({ where: { id: candidate.id } });
        logger.info({ msg: 'command claimed', deviceId, commandId: candidate.id, type: candidate.type });
        if (fresh) return toCommandView(fresh);
      }
      // 被别人抢先领取了，重试下一条
    }
    return null;
  },

  /**
   * 设备端：回报执行结果，并落地状态变更。
   */
  async submitResult(
    commandId: string,
    deviceId: string,
    status: 'succeeded' | 'failed',
    result?: unknown,
    error?: string,
  ) {
    const command = await prisma.deviceCommand.findFirst({ where: { id: commandId, deviceId } });
    if (!command) return null;

    // 已完成/已过期/已撤销的指令不接受二次回报（设备重试是常见情况）
    if (['succeeded', 'failed', 'expired', 'cancelled'].includes(command.status)) {
      return { command: toCommandView(command), alreadySettled: true };
    }

    const updated = await prisma.deviceCommand.update({
      where: { id: commandId },
      data: {
        status,
        result: (result ?? undefined) as Prisma.InputJsonValue | undefined,
        error: error ?? '',
        finishedAt: new Date(),
      },
    });

    if (status === 'succeeded') {
      await applyDeviceState(deviceId, command);
    } else {
      await revertDeviceState(deviceId, command);
    }

    logger.info({
      msg: 'command settled',
      deviceId,
      commandId,
      type: command.type,
      status,
      error: error ?? undefined,
    });
    return { command: toCommandView(updated), alreadySettled: false };
  },

  /**
   * 清理超时未被领取的指令（由 server.ts 的定时任务调用）。
   * 返回本次处理的条数，供日志观察。
   */
  async sweepExpired(): Promise<number> {
    const stale = await prisma.deviceCommand.findMany({
      where: { status: { in: ['pending', 'dispatched'] }, expiresAt: { lt: new Date() } },
      take: 200,
    });
    if (stale.length === 0) return 0;

    for (const command of stale) {
      await prisma.deviceCommand.update({
        where: { id: command.id },
        data: {
          status: 'expired',
          finishedAt: new Date(),
          error: command.status === 'pending' ? '设备超时未响应' : '设备执行超时',
        },
      });
      // 过期的乐观状态必须回滚，否则界面会一直显示「已锁定」但设备其实没锁
      await revertDeviceState(command.deviceId, command);
    }
    logger.warn({ msg: 'expired commands swept', count: stale.length });
    return stale.length;
  },
};

/**
 * 指令成功后落地设备状态。
 * 只有「改变设备状态」类指令有副作用，拍照/录像这类不改状态。
 */
async function applyDeviceState(deviceId: string, command: DeviceCommand): Promise<void> {
  const payload = (command.payload ?? {}) as Record<string, unknown>;
  switch (command.type) {
    case 'lock':
      await prisma.childDevice.update({ where: { id: deviceId }, data: { locked: true } });
      break;
    case 'unlock':
      await prisma.childDevice.update({ where: { id: deviceId }, data: { locked: false } });
      break;
    case 'temp_unlock': {
      const until =
        typeof payload.until === 'string'
          ? new Date(payload.until)
          : new Date(Date.now() + 30 * 60_000);
      await prisma.childDevice.update({
        where: { id: deviceId },
        data: { locked: false, tempUnlockUntil: until },
      });
      break;
    }
    case 'cancel_temp_unlock':
      await prisma.childDevice.update({
        where: { id: deviceId },
        data: { locked: true, tempUnlockUntil: null },
      });
      break;
    default:
      // 无状态副作用
      break;
  }
}

/** 指令失败/过期/撤销时，把设备状态回滚到下发前的快照。 */
async function revertDeviceState(deviceId: string, command: DeviceCommand): Promise<void> {
  const payload = (command.payload ?? {}) as Record<string, unknown>;
  const revert = payload.__revert as Record<string, unknown> | undefined;
  if (!revert || Object.keys(revert).length === 0) return;

  const data: Record<string, unknown> = {};
  if ('locked' in revert) data.locked = Boolean(revert.locked);
  if ('tempUnlockUntil' in revert) {
    data.tempUnlockUntil = revert.tempUnlockUntil ? new Date(String(revert.tempUnlockUntil)) : null;
  }
  if (Object.keys(data).length === 0) return;

  await prisma.childDevice.update({ where: { id: deviceId }, data });
  logger.info({ msg: 'device state reverted', deviceId, commandId: command.id, type: command.type });
}

/** 供业务层构造回滚快照。 */
export function snapshotState(device: Pick<ChildDevice, 'locked' | 'tempUnlockUntil'>) {
  return {
    locked: device.locked,
    tempUnlockUntil: device.tempUnlockUntil ? device.tempUnlockUntil.toISOString() : null,
  };
}
