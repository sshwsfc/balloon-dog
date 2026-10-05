import { prisma } from '../../prisma';
import { FEATURE_DEFS, defaultEnabledOf } from './devices.constants';

/**
 * 数据访问层。
 * 除 commands 相关（在 commands.service 里直接用 prisma 做事务）之外，
 * 设备域的所有查询都收口在这里，便于统一加索引/缓存。
 */
export const devicesRepo = {
  findById: (id: string) => prisma.childDevice.findUnique({ where: { id } }),
  findByCode: (deviceCode: string) => prisma.childDevice.findUnique({ where: { deviceCode } }),

  listByUser: (userId: number) =>
    prisma.childDevice.findMany({
      where: { userId },
      orderBy: { createdAt: 'asc' },
    }),

  countByUser: (userId: number) => prisma.childDevice.count({ where: { userId } }),

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
};
