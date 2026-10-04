package com.balloondog.agent.model;

import androidx.annotation.Nullable;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * {@code GET /api/agent/config} 下发的管控策略快照。
 *
 * <p>设备端拿到它之后在本地强制执行：锁屏、每日时长、应用限额、网址黑名单、答题配置。
 * 未绑定（{@code bound=false}）时服务端只回最基本信息，此时除 {@code bound} 外都是默认值。
 */
public class DeviceConfig {

    public final boolean bound;
    public final String deviceId;
    public final String deviceCode;
    public final String message;
    public final boolean locked;
    public final long tempUnlockUntil;
    public final List<String> features;
    public final boolean timePlanEnabled;
    public final int dailyLimitMinutes;
    public final int remainingMinutes;
    public final boolean unlimited;
    public final List<String> blockedUrls;
    /** 应用限额：appName → 每日分钟数 */
    public final List<AppLimit> appLimits;

    // ---- 锁屏强度与时间表（见 server LockPolicy / ScheduleRule）----
    /** kiosk 锁定页（默认）| password 随机改系统锁屏密码（最高强度） */
    public final String lockStrength;
    /** 锁屏前透明悬浮窗倒计时秒数，0 = 不预告 */
    public final int countdownSeconds;
    public final boolean scheduleEnabled;
    /** 已启用的时间表规则；服务端只下发 enabled 的那些 */
    public final List<ScheduleRule> schedule;

    // ---- 屏幕行为洞察 ----
    public final boolean captureEnabled;
    public final int captureIntervalSeconds;
    public final int framesPerBatch;
    public final boolean quizFromScreen;
    /** 今日局数额度（由服务端的 AI 分析计数） */
    public final boolean gameRoundsLimited;
    public final int gameRoundsLimit;
    public final int gameRoundsUsed;
    public final boolean videoEpisodesLimited;
    public final int videoEpisodesLimit;
    public final int videoEpisodesUsed;
    public final boolean quizEnabled;
    public final String quizType;
    public final String quizGrade;
    public final int quizRewardMinutes;
    public final boolean quizRandomMode;
    /** 模式切换（学习 / 普通）。 */
    public final ModeConfig mode;
    /** 护眼设置。 */
    public final EyeCareConfig eyeCare;
    /** 应用插件管控规则（只含被家长改动过的项）。 */
    public final List<PluginRule> appPlugins;
    /** 原始 JSON，便于在界面上原样展示或排查。 */
    public final String rawJson;

    private DeviceConfig(JSONObject json) {
        rawJson = json.toString();
        bound = json.optBoolean("bound", false);
        deviceId = json.optString("deviceId", null);
        deviceCode = json.optString("deviceCode", null);
        message = json.optString("message", null);
        locked = json.optBoolean("locked", false);
        tempUnlockUntil = JsonUtils.parseIsoMillis(json.optString("tempUnlockUntil", null));
        mode = ModeConfig.parse(json.optJSONObject("mode"));
        eyeCare = EyeCareConfig.parse(json.optJSONObject("eyeCare"));
        appPlugins = PluginRule.parseAll(json.optJSONArray("appPlugins"));

        List<String> featureList = new ArrayList<>();
        JSONArray featureArray = json.optJSONArray("features");
        if (featureArray != null) {
            for (int i = 0; i < featureArray.length(); i++) {
                featureList.add(featureArray.optString(i));
            }
        }
        features = Collections.unmodifiableList(featureList);

        JSONObject timePlan = json.optJSONObject("timePlan");
        if (timePlan != null) {
            timePlanEnabled = timePlan.optBoolean("enabled", false);
            dailyLimitMinutes = timePlan.optInt("dailyLimitMinutes", 0);
            remainingMinutes = timePlan.optInt("remainingMinutes", 0);
            unlimited = timePlan.optBoolean("unlimited", dailyLimitMinutes == 0);
        } else {
            timePlanEnabled = false;
            dailyLimitMinutes = 0;
            remainingMinutes = 0;
            unlimited = true;
        }

        List<AppLimit> limitList = new ArrayList<>();
        JSONArray limitArray = json.optJSONArray("appLimits");
        if (limitArray != null) {
            for (int i = 0; i < limitArray.length(); i++) {
                JSONObject item = limitArray.optJSONObject(i);
                if (item == null) continue;
                limitList.add(new AppLimit(
                        item.optString("appName"),
                        item.optString("packageName", ""),
                        item.optInt("dailyLimitMinutes", 0)));
            }
        }
        appLimits = Collections.unmodifiableList(limitList);

        List<String> urlList = new ArrayList<>();
        JSONArray urlArray = json.optJSONArray("blockedUrls");
        if (urlArray != null) {
            for (int i = 0; i < urlArray.length(); i++) {
                urlList.add(urlArray.optString(i));
            }
        }
        blockedUrls = Collections.unmodifiableList(urlList);

        JSONObject lockPolicy = json.optJSONObject("lockPolicy");
        if (lockPolicy != null) {
            lockStrength = lockPolicy.optString("strength", "kiosk");
            countdownSeconds = lockPolicy.optInt("countdownSeconds", 30);
            scheduleEnabled = lockPolicy.optBoolean("scheduleEnabled", false);
            schedule = Collections.unmodifiableList(
                    ScheduleRule.listFrom(lockPolicy.optJSONArray("schedule")));
        } else {
            // 旧版后端没有这个字段：按「不因时间表锁定、锁屏前 30 秒预告」处理，
            // 保证客户端与老服务端也能正常配对
            lockStrength = "kiosk";
            countdownSeconds = 30;
            scheduleEnabled = false;
            schedule = Collections.emptyList();
        }

        JSONObject screenMonitor = json.optJSONObject("screenMonitor");
        if (screenMonitor != null) {
            captureEnabled = screenMonitor.optBoolean("captureEnabled", false);
            captureIntervalSeconds = screenMonitor.optInt("captureIntervalSeconds", 30);
            framesPerBatch = screenMonitor.optInt("framesPerBatch", 10);
            quizFromScreen = screenMonitor.optBoolean("quizFromScreen", false);

            JSONObject usageBudget = screenMonitor.optJSONObject("usageBudget");
            JSONObject gameRounds = usageBudget == null ? null : usageBudget.optJSONObject("gameRounds");
            JSONObject videoEpisodes = usageBudget == null ? null : usageBudget.optJSONObject("videoEpisodes");
            gameRoundsLimited = gameRounds != null && gameRounds.optBoolean("enabled", false);
            gameRoundsLimit = gameRounds == null ? 0 : gameRounds.optInt("dailyLimit", 0);
            gameRoundsUsed = gameRounds == null ? 0 : gameRounds.optInt("usedToday", 0);
            videoEpisodesLimited = videoEpisodes != null && videoEpisodes.optBoolean("enabled", false);
            videoEpisodesLimit = videoEpisodes == null ? 0 : videoEpisodes.optInt("dailyLimit", 0);
            videoEpisodesUsed = videoEpisodes == null ? 0 : videoEpisodes.optInt("usedToday", 0);
        } else {
            // 旧版后端没有这个字段：全部按「未开启」处理，功能自然降级
            captureEnabled = false;
            captureIntervalSeconds = 30;
            framesPerBatch = 10;
            quizFromScreen = false;
            gameRoundsLimited = false;
            gameRoundsLimit = 0;
            gameRoundsUsed = 0;
            videoEpisodesLimited = false;
            videoEpisodesLimit = 0;
            videoEpisodesUsed = 0;
        }

        JSONObject quiz = json.optJSONObject("quiz");
        if (quiz != null) {
            quizEnabled = quiz.optBoolean("enabled", false);
            quizType = quiz.optString("quizType", "english");
            quizGrade = quiz.optString("grade", "grade1");
            quizRewardMinutes = quiz.optInt("rewardMinutes", 3);
            quizRandomMode = quiz.optBoolean("randomMode", false);
        } else {
            quizEnabled = false;
            quizType = "english";
            quizGrade = "grade1";
            quizRewardMinutes = 3;
            quizRandomMode = false;
        }
    }

