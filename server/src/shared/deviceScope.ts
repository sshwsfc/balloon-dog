import { Request } from 'express';
import type { ChildDevice } from '@prisma/client';
import { prisma } from '../prisma';
import { BadRequestError, ForbiddenError, NotFoundError, UnauthorizedError } from '../errors';
import {
  LIVENESS_LABELS,
  LIVENESS_THRESHOLDS,
  type LivenessLevel,
} from '../features/devices/devices.constants';

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
 * 当前家长对一台设备的角色（规划 §5.1）。
 * - `owner`：`ChildDevice.userId` —— 可以解绑、可以管成员；
 * - `admin`：`DeviceMember.role === 'admin'` —— 和所有者一样能改设置、控制设备，但不能解绑/管成员；
 * - `viewer`：只读。
 */
export type DeviceRole = 'owner' | 'admin' | 'viewer';

export interface DeviceAccess {
  device: ChildDevice;
  role: DeviceRole;
  /** 成员记录 id；所有者是 null（所有者不写进 DeviceMember 表） */
  memberId: string | null;
}

/** 角色能不能写（改设置、下发指令、审批）。viewer 一律不能。 */
export function canWrite(role: DeviceRole): boolean {
  return role !== 'viewer';
}

/**
 * 校验设备归属 + 取角色。任何以 deviceId 为入参的接口都必须先过这里，
 * 否则会出现「换个 id 就能操作别人家孩子手机」的越权。
 *
 * 注意：这里**允许只读成员通过**。写接口要额外过 {@link resolveWritableDevice}
 * 或 {@link requireOwnerDevice} —— 把它们分开，是因为「看得到」和「改得动」
 * 混在一个函数里时，早晚会有一个写接口忘了收紧。
 */
export async function requireDeviceAccess(userId: number, deviceId: string): Promise<DeviceAccess> {
  const device = await prisma.childDevice.findUnique({ where: { id: deviceId } });
  if (!device) throw new NotFoundError('设备', deviceId);
  if (device.userId === userId) return { device, role: 'owner', memberId: null };

  const member = await prisma.deviceMember.findUnique({
    where: { deviceId_userId: { deviceId, userId } },
    select: { id: true, role: true },
  });
  if (!member) {
    // 不用 404 掩盖：明确告知无权限，便于前端提示（越权探测本身也不泄露更多信息）
    throw new ForbiddenError('无权操作该设备');
  }
  return { device, role: member.role === 'admin' ? 'admin' : 'viewer', memberId: member.id };
}

/** 所有者专属操作（解绑设备、管理家庭成员）。成员即使是 admin 也不行。 */
export async function requireOwnerDevice(userId: number, deviceId: string): Promise<ChildDevice> {
  const access = await requireDeviceAccess(userId, deviceId);
  if (access.role !== 'owner') {
    throw new ForbiddenError('只有设备的主人可以执行这个操作');
  }
  return access.device;
}

/** 取设备并断言「这个人写得动」；只读成员在这里被拦下。 */
export async function requireWritableDevice(userId: number, deviceId: string): Promise<ChildDevice> {
  const access = await requireDeviceAccess(userId, deviceId);
  if (!canWrite(access.role)) {
    throw new ForbiddenError('你是这台设备的只读成员，不能修改设置');
  }
  return access.device;
}

/**
 * 解析本次请求要操作的设备，优先级：
 *   1. 请求里显式指定的 deviceId（query 或 body）
 *   2. 用户档案上的 activeDeviceId（家长在「我的」里切换的那台）
 *   3. 该家长最早能访问的那台设备（自己绑的，或作为家庭成员被邀请的）
 *
 * 这样一来前端不传 deviceId 也能工作（兼容既有接口契约），
 * 同时每台设备的数据都是真实隔离的 —— mock 版那个全局单例 device 被彻底移除。
 *
 * 规划 §5.1 起，「能访问」= 所有者 或 DeviceMember 里的一条记录。
 */
