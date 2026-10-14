import { Router } from 'express';
import { ah } from '../../shared/asyncHandler';
import * as controller from './membership.admin.controller';

/**
 * /api/admin/membership —— 会员套餐、定价规则、订单与统计。
 *
 * 挂载点：`server/src/features/admin/admin.routes.ts` 里的 `adminRoutes.use('/membership', …)`，
 * 即位于 `adminAudit` 与 `authenticateAdmin` 之后 —— 权限与审计都由父路由统一负责，
 * 这里不再重复挂鉴权，避免出现「某个子路由忘了加」的口子。
 *
 * 没有 `requireSuperAdmin`：定价规则属于日常运营动作，运营/普通管理员要能改；
 * 管理员账号本身的管理才是超级管理员专属。
 */
export const membershipAdminRoutes = Router();

// 套餐
membershipAdminRoutes.get('/plans', ah(controller.listPlans));
membershipAdminRoutes.post('/plans', ah(controller.createPlan));
membershipAdminRoutes.patch('/plans/:id', ah(controller.updatePlan));
membershipAdminRoutes.delete('/plans/:id', ah(controller.removePlan));

// 定价规则
membershipAdminRoutes.get('/rules', ah(controller.listRules));
membershipAdminRoutes.post('/rules', ah(controller.createRule));
membershipAdminRoutes.patch('/rules/:id', ah(controller.updateRule));
membershipAdminRoutes.delete('/rules/:id', ah(controller.removeRule));

// 受邀用户定价规则（会员价格 × 是否被邀请注册）
membershipAdminRoutes.get('/referral-rules', ah(controller.listReferralPriceRules));
membershipAdminRoutes.post('/referral-rules', ah(controller.createReferralPriceRule));
membershipAdminRoutes.patch('/referral-rules/:id', ah(controller.updateReferralPriceRule));
membershipAdminRoutes.delete('/referral-rules/:id', ah(controller.removeReferralPriceRule));

// 试算：改规则前先看效果
membershipAdminRoutes.post('/simulate', ah(controller.simulate));

// 订单与统计
membershipAdminRoutes.get('/orders', ah(controller.listOrders));
membershipAdminRoutes.get('/stats', ah(controller.stats));