    public static DeviceConfig from(@Nullable JSONObject json) {
        return new DeviceConfig(json == null ? new JSONObject() : json);
    }

    /** 一条应用限额。 */
    public static final class AppLimit {
        public final String appName;
        public final String packageName;
        public final int dailyLimitMinutes;

        AppLimit(String appName, String packageName, int dailyLimitMinutes) {
            this.appName = appName;
            this.packageName = packageName;
            this.dailyLimitMinutes = dailyLimitMinutes;
        }
    }

    public boolean hasFeature(String key) {
        return features.contains(key);
    }

    /**
     * 只把时间表规则序列化出来，用于落盘。
     *
     * <p>锁屏要在断网时照常生效，所以规则必须在 {@code /agent/config} 到达时存到本地，
     * 之后完全由本地时钟驱动。
     */
    public String scheduleToJson() {
        JSONArray array = new JSONArray();
        for (ScheduleRule rule : schedule) {
            JSONObject item = new JSONObject();
            try {
                item.put("id", rule.id);
                item.put("name", rule.name);
                item.put("action", rule.action);
                item.put("daysOfWeek", new JSONArray(rule.daysOfWeek));
                item.put("startMinute", rule.startMinute);
                item.put("endMinute", rule.endMinute);
                item.put("enabled", rule.enabled);
            } catch (org.json.JSONException ignored) {
                // 全部是原生类型，实际不会抛
            }
            array.put(item);
        }
        return array.toString();
    }

    /** 一句话摘要，直接显示在通知与主界面上。 */
    public String summary() {
        if (!bound) return "尚未被家长绑定";
        StringBuilder sb = new StringBuilder();
        sb.append(locked ? "已锁屏" : "未锁屏");
        if (timePlanEnabled || dailyLimitMinutes > 0) {
            sb.append(" · ").append(unlimited ? "时长不限" : "剩余 " + remainingMinutes + " 分钟");
        }
        if (!blockedUrls.isEmpty()) sb.append(" · 拦截 ").append(blockedUrls.size()).append(" 个网址");
        sb.append(" · 答题").append(quizEnabled ? "已开" : "关闭");
        if (scheduleEnabled) sb.append(" · 作息 ").append(schedule.size()).append(" 条");
        if ("study".equals(mode.manualMode)) sb.append(" · 学习模式");
        else if (mode.scheduleEnabled) sb.append(" · 按时段").append(mode.slots.size()).append(" 格");
        if (eyeCare.enabled) sb.append(" · 护眼");
        if (!appPlugins.isEmpty()) sb.append(" · 管控 ").append(appPlugins.size()).append(" 项");
        return sb.toString();
    }
}
