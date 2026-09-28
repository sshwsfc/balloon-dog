package com.balloondog.agent.ui;

import android.content.Context;
import android.content.Intent;
import android.graphics.PixelFormat;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.LayoutInflater;
import android.view.View;
import android.view.WindowManager;
import android.widget.TextView;

import androidx.annotation.Nullable;

import com.balloondog.agent.R;
import com.balloondog.agent.capability.KioskController;
import com.balloondog.agent.capability.LockEnforcer;
import com.balloondog.agent.capability.LockState;
import com.balloondog.agent.capability.PasswordLockController;
import com.balloondog.agent.data.AgentStore;
import com.balloondog.agent.data.EventLog;
import com.balloondog.agent.model.JsonUtils;
import com.balloondog.agent.service.AgentService;

/**
 * 全屏锁定悬浮窗 —— 「按 Home 也切不走」的那一层。
 *
 * <h3>它和 LockScreenActivity 的分工</h3>
 * <table>
 *   <tr><th></th><th>LockScreenActivity</th><th>本类（全屏悬浮窗）</th></tr>
 *   <tr><td>Home 键</td><td><b>会被切走</b>（Activity 属于任务栈）</td><td><b>切不走</b>（悬浮窗不属于任何任务栈）</td></tr>
 *   <tr><td>Enter 键 / 返回键</td><td>可拦截</td><td>可拦截（窗口可聚焦）</td></tr>
 *   <tr><td>Lock Task</td><td>能（设备所有者时钉住）</td><td>不能</td></tr>
 *   <tr><td>通知栏下拉</td><td>挡不住</td><td>挡不住</td></tr>
 * </table>
 *
 * 所以策略是分工而不是二选一：
 * <ul>
 *   <li><b>设备所有者</b>：用 {@code LockScreenActivity} + Lock Task —— 系统级，
 *       连通知栏和电源菜单都禁掉，没有任何绕法；</li>
 *   <li><b>没有设备所有者</b>：用本类。虽然挡不住通知栏，但至少
 *       <b>按 Home 键、按最近任务都回不到桌面</b>，这比 Activity 遮罩强一档。</li>
 * </ul>
 *
 * <h3>它凭什么「解得开」</h3>
 * 与锁定页同样的思路：窗口自己每秒重算一次锁定状态，判定应当解锁就自行移除。
 * <b>不能只依赖 Agent 服务来通知它消失</b> —— 服务一旦被系统杀掉，
 * 全屏悬浮窗会把孩子永久困在屏幕前，那是最坏的结果。
 */
public final class LockOverlayWindow {

    private static final Handler MAIN = new Handler(Looper.getMainLooper());

    @Nullable
    private static View root;
    @Nullable
    private static WindowManager windowManager;
    @Nullable
    private static TextView reasonView;
    @Nullable
    private static TextView countdownView;
    @Nullable
    private static TextView quizButton;
    @Nullable
    private static TextView emergencyButton;
    @Nullable
    private static AgentStore store;

    private static boolean showing;
    private static boolean quizAvailable;
    private static boolean emergencyAvailable;

    /**
     * 临时让位标记：紧急呼叫或来电界面出现时，看门狗把它置为 true，
     * 锁定界面随即让开，让孩子能正常接听 / 拨紧急电话。
     *
     * <p>这是<b>安全底线</b>：任何管控都不该把人与紧急呼叫隔开。
     * 通话结束后看门狗会清掉它，锁定界面自动回来。
     */
    private static volatile boolean suspended;
    /** 已经就失败原因提示过一次，避免每秒刷一条同样的日志 */
    private static boolean failureLogged;

    /** 自我复核：与服务端/服务是否存活无关，保证不会把孩子永久困住。 */
    private static final Runnable SELF_CHECK = new Runnable() {
        @Override
        public void run() {
            if (!showing) return;
            LockState state = LockState.compute(
                    LockEnforcer.buildInputs(store, System.currentTimeMillis()));
            if (!state.locked) {
                EventLog.info("全屏锁定悬浮窗：判定应当解锁，自行移除");
                hide();
                return;
            }
            // 服务没在跑就顺手拉起来（锁定期间服务死掉会让远程解锁失联）
            if (!AgentService.isRunning()) {
                EventLog.warn("锁定期间发现守护服务未在运行，正在自动恢复");
                AgentService.start(store.getContext());
            }
            updateCountdown();
            MAIN.postDelayed(this, 1_000L);
        }
    };

