package com.balloondog.agent.service;

import android.accessibilityservice.AccessibilityService;
import android.accessibilityservice.AccessibilityServiceInfo;
import android.content.Context;
import android.os.SystemClock;
import android.view.accessibility.AccessibilityEvent;

import androidx.annotation.Nullable;

import com.balloondog.agent.capability.LockEnforcer;
import com.balloondog.agent.capability.LockState;
import com.balloondog.agent.data.AgentStore;
import com.balloondog.agent.data.EventLog;
import com.balloondog.agent.ui.LockOverlayWindow;

import java.util.Arrays;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;

/**
 * 无障碍看门狗 —— 没有设备所有者时，把「锁不住的那几百毫秒」压下去。
 *
 * <h3>它补的是哪个洞</h3>
 * 无设备所有者时，锁定界面是一个全屏悬浮窗。它挡得住 Home 与最近任务，
 * 但有三条路能逃出去：
 * <ol>
 *   <li><b>下拉通知栏</b> —— 通知栏是 SystemUI 绘制的系统窗口，层级高于任何应用悬浮窗；</li>
 *   <li><b>进设置撤销「显示在其他应用上层」权限</b> —— 悬浮窗会连同权限一起消失；</li>
 *   <li><b>进设置关掉本服务本身</b> —— 所以它必须顺手把设置界面也挡住。</li>
 * </ol>
 * 本服务的做法是「打地鼠」：监听前台窗口变化，一旦发现锁定界面被抢走，
 * 立刻把锁定界面重新挂上；如果是通知栏就收回去，是设置类界面就补一次返回。
 *
 * <h3>它仍然不是「不可绕过」</h3>
 * 它依赖无障碍权限，而<b>无障碍服务本身可以在系统设置里被关掉</b>。
 * 本服务通过拦截设置界面把这条路也堵上，但拦截有 ~100-300ms 延迟，
 * 手足够快的人仍可能抢在前面关掉它。要真正没有绕法，只有设备所有者 + Lock Task。
 * 这一点在 README 与界面上都如实写明，不做「已经锁死」的假象。
 *
 * <h3>刻意保留的例外</h3>
 * <b>紧急呼叫与来电永远放行。</b> 这是产品底线：无论家长怎么设置，
 * 孩子必须能打紧急电话、必须能接到电话。看门狗绝不拦截这些窗口。
 */
public class LockWatchdogService extends AccessibilityService {

    /**
     * 锁定时仍然放行的包。
     *
     * <p>这是<b>安全底线</b>而不是功能取舍：一个能把孩子与紧急呼叫隔开的管控工具是不可接受的。
     * 所以这里列出的是「必须放行」，而不是「可以放行」。
     */
    private static final Set<String> ALLOWED_WHILE_LOCKED = new HashSet<>(Arrays.asList(
            // 紧急呼叫界面
            "com.android.emergency",
            "com.android.emergencyinfo",
            // 来电 / 通话中界面（不同 ROM 包名不同，多列几个）
            "com.android.incallui",
            "com.android.server.telecom",
            "com.android.phone",
            "com.android.dialer",
            // 系统权限弹窗本身需要能被处理，否则会卡死整个流程
            "android"
    ));

    /**
     * 「设置类」包名：命中就补一次返回，把它们推走。
     *
     * <p>包含权限控制器与应用安装器 —— 撤销悬浮窗权限、卸载应用都在这两个界面里。
     */
    private static final Set<String> SETTINGS_LIKE = new HashSet<>(Arrays.asList(
            "com.android.settings",
            "com.android.permissioncontroller",
            "com.google.android.permissioncontroller",
            "com.android.packageinstaller",
            "com.google.android.packageinstaller"
    ));

    /** 两次强制之间的最小间隔，避免在事件风暴里疯狂 addView / startActivity。 */
    private static final long ENFORCE_INTERVAL_MS = 400L;

    private static volatile boolean connected;

    private AgentStore store;
    private long lastEnforceAt;
    /** 服务是否已连接（界面据此显示状态）。 */
    public static boolean isConnected() {
        return connected;
    }

    /**
     * 从系统设置里读取本服务是否已启用。
     *
     * <p>{@link #isConnected()} 只在进程活着时有意义；重新打开界面时进程可能是新的，
     * 所以要另外问一次系统。
     */
    public static boolean isEnabledInSettings(Context context) {
        try {
            android.view.accessibility.AccessibilityManager manager =
                    (android.view.accessibility.AccessibilityManager)
                            context.getSystemService(Context.ACCESSIBILITY_SERVICE);
            if (manager == null) return false;
            for (AccessibilityServiceInfo info : manager.getEnabledAccessibilityServiceList(
                    AccessibilityServiceInfo.FEEDBACK_ALL_MASK)) {
                String id = info.getId();
                if (id != null && id.contains(context.getPackageName())) return true;
            }
        } catch (Exception e) {
            return false;
        }
        return false;
    }

    @Override
    protected void onServiceConnected() {
        super.onServiceConnected();
        store = new AgentStore(this);
        connected = true;
        EventLog.success("无障碍看门狗已连接：锁定界面被抢走时会自动拉回来");
    }

    @Override
    public boolean onUnbind(android.content.Intent intent) {
        connected = false;
        EventLog.warn("无障碍看门狗已断开（被系统关闭或在设置里关掉了）");
        return super.onUnbind(intent);
    }

