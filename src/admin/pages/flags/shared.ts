import type { FlagBucket, FlagView } from '../../api'

/**
 * 灰度开关的展示辅助。
 *
 * 后端 `flags.service.ts` 的 `FlagView` **没有** `ruleText`（也没有 `rule` / `kind` /
 * `evaluation`），只返回 `enabled / rolloutPercent / allowIds / bucket / usingDefaults`。
 * 任务书里写的 `ruleText` 是要求「用户能看懂当前规则」，所以这里按后端真实的求值顺序
 * 把规则拼成人话，并且**逐条对应 `evaluateFlag()` 的分支**，不额外发明规则。
 */

export const BUCKET_LABELS: Record<FlagBucket, string> = {
  user: '按账号',
  device: '按设备',
  none: '全局',
}

/** 白名单里一项最多 64 字，整个名单最多 200 项（`flags.dto.ts`）。 */
export const ALLOW_ID_MAX = 64
export const ALLOW_IDS_MAX = 200
export const DESCRIPTION_MAX = 200

/**
 * 把当前规则拼成人话。
 *
 * 对应 `evaluateFlag()` 的短路顺序：
 * 白名单 → 开关停用 → 100% → 0% → 无放量维度 → 缺少试算对象 → 哈希分桶。
 */
export function flagRuleText(flag: FlagView): string {
  const bucketLabel = BUCKET_LABELS[flag.bucket]
  const parts: string[] = []

  if (!flag.enabled) {
    parts.push('开关已停用：求值第一步就返回「开关关闭」，任何对象都不命中（白名单也不看）。')
  } else if (flag.bucket === 'none') {
    parts.push('全局开关：只认开 / 关，百分比对它没有意义，所有对象都会命中。')
  } else if (flag.rolloutPercent >= 100) {
    parts.push(`${bucketLabel}哈希放量 100%：所有对象命中，不再真的去算哈希。`)
  } else if (flag.rolloutPercent <= 0) {
    parts.push(`${bucketLabel}哈希放量 0%：没有任何对象命中，白名单除外。`)
  } else {
    parts.push(
      `${bucketLabel}哈希放量 ${flag.rolloutPercent}%：对「${flag.key}:<对象 id>」做 sha256，` +
        `取前 4 字节对 100 取模、结果小于 ${flag.rolloutPercent} 才算命中。`,
    )
  }

  if (flag.allowIds.length > 0) {
    parts.push(
      `另有 ${flag.allowIds.length} 个${bucketLabel}白名单：白名单在求值最前面，名单内的对象无论开关与百分比如何都命中。`,
    )
  }

  return parts.join('')
}

/** 试算对象的提示文案：全局开关不按对象放量，填了 id 也不影响结果。 */
export function subjectHint(flag: FlagView): string {
  if (flag.bucket === 'none') return '这是一个全局开关，试算对象 id 不会影响结果（填不填都一样）'
  if (flag.bucket === 'device') return '这个开关按设备放量，请填设备 id'
  return '这个开关按账号放量，请填家长账号 id'
}

/** 把多行 / 逗号 / 空格分隔的输入切成白名单数组。 */
export function parseAllowIds(raw: string): string[] {
  return raw
    .split(/[\s,，;；]+/)
    .map((v) => v.trim())
    .filter((v) => v.length > 0)
}

/** 后端只存 `updatedBy`（管理员 id 的数字）——没有返回名字，所以这里只如实显示 id。 */
export function updatedByText(flag: FlagView): string {
  if (flag.usingDefaults) return '代码默认值'
  if (flag.updatedBy === null) return '未知操作人'
  return `管理员 #${flag.updatedBy}`
}
