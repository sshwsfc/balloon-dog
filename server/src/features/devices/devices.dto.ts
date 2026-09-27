import { z } from 'zod';
import { COMMAND_STATUSES } from './devices.constants';

const deviceIdParam = z.string().trim().min(1, '缺少设备 ID');

/** 家长输入孩子设备上显示的绑定码，认领设备。 */
export const bindDeviceSchema = z.object({
  deviceCode: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9]{6,12}$/, '绑定码为 6-12 位字母或数字'),
  name: z.string().trim().min(1, '请输入设备名称').max(30).optional(),
});

export const updateDeviceSchema = z.object({
  name: z.string().trim().min(1, '设备名称不能为空').max(30).optional(),
  avatar: z.string().trim().max(500).optional(),
});

export const selectDeviceSchema = z.object({
  deviceId: deviceIdParam,
});

export const deviceIdSchema = z.object({ deviceId: deviceIdParam });

/** 锁屏 / 解锁 */
export const lockSchema = z.object({
  locked: z.boolean({ required_error: '缺少 locked 参数' }),
});

/** 临时解锁时长（分钟） */
export const tempUnlockSchema = z.object({
  minutes: z.coerce
    .number()
    .int('时长必须是整数')
    .min(1, '时长至少 1 分钟')
    .max(24 * 60, '时长最多 24 小时'),
});

/** 录像/录音的停止请求：mock 版要求传 recordingId 却从不使用，这里真正做归属校验。 */
export const stopCaptureSchema = z.object({
  recordingId: z.string().trim().min(1, '缺少录制 ID'),
});

export const commandListQuerySchema = z.object({
  status: z.enum(COMMAND_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

/** 手动把某条 pending 指令作废（家长反悔） */
export const commandIdSchema = z.object({ commandId: z.string().trim().min(1) });

// ============================================================
// 设备端 Agent 接口
// ============================================================

/**
 * 设备端自助注册。
 * deviceCode / deviceSecret 由设备本地生成并持久化：
 *  - 首次注册：服务端建一条「待认领」设备记录；
 *  - 之后重启再用同一对值调用，服务端校验 secret 后重新签发 device token（幂等）。
 */
export const agentRegisterSchema = z.object({
  deviceCode: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9]{6,12}$/, '设备码为 6-12 位字母或数字'),
  deviceSecret: z.string().trim().min(16, '设备密钥至少 16 位').max(200),
  name: z.string().trim().max(30).optional(),
  model: z.string().trim().max(60).default('Unknown'),
  os: z.string().trim().max(30).default('Unknown'),
  osVersion: z.string().trim().max(30).default(''),
  agentVersion: z.string().trim().max(30).default(''),
});

/** 设备心跳：顺带上报电量、网络、前台状态。 */
export const agentHeartbeatSchema = z.object({
  battery: z.coerce.number().int().min(0).max(100).optional(),
  network: z.enum(['wifi', 'cellular', 'ethernet', 'unknown']).optional(),
  agentVersion: z.string().trim().max(30).optional(),
});

/** 设备端回报指令执行结果。 */
export const agentCommandResultSchema = z.object({
  status: z.enum(['succeeded', 'failed'], { required_error: '缺少执行结果' }),
  result: z.unknown().optional(),
  error: z.string().trim().max(500).optional(),
});

/** 设备端上报位置。 */
export const agentLocationSchema = z.object({
  latitude: z.coerce.number().min(-90).max(90),
  longitude: z.coerce.number().min(-180).max(180),
  accuracy: z.coerce.number().min(0).max(100_000).optional(),
  address: z.string().trim().max(200).optional(),
  recordedAt: z.coerce.date().optional(),
});

/** 设备端答题。 */
export const agentQuizAnswerSchema = z.object({
  questionId: z.string().trim().min(1),
  answer: z.coerce.number().int().min(0).max(20),
});

/** 设备端拉取指令：wait 表示长轮询等待秒数（0 = 立即返回）。 */
export const agentPollQuerySchema = z.object({
  wait: z.coerce.number().int().min(0).max(50).default(0),
});
