package com.balloondog.agent.data;

/**
 * 全局常量：设备端协议里出现的字符串、默认值、SharedPreferences 键。
 *
 * <p>与 {@code server/scripts/device-agent-example.mjs} 和 {@code server/README.md}
 * 的「设备端 Agent 协议」一节严格对应，改协议时两边一起改。
 */
public final class Constants {

    private Constants() {
    }

    // ---------------- 协议路径（相对 baseUrl，baseUrl 形如 http://host:4000/api） ----------------

    public static final String PATH_REGISTER = "/agent/register";
    public static final String PATH_HEARTBEAT = "/agent/heartbeat";
    public static final String PATH_CONFIG = "/agent/config";
    public static final String PATH_COMMANDS_NEXT = "/agent/commands/next";
    public static final String PATH_LOCATIONS = "/agent/locations";
    public static final String PATH_MEDIA = "/agent/media";
    public static final String PATH_QUIZ_QUESTION = "/agent/quiz/question";
    public static final String PATH_QUIZ_ANSWER = "/agent/quiz/answer";
    /** 截屏包上传 */
    public static final String PATH_SCREEN_BATCHES = "/agent/screen-batches";
    /** 屏幕内容答题 */
    public static final String PATH_SCREEN_QUIZ_NEXT = "/agent/screen-quiz/next";
    public static final String PATH_SCREEN_QUIZ_ANSWER = "/agent/screen-quiz/answer";

    /** 指令结果回报：/agent/commands/{id}/result */
    public static String pathCommandResult(String commandId) {
        return "/agent/commands/" + commandId + "/result";
    }

    // ---------------- 默认服务端地址 ----------------

    /**
     * 默认后端地址。
     *
     * <p>10.0.2.2 是 Android 模拟器里访问宿主机 localhost 的固定别名 ——
     * 后端跑在开发机的 4000 端口时，模拟器开箱即用。
     * 真机请在「设置」里改成开发机的局域网地址，例如 http://192.168.1.10:4000/api。
     */
    public static final String DEFAULT_BASE_URL = "http://10.0.2.2:4000/api";

    // ---------------- 指令类型（与 devices.constants.ts 的 COMMAND_TYPES 对齐） ----------------

    public static final String CMD_LOCK = "lock";
    public static final String CMD_UNLOCK = "unlock";
    public static final String CMD_TEMP_UNLOCK = "temp_unlock";
    public static final String CMD_CANCEL_TEMP_UNLOCK = "cancel_temp_unlock";
    public static final String CMD_REMOTE_PHOTO = "remote_photo";
    public static final String CMD_SCREENSHOT = "screenshot";
    public static final String CMD_START_RECORDING = "start_recording";
    public static final String CMD_STOP_RECORDING = "stop_recording";
    public static final String CMD_START_AUDIO = "start_audio";
    public static final String CMD_STOP_AUDIO = "stop_audio";
    public static final String CMD_FETCH_LOCATION = "fetch_location";
    public static final String CMD_SYNC_CONFIG = "sync_config";
    /** 让设备重新上报已安装应用清单（家长点「刷新应用列表」）。 */
    public static final String CMD_SYNC_APPS = "sync_apps";

    // ---------------- 节奏参数 ----------------

    /** 心跳间隔（毫秒）。服务端 3 分钟没收到心跳就把设备视为离线，15 秒足够稳。 */
    public static final long HEARTBEAT_INTERVAL_MS = 15_000L;

    /** 管控策略（/agent/config）的刷新间隔。 */
    public static final long CONFIG_REFRESH_INTERVAL_MS = 60_000L;

    /** 位置自动上报间隔。 */
    public static final long LOCATION_REPORT_INTERVAL_MS = 5 * 60_000L;

    /** 长轮询挂起秒数，必须小于 OkHttp 的长轮询读超时（45s）。 */
    public static final int LONG_POLL_WAIT_SECONDS = 25;

    /** 断线重连前的退避下限。 */
    public static final long RETRY_BACKOFF_MS = 5_000L;

    /** 网络请求超时。 */
    public static final long CONNECT_TIMEOUT_MS = 15_000L;
    public static final long READ_TIMEOUT_MS = 30_000L;
    /** 长轮询专用：必须大于 LONG_POLL_WAIT_SECONDS。 */
    public static final long LONG_POLL_READ_TIMEOUT_MS = 45_000L;
    /** 上传专用：照片/录像可能较大。 */
    public static final long UPLOAD_WRITE_TIMEOUT_MS = 120_000L;

    public static final String AGENT_VERSION = "1.0.0-android";

