package com.balloondog.agent.capability;

import android.app.admin.DevicePolicyManager;
import android.content.Context;
import android.os.Build;

/**
 * 锁屏强度的<b>能力分级</b>。
 *
 * <p>家长在家长端选的是「期望强度」（kiosk / password），但这台设备实际能做到什么，
 * 取决于它被授权到什么程度。本类负责把「期望」映射成「实际生效」，并给出人话说明 ——
 * 绝不允许出现「家长以为锁死了、其实只是个能被划走的遮罩」这种静默降级。
 *
 * <pre>
 * 能力档            前提                     能做到
 * ───────────────  ───────────────────────  ──────────────────────────────────────
 * OWNER            设备所有者(Device Owner)  Lock Task 钉住锁定页 + 禁状态栏 + 禁卸载/强行停止
 * ADMIN            设备管理器                lockNow() 真锁屏（但解锁需系统密码）
 * OVERLAY          仅悬浮窗权限              全屏遮罩，可被 Home/通知栏绕过
 * NONE             什么都没有                只能提示，锁不住
 * </pre>
 */
public final class LockCapability {

    private LockCapability() {
    }

    /** 设备实际具备的能力档。 */
    public enum Tier {
        /** 只有（或连）悬浮窗权限。 */
        OVERLAY,
        /** 设备管理器已激活。 */
        ADMIN,
        /** 设备所有者，最强。 */
        OWNER
    }

    public static Tier detect(Context context) {
        if (LockController.isDeviceOwner(context)) return Tier.OWNER;
        if (LockController.isAdminActive(context)) return Tier.ADMIN;
        return Tier.OVERLAY;
    }

    /**
     * 家长期望的强度在当前能力下实际能落到哪一档。
     *
     * @param requested {@code kiosk} | {@code password}
     * @return {@code kiosk} | {@code password} | {@code admin} | {@code overlay}
     */
    public static String effectiveStrength(Context context, String requested) {
        Tier tier = detect(context);
        boolean wantsPassword = "password".equals(requested);

        switch (tier) {
            case OWNER:
                // 设备所有者两种都能做到；password 还需要 API 26+ 的重置令牌机制
                if (wantsPassword && PasswordLockController.isSupported(context)) return "password";
                return "kiosk";
            case ADMIN:
                // 只能 lockNow()，进不了 Lock Task
                return "admin";
            default:
                return "overlay";
        }
    }

    /** 实际生效强度的人话说明，直接显示在界面上。 */
    public static String describeEffective(Context context, String requested) {
        String effective = effectiveStrength(context, requested);
        switch (effective) {
            case "password":
                return "最高强度：锁定瞬间随机改写系统锁屏密码，连系统锁屏都进不去";
            case "kiosk":
                return "强：Lock Task 把设备钉在锁定页，Home / 最近任务 / 通知栏 / 电源菜单全部禁用";
            case "admin":
                return "中：能调用系统锁屏，但孩子可以用自己的锁屏密码解锁后继续使用";
            default:
                return "弱：仅全屏遮罩，孩子可以用 Home 键或通知栏绕过";
        }
    }

    /** 期望强度与实际强度不一致时的降级原因；一致时返回 null。 */
    public static String degradeReason(Context context, String requested) {
        String effective = effectiveStrength(context, requested);
        if (effective.equals(requested)) {
            // password 在设备所有者下若不受支持会落到 kiosk，这里补一句
            if ("password".equals(requested) && !PasswordLockController.isSupported(context)) {
                return "本机系统版本不支持「随机改写锁屏密码」，已降级为 Kiosk 锁定";
            }
            return null;
        }
        Tier tier = detect(context);
        if (tier == Tier.ADMIN) {
            return "本机只是设备管理器（不是设备所有者），无法进入 Kiosk 锁定，已降级为系统锁屏";
        }
        if (tier == Tier.OVERLAY) {
            return "本机尚未激活设备管理器，锁定只是个可被绕过的全屏遮罩";
        }
        return "已按本机实际权限降级";
    }

    /** 界面用的能力总览。 */
    public static String describeTier(Context context) {
        Tier tier = detect(context);
        StringBuilder sb = new StringBuilder();
        switch (tier) {
            case OWNER:
                sb.append("设备所有者");
                break;
            case ADMIN:
                sb.append("设备管理器");
                break;
            default:
                sb.append("仅悬浮窗");
                break;
        }
        DevicePolicyManager dpm = (DevicePolicyManager) context.getSystemService(Context.DEVICE_POLICY_SERVICE);
        if (tier == Tier.OWNER && dpm != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            sb.append(PasswordLockController.isSupported(context)
                    ? "（支持随机锁屏密码）"
                    : "（系统版本不支持随机锁屏密码）");
        }
        return sb.toString();
    }
}
