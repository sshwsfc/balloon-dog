package com.balloondog.agent.model;

import org.json.JSONObject;

/**
 * 护眼设置。
 *
 * <p>对应服务端 {@code /agent/config} 的 {@code eyeCare} 块。
 * 三项分别是三种不同的手段，落在设备上的实现也完全不同：
 * <ul>
 *   <li>{@code continuousMinutes} + {@code restMinutes}：连续用眼到点 → <b>真锁屏</b>强制休息；</li>
 *   <li>{@code nightStartHour}/{@code nightEndHour} + {@code nightLockEnabled}：夜间时段锁定；</li>
 *   <li>{@code maxBrightnessPercent}：屏幕亮度上限（需要 WRITE_SETTINGS，拿不到就如实记日志）。</li>
 * </ul>
 */
public final class EyeCareConfig {

    public final boolean enabled;
    public final int continuousMinutes;
    public final int restMinutes;
    public final int nightStartHour;
    public final int nightEndHour;
    public final boolean nightLockEnabled;
    public final int maxBrightnessPercent;

    private EyeCareConfig(boolean enabled, int continuousMinutes, int restMinutes,
                          int nightStartHour, int nightEndHour, boolean nightLockEnabled,
                          int maxBrightnessPercent) {
        this.enabled = enabled;
        this.continuousMinutes = continuousMinutes;
        this.restMinutes = restMinutes;
        this.nightStartHour = nightStartHour;
        this.nightEndHour = nightEndHour;
        this.nightLockEnabled = nightLockEnabled;
        this.maxBrightnessPercent = maxBrightnessPercent;
    }

    public static EyeCareConfig disabled() {
        return new EyeCareConfig(false, 40, 10, 22, 7, false, 0);
    }

    public static EyeCareConfig parse(JSONObject json) {
        if (json == null) return disabled();
        return new EyeCareConfig(
                json.optBoolean("enabled", false),
                clamp(json.optInt("continuousMinutes", 40), 5, 240),
                clamp(json.optInt("restMinutes", 10), 1, 60),
                clamp(json.optInt("nightStartHour", 22), 0, 23),
                clamp(json.optInt("nightEndHour", 7), 0, 23),
                json.optBoolean("nightLockEnabled", false),
                clamp(json.optInt("maxBrightnessPercent", 0), 0, 100));
    }

    public JSONObject toJson() {
        JSONObject o = new JSONObject();
        try {
            o.put("enabled", enabled);
            o.put("continuousMinutes", continuousMinutes);
            o.put("restMinutes", restMinutes);
            o.put("nightStartHour", nightStartHour);
            o.put("nightEndHour", nightEndHour);
            o.put("nightLockEnabled", nightLockEnabled);
            o.put("maxBrightnessPercent", maxBrightnessPercent);
        } catch (Exception ignored) {
            // 常量 key，不会抛
        }
        return o;
    }

    /** 夜间时段是否启用（起止相同视为不启用）。 */
    public boolean nightEnabled() {
        return nightStartHour != nightEndHour;
    }

    /**
     * 某个小时是否落在夜间时段内。
     *
     * <p>支持跨零点（例如 22 → 7）。起止相同视为不启用，返回 false ——
     * 这一点与服务端校验保持一致：那边也拒绝「起止相同却开夜间锁定」的矛盾配置。
     */
    public boolean isNightHour(int hour) {
        if (!nightEnabled()) return false;
        if (nightStartHour < nightEndHour) {
            return hour >= nightStartHour && hour < nightEndHour;
        }
        // 跨零点：22,23,0..6
        return hour >= nightStartHour || hour < nightEndHour;
    }

    private static int clamp(int v, int min, int max) {
        return Math.max(min, Math.min(max, v));
    }
}