    private LockOverlayWindow() {
    }

    public static boolean isShowing() {
        return showing;
    }

    public static boolean canShow(Context context) {
        return Build.VERSION.SDK_INT < Build.VERSION_CODES.M
                || android.provider.Settings.canDrawOverlays(context);
    }

    /**
     * 显示全屏锁定窗。
     *
     * @param reason            锁定原因，展示给孩子
     * @param strengthLabel     当前强度的说明（如实写明「按 Home 也切不走」以及挡不住什么）
     * @param quizEnabled       是否显示答题入口
     * @param emergencyEnabled  是否显示应急解锁入口
     */
    public static void show(Context context, @Nullable String reason, @Nullable String strengthLabel,
                            boolean quizEnabled, boolean emergencyEnabled) {
        if (suspended) {
            // 正在紧急通话中：绝不让锁定界面盖住拨号 / 接听界面
            return;
        }
        if (!canShow(context)) {
            // 没有悬浮窗权限时只能退回 Activity 遮罩（会被 Home 切走），如实记日志
            EventLog.warn("缺少「在其他应用上层显示」权限，无法启用全屏悬浮窗锁定，"
                    + "已退回会被 Home 键切走的锁定页");
            return;
        }
        // 刻意<b>不</b>转成 ApplicationContext：TYPE_ACCESSIBILITY_OVERLAY（能盖住通知栏的那个层级）
        // 的有效性取决于「调用方是正在运行的无障碍服务」，换成 ApplicationContext 会被
        // WindowManager 以 BadTokenException 拒绝（实测）。
        store = new AgentStore(context);
        quizAvailable = quizEnabled;
        emergencyAvailable = emergencyEnabled;

        final Context host = context;
        MAIN.post(() -> createAndAdd(host, reason, strengthLabel));
    }

    private static boolean createAndAdd(Context context, @Nullable String reason,
                                        @Nullable String strengthLabel) {
        if (showing) {
            updateContent(reason, strengthLabel);
            return true;
        }
        WindowManager manager = (WindowManager) context.getSystemService(Context.WINDOW_SERVICE);
        if (manager == null) return false;

        boolean accessibilityAvailable = LockWatchdogBridge.isAccessibilityAvailable();
        try {
            addWindow(context, manager, accessibilityAvailable, reason, strengthLabel);
            return true;
        } catch (Exception e) {
            if (accessibilityAvailable && e instanceof android.view.WindowManager.BadTokenException) {
                // 这套系统不接受无障碍专属层级时，退回普通悬浮窗。
                // 退回后通知栏会重新盖住锁定界面 —— 属于能力降级，必须记日志说明，
                // 不能默默失败让家长以为还锁得一样死。
                EventLog.warn("无障碍层级窗口被系统拒绝，已退回普通悬浮窗："
                        + "此时通知栏可以盖住锁定界面，请把本应用设为设备所有者以彻底堵住");
                try {
                    addWindow(context, manager, false, reason, strengthLabel);
                    return true;
                } catch (Exception inner) {
                    logFailure(context, inner);
                    return false;
                }
            }
            logFailure(context, e);
            return false;
        }
    }