    @Override
    public void onAccessibilityEvent(@Nullable AccessibilityEvent event) {
        if (event == null) return;
        Context context = getApplicationContext();
        if (store == null) store = new AgentStore(context);

        // 只在「策略判定应当锁定」时才工作。
        // 这里复用与 Agent 服务、锁定界面完全相同的判定，避免三处逻辑打架。
        LockState state = LockState.compute(
                LockEnforcer.buildInputs(store, System.currentTimeMillis()));
        if (!state.locked) return;

        CharSequence packageName = event.getPackageName();
        if (packageName == null) return;
        String pkg = packageName.toString();
        if (pkg.isEmpty()) return;

        // 放行：本应用自己的界面（锁定页 / 答题页 / 应急解锁页）
        if (pkg.equals(context.getPackageName())) {
            LockOverlayWindow.setSuspended(false);
            return;
        }
        // 放行：紧急呼叫与来电 —— 安全底线，无条件。
        // 不仅要放行，还要主动把锁定界面撤掉，否则它会盖在拨号/接听界面上，
        // 孩子依然按不到「拨打」和「接听」。
        if (ALLOWED_WHILE_LOCKED.contains(pkg)) {
            LockOverlayWindow.setSuspended(true);
            return;
        }
        LockOverlayWindow.setSuspended(false);

        long now = SystemClock.elapsedRealtime();
        if (now - lastEnforceAt < ENFORCE_INTERVAL_MS) return;
        lastEnforceAt = now;

        enforce(context, pkg, event, state);
    }

    /** 把锁定界面重新拉回最前；必要时补一次返回把逃逸的界面推走。 */
    private void enforce(Context context, String pkg, AccessibilityEvent event, LockState state) {
        String windowClass = event.getClassName() == null ? "" : event.getClassName().toString();
        if (isNotificationShade(pkg, windowClass)) {
            // 通知栏本身不需要「拉回锁定界面」——锁定界面就在它下面，拉也盖不住。
            // 真正解决它的是 LockOverlayWindow 用的 TYPE_ACCESSIBILITY_OVERLAY（层级高于状态栏），
            // 所以这里只记一笔日志，便于排查「为什么通知栏没被挡住」。
            EventLog.warn("看门狗：通知栏被下拉（锁定界面已采用无障碍层级，应仍在其之上）");
            return;
        }

        EventLog.warn("看门狗：检测到「" + pkg + "」抢到前台，正在把锁定界面拉回来");

        // 重新挂上锁定界面（内部按能力档选择 kiosk 还是全屏悬浮窗）。
        // 这里刻意传 <b>this</b>（无障碍服务自身）而不是 ApplicationContext：
        // TYPE_ACCESSIBILITY_OVERLAY 这个能盖住通知栏的层级，只认正在运行的无障碍服务上下文。
        LockEnforcer.showLockUi(isAccessibilityContextUsable() ? this : context, store, state);

        // 设置类界面：持续按返回把它一路推出去。
        //
        // 刻意<b>不</b>做「同一个包只按一次」的去重：设置页是一层套一层的
        // （应用详情 → 应用列表 → 设置首页），按一次只是退了一层，界面仍然在。
        // 节流已经由 ENFORCE_INTERVAL_MS（400ms）兜住，不会疯狂按键。
        if (SETTINGS_LIKE.contains(pkg)) {
            performGlobalAction(GLOBAL_ACTION_BACK);
            EventLog.warn("看门狗：正在把设置类界面「" + pkg + "」逐层推出（阻止撤销权限 / 关闭本服务）");
        }
    }

    /** 本服务是否已连接（连接后才拿得到有效的无障碍窗口上下文）。 */
    private boolean isAccessibilityContextUsable() {
        return connected;
    }

    /** 判断是不是通知栏 / 状态栏窗口。 */
    private static boolean isNotificationShade(String pkg, String windowClass) {
        if (!pkg.contains("systemui")) return false;
        String lower = windowClass.toLowerCase(Locale.US);
        return lower.contains("shade") || lower.contains("statusbar") || lower.contains("notification");
    }

    @Override
    public void onInterrupt() {
        // 系统要求实现；被中断时不需要额外处理，下次事件会继续工作
    }

    /** 供界面判断：无设备所有者时是否已开启看门狗（未开启则锁定可被绕过）。 */
    public static String describeStatus(Context context) {
        boolean enabled = isEnabledInSettings(context);
        boolean alive = isConnected();
        if (!enabled) {
            return "未开启：锁定期间可下拉通知栏或进设置绕过";
        }
        if (!alive) {
            // 已启用但进程没连上：通常是刚开机或服务被系统重启中
            return "已开启（服务正在启动）";
        }
        return "已开启：通知栏会被收起，设置界面会被推走";
    }

    /** 提示用：无设备所有者时，锁定强度完全取决于这个开关。 */
    public static boolean shouldRecommend(Context context) {
        boolean owner = com.balloondog.agent.capability.LockCapability.detect(context)
                == com.balloondog.agent.capability.LockCapability.Tier.OWNER;
        // 设备所有者已经用 Lock Task 锁死了，看门狗只是锦上添花，不再提示
        return !owner && !isEnabledInSettings(context);
    }

    /** 悬浮窗权限是否还在 —— 被撤销时看门狗只能退回 Activity，界面要提示。 */
    public static boolean hasOverlayPermission(Context context) {
        return LockOverlayWindow.canShow(context);
    }
}
