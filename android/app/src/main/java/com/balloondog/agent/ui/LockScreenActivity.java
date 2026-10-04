package com.balloondog.agent.ui;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.InputType;
import android.view.KeyEvent;
import android.view.View;
import android.view.WindowManager;
import android.widget.EditText;
import android.widget.Toast;

import androidx.annotation.Nullable;
import androidx.appcompat.app.AlertDialog;
import androidx.appcompat.app.AppCompatActivity;

import com.balloondog.agent.R;
import com.balloondog.agent.capability.KioskController;
import com.balloondog.agent.capability.LockCapability;
import com.balloondog.agent.capability.LockEnforcer;
import com.balloondog.agent.capability.LockState;
import com.balloondog.agent.capability.PasswordLockController;
import com.balloondog.agent.data.AgentStore;
import com.balloondog.agent.data.EventLog;
import com.balloondog.agent.databinding.ActivityLockScreenBinding;
import com.balloondog.agent.model.JsonUtils;
import com.balloondog.agent.service.AgentService;

/**
 * 锁定页 —— 需求 2 与需求 5 的落点。
 *
 * <h3>它凭什么「锁得住」</h3>
 * <ul>
 *   <li>设备所有者时进入 <b>Lock Task</b>（见 {@link KioskController}）：
 *       Home / 最近任务 / 通知栏 / 电源菜单全禁用，孩子退不出去；</li>
 *   <li>不是设备所有者时只能退化为全屏页 + 吃掉返回键，孩子仍可能绕过 ——
 *       这一点会如实显示在页面上（{@code textStrength}），不制造「已经锁死」的假象。</li>
 * </ul>
 *
 * <h3>它凭什么「解得开」</h3>
 * 页面每秒自行重算一次锁定状态（{@link LockEnforcer#buildInputs}），一旦策略判定应当解锁
 * 就立刻退出 kiosk 并关闭自己。<b>这个设计是刻意的</b>：如果只靠 Agent 服务来通知解锁，
 * 服务一旦被系统杀掉，孩子就会被永久困在锁定页上 —— 那是最坏的结果。
 * 同理，页面还会在发现服务没在跑时顺手把它拉起来。
 */
public class LockScreenActivity extends AppCompatActivity {

    public static final String ACTION_DISMISS = "com.balloondog.agent.action.DISMISS_LOCK_SCREEN";
    private static final String EXTRA_REASON = "reason";
    private static final String EXTRA_STRENGTH = "strength";

    private ActivityLockScreenBinding binding;
    private AgentStore store;
    private final Handler handler = new Handler(Looper.getMainLooper());

    private boolean kioskEntered;
    private boolean dismissing;

    /**
     * 锁定页当前是否在前台。
     *
     * <p>供 {@link com.balloondog.agent.capability.LockReassertor} 判断「实际是否锁着」——
     * 用静态标志而不是去问 WindowManager，是因为它就在同一个进程里，
     * 精确且零成本。
     */
    private static volatile boolean showing;

    public static boolean isShowing() {
        return showing;
    }

