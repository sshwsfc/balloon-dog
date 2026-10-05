import type { ChildDevice } from '@prisma/client';
import { prisma } from '../../prisma';
import { BadRequestError, NotFoundError } from '../../errors';
import { parsePagination } from '../../shared/deviceScope';
import {
  APP_PLUGIN_CATALOG,
  ALL_PLUGIN_KEYS,
  findPluginTarget,
  pluginKeyOf,
  type PluginRulePayload,
} from './app.plugins.catalog';
import type {
  AddModeAppInput,
  ReportAppsInput,
  ReportEventsInput,
  StudySlotInput,
  UpdateEyeCareInput,
  UpdateModeInput,
  UpdatePluginsInput,
} from './mode.dto';

/** 设备事件保留天数。它是轻量事件流，比截屏留得久，但也不该无限增长。 */
const EVENT_RETENTION_DAYS = 30;

export type EffectiveMode = 'study' | 'normal';

/**
 * 模式求值的**唯一权威实现**（服务端侧）。
 *
 * Android 端 `StudyModeEngine` 里有一份等价逻辑，必须保持一致 ——
 * 否则会出现「家长端显示普通模式、孩子手机却在学习模式」这种最让人困惑的错位。
 * 两边由 `server/scripts/crosscheck-mode.mjs` 逐点比对。
 *
 * 规则（照参考产品的语义）：
 *  1. `manualMode` 非空 → 手动模式优先，时段规划不参与；
 *  2. 否则 `scheduleEnabled` 打开：
 *     - 一格都没选 → **全天学习模式**（这是参考产品的原文约定，家长端会红字警告）；
 *     - 否则命中格子为学习模式，未命中为普通模式；
 *  3. 其余情况 → 普通模式。
 */
export function evaluateMode(
  config: { manualMode: string | null; scheduleEnabled: boolean },
  slots: { dayOfWeek: number; hour: number }[],
  now: Date,
): EffectiveMode {
  if (config.manualMode === 'study') return 'study';
  if (config.manualMode === 'normal') return 'normal';

  if (!config.scheduleEnabled) return 'normal';
  if (slots.length === 0) return 'study';

  const dayOfWeek = now.getDay();
  const hour = now.getHours();
  return slots.some((s) => s.dayOfWeek === dayOfWeek && s.hour === hour) ? 'study' : 'normal';
}

/** 秒级时间戳 → 该时刻的 dayOfWeek / hour（按服务端本地时区，与作息时间表口径一致）。 */
export function slotOf(date: Date): { dayOfWeek: number; hour: number } {
  return { dayOfWeek: date.getDay(), hour: date.getHours() };
}

