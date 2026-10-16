package com.balloondog.agent.capability;

import android.content.ComponentName;
import android.content.Context;
import android.content.pm.LauncherActivityInfo;
import android.content.pm.LauncherApps;
import android.content.pm.PackageManager;
import android.os.Process;
import android.os.UserHandle;

import com.balloondog.agent.data.EventLog;

import java.util.List;

/**
 * 隐藏桌面图标（契约 §9）。
 *
 * <p>做法是把「带 MAIN/LAUNCHER 的入口」单独做成一个 {@code activity-alias}
 * （{@code MainActivityLauncher}），要隐藏时把<b>这个 alias</b>禁用掉，
 * 而不是禁用 {@code MainActivity} 本身 —— 后者会把家长端的远程启动、
 * 锁定页跳转一并打死，那就成了「藏得连自己都进不去」。
 *
 * <p>禁用时用 {@link PackageManager#DONT_KILL_APP}：不改动正在运行的进程，
 * 避免刚设好的守卫（无障碍服务）因为一次配置刷新被系统顺带重启。
 *
 * <p><b>必须让家长知道怎么找回来</b>：图标隐藏后，桌面上与本机设置里都没有入口。
 * 本机入口是拨号暗码 {@code *#*#2887#*#*}（见 {@link SecretCodeReceiver}），
 * 另外两条兜底是家长端远程改配置与 adb（{@code pm enable .../MainActivityLauncher}）。
 * 设置页与家长端都要写明这一点，免得出现「家长自己也找不到、以为装丢了」。
 *
 * <p><b>没有设备所有者时，桌面上会留下一个「占位入口」。</b>AOSP 的
 * {@code LauncherAppsService#getLauncherActivities} 在「包里没有任何可启动的 Activity +
 * 包申请了权限 + 清单里有过默认启用的启动项」三条同时成立时，会<b>凭空造一个</b>启动项
 * （{@code getHiddenAppActivityInfo}），点开就跳到「设置 → 应用信息」。它在
 * {@code DevicePolicyManager.getDeviceOwnerComponentOnAnyUser() != null} 时会被跳过，
 * 所以<b>「隐藏完图标还在」本身就是这台设备没有设备所有者的证据</b>，不是隐藏失败。
 * 系统给的口子是全局设置 {@code show_hidden_icon_apps_enabled}（{@code adb shell settings
 * put global show_hidden_icon_apps_enabled 0}）；普通应用改不了它，所以这里只检测、只记日志。
 * 见 {@link #detectLauncherPlaceholder}。
 */
public final class IconHider {

    /** {@code AndroidManifest.xml} 里 activity-alias 的完整类名，必须与清单一致。 */
    public static final String LAUNCHER_ALIAS =
            "com.balloondog.agent.MainActivityLauncher";

    private IconHider() {
    }

    /** 按配置切换图标显隐；已经是目标状态时不重复写（避免无意义的组件状态变更）。 */
    public static void apply(Context context, boolean hide) {
        try {
            PackageManager manager = context.getPackageManager();
            ComponentName alias = new ComponentName(context.getPackageName(), LAUNCHER_ALIAS);
            int desired = hide
                    ? PackageManager.COMPONENT_ENABLED_STATE_DISABLED
                    : PackageManager.COMPONENT_ENABLED_STATE_ENABLED;
            if (manager.getComponentEnabledSetting(alias) != desired) {
                manager.setComponentEnabledSetting(alias, desired, PackageManager.DONT_KILL_APP);
                EventLog.success(hide
                        ? "桌面图标已隐藏（本机入口：拨号盘输入 " + SecretCodeReceiver.DIAL_CODE
                        + "；也可由家长端远程恢复）"
                        : "桌面图标已恢复显示");
            }
            // 已经是隐藏状态也要查一次：配置每 60 秒刷新一次，这里最多在结果变化时记一条。
            if (hide) reportPlaceholderIfDetected(context);
        } catch (Exception e) {
            // 少数 ROM 会拒绝改组件状态：如实记日志，不假装已经隐藏
            EventLog.warn("切换桌面图标显隐失败：" + e.getMessage());
        }
    }

