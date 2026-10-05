package com.balloondog.agent.data;

import android.content.Context;
import android.content.SharedPreferences;
import android.text.TextUtils;

import androidx.annotation.Nullable;

import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.UUID;

/**
 * 设备身份与本地策略状态的持久化。
 *
 * <p>这里保存的是「设备之所以是它自己」的三样东西：
 * {@code deviceCode}（家长输入的绑定码）、{@code deviceSecret}（续订令牌的凭据）、
 * {@code deviceToken}（访问令牌）。这三样必须落盘，否则重启 / 重装后就变成一台新设备，
 * 家长那边会看到一台永远离线的幽灵设备。
 *
 * <p>对应服务端 {@code agentRegisterSchema}：deviceCode 6-12 位 [A-Z0-9]，
 * deviceSecret 至少 16 位。这里用 8 位设备码 + 48 位十六进制密钥。
 */
public class AgentStore {

    private final SharedPreferences prefs;
    /**
     * <b>设备加密存储</b>（device-protected）里的偏好。
     *
     * <p>为什么需要第二份：`password` 最高强度档会随机改写系统锁屏密码，
     * 而「重启后清除随机密码」这条安全阀必须在**用户解锁之前**执行 ——
     * 否则用户卡在系统锁屏上、应用又因为读不到凭据加密存储而起不来，
     * 形成一个死循环（实测确认过，见 android/README.md §2.4）。
     *
     * <p>所以应急密码哈希、resetPasswordWithToken 令牌、当前随机密码这三样
     * 放进设备加密存储：开机后、用户解锁前就能读到，安全阀才真的能生效。
     */
    private final SharedPreferences devicePrefs;
    private final Context appContext;

    public AgentStore(Context context) {
        this.appContext = context.getApplicationContext();

        // 1) 先建设备加密存储：它在用户解锁前也可用，是开机安全阀的唯一依赖。
        Context deviceContext = this.appContext;
        try {
            deviceContext = this.appContext.createDeviceProtectedStorageContext();
        } catch (Exception e) {
            // 极老或异常 ROM 上拿不到设备加密存储时退回原存储：
            // 功能退化（安全阀在解锁前读不到），但不能因此让整个 Store 构造失败。
            deviceContext = this.appContext;
        }
        this.devicePrefs = deviceContext
                .getSharedPreferences(Constants.PREFS_DEVICE_PROTECTED, Context.MODE_PRIVATE);

        // 2) 再建凭据加密存储。它在 LOCKED_BOOT_COMPLETED（用户解锁前）会直接抛异常，
        //    而开机安全阀恰恰跑在那时 —— 不兜住的话，用来打破死循环的代码自己先崩了。
        //    退回设备加密存储：此刻读到的都是默认值，这正是我们要的语义
        //    （解锁前那些设备令牌确实还不存在），关键是绝不能抛。
        SharedPreferences main;
        try {
            main = this.appContext.getSharedPreferences(Constants.PREFS, Context.MODE_PRIVATE);
        } catch (Exception e) {
            main = this.devicePrefs;
        }
        this.prefs = main;
    }

    /**
     * 取回应用级 Context。
     *
     * <p>给那些长期存活、需要在任意时刻启动组件或申请系统服务的对象使用
     * （例如全屏锁定悬浮窗要在自己的自检里把守护服务拉回来）。
     * 刻意返回 ApplicationContext：它不会泄漏 Activity。
     */
    public Context getContext() {
        return appContext;
    }

    // ---------------- 服务端地址 ----------------

    public String getBaseUrl() {
        String url = prefs.getString(Constants.KEY_BASE_URL, Constants.DEFAULT_BASE_URL);
        return TextUtils.isEmpty(url) ? Constants.DEFAULT_BASE_URL : url;
    }

    public void setBaseUrl(String baseUrl) {
        prefs.edit().putString(Constants.KEY_BASE_URL, normalizeBaseUrl(baseUrl)).apply();
    }

    /** 宽容地归一化用户输入的地址：补协议、去尾部斜杠、补 /api 后缀。 */
    public static String normalizeBaseUrl(String raw) {
        if (raw == null) return Constants.DEFAULT_BASE_URL;
        String url = raw.trim();
        if (url.isEmpty()) return Constants.DEFAULT_BASE_URL;
        if (!url.startsWith("http://") && !url.startsWith("https://")) {
            url = "http://" + url;
        }
        while (url.endsWith("/")) {
            url = url.substring(0, url.length() - 1);
        }
        if (!url.endsWith("/api")) {
            url = url + "/api";
        }
        return url;
    }

    // ---------------- 设备身份 ----------------

    public String getDeviceCode() {
        return prefs.getString(Constants.KEY_DEVICE_CODE, null);
    }

    public String getDeviceSecret() {
        return prefs.getString(Constants.KEY_DEVICE_SECRET, null);
    }

    public String getDeviceToken() {
        return prefs.getString(Constants.KEY_DEVICE_TOKEN, null);
    }

    public void setDeviceToken(String token) {
        prefs.edit().putString(Constants.KEY_DEVICE_TOKEN, token).apply();
    }

    public String getDeviceId() {
        return prefs.getString(Constants.KEY_DEVICE_ID, null);
    }

    public void setDeviceId(String deviceId) {
        prefs.edit().putString(Constants.KEY_DEVICE_ID, deviceId).apply();
    }

    public String getDeviceName() {
        return prefs.getString(Constants.KEY_DEVICE_NAME, null);
    }

