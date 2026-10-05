package com.balloondog.agent.model;

import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * 一条「应用限时」规则（家长给某个应用定的每日分钟数）。
 *
 * <p>为什么单独建一个模型，而不是继续用 {@code AgentStore.KEY_APP_LIMITS} 那个
 * {@code 抖音=60,王者荣耀=30} 字符串：超限判定必须按 <b>包名</b> 做，
 * 而那份展示串里只有应用名 —— 同名应用、改名应用都会判错。
 * 展示串保留不动（通知栏一直在用），这里另存一份结构化规则。
 */
public final class AppLimitRule {

    /** logcat 标签，与 {@code data.EventLog.TAG} 保持同一个字符串便于过滤。 */
    public static final String TAG = "BalloonDog";

    /**
     * 上一次因丢项打过日志的「签名」。
     *
     * <p>{@code parseAll} 会被 {@code AgentStore.getAppLimitRules()} 在无障碍事件热路径上
     * 反复调用，坏数据如果每次都打日志会把 logcat 刷爆。只在丢的东西变化时打一次。
     */
    private static volatile String lastDropSignature = "";

    public final String packageName;
    public final String appName;
    public final int dailyLimitMinutes;

    private AppLimitRule(String packageName, String appName, int dailyLimitMinutes) {
        this.packageName = packageName;
        this.appName = appName;
        this.dailyLimitMinutes = dailyLimitMinutes;
    }

    /** 直接构造（给 crosstest 里的纯逻辑验证用，那里没有真正的 JSON 解析器）。 */
    public static AppLimitRule of(String packageName, String appName, int dailyLimitMinutes) {
        return new AppLimitRule(packageName, appName, dailyLimitMinutes);
    }

    /** 解析服务端 {@code appLimits} 数组；没有 packageName 或限额 <= 0 的项直接丢弃（记日志说明原因）。 */
    public static List<AppLimitRule> parseAll(JSONArray array) {
        List<AppLimitRule> out = new ArrayList<>();
        if (array == null) return out;
        for (int i = 0; i < array.length(); i++) {
            JSONObject item = array.optJSONObject(i);
            if (item == null) continue;
            String pkg = item.optString("packageName", "");
            int minutes = item.optInt("dailyLimitMinutes", 0);
            if (pkg.isEmpty() || minutes <= 0) {
                String sig = pkg + "/" + minutes;
                if (!sig.equals(lastDropSignature)) {
                    lastDropSignature = sig;
                    Log.w(TAG, "读取应用限额时丢弃一条：packageName=\"" + pkg + "\" dailyLimitMinutes="
                            + minutes + "。设备端按包名拦截，没有包名的规则永远不会生效"
                            + "（这是防脏数据的兜底，正确修法是让服务端保证下发非空包名）");
                }
                continue;
            }
            out.add(new AppLimitRule(pkg, item.optString("appName", pkg), minutes));
        }
        return out;
    }

    public static List<AppLimitRule> parseJson(String json) {
        if (json == null || json.isEmpty()) return Collections.emptyList();
        try {
            return parseAll(new JSONArray(json));
        } catch (Exception e) {
            // 坏数据按「没有限额」处理：漏拦一次比让限时逻辑整体崩掉好
            return Collections.emptyList();
        }
    }

    public static String toJson(List<AppLimitRule> rules) {
        JSONArray array = new JSONArray();
        if (rules == null) return array.toString();
        for (AppLimitRule rule : rules) {
            JSONObject item = new JSONObject();
            try {
                item.put("packageName", rule.packageName);
                item.put("appName", rule.appName);
                item.put("dailyLimitMinutes", rule.dailyLimitMinutes);
            } catch (Exception ignored) {
                // 全部是原生类型，实际不会抛
            }
            array.put(item);
        }
        return array.toString();
    }

    /** 事件文案里用的名字，空名回落到包名。 */
    public String displayName() {
        return appName == null || appName.isEmpty() ? packageName : appName;
    }
}
