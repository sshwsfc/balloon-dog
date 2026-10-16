import { Request, Response } from 'express';
import {
  bindDeviceSchema,
  updateDeviceSchema,
  selectDeviceSchema,
  lockSchema,
  tempUnlockSchema,
  deviceIdSchema,
  commandListQuerySchema,
  commandIdSchema,
  callLogQuerySchema,
  smsQuerySchema,
  remoteActionSchema,
  healthQuerySchema,
  timeRequestIdSchema,
  timeRequestQuerySchema,
  reviewTimeRequestSchema,
  inviteDeviceMemberSchema,
  deviceMemberIdSchema,
  updateDeviceMemberSchema,
} from './devices.dto';
import { devicesService } from './devices.service';
import {
  currentUserId,
  requireDeviceAccess,
  requireOwnerDevice,
  resolveDevice,
  resolveWritableDevice,
  toDeviceView,
} from '../../shared/deviceScope';
import { BadRequestError } from '../../errors';

/**
 * GET /api/device/health —— 家长读设备健康页（规划 §1.2）。
 *
 * 走 resolveDevice：不传 deviceId 就是「当前设备」，与其它家长端接口一致，
 * 前端切换设备后不用自己带 id。
 */
export async function getDeviceHealth(req: Request, res: Response) {
  healthQuerySchema.parse(req.query ?? {});
  const device = await resolveDevice(req);
  res.json(await devicesService.getDeviceHealth(device));
}

/**
 * POST /api/device/health/check —— 家长点「重新检测」（规划 §1.3）。
 *
 * 返回的是**指令**而不是新的健康数据：真正的检测发生在孩子手机上，
 * 这里立刻回一份「已下发」，家长端随后轮询 GET /api/device/health。
 */
export async function requestSelfCheck(req: Request, res: Response) {
  const device = await resolveWritableDevice(req);
  res.json(await devicesService.requestSelfCheck(currentUserId(req), device));
}

// ============================================================
// 设备管理
// ============================================================

/** GET /api/devices —— 当前账号下所有设备。 */
export async function listDevices(req: Request, res: Response) {
  const devices = await devicesService.listDevices(currentUserId(req));
  res.json({ devices });
}

/**
 * POST /api/devices/bind —— 凭设备码认领设备。
 *
 * 与 mock 版的核心差别：设备必须先在孩子手机上真实注册过（存在 deviceCode），
 * 家长不可能凭空「新建」一台不存在的设备。
 */
export async function bindDevice(req: Request, res: Response) {
  const { deviceCode, name } = bindDeviceSchema.parse(req.body);
  const result = await devicesService.bindDevice(currentUserId(req), deviceCode, name);
  res.status(result.alreadyBound ? 200 : 201).json(result);
}

/** PUT /api/devices/:deviceId —— 改设备名/头像。 */
export async function updateDevice(req: Request, res: Response) {
  const data = updateDeviceSchema.parse(req.body);
  const result = await devicesService.updateDevice(
    currentUserId(req),
    String(req.params.deviceId),
    data,
  );
  res.json(result);
}

/** DELETE /api/devices/:deviceId —— 解绑设备。 */
export async function removeDevice(req: Request, res: Response) {
  const result = await devicesService.removeDevice(currentUserId(req), String(req.params.deviceId));
  res.json(result);
}

/** POST /api/devices/:deviceId/select —— 设为当前操作设备。 */
export async function selectDeviceById(req: Request, res: Response) {
  const result = await devicesService.selectDevice(currentUserId(req), String(req.params.deviceId));
  res.json(result);
}

/** POST /api/user/select-device —— 兼容前端既有路径，body 传 deviceId。 */
export async function selectDevice(req: Request, res: Response) {
  const { deviceId } = selectDeviceSchema.parse(req.body);
  const result = await devicesService.selectDevice(currentUserId(req), deviceId);
  res.json(result);
}

// ============================================================
// 家庭成员（规划 §5.1）
// ============================================================

/**
 * GET /api/devices/:deviceId/members —— 一起守护这台设备的家长。
 * 任何成员都能看这份名单：只读成员也该知道除了自己还有谁在看这台设备。
 */
export async function listDeviceMembers(req: Request, res: Response) {
  const { deviceId } = deviceIdSchema.parse(req.params);
  const access = await requireDeviceAccess(currentUserId(req), deviceId);
  res.json(await devicesService.listDeviceMembers(access.device));
}

/**
 * POST /api/devices/:deviceId/members —— 邀请一位家长。
 * 只有所有者能邀请（admin 成员不能继续拉人）：权限一旦能自己复制自己，
 * 所有者就会在毫不知情的情况下多出几个能看他孩子数据的人。
 */