    // ---------------- 通知 ----------------

    public static final String CHANNEL_AGENT = "balloon_dog_agent";
    public static final String CHANNEL_EVENTS = "balloon_dog_events";
    public static final int NOTIFICATION_ID_AGENT = 1001;
    public static final int NOTIFICATION_ID_SCREEN = 1002;
    /** 时间表边界提醒（响铃/震动），与「家长操作」共用渠道 */
    public static final int NOTIFICATION_ID_SCHEDULE = 1003;

    // ---------------- Intent / 广播 ----------------

    public static final String ACTION_START_AGENT = "com.balloondog.agent.action.START_AGENT";
    public static final String ACTION_STOP_AGENT = "com.balloondog.agent.action.STOP_AGENT";
    public static final String ACTION_REFRESH_NOW = "com.balloondog.agent.action.REFRESH_NOW";
    /** 保活看门狗：由 AlarmManager / JobScheduler 定时触发，检查并拉起守护服务 */
    public static final String ACTION_WATCHDOG = "com.balloondog.agent.action.WATCHDOG";
    /** 屏幕被点亮 / 解锁：立即复核锁定状态，不等下一个周期 */
    public static final String ACTION_SCREEN_ON = "com.balloondog.agent.action.SCREEN_ON";
    /** 时间表边界到达（例如 22:00 该锁屏了），由 AlarmManager 精确触发 */
    public static final String ACTION_SCHEDULE_BOUNDARY = "com.balloondog.agent.action.SCHEDULE_BOUNDARY";
    /** 倒计时悬浮窗上的操作 */
    public static final String ACTION_COUNTDOWN_QUIZ = "com.balloondog.agent.action.COUNTDOWN_QUIZ";


    // ---------------- SharedPreferences ----------------

    public static final String PREFS = "balloon_dog_agent_prefs";

    // ---- 设备端接口路径 ----
    public static final String PATH_AGENT_APPS = "/agent/apps";
    public static final String PATH_AGENT_EVENTS = "/agent/events";

    /** 应用清单全量上报间隔：应用装卸不频繁，12 小时足够，也省电。 */
    public static final long APP_REPORT_INTERVAL_MS = 12 * 60 * 60 * 1000L;

    /** 设备事件批量上报间隔：攒 60 秒发一次，避免为每条解锁/亮屏都发一个请求。 */
    public static final long EVENT_FLUSH_INTERVAL_MS = 60_000L;

    // ---- 设备事件类型（与 server 端约定一致，改一处必须改两处） ----
    public static final String EVENT_UNLOCK = "unlock";
    public static final String EVENT_LOCK = "lock";
    public static final String EVENT_SCREEN_ON = "screen_on";
    public static final String EVENT_SCREEN_OFF = "screen_off";
    public static final String EVENT_APP_INSTALLED = "app_installed";
    public static final String EVENT_APP_REMOVED = "app_removed";
    public static final String EVENT_MODE_ENTER = "mode_enter";
    public static final String EVENT_EYE_REST = "eye_rest";
    public static final String EVENT_PLUGIN_BLOCKED = "plugin_blocked";
    public static final String EVENT_APP_BLOCKED = "app_blocked";
    /**
     * 设备加密存储（device-protected）里的偏好文件名。
     *
     * <p>只放「用户解锁前就必须读到」的少数几项：应急解锁密码哈希、
     * resetPasswordWithToken 令牌、当前随机锁屏密码。
     * 它们关系到 {@code password} 最高强度档的重启安全阀能否生效 ——
     * 详见 {@link AgentStore} 与 android/README.md §2.4。
     */
    public static final String PREFS_DEVICE_PROTECTED = "balloon_dog_agent_device_protected";

    public static final String KEY_BASE_URL = "base_url";
    public static final String KEY_DEVICE_CODE = "device_code";
    public static final String KEY_DEVICE_SECRET = "device_secret";
    public static final String KEY_DEVICE_TOKEN = "device_token";
    public static final String KEY_DEVICE_ID = "device_id";
    public static final String KEY_DEVICE_NAME = "device_name";
    public static final String KEY_BOUND = "bound";
    public static final String KEY_LOCKED = "locked";
    public static final String KEY_TEMP_UNLOCK_UNTIL = "temp_unlock_until";
    public static final String KEY_AGENT_ENABLED = "agent_enabled";
    /** 主循环最后一次活跃的时间戳，用来判断服务是不是真的还活着 */
    public static final String KEY_LAST_ALIVE_AT = "last_alive_at";
    public static final String KEY_QUIZ_ENABLED = "quiz_enabled";
    public static final String KEY_AUTO_LOCATION = "auto_location";
    public static final String KEY_LAST_CONFIG_JSON = "last_config_json";
    public static final String KEY_USAGE_DAY = "usage_day";
    public static final String KEY_USAGE_SECONDS = "usage_seconds";
    public static final String KEY_DAILY_LIMIT_MINUTES = "daily_limit_minutes";
    public static final String KEY_TIME_PLAN_ENABLED = "time_plan_enabled";
    public static final String KEY_BLOCKED_URLS = "blocked_urls";
    public static final String KEY_APP_LIMITS = "app_limits";

