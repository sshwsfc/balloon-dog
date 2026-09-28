package com.balloondog.agent.data;

import android.content.Context;
import android.content.SharedPreferences;
import android.text.TextUtils;

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
    private final Context appContext;

    public AgentStore(Context context) {
        this.appContext = context.getApplicationContext();
        this.prefs = this.appContext
                .getSharedPreferences(Constants.PREFS, Context.MODE_PRIVATE);
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

    public String getLastConfigJson() {
        return prefs.getString(Constants.KEY_LAST_CONFIG_JSON, null);
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
        return prefs.getString(Constants.KEY_RESET_TOKEN, null);
    }

    public void setResetToken(String token) {
        prefs.edit().putString(Constants.KEY_RESET_TOKEN, token).apply();
    }

    /** 当前生效的随机锁屏密码，供家长在本机解锁后查看。 */
    public String getCurrentRandomPassword() {
        return prefs.getString(Constants.KEY_CURRENT_RANDOM_PASSWORD, null);
    }

    public void setCurrentRandomPassword(String password) {
        prefs.edit().putString(Constants.KEY_CURRENT_RANDOM_PASSWORD, password).apply();
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
                .apply();
        // 注意：刻意<b>不</b>清除应急密码与重置令牌 —— 它们属于「这台设备」而不是
        // 「这个设备身份」，重新配对后家长仍然需要它们来解锁。
    }
}
