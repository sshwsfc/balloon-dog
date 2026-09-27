import { Router, Request, Response } from 'express';
import { ah } from '../../shared/asyncHandler';
import { authenticate } from '../../middleware/auth';
import { resolveDevice } from '../../shared/deviceScope';
import { locationsService } from './locations.service';
import {
  createSafeZoneSchema,
  locationQuerySchema,
  safeZoneIdSchema,
  updateSafeZoneSchema,
} from './locations.dto';

// ============================================================
// 位置历史
// ============================================================

/** GET /api/locations —— 当前设备的位置历史（可带 from/to 时间范围）。 */
export async function listLocations(req: Request, res: Response) {
  const query = locationQuerySchema.parse(req.query);
  const device = await resolveDevice(req);
  const locations = await locationsService.list(device, query);
  res.json({ locations });
}

/** GET /api/locations/latest —— 最近一次定位。 */
export async function latestLocation(req: Request, res: Response) {
  const device = await resolveDevice(req);
  const location = await locationsService.latest(device);
  res.json({ location });
}

// ============================================================
// 安全区
// ============================================================

/** GET /api/safe-zones */
export async function listSafeZones(req: Request, res: Response) {
  const device = await resolveDevice(req);
  res.json({ safeZones: await locationsService.listZones(device) });
}

/** POST /api/safe-zones */
export async function createSafeZone(req: Request, res: Response) {
  const input = createSafeZoneSchema.parse(req.body);
  const device = await resolveDevice(req);
  res.status(201).json({ success: true, safeZone: await locationsService.createZone(device, input) });
}

/** PUT /api/safe-zones/:safeZoneId */
export async function updateSafeZone(req: Request, res: Response) {
  const { safeZoneId } = safeZoneIdSchema.parse(req.params);
  const patch = updateSafeZoneSchema.parse(req.body);
  const device = await resolveDevice(req);
  res.json({ success: true, safeZone: await locationsService.updateZone(device, safeZoneId, patch) });
}

/** DELETE /api/safe-zones/:safeZoneId */
export async function removeSafeZone(req: Request, res: Response) {
  const { safeZoneId } = safeZoneIdSchema.parse(req.params);
  const device = await resolveDevice(req);
  res.json(await locationsService.removeZone(device, safeZoneId));
}

// ============================================================
// 路由
// ============================================================

/** /api/locations */
export const locationRoutes = Router();
locationRoutes.use(authenticate);
locationRoutes.get('/', ah(listLocations));
locationRoutes.get('/latest', ah(latestLocation));

/** /api/safe-zones */
export const safeZoneRoutes = Router();
safeZoneRoutes.use(authenticate);
safeZoneRoutes.get('/', ah(listSafeZones));
safeZoneRoutes.post('/', ah(createSafeZone));
safeZoneRoutes.put('/:safeZoneId', ah(updateSafeZone));
safeZoneRoutes.delete('/:safeZoneId', ah(removeSafeZone));
