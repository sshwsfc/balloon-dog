import type { ChildDevice, LockPolicy, ScheduleRule } from '@prisma/client';
import { prisma } from '../../prisma';
import { logger } from '../../logger';
import { BadRequestError, NotFoundError } from '../../errors';

/**
 * 定时锁屏 / 定时解锁的求值引擎。
 *
 * <b>这里是全项目对「某个时刻该不该锁」的唯一定义。</b>
 * 后端用它给家长端做实时预览，Android 端 `ScheduleEngine` 用同一套语义在本地求值并执行。
 * 两边必须保持一致 —— 所以规则本身刻意设计得足够简单，复杂判断不放进设备端。
 *
 * 语义（按优先级）：
 *   1. 命中任意一条启用的 `unlock` 规则 → 允许使用；
 *   2. 否则命中任意一条启用的 `lock` 规则 → 锁定；
 *   3. 都没命中 → 时间表不锁定。
 */

/** 一天 1440 分钟。 */
const MINUTES_PER_DAY = 1440;

export interface ScheduleDecision {
  /** 按时间表此刻是否应锁定。 */
  locked: boolean;
  /** 决定该结果的那条规则（没命中任何规则时为 null）。 */
  ruleId: string | null;
  ruleName: string | null;
}

/** 判断某个「当天分钟数 + 星期几」是否落在规则区间内（支持跨天）。 */
function coversMinute(rule: Pick<ScheduleRule, 'daysOfWeek' | 'startMinute' | 'endMinute'>, day: number, minute: number): boolean {
  const days = rule.daysOfWeek ?? [];

  if (rule.endMinute > rule.startMinute) {
    // 同一天内的区间，例如 08:00 → 12:00
    return days.includes(day) && minute >= rule.startMinute && minute < rule.endMinute;
  }

  // 跨天区间，例如 22:00 → 次日 07:00：
  //  - 当天部分：start 之后到 24:00
  //  - 次日部分：00:00 到 end 之前，且「start 那天」在生效星期里
  if (days.includes(day) && minute >= rule.startMinute) return true;
  const previousDay = (day + 6) % 7;
  return days.includes(previousDay) && minute < rule.endMinute;
}

/** 求某个时刻的时间表决策。 */
export function evaluateSchedule(
  rules: Pick<ScheduleRule, 'id' | 'name' | 'action' | 'daysOfWeek' | 'startMinute' | 'endMinute' | 'enabled'>[],
  at: Date,
): ScheduleDecision {
  const day = at.getDay();
  const minute = at.getHours() * 60 + at.getMinutes();

  const active = rules.filter((r) => r.enabled && coversMinute(r, day, minute));

  // unlock 优先：这样「整晚锁定 + 中午放行」可以直接叠加表达
  const unlock = active.find((r) => r.action === 'unlock');
  if (unlock) return { locked: false, ruleId: unlock.id, ruleName: unlock.name || null };

  const lock = active.find((r) => r.action === 'lock');
  if (lock) return { locked: true, ruleId: lock.id, ruleName: lock.name || null };

  return { locked: false, ruleId: null, ruleName: null };
}

/**
 * 找出下一次「锁定状态发生变化」的时刻。
 *
 * 逐分钟向后扫描最多 7 天（10080 次纯整数比较，开销可忽略），
 * 因为只有这样才能正确处理跨天、多规则叠加这些情况 ——
 * 直接用「下一条规则的 startMinute」是错的：unlock 规则的结束同样是一次状态变化。
 */
export function nextScheduleBoundary(
  rules: Pick<ScheduleRule, 'id' | 'name' | 'action' | 'daysOfWeek' | 'startMinute' | 'endMinute' | 'enabled'>[],
  from: Date,
): { at: Date; locked: boolean; ruleName: string | null } | null {
  if (rules.length === 0) return null;

  const current = evaluateSchedule(rules, from).locked;
  const cursor = new Date(from);
  cursor.setSeconds(0, 0);

  for (let i = 1; i <= 7 * MINUTES_PER_DAY; i++) {
    cursor.setMinutes(cursor.getMinutes() + 1);
    const decision = evaluateSchedule(rules, cursor);
    if (decision.locked !== current) {
      return { at: new Date(cursor), locked: decision.locked, ruleName: decision.ruleName };
    }
  }
  return null;
}

function toScheduleView(rule: ScheduleRule) {
  return {
    id: rule.id,
    deviceId: rule.deviceId,
    name: rule.name,
    action: rule.action,
    daysOfWeek: rule.daysOfWeek,
    startMinute: rule.startMinute,
    endMinute: rule.endMinute,
    enabled: rule.enabled,
    createdAt: rule.createdAt,
    updatedAt: rule.updatedAt,
  };
}

function toPolicyView(policy: LockPolicy | null, deviceId: string) {
  return {
    deviceId,
    strength: policy?.strength ?? 'kiosk',
    countdownSeconds: policy?.countdownSeconds ?? 30,
    scheduleEnabled: policy?.scheduleEnabled ?? false,
  };
}

