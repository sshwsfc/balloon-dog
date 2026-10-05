package com.balloondog.agent.capability;

import android.content.ComponentName;
import android.content.Context;
import android.content.pm.PackageManager;

import com.balloondog.agent.data.EventLog;

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
 * <p><b>必须让家长知道怎么找回来</b>：图标隐藏后，设备本机没有任何入口
 * （只能靠 adb 或家长端远程改配置）。设置页与家长端都要写明这一点，
 * 免得出现「家长自己也找不到、以为装丢了」。
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
            if (manager.getComponentEnabledSetting(alias) == desired) return;
            manager.setComponentEnabledSetting(alias, desired, PackageManager.DONT_KILL_APP);
            EventLog.success(hide
                    ? "桌面图标已隐藏（可通过家长端远程恢复，或 adb 重新启用）"
                    : "桌面图标已恢复显示");
        } catch (Exception e) {
            // 少数 ROM 会拒绝改组件状态：如实记日志，不假装已经隐藏
            EventLog.warn("切换桌面图标显隐失败：" + e.getMessage());
        }
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