    // ---- 锁屏强度与时间表 ----
    /** kiosk | password */
    public static final String KEY_LOCK_STRENGTH = "lock_strength";
    /** 锁屏前透明悬浮窗倒计时秒数，0 = 不预告 */
    public static final String KEY_COUNTDOWN_SECONDS = "countdown_seconds";
    public static final String KEY_SCHEDULE_ENABLED = "schedule_enabled";
    /** 时间表规则（JSON 数组），断网时也要能照常锁屏，所以必须落盘 */
    public static final String KEY_SCHEDULE_JSON = "schedule_json";
    /** 家长下发「解锁」后的放行截止时间（到下一个时间表边界为止） */
    public static final String KEY_MANUAL_UNLOCK_UNTIL = "manual_unlock_until";
    /** 最高强度档：本机应急解锁密码的哈希（只存本机，绝不上传） */
    public static final String KEY_EMERGENCY_PASSWORD_HASH = "emergency_password_hash";
    /** 最高强度档：用于 resetPasswordWithToken 的令牌 */
    public static final String KEY_RESET_TOKEN = "reset_token";
    /** 最高强度档：当前生效的随机锁屏密码（供本机展示给家长） */
    public static final String KEY_CURRENT_RANDOM_PASSWORD = "current_random_password";
    /** 是否已启用「最强防护」（禁卸载 / 禁强行停止 / 禁恢复出厂 / 禁安全模式） */
    public static final String KEY_HARDENING_ENABLED = "hardening_enabled";

    // ---- 模式切换 / 护眼 / 应用插件管控 ----
    /**
     * 模式配置（JSON），断网时必须照常生效 —— 否则孩子拔网线就绕过学习模式了。
     * 结构与服务端 `/agent/config` 的 `mode` 块一致。
     */
    public static final String KEY_MODE_JSON = "mode_json";
    /** 护眼设置（JSON）。 */
    public static final String KEY_EYE_CARE_JSON = "eye_care_json";
    /** 应用插件管控规则（JSON 数组），只含被家长改动过的项。 */
    public static final String KEY_PLUGIN_RULES_JSON = "plugin_rules_json";
    /** 连续用眼累计毫秒数（护眼计时）。 */
    public static final String KEY_EYE_CONTINUOUS_MS = "eye_continuous_ms";
    /** 护眼强制休息的截止时刻（墙上时间毫秒）；0 = 未在休息。 */
    public static final String KEY_EYE_REST_UNTIL = "eye_rest_until";
    /** 上一次上报应用清单的时间戳，避免频繁全量上报。 */
    public static final String KEY_APPS_REPORTED_AT = "apps_reported_at";

    // ---- 屏幕行为洞察 ----
    /** 家长是否开启了周期截屏（默认关，最高敏感度权限） */
    public static final String KEY_CAPTURE_ENABLED = "capture_enabled";
    public static final String KEY_CAPTURE_INTERVAL_SECONDS = "capture_interval_seconds";
    public static final String KEY_FRAMES_PER_BATCH = "frames_per_batch";
    /** 锁定页是否优先出「基于屏幕内容」的题 */
    public static final String KEY_QUIZ_FROM_SCREEN = "quiz_from_screen";
    /** 服务端下发的今日局数额度（AI 分析算出来的权威计数） */
    public static final String KEY_GAME_ROUNDS_ENABLED = "game_rounds_enabled";
    public static final String KEY_GAME_ROUNDS_LIMIT = "game_rounds_limit";
    public static final String KEY_GAME_ROUNDS_USED = "game_rounds_used";
    public static final String KEY_VIDEO_EPISODES_ENABLED = "video_episodes_enabled";
    public static final String KEY_VIDEO_EPISODES_LIMIT = "video_episodes_limit";
    public static final String KEY_VIDEO_EPISODES_USED = "video_episodes_used";
    /** 是否要求「重启后自动清除随机密码」（安全阀，默认开） */
    public static final String KEY_REBOOT_CLEARS_PASSWORD = "reboot_clears_password";
}