    /** 真正把窗口挂上去。抽成独立方法是为了失败后能用另一种窗口类型重试。 */
    private static void addWindow(Context context, WindowManager manager, boolean accessibilityType,
                                  @Nullable String reason, @Nullable String strengthLabel) {
        Context themed = new android.view.ContextThemeWrapper(context, R.style.Theme_BalloonDog);
        View view = LayoutInflater.from(themed).inflate(R.layout.view_lock_overlay, null);

        {
            manager.addView(view, buildParams(accessibilityType));
            windowManager = manager;
            root = view;
            reasonView = view.findViewById(R.id.overlayReason);
            countdownView = view.findViewById(R.id.overlayCountdown);
            quizButton = view.findViewById(R.id.overlayQuizButton);
            emergencyButton = view.findViewById(R.id.overlayEmergencyButton);

            // 吃掉返回/ESC：全屏遮罩期间不允许用返回键退出
            view.setFocusableInTouchMode(true);
            view.setOnKeyListener((v, keyCode, event) -> {
                if (keyCode == KeyEvent.KEYCODE_BACK || keyCode == KeyEvent.KEYCODE_ESCAPE) {
                    return true;
                }
                return false;
            });

            quizButton.setVisibility(quizAvailable ? View.VISIBLE : View.GONE);
            quizButton.setOnClickListener(v -> openActivity(QuizActivity.class));
            emergencyButton.setVisibility(emergencyAvailable ? View.VISIBLE : View.GONE);
            emergencyButton.setOnClickListener(v -> openActivity(EmergencyUnlockActivity.class));

            showing = true;
            updateContent(reason, strengthLabel);
            updateCountdown();

            MAIN.removeCallbacks(SELF_CHECK);
            MAIN.postDelayed(SELF_CHECK, 1_000L);
            EventLog.warn(accessibilityType
                    ? "已启用全屏悬浮窗锁定（无障碍层级：连通知栏也盖不住它）"
                    : "已启用全屏悬浮窗锁定（按 Home / 最近任务都切不走）");
        }
    }

    /** 失败原因只说一次避免刷屏，并区分「权限问题」与「代码问题」。 */
    private static void logFailure(Context context, Exception e) {
        if (failureLogged) return;
        failureLogged = true;
        boolean permissionIssue = !canShow(context)
                || e instanceof android.view.WindowManager.BadTokenException
                || e instanceof SecurityException;
        EventLog.warn(permissionIssue
                ? "显示全屏锁定悬浮窗失败：缺少「在其他应用上层显示」权限"
                : "显示全屏锁定悬浮窗失败（布局加载异常，与权限无关）："
                        + e.getClass().getSimpleName() + " " + e.getMessage());
        root = null;
        windowManager = null;
        showing = false;
    }

    /**
     * 选择窗口类型 —— 这个选择直接决定「通知栏能不能盖住锁定界面」。
     *
     * <table>
     *   <tr><th>类型</th><th>与通知栏的关系</th><th>前提</th></tr>
     *   <tr><td>{@code TYPE_ACCESSIBILITY_OVERLAY}</td>
     *       <td><b>盖在通知栏之上</b>（官方定义：displayed on top of all other windows,
     *           including the status bar）</td>
     *       <td>无障碍服务已启用</td></tr>
     *   <tr><td>{@code TYPE_APPLICATION_OVERLAY}</td>
     *       <td>在通知栏<b>之下</b>，下拉仍能盖住锁定界面</td>
     *       <td>悬浮窗权限</td></tr>
     * </table>
     *
     * <p>这是「无设备所有者也能把通知栏堵死」的关键：早期版本尝试用 BACK 键去收通知栏，
     * 实测在 Android 13 上根本收不起来；换成无障碍专属窗口类型后，
     * 通知栏从物理上就盖不住锁定界面了。
     */
    private static int pickWindowType(boolean accessibilityAvailable) {
        if (accessibilityAvailable && Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP_MR1) {
            return WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY;
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            return WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY;
        }
        return WindowManager.LayoutParams.TYPE_PHONE;
    }

    private static WindowManager.LayoutParams buildParams(boolean accessibilityAvailable) {
        int type = pickWindowType(accessibilityAvailable);

        WindowManager.LayoutParams params = new WindowManager.LayoutParams(
                WindowManager.LayoutParams.MATCH_PARENT,
                WindowManager.LayoutParams.MATCH_PARENT,
                type,
                // 刻意<b>不</b>加 FLAG_NOT_FOCUSABLE：
                // 需要它拿到焦点才能吃掉返回键，也才能让触摸全部落在遮罩上。
                // FLAG_LAYOUT_IN_SCREEN + NO_LIMITS 让它铺满整屏（含被系统栏遮住的区域）。
                WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN
                        | WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS
                        | WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON
                        | WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED,
                PixelFormat.OPAQUE);
        params.gravity = Gravity.TOP | Gravity.START;
        params.x = 0;
        params.y = 0;
        params.setTitle("balloon-lock-overlay");
        return params;
    }

