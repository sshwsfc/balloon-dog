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
 * 「已被领取但迟迟没有结算」的判定阈值（回退重投递）。
 *
 * 取值必须比「设备端合法执行一条指令的最长时间」更大，否则会把还在正常执行
 * 的指令误判成死信、重复推给设备执行（设备端对指令没有幂等保护）。
 *
 * 设备端的最长合法路径不是长轮询周期，而是**采集类指令的上传**：
 * `CommandExecutor.execute()` 是同步的，`remote_photo` / `screenshot` /
 * `start_recording` 等要在里面把文件传给服务端，而
 * `Constants.UPLOAD_WRITE_TIMEOUT_MS = 120_000L` —— 即单次上传最长可以合法
 * 占住 120s，之后才 `enqueueReport` + `flushPendingReports` 回报。再叠加一次
 * 回报失败后的重试（≈25s 一轮主循环），合法上限约 145s。
 *
 * 所以取 240s：明显大于 145s 的合法上限（不会误判在途指令），又小于
 * COMMAND_TTL_SECONDS（默认 300s），保证卡死的指令仍能在过期**之前**被救回
 * （实际恢复延迟 = 240s ~ 240s+sweep 间隔）。
 */
export const STALE_DISPATCH_SECONDS = 240;

/**
 * 同一条指令最多重新投递几次。
 *
 * 为什么需要上限：重投递本身是「把 dispatched 退回 pending」，而设备端对
 * 指令**没有幂等/去重**保护 —— 若某条指令真的执行得很慢又始终不回报，
 * 无上限重投递会把它反复推给设备执行。2 是「给一次补救机会 + 一次容错」。
 *
 * 注意实际能否用满 2 次取决于 COMMAND_TTL_SECONDS：TTL 默认 300s、阈值 240s，
 * 两次重投之间还要等一个 sweep（60s），所以 TTL 保持 300s 时通常只来得及
 * 重投 1 次，第 2 次往往在 expiresAt 之后（重投条件要求 expiresAt > now，
 * 因此不会命中）。把 TTL 调大（例如 900s）才会真正用到第 2 次。
 */
export const MAX_REDELIVERIES = 2;

/** 重投递次数记在 payload 的内部字段里（`__` 前缀的字段不对外暴露，见 toCommandView）。 */
function redeliveryCount(payload: unknown): number {
  const value = (payload as Record<string, unknown> | null)?.__redeliveries;
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
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
  // `__` 前缀是服务端内部字段（__revert 回滚快照、__redeliveries 重投递计数），
  // 一律不对外暴露 —— 设备端与家长端看到的 payload 保持原样。
  const publicPayload = Object.fromEntries(
    Object.entries(payload).filter(([key]) => !key.startsWith('__')),
  );
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
   * 回退重投递：把「已被领取、但超过 STALE_DISPATCH_SECONDS 仍未结算」的指令
   * 退回 pending，让设备端下一次长轮询能重新领到它。
   *
   * 为什么需要这一层（而不只是修好等待者摘除）：等待者摘除解决的是「设备还活着
   * 且还会再来轮询」的情况 —— 新连接顶掉死连接的等待者即可拿到指令。但如果设备
   * 被杀之后**再也没起来**（孩子关机、卸载、令牌失效一直在报错），就永远不会有
   * 新连接来顶替，那条被死连接抢走的指令就只能等到 COMMAND_TTL_SECONDS 过期，
   * 家长端全程显示「已下发」。这个兜底把「等 300s 变 expired」变成「等 90s 自动重投」。
   *
   * 语义保持：dispatched 仍然表示「已被某个连接领取、正在等 ack」，这里只是把
   * **确实没有人 ack** 的那些退回 pending；已经结算（succeeded/failed/cancelled/
   * expired）的指令 status 已经变了，CAS 不会命中。
   *
   * @returns 本次重投递的条数
   */
  async sweepStaleDispatch(): Promise<number> {
    const cutoff = new Date(Date.now() - STALE_DISPATCH_SECONDS * 1000);
    const stale = await prisma.deviceCommand.findMany({
      where: { status: 'dispatched', dispatchedAt: { lt: cutoff }, expiresAt: { gt: new Date() } },
      take: 200,
    });
    if (stale.length === 0) return 0;

    let redelivered = 0;
    for (const command of stale) {
      const attempts = redeliveryCount(command.payload);
      if (attempts >= MAX_REDELIVERIES) {
        // 已经重投过上限次还是没人 ack：留在 dispatched，由 expiresAt 收尾。
        logger.warn({
          msg: 'stale dispatched command exhausted redeliveries',
          deviceId: command.deviceId,
          commandId: command.id,
          type: command.type,
          redeliveries: attempts,
        });
        continue;
      }
      const payload = {
        ...((command.payload ?? {}) as Record<string, unknown>),
        __redeliveries: attempts + 1,
      } as Prisma.InputJsonValue;
      const reset = await prisma.deviceCommand.updateMany({
        // CAS：必须仍是同一时刻被领取的那条。若设备在这几毫秒里刚回报成功，
        // status 已变成 succeeded，这里就不会命中，更不会把结果覆盖掉。
        where: { id: command.id, status: 'dispatched', dispatchedAt: command.dispatchedAt },
        data: { status: 'pending', dispatchedAt: null, payload },
      });
      if (reset.count === 1) {
        redelivered++;
        logger.warn({
          msg: 'stale dispatched command redelivered',
          deviceId: command.deviceId,
          commandId: command.id,
          type: command.type,
          redeliveries: attempts + 1,
          dispatchedAt: command.dispatchedAt?.toISOString(),
        });
      }
    }
    return redelivered;
  },

  /**
   * 清理超时未被领取的指令（由 server.ts 的定时任务调用）。
   * 返回本次处理的条数，供日志观察。
   *
   * 每次先把「领取了却没人 ack」的指令退回 pending（回退重投递），再清理
   * 真正过期的 —— 顺序不能反：先把能救的救回来，剩下的才判定为死信。
   */
  async sweepExpired(): Promise<number> {
    const redelivered = await commandsService.sweepStaleDispatch();
    if (redelivered > 0) logger.warn({ msg: 'stale dispatched commands redelivered', count: redelivered });

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
      // 与上面的乐观更新保持一致：锁定生效即代表临时解锁作废
      await prisma.childDevice.update({
        where: { id: deviceId },
        data: { locked: true, tempUnlockUntil: null },
      });
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
