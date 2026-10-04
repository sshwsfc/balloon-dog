package com.balloondog.agent.ui;

import android.Manifest;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.text.InputType;
import android.provider.Settings;
import android.text.SpannableStringBuilder;
import android.text.Spanned;
import android.text.style.ForegroundColorSpan;
import android.view.View;
import android.widget.EditText;
import android.widget.Toast;

import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.annotation.Nullable;
import androidx.appcompat.app.AlertDialog;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;

import com.balloondog.agent.R;
import com.balloondog.agent.capability.KioskController;
import com.balloondog.agent.capability.LockCapability;
import com.balloondog.agent.capability.LockController;
import com.balloondog.agent.capability.LockEnforcer;
import com.balloondog.agent.capability.LockState;
import com.balloondog.agent.capability.LocationReader;
import com.balloondog.agent.capability.OwnerHardening;
import com.balloondog.agent.capability.PasswordLockController;
import com.balloondog.agent.capability.PhotoCapturer;
import com.balloondog.agent.data.AgentStore;
import com.balloondog.agent.data.EventLog;
import com.balloondog.agent.databinding.ActivityMainBinding;
import com.balloondog.agent.model.JsonUtils;
import com.balloondog.agent.service.AgentService;
import com.balloondog.agent.service.LockWatchdogService;
import com.balloondog.agent.service.WatchdogScheduler;

import java.util.ArrayList;
import java.util.List;

/**
 * Agent 的主界面：配对引导 + 运行状态 + 运行日志。
 *
 * <p>这台设备平时由孩子使用，家长只在「刚装好」和「出问题时」才会打开它，
 * 所以界面按「先给绑定码，再给一键授权，最后给出排查用的日志」排列。
 */
public class MainActivity extends AppCompatActivity implements EventLog.Listener {

    private static final int REQUEST_DEVICE_ADMIN = 0x1001;

    private ActivityMainBinding binding;
    private AgentStore store;
    /** 上次尝试自愈的时间，避免 onResume 被反复触发时重复启动服务。 */
    private long lastSelfHealAt;

    private final Handler uiHandler = new Handler(Looper.getMainLooper());

    /**
     * 界面可见期间每 2 秒重绘一次状态卡。
     *
     * <p>这个页面上显示的东西（守护是否在跑、当前是否锁定、今日已用时长、权限是否齐）
     * 都会在别的线程里被改动，只在 onResume 刷一次是不够的：
     * 自愈刚把服务拉起来时 renderState 还没看到它、家长在别处解了锁、孩子刚答完题 ——
     * 界面都会停在旧状态，让人以为出了问题。
     */
    private final Runnable uiTicker = new Runnable() {
        @Override
        public void run() {
            renderState();
            uiHandler.postDelayed(this, 2_000L);
        }
    };

    private final ActivityResultLauncher<String[]> runtimePermissionLauncher =
            registerForActivityResult(new ActivityResultContracts.RequestMultiplePermissions(),
                    result -> {
                        int granted = 0;
                        for (Boolean value : result.values()) {
                            if (Boolean.TRUE.equals(value)) granted++;
                        }
                        Toast.makeText(this, "已授权 " + granted + " / " + result.size() + " 项权限",
                                Toast.LENGTH_SHORT).show();
                        renderState();
                    });

    public static Intent createIntent(Context context) {
        Intent intent = new Intent(context, MainActivity.class);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        return intent;
    }