    /** 打开锁定页。 */
    public static void show(Context context, @Nullable String reason, @Nullable String strength) {
        Intent intent = new Intent(context, LockScreenActivity.class);
        intent.putExtra(EXTRA_REASON, reason);
        intent.putExtra(EXTRA_STRENGTH, strength);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK
                | Intent.FLAG_ACTIVITY_CLEAR_TOP
                | Intent.FLAG_ACTIVITY_SINGLE_TOP
                | Intent.FLAG_ACTIVITY_EXCLUDE_FROM_RECENTS);
        // 没有悬浮窗权限时，应用上下文起 Activity 会被系统的后台启动限制静默拦掉
        // （锁定直接失效）。无障碍服务是合法豁免，优先借它起。
        if (!LockOverlayWindow.canShow(context)
                && LockWatchdogBridge.startActivityFromService(intent)) {
            EventLog.info("经无障碍服务拉起锁定页（无悬浮窗权限降级路径）");
            return;
        }
        try {
            context.startActivity(intent);
        } catch (Exception e) {
            EventLog.error("拉起锁定页失败：" + e.getMessage());
        }
    }

    /** 请求关闭锁定页（实际由页面自己在确认解锁后执行）。 */
    public static void dismiss(Context context) {
        Intent intent = new Intent(ACTION_DISMISS);
        intent.setPackage(context.getPackageName());
        context.sendBroadcast(intent);
    }

    private final BroadcastReceiver dismissReceiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            if (ACTION_DISMISS.equals(intent.getAction())) {
                finishAndExitKiosk();
            }
        }
    };

    /** 每秒复查一次是否该解锁。 */
    private final Runnable ticker = new Runnable() {
        @Override
        public void run() {
            if (isFinishing()) return;
            if (!refresh()) {
                handler.postDelayed(this, 1_000L);
            }
        }
    };

    @Override
    protected void onCreate(@Nullable Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        binding = ActivityLockScreenBinding.inflate(getLayoutInflater());
        setContentView(binding.getRoot());

        store = new AgentStore(this);

        // 常亮 + 盖在系统锁屏之上：锁定期间这几条都是必要的，
        // 否则「随机改密码」档下家长连应急解锁入口都看不到
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON
                | WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED
                | WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON
                | WindowManager.LayoutParams.FLAG_DISMISS_KEYGUARD);

        String reason = getIntent().getStringExtra(EXTRA_REASON);
        binding.textLockReason.setText(reason == null ? "家长已锁定这台设备" : reason);
        binding.textStrength.setText(describeStrength(getIntent().getStringExtra(EXTRA_STRENGTH)));

        binding.buttonQuizUnlock.setOnClickListener(v ->
                startActivity(new Intent(this, QuizActivity.class)));
        binding.buttonEmergencyUnlock.setOnClickListener(v -> promptEmergencyPassword());

        IntentFilter filter = new IntentFilter(ACTION_DISMISS);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            registerReceiver(dismissReceiver, filter, Context.RECEIVER_NOT_EXPORTED);
        } else {
            registerReceiver(dismissReceiver, filter);
        }
    }

    /** 当前锁定强度的人话说明。 */
    private String describeStrength(@Nullable String effective) {
        String value = effective == null
                ? LockCapability.effectiveStrength(this, store.getLockStrength())
                : effective;
        switch (value) {
            case "password":
                return "最高强度锁定：系统锁屏密码已被改写，无法绕过";
            case "kiosk":
                return "Kiosk 锁定：无法退出、无法下拉通知栏";
            case "admin":
                return "系统锁屏中：可解锁后继续使用（家长可远程再次锁定）";
            default:
                return "遮罩锁定：可被 Home 键绕过（建议家长激活设备管理器或设备所有者）";
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        showing = true;
        enterKioskIfPossible();
        handler.removeCallbacks(ticker);
        handler.post(ticker);
    }

    @Override
    protected void onPause() {
        handler.removeCallbacks(ticker);
        super.onPause();
    }

    @Override
    protected void onStop() {
        showing = false;
        super.onStop();
    }

    @Override
    protected void onDestroy() {
        handler.removeCallbacks(ticker);
        try {
            unregisterReceiver(dismissReceiver);
        } catch (IllegalArgumentException ignored) {
            // 未注册成功时忽略
        }
        super.onDestroy();
    }

    private void enterKioskIfPossible() {
        if (kioskEntered) return;
        if (LockCapability.detect(this) != LockCapability.Tier.OWNER) return;
        // 白名单必须在 startLockTask 之前设好，否则只会进「屏幕固定」
        KioskController.prepare(this);
        kioskEntered = KioskController.isLocked(this) || KioskController.enter(this);
        if (kioskEntered) {
            binding.textStrength.setText("Kiosk 锁定：无法退出、无法下拉通知栏");
        }
    }

    /**
     * 复查一次。
     *
     * @return true 表示页面即将关闭
     */
    private boolean refresh() {
        // 1) 服务没在跑就顺手拉起来 —— 锁定期间服务死掉会让「远程解锁」彻底失联
        if (!AgentService.isRunning()) {
            EventLog.warn("锁定期间发现守护服务未在运行，正在自动恢复");
            AgentService.start(this);
        }

        // 2) 与服务使用完全相同的判定逻辑复查该不该解锁
        // 先自愈一次：如果本机残留的是「上一台设备」的锁定策略，这里会把它清掉，
        // 紧接着的判定就会得出「应当解锁」，锁定页自己关闭。
        // 这是已经被锁死的设备唯一能自救的地方（不需要用户清数据或重装）。
        try {
            if (store.healStalePolicyCache()) {
                EventLog.warn("已清除陈旧锁定策略，重新判定锁定状态");
            }
        } catch (Exception e) {
            EventLog.warn("锁解锁前自愈失败：" + e.getMessage());
        }

        LockState state = LockState.compute(
                LockEnforcer.buildInputs(store, System.currentTimeMillis()));
        if (!state.locked) {
            EventLog.info("策略判定应当解锁，锁定页自行关闭");
            finishAndExitKiosk();
            return true;
        }

        // 3) 剩余可用时间（临时解锁 / 答题奖励期间）
        long remaining = store.anyGrantUntil() - System.currentTimeMillis();
        binding.textCountdown.setText(remaining > 0
                ? "临时可用剩余 " + JsonUtils.humanizeDuration(remaining)
                : "");

        // 4) 答题入口与应急入口的可见性
        binding.buttonQuizUnlock.setVisibility(store.isQuizEnabled() ? View.VISIBLE : View.GONE);
        binding.buttonEmergencyUnlock.setVisibility(
                PasswordLockController.hasEmergencyPassword(store) ? View.VISIBLE : View.GONE);

        return false;
    }

    private void finishAndExitKiosk() {
        if (dismissing) return;
        dismissing = true;
        handler.removeCallbacks(ticker);
        exitKioskThenFinish(0);
    }

    /**
     * 先把 Kiosk 真正退干净，再关闭本页。
     *
     * <p>不能 {@code stopLockTask()} 完就立刻 {@code finish()}：系统拆 Lock Task 是异步的，
     * 还没拆完时 finish 会被 ActivityTaskManager 直接拒绝（实测日志
     * {@code Not finishing task in lock task mode}），结果就是家长远程解锁了、
     * 日志也写了「解除锁定」，锁定页却仍然挂在屏幕上 —— 需求 3 最不能容忍的那种静默失效。
     *
     * <p>所以这里等状态真的离开 Lock Task 再关，最多重试 3 秒；真退不掉也不能一直卡着，
     * 到点仍然 finish（此时会记一条警告，由 {@link KioskController#exit} 负责）。
     */
    private void exitKioskThenFinish(int attempt) {
        if (kioskEntered || KioskController.isLocked(this)) {
            KioskController.exit(this);
            kioskEntered = false;
        }
        if (KioskController.isLocked(this) && attempt < 15) {
            handler.postDelayed(() -> exitKioskThenFinish(attempt + 1), 200L);
            return;
        }
        finish();
    }

    // ============================================================
    // 应急解锁（完全离线）
    // ============================================================

    /**
     * 弹出应急密码输入框。
     *
     * <p>这是「服务端不可用」时的唯一出路，因此必须完全离线校验：
     * 不依赖 Agent 服务，也不发任何网络请求。
     */
    private void promptEmergencyPassword() {
        EditText input = new EditText(this);
        input.setInputType(InputType.TYPE_CLASS_NUMBER | InputType.TYPE_NUMBER_VARIATION_PASSWORD);
        input.setHint("请输入家长设置的应急密码");
        int padding = (int) (20 * getResources().getDisplayMetrics().density);
        input.setPadding(padding, padding, padding, padding);

        new AlertDialog.Builder(this)
                .setTitle(R.string.action_emergency_unlock)
                .setMessage("应急密码由家长在本机设置、离线可用。输入正确后会解除锁定并清除随机锁屏密码。")
                .setView(input)
                .setNegativeButton("取消", null)
                .setPositiveButton("解锁", (dialog, which) -> {
                    String value = input.getText().toString().trim();
                    if (PasswordLockController.verifyEmergencyPassword(store, value)) {
                        onEmergencyUnlocked();
                    } else {
                        Toast.makeText(this, "应急密码不正确", Toast.LENGTH_LONG).show();
                        EventLog.warn("应急解锁失败：密码不正确");
                    }
                })
                .show();
    }

    private void onEmergencyUnlocked() {
        EventLog.warn("已通过应急密码解除锁定");
        // 清除随机锁屏密码，并给一段放行时间 ——
        // 家长既然已经拿到手机，不该 1 秒后又被锁回去
        PasswordLockController.disengage(this, store);
        store.setLockState(false, 0L);
        store.setManualUnlockUntil(System.currentTimeMillis() + 10 * 60_000L);
        Toast.makeText(this, "已解锁，10 分钟内不会自动锁定", Toast.LENGTH_LONG).show();
        refresh();
    }

    // ============================================================
    // 防退出
    // ============================================================

    @Override
    public void onBackPressed() {
        Toast.makeText(this, "设备已被家长锁定", Toast.LENGTH_SHORT).show();
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK || keyCode == KeyEvent.KEYCODE_ESCAPE) {
            Toast.makeText(this, "设备已被家长锁定", Toast.LENGTH_SHORT).show();
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }
}
