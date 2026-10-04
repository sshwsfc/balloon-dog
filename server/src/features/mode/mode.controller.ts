import { Router, Request, Response } from 'express';
import { ah } from '../../shared/asyncHandler';
import { authenticate, authenticateDevice } from '../../middleware/auth';
import { resolveDevice, currentDeviceId, currentUserId } from '../../shared/deviceScope';
import { devicesService } from '../devices/devices.service';
import { prisma } from '../../prisma';
import { NotFoundError } from '../../errors';
import { modeService } from './mode.service';
import {
  addModeAppSchema,
  deviceAppQuerySchema,
  modeAppIdSchema,
  replaceSlotsSchema,
  reportAppsSchema,
  reportEventsSchema,
  updateEyeCareSchema,
  updateModeSchema,
  updatePluginsSchema,
} from './mode.dto';

/**
 * 模式切换 / 护眼设置 / 应用插件管控。
 *
 * 家长端接口一律经 {@link resolveDevice} 做归属校验；
 * 设备端接口经 authenticateDevice，且**只能操作自己**（不接收 deviceId 参数），
 * 这样不存在「伪造 deviceId 上报别家设备应用清单」的可能。
 */

// ============================================================
// 家长端
// ============================================================

/** GET /api/device-mode */
export async function getMode(req: Request, res: Response) {
  const device = await resolveDevice(req);
  res.json(await modeService.getMode(device));
}

/** PUT /api/device-mode */
export async function updateMode(req: Request, res: Response) {
  const patch = updateModeSchema.parse(req.body);
  const device = await resolveDevice(req);
  res.json({ success: true, mode: await modeService.updateMode(device, patch) });
}

/** GET /api/study-slots */
export async function getSlots(req: Request, res: Response) {
  const device = await resolveDevice(req);
  res.json(await modeService.getSlots(device));
}

/** PUT /api/study-slots —— 整表替换 */
export async function replaceSlots(req: Request, res: Response) {
  const { slots } = replaceSlotsSchema.parse(req.body);
  const device = await resolveDevice(req);
  res.json({ success: true, ...(await modeService.replaceSlots(device, slots)) });
}

/** GET /api/mode-apps */
export async function listModeApps(req: Request, res: Response) {
  const device = await resolveDevice(req);
  res.json(await modeService.listModeApps(device));
}

/** POST /api/mode-apps */
export async function addModeApp(req: Request, res: Response) {
  const input = addModeAppSchema.parse(req.body);
  const device = await resolveDevice(req);
  res.json({ success: true, app: await modeService.addModeApp(device, input) });
}

/** DELETE /api/mode-apps/:id */
export async function removeModeApp(req: Request, res: Response) {
  const { id } = modeAppIdSchema.parse(req.params);
  const device = await resolveDevice(req);
  res.json(await modeService.removeModeApp(device, id));
}

/** GET /api/device-apps */
export async function listDeviceApps(req: Request, res: Response) {
  const query = deviceAppQuerySchema.parse(req.query);
  const device = await resolveDevice(req);
  res.json(await modeService.listDeviceApps(device, query));
}

/** POST /api/device-apps/refresh —— 让设备重新上报应用清单（走指令队列） */
export async function refreshDeviceApps(req: Request, res: Response) {
  const device = await resolveDevice(req);
  // dispatchCommand 返回的是 { success, command }，这里解一层再往外包，
  // 否则前端会拿到 { success, command: { success, command } } 这种双层嵌套
  const dispatched = await devicesService.requestAppSync(currentUserId(req), device);
  res.json({ success: true, command: dispatched.command });
}

/** GET /api/eye-care */
export async function getEyeCare(req: Request, res: Response) {
  const device = await resolveDevice(req);
  res.json({ config: await modeService.getEyeCare(device) });
}

/** PUT /api/eye-care */
export async function updateEyeCare(req: Request, res: Response) {
  const patch = updateEyeCareSchema.parse(req.body);
  const device = await resolveDevice(req);
  res.json({ success: true, config: await modeService.updateEyeCare(device, patch) });
}

/** GET /api/app-plugins */
export async function listAppPlugins(req: Request, res: Response) {
  const device = await resolveDevice(req);
  res.json(await modeService.listAppPlugins(device));
}

/** PUT /api/app-plugins */
export async function updateAppPlugins(req: Request, res: Response) {
  const input = updatePluginsSchema.parse(req.body);
  const device = await resolveDevice(req);
  res.json({ success: true, ...(await modeService.updateAppPlugins(device, input)) });
}

/** GET /api/device-events —— 最新动态 */
export async function listDeviceEvents(req: Request, res: Response) {
  const device = await resolveDevice(req);
  res.json(await modeService.listEvents(device, req.query as Record<string, unknown>));
}

// ============================================================
// 设备端
// ============================================================

/** 设备主体 → 设备行。除 authenticateDevice 外不做别的判断。 */
async function deviceOf(req: Request) {
  const id = currentDeviceId(req);
  const device = await prisma.childDevice.findUnique({ where: { id } });
  if (!device) throw new NotFoundError('设备', id);
  return device;
}

/** POST /api/agent/apps */
export async function reportApps(req: Request, res: Response) {
  const input = reportAppsSchema.parse(req.body);
  res.json(await modeService.reportApps(await deviceOf(req), input));
}

/** POST /api/agent/events */
export async function reportEvents(req: Request, res: Response) {
  const input = reportEventsSchema.parse(req.body);
  res.json(await modeService.reportEvents(await deviceOf(req), input));
}

// ============================================================
// 路由
// ============================================================

/** 家长端路由：由 app.ts 挂到各自的 /api/xxx 前缀下。 */
export const deviceModeRoutes = Router();
deviceModeRoutes.use(authenticate);
deviceModeRoutes.get('/', ah(getMode));
deviceModeRoutes.put('/', ah(updateMode));

export const studySlotRoutes = Router();
studySlotRoutes.use(authenticate);
studySlotRoutes.get('/', ah(getSlots));
studySlotRoutes.put('/', ah(replaceSlots));

export const modeAppRoutes = Router();
modeAppRoutes.use(authenticate);
modeAppRoutes.get('/', ah(listModeApps));
modeAppRoutes.post('/', ah(addModeApp));
modeAppRoutes.delete('/:id', ah(removeModeApp));

export const deviceAppRoutes = Router();
deviceAppRoutes.use(authenticate);
deviceAppRoutes.get('/', ah(listDeviceApps));
deviceAppRoutes.post('/refresh', ah(refreshDeviceApps));

export const eyeCareRoutes = Router();
eyeCareRoutes.use(authenticate);
eyeCareRoutes.get('/', ah(getEyeCare));
eyeCareRoutes.put('/', ah(updateEyeCare));

export const appPluginRoutes = Router();
appPluginRoutes.use(authenticate);
appPluginRoutes.get('/', ah(listAppPlugins));
appPluginRoutes.put('/', ah(updateAppPlugins));

export const deviceEventRoutes = Router();
deviceEventRoutes.use(authenticate);
deviceEventRoutes.get('/', ah(listDeviceEvents));

/** 设备端路由：挂到 /api/agent 下（见 agent.routes.ts）。 */
export const modeAgentRoutes = Router();
modeAgentRoutes.post('/apps', authenticateDevice, ah(reportApps));
modeAgentRoutes.post('/events', authenticateDevice, ah(reportEvents));
