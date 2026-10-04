package com.balloondog.agent.capability;

import android.content.Context;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;

import com.balloondog.agent.data.EventLog;

import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * 设备上装了哪些应用 —— 家长端「选择应用 / 功能管控」的数据来源，
 * 也是学习模式拦截时的**权威判据**。
 *
 * <h3>为什么拦截只针对「可启动应用」</h3>
 * 学习模式要拦的是「孩子打开一个应用去玩」，而不是系统组件。
 * 如果按包名黑名单去拦，一旦把 `com.android.systemui`、输入法、桌面拦掉，
 * 手机就直接不能用了。所以这里的判据是：
 * **只拦「有桌面入口、普通应用能启动」的包**，其余一律放行。
 * 这是安全的一侧 —— 宁可漏拦一个奇怪的系统组件，也不能把手机变砖。
 */
public final class AppInventory {

    /** 缓存的可启动应用包名。PackageManager 查询不便宜，缓存起来逐事件复用。 */
    private volatile Set<String> launchable = Collections.emptySet();
    /** 桌面（Home）包名。桌面本身是可启动应用，但绝不能拦。 */
    private volatile Set<String> homePackages = Collections.emptySet();
    private volatile long lastScanAt;

    /** 扫描间隔：应用列表变化不频繁，5 分钟一次足够，也避免频繁 binder 调用。 */
    private static final long SCAN_INTERVAL_MS = 5 * 60 * 1000L;

    /** 一条应用记录，用于上报服务端。 */
    public static final class AppEntry {
        public final String packageName;
        public final String appName;
        public final boolean isSystem;
        public final boolean isLaunchable;

        AppEntry(String packageName, String appName, boolean isSystem, boolean isLaunchable) {
            this.packageName = packageName;
            this.appName = appName;
            this.isSystem = isSystem;
            this.isLaunchable = isLaunchable;
        }
    }

    /** 需要时重新扫描（超过 {@link #SCAN_INTERVAL_MS} 才真的扫）。 */
    public synchronized void ensureScanned(Context context) {
        long now = android.os.SystemClock.elapsedRealtime();
        if (!launchable.isEmpty() && now - lastScanAt < SCAN_INTERVAL_MS) return;
        scan(context);
    }

    /** 强制重新扫描。 */
    public synchronized void scan(Context context) {
        Set<String> found = new HashSet<>();
        Set<String> homes = new HashSet<>();
        try {
            PackageManager pm = context.getPackageManager();

            Intent launcher = new Intent(Intent.ACTION_MAIN);
            launcher.addCategory(Intent.CATEGORY_LAUNCHER);
            List<ResolveInfo> activities = pm.queryIntentActivities(launcher, 0);
            if (activities != null) {
                for (ResolveInfo info : activities) {
                    if (info.activityInfo != null && info.activityInfo.packageName != null) {
                        found.add(info.activityInfo.packageName);
                    }
                }
            }

            Intent home = new Intent(Intent.ACTION_MAIN);
            home.addCategory(Intent.CATEGORY_HOME);
            List<ResolveInfo> homeApps = pm.queryIntentActivities(home, 0);
            if (homeApps != null) {
                for (ResolveInfo info : homeApps) {
                    if (info.activityInfo != null && info.activityInfo.packageName != null) {
                        homes.add(info.activityInfo.packageName);
                    }
                }
            }

            launchable = Collections.unmodifiableSet(found);
            homePackages = Collections.unmodifiableSet(homes);
            lastScanAt = android.os.SystemClock.elapsedRealtime();
        } catch (Exception e) {
            // 扫描失败不能把拦截逻辑带崩：保守地保持上一次结果
            EventLog.warn("扫描已安装应用失败：" + e.getMessage());
        }
    }

    public boolean isLaunchable(String packageName) {
        return launchable.contains(packageName);
    }

    public boolean isHome(String packageName) {
        return homePackages.contains(packageName);
    }

    /** 完整清单，用于上报服务端（含系统应用，家长端默认过滤掉）。 */
    public List<AppEntry> snapshot(Context context) {
        List<AppEntry> out = new ArrayList<>();
        try {
            PackageManager pm = context.getPackageManager();
            Set<String> seen = new HashSet<>();

            // 1) 可启动应用：家长最关心的那批
            Intent launcher = new Intent(Intent.ACTION_MAIN);
            launcher.addCategory(Intent.CATEGORY_LAUNCHER);
            List<ResolveInfo> activities = pm.queryIntentActivities(launcher, 0);
            if (activities != null) {
                for (ResolveInfo info : activities) {
                    if (info.activityInfo == null || info.activityInfo.packageName == null) continue;
                    String pkg = info.activityInfo.packageName;
                    if (!seen.add(pkg)) continue;
                    CharSequence label = info.loadLabel(pm);
                    out.add(new AppEntry(pkg, label == null ? pkg : label.toString(),
                            isSystem(pm, pkg), true));
                }
            }

            // 2) 不可启动但已安装的应用（系统组件、服务类应用）。数量可能很多，
            //    但仍然上报：家长端排查「某个应用怎么没出现在列表里」时需要看到它们。
            for (ApplicationInfo info : pm.getInstalledApplications(0)) {
                if (info == null || info.packageName == null) continue;
                if (!seen.add(info.packageName)) continue;
                CharSequence label = info.loadLabel(pm);
                out.add(new AppEntry(info.packageName, label == null ? info.packageName : label.toString(),
                        isSystem(pm, info.packageName), false));
            }
        } catch (Exception e) {
            EventLog.warn("收集应用清单失败：" + e.getMessage());
        }
        return out;
    }

    private static boolean isSystem(PackageManager pm, String pkg) {
        try {
            ApplicationInfo info = pm.getApplicationInfo(pkg, 0);
            return (info.flags & ApplicationInfo.FLAG_SYSTEM) != 0;
        } catch (PackageManager.NameNotFoundException e) {
            return false;
        }
    }
}