    private static void updateContent(@Nullable String reason, @Nullable String strengthLabel) {
        if (reasonView != null) {
            reasonView.setText(reason == null ? "家长已锁定这台设备" : reason);
        }
        if (root != null && strengthLabel != null) {
            TextView strength = root.findViewById(R.id.overlayStrength);
            if (strength != null) strength.setText(strengthLabel);
        }
    }

    /** 刷新「临时可用剩余」文案。 */
    private static void updateCountdown() {
        if (countdownView == null || store == null) return;
        long remaining = store.anyGrantUntil() - System.currentTimeMillis();
        countdownView.setText(remaining > 0
                ? "临时可用剩余 " + JsonUtils.humanizeDuration(remaining)
                : "");
    }

    /**
     * 打开本应用自己的 Activity（答题页 / 应急解锁页）。
     *
     * <p>必须先把悬浮窗摘掉：{@code TYPE_APPLICATION_OVERLAY} 的层级高于所有应用窗口，
     * 不摘掉的话我们自己的 Activity 会被自己盖住，用户点不到任何东西。
     * 这些 Activity 结束后，服务端的下一次判定会把悬浮窗重新挂上（此时仍然处于锁定态）。
     */
    private static void openActivity(Class<?> activityClass) {
        hide();
        Context context = store == null ? null : store.getContext();
        if (context == null) return;
        Intent intent = new Intent(context, activityClass);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK
                | Intent.FLAG_ACTIVITY_CLEAR_TOP
                | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        try {
            context.startActivity(intent);
        } catch (Exception e) {
            EventLog.error("从锁定悬浮窗打开界面失败：" + e.getMessage());
        }
    }

    /** 移除悬浮窗。解锁、或需要临时让出自己的界面时调用。 */
    public static void hide() {
        final View current = root;
        final WindowManager manager = windowManager;
        root = null;
        windowManager = null;
        reasonView = null;
        countdownView = null;
        quizButton = null;
        emergencyButton = null;
        showing = false;
        MAIN.removeCallbacks(SELF_CHECK);

        if (current == null || manager == null) return;
        MAIN.post(() -> {
            try {
                manager.removeViewImmediate(current);
            } catch (Exception ignored) {
                // 已被移除时忽略
            }
        });
    }

    /**
     * 紧急呼叫 / 来电期间临时让位。
     *
     * @param value true 让位（立刻移除窗口）；false 恢复（下一次判定会重新挂上）
     */
    public static void setSuspended(boolean value) {
        if (suspended == value) return;
        suspended = value;
        EventLog.warn(value
                ? "检测到紧急呼叫 / 来电界面，锁定界面临时让位（结束后自动恢复）"
                : "紧急呼叫 / 来电结束，锁定界面恢复");
        if (value) hide();
    }

    public static boolean isSuspended() {
        return suspended;
    }

    /** 当前是否处于「无设备所有者，只能靠悬浮窗」的情况 —— 供界面提示用。 */
    public static String describeLimitation(Context context) {
        if (KioskController.isLocked(context)) {
            return "Kiosk 锁定：Home / 最近任务 / 通知栏 / 电源菜单全部禁用";
        }
        if (isShowing()) {
            return "全屏悬浮窗锁定：按 Home 键与最近任务都切不走；"
                    + "但通知栏仍可下拉（要堵住它需要设为设备所有者）";
        }
        return "未处于锁定状态";
    }

    /** 应急解锁入口在悬浮窗里点开后，由这个 Activity 承载密码输入。 */
    public static boolean hasEmergencyPassword() {
        return store != null && PasswordLockController.hasEmergencyPassword(store);
    }
}