export async function inviteDeviceMember(req: Request, res: Response) {
  const { deviceId } = deviceIdSchema.parse(req.params);
  const device = await requireOwnerDevice(currentUserId(req), deviceId);
  const input = inviteDeviceMemberSchema.parse(req.body);
  res.status(201).json(await devicesService.inviteDeviceMember(device, input));
}

/** PATCH /api/devices/:deviceId/members/:memberId —— 改角色/称呼（仅所有者）。 */
export async function updateDeviceMember(req: Request, res: Response) {
  const { deviceId } = deviceIdSchema.parse(req.params);
  const { memberId } = deviceMemberIdSchema.parse(req.params);
  const device = await requireOwnerDevice(currentUserId(req), deviceId);
  const input = updateDeviceMemberSchema.parse(req.body);
  res.json(await devicesService.updateDeviceMember(device, memberId, input));
}

/** DELETE /api/devices/:deviceId/members/:memberId —— 移除成员（仅所有者）。 */
export async function removeDeviceMember(req: Request, res: Response) {
  const { deviceId } = deviceIdSchema.parse(req.params);
  const { memberId } = deviceMemberIdSchema.parse(req.params);
  const device = await requireOwnerDevice(currentUserId(req), deviceId);
  res.json(await devicesService.removeDeviceMember(device, memberId));
}

// ============================================================
// 当前设备状态
// ============================================================

/** GET /api/device —— 当前设备（未指定 deviceId 时用 activeDeviceId）。 */
export async function getDevice(req: Request, res: Response) {
  const device = await resolveDevice(req);
  const view = await devicesService.getDeviceView(currentUserId(req), device);
  res.json(view);
}

/** POST /api/device/lock —— 锁屏/解锁（下发指令给设备端执行）。 */
export async function lockDevice(req: Request, res: Response) {
  const { locked } = lockSchema.parse(req.body);
  const device = await resolveWritableDevice(req);
  const result = await devicesService.lock(currentUserId(req), device, locked);
  res.json(result);
}

/** POST /api/device/temp-unlock —— 临时解锁 N 分钟。 */
export async function tempUnlock(req: Request, res: Response) {
  const { minutes } = tempUnlockSchema.parse(req.body);
  const device = await resolveWritableDevice(req);
  const result = await devicesService.tempUnlock(currentUserId(req), device, minutes);
  res.json(result);
}

/** POST /api/device/cancel-temp-unlock */
export async function cancelTempUnlock(req: Request, res: Response) {
  const device = await resolveWritableDevice(req);
  const result = await devicesService.cancelTempUnlock(currentUserId(req), device);
  res.json(result);
}

// ============================================================
// 远程采集（拍照/截图/录像/录音）—— 全部走指令队列
// ============================================================

/** POST /api/device/remote-photo */
export async function remotePhoto(req: Request, res: Response) {
  const device = await resolveWritableDevice(req);
  const result = await devicesService.requestCapture(currentUserId(req), device, 'remote_photo');
  res.status(202).json(result);
}

/** POST /api/device/screenshot */
export async function screenshot(req: Request, res: Response) {
  const device = await resolveWritableDevice(req);
  const result = await devicesService.requestCapture(currentUserId(req), device, 'screenshot');
  res.status(202).json(result);
}

/** POST /api/device/start-recording */
export async function startRecording(req: Request, res: Response) {
  const device = await resolveWritableDevice(req);
  const result = await devicesService.requestCapture(currentUserId(req), device, 'start_recording');
  res.status(202).json(result);
}

/** POST /api/device/stop-recording */
export async function stopRecording(req: Request, res: Response) {
  const { recordingId } = req.body ?? {};
  const device = await resolveWritableDevice(req);
  if (typeof recordingId !== 'string' || !recordingId.trim()) {
    throw new BadRequestError('缺少录制 ID，请先开始录像');
  }
  const result = await devicesService.stopCapture(currentUserId(req), device, 'stop_recording', recordingId);
  res.status(202).json(result);
}

/** POST /api/device/start-audio */
export async function startAudio(req: Request, res: Response) {
  const device = await resolveWritableDevice(req);
  const result = await devicesService.requestCapture(currentUserId(req), device, 'start_audio');
  res.status(202).json(result);
}

/** POST /api/device/stop-audio */
export async function stopAudio(req: Request, res: Response) {
  const { recordingId } = req.body ?? {};
  const device = await resolveWritableDevice(req);
  if (typeof recordingId !== 'string' || !recordingId.trim()) {
    throw new BadRequestError('缺少录制 ID，请先开始录音');
  }
  const result = await devicesService.stopCapture(currentUserId(req), device, 'stop_audio', recordingId);
  res.status(202).json(result);
}

// ============================================================
// 环境监听 / 远程协助 / 通话短信刷新（§6 §7 §8）—— 同样全部走指令队列
// ============================================================