    public void setDeviceName(String name) {
        prefs.edit().putString(Constants.KEY_DEVICE_NAME, name).apply();
    }

    public boolean isRegistered() {
        return !TextUtils.isEmpty(getDeviceCode()) && !TextUtils.isEmpty(getDeviceSecret());
    }

    public boolean isBound() {
        return prefs.getBoolean(Constants.KEY_BOUND, false);
    }

    public void setBound(boolean bound) {
        prefs.edit().putBoolean(Constants.KEY_BOUND, bound).apply();
    }

    /**
     * 首次启动（或用户主动重置后）生成一套设备身份。
     *
     * <p>设备码刻意避开容易看错的 0/O/1/I，家长要在家长端手动输入它。
     * 密钥用 UUID 拼两次得到 64 位十六进制串（远超服务端要求的 16 位下限），
     * 它只在本机保存，用来在重装后向服务端证明「我还是原来那台设备」。
     */
    public void ensureIdentity() {
        if (isRegistered()) return;
        prefs.edit()
                .putString(Constants.KEY_DEVICE_CODE, generateDeviceCode())
                .putString(Constants.KEY_DEVICE_SECRET, generateDeviceSecret())
                .apply();
    }

    private static final char[] CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789".toCharArray();

    public static String generateDeviceCode() {
        java.security.SecureRandom random = new java.security.SecureRandom();
        StringBuilder sb = new StringBuilder(8);
        for (int i = 0; i < 8; i++) {
            sb.append(CODE_ALPHABET[random.nextInt(CODE_ALPHABET.length)]);
        }
        return sb.toString();
    }

    public static String generateDeviceSecret() {
        return (UUID.randomUUID().toString() + UUID.randomUUID().toString()).replace("-", "");
    }

    // ---------------- 管控状态（服务端下发的期望状态 + 本地实际执行结果） ----------------

    public boolean isLocked() {
        return prefs.getBoolean(Constants.KEY_LOCKED, false);
    }

    public long getTempUnlockUntil() {
        return prefs.getLong(Constants.KEY_TEMP_UNLOCK_UNTIL, 0L);
    }

    /** 当前是否处于「已锁定且没有临时解锁豁免」的状态。 */
    public boolean isEffectivelyLocked() {
        if (!isLocked()) return false;
        long until = getTempUnlockUntil();
        return until <= 0 || until <= System.currentTimeMillis();
    }

    public void setLockState(boolean locked, long tempUnlockUntilMillis) {
        prefs.edit()
                .putBoolean(Constants.KEY_LOCKED, locked)
                .putLong(Constants.KEY_TEMP_UNLOCK_UNTIL, tempUnlockUntilMillis)
                .apply();
    }

    /** 答题奖励 / 临时解锁：在原有到期时间上叠加，与服务端 quiz.service.ts 的语义一致。 */
    public void extendTempUnlock(long extraMillis, boolean unlockNow) {
        long base = Math.max(System.currentTimeMillis(), getTempUnlockUntil());
        long until = base + extraMillis;
        prefs.edit()
                .putLong(Constants.KEY_TEMP_UNLOCK_UNTIL, until)
                .putBoolean(Constants.KEY_LOCKED, unlockNow ? false : isLocked())
                .apply();
    }

    // ---------------- 运行开关 ----------------

    public boolean isAgentEnabled() {
        return prefs.getBoolean(Constants.KEY_AGENT_ENABLED, false);
    }

    public void setAgentEnabled(boolean enabled) {
        prefs.edit().putBoolean(Constants.KEY_AGENT_ENABLED, enabled).apply();
    }

    /** 主循环每轮调用一次，作为「服务真的活着」的证据。 */
    public void markServiceAlive() {
        prefs.edit().putLong(Constants.KEY_LAST_ALIVE_AT, System.currentTimeMillis()).apply();
    }

    public long getLastAliveAt() {
        return prefs.getLong(Constants.KEY_LAST_ALIVE_AT, 0L);
    }

    /**
     * 「服务是否真的在跑」由 {@code AgentService.isRunning()} 判断，不在这里猜。
     *
     * <p>这里只保留 {@link #getLastAliveAt()} 作为<b>证据</b>（主循环每轮刷新一次，
     * 用于「关于」页展示与排查），刻意不提供「按时间窗口推断存活」的方法：
     * 窗口取小了会把正在长轮询的服务误判为已死，取大了又会在服务刚被杀掉的那几十秒里
     * 继续显示「运行中」—— 两种错法都会把用户引向错误的结论，不如直接问进程里的静态标志。
     */

    public boolean isQuizEnabled() {
        return prefs.getBoolean(Constants.KEY_QUIZ_ENABLED, false);
    }

    public void setQuizEnabled(boolean enabled) {
        prefs.edit().putBoolean(Constants.KEY_QUIZ_ENABLED, enabled).apply();
    }

    public boolean isAutoLocationEnabled() {
        return prefs.getBoolean(Constants.KEY_AUTO_LOCATION, true);
    }

    public void setAutoLocationEnabled(boolean enabled) {
        prefs.edit().putBoolean(Constants.KEY_AUTO_LOCATION, enabled).apply();
    }

    // ---------------- 管控策略快照 ----------------

    public void setLastConfigJson(String json) {
        prefs.edit().putString(Constants.KEY_LAST_CONFIG_JSON, json).apply();
    }

