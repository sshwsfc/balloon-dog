package com.balloondog.agent.ui;

import android.content.Context;
import android.content.Intent;
import android.graphics.PixelFormat;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.view.Gravity;
import android.view.LayoutInflater;
import android.view.View;
import android.view.WindowManager;
import android.widget.TextView;

import androidx.annotation.Nullable;

import com.balloondog.agent.R;
import com.balloondog.agent.data.EventLog;

/**
 * 锁屏倒计时预告悬浮窗（需求 4）。
 *
 * <p>在即将锁屏前 N 秒（家长可配，默认 30 秒）弹出一条半透明提示，
 * 让孩子知道「马上要锁了，现在还可以去答题换时间」，而不是毫无预警地黑屏。
 * 内嵌「答题解锁」入口 —— 这是需求 5 里两个入口之一（另一个在锁定页上）。
 *
 * <h3>为什么用 WindowManager 而不是一个 Activity</h3>
 * 悬浮窗要不打断当前界面地浮在上面；Activity 会把孩子正在做的事切走，
 * 那不是「预告」而是「打断」。{@code TYPE_APPLICATION_OVERLAY} 才是对的层级。
 *
 * <h3>权限</h3>
 * Android 6+ 需要 {@code SYSTEM_ALERT_WINDOW}；没有它 {@link #show} 会静默失败，
 * 所以 {@link #show} 返回 false 时调用方会在日志里明确提示家长去授权。
 */
public final class CountdownOverlay {

    private static final Handler MAIN = new Handler(Looper.getMainLooper());

    @Nullable
    private static View view;
    @Nullable
    private static WindowManager windowManager;
    @Nullable
    private static TextView titleView;
    @Nullable
    private static TextView reasonView;
    @Nullable
    private static View quizButton;

    private static boolean quizAvailable;
    private static String lastTitle;
    /** 已经就失败原因提示过一次，避免每秒刷一条同样的日志 */
    private static boolean failureLogged;

    private CountdownOverlay() {
    }

    public static boolean isVisible() {
        return view != null;
    }

    /** 是否具备悬浮窗权限。 */
    public static boolean canShow(Context context) {
        return Build.VERSION.SDK_INT < Build.VERSION_CODES.M || Settings.canDrawOverlays(context);
    }

    /**
     * 显示 / 更新倒计时。
     *
     * @param remainingSeconds 剩余秒数
     * @param reason           锁定原因（例如「作息：晚上睡觉」）
     * @param quizAvailable    是否显示「答题解锁」入口（家长开了答题解锁才显示）
     * @return 是否成功显示
     */
    public static boolean show(Context context, int remainingSeconds, @Nullable String reason,
                               boolean quizAvailable) {
        if (!canShow(context)) return false;
        final Context app = context.getApplicationContext();
        final String title = "距锁定还有 " + formatSeconds(remainingSeconds);

        // 文字没变时只更新内容，不重新 addView —— 反复 add/remove 会闪
        if (view != null) {
            MAIN.post(() -> updateContent(title, reason, quizAvailable));
            return true;
        }

        final boolean[] created = {false};
        MAIN.post(() -> created[0] = createAndAdd(app, title, reason, quizAvailable));
        // WindowManager 必须在主线程操作；这里不等待结果，失败会在日志里体现
        return true;
    }

    private static boolean createAndAdd(Context context, String title, @Nullable String reason,
                                        boolean quizAvailable) {
        if (view != null) {
            updateContent(title, reason, quizAvailable);
            return true;
        }
        WindowManager manager = (WindowManager) context.getSystemService(Context.WINDOW_SERVICE);
        if (manager == null) return false;

        try {
            // 用一个带本应用主题的包装 Context：悬浮窗虽然不依赖 Material 组件，
            // 但带上主题能让 @color / @style 之类的引用行为与其它界面完全一致，
            // 少一类「只有悬浮窗里样式不对」的怪问题。
            Context themed = new android.view.ContextThemeWrapper(context, R.style.Theme_BalloonDog);
            View root = LayoutInflater.from(themed).inflate(R.layout.view_countdown_overlay, null);
            WindowManager.LayoutParams params = buildParams();

            manager.addView(root, params);
            windowManager = manager;
            view = root;
            titleView = root.findViewById(R.id.countdownTitle);
            reasonView = root.findViewById(R.id.countdownReason);
            quizButton = root.findViewById(R.id.countdownQuizButton);

            updateContent(title, reason, quizAvailable);
            failureLogged = false;
            EventLog.info("已显示锁屏倒计时悬浮窗");
            return true;
        } catch (Exception e) {
            // 两类原因要分开说清楚，否则排查时会被引到错误方向：
            //   1) 没有悬浮窗权限 → addView 抛 BadTokenException / SecurityException
            //   2) 布局自身 inflate 失败 → 是代码问题，不是权限问题
            if (!failureLogged) {
                failureLogged = true;
                boolean permissionIssue = !canShow(context)
                        || e instanceof android.view.WindowManager.BadTokenException
                        || e instanceof SecurityException;
                EventLog.warn(permissionIssue
                        ? "显示倒计时悬浮窗失败：缺少「在其他应用上层显示」权限"
                        : "显示倒计时悬浮窗失败（布局加载异常，与权限无关）："
                                + e.getClass().getSimpleName() + " " + e.getMessage());
            }
            view = null;
            windowManager = null;
            return false;
        }
    }