    /** 上一次检测到的占位入口（用来避免每 60 秒刷一条同样的日志）。 */
    private static String reportedPlaceholder;

    /** 本次进程里是否已经记过一条检测结果（第一条永远记，方便排查「到底有没有查」）。 */
    private static boolean placeholderReportedOnce;

    /**
     * 隐藏之后系统是否仍在桌面上留了一个「占位入口」；有就记一条明确的日志。
     *
     * <p>进程内的第一条永远记（无论有没有占位入口，这样日志能自证检测跑过），
     * 之后只在结果变化时记，避免配置每 60 秒刷新一次把它刷屏。
     */
    private static void reportPlaceholderIfDetected(Context context) {
        String placeholder = detectLauncherPlaceholder(context);
        boolean changed = placeholder == null
                ? reportedPlaceholder != null
                : !placeholder.equals(reportedPlaceholder);
        if (placeholderReportedOnce && !changed) return;
        placeholderReportedOnce = true;
        reportedPlaceholder = placeholder;
        if (placeholder == null) {
            EventLog.info("桌面图标已隐藏，系统没有留下占位入口（设备所有者会跳过它）");
            return;
        }
        EventLog.warn("桌面图标已隐藏，但系统仍在桌面留了占位入口 " + placeholder
                + "（点开进「应用信息」）：这是没有「设备所有者」时的系统行为。"
                + "设为设备所有者，或用 adb 执行 settings put global show_hidden_icon_apps_enabled 0"
                + "（改完要重启桌面）才会消失");
    }

    /**
     * 桌面上是否还存在一个<b>不属于我们</b>的启动项（= 系统的「隐藏应用」占位入口）。
     *
     * <p>用 {@code LauncherApps#getActivityList} 问的就是桌面看到的那份清单，
     * 所以它比 {@code queryIntentActivities} 更贴近孩子实际看到的东西。
     * 这是自己查自己，正常不会抛 {@code SecurityException}；少数 ROM 上抛了就当作没检测到，
     * 不影响隐藏本身。
     *
     * @return 占位入口的组件名；没有则返回 {@code null}
     */
    public static String detectLauncherPlaceholder(Context context) {
        try {
            LauncherApps launcherApps =
                    (LauncherApps) context.getSystemService(Context.LAUNCHER_APPS_SERVICE);
            if (launcherApps == null) return null;
            UserHandle user = Process.myUserHandle();
            List<LauncherActivityInfo> activities =
                    launcherApps.getActivityList(context.getPackageName(), user);
            if (activities == null || activities.isEmpty()) return null;
            for (LauncherActivityInfo activity : activities) {
                if (activity == null) continue;
                ComponentName component = activity.getComponentName();
                if (component == null) continue;
                // 我们自己那个 alias 不算：它被禁用时本来就不该出现在这个清单里，
                // 一旦出现说明隐藏没生效，走的是另一条日志。
                if (LAUNCHER_ALIAS.equals(component.getClassName())) continue;
                return component.flattenToShortString();
            }
        } catch (Exception e) {
            return null;
        }
        return null;
    }

    /** 当前图标是否处于隐藏状态（设置页据此给出「怎么找回来」的提示）。 */
    public static boolean isHidden(Context context) {
        try {
            ComponentName alias = new ComponentName(context.getPackageName(), LAUNCHER_ALIAS);
            int state = context.getPackageManager().getComponentEnabledSetting(alias);
            return state == PackageManager.COMPONENT_ENABLED_STATE_DISABLED
                    || state == PackageManager.COMPONENT_ENABLED_STATE_DISABLED_USER;
        } catch (Exception e) {
            return false;
        }
    }
}
