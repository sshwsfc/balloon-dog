package com.balloondog.agent.capability;

import android.app.admin.DevicePolicyManager;
import android.content.Context;
import android.os.Build;
import android.os.UserManager;

import com.balloondog.agent.data.EventLog;

import java.util.ArrayList;
import java.util.List;

/**
 * 设备所有者级「防卸载 / 防强停 / 防恢复出厂」加固。
 *
 * <p>对应需求 1。必须先讲清楚一件事：<b>在不是设备所有者的设备上，这一整套都做不到。</b>
 * 孩子可以在「设置 → 应用 → 强行停止」里一键停掉本应用，而应用一旦进入 stopped 状态，
 * 任何广播、JobScheduler、AlarmManager 都无法再把它唤醒 —— 双进程互相拉起也一样，
 * 因为强停会杀掉该应用<b>所有</b>进程。这是 Android 的设计，不是实现缺陷。
 * 唯一可靠的解法是设备所有者 + 下面这些限制项。
 *
 * <p>本类里每一项都做了 try/catch：不同厂商 ROM 对部分限制项的实现并不完整，
 * 一个失败不应该让整个加固流程中断。{@link #status(Context)} 会如实回报哪些真正生效了。
 */
public final class OwnerHardening {

    private OwnerHardening() {
    }

    /**
     * 限制项清单。刻意把「最影响家长的」排前面，便于排查。
     *
     * <p>注意 {@code DISALLOW_FACTORY_RESET} 同时也会挡住家长自己在设置里恢复出厂 ——
     * 家长需要先在应用里关掉「最强防护」才能恢复出厂。这是有意的取舍：
     * 不挡这一项，孩子一次恢复出厂就能把管控全部抹掉。
     */
    private static final String[] RESTRICTIONS = {
            UserManager.DISALLOW_APPS_CONTROL,      // 禁止 强行停止 / 清除数据 / 卸载 / 停用应用
            UserManager.DISALLOW_UNINSTALL_APPS,    // 禁止卸载任何应用
            UserManager.DISALLOW_FACTORY_RESET,     // 禁止恢复出厂设置
            UserManager.DISALLOW_SAFE_BOOT,         // 禁止进入安全模式（安全模式下管控全失效）
            UserManager.DISALLOW_ADD_USER,          // 禁止新建用户/访客绕过管控
            UserManager.DISALLOW_CONFIG_DATE_TIME,  // 禁止改系统时间（否则改时间就能绕过作息表）
    };

    /** 人话名称，用于界面展示与日志。 */
    private static String label(String restriction) {
        switch (restriction) {
            case UserManager.DISALLOW_APPS_CONTROL:
                return "禁止强行停止 / 清除数据";
            case UserManager.DISALLOW_UNINSTALL_APPS:
                return "禁止卸载应用";
            case UserManager.DISALLOW_FACTORY_RESET:
                return "禁止恢复出厂设置";
            case UserManager.DISALLOW_SAFE_BOOT:
                return "禁止安全模式";
            case UserManager.DISALLOW_ADD_USER:
                return "禁止新建用户/访客";
            case UserManager.DISALLOW_CONFIG_DATE_TIME:
                return "禁止修改系统时间";
            default:
                return restriction;
        }
    }

    /**
     * 应用加固。
     *
     * @return 实际生效的限制项数量；0 表示没有设备所有者权限
     */
    public static int apply(Context context) {
        if (!LockController.isDeviceOwner(context)) return 0;
        DevicePolicyManager dpm =
                (DevicePolicyManager) context.getSystemService(Context.DEVICE_POLICY_SERVICE);
        if (dpm == null) return 0;

        int ok = 0;

        // 1) 禁止卸载本应用（这是最直接的一条）
        try {
            dpm.setUninstallBlocked(LockController.adminComponent(context),
                    context.getPackageName(), true);
            ok++;
        } catch (SecurityException e) {
            EventLog.warn("禁止卸载失败：" + e.getMessage());
        }

        // 2) 逐项添加用户限制
        for (String restriction : RESTRICTIONS) {
            try {
                dpm.addUserRestriction(LockController.adminComponent(context), restriction);
                ok++;
            } catch (SecurityException | IllegalArgumentException e) {
                // 部分 ROM 不支持个别限制项，跳过即可
                EventLog.warn("限制项 " + label(restriction) + " 未能生效：" + e.getMessage());
            }
        }

        EventLog.success("最强防护已启用（" + ok + " 项生效）");
        return ok;
    }

    /** 解除加固。家长在应用内关闭「最强防护」时调用。 */
    public static void release(Context context) {
        if (!LockController.isDeviceOwner(context)) return;
        DevicePolicyManager dpm =
                (DevicePolicyManager) context.getSystemService(Context.DEVICE_POLICY_SERVICE);
        if (dpm == null) return;

        try {
            dpm.setUninstallBlocked(LockController.adminComponent(context),
                    context.getPackageName(), false);
        } catch (SecurityException e) {
            EventLog.warn("解除禁止卸载失败：" + e.getMessage());
        }
        for (String restriction : RESTRICTIONS) {
            try {
                dpm.clearUserRestriction(LockController.adminComponent(context), restriction);
            } catch (SecurityException | IllegalArgumentException ignored) {
                // 未生效过的限制项清除时也会抛，忽略
            }
        }
        EventLog.warn("最强防护已解除");
    }

