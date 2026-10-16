import bcrypt from 'bcryptjs';
import type { CallLogEntry, ChildDevice, DeviceMember, Prisma, SmsMessage } from '@prisma/client';
import { prisma } from '../../prisma';
import { logger } from '../../logger';
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from '../../errors';
import { FREE_DEVICE_LIMIT } from '../membership/membership.constants';
import { requireEntitlement, requireFeatureEntitlement } from '../membership/membership.guard';
import { signDeviceToken } from '../../shared/tokens';
import {
  humanizeLastActive,
  livenessOf,
  parsePagination,
  toDeviceView,
  canWrite,
  requireDeviceAccess,
  type DeviceRole,
} from '../../shared/deviceScope';
import { notificationsService } from '../notifications/notifications.service';
import { childrenService } from '../children/children.service';
import { devicesRepo } from './devices.repository';
import { commandsService, enqueue, snapshotState, toCommandView } from './commands.service';
import {
  FEATURE_DEFS,
  HEALTH_CHECK_DEFS,
  HEALTH_LEVEL_LABELS,
  HEALTH_PERMISSION_DEFS,
  LIVENESS_LABELS,
  LIVENESS_THRESHOLDS,
  OFFLINE_EVENT_DEDUPE_MS,
  TIME_REQUEST_DEDUPE_MS,
  DEVICE_MEMBER_LIMIT,
  DEVICE_MEMBER_ROLE_LABELS,
  TIME_REQUEST_KIND_LABELS,
  commandLabel,
  deriveHealthLevel,
  isFeatureKey,
  type CommandType,
  type DeviceMemberRole,
  type HealthLevel,
  type RemoteAction,
  type TimeRequestKind,
} from './devices.constants';
import type { AgentHealthGap } from './devices.dto';
import type { CommandStatus } from './devices.constants';
import { gapFixSteps, permissionFixSteps } from './devices.fix-steps';

const BCRYPT_ROUNDS = 10;

/** 设备绑定数量上限：防止被刷号，也让「家长」这个身份保持合理规模。 */
const MAX_DEVICES_PER_USER = 20;

/**
 * 家长批准一条安装申请后，设备获得多长时间的「允许安装」窗口（§3）。
 * 30 分钟与临时解锁同一量级：足够孩子把手上的安装流程走完，又不至于长期敞开。
 */
