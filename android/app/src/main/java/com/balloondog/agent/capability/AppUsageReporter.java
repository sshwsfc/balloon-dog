package com.balloondog.agent.capability;

import android.content.Context;
import android.os.SystemClock;

import androidx.annotation.Nullable;

import com.balloondog.agent.data.AgentStore;
import com.balloondog.agent.data.EventLog;
import com.balloondog.agent.model.AppLimitRule;
import com.balloondog.agent.net.AgentApi;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;

/**
 * 应用使用时长：本地采样 + 上报（契约 §4）。
 *
 * <p>拆成「采样」与「上报」两步，是为了配合拦截链路：无障碍服务在每一次窗口切换时
 * 都要问「这个应用今天用超了吗」，而 {@code UsageStatsManager} 查询是有成本的，
 * 绝不能在 {@code onAccessibilityEvent} 里同步调用。所以采样在后台周期做，
 * 结果落进 {@link AgentStore}，拦截时只读缓存。
 *
 * <p><b>只采集「家长设了限额的应用」</b>：把全机每个应用的使用时长都送到服务端，
 * 既没有用处，又多一份孩子的行为画像。这是刻意做的隐私取舍，README 里同样写明。
 *
 * <p>没拿到「使用情况访问」权限时，{@link AppUsageTracker#queryToday} 会记日志并返回空表，
 * 这里就如实把「未授权」写进日志并跳过 —— 上报一份空数据、让家长以为「孩子没用手机」，
 * 比不报还糟。
 */
public final class AppUsageReporter {

    private AppUsageReporter() {
    }

    /**
     * 采样一次今日用量并写入本地缓存。
     *
     * @return 采样到的用量（可能为空表 —— 没权限或没有限额应用）
     */
    public static Map<String, Integer> refresh(Context context, AgentStore store) {
        List<AppLimitRule> rules = store.getAppLimitRules();
        if (rules.isEmpty()) {
            store.setAppUsageToday(Collections.<String, Integer>emptyMap());
            return Collections.emptyMap();
        }
        List<String> packages = new ArrayList<>(rules.size());
        for (AppLimitRule rule : rules) {
            if (!packages.contains(rule.packageName)) packages.add(rule.packageName);
        }

        if (!AppUsageTracker.hasPermission(context)) {
            // 不伪造：缓存清空，拦截判定拿不到数据就不会误拦，界面上也会提示去授权
            store.setAppUsageToday(Collections.<String, Integer>emptyMap());
            return Collections.emptyMap();
        }

        Map<String, Integer> usage = AppUsageTracker.queryToday(context, packages);
        store.setAppUsageToday(usage);
        return usage;
    }

    /**
     * 把本地缓存的用量上报上去（服务端按当日全量替换）。
     *
     * @return true 表示确实发出了一次上报；false 表示没有可报的内容或上报失败
     */
    public static boolean report(AgentStore store, AgentApi api) {
        Map<String, Integer> usage = store.getAppUsageToday();
        if (usage.isEmpty()) {
            // 服务端对空数组返回 422（防止误调用清空家长可见数据），所以本地就直接跳过
            return false;
        }
        List<AppLimitRule> rules = store.getAppLimitRules();
        JSONArray array = new JSONArray();
        for (AppLimitRule rule : rules) {
            Integer seconds = usage.get(rule.packageName);
            if (seconds == null || seconds <= 0) continue;
            try {
                JSONObject item = new JSONObject();
                item.put("packageName", rule.packageName);
                item.put("appName", rule.displayName());
                item.put("seconds", seconds);
                array.put(item);
            } catch (Exception ignored) {
                // 单条失败就少报一条，不影响其余
            }
        }
        if (array.length() == 0) return false;

        try {
            api.reportAppUsage(store.getBaseUrl(), array);
            store.setAppUsageReportedAt(SystemClock.elapsedRealtime());
            EventLog.info("应用使用时长已上报：" + array.length() + " 个应用");
            return true;
        } catch (Exception e) {
            EventLog.warn("应用使用时长上报失败：" + e.getMessage());
            return false;
        }
    }

    /** 供拦截判定使用的缓存读数（从不阻塞、从不查询系统）。 */
    @Nullable
    public static Integer usedSeconds(AgentStore store, String packageName) {
        return store.getAppUsageToday().get(packageName);
    }
}