    public static PendingIntent createPendingIntent(Context context) {
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            flags |= PendingIntent.FLAG_IMMUTABLE;
        }
        return PendingIntent.getActivity(context, 0, createIntent(context), flags);
    }

    @Override
    protected void onCreate(@Nullable Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        binding = ActivityMainBinding.inflate(getLayoutInflater());
        setContentView(binding.getRoot());

        store = new AgentStore(this);
        store.ensureIdentity();

        binding.buttonToggleService.setOnClickListener(v -> toggleService());
        binding.buttonRefresh.setOnClickListener(v -> {
            AgentService.refreshNow(this);
            Toast.makeText(this, "已请求刷新", Toast.LENGTH_SHORT).show();
        });
        binding.buttonGrantAdmin.setOnClickListener(v ->
                LockController.requestAdmin(this, REQUEST_DEVICE_ADMIN));
        binding.buttonGrantRuntime.setOnClickListener(v -> requestRuntimePermissions());
        binding.buttonGrantOverlay.setOnClickListener(v -> {
            LockController.requestOverlayPermission(this);
            Toast.makeText(this, "请在列表中找到「气球狗守护」并允许", Toast.LENGTH_LONG).show();
        });
        binding.buttonBattery.setOnClickListener(v -> requestIgnoreBatteryOptimization());
        binding.buttonQuiz.setOnClickListener(v ->
                startActivity(new Intent(this, QuizActivity.class)));
        binding.buttonSettings.setOnClickListener(v ->
                startActivity(new Intent(this, SettingsActivity.class)));
        binding.buttonSetEmergency.setOnClickListener(v -> promptEmergencyPassword());
        binding.buttonHeal.setOnClickListener(v -> selfCheckAndHeal());
        binding.buttonEnableWatchdog.setOnClickListener(v -> openAccessibilitySettings());
        binding.buttonCaptureAuth.setOnClickListener(v -> requestCaptureAuthorization());
        binding.buttonWatchdogGuide.setOnClickListener(v -> showWatchdogGuide());
        binding.buttonOwnerGuide.setOnClickListener(v -> showOwnerGuide());
        binding.buttonClearLog.setOnClickListener(v -> {
            EventLog.clear();
            renderLog();
        });
    }

    @Override
    protected void onResume() {
        super.onResume();
        EventLog.addListener(this);
        selfHealIfServiceDied();
        renderState();
        renderLog();
        uiHandler.removeCallbacks(uiTicker);
        uiHandler.post(uiTicker);
    }

    /**
     * 守护服务被系统回收时的自愈。
     *
     * <p>{@code agent_enabled} 为 true 但服务已经不在跑，说明进程被强行停止或被 ROM 清理过
     * （这种情况 {@code onDestroy} 不会执行）。用户明明开过守护，不该因为系统回收就永久失效 ——
     * 家长也不会知道设备是怎么掉线的。所以只要打开这个界面，就把守护重新拉起来。
     */
    private void selfHealIfServiceDied() {
        if (!store.isAgentEnabled() || AgentService.isRunning()) return;
        long now = System.currentTimeMillis();
        // 短时间内不要反复尝试启动
        if (now - lastSelfHealAt < 10_000L) return;
        lastSelfHealAt = now;
        EventLog.warn("检测到守护服务未在运行，正在自动恢复");
        AgentService.start(this);
    }

    @Override
    protected void onPause() {
        EventLog.removeListener(this);
        uiHandler.removeCallbacks(uiTicker);
        super.onPause();
    }

    @Override
    public void onLogLine(EventLog.Line line) {
        renderLog();
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, @Nullable Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == REQUEST_DEVICE_ADMIN) {
            boolean active = LockController.isAdminActive(this);
            Toast.makeText(this, active ? "设备管理器已激活" : "未激活，锁屏能力将受限",
                    Toast.LENGTH_SHORT).show();
            renderState();
        }
    }

    // ============================================================
    // 渲染
    // ============================================================

    private void renderState() {
        boolean running = AgentService.isRunning();
        boolean bound = store.isBound();

        binding.textStatus.setText(running ? R.string.status_running : R.string.status_stopped);
        binding.textStatus.setTextColor(ContextCompat.getColor(this,
                running ? R.color.wechat_green : R.color.text_secondary));
        binding.buttonToggleService.setText(running ? R.string.action_stop : R.string.action_start);

        LockState lockState = LockState.compute(LockEnforcer.buildInputs(store, System.currentTimeMillis()));
        String detail = (bound ? getString(R.string.status_bound) : getString(R.string.status_unbound))
                + " · " + lockState.describe();
        binding.textDetail.setText(detail);

        binding.textDeviceCode.setText(store.getDeviceCode());
        binding.textPairingHint.setText(bound
                ? "这台设备已被家长绑定，正在接收家长端的管控指令。"
                : getString(R.string.pairing_hint));
        binding.textServer.setText(store.getBaseUrl());

        long usedSeconds = store.getUsageSecondsToday();
        int limitMinutes = store.getDailyLimitMinutes();
        String usage = JsonUtils.humanizeDuration(usedSeconds * 1000L)
                + (limitMinutes > 0 ? " / 上限 " + limitMinutes + "分钟" : " / 未设置上限");
        binding.textUsage.setText(usage);

        binding.textLockCapability.setText(getString(R.string.label_lock_capability)
                + "：" + LockController.capabilityLabel(this));

        binding.textPermissionSummary.setText(buildPermissionSummary());

        renderProtection(lockState);

        binding.buttonGrantAdmin.setEnabled(!LockController.isAdminActive(this));
        binding.buttonQuiz.setVisibility(lockState.locked ? View.VISIBLE : View.GONE);
    }

    /**
     * 渲染「防护与保活」分区。
     *
     * <p>这一块刻意只做一件事：<b>把实际生效的能力如实写出来</b>，
     * 包括降级到了哪一档、哪一项防护没生效、看门狗排没排上。
     * 家长最怕的不是锁不住，而是「以为锁住了其实没有」。
     */
    private void renderProtection(LockState lockState) {
        String requested = store.getLockStrength();
        String effective = LockCapability.effectiveStrength(this, requested);
        String requestedLabel = "password".equals(requested) ? "随机锁屏密码（最高强度）" : "Kiosk 锁定页";

        StringBuilder strength = new StringBuilder();
        strength.append("家长期望：").append(requestedLabel).append('\n');
        strength.append("本机实际：").append(LockCapability.describeEffective(this, requested));
        String degrade = LockCapability.degradeReason(this, requested);
        if (degrade != null) {
            strength.append('\n').append("降级原因：").append(degrade);
        }
        strength.append('\n').append("当前状态：").append(lockState.describe());
        if (lockState.nextLockAt > 0) {
            strength.append('\n').append("下次锁定：")
                    .append(com.balloondog.agent.capability.ScheduleEngine
                            .describeBoundary(lockState.nextLockAt, System.currentTimeMillis()));
        }
        strength.append('\n').append("Kiosk：").append(KioskController.describeState(this));
        binding.textStrengthDetail.setText(strength.toString());

        // 逐项列出防护状态，未生效的项直接显示出来
        StringBuilder hardening = new StringBuilder();
        for (String line : OwnerHardening.status(this)) {
            if (hardening.length() > 0) hardening.append('\n');
            hardening.append(line);
        }
        binding.textHardening.setText(hardening.toString());

        StringBuilder emergency = new StringBuilder();
        emergency.append(PasswordLockController.hasEmergencyPassword(store)
                ? getString(R.string.emergency_set)
                : getString(R.string.emergency_unset));
        if (PasswordLockController.isEngaged(store)) {
            emergency.append('\n').append(PasswordLockController.describeState(store));
        }
        binding.textEmergency.setText(emergency.toString());

        // 无障碍看门狗：无设备所有者时它决定「能不能被通知栏绕过」，必须显眼地写出来
        // 屏幕行为洞察：家长开关 + 本机采集授权的状态。
        // 两者必须分开显示 —— 家长开了但本机没授权，采样一样跑不起来，
        // 不写清楚的话运维只会看到「截图一直失败」。
        StringBuilder capture = new StringBuilder();
        if (!store.isCaptureEnabled()) {
            capture.append("截屏分析：家长未开启");
        } else {
            capture.append("截屏分析：已开启（每 ").append(store.getCaptureIntervalSeconds())
                    .append(" 秒一张，").append(store.getFramesPerBatch()).append(" 张一包）");
            capture.append('\n').append("采集授权：")
                    .append(com.balloondog.agent.capability.ScreenCapturer.hasProjection()
                            ? "已授权" : "未授权（点下方按钮授权）");
            capture.append('\n').append("待上传：")
                    .append(com.balloondog.agent.capability.FrameBatchUploader
                            .describePending(this, store));
            capture.append('\n').append("今日额度：游戏 ")
                    .append(store.isGameRoundsLimited()
                            ? store.getGameRoundsUsed() + "/" + store.getGameRoundsLimit() + " 局"
                            : "未限制")
                    .append("，动画 ")
                    .append(store.isVideoEpisodesLimited()
                            ? store.getVideoEpisodesUsed() + "/" + store.getVideoEpisodesLimit() + " 集"
                            : "未限制");
        }
        binding.textScreenCapture.setText(capture.toString());
        binding.buttonCaptureAuth.setEnabled(store.isCaptureEnabled());

        StringBuilder watchdog = new StringBuilder();
        watchdog.append(LockWatchdogService.describeStatus(this));
        if (LockWatchdogService.shouldRecommend(this)) {
            watchdog.append('\n').append("→ 强烈建议开启：不开启的话孩子下拉通知栏就能绕过锁定");
        }
        binding.textWatchdog.setText(watchdog.toString());
        binding.buttonEnableWatchdog.setEnabled(!LockWatchdogService.isEnabledInSettings(this));

        StringBuilder keepAlive = new StringBuilder();
        keepAlive.append("守护服务：").append(AgentService.isRunning() ? "运行中" : "未运行");
        keepAlive.append('\n').append(WatchdogScheduler.describe(this));
        keepAlive.append('\n').append(isIgnoringBatteryOptimizations()
                ? "电池优化：已加入白名单" : "电池优化：未加入白名单（息屏后可能被冻结）");
        binding.textKeepAlive.setText(keepAlive.toString());
    }

    /**
     * 设置应急解锁密码。
     *
     * <p>它是「最高强度档」的强制前提：随机改写系统密码后，
     * 一旦服务端不可用，家长只能靠它进门。所以这里会先讲清用途再收密码。
     */
    private void promptEmergencyPassword() {
        EditText input = new EditText(this);
        input.setInputType(InputType.TYPE_CLASS_NUMBER | InputType.TYPE_NUMBER_VARIATION_PASSWORD);
        input.setHint("6 位数字，家长自己记住");
        int padding = (int) (20 * getResources().getDisplayMetrics().density);
        input.setPadding(padding, padding, padding, padding);

        new AlertDialog.Builder(this)
                .setTitle(R.string.action_set_emergency)
                .setMessage("这个密码只保存在这台设备上、绝不上传服务器，用途是：\n"
                        + "当手机被「随机锁屏密码」锁住、又连不上服务器时，在锁定页输入它即可解锁。\n\n"
                        + "请务必牢记，忘记后只能恢复出厂设置。")
                .setView(input)
                .setNegativeButton("取消", null)
                .setPositiveButton("保存", (dialog, which) -> {
                    String value = input.getText().toString().trim();
                    if (value.length() < 4) {
                        Toast.makeText(this, "请设置至少 4 位", Toast.LENGTH_SHORT).show();
                        return;
                    }
                    PasswordLockController.setEmergencyPassword(this, store, value);
                    // 顺手把重置令牌装好：Android 8+ 必须先预置令牌，
                    // 之后才能在锁定瞬间改写已有密码
                    PasswordLockController.ensureResetToken(this, store);
                    Toast.makeText(this, "应急解锁密码已保存", Toast.LENGTH_SHORT).show();
                    renderState();
                })
                .show();
    }

    /** 自检并恢复：把所有保活链路和锁定副作用重新对齐一次。 */
    private void selfCheckAndHeal() {
        if (store.isHardeningEnabled()) {
            OwnerHardening.apply(this);
        }
        KioskController.prepare(this);
        WatchdogScheduler.scheduleWatchdog(this);
        if (!AgentService.isRunning()) {
            store.setAgentEnabled(true);
            AgentService.start(this);
        }
        EventLog.info("已执行自检：重排看门狗、重建 Kiosk 白名单、拉起守护服务");
        Toast.makeText(this, "自检完成，已重新拉起守护与保活链路", Toast.LENGTH_LONG).show();
        renderState();
    }

    /**
     * 请求屏幕采集授权。
     *
     * <p>家长在家长端只能「打开开关」，而 MediaProjection 的授权框必须在本机由人点一次。
     * 这里主动截一张屏来触发那次授权（成功后立刻丢掉这张图，不进入采样队列）——
     * 否则家长会看到「已开启但一直没有数据」，却不知道差在哪一步。
     */
    private void requestCaptureAuthorization() {
        Toast.makeText(this, "请在弹出的系统对话框中允许屏幕采集", Toast.LENGTH_LONG).show();
        new Thread(() -> {
            try {
                com.balloondog.agent.capability.ScreenCapturer
                        .captureScreenshotLowRes(this, 480, 45, 60_000L);
                runOnUiThread(() -> {
                    Toast.makeText(this, "屏幕采集已授权，之后会自动周期采样", Toast.LENGTH_LONG).show();
                    renderState();
                });
            } catch (Exception e) {
                runOnUiThread(() -> {
                    Toast.makeText(this, "授权未完成：" + e.getMessage(), Toast.LENGTH_LONG).show();
                    renderState();
                });
            }
        }, "balloon-capture-auth").start();
    }

    /** 跳到系统的无障碍设置页，让家长手动开启看门狗（系统不允许应用自行开启）。 */
    private void openAccessibilitySettings() {
        try {
            startActivity(new Intent(android.provider.Settings.ACTION_ACCESSIBILITY_SETTINGS));
            Toast.makeText(this,
                    "请在列表中找到「气球狗守护」并开启。\nAndroid 13 及以上若提示「受限设置」，"
                            + "需先到「应用信息 → 右上角菜单 → 允许受限设置」。",
                    Toast.LENGTH_LONG).show();
        } catch (Exception e) {
            Toast.makeText(this, "无法打开无障碍设置，请手动前往：设置 → 无障碍", Toast.LENGTH_LONG).show();
        }
    }

    /**
     * 解释为什么需要无障碍权限。
     *
     * <p>这个权限很敏感，必须把「用它做什么、不做什么」讲清楚，
     * 而不是一句「为了更好的体验」。尤其要说明紧急呼叫永远放行。
     */
    private void showWatchdogGuide() {
        new AlertDialog.Builder(this)
                .setTitle(R.string.action_watchdog_guide)
                .setMessage(
                        "没有设备所有者权限时，锁定界面是一个全屏悬浮窗。它能挡住 Home 键，"
                                + "但有两条路能绕过去：\n\n"
                                + "· 下拉通知栏（通知栏是系统窗口，层级比悬浮窗高）\n"
                                + "· 进系统设置撤销悬浮窗权限，或关掉本服务\n\n"
                                + "开启无障碍看门狗后，应用可以感知「当前前台是哪个界面」，从而：\n\n"
                                + "· 通知栏被下拉时自动收起\n"
                                + "· 系统设置被打开时推走它\n"
                                + "· 锁定界面被抢走时立刻拉回最前\n\n"
                                + "它<b>不会</b>读取你的任何输入内容、不会记录屏幕、不会联网上传。"
                                + "代码是开源的，可直接查阅 LockWatchdogService。\n\n"
                                + "紧急呼叫与来电永远放行 —— 这是不可关闭的底线。")
                .setPositiveButton("去开启", (d, w) -> openAccessibilitySettings())
                .setNegativeButton("知道了", null)
                .show();
    }

    /** 设备所有者开通指引：这是需求 1、2 能达到最强档的唯一前提。 */
    private void showOwnerGuide() {
        new AlertDialog.Builder(this)
                .setTitle(R.string.action_owner_guide)
                .setMessage(
                        "「设备所有者」是 Android 给企业管控应用的最高权限，只有它才能做到：\n\n"
                                + "· 让孩子无法卸载、无法「强行停止」本应用\n"
                                + "· 用 Lock Task 把设备钉在锁定页，Home / 通知栏全禁用\n"
                                + "· 锁定瞬间随机改写系统锁屏密码\n"
                                + "· 禁止恢复出厂设置、禁止进入安全模式\n\n"
                                + "开通方式（需一次性连接电脑，且设备尚未添加任何账号）：\n\n"
                                + "adb shell dpm set-device-owner \\\n"
                                + "  com.balloondog.agent/.capability.AgentAdminReceiver\n\n"
                                + "如果提示已有账号，需要先恢复出厂设置再执行。")
                .setPositiveButton("知道了", null)
                .show();
    }

    private String buildPermissionSummary() {
        StringBuilder sb = new StringBuilder();
        appendPermission(sb, "相机（远程拍照）", Manifest.permission.CAMERA);
        appendPermission(sb, "麦克风（远程录音）", Manifest.permission.RECORD_AUDIO);
        appendPermission(sb, "位置（行踪轨迹）", Manifest.permission.ACCESS_FINE_LOCATION);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            boolean granted = NotificationManagerCompat.from(this).areNotificationsEnabled();
            sb.append("\n通知（保持守护常驻）：")
                    .append(granted ? getString(R.string.permission_granted) : getString(R.string.permission_denied));
        }
        sb.append("\n悬浮窗（锁定时全屏遮罩）：")
                .append(LockController.canDrawOverlays(this)
                        ? getString(R.string.permission_granted) : getString(R.string.permission_denied));
        sb.append("\n电池优化白名单：")
                .append(isIgnoringBatteryOptimizations()
                        ? getString(R.string.permission_granted) : getString(R.string.permission_denied));
        // 孩子把系统定位开关关掉时，家长端只会看到「没有位置」，这里给出可操作的原因
        sb.append("\n系统定位开关：")
                .append(LocationReader.isLocationEnabled(this)
                        ? getString(R.string.permission_granted) : "已关闭（请在系统设置里打开）");
        sb.append("\n摄像头：").append(PhotoCapturer.describeCameras(this));
        return sb.toString();
    }

    private void appendPermission(StringBuilder sb, String label, String permission) {
        boolean granted = ContextCompat.checkSelfPermission(this, permission)
                == PackageManager.PERMISSION_GRANTED;
        if (sb.length() > 0) sb.append('\n');
        sb.append(label).append("：")
                .append(granted ? getString(R.string.permission_granted) : getString(R.string.permission_denied));
    }

    private void renderLog() {
        SpannableStringBuilder builder = new SpannableStringBuilder();
        for (EventLog.Line line : EventLog.snapshot()) {
            int start = builder.length();
            builder.append(line.render()).append('\n');
            builder.setSpan(new ForegroundColorSpan(colorFor(line.level)),
                    start, builder.length(), Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
        }
        if (builder.length() == 0) {
            builder.append("暂无日志。启动守护后这里会显示注册、心跳、指令执行的完整过程。");
        }
        binding.textLog.setText(builder);
    }

    private int colorFor(EventLog.Level level) {
        switch (level) {
            case SUCCESS:
                return ContextCompat.getColor(this, R.color.log_success);
            case WARN:
                return ContextCompat.getColor(this, R.color.log_warn);
            case ERROR:
                return ContextCompat.getColor(this, R.color.log_error);
            default:
                return ContextCompat.getColor(this, R.color.log_info);
        }
    }

    // ============================================================
    // 操作
    // ============================================================

    private void toggleService() {
        if (AgentService.isRunning()) {
            AgentService.stop(this);
            store.setAgentEnabled(false);
            Toast.makeText(this, "已停止守护", Toast.LENGTH_SHORT).show();
        } else {
            store.setAgentEnabled(true);
            AgentService.start(this);
            Toast.makeText(this, "已启动守护", Toast.LENGTH_SHORT).show();
        }
        // 服务状态变化与界面刷新之间有毫秒级延迟，交给 uiTicker 在 2 秒内自然收敛
    }

    private void requestRuntimePermissions() {
        List<String> permissions = new ArrayList<>();
        permissions.add(Manifest.permission.CAMERA);
        permissions.add(Manifest.permission.RECORD_AUDIO);
        permissions.add(Manifest.permission.ACCESS_FINE_LOCATION);
        permissions.add(Manifest.permission.ACCESS_COARSE_LOCATION);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            permissions.add("android.permission.POST_NOTIFICATIONS");
        }
        runtimePermissionLauncher.launch(permissions.toArray(new String[0]));
    }

    private boolean isIgnoringBatteryOptimizations() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return true;
        PowerManager manager = (PowerManager) getSystemService(Context.POWER_SERVICE);
        return manager != null && manager.isIgnoringBatteryOptimizations(getPackageName());
    }

    /**
     * 申请电池优化白名单。
     *
     * <p>不做这一步的话，国产 ROM 与 Doze 会在息屏几分钟后冻结长轮询，
     * 表现就是「家长点锁屏，孩子手机半天没反应」。
     */
    private void requestIgnoreBatteryOptimization() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) {
            Toast.makeText(this, "当前系统无需设置", Toast.LENGTH_SHORT).show();
            return;
        }
        if (isIgnoringBatteryOptimizations()) {
            Toast.makeText(this, "已在电池优化白名单中", Toast.LENGTH_SHORT).show();
            return;
        }
        try {
            Intent intent = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
            intent.setData(Uri.parse("package:" + getPackageName()));
            startActivity(intent);
        } catch (Exception e) {
            // 部分 ROM 屏蔽了这个 Action，退回到电池优化列表页
            try {
                startActivity(new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS));
            } catch (Exception inner) {
                Toast.makeText(this, "请手动在系统设置里允许后台运行", Toast.LENGTH_LONG).show();
            }
        }
    }
}
