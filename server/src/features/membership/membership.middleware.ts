import type { NextFunction, Request, Response } from 'express';
import { currentUserId } from '../../shared/deviceScope';
import { requireEntitlement } from './membership.guard';

/**
 * 路由级会员门禁，放在 `authenticate` 之后。
 *
 * 用法：
 * ```ts
 * insightRoutes.use(authenticate);
 * insightRoutes.use(entitlementGate('aiInsight'));
 * ```
 *
 * 为什么不直接在 handler 里 `await requireEntitlement(...)`：这些路由是
 * 「整个功能都归超级会员」的，写在路由上比在每个 handler 里重复一遍更不容易漏；
 * 漏一处的后果是那个接口能被白嫖，而且不会有任何报错提示。
 */
export function entitlementGate(entitlementKey: string) {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      await requireEntitlement(currentUserId(req), entitlementKey);
      next();
    } catch (err) {
      next(err);
    }
  };
}