/** POST /api/device/start-ambient —— 开始环境监听（要求 audioRecord 开关）。 */
export async function startAmbient(req: Request, res: Response) {
  const device = await resolveWritableDevice(req);
  const result = await devicesService.requestAmbient(currentUserId(req), device, true);
  res.status(202).json(result);
}

/** POST /api/device/stop-ambient —— 停止环境监听（不检查开关，必须停得下来）。 */
export async function stopAmbient(req: Request, res: Response) {
  const device = await resolveWritableDevice(req);
  const result = await devicesService.requestAmbient(currentUserId(req), device, false);
  res.status(202).json(result);
}

/** POST /api/device/remote-action —— 返回/主页/最近任务/通知栏/打开应用（要求 remoteHelp）。 */
export async function remoteAction(req: Request, res: Response) {
  const { action, packageName } = remoteActionSchema.parse(req.body ?? {});
  const device = await resolveWritableDevice(req);
  const result = await devicesService.remoteAction(currentUserId(req), device, action, packageName);
  res.status(202).json(result);
}

/** POST /api/device/sync-calls-sms —— 让设备重新上报通话记录与短信（要求 callSms）。 */
export async function syncCallsSms(req: Request, res: Response) {
  const device = await resolveWritableDevice(req);
  const result = await devicesService.requestCallsSmsSync(currentUserId(req), device);
  res.status(202).json(result);
}

// ============================================================
// 指令队列（家长视角）
// ============================================================

/** GET /api/device/commands —— 指令历史与其执行结果。 */
export async function listCommands(req: Request, res: Response) {
  const { status, limit } = commandListQuerySchema.parse(req.query);
  const device = await resolveDevice(req);
  const commands = await devicesService.listCommands(device, status, limit);
  res.json({ commands });
}

/** POST /api/device/commands/:commandId/cancel —— 撤销未执行的指令。 */
export async function cancelCommand(req: Request, res: Response) {
  const { commandId } = commandIdSchema.parse(req.params);
  const device = await resolveWritableDevice(req);
  const result = await devicesService.cancelCommand(device, commandId);
  if (!result) {
    return res.status(404).json({
      title: 'NOT_FOUND',
      status: 404,
      message: '指令不存在',
      detail: null,
      errors: null,
      request_id: req.requestId,
    });
  }
  res.json(result);
}

// ============================================================
// 功能配置
// ============================================================

/** GET /api/features */
export async function getFeatures(req: Request, res: Response) {
  const device = await resolveDevice(req);
  res.json(await devicesService.getFeatures(device));
}

/** PUT /api/features —— 开关某个功能。 */
export async function updateFeature(req: Request, res: Response) {
  const feature = String(req.body?.feature ?? '');
  const enabled = req.body?.enabled;
  if (!feature) throw new BadRequestError('缺少 feature 参数');
  if (typeof enabled !== 'boolean') throw new BadRequestError('enabled 必须是布尔值');
  const device = await resolveWritableDevice(req);
  res.json(await devicesService.setFeature(currentUserId(req), device.id, feature, enabled));
}

/** PUT /api/features/time-plan */
export async function setTimePlan(req: Request, res: Response) {
  const dailyLimit = Number(req.body?.dailyLimit);
  if (!Number.isFinite(dailyLimit) || dailyLimit < 0) {
    throw new BadRequestError('请输入有效的每日时长（分钟）');
  }
  const device = await resolveWritableDevice(req);
  res.json(await devicesService.setTimePlan(currentUserId(req), device.id, Math.floor(dailyLimit)));
}

/** PUT /api/features/app-limit */
export async function setAppLimit(req: Request, res: Response) {
  const appName = String(req.body?.appName ?? '').trim();
  const packageName = String(req.body?.packageName ?? '').trim();
  const limit = Number(req.body?.limit);
  if (!appName) throw new BadRequestError('请选择要限制的应用');
  // 包名必填：设备端按包名匹配前台窗口，没有包名的规则在设备上等于不存在
  if (!packageName) throw new BadRequestError('缺少应用包名：请从孩子设备上报的应用清单里选择应用');
  if (!Number.isFinite(limit) || limit <= 0) throw new BadRequestError('请输入有效的时长（分钟）');
  const device = await resolveWritableDevice(req);
  res.json(
    await devicesService.setAppLimit(
      currentUserId(req),
      device.id,
      appName,
      packageName,
      Math.floor(limit),
    ),
  );
}

/** DELETE /api/features/app-limit/:appName */
export async function removeAppLimit(req: Request, res: Response) {
  const appName = decodeURIComponent(String(req.params.appName));
  const device = await resolveWritableDevice(req);
  res.json(await devicesService.removeAppLimit(currentUserId(req), device.id, appName));
}

