import { Request } from 'express';
import type { ChildDevice } from '@prisma/client';
import { prisma } from '../prisma';
import { BadRequestError, ForbiddenError, NotFoundError, UnauthorizedError } from '../errors';

/** 设备超过这个时长没有上报心跳，就视为离线（哪怕 status 还写着 online）。 */
const OFFLINE_AFTER_MS = 3 * 60 * 1000;

/** 取出当前登录家长 id；非家长主体直接 401（设备令牌不能冒充家长）。 */
export function currentUserId(req: Request): number {
  if (req.auth?.kind !== 'user') {
    throw new UnauthorizedError('请先登录家长账号');
  }
  return req.auth.id;
}

/** 取出当前设备主体；非设备主体直接 401。 */
export function currentDeviceId(req: Request): string {
  if (req.auth?.kind !== 'device') {
    throw new UnauthorizedError('该接口仅设备端可访问');
  }
  return req.auth.id;
}

/**
 * 校验设备归属。任何以 deviceId 为入参的接口都必须先过这里，
 * 否则会出现「换个 id 就能操作别人家孩子手机」的越权。
 */
export async function requireOwnedDevice(userId: number, deviceId: string): Promise<ChildDevice> {
  const device = await prisma.childDevice.findUnique({ where: { id: deviceId } });
  if (!device) throw new NotFoundError('设备', deviceId);
  if (device.userId !== userId) {
    // 不用 404 掩盖：明确告知无权限，便于前端提示（越权探测本身也不泄露更多信息）
    throw new ForbiddenError('无权操作该设备');
  }
  return device;
}

/**
 * 解析本次请求要操作的设备，优先级：
 *   1. 请求里显式指定的 deviceId（query 或 body）
 *   2. 用户档案上的 activeDeviceId（家长在「我的」里切换的那台）
 *   3. 该家长最早绑定的那台设备
 *
 * 这样一来前端不传 deviceId 也能工作（兼容既有接口契约），
 * 同时每台设备的数据都是真实隔离的 —— mock 版那个全局单例 device 被彻底移除。
 */
export async function resolveDevice(req: Request): Promise<ChildDevice> {
  const userId = currentUserId(req);
  const explicit =
    (typeof req.query.deviceId === 'string' && req.query.deviceId) ||
    (typeof req.body?.deviceId === 'string' && req.body.deviceId) ||
    '';

  if (explicit) {
    return requireOwnedDevice(userId, explicit);
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { activeDeviceId: true },
  });

  if (user?.activeDeviceId) {
    const active = await prisma.childDevice.findFirst({
      where: { id: user.activeDeviceId, userId },
    });
    if (active) return active;
    // activeDeviceId 指向已解绑的设备：顺手清掉，避免一直命中失效引用
    await prisma.user.update({ where: { id: userId }, data: { activeDeviceId: null } });
  }

  const fallback = await prisma.childDevice.findFirst({
    where: { userId },
    orderBy: { createdAt: 'asc' },
  });
  if (!fallback) {
    throw new NotFoundError('设备', '当前账号下还没有绑定任何设备');
  }
  return fallback;
}

/** 设备的有效在线状态：兼顾 lastActiveAt 的时效性。 */
export function effectiveStatus(device: Pick<ChildDevice, 'status' | 'lastActiveAt'>): 'online' | 'offline' {
  if (device.status !== 'online') return 'offline';
  if (!device.lastActiveAt) return 'offline';
  return Date.now() - device.lastActiveAt.getTime() <= OFFLINE_AFTER_MS ? 'online' : 'offline';
}

/** 把「多久之前活跃」渲染成中文短句，供前端直接展示。 */
export function humanizeLastActive(lastActiveAt: Date | null): string {
  if (!lastActiveAt) return '从未活跃';
  const diffMs = Date.now() - lastActiveAt.getTime();
  if (diffMs < 60_000) return '刚刚';
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) return `${minutes}分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}小时前`;
  return `${Math.floor(hours / 24)}天前`;
}

/**
 * 设备对外视图：字段名与前端既有契约保持一致（name/model/os/battery/status/
 * lastActive/network/locked/tempUnlock），避免前端为改字段名而大改。
 */
export function toDeviceView(device: ChildDevice) {
  return {
    id: device.id,
    userId: String(device.userId),
    name: device.name,
    model: device.model,
    os: device.osVersion ? `${device.os} ${device.osVersion}`.trim() : device.os,
    osName: device.os,
    osVersion: device.osVersion,
    avatar: device.avatar,
    /** 隐藏桌面图标（§9）：家长端读的就是这个字段，写走 PUT /api/devices/:deviceId */
    hideIcon: device.hideIcon,
    battery: device.battery,
    status: effectiveStatus(device),
    lastActive: humanizeLastActive(device.lastActiveAt),
    lastActiveAt: device.lastActiveAt,
    network: device.network,
    locked: device.locked,
    // 设备端上报的<b>实际</b>锁定状态：与 locked（家长期望值）分开，
    // 这样家长才知道「作息时间到了所以锁了」和「我手动锁的」是两回事
    effectiveLocked: device.effectiveLocked,
    lockReason: device.lockReason,
    tempUnlock: device.tempUnlockUntil ? device.tempUnlockUntil.toISOString() : null,
    deviceCode: device.deviceCode,
    agentVersion: device.agentVersion,
    createdAt: device.createdAt,
  };
}

/** 校验并返回分页参数（页码从 1 开始，pageSize 上限 200，防止被拉全表）。 */
export function parsePagination(query: Record<string, unknown>, defaultSize = 20) {
  const page = Math.max(1, Number.parseInt(String(query.page ?? '1'), 10) || 1);
  const rawSize = Number.parseInt(String(query.pageSize ?? query.limit ?? defaultSize), 10) || defaultSize;
  const pageSize = Math.min(200, Math.max(1, rawSize));
  return { page, pageSize, skip: (page - 1) * pageSize, take: pageSize };
}

/** 断言字符串是合法的 deviceId 形态，避免把明显非法的 id 丢给数据库。 */
export function assertDeviceIdParam(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new BadRequestError('缺少设备 ID');
  }
  return value.trim();
}
