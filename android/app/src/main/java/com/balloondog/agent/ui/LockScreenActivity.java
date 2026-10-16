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
import com.balloondog.agent.net.AgentApi;
import com.balloondog.agent.net.ApiException;
import com.balloondog.agent.service.AgentService;
import com.balloondog.agent.capability.TrustedClock;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

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
 * <h3>它凭什么「说得清」</h3>
 * 页面把「为什么被锁」（先于锁定就存在的 {@code detail}）与「还剩多久」都显示出来，
 * 并给出唯一的开口：向家长申请使用时间（规划 §3.1/§3.3）。在此之前孩子除了等
 * 什么也做不了 —— 那正是亲子冲突的来源。三条自我约束：
 * <ul>
 *   <li>能算准才给具体时间（作息、护眼），算不准就如实说「由家长决定」；</li>
 *   <li>原因文案取自<b>同一次</b>判定结果，不可能与「该不该解锁」自相矛盾；</li>
 *   <li>申请与轮询都在后台线程，落盘记住申请过 —— 锁定页卡住或忘了，
 *       比不给申请入口更糟。</li>
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

    /** 申请加时的候选分钟数。与家长端的快捷档位保持一致。 */
    private static final int[] REQUEST_MINUTES = {15, 30, 60, 120};

    private ActivityLockScreenBinding binding;
    private AgentStore store;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final AgentApi api = new AgentApi();
    private final ExecutorService executor = Executors.newSingleThreadExecutor();

    private boolean kioskEntered;
    private boolean dismissing;

    /** 孩子最近一次申请（打开页面时从本地恢复，见 AgentStore）。 */
    @Nullable
    private AgentApi.TimeRequestResult request;
    /** 正在轮询 / 上次轮询时刻：把轮询压到每 5 秒一次，别每秒打服务器。 */
    private volatile boolean polling;
    private long lastPollAt;
    /** 「还剩多久」的缓存：每分钟探一次就够，探测本身要扫 24 小时。 */
    private long unlockAtCache;
    private long unlockAtProbedAt;
    private String unlockAtKey = "";

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
        // 孩子正在答题解锁时绝不重新拉起锁定页：本方法带 CLEAR_TOP，
        // 一拉就把答题页弹掉，孩子永远答不完题（实测过的 bug）。
        // 真正的判断在 LockReassertor / LockWatchdogService，这里再兜一道，
        // 避免以后新增调用点又把这条链路踩坏。
        if (QuizActivity.isShowing()) {
            EventLog.info("锁定页：孩子正在答题解锁流程中，跳过本次拉起");
            return;
        }
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
        binding.buttonRequestTime.setOnClickListener(v -> promptRequest());

        // 恢复上一次的申请：锁定页会被系统重建，忘了就会重复申请、也看不到家长的回复
        String pendingId = store.getPendingTimeRequestId();
        if (pendingId != null) {
            request = new AgentApi.TimeRequestResult(pendingId, store.getPendingTimeRequestKind(),
                    store.getPendingTimeRequestMinutes(), "pending", "");
        }
        renderRequest();

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
        executor.shutdownNow();
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
                LockEnforcer.buildInputs(store, TrustedClock.now()));
        if (!state.locked) {
            EventLog.info("策略判定应当解锁，锁定页自行关闭");
            finishAndExitKiosk();
            return true;
        }

        // 3) 为什么锁：用刚刚这次判定的 detail，而不是拉起本页时那个可能已经过期的入参。
        //    同一个原因字符串既决定「锁着」，也决定「页面怎么写」—— 不可能自相矛盾。
        binding.textLockReason.setText(state.detail == null ? "家长已锁定这台设备" : state.detail);

        // 4) 还剩多久（能算准才说具体时间）
        binding.textUnlockAt.setText(unlockAtText(state));

        // 5) 剩余可用时间（临时解锁 / 答题奖励期间）
        long remaining = store.anyGrantUntil() - TrustedClock.now();
        binding.textCountdown.setText(remaining > 0
                ? "临时可用剩余 " + JsonUtils.humanizeDuration(remaining)
                : "");

        // 6) 答题入口与应急入口的可见性
        binding.buttonQuizUnlock.setVisibility(store.isQuizEnabled() ? View.VISIBLE : View.GONE);
        binding.buttonEmergencyUnlock.setVisibility(
                PasswordLockController.hasEmergencyPassword(store) ? View.VISIBLE : View.GONE);

        // 7) 有未了结的申请时顺手看一眼家长回了没有
        maybePollRequest();

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
        store.setManualUnlockUntil(TrustedClock.now() + 10 * 60_000L);
        Toast.makeText(this, "已解锁，10 分钟内不会自动锁定", Toast.LENGTH_LONG).show();
        refresh();
    }

    // ============================================================
    // 孩子的申请：加时 / 延后锁屏（规划 §3.1）
    // ============================================================

    /**
     * 「还剩多久」。
     *
     * <p>只有本地策略能算准的锁定（作息、护眼）才给具体时间：用与守护服务完全相同的
     * 判定向前试探（{@link LockState#probeAutoUnlockAt}）。家长远程锁定、今日额度或
     * 预算用尽则如实说明 —— 编一个具体的解锁时间比不说更糟，孩子会盯着那个时间等。
     */
    private String unlockAtText(LockState state) {
        if (state.reason == LockState.Reason.REMOTE) {
            return "解锁时间由家长决定";
        }
        if (state.reason == LockState.Reason.DAILY_LIMIT) {
            return "今天的可用时长已经用完，明天重新开始计时";
        }
        if (state.reason == LockState.Reason.BUDGET) {
            return "今天的这一项已经用完，明天重新开始";
        }
        // 每分钟探一次：探测是纯内存计算，但没必要每秒扫 24 小时
        long now = TrustedClock.now();
        String key = state.reason + "|" + state.detail;
        if (!key.equals(unlockAtKey) || now - unlockAtProbedAt > 60_000L) {
            unlockAtKey = key;
            unlockAtProbedAt = now;
            unlockAtCache = LockState.probeAutoUnlockAt(LockEnforcer.buildInputs(store, now));
        }
        if (unlockAtCache <= now) return "";
        return "预计 " + JsonUtils.humanizeDuration(unlockAtCache - now) + "后自动解锁";
    }

    /** 选时长 → 填理由 → 发出去。 */
    private void promptRequest() {
        String[] labels = new String[REQUEST_MINUTES.length];
        for (int i = 0; i < REQUEST_MINUTES.length; i++) {
            labels[i] = REQUEST_MINUTES[i] < 60
                    ? REQUEST_MINUTES[i] + " 分钟"
                    : (REQUEST_MINUTES[i] / 60) + " 小时";
        }
        new AlertDialog.Builder(this)
                .setTitle("申请使用多长时间")
                .setItems(labels, (dialog, which) -> promptRequestReason(REQUEST_MINUTES[which]))
                .setNegativeButton("取消", null)
                .show();
    }

    private void promptRequestReason(int minutes) {
        EditText input = new EditText(this);
        input.setHint("想用手机做什么？（可以不填）");
        input.setMaxLines(2);
        int padding = (int) (20 * getResources().getDisplayMetrics().density);
        input.setPadding(padding, padding, padding, padding);

        new AlertDialog.Builder(this)
                .setTitle("申请 " + minutes + " 分钟")
                .setMessage("申请会立刻发给家长。家长同意后，这台设备会拿到对应的使用时间。")
                .setView(input)
                .setNegativeButton("取消", null)
                .setPositiveButton("发送申请",
                        (dialog, which) -> submitRequest(minutes, input.getText().toString().trim()))
                .show();
    }

    /**
     * 真正发申请。
     *
     * <p>网络请求必须离开主线程：OkHttp 的同步 {@code execute} 会把锁定页卡住，
     * 而锁定页卡住意味着孩子按什么都没反应 —— 比不给他申请入口更糟。
     */
    private void submitRequest(int minutes, String reason) {
        binding.textRequestStatus.setVisibility(View.VISIBLE);
        binding.textRequestStatus.setText("正在发送…");
        binding.buttonRequestTime.setEnabled(false);
        executor.execute(() -> {
            try {
                AgentApi.TimeRequestResult result = api.submitTimeRequest(
                        store.getBaseUrl(), "extend_time", minutes, reason);
                store.setPendingTimeRequest(result.id, result.kind, result.minutes);
                handler.post(() -> {
                    request = result;
                    renderRequest();
                });
            } catch (ApiException e) {
                EventLog.warn("提交加时申请失败：" + e.getMessage());
                handler.post(() -> {
                    binding.textRequestStatus.setText(
                            "申请没能发出去：" + e.userMessage() + "（网络恢复后可以再试）");
                    binding.buttonRequestTime.setEnabled(true);
                });
            }
        });
    }

    /**
     * 轮询审批结果。
     *
     * <p>每 5 秒一次，且只在有 pending 申请时。它只负责「把结果说清楚」：
     * 批准后的真正解锁不依赖它 —— 服务端同时下发了 temp_unlock 指令，
     * 放行窗口一生效，本页每秒的判定就会自行关闭自己。
     */
    private void maybePollRequest() {
        AgentApi.TimeRequestResult current = request;
        if (current == null || !current.isPending() || polling) return;
        long now = TrustedClock.now();
        if (now - lastPollAt < 5_000L) return;
        lastPollAt = now;
        polling = true;
        final String id = current.id;
        executor.execute(() -> {
            try {
                AgentApi.TimeRequestResult result = api.getTimeRequest(store.getBaseUrl(), id);
                handler.post(() -> {
                    polling = false;
                    request = new AgentApi.TimeRequestResult(
                            id, current.kind, result.minutes, result.status, result.note);
                    if (!result.isPending()) {
                        // 已了结：清了本地记录，否则重建页面时会又显示成「等待回应」
                        store.clearPendingTimeRequest();
                    }
                    renderRequest();
                });
            } catch (ApiException e) {
                polling = false;
                // 这条申请查不到了（设备换绑 / 记录被清）：清掉本地记录，别再问了
                if (e.status() == 404) {
                    store.clearPendingTimeRequest();
                }
                EventLog.info("轮询申请状态失败：" + e.getMessage());
            }
        });
    }

    /**
     * 把「最后一次申请」的状态画出来。
     *
     * <p>等待中要挡住重复点击；被拒绝时要把家长的话显示出来 —— 孩子最需要知道的是
     * 「为什么不行」，而不是继续盯着同一个页面等一个不会来的解锁。
     */
    private void renderRequest() {
        if (request == null) {
            binding.textRequestStatus.setVisibility(View.GONE);
            binding.buttonRequestTime.setEnabled(true);
            binding.buttonRequestTime.setText(R.string.action_request_time);
            return;
        }
        binding.textRequestStatus.setVisibility(View.VISIBLE);
        if ("approved".equals(request.status)) {
            binding.textRequestStatus.setText("家长已同意，给你 " + request.minutes + " 分钟，马上解锁");
            binding.buttonRequestTime.setEnabled(false);
            binding.buttonRequestTime.setText("家长已同意");
        } else if ("rejected".equals(request.status)) {
            binding.textRequestStatus.setText(request.note.isEmpty()
                    ? "家长没有同意这次申请"
                    : "家长没有同意：" + request.note);
            binding.buttonRequestTime.setEnabled(true);
            binding.buttonRequestTime.setText("再申请一次");
        } else {
            binding.textRequestStatus.setText(
                    "已发给家长，等待回应…（申请 " + request.minutes + " 分钟）");
            binding.buttonRequestTime.setEnabled(false);
            binding.buttonRequestTime.setText("已申请，等待家长回应");
        }
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