/** POST /api/features/app-audit */
export async function auditApp(req: Request, res: Response) {
  const appName = String(req.body?.appName ?? '').trim();
  const approved = req.body?.approved;
  if (!appName) throw new BadRequestError('缺少应用名称');
  if (typeof approved !== 'boolean') throw new BadRequestError('approved 必须是布尔值');
  const device = await resolveWritableDevice(req);
  res.json(
    await devicesService.auditApp(currentUserId(req), device.id, appName, approved, String(req.body?.reason ?? '')),
  );
}

// ============================================================
// 孩子的申请（§3.1）
// ============================================================

/**
 * GET /api/device/time-requests —— 家长看当前设备上的申请。
 *
 * 默认只回待审批：家长点进这个页面就是为了处理它们，
 * 一屏历史混在里面反而要多一步过滤。传 status=all 或具体状态才看历史。
 */
export async function listTimeRequests(req: Request, res: Response) {
  const { status } = timeRequestQuerySchema.parse(req.query ?? {});
  const device = await resolveDevice(req);
  res.json(await devicesService.listTimeRequests(device, status));
}

/** POST /api/device/time-requests/:id/review —— 批准或拒绝一条申请。 */
export async function reviewTimeRequest(req: Request, res: Response) {
  const { id } = timeRequestIdSchema.parse(req.params);
  const input = reviewTimeRequestSchema.parse(req.body);
  const device = await resolveWritableDevice(req);
  res.json(await devicesService.reviewTimeRequest(currentUserId(req), device, id, input));
}

/** POST /api/features/web-block */
export async function blockUrl(req: Request, res: Response) {
  const url = String(req.body?.url ?? '').trim();
  if (!url) throw new BadRequestError('请输入要拦截的网址');
  const device = await resolveWritableDevice(req);
  res.json(await devicesService.blockUrl(currentUserId(req), device.id, url));
}

/** DELETE /api/features/web-block/:url */
export async function unblockUrl(req: Request, res: Response) {
  const url = decodeURIComponent(String(req.params.url));
  const device = await resolveWritableDevice(req);
  res.json(await devicesService.unblockUrl(currentUserId(req), device.id, url));
}

// ============================================================
// 电话与短信（§8）—— 家长只读；管理后台永远只给计数，不给内容
// ============================================================

/** GET /api/calls —— 通话记录（分页，可筛类型/搜索号码姓名）。 */
export async function listCalls(req: Request, res: Response) {
  const query = callLogQuerySchema.parse(req.query);
  const device = await resolveDevice(req);
  res.json(await devicesService.listCalls(device, query));
}

/** GET /api/sms —— 短信（分页，可筛收/发件与号码）。 */
export async function listSms(req: Request, res: Response) {
  const query = smsQuerySchema.parse(req.query);
  const device = await resolveDevice(req);
  res.json(await devicesService.listSms(device, query));
}

// ============================================================
// 兼容前端既有路径
// ============================================================

/**
 * POST /api/user/devices —— mock 版的「添加设备」。
 * 真实语义是「凭设备码绑定」，因此这里直接复用 bindDevice，
 * 不再允许家长凭空创建一台不存在的设备。
 */
export async function addDeviceCompat(req: Request, res: Response) {
  const { name, model, os, deviceCode } = req.body ?? {};
  if (!deviceCode || typeof deviceCode !== 'string' || !deviceCode.trim()) {
    throw new BadRequestError('请输入孩子设备上显示的绑定码');
  }
  if (!name || typeof name !== 'string' || !name.trim()) {
    throw new BadRequestError('请输入设备名称');
  }
  const result = await devicesService.bindDevice(
    currentUserId(req),
    deviceCode.trim().toUpperCase(),
    name.trim(),
  );
  // 保留 model/os 字段的响应形状，避免老前端取不到值
  res.status(201).json({
    ...result,
    device: { ...result.device, model: result.device.model || model || '', os: result.device.os || os || '' },
  });
}

/** GET /api/user/devices —— 兼容路径，等价于 GET /api/devices。 */
export async function listDevicesCompat(req: Request, res: Response) {
  const devices = await devicesService.listDevices(currentUserId(req));
  res.json({ devices });
}

/** DELETE /api/user/devices/:deviceId —— 兼容路径。 */
export async function removeDeviceCompat(req: Request, res: Response) {
  const result = await devicesService.removeDevice(currentUserId(req), String(req.params.deviceId));
  res.json(result);
}

/** 供 select-device 使用：按 id 解析并回传视图。 */
export async function selectDeviceCompat(req: Request, res: Response) {
  const { deviceId } = deviceIdSchema.parse(req.body);
  const device = await devicesService.requireAccess(currentUserId(req), deviceId);
  res.json({ success: true, device: toDeviceView(device) });
}
