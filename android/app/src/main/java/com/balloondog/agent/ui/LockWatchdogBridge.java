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
}
