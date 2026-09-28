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
    /** 时间表边界到达（例如 22:00 该锁屏了），由 AlarmManager 精确触发 */
    public static final String ACTION_SCHEDULE_BOUNDARY = "com.balloondog.agent.action.SCHEDULE_BOUNDARY";
    /** 倒计时悬浮窗上的操作 */
    public static final String ACTION_COUNTDOWN_QUIZ = "com.balloondog.agent.action.COUNTDOWN_QUIZ";


    // ---------------- SharedPreferences ----------------

    public static final String PREFS = "balloon_dog_agent_prefs";

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
    /** 是否要求「重启后自动清除随机密码」（安全阀，默认开） */
    public static final String KEY_REBOOT_CLEARS_PASSWORD = "reboot_clears_password";
}
