package com.balloondog.agent.model;

import androidx.annotation.Nullable;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Calendar;
import java.util.Collections;
import java.util.List;

/**
 * 一条定时锁屏 / 定时解锁规则。
 *
 * <p>字段与 {@code server/src/features/schedule/schedule.dto.ts} 一一对应，
 * 时间用「从 00:00 起的分钟数」表示：设备端要做逐分钟求值，整数比较最不容易出错，
 * 也天然绕开了时区字符串解析。
 */
public class ScheduleRule {

    public final String id;
    public final String name;
    /** lock 该时段锁定 | unlock 该时段允许使用 */
    public final String action;
    /** 0=周日 … 6=周六（与 {@link Calendar#DAY_OF_WEEK} 的换算见 ScheduleEngine） */
    public final List<Integer> daysOfWeek;
    /** 0..1439，从 00:00 起的分钟数 */
    public final int startMinute;
    /** 1..1440；1440 表示当天 24:00；小于 startMinute 表示跨天 */
    public final int endMinute;
    public final boolean enabled;

    public ScheduleRule(String id, String name, String action, List<Integer> daysOfWeek,
                        int startMinute, int endMinute, boolean enabled) {
        this.id = id;
        this.name = name;
        this.action = action;
        this.daysOfWeek = daysOfWeek;
        this.startMinute = startMinute;
        this.endMinute = endMinute;
        this.enabled = enabled;
    }

    public boolean isUnlock() {
        return "unlock".equals(action);
    }

    public boolean isLock() {
        return "lock".equals(action);
    }

    /** 是否跨天（例如 22:00 → 次日 07:00）。 */
    public boolean crossesMidnight() {
        return endMinute <= startMinute;
    }

    @Nullable
    public static ScheduleRule from(@Nullable JSONObject json) {
        if (json == null) return null;
        List<Integer> days = new ArrayList<>();
        JSONArray array = json.optJSONArray("daysOfWeek");
        if (array != null) {
            for (int i = 0; i < array.length(); i++) {
                days.add(array.optInt(i));
            }
        }
        return new ScheduleRule(
                json.optString("id"),
                json.optString("name", ""),
                json.optString("action", "lock"),
                Collections.unmodifiableList(days),
                json.optInt("startMinute", 0),
                json.optInt("endMinute", 1440),
                json.optBoolean("enabled", true));
    }

    /** 解析设备端配置里的 schedule 数组。 */
    public static List<ScheduleRule> listFrom(@Nullable JSONArray array) {
        List<ScheduleRule> rules = new ArrayList<>();
        if (array == null) return rules;
        for (int i = 0; i < array.length(); i++) {
            ScheduleRule rule = from(array.optJSONObject(i));
            if (rule != null) rules.add(rule);
        }
        return rules;
    }

    /** "22:00" 这类展示用文案。 */
    public static String formatMinute(int minute) {
        int clamped = Math.max(0, Math.min(1440, minute));
        if (clamped == 1440) return "24:00";
        return String.format(java.util.Locale.US, "%02d:%02d", clamped / 60, clamped % 60);
    }

    /** "周一、周二" 这类展示用文案。 */
    public String describeDays() {
        if (daysOfWeek.size() == 7) return "每天";
        StringBuilder sb = new StringBuilder();
        for (int day : daysOfWeek) {
            if (sb.length() > 0) sb.append('、');
            sb.append(WEEKDAY_LABELS[((day % 7) + 7) % 7]);
        }
        return sb.toString();
    }

    public static final String[] WEEKDAY_LABELS = {"周日", "周一", "周二", "周三", "周四", "周五", "周六"};

    /** "22:00 → 次日 07:00" 这类展示用文案。 */
    public String describeRange() {
        String range = formatMinute(startMinute) + " → " + formatMinute(endMinute);
        if (crossesMidnight()) {
            // endMinute=0 在模型里不允许（最小 1），所以跨天一定是「次日」
            range = formatMinute(startMinute) + " → 次日 " + formatMinute(endMinute);
        }
        return range;
    }

    @Override
    public String toString() {
        return (name == null || name.isEmpty() ? action : name) + " " + describeRange() + " " + describeDays();
    }
}
