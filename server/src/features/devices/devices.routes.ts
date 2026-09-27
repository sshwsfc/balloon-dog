import { Router } from 'express';
import { ah } from '../../shared/asyncHandler';
import { authenticate } from '../../middleware/auth';
import * as controller from './devices.controller';

/**
 * 设备管理 / 当前设备状态 / 功能配置 三组路由。
 * 全部要求家长登录 —— 这是与 mock 版最根本的差别：
 * mock 的 /api/device 与 /api/features 完全裸奔，未登录也能读写。
 */

/** /api/devices —— 设备管理（列表、绑定、改名、解绑、切换） */
export const devicesRoutes = Router();
devicesRoutes.use(authenticate);
devicesRoutes.get('/', ah(controller.listDevices));
devicesRoutes.post('/bind', ah(controller.bindDevice));
devicesRoutes.put('/:deviceId', ah(controller.updateDevice));
devicesRoutes.delete('/:deviceId', ah(controller.removeDevice));
devicesRoutes.post('/:deviceId/select', ah(controller.selectDeviceById));

/** /api/device —— 当前设备状态与指令下发 */
export const deviceRoutes = Router();
deviceRoutes.use(authenticate);
deviceRoutes.get('/', ah(controller.getDevice));
deviceRoutes.post('/lock', ah(controller.lockDevice));
deviceRoutes.post('/temp-unlock', ah(controller.tempUnlock));
deviceRoutes.post('/cancel-temp-unlock', ah(controller.cancelTempUnlock));
deviceRoutes.post('/remote-photo', ah(controller.remotePhoto));
deviceRoutes.post('/screenshot', ah(controller.screenshot));
deviceRoutes.post('/start-recording', ah(controller.startRecording));
deviceRoutes.post('/stop-recording', ah(controller.stopRecording));
deviceRoutes.post('/start-audio', ah(controller.startAudio));
deviceRoutes.post('/stop-audio', ah(controller.stopAudio));
deviceRoutes.get('/commands', ah(controller.listCommands));
deviceRoutes.post('/commands/:commandId/cancel', ah(controller.cancelCommand));

/** /api/features —— 功能开关与各项配置 */
export const featureRoutes = Router();
featureRoutes.use(authenticate);
featureRoutes.get('/', ah(controller.getFeatures));
featureRoutes.put('/', ah(controller.updateFeature));
featureRoutes.put('/time-plan', ah(controller.setTimePlan));
featureRoutes.put('/app-limit', ah(controller.setAppLimit));
featureRoutes.delete('/app-limit/:appName', ah(controller.removeAppLimit));
featureRoutes.post('/app-audit', ah(controller.auditApp));
featureRoutes.post('/web-block', ah(controller.blockUrl));
featureRoutes.delete('/web-block/:url', ah(controller.unblockUrl));

/**
 * /api/user —— 兼容前端既有路径的薄封装。
 * 保留是为了让老前端零改动也能跑；新前端应逐步迁到 /api/devices。
 */
export const userCompatRoutes = Router();
userCompatRoutes.use(authenticate);
userCompatRoutes.get('/devices', ah(controller.listDevicesCompat));
userCompatRoutes.post('/devices', ah(controller.addDeviceCompat));
userCompatRoutes.delete('/devices/:deviceId', ah(controller.removeDeviceCompat));
userCompatRoutes.post('/select-device', ah(controller.selectDevice));
