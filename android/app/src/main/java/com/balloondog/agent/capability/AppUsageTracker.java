package com.balloondog.agent.capability;

import android.app.AppOpsManager;
import android.app.usage.UsageStats;
import android.app.usage.UsageStatsManager;
import android.content.Context;
import android.content.Intent;
import android.os.Process;
import android.provider.Settings;

import androidx.annotation.Nullable;

import com.balloondog.agent.data.EventLog;

import java.util.Calendar;
import java.util.Collection;
import java.util.HashMap;
import java.util.Map;

/**
 * 读取「今日各应用前台使用时长」（契约 §4 —— 应用限时）。
 *
 * <p>依赖 {@code android.permission.PACKAGE_USAGE_STATS}：这是<b>受限权限</b>，
 * 声明在清单里也不会自动授予，必须在系统设置里由用户手动打开
 * （{@link #openSettings(Context)}）。没授权时 {@link #queryToday} 返回空表并记一条日志 ——
 * <b>刻意不做任何「假装已生效」的兜底</b>：与其上报一堆 0 让家长以为限时在跑，
 * 不如在日志里说清楚「缺少使用情况访问权限」。
 *
 * <p>注意这不是实时查询：用量在设备端按「今日」整体刷新（见 AgentService 的周期任务），
 * 判定路径只读本地缓存，不在无障碍回调里做耗时查询。
 */
public final class AppUsageTracker {

    private AppUsageTracker() {
    }

    /**
     * 是否已获得「使用情况访问」权限。
     *
     * <p>用 {@link AppOpsManager} 而不是 {@code checkSelfPermission}：
     * PACKAGE_USAGE_STATS 是 appop 型权限，{@code checkSelfPermission} 对它不可靠
     * （声明过就直接返回 GRANTED），只有 AppOps 才能反映用户真实的开关状态。
     */
    public static boolean hasPermission(Context context) {
        AppOpsManager ops = (AppOpsManager) context.getSystemService(Context.APP_OPS_SERVICE);
        if (ops == null) return false;
        try {
            int mode = ops.checkOpNoThrow(AppOpsManager.OPSTR_GET_USAGE_STATS,
                    Process.myUid(), context.getPackageName());
            if (mode == AppOpsManager.MODE_ALLOWED) return true;
            // MODE_DEFAULT 表示用户还没做过选择：对 appop 型权限而言就是没授权
            // （真授权过一定变成 MODE_ALLOWED），所以这里一并返回 false。
        } catch (Exception e) {
            EventLog.warn("查询使用情况访问权限失败：" + e.getMessage());
        }
        return false;
    }

    /** 打开系统的「使用情况访问」设置页，让用户手动授权。 */
    public static void openSettings(Context context) {
        try {
            Intent intent = new Intent(Settings.ACTION_USAGE_ACCESS_SETTINGS);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            context.startActivity(intent);
        } catch (Exception e) {
            EventLog.warn("无法打开使用情况访问设置页：" + e.getMessage());
        }
    }

    /**
     * 查询今日各应用前台秒数。
     *
     * <p>只返回 {@code interestedPackages} 里的包：本功能只需要知道「设了限额的那几个应用」
     * 用了多久，把全机使用记录都读出来既没有用处、也没有必要（刻意的隐私取舍，
     * 已写进 android/README.md）。
     *
     * <p>返回空表有两种含义：没有权限、或今天确实谁都没用 —— 调用方必须靠
     * {@link #hasPermission(Context)} 区分，不要把「查不到」当成「没超时」。
     */
    public static Map<String, Integer> queryToday(Context context, Collection<String> interestedPackages) {
        Map<String, Integer> out = new HashMap<>();
        if (interestedPackages == null || interestedPackages.isEmpty()) return out;
        if (!hasPermission(context)) {
            EventLog.warn("缺少「使用情况访问」权限，无法统计逐应用用量（应用限时不会生效）");
            return out;
        }

        UsageStatsManager manager =
                (UsageStatsManager) context.getSystemService(Context.USAGE_STATS_SERVICE);
        if (manager == null) {
            EventLog.warn("本机没有 UsageStatsManager，无法统计逐应用用量");
            return out;
        }

        long now = System.currentTimeMillis();
        long startOfDay = startOfToday();
        java.util.List<UsageStats> stats;
        try {
            stats = manager.queryUsageStats(UsageStatsManager.INTERVAL_DAILY, startOfDay, now);
        } catch (Exception e) {
            EventLog.warn("查询使用情况失败：" + e.getMessage());
            return out;
        }
        if (stats == null) return out;

        for (UsageStats stat : stats) {
            if (stat == null) continue;
            String pkg = stat.getPackageName();
            if (pkg == null || !interestedPackages.contains(pkg)) continue;
            long millis = stat.getTotalTimeInForeground();
            if (millis <= 0) continue;
            int seconds = (int) Math.min(Integer.MAX_VALUE, millis / 1000L);
            Integer previous = out.get(pkg);
            out.put(pkg, previous == null ? seconds : Math.max(previous, seconds));
        }
        return out;
    }

    /** 今日 0 点（本地时区）。UsageStats 的日桶边界与本地零点一致，这里保持同一口径。 */
    public static long startOfToday() {
        Calendar calendar = Calendar.getInstance();
        calendar.set(Calendar.HOUR_OF_DAY, 0);
        calendar.set(Calendar.MINUTE, 0);
        calendar.set(Calendar.SECOND, 0);
        calendar.set(Calendar.MILLISECOND, 0);
        return calendar.getTimeInMillis();
    }

    /** 既没有权限、也没有规则时，调用方可以用它做「无事可做」的早退。 */
    public static boolean hasAnythingToTrack(@Nullable Collection<String> interestedPackages) {
        return interestedPackages != null && !interestedPackages.isEmpty();
    }
}