const INSTALL_APPROVAL_MINUTES = 30;
/** 前端 Features 契约需要的形状。 */
export interface FeaturesPayload {
  lockScreen: { enabled: boolean; locked: boolean };
  tempUnlock: { enabled: boolean; unlockTime: string | null };
  timePlan: { enabled: boolean; dailyLimit: number; usedToday: number };
  /**
   * appLimit.apps 的值从「数字」升级为「对象」（§4）：
   * 家长端要在应用限制列表里显示「今日已用 / 上限」，只有上限不够。
   * ⚠️ 跨端契约变更：web 侧 src/types/index.ts 与 HomePage.tsx 需同步。
   * 键仍然是 AppLimit.appName（展示名），因为前端本来就按展示名分组。
   */
  appLimit: { enabled: boolean; apps: Record<string, { dailyLimit: number; usedTodaySeconds: number }> };
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

/** 四段十进制、每段 0-255 —— 与设备端 `BlockedAddresses.isIpv4Literal` 同一口径。 */
function isValidIpv4(value: string): boolean {
  const parts = value.split('.');
  if (parts.length !== 4) return false;
  return parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

function ipv4ToInt(value: string): number {
  return value.split('.').reduce((acc, part) => acc * 256 + Number(part), 0) >>> 0;
}

function intToIpv4(value: number): string {
  return [24, 16, 8, 0].map((shift) => (value >>> shift) & 0xff).join('.');
}

/** `10.0.0.0/8` → 规范化（主机位清零、前缀 0-32 之间）；不是网段返回 null。 */
function normalizeCidr(value: string): string | null {
  const slash = value.indexOf('/');
  if (slash <= 0) return null;
  const address = value.slice(0, slash);
  const prefixText = value.slice(slash + 1);
  if (!isValidIpv4(address) || !/^\d{1,2}$/.test(prefixText)) return null;
  const prefix = Number(prefixText);
  if (prefix < 0 || prefix > 32) return null;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  const network = (ipv4ToInt(address) & mask) >>> 0;
  return `${intToIpv4(network)}/${prefix}`;
}

/**
 * 归一化一条网址拦截规则：域名 → 主机名；IP / 网段 → 规范写法；其它 → null。
 *
 * 为什么允许 IP 与网段（规划 §4.1）：只拦域名有个天然漏洞 —— 解析过一次的 IP 会留在
 * 应用自己的缓存里，而直连 IP 根本不经过 DNS。设备端会把 IP/网段变成**隧道路由**，
 * 于是不管孩子从哪拿到这个 IP、走哪个端口（含 853 的 DoT），包都会被丢掉。
 * 这里与设备端 `BlockedAddresses` 必须同一口径，否则家长填得进去、设备端不认。
 */
function normalizeBlockedEntry(raw: string): string | null {
  const value = raw.trim().toLowerCase();
  if (value.length === 0) return null;
  // 先判 IP 与网段：网段里的斜杠不能当成 URL 路径砍掉
  if (isValidIpv4(value)) return value;
  const cidr = normalizeCidr(value);
  if (cidr !== null) return cidr;
  // IPv6 字面量：只做「看起来像」的判断（设备端同样只支持字面量，不支持 v6 网段）
  if (value.includes(':') && /^[0-9a-f:]+$/.test(value)) return value;
  // 域名 / 网址：去掉协议、userinfo、路径、查询、端口与通配前缀
  let host = value.replace(/^https?:\/\//, '');
  host = host.replace(/^[^/@]*@/, '');
  host = host.split(/[/?#]/)[0] ?? '';
  host = host.split(':')[0] ?? '';
  host = host.replace(/^\*\./, '').replace(/^\.+|\.+$/g, '');
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(host)) {
    return null;
  }
  return host;
}

/** 电话/短信单次上报保留的最大条数（与 DTO 的上限一致），超出按时间倒序截断。 */
const MAX_CALL_SMS_ROWS = 500;

/**
 * 设备时钟可能不准，甚至因为改系统时间而报出未来时间。
 * 服务端不信任它：未来时间一律钳到现在，避免「最新一条永远在最上面」的假象。
 */
function clampOccurredAt(value: Date | undefined): Date {
  const t = value ? value.getTime() : Date.now();
  if (!Number.isFinite(t)) return new Date();
  return new Date(Math.min(t, Date.now()));
}

function toCallView(row: CallLogEntry) {
  return {
    id: row.id,
    phoneNumber: row.phoneNumber,
    name: row.name,
    type: row.type,
    durationSeconds: row.durationSeconds,
    occurredAt: row.occurredAt,
  };
}

function toSmsView(row: SmsMessage) {
  return {
    id: row.id,
    address: row.address,
    body: row.body,
    type: row.type,
    occurredAt: row.occurredAt,
  };
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
      apps: Object.fromEntries(
        appLimits
          // 没有包名的行是历史缺陷的产物，设备端会直接丢弃 —— 不往家长端展示，
          // 免得家长看到一条「设了但其实不存在」的限制。
          .filter((a) => a.enabled && a.packageName.trim().length > 0)
          .map((a) => [
            a.appName,
            {
              dailyLimit: a.dailyLimitMinutes,
              packageName: a.packageName,
              // 跨天显示归零：与 TimePlan 一样在读取路径上惰性处理，不靠定时任务。
              // 这里只影响展示，不回写 —— 设备端的下一次全量上报会覆盖当日值。
              usedTodaySeconds: a.usageDay === todayKey() ? a.usedTodaySeconds : 0,
            },
          ]),
      ),
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
    // 健康摘要一次查回来（规划 §1.2）：设备列表每台一个健康点，
    // 不能变成「每台设备打一次 /device/health」的 N+1
    const summaries = await devicesRepo.healthSummaries(devices.map((d) => d.id));
    const byDevice = new Map(summaries.map((s) => [s.deviceId, s]));
    // 待审批的申请也一次查回来（§3.1）：家长端「我的」和首页的角标要用，
    // 同样不能变成每台设备一次查询
    const pendingRequests = await this.pendingTimeRequestCounts(devices.map((d) => d.id));
    // 角色也一次查回来（§5.1）：列表里每台设备都要标「我是主人还是只读成员」，
    // 逐台去问数据库就是 N+1
    const memberships = await devicesRepo.memberRolesForUser(userId);
    const roleByDevice = new Map<string, DeviceRole>(
      memberships.map((m) => [m.deviceId, m.role === 'admin' ? 'admin' : 'viewer']),
    );
    return devices.map((d) => {
      const summary = byDevice.get(d.id);
      const role: DeviceRole = d.userId === userId ? 'owner' : (roleByDevice.get(d.id) ?? 'viewer');
      return {
        ...toDeviceView(d, role),
        /**
         * 从没上报过的设备是 `null`，不是 `ok` ——
         * 列表上画一个绿点等于替设备担保，而我们根本不知道它现在的状态。
         */
        healthLevel: summary?.level ?? null,
        openGaps: summary?.openGaps ?? null,
        healthReportedAt: summary?.reportedAt ?? null,
        /** 待审批的申请条数：0 是「问过了，没有」，不是「不知道」 */
        pendingTimeRequests: pendingRequests[d.id] ?? 0,
      };
    });
  },

  async getDeviceView(userId: number, device: ChildDevice) {
    const reconciled = await reconcileTempUnlock(device);
    // 待审批条数：首页顶部那条「孩子有 N 条申请在等你」靠它。
    // 单台设备一次 count，走 (deviceId, status) 索引。
    const pending = await this.pendingTimeRequestCounts([reconciled.id]);
    const role = await this.roleFor(userId, reconciled);
    return {
      ...toDeviceView(reconciled, role),
      pendingTimeRequests: pending[reconciled.id] ?? 0,
    };
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

    // 绑定数量受会员档位限制：普通账号 1 台，会员起放宽到 MAX_DEVICES_PER_USER。
    //
    // 顺序很重要：先问会员够不够，再问系统够不够。反过来的话，
    // 一个普通账号绑第 2 台时会先撞上「最多只能绑定 20 台设备」这种莫名其妙的报错。
    const count = await devicesRepo.countByUser(userId);
    if (count >= FREE_DEVICE_LIMIT) {
      await requireEntitlement(userId, 'multiDevice');
    }
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

  async updateDevice(
    userId: number,
    deviceId: string,
    data: { name?: string; avatar?: string; hideIcon?: boolean },
  ) {
    if (Object.keys(data).length === 0) throw new BadRequestError('没有需要更新的字段');
    const device = await this.requireWritable(userId, deviceId);
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
    const device = await this.requireAccess(userId, deviceId);
    await prisma.user.update({ where: { id: userId }, data: { activeDeviceId: device.id } });
    const role = await this.roleFor(userId, device);
    return { success: true, device: toDeviceView(device, role) };
  },

  // ============================================================
  // 家庭成员（规划 §5.1）
  // ============================================================

  /**
   * 家庭成员列表。所有者排第一 —— 他不在 DeviceMember 表里，
   * 只返回成员表的话界面会出现「设备没有主人」这种荒唐的空列表。
   */
  async listDeviceMembers(device: ChildDevice) {
    // userId 在库里可空（历史数据）：无主设备照样能列出成员，只是没有「设备主人」那一行
    const ownerUserId = device.userId;
    const [owner, members] = await Promise.all([
      ownerUserId
        ? prisma.user.findUnique({
            where: { id: ownerUserId },
            select: { id: true, nickname: true, phone: true, avatar: true },
          })
        : Promise.resolve(null),
      devicesRepo.listDeviceMembers(device.id),
    ]);
    return {
      members: [
        {
          id: 'owner',
          deviceId: device.id,
          userId: ownerUserId ?? 0,
          nickname: owner?.nickname || (maskPhone(owner?.phone ?? null) ?? ''),
          phone: maskPhone(owner?.phone ?? null),
          avatar: owner?.avatar ?? null,
          role: 'owner' as const,
          roleLabel: '设备主人',
          isOwner: true,
          createdAt: device.createdAt,
        },
        ...members.map((m) => ({ ...toDeviceMemberView(m), isOwner: false })),
      ],
      roleLabels: DEVICE_MEMBER_ROLE_LABELS,
      limit: DEVICE_MEMBER_LIMIT,
    };
  },

  /**
   * 邀请一位家长共同守护这台设备（只有所有者能邀请）。
   *
   * admin 成员不能再拉人：权限一旦能自己复制自己，一天之内就会长出谁也没批过的第三方，
   * 而所有者对此毫不知情 —— 共同守护必须始终只有一个入口。
   */
  async inviteDeviceMember(
    device: ChildDevice,
    input: { phone: string; role: DeviceMemberRole; nickname?: string },
  ) {
    const target = await devicesRepo.findUserByPhone(input.phone);
    if (!target) throw new NotFoundError('该手机号对应的账号', input.phone);
    if (target.id === device.userId) throw new ConflictError('这台设备本来就是 Ta 的，不用邀请');
    if (target.status !== 'active') throw new ForbiddenError('该账号已被禁用，不能加入');
    if (await devicesRepo.findDeviceMemberByUser(device.id, target.id)) {
      throw new ConflictError('Ta 已经在共同守护这台设备了');
    }
    const count = await devicesRepo.countDeviceMembers(device.id);
    if (count >= DEVICE_MEMBER_LIMIT) {
      throw new ConflictError(`一台设备最多 ${DEVICE_MEMBER_LIMIT} 位家庭成员`);
    }
    const created = await devicesRepo.createDeviceMember({
      deviceId: device.id,
      userId: target.id,
      role: input.role,
      nickname: input.nickname ?? '',
      invitedBy: device.userId ?? null,
    });

    // 静默把人加进来，对方会以为账号被人动了手脚 —— 这一条通知是义务，不是礼貌
    const owner = device.userId
      ? await prisma.user.findUnique({
          where: { id: device.userId },
          select: { nickname: true, phone: true },
        })
      : null;
    await notificationsService.notify({
      userId: target.id,
      type: 'device_shared',
      title: '{{v0}} 邀请你一起守护「{{v1}}」',
      titleParams: {
        v0: owner?.nickname || maskPhone(owner?.phone ?? null) || '设备的主人',
        v1: device.name,
      },
      body: '你的角色是 {{v0}}，{{v1}}。',
      bodyParams: {
        v0: DEVICE_MEMBER_ROLE_LABELS[input.role],
        v1: input.role === 'admin' ? '可以查看和修改设置、控制设备' : '只能查看，不能改设置',
      },
      linkPath: '/devices',
      deviceId: device.id,
      dedupeKey: `device_shared:${device.id}:${target.id}`,
    });

    logger.info(
      { msg: 'device member invited', deviceId: device.id, memberId: created.id, role: input.role },
      '家庭成员已邀请',
    );
    return toDeviceMemberView(created);
  },

  /** 改成员的角色/称呼。改角色而不是「删掉再加」：邀请通知不该因为改角色重发一次。 */
  async updateDeviceMember(
    device: ChildDevice,
    memberId: string,
    input: { role?: DeviceMemberRole; nickname?: string },
  ) {
    const member = await this.requireMemberOf(device, memberId);
    const updated = await devicesRepo.updateDeviceMember(member.id, {
      ...(input.role !== undefined ? { role: input.role } : {}),
      ...(input.nickname !== undefined ? { nickname: input.nickname } : {}),
    });
    logger.info(
      { msg: 'device member updated', deviceId: device.id, memberId, role: updated.role },
      '家庭成员已更新',
    );
    return toDeviceMemberView(updated);
  },

  /** 移除成员：只断开关联，不删账号 —— 他可能还在守护别的设备。 */
  async removeDeviceMember(device: ChildDevice, memberId: string) {
    const member = await this.requireMemberOf(device, memberId);
    await devicesRepo.deleteDeviceMember(member.id);
    logger.info({ msg: 'device member removed', deviceId: device.id, memberId }, '家庭成员已移除');
    return { success: true };
  },

  /**
   * 成员必须属于**这台**设备。
   * 只按 id 查再删，等于给了「拿别人家的成员 id 来删」的越权路径 ——
   * 设备归属与成员归属是两件事，都要查。
   */
  async requireMemberOf(device: ChildDevice, memberId: string) {
    const member = await devicesRepo.findDeviceMember(memberId);
    if (!member || member.deviceId !== device.id) throw new NotFoundError('家庭成员', memberId);
    return member;
  },

  /** 该家长在这台设备上的角色（单台查询版；列表用 memberRolesForUser 批量取）。 */
  async roleFor(userId: number, device: ChildDevice): Promise<DeviceRole> {
    if (device.userId === userId) return 'owner';
    const member = await devicesRepo.findDeviceMemberByUser(device.id, userId);
    return member?.role === 'admin' ? 'admin' : 'viewer';
  },

  // ============================================================
  // 功能配置
  // ============================================================

  async setFeature(userId: number, deviceId: string, key: string, enabled: boolean) {
    if (!isFeatureKey(key)) throw new BadRequestError(`未知的功能标识：${key}`);
    const device = await this.requireWritable(userId, deviceId);

    // 只拦「打开」：关掉一个高级功能永远要允许，否则会员到期后
    // 家长连关都关不掉，只能看着一个用不了还亮着的开关。
    if (enabled) await requireFeatureEntitlement(userId, key);

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
    const device = await this.requireWritable(userId, deviceId);
    await devicesRepo.setTimePlan(device.id, {
      dailyLimitMinutes,
      ...(enabled !== undefined ? { enabled } : {}),
    });
    // 时间规划一旦设置，就把对应开关打开
    await devicesRepo.setFeature(device.id, 'timePlan', true);
    return { success: true };
  },

  /**
   * 设置某台设备上某个应用的每日限额。
   *
   * <p>**包名是必填且必须来自设备上报的应用清单**（`DeviceApp`）：
   * 设备端 `GuardRules.matchAppLimit` 是拿前台窗口的包名去匹配规则的，
   * 没有包名（或包名对不上、或那个包没有桌面入口）的规则在设备上永远不会触发。
   * 历史缺陷就是家长端只发应用名 → 库里存了 `packageName=''` → 设备端 `parseAll`
   * 直接丢弃 → 家长端「已用 0 分钟」永远是 0。
   *
   * <p>在这里把「能拦到」当成写入的前置条件，比在设备端放宽兜底更安全：
   * 设备端那个 `pkg.isEmpty() → continue` 是防脏数据的最后一道闸，不该为了
   * 上游的丢包问题把它拆掉。
   */
  async setAppLimit(
    userId: number,
    deviceId: string,
    appName: string,
    packageName: string,
    limit: number,
  ) {
    const device = await this.requireWritable(userId, deviceId);
    const pkg = packageName.trim();
    if (!pkg) {
      throw new BadRequestError('缺少应用包名：请从孩子设备上报的应用清单里选择应用');
    }
    const app = await devicesRepo.findDeviceApp(device.id, pkg);
    if (!app) {
      throw new BadRequestError('该应用不在孩子设备上报的应用清单里，请先在设备上刷新应用清单');
    }
    if (!app.isLaunchable) {
      throw new BadRequestError('该应用没有桌面入口，设备端无法做限时拦截');
    }
    // 历史缺陷留下的空包名行在写入路径上顺手清掉
    await devicesRepo.removeAppLimitsWithoutPackage(device.id);
    await devicesRepo.upsertAppLimit(device.id, app.appName || appName, {
      dailyLimitMinutes: limit,
      packageName: pkg,
    });
    await devicesRepo.setFeature(device.id, 'appLimit', true);
    return { success: true };
  },

  async removeAppLimit(userId: number, deviceId: string, appName: string) {
    const device = await this.requireWritable(userId, deviceId);
    await devicesRepo.removeAppLimit(device.id, appName);
    return { success: true };
  },

  /**
   * 应用审核：批准后开一个 30 分钟的「允许安装」窗口
   * （ChildDevice.installApprovalUntil），随 /api/agent/config 下发 ——
   * 否则孩子就算被批准了，设备端的安装拦截也仍然拦着，家长会以为批准没生效。
   *
   * <p>**这里不再建逐应用限额**（旧实现会写一条 60 分钟限额）。设备端上报的
   * `packageName` 其实是**安装器自己**的包名（`LockWatchdogService` 只能看到
   * 「安装器窗口出现了」，看不到孩子要装的是哪个包），而安装器没有桌面入口：
   * `AppInventory.isLaunchable=false` ⇒ `GuardRules.matchAppLimit` 第一道闸门
   * `if (!isLaunchable) return null;` 永远返回 null ⇒ 那是一条永不触发的假规则。
   * 逐应用限时的入口收敛到「家长从设备应用清单里选应用」（{@link setAppLimit}）。
   *
   * <p>批准时顺手清掉历史版本留下的、作用在不可启动包上的死规则。
   */
  async auditApp(userId: number, deviceId: string, appName: string, approved: boolean, reason = '') {
    const device = await this.requireWritable(userId, deviceId);
    const request = await devicesRepo.findAudit(device.id, appName);
    if (!request) throw new NotFoundError('待审核的应用申请', appName);

    await devicesRepo.reviewAudit(request.id, approved ? 'approved' : 'rejected', reason);
    if (approved) {
      // 自愈：清掉旧版本用安装器包名建的那条永不触发的限额
      await devicesRepo.removeDeadAppLimit(device.id, request.packageName);
      await devicesRepo.update(device.id, {
        installApprovalUntil: new Date(Date.now() + INSTALL_APPROVAL_MINUTES * 60_000),
      });
    }
    logger.info({ msg: 'app audit reviewed', deviceId: device.id, appName, approved });
    return { success: true };
  },

  async blockUrl(userId: number, deviceId: string, url: string) {
    const device = await this.requireWritable(userId, deviceId);
    // 归一化：去掉协议与路径，只留主机名，避免 "https://a.com/x" 与 "a.com" 重复拦截
    const trimmed = url.trim().toLowerCase();
    const normalized = normalizeBlockedEntry(trimmed);
    if (normalized === null) {
      throw new BadRequestError('请输入有效的域名或 IP，例如 gambling.com、1.2.3.4');
    }
    await devicesRepo.addBlockedUrl(device.id, normalized);
    await devicesRepo.setFeature(device.id, 'webBlock', true);
    return { success: true, url: normalized };
  },

  async unblockUrl(userId: number, deviceId: string, url: string) {
    const device = await this.requireWritable(userId, deviceId);
    // 用与写入同一套归一化：家长端列表里显示的就是归一化后的串，但 IP / 网段
    // 在 URL 里要转义（`10.0.0.0/8` 的斜杠），所以这里再兜一次，免得删不掉。
    const normalized = normalizeBlockedEntry(url.trim().toLowerCase()) ?? url.trim().toLowerCase();
    await devicesRepo.removeBlockedUrl(device.id, normalized);
    return { success: true };
  },

  // ============================================================
  // 电话与短信（§8）—— 家长端只读列表
  // ============================================================

  /** 通话记录列表（分页）。设备由调用方通过 resolveDevice 解析并完成归属校验。 */
  async listCalls(
    device: ChildDevice,
    query: { type?: string; q?: string; page?: number; pageSize?: number; limit?: number },
  ) {
    const { page, pageSize, skip, take } = parsePagination(query as Record<string, unknown>);
    const where = {
      deviceId: device.id,
      ...(query.type ? { type: query.type } : {}),
      ...(query.q
        ? { OR: [{ phoneNumber: { contains: query.q } }, { name: { contains: query.q } }] }
        : {}),
    };
    const [total, rows] = await Promise.all([
      prisma.callLogEntry.count({ where }),
      prisma.callLogEntry.findMany({ where, orderBy: { occurredAt: 'desc' }, skip, take }),
    ]);
    return {
      page,
      pageSize,
      total,
      totalPages: Math.ceil(total / pageSize) || 1,
      items: rows.map(toCallView),
    };
  },

  /** 短信列表（分页）。正文只回给家长，绝不出现在任何 /api/admin/* 响应里。 */
  async listSms(
    device: ChildDevice,
    query: { type?: string; address?: string; page?: number; pageSize?: number; limit?: number },
  ) {
    const { page, pageSize, skip, take } = parsePagination(query as Record<string, unknown>);
    const where = {
      deviceId: device.id,
      ...(query.type ? { type: query.type } : {}),
      ...(query.address ? { address: { contains: query.address } } : {}),
    };
    const [total, rows] = await Promise.all([
      prisma.smsMessage.count({ where }),
      prisma.smsMessage.findMany({ where, orderBy: { occurredAt: 'desc' }, skip, take }),
    ]);
    return {
      page,
      pageSize,
      total,
      totalPages: Math.ceil(total / pageSize) || 1,
      items: rows.map(toSmsView),
    };
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

  /**
   * 临时使用授权（家长手动点，或家长批准孩子的加时申请）。
   *
   * `accumulate` 为 true 时从**已有窗口的截止时刻**往后顺延，而不是从此刻重新计时。
   * 场景：设备已经放行到 20:30，家长又批了 30 分钟 —— 从此刻算会把窗口截短到
   * 「现在 +30 分钟」（可能早于 20:30），家长会看到「我批了加时，时间反而变少了」。
   * 手动点「临时使用」时仍然是重新计时（家长此刻的心智是「从现在开始给 30 分钟」），
   * 所以默认不累加。
   */
  async tempUnlock(
    userId: number,
    device: ChildDevice,
    minutes: number,
    options: { accumulate?: boolean } = {},
  ) {
    const existing = device.tempUnlockUntil?.getTime() ?? 0;
    const base =
      options.accumulate && existing > Date.now() ? Math.max(existing, Date.now()) : Date.now();
    const until = new Date(base + minutes * 60_000);
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
    // 拍照 / 录像 / 录音各自有对应的家长开关，必须在设备上真实执行，所以要求开关已打开。
    //
    // `screenshot` 刻意**没有门禁**，原因有二：
    // 1. FEATURE_DEFS 里根本没有「截图」这个开关。过去把它挂在 screenMonitor（屏幕洞察）
    //    上是错的：屏幕洞察是「周期截屏 + AI 分析」的持续采集，而截图是家长按一次看一次的
    //    即时动作。想截一张图先得打开一个会持续采集的功能，本身就是更严重的隐私问题；
    //    而且报错是「请先开启「屏幕洞察」功能」，家长拿着一个跟截图毫不相干的名字找不到北。
    // 2. 能不能截到取决于孩子端的能力（无障碍服务是否在运行、系统是否 ≥ API 30，见
    //    android/app/src/main/java/com/balloondog/agent/capability/AccessibilityScreenCapture.java），
    //    服务端凭空编一个开关既管不住设备，也只是多一道假门禁。截不到时由设备端回报真实原因，
    //    落在 DeviceCommand.error 上给家长看。
    if (type !== 'screenshot') {
      const featureKey =
        type === 'remote_photo'
          ? 'remotePhoto'
          : type === 'start_recording'
            ? 'videoRecord'
            : 'remoteRecord';
      await requireFeatureEnabled(device.id, featureKey, userId);
    } else {
      // 截图没有功能开关（见上），但它是「远程监控」能力的一部分，同样要会员。
      // 只查会员、不查开关，正好绕开了上面那段「凭空编一个开关」的问题。
      await requireEntitlement(userId, 'remoteMonitor');
    }

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

  /**
   * 环境监听（§6）：开始/停止分片连续录音。
   *
   * 授权用的是 **audioRecord**（「环境监听」）而不是 remoteRecord（「远程录音」）：
   * 这是两个独立的家长开关，前者是持续采集、后者是一次性取证，
   * 用错开关会让家长在只开了远程录音的情况下被静默持续录音。
   *
   * 停止**不检查**开关：家长关掉功能后必须仍然停得下来，
   * 否则「关了开关，麦克风还在录，而且停不掉」是最坏的情况。
   */
  async requestAmbient(userId: number, device: ChildDevice, start: boolean) {
    if (start) await requireFeatureEnabled(device.id, 'audioRecord', userId);
    return dispatchCommand(device, userId, start ? 'start_ambient' : 'stop_ambient', {}, {});
  },

  /** 远程协助（§7）：返回 / 主页 / 最近任务 / 通知栏 / 打开指定应用。 */
  async remoteAction(userId: number, device: ChildDevice, action: RemoteAction, packageName?: string) {
    await requireFeatureEnabled(device.id, 'remoteHelp', userId);
    const payload: Record<string, unknown> =
      action === 'open_app' ? { action, packageName } : { action };
    return dispatchCommand(device, userId, 'remote_action', payload, {});
  },

  /** 让设备重新上报通话记录与短信（§8 家长端「刷新」）。 */
  async requestCallsSmsSync(userId: number, device: ChildDevice) {
    await requireFeatureEnabled(device.id, 'callSms', userId);
    return dispatchCommand(device, userId, 'sync_calls_sms', {}, {});
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
  // 设备端 Agent —— 应用审核 / 用量 / 电话短信（§3 §4 §8）
  // ============================================================

  /**
   * 设备端申请安装某个应用（§3）。
   * 幂等键是 deviceId + packageName：同一台设备对同一个包重复申请
   * 只会返回既有那条 pending，不会在家长端堆出一串重复的待审核项。
   */
  async createAuditRequest(
    deviceId: string,
    userId: number,
    input: { appName: string; packageName: string },
  ) {
    const existing = await devicesRepo.findPendingAuditByPackage(deviceId, input.packageName);
    if (existing) {
      return { id: existing.id, status: existing.status, created: false };
    }
    const created = await devicesRepo.createAudit(deviceId, input.appName, input.packageName);
    logger.info({ msg: 'audit request created', deviceId, packageName: input.packageName });

    // 孩子装新应用要家长批 —— 家长不知道就不会批，这条必须推（规划 §2.1）。
    // 去重键用审核单 id：同一条申请只会有一条通知，而孩子下次再申请（新单）会再推一次。
    if (userId > 0) {
      await notificationsService.notify({
        userId,
        deviceId,
        type: 'app_audit',
        title: '{{v0}} 安装申请',
        titleParams: { v0: input.appName },
        body: '孩子想安装这个应用，需要你批准后才能在设备上安装。',
        dedupeKey: `app_audit:${created.id}`,
      });
    }

    return { id: created.id, status: created.status, created: true };
  },

  /** 设备端轮询审核结果（§3）。只能查自己设备上的申请。 */
  async getAuditRequestStatus(deviceId: string, id: string) {
    const request = await devicesRepo.findAuditById(deviceId, id);
    if (!request) throw new NotFoundError('审核申请', id);
    return { status: request.status };
  },

  // ============================================================
  // 孩子的申请：加时 / 延后锁屏（§3.1）
  // ============================================================

  /**
   * 设备端提交一条申请。
   *
   * 幂等键是 (deviceId, kind)：孩子端锁屏页会反复问「批了吗」，网络也会重试，
   * 而家长被同一条申请刷屏的直接后果是开始无脑点同意 —— 那比没有这个功能更糟。
   * 去重窗口见 TIME_REQUEST_DEDUPE_MS；窗口内已有 pending 就**更新分钟数与理由**
   * 并回既有那条（孩子把 30 分钟改成 60 分钟时，家长该看到的是新诉求，
   * 而不是两条并列的数字让他猜哪个算数）。
   */
  async createTimeRequest(
    deviceId: string,
    userId: number,
    input: { kind: TimeRequestKind; minutes: number; reason: string },
  ) {
    const existing = await devicesRepo.findPendingTimeRequest(deviceId, input.kind);
    const fresh =
      existing && Date.now() - existing.createdAt.getTime() < TIME_REQUEST_DEDUPE_MS
        ? existing
        : null;

    if (fresh) {
      // 分钟数/理由变了才写库：没变的重复提交不该刷新 createdAt，
      // 否则孩子端每轮询一次就把「已经等了多久」重置一次，家长端排序也跟着乱跳。
      if (fresh.minutes !== input.minutes || fresh.reason !== input.reason) {
        await prisma.timeRequest.update({
          where: { id: fresh.id },
          data: { minutes: input.minutes, reason: input.reason, createdAt: new Date() },
        });
      }
      return {
        id: fresh.id,
        status: fresh.status,
        minutes: input.minutes,
        created: false,
      };
    }

    const created = await devicesRepo.createTimeRequest(
      deviceId,
      input.kind,
      input.minutes,
      input.reason,
    );
    logger.info({
      msg: 'time request created',
      deviceId,
      kind: input.kind,
      minutes: input.minutes,
    });

    // 孩子开口了，家长必须知道 —— 这是这个功能唯一的价值所在（规划 §2.1）。
    // 去重键用申请 id：同一条申请只有一条通知，孩子下次真正发起新申请时会再推一次。
    if (userId > 0) {
      await notificationsService.notify({
        userId,
        deviceId,
        type: 'child_request',
        // v0 本身就是一条 i18n key（申请加时 / 申请延后锁屏），前端渲染时会把它也过一遍 t()
        title: '{{v0}}：{{v1}} 分钟',
        titleParams: { v0: TIME_REQUEST_KIND_LABELS[input.kind], v1: input.minutes },
        // 理由保留孩子自己写的中文（那是用户内容，不是界面文案）
        body: input.reason || '孩子正在等你回应，批了之后设备会立刻多出一段使用时间。',
        dedupeKey: `child_request:${created.id}`,
      });
    }

    return { id: created.id, status: created.status, minutes: created.minutes, created: true };
  },

  /** 设备端轮询审批结果。批准后还要知道自己拿到多少分钟 —— 锁屏页要显示出来。 */
  async getTimeRequestStatus(deviceId: string, id: string) {
    const request = await devicesRepo.findTimeRequestById(deviceId, id);
    if (!request) throw new NotFoundError('申请', id);
    return {
      status: request.status,
      // 未审批时回孩子申请的值，批完回家长实际给的 —— 设备端不用分两种情况处理
      minutes: request.grantedMinutes ?? request.minutes,
      note: request.reviewNote,
    };
  },

  /**
   * 孩子端主页要的绑定信息（规划 §3.2）。
   *
   * 只回「这台设备是谁在守护」。手机号是家长自己的号码 —— 设备令牌已经代表
   * 这台被绑定的设备，回给它不存在越权；孩子端主页要能一键拨给家长。
   * 没绑定时（设备被解绑、家长注销）回 bound:false 而不是抛错：孩子端主页
   * 要能如实显示「这台设备还没有被守护」，而不是白屏。
   */
  async getChildHome(deviceId: string) {
    const device = await devicesRepo.findById(deviceId);
    if (!device) throw new NotFoundError('设备', deviceId);
    // userId 可空 = 设备还没被认领（或已被解绑）。这时如实回 bound:false，
    // 让孩子端主页显示「这台设备还没有被守护」，而不是抛 404 让它白屏。
    if (device.userId == null) {
      return {
        bound: false,
        deviceName: device.name,
        parentName: null,
        parentPhone: null,
        childName: null,
        tasks: [],
      };
    }
    const parent = await prisma.user.findUnique({
      where: { id: device.userId },
      select: { phone: true, nickname: true },
    });
    // 「今日任务」（规划 §5.2）：挂在这台设备所属的孩子身上。
    // 设备没挂孩子档案时是空清单，不是错误 —— 家长可能只想看设备，还没建档案。
    const { childName, tasks } = await childrenService.todayForDevice(device);
    return {
      bound: true,
      deviceName: device.name,
      parentName: parent?.nickname ?? null,
      parentPhone: parent?.phone ?? null,
      childName,
      tasks,
    };
  },

  /**
   * 孩子点的求助（规划 §3.2）。
   *
   * 两件事都要做，缺一不可：
   * - 写一条设备事件，家长在「最新动态」里能看到**孩子主动发起的**信号（带时间）；
   * - 发一条 danger 级站内通知 —— 家长不一定正开着动态页。
   *
   * 幂等键按「设备 + 分钟」而不是「设备 + 天」：孩子连点两下不该产生两条，
   * 但同一分钟之外再点一次应当再响一次（真的出事了，家长必须被再次叫醒）。
   */
  async sos(deviceId: string, message?: string) {
    const device = await devicesRepo.findById(deviceId);
    if (!device) throw new NotFoundError('设备', deviceId);
    // 没人守护就没有收件人：如实回 success:false（不是假成功），
    // 孩子端据此显示「这台设备还没有被守护，求助发不出去」。
    if (device.userId == null) {
      return { success: false, parentPhone: null, parentName: null, reason: 'unbound' };
    }
    const userId = device.userId;

    await devicesRepo.createEvent(deviceId, 'sos', message || '孩子发起了求助');
    await notificationsService.notify({
      userId,
      type: 'child_sos',
      title: '{{v0}} 发起了求助',
      titleParams: { v0: device.name },
      body: message ? '孩子说：{{v0}}' : '孩子点了求助按钮，请尽快联系他。',
      bodyParams: message ? { v0: message } : null,
      linkPath: '/notifications',
      deviceId: device.id,
      dedupeKey: `child_sos:${device.id}:${Math.floor(Date.now() / 60_000)}`,
    });

    const parent = await prisma.user.findUnique({
      where: { id: userId },
      select: { phone: true, nickname: true },
    });
    return {
      success: true,
      parentPhone: parent?.phone ?? null,
      parentName: parent?.nickname ?? null,
    };
  },

  /** 家长端列表（当前设备）。 */
  async listTimeRequests(device: ChildDevice, status?: string) {
    const rows = await devicesRepo.listTimeRequests(device.id, status);
    return { items: rows.map(toTimeRequestView) };
  },

  /**
   * 家长审批。
   *
   * 批准 = 下发一段 temp_unlock 放行窗口，走的是与家长手动「临时使用」完全相同的
   * 指令通道（设备端要真去解锁，服务端不能自己宣布成功）。放行时长从已有窗口
   * 往后顺延，见 tempUnlock 的 accumulate。
   *
   * 已经审批过的申请不能再改：审批是一次性的决定，允许翻案的话设备端
   * 那条「已批准」的轮询结果就成了假的。
   */
  async reviewTimeRequest(
    userId: number,
    device: ChildDevice,
    id: string,
    input: { status: 'approved' | 'rejected'; minutes?: number; note: string },
  ) {
    const request = await devicesRepo.findTimeRequestById(device.id, id);
    if (!request) throw new NotFoundError('申请', id);
    if (request.status !== 'pending') {
      throw new ConflictError('这条申请已经处理过了');
    }

    if (input.status === 'rejected') {
      await devicesRepo.reviewTimeRequest(id, 'rejected', input.note, null);
      logger.info({ msg: 'time request rejected', deviceId: device.id, id });
      return { success: true, grantedMinutes: 0 };
    }

    // 家长可以改小，不能改大（DTO 已挡住越界值，这里只处理「没给就用孩子申请的」）
    const granted = Math.min(input.minutes ?? request.minutes, request.minutes);
    const result = await this.tempUnlock(userId, device, granted, { accumulate: true });
    await devicesRepo.reviewTimeRequest(id, 'approved', input.note, granted);
    logger.info({ msg: 'time request approved', deviceId: device.id, id, granted });
    return { ...result, grantedMinutes: granted };
  },

  /** 各设备待审批条数（家长端角标）。 */
  async pendingTimeRequestCounts(deviceIds: string[]) {
    if (deviceIds.length === 0) return {} as Record<string, number>;
    const rows = await devicesRepo.pendingTimeRequestCounts(deviceIds);
    return Object.fromEntries(rows.map((r) => [r.deviceId, r._count._all]));
  },

  /**
   * 设备端上报今日逐应用用量（§4）—— **全量替换**当日数据。
   *
   * 只写已存在的 AppLimit 行：家长没设过限的应用不建行，否则 AppLimit 会变成
   * 一张「设备上所有应用」的镜像表，家长端与后台的应用限制列表会被大量
   * dailyLimitMinutes=0 的占位行淹没。
   * 没被本次上报覆盖到的已有行当日值归零 —— 那才是「全量替换」的字面含义。
   */
  async reportAppUsage(
    deviceId: string,
    usage: { packageName: string; appName: string; seconds: number }[],
  ) {
    const day = todayKey();
    const limits = await devicesRepo.listAppLimits(deviceId);

    // 同一行只写一次；重复上报同一应用时取较大值而不是累加，避免重复上报把用量翻倍
    const secondsByLimitId = new Map<string, number>();
    for (const item of usage) {
      const limit =
        (item.packageName
          ? limits.find((l) => l.packageName && l.packageName === item.packageName)
          : undefined) ?? limits.find((l) => l.appName === item.appName);
      if (!limit) continue;
      const prev = secondsByLimitId.get(limit.id) ?? 0;
      secondsByLimitId.set(limit.id, Math.min(24 * 3600, Math.max(prev, item.seconds)));
    }

    if (limits.length > 0) {
      await prisma.$transaction(
        limits.map((l) =>
          prisma.appLimit.update({
            where: { id: l.id },
            data: { usedTodaySeconds: secondsByLimitId.get(l.id) ?? 0, usageDay: day },
          }),
        ),
      );
    }
    return { success: true, day, updated: secondsByLimitId.size, reported: usage.length };
  },

  /** 设备端批量上报通话记录（§8）：整表替换这台设备的记录，只保留最近 N 条。 */
  async reportCalls(
    deviceId: string,
    calls: {
      phoneNumber: string;
      name: string;
      type: 'incoming' | 'outgoing' | 'missed';
      durationSeconds: number;
      occurredAt?: Date;
    }[],
  ) {
    const rows = calls
      .map((c) => ({
        deviceId,
        phoneNumber: c.phoneNumber,
        name: c.name,
        type: c.type,
        durationSeconds: c.durationSeconds,
        occurredAt: clampOccurredAt(c.occurredAt),
      }))
      .sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime())
      .slice(0, MAX_CALL_SMS_ROWS);

    await prisma.$transaction([
      prisma.callLogEntry.deleteMany({ where: { deviceId } }),
      prisma.callLogEntry.createMany({ data: rows }),
    ]);
    logger.info({ msg: 'call logs reported', deviceId, stored: rows.length });
    return { success: true, stored: rows.length };
  },

  /** 设备端批量上报短信（§8）：整表替换这台设备的短信，只保留最近 N 条。 */
  async reportSms(
    deviceId: string,
    messages: { address: string; body: string; type: 'inbox' | 'sent'; occurredAt?: Date }[],
  ) {
    const rows = messages
      .map((m) => ({
        deviceId,
        address: m.address,
        body: m.body,
        type: m.type,
        occurredAt: clampOccurredAt(m.occurredAt),
      }))
      .sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime())
      .slice(0, MAX_CALL_SMS_ROWS);

    await prisma.$transaction([
      prisma.smsMessage.deleteMany({ where: { deviceId } }),
      prisma.smsMessage.createMany({ data: rows }),
    ]);
    logger.info({ msg: 'sms reported', deviceId, stored: rows.length });
    return { success: true, stored: rows.length };
  },

  // ============================================================
  // 设备健康（规划 §1）
  // ============================================================

  /**
   * 设备端上报健康快照（整份覆盖）。
   *
   * 只做三件事：校验过的形状原样落库、把 `gaps[].detail` 汇总成动态流用语、
   * 回一个权威 serverTime 给设备锚时钟（规划 §1.6 用得上）。
   *
   * <b>刻意不在这里判定「危险」</b>：等级由设备端给。服务端自己再判一遍，
   * 迟早出现「动态流说危险、健康页说正常」这种互相打脸的结论，而家长只会更慌。
   * 只有老版本 Agent 没给 level 时才用 deriveHealthLevel 兜底。
   */
  async reportHealth(
    deviceId: string,
    userId: number,
    input: {
      level?: HealthLevel;
      gaps: AgentHealthGap[];
      checks: Record<string, boolean>;
      permissions: Record<string, 'granted' | 'denied'>;
      restrictions: { id: string; label: string; supported: boolean; applied: boolean }[];
      serviceRunning: boolean;
      clockSkewSeconds: number;
      healCount: number;
      lastHealAt?: Date;
    },
  ) {
    const level = input.level ?? deriveHealthLevel(input.checks);
    const saved = await devicesRepo.upsertHealth(deviceId, {
      level,
      gaps: input.gaps as unknown as Prisma.InputJsonValue,
      openGaps: input.gaps.length,
      checks: input.checks as Prisma.InputJsonValue,
      permissions: input.permissions as Prisma.InputJsonValue,
      restrictions: input.restrictions as Prisma.InputJsonValue,
      serviceRunning: input.serviceRunning,
      clockSkewSeconds: input.clockSkewSeconds,
      healCount: input.healCount,
      lastHealAt: input.lastHealAt ?? null,
      reportedAt: new Date(),
    });

    logger.info({
      msg: 'device health reported',
      deviceId,
      level,
      openGaps: input.gaps.length,
      clockSkewSeconds: input.clockSkewSeconds,
    });

    // 关键缺口（设备所有者被撤销、无障碍被关）意味着管控**已经实质失效**，
    // 家长必须知道 —— 但不能每 3 分钟发一条，所以按「缺口 × 天」去重：
    // 同一个缺口一天最多提醒一次；修好之后又坏掉，第二天会再提醒一次。
    // 刻意不做「和上一次快照对比」：那需要多存一份状态，而且设备重装/换机时
    // 会漏报 —— 一条每天最多一次的提醒，代价是重复，收益是绝不漏。
    const today = new Date().toISOString().slice(0, 10);
    // userId = 0 表示设备还没被认领（没有家长可通知）
    for (const gap of userId > 0 ? input.gaps.filter((g) => g.importance === 'critical') : []) {
      await notificationsService.notify({
        userId,
        deviceId,
        type: 'health_danger',
        level: 'danger',
        title: '一项管控能力已失效',
        // 只带缺口名（它是一条 en 词典里的 key，会跟着语言走）。
        // gap.detail 是设备端拼的中文长句（如「无障碍看门狗已被关闭：孩子可下拉通知栏…」），
        // 没法当 key，硬塞进来英文界面就会露出中文 —— 详情让家长点进设备健康看。
        body: '{{v0}}',
        bodyParams: { v0: gap.label },
        dedupeKey: `health_danger:${deviceId}:${gap.id}:${today}`,
      });
    }

    return {
      success: true,
      serverTime: new Date().toISOString(),
      level: saved.level,
      openGaps: saved.openGaps,
    };
  },

  /**
   * 家长读健康页（规划 §1.2）。
   *
   * 除了把快照整理成可直接渲染的结构，还顺带做一件「读取时才可能做」的事：
   * 发现设备失联时补记一条 `agent_offline` 动态。失联是按时间差算出来的状态，
   * 没有设备端事件可以依赖（设备都不在了，它当然发不出消息），所以只能这样补。
   * 去重靠 OFFLINE_EVENT_DEDUPE_MS，家长反复刷新不会刷出一屏重复告警。
   */
  async getDeviceHealth(device: ChildDevice) {
    const [snapshot, offlineAt] = await Promise.all([
      devicesRepo.findHealth(device.id),
      devicesRepo.lastOfflineEventAt(device.id),
    ]);

    const liveness = livenessOf(device);
    if (
      (liveness === 'offline' || liveness === 'lost') &&
      (!offlineAt || Date.now() - offlineAt.getTime() > OFFLINE_EVENT_DEDUPE_MS)
    ) {
      const lostHours = Math.floor(LIVENESS_THRESHOLDS.lostAfterMs / 3_600_000);
      // 动态里的原文照旧（那一页是设备视角的日志，且要留档）；
      // 通知则走模板 + 参数，见下面 lastActiveTemplate 的注释。
      const detail =
        liveness === 'lost'
          ? `设备已超过 ${lostHours} 小时没有任何心跳，可能已关机或卸载了本应用`
          : `设备已失联：最后一次心跳是${humanizeLastActive(device.lastActiveAt)}`;
      await devicesRepo.createEvent(device.id, 'agent_offline', detail);
      // 同一条事也给家长发一条站内通知（规划 §2.1）：动态是设备视角的日志，
      // 家长不一定在看那一页；「孩子手机联系不上了」是必须推到他眼前的事。
      // 去重键与动态同源（都用这次失联的时间桶），所以两者要么一起出现、要么一起不出现。
      const offlineBody = lastActiveTemplate(device.lastActiveAt);
      await notificationsService.notify({
        // 未认领的设备（家长还没输绑定码）没有可通知的人，跳过
        userId: device.userId ?? 0,
        deviceId: device.id,
        type: 'agent_offline',
        level: liveness === 'lost' ? 'danger' : 'warn',
        title: liveness === 'lost' ? '{{v0}} 已超过一天无法联系' : '{{v0}} 已失联',
        titleParams: { v0: device.name },
        body: liveness === 'lost' ? '设备已超过 {{v0}} 小时没有任何心跳，可能已关机或卸载了本应用' : offlineBody.text,
        bodyParams: liveness === 'lost' ? { v0: lostHours } : offlineBody.params,
        dedupeKey: `agent_offline:${device.id}:${Math.floor(Date.now() / OFFLINE_EVENT_DEDUPE_MS)}`,
      });
    }

    const checks = (snapshot?.checks ?? {}) as Record<string, boolean>;
    const permissions = (snapshot?.permissions ?? {}) as Record<string, 'granted' | 'denied'>;
    const rawGaps = (snapshot?.gaps ?? []) as unknown as AgentHealthGap[];
    const restrictions = (snapshot?.restrictions ?? []) as unknown as {
      id: string;
      label: string;
      supported: boolean;
      applied: boolean;
    }[];

    /**
     * 快照过期判定：设备 30 分钟没 heartbeat 就会走到 offline，
     * 那时快照里的绿灯已经不代表「现在」。过期的绿灯比红灯更危险，
     * 所以这里显式标出来，让前端把整页降级显示成「数据陈旧」。
     */
    const staleAfterMs = 30 * 60_000;
    const stale = !snapshot || Date.now() - snapshot.reportedAt.getTime() > staleAfterMs;

    return {
      deviceId: device.id,
      deviceName: device.name,
      // 一台设备都还没上报过快照：如实说「还没检测过」，不要假装一切正常
      reported: Boolean(snapshot),
      stale,
      level: snapshot?.level ?? 'warn',
      levelLabel: HEALTH_LEVEL_LABELS[snapshot?.level as HealthLevel] ?? '尚未检测',
      liveness,
      livenessLabel: LIVENESS_LABELS[liveness],
      lastActive: humanizeLastActive(device.lastActiveAt),
      lastActiveAt: device.lastActiveAt,
      online: liveness === 'online',
      /** 开关一览：未上报的项是 unknown，不替设备猜一个「正常」 */
      checks: HEALTH_CHECK_DEFS.map((def) => ({
        key: def.key,
        label: def.label,
        why: def.why,
        critical: def.critical,
        status: checks[def.key] === undefined ? 'unknown' : checks[def.key] ? 'on' : 'off',
      })),
      permissions: HEALTH_PERMISSION_DEFS.map((def) => {
        const status = permissions[def.key] ?? 'unknown';
        return {
          key: def.key,
          label: def.label,
          status,
          /**
           * 分机型步骤（规划 §1.4）只给「被拒」的项。
           * 设备所有者模式下这些权限是静默自授的，仍报 denied 只可能是快照过期，
           * 那时给步骤是把家长往一个早就开着的开关上引。
           */
          fixSteps:
            status === 'denied' && checks.deviceOwner !== true
              ? permissionFixSteps(def.key, device.model)
              : [],
        };
      }),
      gaps: rawGaps.map((gap) => ({
        ...gap,
        /**
         * 分机型步骤只给 `manual` 的缺口：`auto` 的项点「重新检测」就会自愈，
         * 补一段步骤反而让家长以为要手动；`none` 的项系统就是不允许，给步骤等于骗人。
         */
        fixSteps: gap.fixability === 'manual' ? gapFixSteps(gap.id, device.model) : [],
      })),
      /** 缺口统计：家长端顶部「N 项失效，其中 M 项可一键修复」 */
      summary: {
        openGaps: rawGaps.length,
        criticalGaps: rawGaps.filter((g) => g.importance === 'critical').length,
        autoFixable: rawGaps.filter((g) => g.fixability === 'auto').length,
        manualFixable: rawGaps.filter((g) => g.fixability === 'manual').length,
      },
      restrictions: restrictions.map((r) => ({
        id: r.id,
        label: r.label,
        supported: r.supported,
        applied: r.applied,
      })),
      serviceRunning: snapshot?.serviceRunning ?? false,
      clockSkewSeconds: snapshot?.clockSkewSeconds ?? 0,
      healCount: snapshot?.healCount ?? 0,
      lastHealAt: snapshot?.lastHealAt ?? null,
      reportedAt: snapshot?.reportedAt ?? null,
      updatedAt: snapshot?.updatedAt ?? null,
    };
  },

  /**
   * 家长点「重新检测」（规划 §1.3）：下发 self_check，让设备当场自愈一遍再把快照发回来。
   *
   * 为什么不直接在服务端读一次快照就返回：服务端只能看到「上次上报的结果」，
   * 而家长点这个按钮的意图是「现在就去看看、顺手修好」。只有设备端跑一遍
   * LongevityGuard.selfHeal 才能满足这个意图 —— 所以它必须走指令队列。
   *
   * 不检查任何功能开关：这是诊断与自愈，任何会员与开关状态下都应该能用。
   */
  async requestSelfCheck(userId: number, device: ChildDevice) {
    return dispatchCommand(device, userId, 'self_check', {}, {});
  },

  // ============================================================
  // 内部辅助
  // ============================================================

  /** 归属校验的统一入口（越权一律 403）。 */
  async requireOwned(userId: number, deviceId: string): Promise<ChildDevice> {
    const device = await devicesRepo.findById(deviceId);
    if (!device) throw new NotFoundError('设备', deviceId);
    if (device.userId !== userId) throw new ForbiddenError('只有设备的主人可以操作这台设备');
    return device;
  },

  /**
   * 只要能看见这台设备就行（所有者 / admin 成员 / viewer 成员）。
   *
   * 用于「不是改设备，而是记我自己偏好」的动作：把共享设备设为当前操作设备 ——
   * viewer 也该能切换自己正在看哪台设备，否则他只读得到列表里第一台。
   */
  async requireAccess(userId: number, deviceId: string): Promise<ChildDevice> {
    const access = await requireDeviceAccess(userId, deviceId);
    return access.device;
  },

  /**
   * 能改这台设备的设置（所有者 / admin 成员）。viewer 成员到这里被挡住。
   *
   * 只读成员必须被挡住 —— 否则「只读」只是前端不画按钮，改一下请求就绕过去了。
   */
  async requireWritable(userId: number, deviceId: string): Promise<ChildDevice> {
    const access = await requireDeviceAccess(userId, deviceId);
    if (!canWrite(access.role)) throw new ForbiddenError('只读成员不能修改设置');
    return access.device;
  },
};

/**
 * 失联通知的正文：**模板 + 参数**，不是拼好的中文句子。
 *
 * `humanizeLastActive` 返回的是「3小时前」这种给中文界面看的成品字符串 —— 它整句都不是
 * 一个 i18n key，直接塞进通知正文，英文界面就会原样露出中文（浏览器 e2e 的英文扫描
 * 真的抓到过这条）。所以这里按同样的分档，但返回「模板 + 数字」。
 */
function lastActiveTemplate(lastActiveAt: Date | null): {
  text: string;
  params: Record<string, string | number> | null;
} {
  if (!lastActiveAt) return { text: '设备已失联：这台设备还没有上报过心跳', params: null };
  const diffMs = Date.now() - lastActiveAt.getTime();
  if (diffMs < 60_000) return { text: '设备已失联：最后一次心跳就在刚刚', params: null };
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) return { text: '设备已失联：最后一次心跳是 {{v0}} 分钟前', params: { v0: minutes } };
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return { text: '设备已失联：最后一次心跳是 {{v0}} 小时前', params: { v0: hours } };
  return { text: '设备已失联：最后一次心跳是 {{v0}} 天前', params: { v0: Math.floor(hours / 24) } };
}

/**
 * 确认设备上某个功能开关已打开，否则拒绝下发对应指令。
 *
 * 顺序是「先会员、后开关」：反过来的话，普通账号点远程拍照会先看到
 * 「请先开启「远程拍照」功能」，照着打开开关又被告知要开会员 —— 白跑一趟。
 */
async function requireFeatureEnabled(
  deviceId: string,
  featureKey: string,
  userId: number,
): Promise<void> {
  await requireFeatureEntitlement(userId, featureKey);
  const row = await prisma.deviceFeature.findUnique({
    where: { deviceId_key: { deviceId, key: featureKey } },
  });
  if (!row?.enabled) {
    const def = FEATURE_DEFS.find((f) => f.key === featureKey);
    throw new BadRequestError(`请先开启「${def?.label ?? featureKey}」功能`);
  }
}

export { buildFeaturesPayload, reconcileTempUnlock, todayKey, humanizeLastActive };

/**
 * 一条申请的对外视图。
 *
 * 文案在服务端拼成中文（`kindLabel`），与指令名/缺口说明同一条规矩：
 * 家长端把它包进 t() 就能出英文，不会因为漏了一个 kind 而显示成
 * `extend_time` 这种内部枚举值。
 */
/**
 * 手机号打码（§5.1）。
 *
 * 成员之间需要确认「这是不是我认识的那个人」，但没有任何理由把完整号码发给每一个成员：
 * 打码后仍可辨认，泄露了也只是一串占位符。
 */
function maskPhone(phone: string | null): string | null {
  if (!phone) return null;
  return phone.length === 11 ? `${phone.slice(0, 3)}****${phone.slice(7)}` : phone;
}

/** 家庭成员视图（§5.1）：出参只给打码手机号，绝不给密码/令牌这类字段。 */
export function toDeviceMemberView(
  m: DeviceMember & {
    user: { id: number; nickname: string; phone: string | null; avatar: string | null };
  },
) {
  return {
    id: m.id,
    deviceId: m.deviceId,
    userId: m.userId,
    nickname: m.nickname || m.user.nickname || maskPhone(m.user.phone) || '家长',
    phone: maskPhone(m.user.phone),
    avatar: m.user.avatar,
    role: m.role as DeviceMemberRole,
    roleLabel: DEVICE_MEMBER_ROLE_LABELS[m.role as DeviceMemberRole] ?? m.role,
    createdAt: m.createdAt,
  };
}

export function toTimeRequestView(r: {
  id: string;
  kind: string;
  minutes: number;
  reason: string;
  status: string;
  reviewNote: string;
  grantedMinutes: number | null;
  reviewedAt: Date | null;
  createdAt: Date;
}) {
  return {
    id: r.id,
    kind: r.kind,
    kindLabel: TIME_REQUEST_KIND_LABELS[r.kind as TimeRequestKind] ?? r.kind,
    minutes: r.minutes,
    reason: r.reason,
    status: r.status,
    reviewNote: r.reviewNote,
    grantedMinutes: r.grantedMinutes,
    reviewedAt: r.reviewedAt,
    createdAt: r.createdAt,
  };
}
