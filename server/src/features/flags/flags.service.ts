import { createHash } from 'node:crypto';
import type { RuntimeFlag } from '@prisma/client';
import { prisma } from '../../prisma';
import { logger } from '../../logger';
import { BadRequestError, NotFoundError } from '../../errors';
import { FLAG_DEFS, flagDefOf, isKnownFlag, type FlagDef } from './flags.constants';

/**
 * 灰度开关的求值（规划 §5.5）。
 *
 * 三条硬规则：
 *
 * 1. **不确定就关闭**：需要灰度对象的开关没拿到对象 id 时返回 `false` 并打 warn，
 *    绝不「无法判断就放行」。
 * 2. **白名单优先**：白名单里的对象永远命中 —— 包括 `enabled = false` 的时候。
 *    白名单的意思是「我就要它开」，不是「顺便也开一下」。
 * 3. **百分比是稳定散列**：`sha256(key:subjectId)` 取模，同一个对象每次结果一致。
 *    用 `Math.random()` 会让家长每刷新一次就看到不同的界面，也无法复现线上问题。
 *
 * **刻意不做进程内缓存**：后台点「关掉」必须立刻生效。一次主键查询的成本换「运营的
 * 处置是同步的」，这笔账在任何量级下都划算 —— 支付/退款/出站这些路径本来就要写库。
 */

export interface FlagView {
  key: string;
  label: string;
  description: string;
  bucket: FlagDef['bucket'];
  enabled: boolean;
  rolloutPercent: number;
  allowIds: string[];
  updatedAt: Date | null;
  updatedBy: number | null;
  /** 数据库里还没有这一行，正在用代码默认值（界面要如实标出来） */
  usingDefaults: boolean;
  wiredAt: string;
}

export interface FlagEvaluation {
  key: string;
  hit: boolean;
  /** 机器可读的原因，便于断言与界面映射 */
  reason:
    | 'allowlisted'
    | 'flag_disabled'
    | 'rollout_full'
    | 'rollout_zero'
    | 'missing_subject'
    | 'rollout_bucket';
  /** 人话说明（后台预览与界面提示直接用） */
  reasonText: string;
  /**
   * 数据库里没有这一行、当前用的是代码默认值。
   *
   * 与其把「默认值」写成第 7 种 `reason`，不如独立成一个布尔：命中与否仍由
   * `reason` 说清（放量 / 白名单 / 关闭），而这个字段回答的是「这个状态持久化了吗」。
   */
  usingDefaults: boolean;
}

function normalizeAllowIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((x) => String(x)).filter((x) => x.length > 0);
}

/** 数据库行 + 代码默认值合并成「当前生效的定义」。 */
function resolve(def: FlagDef, row: RuntimeFlag | null) {
  return {
    enabled: row ? row.enabled : def.defaultEnabled,
    rolloutPercent: row ? row.rolloutPercent : def.defaultRolloutPercent,
    allowIds: normalizeAllowIds(row?.allowIds),
    usingDefaults: row == null,
  };
}

function evaluateCore(
  def: FlagDef,
  row: RuntimeFlag | null,
  subjectId?: string | null,
): Omit<FlagEvaluation, 'usingDefaults'> {
  const state = resolve(def, row);
  const subject = subjectId == null || String(subjectId).length === 0 ? null : String(subjectId);

  if (subject && state.allowIds.includes(subject)) {
    return {
      key: def.key,
      hit: true,
      reason: 'allowlisted',
      reasonText: '在白名单里（白名单优先于开关与百分比）',
    };
  }

  if (!state.enabled) {
    return { key: def.key, hit: false, reason: 'flag_disabled', reasonText: '开关已关闭' };
  }

  if (state.rolloutPercent >= 100) {
    return {
      key: def.key,
      hit: true,
      reason: 'rollout_full',
      reasonText: '全量开放',
    };
  }

  if (state.rolloutPercent <= 0) {
    return { key: def.key, hit: false, reason: 'rollout_zero', reasonText: '放量比例为 0' };
  }

  if (def.bucket === 'none') {
    // 全局开关配了中间比例：没有可散列的对象，按「开」处理过于乐观，按「关」又违背
    // 管理员的显式设置 —— 只有 0 与 100 对全局开关有意义，中间值一律当成开启并提示。
    return {
      key: def.key,
      hit: true,
      reason: 'rollout_full',
      reasonText: '全局开关（百分比只对按账号/设备放量的开关有意义）',
    };
  }

  if (!subject) {
    logger.warn({
      msg: 'feature flag has no subject, defaulting to off',
      flag: def.key,
      bucket: def.bucket,
    });
    return {
      key: def.key,
      hit: false,
      reason: 'missing_subject',
      reasonText: `这个开关按${def.bucket === 'user' ? '账号' : '设备'}放量，但调用方没有给出对象，保守关闭`,
    };
  }

  const digest = createHash('sha256').update(`${def.key}:${subject}`).digest();
  const bucketValue = digest.readUInt32BE(0) % 100;
  const hit = bucketValue < state.rolloutPercent;
  return {
    key: def.key,
    hit,
    reason: 'rollout_bucket',
    reasonText: `稳定散列落在 ${bucketValue}，阈值 ${state.rolloutPercent}（${hit ? '命中' : '未命中'}）`,
  };
}

