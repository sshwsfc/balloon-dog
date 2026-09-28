import { Router, Request, Response } from 'express';
import { ah } from '../../shared/asyncHandler';
import { authenticate } from '../../middleware/auth';
import { resolveDevice } from '../../shared/deviceScope';
import { scheduleService } from './schedule.service';
import {
  createScheduleSchema,
  scheduleIdSchema,
  updateLockPolicySchema,
  updateScheduleSchema,
} from './schedule.dto';

/**
 * 定时锁屏 / 定时解锁。
 *
 * 与项目里其它设备维度接口一样，全部经 {@link resolveDevice} 做归属校验 ——
 * 时间表决定了孩子什么时候能用手机，是敏感配置，绝不能靠前端传的 deviceId 说了算。
 * 不传 deviceId 时按「显式参数 → activeDeviceId → 最早绑定设备」三级回落。
 */

// ============================================================
// 锁屏强度策略
// ============================================================

/** GET /api/lock-policy */
export async function getPolicy(req: Request, res: Response) {
  const device = await resolveDevice(req);
  res.json(await scheduleService.getPolicy(device));
}

/** PUT /api/lock-policy */
export async function updatePolicy(req: Request, res: Response) {
  const patch = updateLockPolicySchema.parse(req.body);
  const device = await resolveDevice(req);
  res.json({ success: true, policy: await scheduleService.updatePolicy(device, patch) });
}

// ============================================================
// 时间表
// ============================================================

/** GET /api/schedules */
export async function listSchedules(req: Request, res: Response) {
  const device = await resolveDevice(req);
  res.json(await scheduleService.list(device));
}

/** POST /api/schedules */
export async function createSchedule(req: Request, res: Response) {
  const input = createScheduleSchema.parse(req.body);
  const device = await resolveDevice(req);
  res.status(201).json({ success: true, schedule: await scheduleService.create(device, input) });
}

/** PUT /api/schedules/:scheduleId */
export async function updateSchedule(req: Request, res: Response) {
  const { scheduleId } = scheduleIdSchema.parse(req.params);
  const patch = updateScheduleSchema.parse(req.body);
  const device = await resolveDevice(req);
  res.json({ success: true, schedule: await scheduleService.update(device, scheduleId, patch) });
}

/** DELETE /api/schedules/:scheduleId */
export async function removeSchedule(req: Request, res: Response) {
  const { scheduleId } = scheduleIdSchema.parse(req.params);
  const device = await resolveDevice(req);
  res.json(await scheduleService.remove(device, scheduleId));
}

// ============================================================
// 路由
// ============================================================

/** /api/lock-policy */
export const lockPolicyRoutes = Router();
lockPolicyRoutes.use(authenticate);
lockPolicyRoutes.get('/', ah(getPolicy));
lockPolicyRoutes.put('/', ah(updatePolicy));

/** /api/schedules */
export const scheduleRoutes = Router();
scheduleRoutes.use(authenticate);
scheduleRoutes.get('/', ah(listSchedules));
scheduleRoutes.post('/', ah(createSchedule));
scheduleRoutes.put('/:scheduleId', ah(updateSchedule));
scheduleRoutes.delete('/:scheduleId', ah(removeSchedule));