    /**
     * 上一份策略配置的原始 JSON。
     *
     * <p><b>会顺手丢掉「不属于当前设备」的陈旧缓存</b>：配置 JSON 里带着它属于哪个 deviceId，
     * 一旦和本地记录的 deviceId 不一致，就说明这份缓存是上一台设备留下的 ——
     * 必须当作「没有配置」处理，而不是继续拿它去判定锁定。
     *
     * <p>为什么这条不变量要写在这里：实测遇到过设备解绑后重新注册，
     * 服务端明明已经 `locked=false`，本地却还在用旧缓存里的 `"locked":true`
     * 稳定地把设备锁在锁定页上 —— 家长端已经看不到那台设备，等于谁也解不开。
     * 放在读取处做自愈，连已经损坏的安装也能自己恢复，不必等下一次注册。
     */
    @Nullable
    public String getLastConfigJson() {
        String json = prefs.getString(Constants.KEY_LAST_CONFIG_JSON, null);
        if (json == null) return null;
        String owner = extractJsonString(json, "deviceId");
        String mine = getDeviceId();
        if (owner != null && mine != null && !owner.equals(mine)) {
            EventLog.warn("丢弃陈旧的策略缓存：它属于设备 " + owner + "，而本机是 " + mine);
            prefs.edit().remove(Constants.KEY_LAST_CONFIG_JSON).apply();
            return null;
        }
        return json;
    }

    /**
     * 自愈：丢掉「不属于当前设备」的锁定策略。
     *
     * <p>本地锁定判定读的是 {@code KEY_LOCKED} 这个独立标志，而不是配置 JSON，
     * 所以只丢弃 JSON 是不够的 —— 那份标志也得一起清掉，否则设备会一直停在锁定页上。
     *
     * <p>触发条件是「缓存配置里的 deviceId 与本机 deviceId 不一致」：
     * 这只有在设备身份变过（解绑后重新注册）却还留着旧策略时才成立，
     * 是一个不含糊的判据，不会误伤正常的锁定状态。
     *
     * <p>在服务启动时和锁定页自检时都会调用，所以已经卡住的设备也能自己恢复，
     * 不需要用户清数据或重装。
     *
     * @return true 表示确实清理了陈旧策略
     */
    public boolean healStalePolicyCache() {
        String json = prefs.getString(Constants.KEY_LAST_CONFIG_JSON, null);
        if (json == null) return false;
        String owner = extractJsonString(json, "deviceId");
        String mine = getDeviceId();
        if (owner == null || mine == null || owner.equals(mine)) return false;

        EventLog.warn("检测到陈旧的锁定策略（属于设备 " + owner + "，本机是 " + mine
                + "），正在清除，避免设备被不存在的设备锁死");
        prefs.edit()
                .remove(Constants.KEY_LAST_CONFIG_JSON)
                .remove(Constants.KEY_LOCKED)
                .remove(Constants.KEY_TEMP_UNLOCK_UNTIL)
                .remove(Constants.KEY_MANUAL_UNLOCK_UNTIL)
                .remove(Constants.KEY_SCHEDULE_JSON)
                .remove(Constants.KEY_SCHEDULE_ENABLED)
                .remove(Constants.KEY_MODE_JSON)
                .remove(Constants.KEY_EYE_CARE_JSON)
                .remove(Constants.KEY_PLUGIN_RULES_JSON)
                .remove(Constants.KEY_EYE_REST_UNTIL)
                .remove(Constants.KEY_SAFE_ZONES)
                .remove(Constants.KEY_LAST_SAFE_ZONE_ID)
                .remove(Constants.KEY_APP_LIMIT_RULES)
                .remove(Constants.KEY_APP_USAGE_JSON)
                .remove(Constants.KEY_INSTALL_APPROVAL_UNTIL)
                .remove(Constants.KEY_CALLS_SMS_REPORTED_AT)
                .apply();
        return true;
    }

    /** 从 JSON 文本里取一个顶层字符串字段（不引 JSON 库，够用且不会因畸形 JSON 抛异常）。 */
    @Nullable
    private static String extractJsonString(String json, String key) {
        java.util.regex.Matcher m = java.util.regex.Pattern
                .compile("\"" + java.util.regex.Pattern.quote(key) + "\"\\s*:\\s*\"([^\"]*)\"")
                .matcher(json);
        return m.find() ? m.group(1) : null;
    }

    public void setTimePlan(boolean enabled, int dailyLimitMinutes) {
        prefs.edit()
                .putBoolean(Constants.KEY_TIME_PLAN_ENABLED, enabled)
                .putInt(Constants.KEY_DAILY_LIMIT_MINUTES, dailyLimitMinutes)
                .apply();
    }

    public boolean isTimePlanEnabled() {
        return prefs.getBoolean(Constants.KEY_TIME_PLAN_ENABLED, false);
    }

    public int getDailyLimitMinutes() {
        return prefs.getInt(Constants.KEY_DAILY_LIMIT_MINUTES, 0);
    }

    public void setBlockedUrls(String joined) {
        prefs.edit().putString(Constants.KEY_BLOCKED_URLS, joined).apply();
    }

    /** 最近一次下发的网址黑名单（逗号分隔）。 */
    public String getBlockedUrls() {
        return prefs.getString(Constants.KEY_BLOCKED_URLS, "");
    }

    // ---------------- 锁屏强度与时间表 ----------------

    /** 家长期望的锁屏强度：kiosk（默认）| password（最高强度）。 */
    public String getLockStrength() {
        return prefs.getString(Constants.KEY_LOCK_STRENGTH, "kiosk");
    }

