package com.balloondog.agent.capability;

import android.app.Activity;
import android.app.ActivityManager;
import android.app.admin.DevicePolicyManager;
import android.content.Context;
import android.os.Build;

import com.balloondog.agent.data.EventLog;

/**
 * Lock Task（kiosk）控制。
 *
 * <p>这是需求 2「锁屏不能被随便绕过」的<b>真正答案</b>：单纯的全屏悬浮窗挡不住 Home 键、
 * 最近任务和通知栏，而 Lock Task 能把设备钉在我们的锁定页上，并把这几条路全部关掉。
 *
 * <p>两个前提缺一不可：
 * <ol>
 *   <li>必须由<b>设备所有者</b>先调用 {@code setLockTaskPackages} 把自己加入白名单；</li>
 *   <li>锁定页 Activity 在进入前台后调用 {@code startLockTask()}。</li>
 * </ol>
 * 少了第 1 步，{@code startLockTask()} 只会进入「屏幕固定」（pinning）——
 * 孩子长按返回键就能退出，等于没锁。这一点是本类里最容易踩的坑，所以
 * {@link #enter(Activity)} 会如实报告当前是否真的进了 kiosk。
 *
 * <p>参考：<a href="https://developer.android.google.cn/work/dpc/dedicated-devices/lock-task-mode">
 * Android 官方 Lock task mode 文档</a>。
 */
public final class KioskController {

    private KioskController() {
    }

    /**
     * 把本应用加入 Lock Task 白名单，并把允许的特性关到最少。
     *
     * <p>{@code setLockTaskFeatures(0)} 等于在锁定期间禁用：
     * Home、最近任务、通知栏、全局操作（电源菜单）、锁屏界面、系统信息。
     * 只保留我们自己的锁定页。
     *
     * @return true 表示设置成功（即确实具备设备所有者权限）
     */
    public static boolean prepare(Context context) {
        if (!LockController.isDeviceOwner(context)) return false;
        DevicePolicyManager dpm =
                (DevicePolicyManager) context.getSystemService(Context.DEVICE_POLICY_SERVICE);
        if (dpm == null) return false;

        try {
            dpm.setLockTaskPackages(LockController.adminComponent(context),
                    new String[]{context.getPackageName()});
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                // LOCK_TASK_FEATURE_NONE = 0：锁定期间什么都不给
                dpm.setLockTaskFeatures(LockController.adminComponent(context), 0);
            }
            return true;
        } catch (SecurityException e) {
            EventLog.error("配置 Lock Task 失败：" + e.getMessage());
            return false;
        }
    }

    /** 撤销 Lock Task 白名单（解除管控 / 卸载前调用）。 */
    public static void release(Context context) {
        if (!LockController.isDeviceOwner(context)) return;
        DevicePolicyManager dpm =
                (DevicePolicyManager) context.getSystemService(Context.DEVICE_POLICY_SERVICE);
        if (dpm == null) return;
        try {
            dpm.setLockTaskPackages(LockController.adminComponent(context), new String[0]);
        } catch (SecurityException e) {
            EventLog.warn("撤销 Lock Task 白名单失败：" + e.getMessage());
        }
    }

    /**
     * 让锁定页进入 kiosk。
     *
     * @return true 表示已进入「无人可退出的」Lock Task；
     *         false 表示只进了屏幕固定（用户可退出），调用方应据此提示家长能力不足
     */
    public static boolean enter(Activity activity) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.LOLLIPOP) return false;
        try {
            activity.startLockTask();
        } catch (IllegalStateException | SecurityException e) {
            EventLog.error("进入 Lock Task 失败：" + e.getMessage());
            return false;
        }
        int state = lockTaskState(activity);
        boolean locked = state == ActivityManager.LOCK_TASK_MODE_LOCKED;
        if (!locked) {
            // 只有设备所有者白名单才会是 LOCKED；否则是 PINNED，孩子长按返回即可退出
            EventLog.warn("进入的是「屏幕固定」而不是真正的 Lock Task —— "
                    + "需要把本应用设为设备所有者才能锁死");
        }
        return locked;
    }

    /** 退出 kiosk。远程解锁 / 家长撤销锁定时调用。 */
    public static void exit(Activity activity) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.LOLLIPOP) return;
        try {
            activity.stopLockTask();
        } catch (IllegalStateException | SecurityException e) {
            EventLog.warn("退出 Lock Task 失败：" + e.getMessage());
        }
    }

    /** 当前 Lock Task 状态：NONE / PINNED / LOCKED。 */
    public static int lockTaskState(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.LOLLIPOP) return ActivityManager.LOCK_TASK_MODE_NONE;
        ActivityManager am = (ActivityManager) context.getSystemService(Context.ACTIVITY_SERVICE);
        return am == null ? ActivityManager.LOCK_TASK_MODE_NONE : am.getLockTaskModeState();
    }

    public static boolean isLocked(Context context) {
        return lockTaskState(context) == ActivityManager.LOCK_TASK_MODE_LOCKED;
    }

    /** 状态的人话描述，用于界面与日志。 */
    public static String describeState(Context context) {
        switch (lockTaskState(context)) {
            case ActivityManager.LOCK_TASK_MODE_LOCKED:
                return "已进入 Kiosk 锁定（无法退出）";
            case ActivityManager.LOCK_TASK_MODE_PINNED:
                return "处于屏幕固定（可被用户退出，需设备所有者才能锁死）";
            default:
                return "未处于 Kiosk 锁定";
        }
    }
}
