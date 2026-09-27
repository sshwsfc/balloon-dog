import { Prisma } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { prisma } from '../../prisma';
import { logger } from '../../logger';
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
} from '../../errors';
import { signAdminToken } from '../../shared/tokens';
import { parsePagination } from '../../shared/deviceScope';
import { adminRepo } from './admin.repository';
import { commandsService, toCommandView } from '../devices/commands.service';
import { commandLabel } from '../devices/devices.constants';

/** 设备多久没上报心跳就算离线（与家长端 deviceScope 的口径保持一致）。 */
const OFFLINE_AFTER_MS = 3 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** 归一化到本地时区当天 0 点，用于按天分桶。 */
function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function dayKey(d: Date): string {
  const x = startOfDay(d);
  const m = String(x.getMonth() + 1).padStart(2, '0');
  const day = String(x.getDate()).padStart(2, '0');
  return `${x.getFullYear()}-${m}-${day}`;
}

/**
 * 把一批时间点按天分桶，补齐区间内没有数据的日期（前端画折线图不需要自己补零）。
 */
function bucketByDay(dates: Date[], days: number): { date: string; count: number }[] {
  const from = startOfDay(new Date(Date.now() - (days - 1) * DAY_MS));
  const buckets = new Map<string, number>();
  for (let i = 0; i < days; i++) {
    buckets.set(dayKey(new Date(from.getTime() + i * DAY_MS)), 0);
  }
  for (const d of dates) {
    const key = dayKey(d);
    if (buckets.has(key)) buckets.set(key, (buckets.get(key) ?? 0) + 1);
  }
  return [...buckets.entries()].map(([date, count]) => ({ date, count }));
}

/** 统一的「当前在线」条件。 */
function onlineCutoff(): Date {
  return new Date(Date.now() - OFFLINE_AFTER_MS);
}