    public void setLockStrength(String strength) {
        prefs.edit().putString(Constants.KEY_LOCK_STRENGTH, strength).apply();
    }

    /** 锁屏前透明悬浮窗倒计时秒数；0 表示不预告。 */
    public int getCountdownSeconds() {
        return prefs.getInt(Constants.KEY_COUNTDOWN_SECONDS, 30);
    }

    public void setCountdownSeconds(int seconds) {
        prefs.edit().putInt(Constants.KEY_COUNTDOWN_SECONDS, Math.max(0, seconds)).apply();
    }

    public boolean isScheduleEnabled() {
        return prefs.getBoolean(Constants.KEY_SCHEDULE_ENABLED, false);
    }

    /**
     * 时间表规则必须落盘：锁屏要在断网时照常生效，
     * 不能每次开机都等服务端下发（孩子拔网线就能绕过作息表）。
     */
    public void setScheduleJson(String json) {
        prefs.edit().putString(Constants.KEY_SCHEDULE_JSON, json).apply();
    }

    public String getScheduleJson() {
        return prefs.getString(Constants.KEY_SCHEDULE_JSON, "[]");
    }

    public void setScheduleEnabled(boolean enabled) {
        prefs.edit().putBoolean(Constants.KEY_SCHEDULE_ENABLED, enabled).apply();
    }

    /** 家长手动「解锁」后的放行截止时间（到下一个时间表边界为止）。 */
    public long getManualUnlockUntil() {
        return prefs.getLong(Constants.KEY_MANUAL_UNLOCK_UNTIL, 0L);
    }

    public void setManualUnlockUntil(long untilMillis) {
        prefs.edit().putLong(Constants.KEY_MANUAL_UNLOCK_UNTIL, untilMillis).apply();
    }

    /**
     * 是否存在任何「放行」——取最晚的一个。
     *
     * <p>两个来源：服务端下发的临时解锁/答题奖励（{@code tempUnlockUntil}），
     * 以及家长本机「解锁」后到下一个时间表边界为止的放行（{@code manualUnlockUntil}）。
     * 刻意<b>不再</b>单独存一份「答题奖励截止时间」：服务端答对时已经把
     * {@code tempUnlockUntil} 往后延了，本地再存一份就是第二个事实来源。
     */
    public long anyGrantUntil() {
        return Math.max(getTempUnlockUntil(), getManualUnlockUntil());
    }

    // ---------------- 最高强度档（随机改系统锁屏密码） ----------------

    /** 本机应急解锁密码的哈希。刻意只存本机、绝不上传：网络不可用时家长就靠它进门。 */
    public String getEmergencyPasswordHash() {
        // 刻意留在凭据加密存储里：它只在锁定页（用户已解锁之后）被用到，
        // 而安全阀要打破的那个死循环只需要 reset 令牌 ——
        // 没必要为了用不到的场景把这份哈希放到解锁前可读的地方。
        return prefs.getString(Constants.KEY_EMERGENCY_PASSWORD_HASH, null);
    }

    public void setEmergencyPasswordHash(String hash) {
        prefs.edit().putString(Constants.KEY_EMERGENCY_PASSWORD_HASH, hash).apply();
    }

    public boolean hasEmergencyPassword() {
        String hash = getEmergencyPasswordHash();
        return hash != null && !hash.isEmpty();
    }

    /** resetPasswordWithToken 用的令牌（设备所有者专用）。 */
    public String getResetToken() {
        return devicePrefs.getString(Constants.KEY_RESET_TOKEN, null);
    }

    public void setResetToken(String token) {
        devicePrefs.edit().putString(Constants.KEY_RESET_TOKEN, token).apply();
    }

    /** 当前生效的随机锁屏密码，供家长在本机解锁后查看。 */
    public String getCurrentRandomPassword() {
        return devicePrefs.getString(Constants.KEY_CURRENT_RANDOM_PASSWORD, null);
    }

    public void setCurrentRandomPassword(String password) {
        devicePrefs.edit().putString(Constants.KEY_CURRENT_RANDOM_PASSWORD, password).apply();
    }

    // ---------------- 最强防护 ----------------

    public boolean isHardeningEnabled() {
        return prefs.getBoolean(Constants.KEY_HARDENING_ENABLED, true);
    }

    public void setHardeningEnabled(boolean enabled) {
        prefs.edit().putBoolean(Constants.KEY_HARDENING_ENABLED, enabled).apply();
    }

    public boolean isRebootClearsPassword() {
        return prefs.getBoolean(Constants.KEY_REBOOT_CLEARS_PASSWORD, true);
    }

    public void setRebootClearsPassword(boolean clears) {
        prefs.edit().putBoolean(Constants.KEY_REBOOT_CLEARS_PASSWORD, clears).apply();
    }

    // ---------------- 屏幕行为洞察 ----------------

    /**
     * 是否开启周期截屏。
     *
     * <p>默认<b>关</b>：这是全项目敏感度最高的权限（会持续采集孩子屏幕），
     * 必须家长显式打开，绝不能给一个默认开启的开关。
     */
    public boolean isCaptureEnabled() {
        return prefs.getBoolean(Constants.KEY_CAPTURE_ENABLED, false);
    }

    public void setCaptureEnabled(boolean enabled) {
        prefs.edit().putBoolean(Constants.KEY_CAPTURE_ENABLED, enabled).apply();
    }

