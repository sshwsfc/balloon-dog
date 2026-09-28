package com.balloondog.agent.capability;

import android.app.Activity;
import android.app.admin.DevicePolicyManager;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.provider.Settings;
import android.text.TextUtils;

import com.balloondog.agent.data.EventLog;

/**
 * 锁屏 / 解锁能力封装。
 *
 * <p>三种强度，从强到弱：
 * <ol>
 *   <li><b>Device Owner</b>：{@code lockNow()} 真锁屏 + {@code setKeyguardDisabled} 临时解锁 + 禁用状态栏；</li>
 *   <li><b>设备管理器</b>：{@code lockNow()} 真锁屏；解锁只能靠系统密码，本应用无法代劳；</li>
 *   <li><b>仅有悬浮窗权限</b>：无法锁屏，退化为全屏锁定页 ——
 *       能挡住使用，但用户可以通过通知栏/多任务绕开，属于「尽力而为」。</li>
 * </ol>
 *
 * <p>本类只提供「锁屏原语」。<b>什么时候锁、锁到什么强度</b>由
 * {@link LockState} 判定、{@link LockEnforcer} 执行，不要在这里加策略。
 *
 * <p>这一点必须在文档里对家长讲清楚，否则会出现「家长以为锁死了，其实没锁」的静默失败 ——
 * 这正是后端 README 反复强调要避免的问题。
 */
public final class LockController {

    private LockController() {
    }

    public static ComponentName adminComponent(Context context) {
        return new ComponentName(context.getPackageName(), AgentAdminReceiver.class.getName());
    }

    private static DevicePolicyManager dpm(Context context) {
        return (DevicePolicyManager) context.getSystemService(Context.DEVICE_POLICY_SERVICE);
    }

    /** 设备管理器是否已激活（家长在引导页里点过「激活设备管理器」）。 */
    public static boolean isAdminActive(Context context) {
        DevicePolicyManager manager = dpm(context);
        return manager != null && manager.isAdminActive(adminComponent(context));
    }

    /** 本应用是否被设为设备所有者（执行过 adb dpm set-device-owner）。 */
    public static boolean isDeviceOwner(Context context) {
        DevicePolicyManager manager = dpm(context);
        return manager != null && manager.isDeviceOwnerApp(context.getPackageName());
    }

    /** 是否有「在其他应用上层绘制」权限 —— Android 10+ 后台弹遮罩锁屏需要它。 */
    public static boolean canDrawOverlays(Context context) {
        return Build.VERSION.SDK_INT < Build.VERSION_CODES.M || Settings.canDrawOverlays(context);
    }

    /** 当前锁屏能力的强度描述，直接显示在界面上。 */
    public static String capabilityLabel(Context context) {
        if (isDeviceOwner(context)) return "设备所有者（最强：可锁屏 / 临时解锁 / 禁用状态栏）";
        if (isAdminActive(context)) return "设备管理器（可真正锁屏；解锁需系统密码或家长端指令）";
        return "仅应用内遮罩（未激活设备管理器，用户可绕过）";
    }

    /** 拉起系统的「激活设备管理器」授权页。 */
    public static void requestAdmin(Activity activity, int requestCode) {
        Intent intent = new Intent(DevicePolicyManager.ACTION_ADD_DEVICE_ADMIN);
        intent.putExtra(DevicePolicyManager.EXTRA_DEVICE_ADMIN, adminComponent(activity));
        intent.putExtra(DevicePolicyManager.EXTRA_ADD_EXPLANATION,
                "激活后，家长才能在这台设备上执行「一键锁屏」。");
        activity.startActivityForResult(intent, requestCode);
    }

    /** 拉起「在其他应用上层绘制」授权页。 */
    public static void requestOverlayPermission(Activity activity) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return;
        Intent intent = new Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION);
        intent.setData(android.net.Uri.parse("package:" + activity.getPackageName()));
        activity.startActivity(intent);
    }

    /**
     * 立即锁屏。
     *
     * @return true 表示已交给系统执行真锁屏；false 表示只做了应用内遮罩
     */
    public static boolean lockNow(Context context) {
        DevicePolicyManager manager = dpm(context);
        if (manager != null && manager.isAdminActive(adminComponent(context))) {
            try {
                manager.lockNow();
                EventLog.success("已调用 DevicePolicyManager.lockNow() 锁屏");
                return true;
            } catch (SecurityException e) {
                EventLog.error("锁屏被系统拒绝：" + e.getMessage());
            }
        }
        // 没有设备管理器就锁不了系统屏幕。这里只如实回报失败，
        // 由 LockEnforcer 退化为全屏锁定页（并会在界面上写清强度只有「遮罩」）。
        EventLog.warn("未激活设备管理器，无法调用系统锁屏，将退化为全屏锁定页");
        return false;
    }

    /**
     * 解除锁定。
     *
     * <p>系统不允许应用随意解锁屏幕（这是 Android 的安全底线），所以：
     * <ul>
     *   <li>设备所有者：调用 {@code setKeyguardDisabled(true)} 临时关掉锁屏；</li>
     *   <li>其它情况：收起应用内遮罩，真正的锁屏需要用户自己输入系统密码。</li>
     * </ul>
     */
    public static void unlock(Context context) {
        // 刻意<b>不</b>调用 setKeyguardDisabled(true)：那会把系统锁屏整个关掉，
        // 解锁一次之后设备就永久失去锁屏保护了。真正的「可用」是这样实现的：
        //   - Kiosk 档：退出 Lock Task，孩子回到正常桌面；
        //   - 随机密码档：清除被改写的密码；
        //   - 系统锁屏本身保持启用，孩子用自己的锁屏密码进入。
        //
        // 本方法因此只剩「确保系统锁屏是启用状态」这一件事，由 restoreKeyguard 完成。
        restoreKeyguard(context);
    }

    /** 恢复系统锁屏（临时解锁到期、家长撤销临时解锁时调用）。 */
    public static void restoreKeyguard(Context context) {
        if (isDeviceOwner(context)) {
            try {
                dpm(context).setKeyguardDisabled(adminComponent(context), false);
            } catch (SecurityException e) {
                EventLog.warn("恢复系统锁屏失败：" + e.getMessage());
            }
        }
    }

    /** 锁定期间禁止下拉状态栏 —— 只有设备所有者能做到，做不到就如实返回 false。 */
    public static boolean setStatusBarDisabled(Context context, boolean disabled) {
        if (!isDeviceOwner(context)) return false;
        try {
            dpm(context).setStatusBarDisabled(adminComponent(context), disabled);
            return true;
        } catch (SecurityException e) {
            EventLog.warn("设置状态栏禁用失败：" + e.getMessage());
            return false;
        }
    }

    /** 设备所有者模式下真正隐藏一个应用（应用限额用得到）。 */
    public static boolean setApplicationHidden(Context context, String packageName, boolean hidden) {
        if (!isDeviceOwner(context) || TextUtils.isEmpty(packageName)) return false;
        try {
            return dpm(context).setApplicationHidden(adminComponent(context), packageName, hidden);
        } catch (SecurityException e) {
            EventLog.warn("隐藏应用 " + packageName + " 失败：" + e.getMessage());
            return false;
        }
    }
}