export const scheduleService = {
  // ============================================================
  // 锁屏策略
  // ============================================================

  async getPolicy(device: ChildDevice) {
    const policy = await prisma.lockPolicy.findUnique({ where: { deviceId: device.id } });
    return toPolicyView(policy, device.id);
  },

  async updatePolicy(device: ChildDevice, patch: { strength?: string; countdownSeconds?: number; scheduleEnabled?: boolean }) {
    const policy = await prisma.lockPolicy.upsert({
      where: { deviceId: device.id },
      create: { deviceId: device.id, ...patch },
      update: patch,
    });
    logger.info({ msg: 'lock policy updated', deviceId: device.id, ...patch });
    return toPolicyView(policy, device.id);
  },

  // ============================================================
  // 时间表
  // ============================================================

  /**
   * 列出时间表，并附带一份「按服务器时间算出来」的实时预览。
   *
   * 预览刻意由后端计算而不是前端自己推：规则求值（跨天、unlock 优先）只有一处实现，
   * 前端再实现一遍必然会和设备端的执行结果产生偏差。
   * 但也要说明：真正执行的是设备，它以设备本地时钟为准，服务器时钟只作参考。
   */
  async list(device: ChildDevice) {
    const [rules, policy] = await Promise.all([
      prisma.scheduleRule.findMany({ where: { deviceId: device.id }, orderBy: { startMinute: 'asc' } }),
      prisma.lockPolicy.findUnique({ where: { deviceId: device.id } }),
    ]);

    const now = new Date();
    const decision = evaluateSchedule(rules, now);
    const boundary = nextScheduleBoundary(rules, now);
    const scheduleEnabled = policy?.scheduleEnabled ?? false;

    return {
      schedules: rules.map(toScheduleView),
      scheduleEnabled,
      /** 按服务器时间计算的预览；设备端以本地时钟为准。 */
      preview: {
        lockedNow: scheduleEnabled ? decision.locked : false,
        matchedRuleName: scheduleEnabled ? decision.ruleName : null,
        nextChangeAt: scheduleEnabled && boundary ? boundary.at : null,
        nextChangeLocked: scheduleEnabled && boundary ? boundary.locked : null,
        evaluatedAt: now,
      },
    };
  },

  async create(
    device: ChildDevice,
    input: { name: string; action: string; daysOfWeek: number[]; startMinute: number; endMinute: number; enabled: boolean },
  ) {
    const rule = await prisma.scheduleRule.create({
      data: {
        deviceId: device.id,
        name: input.name,
        action: input.action,
        // 去重并排序，避免同一个星期被写两次导致 UI 上出现重复勾选
        daysOfWeek: Array.from(new Set(input.daysOfWeek)).sort((a, b) => a - b),
        startMinute: input.startMinute,
        endMinute: input.endMinute,
        enabled: input.enabled,
      },
    });
    // 一旦开始配时间表，就把总开关打开 —— 否则用户会以为设了没生效
    await scheduleService.ensureScheduleEnabled(device.id);
    logger.info({ msg: 'schedule created', deviceId: device.id, ruleId: rule.id });
    return toScheduleView(rule);
  },

  async update(
    device: ChildDevice,
    scheduleId: string,
    patch: {
      name?: string;
      action?: string;
      daysOfWeek?: number[];
      startMinute?: number;
      endMinute?: number;
      enabled?: boolean;
    },
  ) {
    // 先确认这条规则属于这台设备，避免换 id 改别人家的作息表
    const existing = await prisma.scheduleRule.findFirst({ where: { id: scheduleId, deviceId: device.id } });
    if (!existing) throw new NotFoundError('时间表规则', scheduleId);

    const nextStart = patch.startMinute ?? existing.startMinute;
    const nextEnd = patch.endMinute ?? existing.endMinute;
    if (nextStart === nextEnd) {
      throw new BadRequestError('开始时间与结束时间不能相同（全天请填 00:00 → 24:00）');
    }

    const rule = await prisma.scheduleRule.update({
      where: { id: scheduleId },
      data: {
        ...patch,
        ...(patch.daysOfWeek
          ? { daysOfWeek: Array.from(new Set(patch.daysOfWeek)).sort((a, b) => a - b) }
          : {}),
      },
    });
    return toScheduleView(rule);
  },

  async remove(device: ChildDevice, scheduleId: string) {
    const existing = await prisma.scheduleRule.findFirst({ where: { id: scheduleId, deviceId: device.id } });
    if (!existing) throw new NotFoundError('时间表规则', scheduleId);
    await prisma.scheduleRule.delete({ where: { id: scheduleId } });
    logger.info({ msg: 'schedule removed', deviceId: device.id, ruleId: scheduleId });
    return { success: true };
  },

  /** 设置时间表时自动打开总开关（幂等）。 */
  async ensureScheduleEnabled(deviceId: string) {
    await prisma.lockPolicy.upsert({
      where: { deviceId },
      create: { deviceId, scheduleEnabled: true },
      update: { scheduleEnabled: true },
    });
  },

  // ============================================================
  // 供设备端 /agent/config 使用
  // ============================================================

  /** 设备端要的全部锁屏策略：强度、倒计时、以及启用的时间表规则。 */
  async buildAgentPayload(deviceId: string) {
    const [policy, rules] = await Promise.all([
      prisma.lockPolicy.findUnique({ where: { deviceId } }),
      prisma.scheduleRule.findMany({
        where: { deviceId, enabled: true },
        orderBy: { startMinute: 'asc' },
      }),
    ]);

    const view = toPolicyView(policy, deviceId);
    return {
      strength: view.strength,
      countdownSeconds: view.countdownSeconds,
      scheduleEnabled: view.scheduleEnabled,
      // 只下发启用的规则：设备端不需要知道被停用的规则，少一份状态少一类 bug
      schedule: view.scheduleEnabled
        ? rules.map((r) => ({
            id: r.id,
            name: r.name,
            action: r.action,
            daysOfWeek: r.daysOfWeek,
            startMinute: r.startMinute,
            endMinute: r.endMinute,
          }))
        : [],
    };
  },
};

export { toScheduleView, toPolicyView };