    public int getCaptureIntervalSeconds() {
        return prefs.getInt(Constants.KEY_CAPTURE_INTERVAL_SECONDS, 30);
    }

    public void setCaptureIntervalSeconds(int seconds) {
        prefs.edit().putInt(Constants.KEY_CAPTURE_INTERVAL_SECONDS, Math.max(10, seconds)).apply();
    }

    /** 每攒多少张打一个包。 */
    public int getFramesPerBatch() {
        return prefs.getInt(Constants.KEY_FRAMES_PER_BATCH, 10);
    }

    public void setFramesPerBatch(int count) {
        prefs.edit().putInt(Constants.KEY_FRAMES_PER_BATCH, Math.max(2, count)).apply();
    }

    public boolean isQuizFromScreen() {
        return prefs.getBoolean(Constants.KEY_QUIZ_FROM_SCREEN, false);
    }

    public void setQuizFromScreen(boolean enabled) {
        prefs.edit().putBoolean(Constants.KEY_QUIZ_FROM_SCREEN, enabled).apply();
    }

    /**
     * 下发今日局数额度。
     *
     * <p>计数来自服务端的 AI 分析 —— 设备端自己数不准（判断「这一局打完了没」要看画面）。
     * 设备端拿它做两件事：界面上展示剩余额度、以及离线时兜底锁屏。
     */
    public void setGameRoundsBudget(boolean enabled, int limit, int used) {
        prefs.edit()
                .putBoolean(Constants.KEY_GAME_ROUNDS_ENABLED, enabled)
                .putInt(Constants.KEY_GAME_ROUNDS_LIMIT, limit)
                .putInt(Constants.KEY_GAME_ROUNDS_USED, used)
                .apply();
    }

    public boolean isGameRoundsLimited() {
        return prefs.getBoolean(Constants.KEY_GAME_ROUNDS_ENABLED, false);
    }

    public int getGameRoundsLimit() {
        return prefs.getInt(Constants.KEY_GAME_ROUNDS_LIMIT, 0);
    }

    public int getGameRoundsUsed() {
        return prefs.getInt(Constants.KEY_GAME_ROUNDS_USED, 0);
    }

    public void setVideoEpisodesBudget(boolean enabled, int limit, int used) {
        prefs.edit()
                .putBoolean(Constants.KEY_VIDEO_EPISODES_ENABLED, enabled)
                .putInt(Constants.KEY_VIDEO_EPISODES_LIMIT, limit)
                .putInt(Constants.KEY_VIDEO_EPISODES_USED, used)
                .apply();
    }

    public boolean isVideoEpisodesLimited() {
        return prefs.getBoolean(Constants.KEY_VIDEO_EPISODES_ENABLED, false);
    }

    public int getVideoEpisodesLimit() {
        return prefs.getInt(Constants.KEY_VIDEO_EPISODES_LIMIT, 0);
    }

    public int getVideoEpisodesUsed() {
        return prefs.getInt(Constants.KEY_VIDEO_EPISODES_USED, 0);
    }

    public void setAppLimits(String joined) {
        prefs.edit().putString(Constants.KEY_APP_LIMITS, joined).apply();
    }

    /** 最近一次下发的应用限额，形如「抖音=60,王者荣耀=30」。 */
    public String getAppLimits() {
        return prefs.getString(Constants.KEY_APP_LIMITS, "");
    }

    // ---------------- 本地用量统计 ----------------

    /**
     * 累加今日已用时长。
     *
     * <p>注意：服务端目前<b>没有</b>给设备端提供「上报已用时长」的接口
     * （{@code /agent/config} 只读 {@code timePlan.usedTodayMinutes}），
     * 所以每日时长上限只能在设备本地统计与执行。详见 android/README.md 的「已知边界」。
     *
     * @return 今日累计已用秒数
     */
    public long addUsageSeconds(long seconds) {
        String today = dayKey();
        String storedDay = prefs.getString(Constants.KEY_USAGE_DAY, "");
        long used = today.equals(storedDay) ? prefs.getLong(Constants.KEY_USAGE_SECONDS, 0L) : 0L;
        used += seconds;
        prefs.edit()
                .putString(Constants.KEY_USAGE_DAY, today)
                .putLong(Constants.KEY_USAGE_SECONDS, used)
                .apply();
        return used;
    }

    public long getUsageSecondsToday() {
        String today = dayKey();
        String storedDay = prefs.getString(Constants.KEY_USAGE_DAY, "");
        if (!today.equals(storedDay)) return 0L;
        return prefs.getLong(Constants.KEY_USAGE_SECONDS, 0L);
    }

    private static String dayKey() {
        return new SimpleDateFormat("yyyy-MM-dd", Locale.US).format(new Date());
    }

