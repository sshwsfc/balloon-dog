/**
 * 功能开关的「单一事实来源」。
 *
 * 数据库里 DeviceFeature 是 (deviceId, key) 的行，key 的合法取值只在这里定义，
 * 任何接口传入未列出的 key 都会被拒绝 —— mock 版是直接拿用户传的字符串去索引对象，
 * 拼错就静默无效，这里改成显式白名单。
 */

export interface FeatureDef {
  key: string;
  label: string;
  /** basic=基础功能，advanced=高级功能（前端分组展示） */
  group: 'basic' | 'advanced';
  /** 新绑定设备的默认开关状态 */
  defaultEnabled: boolean;
  description: string;
}

export const FEATURE_DEFS: FeatureDef[] = [
  // ---- 基础功能 ----
  { key: 'lockScreen', label: '一键锁屏', group: 'basic', defaultEnabled: true, description: '立即锁定设备屏幕' },
  { key: 'tempUnlock', label: '临时使用', group: 'basic', defaultEnabled: true, description: '授权临时使用权限' },
  { key: 'timePlan', label: '时间规划', group: 'basic', defaultEnabled: true, description: '设置使用时间限制' },
  { key: 'appLimit', label: '应用限制', group: 'basic', defaultEnabled: false, description: '限制应用使用时长' },
  { key: 'appAudit', label: '应用审核', group: 'basic', defaultEnabled: false, description: '审核新安装应用' },
  { key: 'webBlock', label: '网址拦截', group: 'basic', defaultEnabled: false, description: '拦截不良网站' },
  // ---- 高级功能 ----
  { key: 'quizUnlock', label: '答题解锁', group: 'advanced', defaultEnabled: false, description: '通过答题获得使用时长' },
  { key: 'screenMonitor', label: '同屏监控', group: 'advanced', defaultEnabled: false, description: '实时查看屏幕内容' },
  { key: 'remoteHelp', label: '远程协助', group: 'advanced', defaultEnabled: false, description: '远程操作帮助' },
  { key: 'callSms', label: '电话短信', group: 'advanced', defaultEnabled: false, description: '查看通话和短信' },
  { key: 'remotePhoto', label: '远程拍照', group: 'advanced', defaultEnabled: false, description: '远程拍摄照片' },
  { key: 'remoteRecord', label: '远程录音', group: 'advanced', defaultEnabled: false, description: '远程录制音频' },
  { key: 'videoRecord', label: '连续录像', group: 'advanced', defaultEnabled: false, description: '持续视频录制' },
  { key: 'audioRecord', label: '环境监听', group: 'advanced', defaultEnabled: false, description: '持续采集环境声音' },
];

export const FEATURE_KEYS = FEATURE_DEFS.map((f) => f.key);

const FEATURE_KEY_SET = new Set(FEATURE_KEYS);

export function isFeatureKey(key: string): boolean {
  return FEATURE_KEY_SET.has(key);
}

export function defaultEnabledOf(key: string): boolean {
  return FEATURE_DEFS.find((f) => f.key === key)?.defaultEnabled ?? false;
}

/** 指令类型白名单。 */
export const COMMAND_TYPES = [
  'lock',
  'unlock',
  'temp_unlock',
  'cancel_temp_unlock',
  'remote_photo',
  'screenshot',
  'start_recording',
  'stop_recording',
  'start_audio',
  'stop_audio',
  'fetch_location',
  'sync_config',
] as const;

export type CommandType = (typeof COMMAND_TYPES)[number];

const COMMAND_TYPE_SET = new Set<string>(COMMAND_TYPES);
export function isCommandType(t: string): t is CommandType {
  return COMMAND_TYPE_SET.has(t);
}

export const COMMAND_STATUSES = [
  'pending', // 已下发，等待设备领取
  'dispatched', // 设备已领取，执行中
  'succeeded',
  'failed',
  'expired', // 超时未被领取
  'cancelled', // 被家长撤销
] as const;

export type CommandStatus = (typeof COMMAND_STATUSES)[number];

/** 指令的中文名，用于给用户提示「远程拍照指令已下发」。 */
export const COMMAND_LABELS: Record<string, string> = {
  lock: '锁屏',
  unlock: '解锁',
  temp_unlock: '临时解锁',
  cancel_temp_unlock: '取消临时解锁',
  remote_photo: '远程拍照',
  screenshot: '屏幕截图',
  start_recording: '开始录像',
  stop_recording: '停止录像',
  start_audio: '开始录音',
  stop_audio: '停止录音',
  fetch_location: '获取位置',
  sync_config: '同步配置',
};

export function commandLabel(type: string): string {
  return COMMAND_LABELS[type] ?? type;
}

/** 允许「离线设备也先记下指令、等上线再执行」的指令类型。 */
export const QUEUEABLE_WHEN_OFFLINE: ReadonlySet<string> = new Set([
  'lock',
  'unlock',
  'temp_unlock',
  'cancel_temp_unlock',
  'sync_config',
  'fetch_location',
]);
