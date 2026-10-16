import { prisma } from '../../prisma';
import type { Prisma } from '@prisma/client';
import { FEATURE_DEFS, defaultEnabledOf } from './devices.constants';

/**
 * 数据访问层。
 * 除 commands 相关（在 commands.service 里直接用 prisma 做事务）之外，
 * 设备域的所有查询都收口在这里，便于统一加索引/缓存。
 */
export const devicesRepo = {
  findById: (id: string) => prisma.childDevice.findUnique({ where: { id } }),
  findByCode: (deviceCode: string) => prisma.childDevice.findUnique({ where: { deviceCode } }),

  /**
   * 该家长能打开的设备（规划 §5.1）：自己绑的 + 作为家庭成员被邀请的。
   * 家庭成员的设备在读接口里必须出现，否则「共同守护」只存在于数据库里。
   */
  listByUser: (userId: number) =>
    prisma.childDevice.findMany({
      where: { OR: [{ userId }, { members: { some: { userId } } }] },
      orderBy: { createdAt: 'asc' },
    }),

  countByUser: (userId: number) => prisma.childDevice.count({ where: { userId } }),

  /**
   * 批量取健康摘要（规划 §1.2 的「设备列表每台一个健康点」）。
   *
   * 只 select 三个轻字段，绝不把 `gaps` / `restrictions` 这些 JSON 大字段捞进列表页 ——
   * 列表每台设备一行，详情才需要完整快照。
   */
  healthSummaries: (deviceIds: string[]) =>
    prisma.deviceHealth.findMany({
      where: { deviceId: { in: deviceIds } },
      select: { deviceId: true, level: true, openGaps: true, reportedAt: true },
    }),

  createUnbound: (data: {
    deviceCode: string;
    deviceSecretHash: string;
    name: string;
    model: string;
    os: string;
    osVersion: string;
    agentVersion: string;
  }) =>
    prisma.childDevice.create({
      data: { ...data, userId: null, status: 'online', lastActiveAt: new Date() },
    }),

  bindToUser: (deviceId: string, userId: number, name?: string) =>
    prisma.childDevice.update({
      where: { id: deviceId },
      data: {
        userId,
        boundAt: new Date(),
        ...(name ? { name } : {}),
      },
    }),

  update: (id: string, data: Record<string, unknown>) =>
    prisma.childDevice.update({ where: { id }, data }),

  remove: (id: string) => prisma.childDevice.delete({ where: { id } }),

  /** 幂等地补齐设备的功能开关、时间规划、答题配置等 1:1 附属记录。 */
  async ensureDefaults(deviceId: string): Promise<void> {
    // 功能开关：只补缺失的 key（已关闭的开关不能被重置为默认值）
    const existing = await prisma.deviceFeature.findMany({
      where: { deviceId },
      select: { key: true },
    });
    const existingKeys = new Set(existing.map((f) => f.key));
    const missing = FEATURE_DEFS.filter((f) => !existingKeys.has(f.key));
    if (missing.length > 0) {
      await prisma.deviceFeature.createMany({
        data: missing.map((f) => ({
          deviceId,
          key: f.key,
          enabled: defaultEnabledOf(f.key),
        })),
        skipDuplicates: true,
      });
    }

    await prisma.timePlan.upsert({
      where: { deviceId },
      create: { deviceId, enabled: true, dailyLimitMinutes: 0, usedTodayMinutes: 0 },
      update: {},
    });

    await prisma.quizConfig.upsert({
      where: { deviceId },
      create: { deviceId, enabled: false, quizType: 'english', grade: 'grade1' },
      update: {},
    });

    // 锁屏策略：默认 kiosk（可远程即时解锁），不要默认成 password ——
    // 那是需要家长显式选择的高风险档位
    await prisma.lockPolicy.upsert({
      where: { deviceId },
      create: { deviceId, strength: 'kiosk', countdownSeconds: 30, scheduleEnabled: false },
      update: {},
    });
  },

  listFeatures: (deviceId: string) =>
    prisma.deviceFeature.findMany({ where: { deviceId }, orderBy: { key: 'asc' } }),

  setFeature: (deviceId: string, key: string, enabled: boolean) =>
    prisma.deviceFeature.upsert({
      where: { deviceId_key: { deviceId, key } },
      create: { deviceId, key, enabled },
      update: { enabled },
    }),

  getTimePlan: (deviceId: string) => prisma.timePlan.findUnique({ where: { deviceId } }),

  setTimePlan: (deviceId: string, data: { dailyLimitMinutes?: number; enabled?: boolean; usedTodayMinutes?: number; resetAt?: Date }) =>
    prisma.timePlan.upsert({
      where: { deviceId },
      create: {
        deviceId,
        dailyLimitMinutes: data.dailyLimitMinutes ?? 0,
        enabled: data.enabled ?? true,
        usedTodayMinutes: data.usedTodayMinutes ?? 0,
      },
      update: data,
    }),

  /** 设备上报过的某个应用（家长端选应用时用来拿真实包名 / 判断能不能拦）。 */
  findDeviceApp: (deviceId: string, packageName: string) =>
    prisma.deviceApp.findUnique({
      where: { deviceId_packageName: { deviceId, packageName } },
    }),

  listAppLimits: (deviceId: string) =>
    prisma.appLimit.findMany({ where: { deviceId }, orderBy: { appName: 'asc' } }),

  /**
   * 写一条逐应用限额。
   *
   * <p>唯一键是 `(deviceId, appName)`，但**判定用的是 packageName**，所以同一个包
   * 换个展示名（历史数据里的「时钟」vs 设备清单里的「Clock」）会按 appName upsert 出
   * 两条规则 —— 设备端会拿同一个包判两次。这里先按 packageName 找已有行，
   * 找到就改它（顺带把展示名对齐），找不到再走原来的 upsert。
   */
  upsertAppLimit: async (
    deviceId: string,
    appName: string,
    data: { dailyLimitMinutes: number; packageName?: string; enabled?: boolean },
  ) => {
    if (data.packageName) {
      const existing = await prisma.appLimit.findFirst({
        where: { deviceId, packageName: data.packageName },
      });
      if (existing) {
        return prisma.appLimit.update({
          where: { id: existing.id },
          data: {
            appName,
            dailyLimitMinutes: data.dailyLimitMinutes,
            ...(data.enabled !== undefined ? { enabled: data.enabled } : {}),
          },
        });
      }
    }
    return prisma.appLimit.upsert({
      where: { deviceId_appName: { deviceId, appName } },
      create: {
        deviceId,
        appName,
        dailyLimitMinutes: data.dailyLimitMinutes,
        packageName: data.packageName ?? '',
        enabled: data.enabled ?? true,
      },
      update: {
        dailyLimitMinutes: data.dailyLimitMinutes,
        ...(data.packageName !== undefined ? { packageName: data.packageName } : {}),
        ...(data.enabled !== undefined ? { enabled: data.enabled } : {}),
      },
    });
  },

  removeAppLimit: (deviceId: string, appName: string) =>
    prisma.appLimit.deleteMany({ where: { deviceId, appName } }),

  /**
   * 清掉「空包名」的限额行。
   *
   * <p>历史缺陷在服务端丢掉了 packageName，库里留下了一批 `packageName=''` 的行。
   * 设备端按包名判定，这些行永远不生效（不是「暂时不生效」，是永远），
   * 留着只会让家长端显示一条假的限制。写入路径顺手清掉。
   */
  removeAppLimitsWithoutPackage: (deviceId: string) =>
    prisma.appLimit.deleteMany({ where: { deviceId, packageName: '' } }),

  /**
   * 清掉「作用在不可启动包上」的死规则（缺陷 2 的自愈）。
   *
   * <p>旧实现批准安装审核时，拿设备上报的**安装器包名**建了一条限额；
   * 安装器没有桌面入口，`GuardRules.matchAppLimit` 的第一道闸门
   * `if (!isLaunchable) return null;` 让它永不触发。
   * 只有设备明确报过「这个包不可启动」时才删 —— 清单还没同步（app 为 null）时不动，
   * 免得把家长刚设的正常限额误删。
   */
  removeDeadAppLimit: async (deviceId: string, packageName: string) => {
    const pkg = packageName.trim();
    if (!pkg) return;
    const app = await prisma.deviceApp.findUnique({
      where: { deviceId_packageName: { deviceId, packageName: pkg } },
      select: { isLaunchable: true },
    });
    if (app && !app.isLaunchable) {
      await prisma.appLimit.deleteMany({ where: { deviceId, packageName: pkg } });
    }
  },

  listPendingAudits: (deviceId: string) =>
    prisma.appAuditRequest.findMany({
      where: { deviceId, status: 'pending' },
      orderBy: { createdAt: 'asc' },
    }),

  findAudit: (deviceId: string, appName: string) =>
    prisma.appAuditRequest.findFirst({
      where: { deviceId, appName, status: 'pending' },
      orderBy: { createdAt: 'desc' },
    }),

  /** 应用审核落地：请假条式的历史也要留痕，所以不删除记录，而是改状态。 */
  reviewAudit: (id: string, status: 'approved' | 'rejected', reason: string) =>
    prisma.appAuditRequest.update({
      where: { id },
      data: { status, reason, reviewedAt: new Date() },
    }),

  createAudit: (deviceId: string, appName: string, packageName: string) =>
    prisma.appAuditRequest.create({ data: { deviceId, appName, packageName } }),

  /**
   * 设备端申请安装时的幂等键：同一台设备 + 同一个包名只应该有一条 pending。
   * 用 packageName 而不是 appName —— 展示名是给孩子看的、可以重名，包名才唯一。
   */
  findPendingAuditByPackage: (deviceId: string, packageName: string) =>
    prisma.appAuditRequest.findFirst({
      where: { deviceId, packageName, status: 'pending' },
      orderBy: { createdAt: 'desc' },
    }),

  /** 设备端按 id 轮询审核结果。带 deviceId 一起查，避免拿到别的设备的申请状态。 */
  findAuditById: (deviceId: string, id: string) =>
    prisma.appAuditRequest.findFirst({ where: { id, deviceId } }),

  listBlockedUrls: (deviceId: string) =>
    prisma.blockedUrl.findMany({ where: { deviceId }, orderBy: { createdAt: 'asc' } }),

  addBlockedUrl: (deviceId: string, url: string) =>
    prisma.blockedUrl.upsert({
      where: { deviceId_url: { deviceId, url } },
      create: { deviceId, url },
      update: { enabled: true },
    }),

  removeBlockedUrl: (deviceId: string, url: string) =>
    prisma.blockedUrl.deleteMany({ where: { deviceId, url } }),

  listQuizConfig: (deviceId: string) => prisma.quizConfig.findUnique({ where: { deviceId } }),

  setQuizConfig: (
    deviceId: string,
    data: {
      enabled?: boolean;
      quizType?: string;
      grade?: string;
      correctRewardMinutes?: number;
      randomMode?: boolean;
    },
  ) =>
    prisma.quizConfig.upsert({
      where: { deviceId },
      create: { deviceId, ...data },
      update: data,
    }),

  upsertFeatureRows: async (deviceId: string): Promise<void> => {
    await devicesRepo.ensureDefaults(deviceId);
  },

  // ============================================================
  // 设备健康（规划 §1）
  // ============================================================

  /**
   * 健康快照是**整份覆盖**：一台设备一行，上报走 upsert。
   * 用 upsert 而不是「先删后插」是因为它不产生空窗期 —— 家长在设备上报的
   * 同一瞬间刷新健康页，也不会读到「没有快照」。
   */
  upsertHealth: (
    deviceId: string,
    data: {
      level: string;
      gaps: Prisma.InputJsonValue;
      openGaps: number;
      checks: Prisma.InputJsonValue;
      permissions: Prisma.InputJsonValue;
      restrictions: Prisma.InputJsonValue;
      serviceRunning: boolean;
      clockSkewSeconds: number;
      healCount: number;
      lastHealAt: Date | null;
      reportedAt: Date;
    },
  ) =>
    prisma.deviceHealth.upsert({
      where: { deviceId },
      create: { deviceId, ...data },
      update: data,
    }),

  findHealth: (deviceId: string) => prisma.deviceHealth.findUnique({ where: { deviceId } }),

  /** 最近一条「设备失联」动态，用于给补记事件做去重（见 OFFLINE_EVENT_DEDUPE_MS）。 */
  lastOfflineEventAt: async (deviceId: string): Promise<Date | null> => {
    const row = await prisma.deviceEvent.findFirst({
      where: { deviceId, type: 'agent_offline' },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });
    return row?.createdAt ?? null;
  },

  createEvent: (deviceId: string, type: string, detail: string) =>
    prisma.deviceEvent.create({ data: { deviceId, type, detail } }),

  // ============================================================
  // 孩子的申请（§3.1）
  // ============================================================

  createTimeRequest: (deviceId: string, kind: string, minutes: number, reason: string) =>
    prisma.timeRequest.create({ data: { deviceId, kind, minutes, reason } }),

  /**
   * 去重键 (deviceId, kind) 的 pending 查询 —— 孩子端反复提交只应有一条待审批。
   *
   * 用 kind 而不是 (kind, minutes)：孩子第一次申请 30 分钟没批，第二次改成 60 分钟，
   * 那是同一个「我想多玩一会儿」的诉求，家长端该看到的是一条最新的申请，
   * 而不是两条并列的 30/60 让家长猜。
   */
  findPendingTimeRequest: (deviceId: string, kind: string) =>
    prisma.timeRequest.findFirst({
      where: { deviceId, kind, status: 'pending' },
      orderBy: { createdAt: 'desc' },
    }),

  /** 设备端按 id 轮询审批结果。带 deviceId 一起查，免得拿到别家设备的申请。 */
  findTimeRequestById: (deviceId: string, id: string) =>
    prisma.timeRequest.findFirst({ where: { id, deviceId } }),

  /** 家长端列表：pending 时按「先来先处理」正序，历史按「最近发生」倒序。 */
  listTimeRequests: (deviceId: string, status?: string) =>
    prisma.timeRequest.findMany({
      where: { deviceId, ...(status && status !== 'all' ? { status } : {}) },
      orderBy: { createdAt: status === 'pending' ? 'asc' : 'desc' },
      take: 100,
    }),

  reviewTimeRequest: (
    id: string,
    status: 'approved' | 'rejected',
    note: string,
    grantedMinutes: number | null,
  ) =>
    prisma.timeRequest.update({
      where: { id },
      data: { status, reviewNote: note, grantedMinutes, reviewedAt: new Date() },
    }),

  /**
   * 待审批条数 —— 家长端首页/底栏的角标用。
   *
   * 一次查回该家长**所有**设备的待审批数（按设备分组），而不是每台设备查一次：
   * 首页要同时渲染设备列表和角标，N+1 会随设备数线性变慢。
   */
  // ---- 家庭成员（规划 §5.1）----

  findUserByPhone: (phone: string) =>
    prisma.user.findUnique({
      where: { phone },
      select: { id: true, nickname: true, phone: true, status: true },
    }),

  listDeviceMembers: (deviceId: string) =>
    prisma.deviceMember.findMany({
      where: { deviceId },
      orderBy: { createdAt: 'asc' },
      include: { user: { select: { id: true, nickname: true, phone: true, avatar: true } } },
    }),

  findDeviceMember: (id: string) =>
    prisma.deviceMember.findUnique({
      where: { id },
      include: { user: { select: { id: true, nickname: true, phone: true, avatar: true } } },
    }),

  findDeviceMemberByUser: (deviceId: string, userId: number) =>
    prisma.deviceMember.findUnique({ where: { deviceId_userId: { deviceId, userId } } }),

  countDeviceMembers: (deviceId: string) => prisma.deviceMember.count({ where: { deviceId } }),

  createDeviceMember: (data: {
    deviceId: string;
    userId: number;
    role: string;
    nickname: string;
    invitedBy: number | null;
  }) =>
    prisma.deviceMember.create({
      data,
      include: { user: { select: { id: true, nickname: true, phone: true, avatar: true } } },
    }),

  updateDeviceMember: (id: string, data: { role?: string; nickname?: string }) =>
    prisma.deviceMember.update({
      where: { id },
      data,
      include: { user: { select: { id: true, nickname: true, phone: true, avatar: true } } },
    }),

  deleteDeviceMember: (id: string) => prisma.deviceMember.delete({ where: { id } }),

  /** 该家长作为成员参与的所有设备（列表页标角色用，一次查回，避免 N+1）。 */
  memberRolesForUser: (userId: number) =>
    prisma.deviceMember.findMany({
      where: { userId },
      select: { deviceId: true, role: true },
    }),

  pendingTimeRequestCounts: (deviceIds: string[]) =>
    prisma.timeRequest.groupBy({
      by: ['deviceId'],
      where: { deviceId: { in: deviceIds }, status: 'pending' },
      _count: { _all: true },
    }),
};