/** 求值一个开关：命中与否 + 原因 + 人为说明 + 是否在用代码默认值。 */
export function evaluateFlag(
  def: FlagDef,
  row: RuntimeFlag | null,
  subjectId?: string | null,
): FlagEvaluation {
  return { ...evaluateCore(def, row, subjectId), usingDefaults: row == null };
}

/**
 * 求值一个开关。`subjectId` 必填与否取决于这个开关的 bucket：
 * 按账号放量传 userId，按设备放量传 deviceId，全局开关传 null。
 */
export async function flagEnabled(
  key: string,
  subjectId?: string | number | null,
): Promise<boolean> {
  const def = flagDefOf(key);
  if (!def) {
    // 代码里没定义的 key 一律关闭并告警：手写字符串拼错的开关不能变成「默认放行」
    logger.warn({ msg: 'unknown feature flag, defaulting to off', flag: key });
    return false;
  }
  const row = await prisma.runtimeFlag.findUnique({ where: { key } });
  return evaluateFlag(def, row, subjectId == null ? null : String(subjectId)).hit;
}

/** 同上，但把判定过程一起返回（后台预览、家长端提示文案用）。 */
export async function flagState(
  key: string,
  subjectId?: string | number | null,
): Promise<FlagEvaluation> {
  const def = flagDefOf(key);
  if (!def) throw new NotFoundError('开关', key);
  const row = await prisma.runtimeFlag.findUnique({ where: { key } });
  return evaluateFlag(def, row, subjectId == null ? null : String(subjectId));
}

/** 数据库缺行时补上（幂等）。启动时调用一次，保证后台看到的列表与代码定义一致。 */
export async function ensureFlagDefaults(): Promise<number> {
  let created = 0;
  for (const def of FLAG_DEFS) {
    const existing = await prisma.runtimeFlag.findUnique({ where: { key: def.key } });
    if (existing) continue;
    await prisma.runtimeFlag.create({
      data: {
        key: def.key,
        label: def.label,
        description: def.description,
        enabled: def.defaultEnabled,
        rolloutPercent: def.defaultRolloutPercent,
        allowIds: [],
      },
    });
    created += 1;
  }
  if (created > 0) logger.info({ msg: 'feature flag defaults restored', created });
  return created;
}

export async function listFlags(): Promise<FlagView[]> {
  const rows = await prisma.runtimeFlag.findMany();
  const byKey = new Map(rows.map((r) => [r.key, r]));
  return FLAG_DEFS.map((def) => {
    const row = byKey.get(def.key) ?? null;
    return {
      key: def.key,
      label: row?.label ?? def.label,
      description: row?.description || def.description,
      bucket: def.bucket,
      enabled: row ? row.enabled : def.defaultEnabled,
      rolloutPercent: row ? row.rolloutPercent : def.defaultRolloutPercent,
      allowIds: normalizeAllowIds(row?.allowIds),
      updatedAt: row?.updatedAt ?? null,
      updatedBy: row?.updatedBy ?? null,
      usingDefaults: row == null,
      wiredAt: def.wiredAt,
    };
  });
}

export interface FlagPatch {
  enabled?: boolean;
  rolloutPercent?: number;
  allowIds?: string[];
  description?: string;
}

export async function updateFlag(
  key: string,
  patch: FlagPatch,
  adminId: number | null,
): Promise<FlagView> {
  if (!isKnownFlag(key)) throw new NotFoundError('开关', key);
  const def = flagDefOf(key)!;
  const data: Record<string, unknown> = { updatedBy: adminId };
  if (patch.enabled !== undefined) data.enabled = patch.enabled;
  if (patch.rolloutPercent !== undefined) {
    if (!Number.isInteger(patch.rolloutPercent) || patch.rolloutPercent < 0 || patch.rolloutPercent > 100) {
      throw new BadRequestError('放量比例必须是 0-100 的整数');
    }
    data.rolloutPercent = patch.rolloutPercent;
  }
  if (patch.allowIds !== undefined) data.allowIds = patch.allowIds;
  if (patch.description !== undefined) data.description = patch.description;

  await prisma.runtimeFlag.upsert({
    where: { key },
    create: {
      key,
      label: def.label,
      description: patch.description ?? def.description,
      enabled: patch.enabled ?? def.defaultEnabled,
      rolloutPercent: patch.rolloutPercent ?? def.defaultRolloutPercent,
      allowIds: patch.allowIds ?? [],
      updatedBy: adminId,
    },
    update: data,
  });
  const views = await listFlags();
  return views.find((v) => v.key === key)!;
}

/** 恢复代码默认值：删掉数据库那一行，求值随即回到 `FLAG_DEFS`。 */
export async function resetFlag(key: string): Promise<FlagView> {
  if (!isKnownFlag(key)) throw new NotFoundError('开关', key);
  await prisma.runtimeFlag.deleteMany({ where: { key } });
  await ensureFlagDefaults();
  const views = await listFlags();
  return views.find((v) => v.key === key)!;
}
