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
  { key: 'modeSwitch', label: '模式切换', group: 'basic', defaultEnabled: false, description: '学习模式 / 普通模式，学习模式下只允许白名单应用' },
  { key: 'eyeCare', label: '护眼设置', group: 'basic', defaultEnabled: false, description: '连续用眼提醒、强制休息、夜间护眼' },
  { key: 'appPlugin', label: '功能管控', group: 'basic', defaultEnabled: false, description: '按应用关闭微信 / QQ 等具体功能' },
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
  // 让设备重新上报已安装应用清单（家长点「刷新应用列表」时下发）。
  // 刻意不叫 sync_apps 之类会让人以为是「同步配置」的名字：它只做一件事。
  'sync_apps',
  // 环境监听（分片连续录音）。要求特性 audioRecord —— 不是 remoteRecord：
  // 「远程录音」是一次性取证，「环境监听」是持续采集，两者权限与提示文案都不同。
  'start_ambient',
  'stop_ambient',
  // 远程协助：受限但真实的「远程操作」（返回/主页/最近任务/通知栏/打开应用）。
  'remote_action',
  // 让设备重新上报通话记录与短信（家长点「刷新」时下发）。
  'sync_calls_sms',
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
  sync_apps: '同步应用列表',
  start_ambient: '开始环境监听',
  stop_ambient: '停止环境监听',
  remote_action: '远程协助',
  sync_calls_sms: '同步通话短信',
};

/** 远程协助允许的动作白名单（§7）。open_app 必须带 packageName。 */
export const REMOTE_ACTIONS = ['back', 'home', 'recents', 'notifications', 'open_app'] as const;

export type RemoteAction = (typeof REMOTE_ACTIONS)[number];

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
