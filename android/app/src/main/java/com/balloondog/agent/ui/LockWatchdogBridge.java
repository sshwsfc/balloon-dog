package com.balloondog.agent.ui;

/**
 * 让 {@link LockOverlayWindow} 能问出「无障碍看门狗是否可用」，而不必反向依赖 service 包。
 *
 * <p>这个判断决定了锁定窗口用哪种类型，进而决定「通知栏能不能盖住锁定界面」，
 * 是整个无设备所有者方案里最关键的一个开关。
 */
public final class LockWatchdogBridge {

    private LockWatchdogBridge() {
    }

    /** 由 AgentApp 在启动时注入，避免两个包互相 import。 */
    public interface Availability {
        boolean isAccessibilityAvailable();
    }

    private static Availability availability;

    public static void install(Availability impl) {
        availability = impl;
    }

    public static boolean isAccessibilityAvailable() {
        return availability != null && availability.isAccessibilityAvailable();
    }

    /**
     * 用<b>无障碍服务</b>的上下文启动 Activity。
     *
     * <p>为什么必须有这个：Android 10 起禁止后台应用自行弹出 Activity，唯一常用的豁免就是
     * {@code SYSTEM_ALERT_WINDOW}。悬浮窗权限一旦被撤销，「退回锁定页 Activity」这条降级路
     * 就同时被系统堵死了 —— 锁定会彻底失效（实测确认）。无障碍服务是另一条合法豁免，
     * 所以这里借它的上下文起页面，把降级路重新打通。
     */
    public interface ActivityStarter {
        boolean startActivity(android.content.Intent intent);
    }

    private static ActivityStarter activityStarter;

    public static void installActivityStarter(ActivityStarter impl) {
        activityStarter = impl;
    }

    /** @return true 表示已经（通过无障碍服务）尝试启动，调用方不必再自己启动一次。 */
    public static boolean startActivityFromService(android.content.Intent intent) {
        ActivityStarter starter = activityStarter;
        if (starter == null) return false;
        try {
            return starter.startActivity(intent);
        } catch (Exception e) {
            com.balloondog.agent.data.EventLog.warn("经无障碍服务拉起锁定页失败：" + e.getMessage());
            return false;
        }
    }
}