async function pickDevice(req: Request): Promise<DeviceAccess> {
  const userId = currentUserId(req);
  const explicit =
    (typeof req.query.deviceId === 'string' && req.query.deviceId) ||
    (typeof req.body?.deviceId === 'string' && req.body.deviceId) ||
    '';

  if (explicit) {
    return requireDeviceAccess(userId, explicit);
  }

  // 自己绑的 + 作为家庭成员被邀请的，两类都算「我的设备」
  const reachable = { OR: [{ userId }, { members: { some: { userId } } }] };

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { activeDeviceId: true },
  });

  if (user?.activeDeviceId) {
    const active = await prisma.childDevice.findFirst({
      where: { id: user.activeDeviceId, ...reachable },
    });
    if (active) return requireDeviceAccess(userId, active.id);
    // activeDeviceId 指向已解绑/被移出的设备：顺手清掉，避免一直命中失效引用
    await prisma.user.update({ where: { id: userId }, data: { activeDeviceId: null } });
  }

  const fallback = await prisma.childDevice.findFirst({
    where: reachable,
    orderBy: { createdAt: 'asc' },
  });
  if (!fallback) {
    throw new NotFoundError('设备', '当前账号下还没有绑定任何设备');
  }
  return requireDeviceAccess(userId, fallback.id);
}

/** 读接口用：设备 + 角色（只读成员也拿得到）。 */
export async function resolveDeviceAccess(req: Request): Promise<DeviceAccess> {
  return pickDevice(req);
}

/** 读接口用：只关心设备本体。 */
export async function resolveDevice(req: Request): Promise<ChildDevice> {
  return (await pickDevice(req)).device;
}

/** 写接口用：只读成员在这里被 403 拦下，不给「悄悄改成功」的机会。 */
export async function resolveWritableDevice(req: Request): Promise<ChildDevice> {
  const access = await pickDevice(req);
  if (!canWrite(access.role)) {
    throw new ForbiddenError('你是这台设备的只读成员，不能修改设置');
  }
  return access.device;
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
 * 在线的**分级**（规划 §1.5）。
 *
 * 二值的 online/offline 分不清「刚切到后台」和「三天没开机」，而这两种情况家长
 * 该做的事完全不同：前者等一会儿，后者要去找孩子。所以按 lastActiveAt 分四档。
 *
 * 刻意<b>不</b>复用 {@link effectiveStatus}：那个函数服务于既有的「在线/离线」契约
 * （前端、后台、测试都在读），改它的语义会连带改动一大片；这里只做加法。
 */
export function livenessOf(
  device: Pick<ChildDevice, 'status' | 'lastActiveAt'>,
): LivenessLevel {
  if (!device.lastActiveAt) return 'never';
  const gap = Date.now() - device.lastActiveAt.getTime();
  if (gap >= LIVENESS_THRESHOLDS.lostAfterMs) return 'lost';
  if (gap >= LIVENESS_THRESHOLDS.offlineAfterMs) return 'offline';
  // 设备显式报过 offline 时，即使刚活跃过也如实降级（例如设备端主动汇报要下线）
  if (device.status !== 'online') return 'delayed';
  if (gap >= LIVENESS_THRESHOLDS.delayedAfterMs) return 'delayed';
  return 'online';
}

/**
 * 设备对外视图：字段名与前端既有契约保持一致（name/model/os/battery/status/
 * lastActive/network/locked/tempUnlock），避免前端为改字段名而大改。
 */
export function toDeviceView(device: ChildDevice, role: DeviceRole = 'owner') {
  return {
    id: device.id,
    /** 当前登录家长对这台设备的角色（规划 §5.1）：owner | admin | viewer */
    role,
    /** 前端据此隐藏写操作入口；服务端仍会独立校验，界面只是不骗人 */
    canWrite: canWrite(role),
    canManageMembers: role === 'owner',
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
    // 在线分级（规划 §1.5）：status 保持二值不动（既有契约），liveness 是它的细化
    liveness: livenessOf(device),
    livenessLabel: LIVENESS_LABELS[livenessOf(device)],
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
