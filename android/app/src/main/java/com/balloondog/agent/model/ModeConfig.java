package com.balloondog.agent.model;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * 学习模式 / 普通模式的本地配置。
 *
 * <p>与服务端 {@code /agent/config} 的 {@code mode} 块一一对应。
 * 求值逻辑刻意放在设备端（见 {@link com.balloondog.agent.capability.StudyModeEngine}）：
 * 断网、拔卡、关 Wi-Fi 都必须照常生效，否则「学习模式」就是个摆设。
 */
public final class ModeConfig {

    /** 手动锁定模式：study | normal；null 表示跟随时段规划。 */
    public final String manualMode;
    public final boolean scheduleEnabled;
    public final List<Slot> slots;
    /** 学习模式下允许使用的应用包名。不在这个清单里的可启动应用会被拦。 */
    public final List<String> studyApps;

    public static final class Slot {
        public final int dayOfWeek; // 0=周日 … 6=周六
        public final int hour;      // 0..23

        Slot(int dayOfWeek, int hour) {
            this.dayOfWeek = dayOfWeek;
            this.hour = hour;
        }
    }

    private ModeConfig(String manualMode, boolean scheduleEnabled,
                       List<Slot> slots, List<String> studyApps) {
        this.manualMode = manualMode;
        this.scheduleEnabled = scheduleEnabled;
        this.slots = Collections.unmodifiableList(slots);
        this.studyApps = Collections.unmodifiableList(studyApps);
    }

    /**
     * 直接构造一份配置。
     *
     * <p>给交叉验证用：那条链路要能把「同一组规则」喂给 Android 与后端两套实现，
     * 而设备上没有真正的 JSON 解析器可用（跑在普通 JVM 上）。
     * 服务端的解析路径由设备端联调覆盖，这里只关心求值逻辑本身。
     */
    public static ModeConfig of(String manualMode, boolean scheduleEnabled,
                                List<Slot> slots, List<String> studyApps) {
        return new ModeConfig(manualMode, scheduleEnabled, slots, studyApps);
    }

    /** 造一个时段格子。 */
    public static Slot slot(int dayOfWeek, int hour) {
        return new Slot(dayOfWeek, hour);
    }

    /** 服务端缺省 / 老版本返回时用的空配置：不启用的普通模式。 */
    public static ModeConfig disabled() {
        return new ModeConfig(null, false, Collections.<Slot>emptyList(),
                Collections.<String>emptyList());
    }

    public static ModeConfig parse(JSONObject json) {
        if (json == null) return disabled();

        String manual = json.optString("manualMode", "");
        if (manual.isEmpty() || "null".equals(manual)) manual = null;

        boolean scheduleEnabled = json.optBoolean("scheduleEnabled", false);

        List<Slot> slots = new ArrayList<>();
        JSONArray slotArray = json.optJSONArray("slots");
        if (slotArray != null) {
            for (int i = 0; i < slotArray.length(); i++) {
                JSONObject o = slotArray.optJSONObject(i);
                if (o == null) continue;
                int day = o.optInt("dayOfWeek", -1);
                int hour = o.optInt("hour", -1);
                if (day < 0 || day > 6 || hour < 0 || hour > 23) continue; // 非法格子直接丢
                slots.add(new Slot(day, hour));
            }
        }

        List<String> apps = new ArrayList<>();
        JSONArray appArray = json.optJSONArray("studyApps");
        if (appArray != null) {
            for (int i = 0; i < appArray.length(); i++) {
                String pkg = appArray.optString(i, "");
                if (!pkg.isEmpty()) apps.add(pkg);
            }
        }

        return new ModeConfig(manual, scheduleEnabled, slots, apps);
    }

    /** 序列化回 JSON 存本地（离线时用上一份）。 */
    public JSONObject toJson() {
        JSONObject o = new JSONObject();
        try {
            o.put("manualMode", manualMode == null ? JSONObject.NULL : manualMode);
            o.put("scheduleEnabled", scheduleEnabled);
            JSONArray slotArray = new JSONArray();
            for (Slot s : slots) {
                JSONObject so = new JSONObject();
                so.put("dayOfWeek", s.dayOfWeek);
                so.put("hour", s.hour);
                slotArray.put(so);
            }
            o.put("slots", slotArray);
            JSONArray appArray = new JSONArray();
            for (String a : studyApps) appArray.put(a);
            o.put("studyApps", appArray);
        } catch (Exception ignored) {
            // JSONObject.put 只在 key 为 null 时抛，这里的 key 全是常量
        }
        return o;
    }
}