export const modeService = {
  // ==========================================================
  // 模式配置
  // ==========================================================

  async getMode(device: ChildDevice) {
    const [config, slots] = await Promise.all([
      ensureModeRow(device.id),
      prisma.studyModeSlot.findMany({
        where: { deviceId: device.id },
        orderBy: [{ dayOfWeek: 'asc' }, { hour: 'asc' }],
      }),
    ]);

    const now = new Date();
    return {
      manualMode: config.manualMode,
      scheduleEnabled: config.scheduleEnabled,
      effectiveMode: evaluateMode(config, slots, now),
      /** 开启时段规划却一格都没选 —— 家长端要红字警告「当前全天为学习模式」 */
      allDayStudyWarning: config.scheduleEnabled && config.manualMode === null && slots.length === 0,
      slotCount: slots.length,
      /** 当前时刻命中的格子（值为 null 表示当前不在任何学习时段） */
      currentSlot: config.scheduleEnabled ? slotOf(now) : null,
      serverTime: now.toISOString(),
    };
  },

  async updateMode(device: ChildDevice, patch: UpdateModeInput) {
    await ensureModeRow(device.id);
    await prisma.deviceMode.update({
      where: { deviceId: device.id },
      data: {
        ...(patch.manualMode !== undefined ? { manualMode: patch.manualMode } : {}),
        ...(patch.scheduleEnabled !== undefined ? { scheduleEnabled: patch.scheduleEnabled } : {}),
      },
    });

    // 模式决定孩子现在能不能用手机，属于「必须让设备立刻知道」的变更。
    // 这里不改设备状态，只回最新配置，由设备端下一次心跳（≤15 秒）或配置刷新拉到。
    return this.getMode(device);
  },

  // ==========================================================
  // 时段格子
  // ==========================================================

  async getSlots(device: ChildDevice) {
    const slots = await prisma.studyModeSlot.findMany({
      where: { deviceId: device.id },
      orderBy: [{ dayOfWeek: 'asc' }, { hour: 'asc' }],
      select: { dayOfWeek: true, hour: true },
    });
    return { slots, total: slots.length, max: 168 };
  },

  /**
   * 整表替换时段。
   *
   * 刻意做成「整表替换」而不是逐格增删：家长端那张格子图是一个整体，
   * 逐格提交会产生几十次请求，且中途失败会留下半套规则 ——
   * 对「什么时候不能玩手机」这种配置来说，半套规则比没有规则更糟。
   */
  async replaceSlots(device: ChildDevice, slots: StudySlotInput[]) {
    const unique = new Map<string, StudySlotInput>();
    for (const s of slots) unique.set(`${s.dayOfWeek}-${s.hour}`, s);
    const rows = [...unique.values()];

    await prisma.$transaction([
      prisma.studyModeSlot.deleteMany({ where: { deviceId: device.id } }),
      ...(rows.length
        ? [
            prisma.studyModeSlot.createMany({
              data: rows.map((s) => ({ deviceId: device.id, dayOfWeek: s.dayOfWeek, hour: s.hour })),
            }),
          ]
        : []),
    ]);

    return this.getSlots(device);
  },

  // ==========================================================
  // 学习模式应用分组
  // ==========================================================

  async listModeApps(device: ChildDevice) {
    const rows = await prisma.modeApp.findMany({
      where: { deviceId: device.id },
      orderBy: [{ group: 'asc' }, { appName: 'asc' }],
    });
    return {
      study: rows.filter((r) => r.group === 'study'),
      normal: rows.filter((r) => r.group === 'normal'),
    };
  },

  async addModeApp(device: ChildDevice, input: AddModeAppInput) {
    const appName = input.appName?.trim() || (await guessAppName(device.id, input.packageName));
    const row = await prisma.modeApp.upsert({
      where: {
        deviceId_packageName_group: {
          deviceId: device.id,
          packageName: input.packageName,
          group: input.group,
        },
      },
      create: {
        deviceId: device.id,
        packageName: input.packageName,
        appName,
        group: input.group,
      },
      update: { appName },
    });
    return row;
  },

  async removeModeApp(device: ChildDevice, id: string) {
    const row = await prisma.modeApp.findFirst({ where: { id, deviceId: device.id } });
    if (!row) throw new NotFoundError('学习应用记录', id);
    await prisma.modeApp.delete({ where: { id: row.id } });
    return { success: true };
  },

  // ==========================================================
  // 设备已安装应用
  // ==========================================================

  async listDeviceApps(device: ChildDevice, opts: { q?: string; includeSystem?: boolean }) {
    const where: Record<string, unknown> = { deviceId: device.id };
    if (!opts.includeSystem) where.isSystem = false;
    if (opts.q) {
      where.OR = [
        { appName: { contains: opts.q, mode: 'insensitive' } },
        { packageName: { contains: opts.q, mode: 'insensitive' } },
      ];
    }
    const apps = await prisma.deviceApp.findMany({
      where,
      orderBy: [{ appName: 'asc' }],
      take: 500,
    });
    return { apps, total: apps.length };
  },

  /**
   * 设备上报已安装应用（全量替换）。
   *
   * 用「先删后插」在一个事务里做：半套应用清单会让家长端的选择页少几个应用，
   * 而家长看不出少了什么 —— 这种静默缺失比多几个条目危险得多。
   */
  async reportApps(device: ChildDevice, input: ReportAppsInput) {
    const now = new Date();
    const rows = input.apps.map((a) => ({
      deviceId: device.id,
      packageName: a.packageName,
      appName: a.appName || a.packageName,
      isSystem: a.isSystem,
      isLaunchable: a.isLaunchable,
      lastSeenAt: now,
    }));

    await prisma.$transaction([
      prisma.deviceApp.deleteMany({ where: { deviceId: device.id } }),
      ...(rows.length ? [prisma.deviceApp.createMany({ data: rows })] : []),
    ]);

    // 清单刷新后顺手清掉「作用在不可启动包上」的死规则（缺陷 2 的自愈）。
    //
    // 旧实现批准安装审核时，拿设备上报的**安装器包名**建了一条逐应用限额；
    // 安装器没有桌面入口，`GuardRules.matchAppLimit` 的第一道闸门
    // `if (!isLaunchable) return null;` 让它永不触发 —— 家长端却显示「已设限」。
    // 只有设备**明确**报了 `isLaunchable=false` 才删（清单是全量替换，缺席的包不动），
    // 免得把家长刚设的正常限额误删。
    const nonLaunchable = rows.filter((r) => !r.isLaunchable).map((r) => r.packageName);
    if (nonLaunchable.length > 0) {
      await prisma.appLimit.deleteMany({
        where: { deviceId: device.id, packageName: { in: nonLaunchable } },
      });
    }

    return { success: true, count: rows.length };
  },

  // ==========================================================
  // 护眼设置
  // ==========================================================

  async getEyeCare(device: ChildDevice) {
    const row = await ensureEyeCareRow(device.id);
    return { ...row, nightEnabled: row.nightStartHour !== row.nightEndHour };
  },

  async updateEyeCare(device: ChildDevice, patch: UpdateEyeCareInput) {
    const current = await ensureEyeCareRow(device.id);

    // 先算出「合并 patch 之后」的最终值，再校验，最后才落库。
    //
    // 顺序很要紧：如果先 update 再校验，被拒绝的请求其实已经写进数据库了 ——
    // 客户端收到 400、以为没生效，服务端却已经变成矛盾配置。
    // （这个 bug 真的出现过，是前端同学在联调时发现的：他加了一条客户端兜底，
    //   因为「服务端会先写后拒」。兜底现在可以去掉了。）
    const next = {
      nightStartHour: patch.nightStartHour ?? current.nightStartHour,
      nightEndHour: patch.nightEndHour ?? current.nightEndHour,
      nightLockEnabled: patch.nightLockEnabled ?? current.nightLockEnabled,
    };

    if (next.nightStartHour === next.nightEndHour && next.nightLockEnabled) {
      // 夜间时段起止相同 = 不启用，此时还开着「夜间锁定」是自相矛盾的配置，直接拒绝，
      // 而不是让它静默不生效 —— 家长会以为孩子夜里被锁了，其实没有。
      throw new BadRequestError('夜间护眼时段为空（起止小时相同），无法开启夜间锁定');
    }

    const row = await prisma.eyeCareConfig.update({ where: { deviceId: device.id }, data: patch });
    return { ...row, nightEnabled: row.nightStartHour !== row.nightEndHour };
  },

  // ==========================================================
  // 应用插件管控
  // ==========================================================

  /**
   * 插件目录 + 家长当前设置。
   *
   * 返回结构直接对齐家长端的卡片列表：每个应用一个卡片，带「已关闭 N / 共 M」。
   * 未设置过的插件按目录里的 `defaultEnabled` 处理 —— 默认放行，
   * 避免产品升级新增插件后突然拦住孩子正常在用的功能。
   */
  async listAppPlugins(device: ChildDevice) {
    const states = await prisma.appPluginState.findMany({ where: { deviceId: device.id } });
    const stateMap = new Map(states.map((s) => [pluginKeyOf(s.packageName, s.pluginKey), s.enabled]));

    const targets = APP_PLUGIN_CATALOG.map((target) => {
      const plugins = target.plugins.map((def) => {
        const enabled = stateMap.get(pluginKeyOf(target.packageName, def.key)) ?? def.defaultEnabled;
        return {
          key: def.key,
          label: def.label,
          category: def.category,
          enabled,
          /** 家长改过才显示「已自定义」，便于一眼看出哪些是动过的 */
          customized:
            stateMap.has(pluginKeyOf(target.packageName, def.key)) &&
            stateMap.get(pluginKeyOf(target.packageName, def.key)) !== def.defaultEnabled,
        };
      });
      return {
        packageName: target.packageName,
        appName: target.appName,
        badge: target.badge,
        total: plugins.length,
        blocked: plugins.filter((x) => !x.enabled).length,
        plugins,
      };
    });

    return { targets };
  },

  async updateAppPlugins(device: ChildDevice, input: UpdatePluginsInput) {
    for (const item of input.items) {
      if (!ALL_PLUGIN_KEYS.has(pluginKeyOf(item.packageName, item.pluginKey))) {
        // 宁可报错也不静默忽略：静默忽略会让家长以为「已经关掉了」，
        // 而设备上那条规则根本不存在。
        throw new BadRequestError(
          `未知插件：${item.packageName} / ${item.pluginKey}（目录里没有这一项）`,
        );
      }
    }

    await prisma.$transaction(
      input.items.map((item) =>
        prisma.appPluginState.upsert({
          where: {
            deviceId_packageName_pluginKey: {
              deviceId: device.id,
              packageName: item.packageName,
              pluginKey: item.pluginKey,
            },
          },
          create: {
            deviceId: device.id,
            packageName: item.packageName,
            pluginKey: item.pluginKey,
            enabled: item.enabled,
          },
          update: { enabled: item.enabled },
        }),
      ),
    );

    return this.listAppPlugins(device);
  },

  /**
   * 下发给设备端的插件规则。
   *
   * 只发**被家长关掉或显式设置过**的项：默认放行的项发过去只是浪费流量，
   * 而且会让「设备端规则的来源」变得难以解释。
   */
  async buildPluginRules(device: ChildDevice): Promise<PluginRulePayload[]> {
    const states = await prisma.appPluginState.findMany({ where: { deviceId: device.id } });
    const byPackage = new Map<string, PluginRulePayload>();

    for (const s of states) {
      const target = findPluginTarget(s.packageName);
      const def = target?.plugins.find((x) => x.key === s.pluginKey);
      if (!target || !def) continue; // 目录里已下线的项，直接不发
      if (s.enabled === def.defaultEnabled) continue; // 与默认一致，不必下发

      if (!byPackage.has(s.packageName)) {
        byPackage.set(s.packageName, { packageName: s.packageName, plugins: [] });
      }
      byPackage.get(s.packageName)!.plugins.push({
        key: def.key,
        enabled: s.enabled,
        keywords: def.keywords,
      });
    }

    return [...byPackage.values()];
  },

  /** 设备端需要知道的「模式 + 学习白名单」。 */
  async buildModePayload(device: ChildDevice) {
    const [config, slots, modeApps] = await Promise.all([
      ensureModeRow(device.id),
      prisma.studyModeSlot.findMany({
        where: { deviceId: device.id },
        select: { dayOfWeek: true, hour: true },
      }),
      prisma.modeApp.findMany({
        where: { deviceId: device.id, group: 'study' },
        select: { packageName: true, appName: true },
      }),
    ]);

    return {
      manualMode: config.manualMode,
      scheduleEnabled: config.scheduleEnabled,
      slots,
      studyApps: modeApps.map((a) => a.packageName),
      effectiveMode: evaluateMode(config, slots, new Date()),
    };
  },

  // ==========================================================
  // 设备事件（最新动态）
  // ==========================================================

  async listEvents(device: ChildDevice, query: Record<string, unknown>) {
    const { skip, take, page, pageSize } = parsePagination(query, 20);
    const where: Record<string, unknown> = { deviceId: device.id };
    if (typeof query.type === 'string' && query.type.trim()) where.type = query.type.trim();

    const [items, total] = await Promise.all([
      prisma.deviceEvent.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take }),
      prisma.deviceEvent.count({ where }),
    ]);
    return { page, pageSize, total, totalPages: Math.ceil(total / pageSize) || 1, items };
  },

  /**
   * 设备上报事件。
   *
   * 顺手做保留期清理（每次上报最多删一轮），避免事件表无限增长 ——
   * 单独做定时任务也行，但事件流是低频写入，搭在写入路径上更省事且不会漏。
   */
  async reportEvents(device: ChildDevice, input: ReportEventsInput) {
    const now = Date.now();
    const rows = input.events.map((e) => ({
      deviceId: device.id,
      type: e.type,
      detail: e.detail,
      // 设备时钟可能不准（孩子可以改时间），所以对上报时刻做一次钳制：
      // 只接受「不晚于服务端现在、且不早于 7 天前」的值，其余一律用服务端时间。
      createdAt: clampEventTime(e.at, now),
    }));

    await prisma.deviceEvent.createMany({ data: rows });

    const cutoff = new Date(now - EVENT_RETENTION_DAYS * 24 * 60 * 60 * 1000);
    await prisma.deviceEvent.deleteMany({ where: { deviceId: device.id, createdAt: { lt: cutoff } } });

    return { success: true, count: rows.length };
  },
};

// ============================================================
// 内部工具
// ============================================================

function clampEventTime(at: number | undefined, now: number): Date {
  const WEEK = 7 * 24 * 60 * 60 * 1000;
  if (!at || at > now || at < now - WEEK) return new Date(now);
  return new Date(at);
}

/** 没有现成配置行时按默认值建一行，让上层不用到处判空。 */
async function ensureModeRow(deviceId: string) {
  const existing = await prisma.deviceMode.findUnique({ where: { deviceId } });
  if (existing) return existing;
  return prisma.deviceMode.create({ data: { deviceId } });
}

async function ensureEyeCareRow(deviceId: string) {
  const existing = await prisma.eyeCareConfig.findUnique({ where: { deviceId } });
  if (existing) return existing;
  return prisma.eyeCareConfig.create({ data: { deviceId } });
}

/** 家长只给了包名时，从设备上报的清单里补一个展示名。 */
async function guessAppName(deviceId: string, packageName: string): Promise<string> {
  const app = await prisma.deviceApp.findUnique({
    where: { deviceId_packageName: { deviceId, packageName } },
    select: { appName: true },
  });
  return app?.appName ?? packageName;
}