    /**
     * 注册 / 续订成功后写入身份。
     *
     * <p><b>为什么不能只是 setDeviceId</b>：服务端返回的 deviceId 与本地记录的不一致时，
     * 说明这台手机在服务端那边已经是「另一台设备」了（典型场景：家长解绑后，
     * 设备端自动重新注册，拿到一条全新的设备记录）。
     * 这时候必须把<b>上一台设备缓存下来的策略</b>一起丢掉 ——
     * 否则新设备会继承旧设备的「已锁定」，孩子手机会莫名其妙一直锁着，
     * 而家长端已经看不到那台设备了，等于谁也解不开。
     *
     * <p>实测踩过：解绑后重新注册，`last_config_json` 里还留着旧 deviceId 的
     * `"locked":true`，设备稳定停在锁定页上，看起来像应用坏了。
     *
     * @return true 表示检测到身份变化，并已清理陈旧的锁定/作息缓存
     */
    public boolean applyRegistration(String deviceId, String deviceToken, boolean bound) {
        String previous = getDeviceId();
        boolean changed = previous != null && deviceId != null && !previous.equals(deviceId);
        if (changed) {
            prefs.edit()
                    .remove(Constants.KEY_LAST_CONFIG_JSON)
                    .remove(Constants.KEY_LOCKED)
                    .remove(Constants.KEY_TEMP_UNLOCK_UNTIL)
                    .remove(Constants.KEY_MANUAL_UNLOCK_UNTIL)
                    .remove(Constants.KEY_SCHEDULE_JSON)
                    .remove(Constants.KEY_SCHEDULE_ENABLED)
                    .apply();
            EventLog.warn("设备身份已变化（" + previous + " → " + deviceId
                    + "），已丢弃上一台设备缓存的锁定策略");
        }
        setDeviceToken(deviceToken);
        setDeviceId(deviceId);
        setBound(bound);
        return changed;
    }

    // ---------------- 模式切换 / 护眼 / 应用插件 ----------------

    /** 模式配置。解析失败时退回「不启用的普通模式」，绝不让坏 JSON 把拦截逻辑带崩。 */
    public com.balloondog.agent.model.ModeConfig getModeConfig() {
        String json = prefs.getString(Constants.KEY_MODE_JSON, null);
        if (json == null) return com.balloondog.agent.model.ModeConfig.disabled();
        try {
            return com.balloondog.agent.model.ModeConfig.parse(new org.json.JSONObject(json));
        } catch (Exception e) {
            EventLog.warn("模式配置解析失败，按普通模式处理：" + e.getMessage());
            return com.balloondog.agent.model.ModeConfig.disabled();
        }
    }

    public void setModeConfig(com.balloondog.agent.model.ModeConfig config) {
        prefs.edit().putString(Constants.KEY_MODE_JSON, config.toJson().toString()).apply();
    }

    public com.balloondog.agent.model.EyeCareConfig getEyeCareConfig() {
        String json = prefs.getString(Constants.KEY_EYE_CARE_JSON, null);
        if (json == null) return com.balloondog.agent.model.EyeCareConfig.disabled();
        try {
            return com.balloondog.agent.model.EyeCareConfig.parse(new org.json.JSONObject(json));
        } catch (Exception e) {
            EventLog.warn("护眼配置解析失败，按未启用处理：" + e.getMessage());
            return com.balloondog.agent.model.EyeCareConfig.disabled();
        }
    }

    public void setEyeCareConfig(com.balloondog.agent.model.EyeCareConfig config) {
        prefs.edit().putString(Constants.KEY_EYE_CARE_JSON, config.toJson().toString()).apply();
    }

    public java.util.List<com.balloondog.agent.model.PluginRule> getPluginRules() {
        String json = prefs.getString(Constants.KEY_PLUGIN_RULES_JSON, null);
        if (json == null) return java.util.Collections.emptyList();
        try {
            return com.balloondog.agent.model.PluginRule.parseAll(new org.json.JSONArray(json));
        } catch (Exception e) {
            EventLog.warn("插件规则解析失败，按无规则处理：" + e.getMessage());
            return java.util.Collections.emptyList();
        }
    }

    public void setPluginRules(java.util.List<com.balloondog.agent.model.PluginRule> rules) {
        prefs.edit()
                .putString(Constants.KEY_PLUGIN_RULES_JSON,
                        com.balloondog.agent.model.PluginRule.toJson(rules))
                .apply();
    }

    public long getEyeContinuousMs() {
        return prefs.getLong(Constants.KEY_EYE_CONTINUOUS_MS, 0L);
    }

    public void setEyeContinuousMs(long ms) {
        prefs.edit().putLong(Constants.KEY_EYE_CONTINUOUS_MS, Math.max(0L, ms)).apply();
    }

    public long getEyeRestUntil() {
        return prefs.getLong(Constants.KEY_EYE_REST_UNTIL, 0L);
    }

    public void setEyeRestUntil(long at) {
        prefs.edit().putLong(Constants.KEY_EYE_REST_UNTIL, Math.max(0L, at)).apply();
    }

    public long getAppsReportedAt() {
        return prefs.getLong(Constants.KEY_APPS_REPORTED_AT, 0L);
    }

    public void setAppsReportedAt(long at) {
        prefs.edit().putLong(Constants.KEY_APPS_REPORTED_AT, at).apply();
    }

    // ---------------- 服务端特性开关快照 ----------------

    /**
     * 保存 {@code /agent/config} 里下发的 features 列表。
     *
     * <p>为什么要落盘：指令可能在配置下发很久之后才到（甚至断网重连后才补到），
     * 设备端必须能回答「家长到底有没有开这个功能」，不能只靠内存里那份配置对象。
     * 与服务端一致用逗号分隔，便于 SharedPreferences 直接存字符串。
     */
    public void setFeatures(java.util.List<String> features) {
        StringBuilder sb = new StringBuilder();
        if (features != null) {
            for (String feature : features) {
                if (TextUtils.isEmpty(feature)) continue;
                if (sb.length() > 0) sb.append(',');
                sb.append(feature.trim());
            }
        }
        prefs.edit().putString(Constants.KEY_FEATURES, sb.toString()).apply();
    }