export const adminService = {
  // ============================================================
  // 认证
  // ============================================================

  /** 管理员登录。账号不存在与密码错误返回同一句提示，避免账号枚举。 */
  async login(username: string, password: string) {
    const admin = await adminRepo.findByUsername(username);
    if (!admin) {
      // 即使账号不存在也做一次哈希比较，抹平响应时间差
      await adminRepo.dummyCompare(password);
      throw new UnauthorizedError('账号或密码错误');
    }
    const ok = await adminRepo.verify(admin.passwordHash, password);
    if (!ok) throw new UnauthorizedError('账号或密码错误');
    if (admin.status === 'disabled') throw new ForbiddenError('该管理员账号已被禁用');

    // touchLogin 的返回值才是本次登录时间；用更新后的对象组装响应，
    // 否则前端「最近登录」会显示上一次的时间。
    const fresh = await adminRepo.touchLogin(admin.id);
    logger.info({ msg: 'admin login', adminId: admin.id, username: admin.username });

    return {
      token: signAdminToken({ id: admin.id, username: admin.username, role: admin.role }),
      admin: publicAdmin(fresh),
    };
  },

  async getProfile(adminId: number) {
    const admin = await adminRepo.findById(adminId);
    if (!admin) throw new NotFoundError('管理员');
    return publicAdmin(admin);
  },

  async changeOwnPassword(adminId: number, oldPassword: string, newPassword: string) {
    const admin = await adminRepo.findById(adminId);
    if (!admin) throw new NotFoundError('管理员');
    const ok = await adminRepo.verify(admin.passwordHash, oldPassword);
    if (!ok) throw new UnauthorizedError('原密码错误');
    if (await bcrypt.compare(newPassword, admin.passwordHash)) {
      throw new BadRequestError('新密码不能与原密码相同');
    }
    await adminRepo.updatePassword(adminId, newPassword);
    logger.info({ msg: 'admin changed own password', adminId });
    return { success: true };
  },

  // ============================================================
  // 管理员账号管理（仅超级管理员）
  // ============================================================

  listAdmins() {
    return adminRepo.list();
  },

  async createAdmin(input: { username: string; password: string; name?: string; role: string }) {
    const existing = await adminRepo.findByUsername(input.username);
    if (existing) throw new ConflictError('该管理员账号已存在');
    const created = await adminRepo.create(input);
    logger.info({ msg: 'admin created', adminId: created.id, username: created.username, role: created.role });
    return created;
  },

  async resetAdminPassword(targetId: number, password: string, operatorId: number) {
    const target = await adminRepo.findById(targetId);
    if (!target) throw new NotFoundError('管理员', String(targetId));
    // 允许改自己的密码，但改他人密码要求是超级管理员（路由已用 requireSuperAdmin 兜住）
    if (target.id === operatorId) {
      throw new BadRequestError('修改自己的密码请使用「修改密码」入口');
    }
    await adminRepo.updatePassword(targetId, password);
    logger.info({ msg: 'admin password reset', targetId, operatorId });
    return { success: true };
  },

  /** 启用/禁用管理员。禁止禁用自己，也禁止禁用最后一个可用的超级管理员。 */
  async setAdminStatus(targetId: number, status: 'active' | 'disabled', operatorId: number) {
    const target = await adminRepo.findById(targetId);
    if (!target) throw new NotFoundError('管理员', String(targetId));
    if (target.id === operatorId) {
      throw new BadRequestError('不能修改自己的账号状态');
    }
    if (status === 'disabled' && target.role === 'super') {
      const others = await adminRepo.countByRole('super', { status: 'active', excludeId: targetId });
      if (others === 0) {
        throw new BadRequestError('至少需要保留一个启用状态的超级管理员');
      }
    }
    await adminRepo.setStatus(targetId, status);
    logger.info({ msg: 'admin status changed', targetId, status, operatorId });
    return { success: true };
  },

  /** 删除管理员。禁止删除自己与最后一个超级管理员。 */
  async removeAdmin(targetId: number, operatorId: number) {
    const target = await adminRepo.findById(targetId);
    if (!target) throw new NotFoundError('管理员', String(targetId));
    if (target.id === operatorId) {
      throw new BadRequestError('不能删除自己的账号');
    }
    if (target.role === 'super') {
      const others = await adminRepo.countByRole('super', { excludeId: targetId });
      if (others === 0) {
        throw new BadRequestError('至少需要保留一个超级管理员');
      }
    }
    await adminRepo.remove(targetId);
    logger.warn({ msg: 'admin removed', targetId, username: target.username, operatorId });
    return { success: true };
  },

  // ============================================================
  // 数据看板
  // ============================================================

  /**
   * 平台总览。
   * 一次性并发查询所有计数，避免串行造成的响应时间累积。
   * 趋势按天补齐（前端不需要自己填零）。
   */
  async stats(days: number) {
    const from = startOfDay(new Date(Date.now() - (days - 1) * DAY_MS));
    const cutoff = onlineCutoff();

    const [
      totalUsers,
      disabledUsers,
      newUsers,
      totalDevices,
      boundDevices,
      onlineDevices,
      lockedDevices,
      totalCommands,
      pendingCommands,
      failedCommands,
      succeededCommands,
      totalMedia,
      mediaAgg,
      totalLocations,
      totalSafeZones,
      totalQuizRecords,
      correctQuizRecords,
      totalSmsCodes,
      deviceRows,
    ] = await Promise.all([
      prisma.user.count(),
      prisma.user.count({ where: { status: 'disabled' } }),
      prisma.user.findMany({ where: { createdAt: { gte: from } }, select: { createdAt: true } }),
      prisma.childDevice.count(),
      prisma.childDevice.count({ where: { userId: { not: null } } }),
      prisma.childDevice.count({ where: { status: 'online', lastActiveAt: { gte: cutoff } } }),
      prisma.childDevice.count({ where: { locked: true } }),
      prisma.deviceCommand.count(),
      prisma.deviceCommand.count({ where: { status: 'pending' } }),
      prisma.deviceCommand.count({ where: { status: { in: ['failed', 'expired'] } } }),
      prisma.deviceCommand.count({ where: { status: 'succeeded' } }),
      prisma.mediaAsset.count(),
      prisma.mediaAsset.aggregate({ _sum: { sizeBytes: true } }),
      prisma.locationRecord.count(),
      prisma.safeZone.count(),
      prisma.quizRecord.count(),
      prisma.quizRecord.count({ where: { isCorrect: true } }),
      prisma.smsCode.count(),
      prisma.childDevice.findMany({ where: { createdAt: { gte: from } }, select: { createdAt: true } }),
    ]);

    const [commandRows, commandByType, commandByStatus, quizByType] = await Promise.all([
      prisma.deviceCommand.findMany({
        where: { createdAt: { gte: from } },
        select: { createdAt: true, status: true },
      }),
      prisma.deviceCommand.groupBy({ by: ['type'], _count: { _all: true } }),
      prisma.deviceCommand.groupBy({ by: ['status'], _count: { _all: true } }),
      prisma.quizRecord.groupBy({ by: ['type'], _count: { _all: true }, _sum: { rewardMinutes: true } }),
    ]);

    const settled = succeededCommands + failedCommands;
    const kpi = {
      totalUsers,
      activeUsers: totalUsers - disabledUsers,
      disabledUsers,
      newUsersInRange: newUsers.length,
      totalDevices,
      boundDevices,
      unboundDevices: totalDevices - boundDevices,
      onlineDevices,
      lockedDevices,
      totalCommands,
      pendingCommands,
      succeededCommands,
      failedCommands,
      // 只在有「已结束」指令时才算成功率，否则为 null（前端显示 —）
      commandSuccessRate: settled > 0 ? succeededCommands / settled : null,
      totalMedia,
      mediaBytes: mediaAgg._sum.sizeBytes ?? 0,
      totalLocations,
      totalSafeZones,
      totalQuizRecords,
      quizAccuracy: totalQuizRecords > 0 ? correctQuizRecords / totalQuizRecords : null,
      totalSmsCodes,
    };

    return {
      range: { days, from, to: new Date() },
      kpi,
      series: {
        users: bucketByDay(newUsers.map((u) => u.createdAt), days),
        devices: bucketByDay(deviceRows.map((d) => d.createdAt), days),
        commands: bucketByDay(commandRows.map((c) => c.createdAt), days),
      },
      breakdown: {
        commandsByType: commandByType
          .map((r) => ({ type: r.type, count: r._count._all }))
          .sort((a, b) => b.count - a.count),
        commandsByStatus: commandByStatus.map((r) => ({ status: r.status, count: r._count._all })),
        quizByType: quizByType.map((r) => ({
          type: r.type,
          count: r._count._all,
          rewardMinutes: r._sum.rewardMinutes ?? 0,
        })),
      },
    };
  },

  // ============================================================
  // 家长账号管理
  // ============================================================

  async listUsers(query: Record<string, unknown>) {
    const { page, pageSize, skip, take } = parsePagination(query, 20);
    const q = typeof query.q === 'string' ? query.q : undefined;
    const status = typeof query.status === 'string' ? query.status : undefined;

    const where: Prisma.UserWhereInput = {
      ...(status ? { status } : {}),
      ...(q
        ? {
            OR: [
              { phone: { contains: q } },
              { email: { contains: q } },
              { nickname: { contains: q, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const [total, rows] = await Promise.all([
      prisma.user.count({ where }),
      prisma.user.findMany({
        where,
        select: {
          id: true,
          phone: true,
          email: true,
          nickname: true,
          avatar: true,
          status: true,
          wechatOpenid: true,
          createdAt: true,
          _count: { select: { devices: true, commands: true, quizRecords: true, media: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take,
      }),
    ]);

    return {
      page,
      pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
      items: rows.map((u) => ({
        id: u.id,
        phone: u.phone,
        email: u.email,
        nickname: u.nickname,
        avatar: u.avatar,
        status: u.status,
        wechatBound: Boolean(u.wechatOpenid),
        createdAt: u.createdAt,
        deviceCount: u._count.devices,
        commandCount: u._count.commands,
        quizRecordCount: u._count.quizRecords,
        mediaCount: u._count.media,
      })),
    };
  },

  /** 家长账号详情：设备清单 + 各类计数 + 最近指令，够运营定位问题即可，不暴露孩子隐私内容。 */
  async getUserDetail(userId: number) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        phone: true,
        email: true,
        nickname: true,
        avatar: true,
        status: true,
        wechatOpenid: true,
        activeDeviceId: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    if (!user) throw new NotFoundError('家长账号', String(userId));

    const [devices, commandTotal, commandFailed, quizTotal, quizCorrect, mediaTotal, locationTotal] =
      await Promise.all([
        prisma.childDevice.findMany({
          where: { userId },
          select: {
            id: true,
            name: true,
            model: true,
            os: true,
            osVersion: true,
            status: true,
            locked: true,
            battery: true,
            lastActiveAt: true,
            deviceCode: true,
            boundAt: true,
            _count: { select: { commands: true, media: true, locations: true, quizRecords: true } },
          },
          orderBy: { createdAt: 'asc' },
        }),
        prisma.deviceCommand.count({ where: { requestedBy: userId } }),
        prisma.deviceCommand.count({ where: { requestedBy: userId, status: { in: ['failed', 'expired'] } } }),
        prisma.quizRecord.count({ where: { userId } }),
        prisma.quizRecord.count({ where: { userId, isCorrect: true } }),
        prisma.mediaAsset.count({ where: { userId } }),
        prisma.locationRecord.count({ where: { device: { userId } } }),
      ]);

    const recentCommands = await prisma.deviceCommand.findMany({
      where: { requestedBy: userId },
      orderBy: { createdAt: 'desc' },
      take: 10,
    });

    const cutoff = onlineCutoff();
    return {
      user: {
        ...user,
        wechatBound: Boolean(user.wechatOpenid),
        wechatOpenid: undefined, // 不给后台看原始 openid
      },
      stats: {
        deviceCount: devices.length,
        onlineDeviceCount: devices.filter(
          (d) => d.status === 'online' && d.lastActiveAt && d.lastActiveAt >= cutoff,
        ).length,
        commandTotal,
        commandFailed,
        quizTotal,
        quizCorrect,
        quizAccuracy: quizTotal > 0 ? quizCorrect / quizTotal : null,
        mediaTotal,
        locationTotal,
      },
      devices: devices.map((d) => ({
        id: d.id,
        name: d.name,
        model: d.model,
        os: d.osVersion ? `${d.os} ${d.osVersion}` : d.os,
        status: d.status === 'online' && d.lastActiveAt && d.lastActiveAt >= cutoff ? 'online' : 'offline',
        locked: d.locked,
        battery: d.battery,
        lastActiveAt: d.lastActiveAt,
        deviceCode: d.deviceCode,
        boundAt: d.boundAt,
        counts: d._count,
      })),
      recentCommands: recentCommands.map(toCommandView),
    };
  },

  /**
   * 启用/禁用家长账号。
   * 禁用后 middleware/auth 的每请求查库会让其已签发令牌立即失效 —— 无需额外吊销逻辑。
   */
  async setUserStatus(userId: number, status: 'active' | 'disabled') {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, nickname: true } });
    if (!user) throw new NotFoundError('家长账号', String(userId));
    await prisma.user.update({ where: { id: userId }, data: { status } });
    logger.warn({ msg: 'user status changed by admin', userId, status });
    return { success: true, status };
  },

  /** 删除家长账号：设备/指令/位置/媒体等由外键级联删除。 */
  async removeUser(userId: number) {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
    if (!user) throw new NotFoundError('家长账号', String(userId));
    // 落盘文件不在数据库级联范围内，先取出文件名再删记录
    const files = await prisma.mediaAsset.findMany({ where: { userId }, select: { filename: true } });
    await prisma.user.delete({ where: { id: userId } });
    logger.warn({ msg: 'user removed by admin', userId, mediaFiles: files.length });
    return { success: true, removedMediaFiles: files.length };
  },

  // ============================================================
  // 设备管理
  // ============================================================

  async listDevices(query: Record<string, unknown>) {
    const { page, pageSize, skip, take } = parsePagination(query, 20);
    const q = typeof query.q === 'string' ? query.q : undefined;
    const bound = typeof query.bound === 'boolean' ? query.bound : undefined;
    const status = typeof query.status === 'string' ? query.status : undefined;
    const locked = typeof query.locked === 'boolean' ? query.locked : undefined;
    const userId = typeof query.userId === 'number' ? query.userId : undefined;

    const where: Prisma.ChildDeviceWhereInput = {
      ...(userId ? { userId } : {}),
      ...(locked !== undefined ? { locked } : {}),
      ...(bound === true ? { userId: { not: null } } : {}),
      ...(bound === false ? { userId: null } : {}),
      ...(status === 'online'
        ? { status: 'online', lastActiveAt: { gte: onlineCutoff() } }
        : status === 'offline'
          ? { OR: [{ status: { not: 'online' } }, { lastActiveAt: { lt: onlineCutoff() } }] }
          : {}),
      ...(q
        ? {
            OR: [
              { name: { contains: q, mode: 'insensitive' } },
              { model: { contains: q, mode: 'insensitive' } },
              { deviceCode: { contains: q.toUpperCase() } },
            ],
          }
        : {}),
    };

    const [total, rows] = await Promise.all([
      prisma.childDevice.count({ where }),
      prisma.childDevice.findMany({
        where,
        select: {
          id: true,
          name: true,
          model: true,
          os: true,
          osVersion: true,
          status: true,
          battery: true,
          network: true,
          locked: true,
          tempUnlockUntil: true,
          deviceCode: true,
          agentVersion: true,
          lastActiveAt: true,
          createdAt: true,
          boundAt: true,
          user: { select: { id: true, phone: true, nickname: true, status: true } },
          _count: { select: { commands: true, media: true, locations: true, quizRecords: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take,
      }),
    ]);

    const cutoff = onlineCutoff();
    return {
      page,
      pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
      items: rows.map((d) => ({
        id: d.id,
        name: d.name,
        model: d.model,
        os: d.osVersion ? `${d.os} ${d.osVersion}` : d.os,
        online: d.status === 'online' && Boolean(d.lastActiveAt && d.lastActiveAt >= cutoff),
        battery: d.battery,
        network: d.network,
        locked: d.locked,
        tempUnlockUntil: d.tempUnlockUntil,
        deviceCode: d.deviceCode,
        agentVersion: d.agentVersion,
        lastActiveAt: d.lastActiveAt,
        createdAt: d.createdAt,
        boundAt: d.boundAt,
        // 以 user 关系判定是否已认领：未认领设备的 userId 为 null
        bound: Boolean(d.user),
        owner: d.user ? { id: d.user.id, phone: d.user.phone, nickname: d.user.nickname, status: d.user.status } : null,
        counts: d._count,
      })),
    };
  },

  async getDeviceDetail(deviceId: string) {
    // 先取设备本体（含 userId，用于判定绑定状态），再并发取附属配置
    const device = await prisma.childDevice.findUnique({ where: { id: deviceId } });
    if (!device) throw new NotFoundError('设备', deviceId);
    const [owner, features, timePlan, appLimits, blockedUrls, counts, recentCommands, pendingAudits, quizConfig] =
      await Promise.all([
        device.userId
          ? prisma.user.findUnique({
              where: { id: device.userId },
              select: { id: true, phone: true, nickname: true, status: true },
            })
          : Promise.resolve(null),
        prisma.deviceFeature.findMany({ where: { deviceId }, select: { key: true, enabled: true } }),
        prisma.timePlan.findUnique({ where: { deviceId } }),
        prisma.appLimit.findMany({ where: { deviceId } }),
        prisma.blockedUrl.findMany({ where: { deviceId } }),
        Promise.all([
          prisma.deviceCommand.count({ where: { deviceId } }),
          prisma.mediaAsset.count({ where: { deviceId } }),
          prisma.locationRecord.count({ where: { deviceId } }),
          prisma.quizRecord.count({ where: { deviceId } }),
        ]).then(([commands, media, locations, quizRecords]) => ({ commands, media, locations, quizRecords })),
        prisma.deviceCommand.findMany({ where: { deviceId }, orderBy: { createdAt: 'desc' }, take: 15 }),
        prisma.appAuditRequest.count({ where: { deviceId, status: 'pending' } }),
        prisma.quizConfig.findUnique({ where: { deviceId } }),
      ]);

    const cutoff = onlineCutoff();
    return {
      device: {
        id: device.id,
        name: device.name,
        model: device.model,
        os: device.osVersion ? `${device.os} ${device.osVersion}` : device.os,
        online: device.status === 'online' && Boolean(device.lastActiveAt && device.lastActiveAt >= cutoff),
        status: device.status,
        battery: device.battery,
        network: device.network,
        locked: device.locked,
        tempUnlockUntil: device.tempUnlockUntil,
        deviceCode: device.deviceCode,
        agentVersion: device.agentVersion,
        lastActiveAt: device.lastActiveAt,
        createdAt: device.createdAt,
        boundAt: device.boundAt,
        bound: Boolean(device.userId),
        counts,
      },
      owner,
      features: Object.fromEntries(features.map((f) => [f.key, f.enabled])),
      timePlan,
      appLimits: appLimits.map((a) => ({
        appName: a.appName,
        packageName: a.packageName,
        dailyLimitMinutes: a.dailyLimitMinutes,
        enabled: a.enabled,
      })),
      blockedUrls: blockedUrls.map((u) => u.url),
      pendingAuditCount: pendingAudits,
      quizConfig,
      recentCommands: recentCommands.map(toCommandView),
    };
  },


  /**
   * 强制解绑设备（客服场景：家长丢了账号、设备转手等）。
   * 只清归属关系，保留设备记录本身，这样设备端仍能继续心跳、等待新家长认领。
   */
  async forceUnbindDevice(deviceId: string) {
    const device = await prisma.childDevice.findUnique({
      where: { id: deviceId },
      select: { id: true, userId: true, name: true },
    });
    if (!device) throw new NotFoundError('设备', deviceId);
    if (!device.userId) throw new BadRequestError('该设备当前没有被任何账号绑定');

    await prisma.$transaction([
      // 清掉 owner 的 activeDeviceId 引用，避免指向一台已不属于他的设备
      prisma.user.updateMany({
        where: { id: device.userId, activeDeviceId: device.id },
        data: { activeDeviceId: null },
      }),
      prisma.childDevice.update({
        where: { id: device.id },
        data: { userId: null, boundAt: null },
      }),
    ]);

    logger.warn({ msg: 'device force unbound by admin', deviceId, previousOwner: device.userId });
    return { success: true, previousOwnerId: device.userId };
  },

  async removeDevice(deviceId: string) {
    const device = await prisma.childDevice.findUnique({
      where: { id: deviceId },
      select: { id: true, name: true, userId: true },
    });
    if (!device) throw new NotFoundError('设备', deviceId);
    const files = await prisma.mediaAsset.count({ where: { deviceId } });
    await prisma.childDevice.delete({ where: { id: deviceId } });
    logger.warn({ msg: 'device removed by admin', deviceId, mediaFiles: files });
    return { success: true, removedMediaFiles: files };
  },

  // ============================================================
  // 指令监控
  // ============================================================

  async listCommands(query: Record<string, unknown>) {
    const { page, pageSize, skip, take } = parsePagination(query, 20);
    const status = typeof query.status === 'string' ? query.status : undefined;
    const type = typeof query.type === 'string' ? query.type : undefined;
    const deviceId = typeof query.deviceId === 'string' ? query.deviceId : undefined;
    const userId = typeof query.userId === 'number' ? query.userId : undefined;
    const onlyFailed = query.onlyFailed === true;

    const where: Prisma.DeviceCommandWhereInput = {
      ...(status ? { status } : {}),
      ...(onlyFailed ? { status: { in: ['failed', 'expired'] } } : {}),
      ...(type ? { type } : {}),
      ...(deviceId ? { deviceId } : {}),
      ...(userId ? { requestedBy: userId } : {}),
    };

    const [total, rows] = await Promise.all([
      prisma.deviceCommand.count({ where }),
      prisma.deviceCommand.findMany({
        where,
        select: {
          id: true,
          deviceId: true,
          type: true,
          status: true,
          payload: true,
          result: true,
          error: true,
          createdAt: true,
          dispatchedAt: true,
          finishedAt: true,
          expiresAt: true,
          device: {
            select: { name: true, user: { select: { id: true, phone: true, nickname: true } } },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take,
      }),
    ]);

    return {
      page,
      pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
      items: rows.map((c) => {
        const payload = (c.payload ?? {}) as Record<string, unknown>;
        // __revert 是内部回滚快照，属于实现细节，不对后台暴露
        const { __revert: _revert, ...publicPayload } = payload;
        return {
          id: c.id,
          deviceId: c.deviceId,
          type: c.type,
          label: commandLabel(c.type),
          payload: publicPayload,
          status: c.status,
          result: c.result,
          error: c.error,
          createdAt: c.createdAt,
          dispatchedAt: c.dispatchedAt,
          finishedAt: c.finishedAt,
          expiresAt: c.expiresAt,
          deviceName: c.device?.name ?? '',
          owner: c.device?.user
            ? { id: c.device.user.id, phone: c.device.user.phone, nickname: c.device.user.nickname }
            : null,
        };
      }),
    };
  },

  /** 撤销一条还没被设备领取的指令（复用家长端的取消逻辑，含状态回滚）。 */
  async cancelCommand(commandId: string) {
    const command = await prisma.deviceCommand.findUnique({
      where: { id: commandId },
      select: { id: true, deviceId: true },
    });
    if (!command) throw new NotFoundError('指令', commandId);
    const result = await commandsService.cancel(commandId, command.deviceId);
    if (!result) throw new NotFoundError('指令', commandId);
    logger.warn({ msg: 'command cancelled by admin', commandId });
    return result;
  },

  // ============================================================
  // 题库管理
  // ============================================================

  async listQuestions(query: Record<string, unknown>) {
    const { page, pageSize, skip, take } = parsePagination(query, 20);
    const type = typeof query.type === 'string' ? query.type : undefined;
    const grade = typeof query.grade === 'string' ? query.grade : undefined;
    const q = typeof query.q === 'string' ? query.q : undefined;

    const where: Prisma.QuizQuestionWhereInput = {
      ...(type ? { type } : {}),
      ...(grade ? { grade } : {}),
      ...(q ? { question: { contains: q, mode: 'insensitive' } } : {}),
    };

    const [total, rows, byGrade] = await Promise.all([
      prisma.quizQuestion.count({ where }),
      prisma.quizQuestion.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take }),
      prisma.quizQuestion.groupBy({ by: ['grade', 'type'], _count: { _all: true } }),
    ]);

    return {
      page,
      pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
      items: rows.map((q2) => ({
        id: q2.id,
        type: q2.type,
        grade: q2.grade,
        question: q2.question,
        options: q2.options,
        correctAnswer: q2.correctAnswer,
        explanation: q2.explanation,
        createdAt: q2.createdAt,
      })),
      distribution: byGrade.map((r) => ({ grade: r.grade, type: r.type, count: r._count._all })),
    };
  },

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
    logger.info({ msg: 'quiz question created by admin', questionId: created.id });
    return created;
  },

  async updateQuestion(
    questionId: string,
    patch: {
      type?: string;
      grade?: string;
      question?: string;
      options?: string[];
      correctAnswer?: number;
      explanation?: string;
    },
  ) {
    const existing = await prisma.quizQuestion.findUnique({ where: { id: questionId } });
    if (!existing) throw new NotFoundError('题目', questionId);

    // 选项与答案可能只改其中一个，必须用「改完之后」的状态校验下标
    const finalOptions = patch.options ?? existing.options;
    const finalAnswer = patch.correctAnswer ?? existing.correctAnswer;
    if (finalAnswer >= finalOptions.length) {
      throw new BadRequestError('正确答案下标超出选项范围');
    }

    const updated = await prisma.quizQuestion.update({ where: { id: questionId }, data: patch });
    logger.info({ msg: 'quiz question updated by admin', questionId });
    return updated;
  },

  /**
   * 删除题目。
   * QuizRecord.questionId 是外键且 onDelete: Cascade —— 直接删会连带删掉孩子的答题历史。
   * 因此这里明确拒绝删除已有作答记录的题目，引导运营改为「修改题干」。
   */
  async removeQuestion(questionId: string) {
    const existing = await prisma.quizQuestion.findUnique({
      where: { id: questionId },
      select: { id: true, _count: { select: { records: true } } },
    });
    if (!existing) throw new NotFoundError('题目', questionId);
    if (existing._count.records > 0) {
      throw new ConflictError(
        `该题目已有 ${existing._count.records} 条答题记录，删除会一并清除孩子的答题历史。请改为修改题目内容。`,
      );
    }
    await prisma.quizQuestion.delete({ where: { id: questionId } });
    logger.warn({ msg: 'quiz question removed by admin', questionId });
    return { success: true };
  },

  // ============================================================
  // 答题记录
  // ============================================================

  async listQuizRecords(query: Record<string, unknown>) {
    const { page, pageSize, skip, take } = parsePagination(query, 20);
    const deviceId = typeof query.deviceId === 'string' ? query.deviceId : undefined;
    const userId = typeof query.userId === 'number' ? query.userId : undefined;
    const type = typeof query.type === 'string' ? query.type : undefined;
    const isCorrect = typeof query.isCorrect === 'boolean' ? query.isCorrect : undefined;

    const where: Prisma.QuizRecordWhereInput = {
      ...(deviceId ? { deviceId } : {}),
      ...(userId ? { userId } : {}),
      ...(type ? { type } : {}),
      ...(isCorrect !== undefined ? { isCorrect } : {}),
    };

    const [total, rows] = await Promise.all([
      prisma.quizRecord.count({ where }),
      prisma.quizRecord.findMany({
        where,
        select: {
          id: true,
          deviceId: true,
          questionId: true,
          type: true,
          questionText: true,
          userAnswer: true,
          isCorrect: true,
          rewardMinutes: true,
          createdAt: true,
          device: { select: { name: true, user: { select: { id: true, phone: true, nickname: true } } } },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take,
      }),
    ]);

    return {
      page,
      pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
      items: rows.map((r) => ({
        id: r.id,
        deviceId: r.deviceId,
        questionId: r.questionId,
        deviceName: r.device?.name ?? '',
        owner: r.device?.user ? { id: r.device.user.id, phone: r.device.user.phone, nickname: r.device.user.nickname } : null,
        type: r.type,
        question: r.questionText,
        userAnswer: r.userAnswer,
        isCorrect: r.isCorrect,
        rewardMinutes: r.rewardMinutes,
        createdAt: r.createdAt,
      })),
    };
  },

  // ============================================================
  // 短信验证码审计
  // ============================================================

  /**
   * 验证码发送记录。
   * **只返回手机号、用途、状态与次数，绝不返回 codeHash** —— 审计表不能成为破解入口。
   */
  async listSmsCodes(query: Record<string, unknown>) {
    const { page, pageSize, skip, take } = parsePagination(query, 20);
    const phone = typeof query.phone === 'string' ? query.phone : undefined;
    const purpose = typeof query.purpose === 'string' ? query.purpose : undefined;
    const state = typeof query.state === 'string' ? query.state : undefined;
    const now = new Date();

    const where: Prisma.SmsCodeWhereInput = {
      ...(phone ? { phone: { contains: phone } } : {}),
      ...(purpose ? { purpose } : {}),
      ...(state === 'consumed'
        ? { consumedAt: { not: null } }
        : state === 'pending'
          ? { consumedAt: null, expiresAt: { gt: now } }
          : state === 'expired'
            ? { consumedAt: null, expiresAt: { lte: now } }
            : {}),
    };

    const [total, rows, byPurpose] = await Promise.all([
      prisma.smsCode.count({ where }),
      prisma.smsCode.findMany({
        where,
        select: {
          id: true,
          phone: true,
          purpose: true,
          attempts: true,
          expiresAt: true,
          consumedAt: true,
          createdAt: true,
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take,
      }),
      prisma.smsCode.groupBy({ by: ['purpose'], _count: { _all: true } }),
    ]);

    return {
      page,
      pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
      items: rows.map((r) => ({
        id: r.id,
        phone: r.phone,
        purpose: r.purpose,
        attempts: r.attempts,
        state: r.consumedAt ? 'consumed' : r.expiresAt > now ? 'pending' : 'expired',
        expiresAt: r.expiresAt,
        consumedAt: r.consumedAt,
        createdAt: r.createdAt,
      })),
      distribution: byPurpose.map((r) => ({ purpose: r.purpose, count: r._count._all })),
    };
  },

  /** 清理已经无用（已消费或已过期）的验证码记录。 */
  async purgeSmsCodes() {
    const result = await prisma.smsCode.deleteMany({
      where: { OR: [{ consumedAt: { not: null } }, { expiresAt: { lt: new Date() } }] },
    });
    logger.info({ msg: 'sms codes purged by admin', count: result.count });
    return { success: true, deleted: result.count };
  },

  // ============================================================
  // 操作日志
  // ============================================================

  async listLogs(query: Record<string, unknown>) {
    const { page, pageSize, skip, take } = parsePagination(query, 30);
    const adminId = typeof query.adminId === 'number' ? query.adminId : undefined;
    const action = typeof query.action === 'string' ? query.action : undefined;
    const status = typeof query.status === 'number' ? query.status : undefined;
    const onlyFailed = query.onlyFailed === true;

    const where: Prisma.OperationLogWhereInput = {
      ...(adminId ? { adminId } : {}),
      ...(action ? { action: { contains: action, mode: 'insensitive' } } : {}),
      ...(status ? { status } : {}),
      ...(onlyFailed ? { status: { gte: 400 } } : {}),
    };

    const [total, rows] = await Promise.all([
      prisma.operationLog.count({ where }),
      prisma.operationLog.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take }),
    ]);

    return {
      page,
      pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
      items: rows,
    };
  },
};

/** 管理员对外视图：绝不包含 passwordHash。 */
function publicAdmin(admin: {
  id: number;
  username: string;
  name: string;
  role: string;
  status?: string;
  lastLoginAt?: Date | null;
  createdAt?: Date;
}) {
  return {
    id: admin.id,
    username: admin.username,
    name: admin.name,
    role: admin.role,
    status: admin.status ?? 'active',
    lastLoginAt: admin.lastLoginAt ?? null,
    createdAt: admin.createdAt ?? null,
  };
}
