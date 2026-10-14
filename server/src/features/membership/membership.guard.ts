/**
 * 会员门禁：其他业务切片只通过这里判断「这个账号能不能用这个功能」。
 *
 * 为什么单独一层：门禁散落在各 service 里直接读 user.membershipTier 时，
 * 一旦忘了把「已过期」算进去（库里档位还是 member，但到期时间早就过了），
 * 就会出现永久白嫖。这里统一走 resolveMembership() 拿「此刻真正生效的档位」。
 */

import { MembershipRequiredError } from '../../errors';
import {
  ENTITLEMENTS,
  FEATURE_ENTITLEMENTS,
  FREE_DEVICE_LIMIT,
  TIER_LABELS,
  TIER_RANK,
  entitlementOf,
  type MembershipTier,
} from './membership.constants';
import { membershipService } from './membership.service';

/** 某档位是否已解锁某权益。 */
export function tierHasEntitlement(tier: MembershipTier, entitlementKey: string): boolean {
  const def = entitlementOf(entitlementKey);
  if (!def) return true; // 未知权益不拦（宁可少拦也不要误拦基础功能）
  return TIER_RANK[tier] >= TIER_RANK[def.minTier];
}

/** 设备功能开关 → 所需权益；基础功能返回 null。 */
export function entitlementForFeature(featureKey: string): string | null {
  return FEATURE_ENTITLEMENTS[featureKey] ?? null;
}

/** 断言账号已开通某权益，否则抛 403 MEMBERSHIP_REQUIRED。 */
export async function requireEntitlement(userId: number, entitlementKey: string): Promise<void> {
  const def = entitlementOf(entitlementKey);
  if (!def) return;
  const status = await membershipService.getStatus(userId);
  if (tierHasEntitlement(status.tier, entitlementKey)) return;
  throw new MembershipRequiredError(
    `「${def.label}」是${TIER_LABELS[def.minTier]}专属功能，开通后即可使用`,
    { requiredTier: def.minTier, entitlement: entitlementKey, currentTier: status.tier },
  );
}

/** 断言设备功能开关可以开启/下发。基础功能直接放行。 */
export async function requireFeatureEntitlement(userId: number, featureKey: string): Promise<void> {
  const entitlementKey = entitlementForFeature(featureKey);
  if (!entitlementKey) return;
  await requireEntitlement(userId, entitlementKey);
}

/** 该账号当前允许绑定的设备数上限。 */
export async function deviceLimitFor(userId: number, hardLimit: number): Promise<number> {
  const status = await membershipService.getStatus(userId);
  return tierHasEntitlement(status.tier, 'multiDevice') ? hardLimit : FREE_DEVICE_LIMIT;
}

/** 家长端的权益对照表（会员页展示用）。 */
export function allEntitlements() {
  return ENTITLEMENTS;
}