    public java.util.List<String> getFeatures() {
        String joined = prefs.getString(Constants.KEY_FEATURES, "");
        if (TextUtils.isEmpty(joined)) return java.util.Collections.emptyList();
        java.util.List<String> out = new java.util.ArrayList<>();
        for (String part : joined.split(",")) {
            if (!TextUtils.isEmpty(part)) out.add(part.trim());
        }
        return out;
    }

    /** 是否已经收到过带 features 的配置。没收到过时所有特性判定都按「不拦」处理。 */
    public boolean knowsFeatures() {
        return !getFeatures().isEmpty();
    }

    /**
     * 特性是否开启。
     *
     * <p><b>刻意在「还没收到过配置」时返回 true</b>：这是一个不制造假象的取舍 ——
     * 设备刚装好、还没连上服务端时，本地无法知道家长开没开某项功能；
     * 此时返回 false 会让功能静默失效（看起来像坏了），返回 true 则由服务端把关
     * （服务端本来就不会下发没开启的指令）。一旦收到过配置，就以快照为准。
     */
    public boolean isFeatureEnabled(String key) {
        java.util.List<String> features = getFeatures();
        if (features.isEmpty()) return true;
        return features.contains(key);
    }

    // ---------------- 安全区（契约 §2） ----------------

    /** 安全区列表必须落盘：断网时进出判定照常工作（离线优先）。 */
    public void setSafeZones(java.util.List<com.balloondog.agent.model.SafeZone> zones) {
        prefs.edit()
                .putString(Constants.KEY_SAFE_ZONES, com.balloondog.agent.model.SafeZone.toJson(zones))
                .apply();
    }

    public java.util.List<com.balloondog.agent.model.SafeZone> getSafeZones() {
        return com.balloondog.agent.model.SafeZone.parseJson(
                prefs.getString(Constants.KEY_SAFE_ZONES, null));
    }

    /** 上一次定位时所在的区 id；null = 当时不在任何安全区内。 */
    @Nullable
    public String getLastSafeZoneId() {
        return prefs.getString(Constants.KEY_LAST_SAFE_ZONE_ID, null);
    }

    public void setLastSafeZoneId(@Nullable String zoneId) {
        if (TextUtils.isEmpty(zoneId)) {
            prefs.edit().remove(Constants.KEY_LAST_SAFE_ZONE_ID).apply();
        } else {
            prefs.edit().putString(Constants.KEY_LAST_SAFE_ZONE_ID, zoneId).apply();
        }
    }

    // ---------------- 应用审核（契约 §3） ----------------

    public long getInstallApprovalUntil() {
        return prefs.getLong(Constants.KEY_INSTALL_APPROVAL_UNTIL, 0L);
    }

    public void setInstallApprovalUntil(long untilMillis) {
        prefs.edit().putLong(Constants.KEY_INSTALL_APPROVAL_UNTIL, Math.max(0L, untilMillis)).apply();
    }

    /**
     * 家长批准后的放开窗口是否有效。
     *
     * <p><b>刻意只判断「服务端给了非空时间」，不拿本机时钟比大小</b>：
     * 服务端返回 {@code installApprovalUntil} 之前已经用它自己的时钟把过期的项置成了 null，
     * 本机时钟反而不可信（孩子把时间改掉就能凭空延长安装窗口，
     * 也就是说「客户端时钟准不准」不该成为安全边界）。窗口到期后，
     * 下一次配置刷新（最长 60 秒）服务端会下发 null，限制自动收紧。
     */
    public boolean isInstallWindowOpen() {
        return getInstallApprovalUntil() > 0;
    }

    /**
     * 上一次发起安装申请的时间戳。
     *
     * <p>备注：App 用服务端返回的 id 做去重键，本地这份时间戳只是「同一包名 10 分钟内
     * 只报一次」的兜底（服务挂了或离线时也不能反复刷屏）。
     */
    public long getInstallAuditLastAt() {
        return prefs.getLong(Constants.KEY_INSTALL_AUDIT_LAST_AT, 0L);
    }

    public void setInstallAuditLastAt(long at) {
        prefs.edit().putLong(Constants.KEY_INSTALL_AUDIT_LAST_AT, at).apply();
    }

    // ---------------- 应用限时与逐应用用量（契约 §4） ----------------

    public void setAppLimitRules(java.util.List<com.balloondog.agent.model.AppLimitRule> rules) {
        prefs.edit()
                .putString(Constants.KEY_APP_LIMIT_RULES,
                        com.balloondog.agent.model.AppLimitRule.toJson(rules))
                .apply();
    }

    public java.util.List<com.balloondog.agent.model.AppLimitRule> getAppLimitRules() {
        return com.balloondog.agent.model.AppLimitRule.parseJson(
                prefs.getString(Constants.KEY_APP_LIMIT_RULES, null));
    }

    /** 保存今日逐应用用量（秒）。跨天由 {@link #getAppUsageToday()} 自动归零。 */
    public void setAppUsageToday(java.util.Map<String, Integer> usage) {
        org.json.JSONObject root = new org.json.JSONObject();
        org.json.JSONObject items = new org.json.JSONObject();
        try {
            root.put("day", dayKey());
            if (usage != null) {
                for (java.util.Map.Entry<String, Integer> entry : usage.entrySet()) {
                    if (TextUtils.isEmpty(entry.getKey()) || entry.getValue() == null) continue;
                    items.put(entry.getKey(), entry.getValue());
                }
            }
            root.put("usage", items);
        } catch (Exception e) {
            EventLog.warn("逐应用用量序列化失败，本次不落盘：" + e.getMessage());
            return;
        }
        prefs.edit().putString(Constants.KEY_APP_USAGE_JSON, root.toString()).apply();
    }