    private static WindowManager.LayoutParams buildParams() {
        int type = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
                : WindowManager.LayoutParams.TYPE_PHONE;

        WindowManager.LayoutParams params = new WindowManager.LayoutParams(
                WindowManager.LayoutParams.MATCH_PARENT,
                WindowManager.LayoutParams.WRAP_CONTENT,
                type,
                // NOT_FOCUSABLE：不抢输入焦点（不弹键盘），但按钮仍能收到点击
                // NOT_TOUCH_MODAL：窗口外的触摸照常传给下面的应用，不打断孩子操作
                //
                // 刻意<b>不</b>加 FLAG_LAYOUT_NO_LIMITS：那个标记允许窗口超出屏幕边界，
                // 会让下面的 horizontalMargin 完全失效，卡片直接贴边 —— 看起来像系统 UI 出错。
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                        | WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL,
                PixelFormat.TRANSLUCENT);
        // 给窗口起个名字：dumpsys window 里能直接 grep 到，
        // 否则排障时无法确认「悬浮窗到底有没有加上去」
        params.setTitle("balloon-countdown");
        params.gravity = Gravity.TOP | Gravity.CENTER_HORIZONTAL;
        params.y = dp(14);
        params.width = WindowManager.LayoutParams.MATCH_PARENT;
        // 左右各留 5% 边距：配合上面的 MATCH_PARENT 让它看起来是一张浮起来的卡片，
        // 而不是一条被裁掉的系统栏
        params.horizontalMargin = 0.05f;
        return params;
    }

    private static void updateContent(String title, @Nullable String reason, boolean quizAvailable) {
        if (titleView != null && !title.equals(lastTitle)) {
            titleView.setText(title);
            lastTitle = title;
        }
        if (reasonView != null) {
            if (reason == null || reason.isEmpty()) {
                reasonView.setVisibility(View.GONE);
            } else {
                reasonView.setVisibility(View.VISIBLE);
                reasonView.setText(reason);
            }
        }
        if (quizButton != null) {
            boolean changed = quizAvailable != CountdownOverlay.quizAvailable;
            CountdownOverlay.quizAvailable = quizAvailable;
            quizButton.setVisibility(quizAvailable ? View.VISIBLE : View.GONE);
            if (changed && quizAvailable) {
                quizButton.setOnClickListener(v -> openQuiz(v.getContext()));
            }
        }
    }

    /** 从悬浮窗进入答题页。 */
    private static void openQuiz(Context context) {
        Intent intent = new Intent(context, QuizActivity.class);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK
                | Intent.FLAG_ACTIVITY_CLEAR_TOP
                | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        try {
            context.startActivity(intent);
        } catch (Exception e) {
            EventLog.error("从倒计时悬浮窗打开答题页失败：" + e.getMessage());
        }
    }

    /** 收起悬浮窗。锁定真正发生、或家长解锁后调用。 */
    public static void hide() {
        final View current = view;
        final WindowManager manager = windowManager;
        view = null;
        windowManager = null;
        titleView = null;
        reasonView = null;
        quizButton = null;
        lastTitle = null;

        if (current == null || manager == null) return;
        MAIN.post(() -> {
            try {
                manager.removeViewImmediate(current);
            } catch (Exception ignored) {
                // 已经被移除时忽略
            }
        });
    }

    /** mm:ss；不足 1 分钟就直接显示秒数，更符合「还有 30 秒」的语感。 */
    private static String formatSeconds(int seconds) {
        int safe = Math.max(0, seconds);
        if (safe < 60) return safe + " 秒";
        return String.format(java.util.Locale.US, "%d:%02d", safe / 60, safe % 60);
    }

    private static int dp(int value) {
        return (int) (value * android.content.res.Resources.getSystem().getDisplayMetrics().density);
    }
}