    /** 逐项回报当前生效状态，界面直接展示，避免「以为开了其实没开」。 */
    public static List<String> status(Context context) {
        List<String> lines = new ArrayList<>();
        if (!LockController.isDeviceOwner(context)) {
            lines.add("未获得设备所有者权限：孩子可以在系统设置里「强行停止」或卸载本应用");
            return lines;
        }
        DevicePolicyManager dpm =
                (DevicePolicyManager) context.getSystemService(Context.DEVICE_POLICY_SERVICE);
        if (dpm == null) {
            lines.add("无法读取设备策略服务");
            return lines;
        }

        try {
            boolean blocked = dpm.isUninstallBlocked(LockController.adminComponent(context),
                    context.getPackageName());
            lines.add("禁止卸载：" + (blocked ? "已生效" : "未生效"));
        } catch (Exception e) {
            lines.add("禁止卸载：读取失败");
        }

        for (String restriction : RESTRICTIONS) {
            boolean active;
            try {
                active = dpm.getUserRestrictions(LockController.adminComponent(context))
                        .getBoolean(restriction, false);
            } catch (Exception e) {
                active = false;
            }
            lines.add(label(restriction) + "：" + (active ? "已生效" : "未生效"));
        }

        // 应用审核的安装限制是动态项（家长批准期间会临时放开），单独一行如实展示
        try {
            boolean installBlocked = dpm.getUserRestrictions(LockController.adminComponent(context))
                    .getBoolean(UserManager.DISALLOW_INSTALL_APPS, false);
            lines.add("应用审核（禁止安装）：" + (installBlocked ? "已生效" : "未生效"));
        } catch (Exception e) {
            lines.add("应用审核（禁止安装）：读取失败");
        }
        return lines;
    }

    /** 是否有任何一项加固生效（用于界面上的总开关状态）。 */
    public static boolean isActive(Context context) {
        if (!LockController.isDeviceOwner(context)) return false;
        DevicePolicyManager dpm =
                (DevicePolicyManager) context.getSystemService(Context.DEVICE_POLICY_SERVICE);
        if (dpm == null) return false;
        try {
            if (dpm.isUninstallBlocked(LockController.adminComponent(context), context.getPackageName())) {
                return true;
            }
            return dpm.getUserRestrictions(LockController.adminComponent(context))
                    .getBoolean(UserManager.DISALLOW_APPS_CONTROL, false);
        } catch (Exception e) {
            return false;
        }
    }

    /** 是否支持运行时的用户限制 API（API 21+ 一直有，这里留个位置便于将来扩展）。 */
    public static boolean isSupported() {
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP;
    }

    // ---------------- 应用审核：安装限制随批准窗口开合（契约 §3） ----------------

    /** 上一次同步给日志用的状态，避免配置每 60 秒刷新一次就刷一条重复日志。 */
    private static volatile Boolean lastInstallRestricted = null;

    /**
     * 按「应用审核」特性同步「禁止安装应用」限制。
     *
     * <p>为什么要单开一个方法而不是塞进 {@link #RESTRICTIONS}：这一项是<b>动态</b>的 ——
     * 家长批准安装后服务端会把 {@code installApprovalUntil} 往后推 30 分钟，
     * 这期间必须放开；窗口一过又要自动收紧。塞进静态清单就没法开合。
     *
     * <p>{@code DISALLOW_INSTALL_APPS} 同样只有设备所有者能设置：非设备所有者时
     * 这里只如实记一条日志（一次状态变化记一次），不假装已生效。
     *
     * @param auditEnabled 家长是否开启应用审核（appAudit 特性）
     * @param windowOpen   是否处于家长刚批准后的放行窗口
     * @return true 表示当前确实处于「禁止安装」状态
     */
    public static boolean syncInstallRestriction(Context context, boolean auditEnabled, boolean windowOpen) {
        boolean shouldBlock = auditEnabled && !windowOpen;
        if (!LockController.isDeviceOwner(context)) {
            if (lastInstallRestricted == null || lastInstallRestricted != shouldBlock) {
                lastInstallRestricted = shouldBlock;
                EventLog.warn(auditEnabled
                        ? "应用审核已开启，但本机不是设备所有者，无法阻止安装（孩子仍可自行安装应用）"
                        : "应用审核未开启：不限制安装");
            }
            return false;
        }
        DevicePolicyManager dpm =
                (DevicePolicyManager) context.getSystemService(Context.DEVICE_POLICY_SERVICE);
        if (dpm == null) return false;

        boolean currently;
        try {
            currently = dpm.getUserRestrictions(LockController.adminComponent(context))
                    .getBoolean(UserManager.DISALLOW_INSTALL_APPS, false);
        } catch (Exception e) {
            currently = false;
        }

        try {
            if (shouldBlock) {
                dpm.addUserRestriction(LockController.adminComponent(context),
                        UserManager.DISALLOW_INSTALL_APPS);
            } else {
                dpm.clearUserRestriction(LockController.adminComponent(context),
                        UserManager.DISALLOW_INSTALL_APPS);
            }
        } catch (Exception e) {
            EventLog.warn("同步「禁止安装应用」失败：" + e.getMessage());
            return currently;
        }

        if (currently != shouldBlock || lastInstallRestricted == null
                || lastInstallRestricted != shouldBlock) {
            lastInstallRestricted = shouldBlock;
            if (shouldBlock) {
                EventLog.info("应用审核：已禁止安装新应用（家长批准后会临时放开 30 分钟）");
            } else if (windowOpen) {
                EventLog.success("家长已批准安装：临时放开安装限制");
            } else {
                EventLog.info("应用审核：已解除安装限制");
            }
        }
        return shouldBlock;
    }
}