    /**
     * 今日逐应用前台秒数（包名 → 秒）。
     *
     * <p>刻意只读本地缓存、不在这里查 {@code UsageStatsManager}：
     * 无障碍回调每秒可能触发多次，那里绝不能做耗时查询。
     */
    public java.util.Map<String, Integer> getAppUsageToday() {
        java.util.Map<String, Integer> out = new java.util.HashMap<>();
        String json = prefs.getString(Constants.KEY_APP_USAGE_JSON, null);
        if (json == null) return out;
        try {
            org.json.JSONObject root = new org.json.JSONObject(json);
            if (!dayKey().equals(root.optString("day", ""))) return out;
            org.json.JSONObject items = root.optJSONObject("usage");
            if (items == null) return out;
            java.util.Iterator<String> keys = items.keys();
            while (keys.hasNext()) {
                String pkg = keys.next();
                out.put(pkg, items.optInt(pkg, 0));
            }
        } catch (Exception e) {
            EventLog.warn("逐应用用量解析失败，按无用量处理：" + e.getMessage());
        }
        return out;
    }

    public long getAppUsageReportedAt() {
        return prefs.getLong(Constants.KEY_APP_USAGE_REPORTED_AT, 0L);
    }

    public void setAppUsageReportedAt(long at) {
        prefs.edit().putLong(Constants.KEY_APP_USAGE_REPORTED_AT, at).apply();
    }

    // ---------------- 电话与短信（契约 §8） ----------------

    public long getCallsSmsReportedAt() {
        return prefs.getLong(Constants.KEY_CALLS_SMS_REPORTED_AT, 0L);
    }

    public void setCallsSmsReportedAt(long at) {
        prefs.edit().putLong(Constants.KEY_CALLS_SMS_REPORTED_AT, at).apply();
    }

    // ---------------- 网址拦截与隐藏图标（契约 §5/§9） ----------------

    /** 家长是否开启网址拦截（特性开 且 黑名单非空）。VPN 服务据此自检并在关闭时退出。 */
    public boolean isWebBlockEnabled() {
        return prefs.getBoolean(Constants.KEY_WEB_BLOCK_ENABLED, false);
    }

    public void setWebBlockEnabled(boolean enabled) {
        prefs.edit().putBoolean(Constants.KEY_WEB_BLOCK_ENABLED, enabled).apply();
    }

    public boolean isHideIcon() {
        return prefs.getBoolean(Constants.KEY_HIDE_ICON, false);
    }

    public void setHideIcon(boolean hidden) {
        prefs.edit().putBoolean(Constants.KEY_HIDE_ICON, hidden).apply();
    }

    public long getVpnConsentNotifiedAt() {
        return prefs.getLong(Constants.KEY_VPN_CONSENT_NOTIFIED_AT, 0L);
    }

    public void setVpnConsentNotifiedAt(long at) {
        prefs.edit().putLong(Constants.KEY_VPN_CONSENT_NOTIFIED_AT, at).apply();
    }

    // ---------------- 重置 ----------------

    /** 清空设备身份，下次连接会以一台全新设备重新注册（家长需重新输入新绑定码）。 */
    public void resetIdentity() {
        prefs.edit()
                .remove(Constants.KEY_DEVICE_CODE)
                .remove(Constants.KEY_DEVICE_SECRET)
                .remove(Constants.KEY_DEVICE_TOKEN)
                .remove(Constants.KEY_DEVICE_ID)
                .remove(Constants.KEY_BOUND)
                .remove(Constants.KEY_LAST_CONFIG_JSON)
                .remove(Constants.KEY_LAST_ALIVE_AT)
                .remove(Constants.KEY_LOCK_STRENGTH)
                .remove(Constants.KEY_SCHEDULE_JSON)
                .remove(Constants.KEY_SCHEDULE_ENABLED)
                .remove(Constants.KEY_MANUAL_UNLOCK_UNTIL)
                .remove(Constants.KEY_CAPTURE_ENABLED)
                .remove(Constants.KEY_QUIZ_FROM_SCREEN)
                .remove(Constants.KEY_MODE_JSON)
                .remove(Constants.KEY_EYE_CARE_JSON)
                .remove(Constants.KEY_PLUGIN_RULES_JSON)
                .remove(Constants.KEY_EYE_CONTINUOUS_MS)
                .remove(Constants.KEY_EYE_REST_UNTIL)
                .remove(Constants.KEY_FEATURES)
                .remove(Constants.KEY_SAFE_ZONES)
                .remove(Constants.KEY_LAST_SAFE_ZONE_ID)
                .remove(Constants.KEY_INSTALL_APPROVAL_UNTIL)
                .remove(Constants.KEY_APP_LIMIT_RULES)
                .remove(Constants.KEY_APP_USAGE_JSON)
                .remove(Constants.KEY_CALLS_SMS_REPORTED_AT)
                .remove(Constants.KEY_WEB_BLOCK_ENABLED)
                .apply();
        // 注意：刻意<b>不</b>清除应急密码与重置令牌 —— 它们属于「这台设备」而不是
        // 「这个设备身份」，重新配对后家长仍然需要它们来解锁。
    }
}
