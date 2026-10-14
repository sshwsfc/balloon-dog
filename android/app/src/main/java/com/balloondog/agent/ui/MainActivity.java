package com.balloondog.agent.ui;

import android.Manifest;
import android.app.PendingIntent;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.net.Uri;
import android.net.VpnService;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.text.InputType;
import android.provider.Settings;
import android.text.SpannableStringBuilder;
import android.text.Spanned;
import android.text.TextUtils;
import android.text.style.ForegroundColorSpan;
import android.view.LayoutInflater;
import android.view.View;
import android.widget.EditText;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.annotation.Nullable;
import androidx.appcompat.app.AlertDialog;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;

import com.balloondog.agent.R;
import com.balloondog.agent.capability.AppUsageTracker;
import com.balloondog.agent.capability.KioskController;
import com.balloondog.agent.capability.LockCapability;
import com.balloondog.agent.capability.LockController;
import com.balloondog.agent.capability.LockEnforcer;
import com.balloondog.agent.capability.LockState;
import com.balloondog.agent.capability.LocationReader;
import com.balloondog.agent.capability.OwnerHardening;
import com.balloondog.agent.capability.PasswordLockController;
import com.balloondog.agent.capability.PermissionGranter;
import com.balloondog.agent.capability.PhotoCapturer;
import com.balloondog.agent.capability.ScreenCapturer;
import com.balloondog.agent.data.AgentStore;
import com.balloondog.agent.data.EventLog;
import com.balloondog.agent.databinding.ActivityMainBinding;
import com.balloondog.agent.databinding.ItemPermissionRowBinding;
import com.balloondog.agent.model.JsonUtils;
import com.balloondog.agent.service.AgentService;
import com.balloondog.agent.service.DnsFilterVpnService;
import com.balloondog.agent.service.LockWatchdogService;
import com.balloondog.agent.service.LongevityGuard;
import com.google.android.material.button.MaterialButton;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Agent 的主界面：任务导向的引导页。
 *
 * <p>这台设备平时由孩子使用，孩子打开它时最常问的是「我现在该干什么」，
 * 所以界面按待办顺序排列：先看守护在不在跑 → 没绑定就引导绑定 →
 * 逐项列出还没开的权限（带原因和实时状态徽标）→ 应急解锁 →
 * 排查用的诊断信息全部收进「高级 / 诊断」折叠区。
 *
 * <p>权限状态一律<b>现场读取</b>（{@code renderState()} 每 2 秒跑一次，
 * 每次授权动作、{@code onResume()} 之后也会重跑），不做任何缓存，
 * 避免出现「界面写着已开启、其实早就被系统撤销」这种家长照着折腾半天也没用的情况。
 */
public class MainActivity extends AppCompatActivity implements EventLog.Listener {

    private static final int REQUEST_DEVICE_ADMIN = 0x1001;

    /** 绑定码二维码的展示边长，与 activity_main.xml 里 imageDeviceCodeQr 的尺寸保持一致。 */
    private static final int DEVICE_CODE_QR_SIZE_DP = 166;

    /** 待办清单的固定项 id —— 数组下标即显示顺序。 */
    private static final int TODO_OWNER = 0;
    private static final int TODO_ACCESSIBILITY = 1;
    private static final int TODO_RUNTIME = 2;
    private static final int TODO_OVERLAY = 3;
    private static final int TODO_USAGE = 4;
    private static final int TODO_BATTERY = 5;
    private static final int TODO_CAPTURE = 6;
    private static final int TODO_VPN = 7;
    private static final int TODO_COUNT = 8;

    /** 「使用情况访问」不是运行时权限，走 AppOps，这里给它一个名字常量。 */
    private static final String PERMISSION_USAGE_STATS = "android.permission.PACKAGE_USAGE_STATS";

    /** 清单进度只统计「必备项」——可选项不该拉低分母，让家长看着像永远做不完。 */
    private static final int REQUIRED_TODO_COUNT = 6;

    /** 徽标配色：绿=已开启、灰=未开启、琥珀=可选/启动中。 */
    private static final int BADGE_OK = 0;
    private static final int BADGE_OFF = 1;
    private static final int BADGE_WARN = 2;

    private ActivityMainBinding binding;
    private AgentStore store;
    /** 已画到界面上的绑定码，用来避免 uiTicker 每 2 秒重复生成同一张二维码位图。 */
    private String renderedQrCode;
    /** 上次尝试自愈的时间，避免 onResume 被反复触发时重复启动服务。 */
    private long lastSelfHealAt;

    /** 待办清单每一行的视图句柄；renderState() 只改文字与背景，不重建视图。 */
    private final TodoRow[] todoRows = new TodoRow[TODO_COUNT];
    /** 「一键开启权限」跨系统弹框续跑：运行时权限弹框返回后还要接着开悬浮窗与电池白名单。 */
    private boolean oneKeyAwaitingRuntimeDialog;

    /** 一行待办的视图句柄。 */
    private static final class TodoRow {
        final ImageView icon;
        final TextView name;
        final TextView reason;
        final TextView badge;
        final MaterialButton action;

        TodoRow(ItemPermissionRowBinding row) {
            this.icon = row.imageTodoIcon;
            this.name = row.textTodoName;
            this.reason = row.textTodoReason;
            this.badge = row.textTodoBadge;
            this.action = row.buttonTodoAction;
        }
    }

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
                        if (oneKeyAwaitingRuntimeDialog) {
                            oneKeyAwaitingRuntimeDialog = false;
                            continueOneKeyGrant();
                        }
                    });

    /** 开悬浮窗、使用情况访问这些「特殊权限」时跳系统设置页，回来要重新读状态。 */
    private final ActivityResultLauncher<Intent> specialGrantLauncher =
            registerForActivityResult(new ActivityResultContracts.StartActivityForResult(),
                    result -> renderState());

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

        // 首页新增：绑定码复制、一键开启权限、高级折叠
        binding.buttonCopyCode.setOnClickListener(v -> copyDeviceCode());
        binding.buttonOneKeyGrant.setOnClickListener(v -> runOneKeyGrant());
        binding.buttonAdvancedToggle.setOnClickListener(v -> toggleAdvanced());

        buildTodoRows();
    }

    /**
     * 建好待办清单的 7 行。
     *
     * <p>视图只建一次，之后每次 {@code renderState()} 只改文字、颜色与按钮可用性 ——
     * 每 2 秒重建一遍整棵视图树既费电又会打断正在滚动的手指。
     */
    private void buildTodoRows() {
        LinearLayout container = binding.containerTodo;
        container.removeAllViews();
        LayoutInflater inflater = getLayoutInflater();
        for (int id = 0; id < TODO_COUNT; id++) {
            ItemPermissionRowBinding row = ItemPermissionRowBinding.inflate(inflater, container, false);
            todoRows[id] = new TodoRow(row);
            final int todoId = id;
            row.buttonTodoAction.setOnClickListener(v -> onTodoAction(todoId));
            row.rowTodoBody.setOnClickListener(v -> showTodoDetail(todoId));
            // 最后一行不画分隔线，免得卡片底部多出一条悬空的线
            row.dividerTodo.setVisibility(id == TODO_COUNT - 1 ? View.GONE : View.VISIBLE);
            container.addView(row.getRoot());
        }
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

    /**
     * 把绑定码画成二维码，显示在绑定码文字下方，家长端「扫一扫」即可自动填入。
     *
     * <p>只在绑定码真的变了才重新生成：renderState() 由 uiTicker 每 2 秒调一次，
     * 每次都重建位图纯属浪费 —— 编码加上逐像素填充，在低端机上会有肉眼可见的一下卡顿。
     *
     * <p>生成失败时把二维码隐藏掉，而不是留一个空白框：绑定码文字始终在，
     * 家长照样能手输，不值得为一张画不出来的图再弹一次错误。
     */
    private void renderDeviceCodeQr(String code) {
        if (code == null || code.isEmpty() || code.equals(renderedQrCode)) return;
        renderedQrCode = code;

        // dp → px：ImageView 是按 dp 定尺寸的，位图必须按像素密度放大，
        // 否则在高密度屏上会被拉伸、码点边缘发虚，影响扫码识别率。
        int sizePx = Math.round(DEVICE_CODE_QR_SIZE_DP * getResources().getDisplayMetrics().density);
        Bitmap qr = DeviceCodeQr.render(code, sizePx);
        if (qr == null) {
            binding.imageDeviceCodeQr.setVisibility(View.GONE);
            return;
        }
        binding.imageDeviceCodeQr.setImageBitmap(qr);
        binding.imageDeviceCodeQr.setVisibility(View.VISIBLE);
    }

    private void renderState() {
        boolean running = AgentService.isRunning();
        boolean bound = store.isBound();

        // ---- 状态头：一句话说清「守护在不在跑」 ----
        binding.textStatus.setText(running ? R.string.status_running : R.string.status_stopped);
        binding.textStatus.setTextColor(ContextCompat.getColor(this,
                running ? R.color.wechat_green : R.color.text_secondary));
        binding.imageStatusIcon.setColorFilter(ContextCompat.getColor(this,
                running ? R.color.wechat_green : R.color.text_tertiary));
        binding.buttonToggleService.setText(running ? R.string.action_stop : R.string.action_start);

        LockState lockState = LockState.compute(LockEnforcer.buildInputs(store, System.currentTimeMillis()));
        binding.textDetail.setText(buildStatusDetail(bound, lockState));

        renderBindingCard(bound);

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
        renderTodoList();

        binding.buttonGrantAdmin.setEnabled(!LockController.isAdminActive(this));
        binding.buttonQuiz.setVisibility(lockState.locked ? View.VISIBLE : View.GONE);
    }

    /** 状态头下面的一行摘要：绑定情况 + 今日用量 +（锁定中）。只留关键词，不写整句。 */
    private String buildStatusDetail(boolean bound, LockState lockState) {
        StringBuilder sb = new StringBuilder();
        sb.append(getString(bound ? R.string.status_bound : R.string.status_unbound));
        sb.append(" · ").append(getString(R.string.status_detail_usage,
                JsonUtils.humanizeDuration(store.getUsageSecondsToday() * 1000L)));
        if (lockState.locked) {
            sb.append(" · ").append(getString(R.string.status_locked_now));
        }
        return sb.toString();
    }

    /**
     * 绑定卡片：未绑定 → 大字绑定码 + 二维码 + 操作步骤；已绑定 → 压成一行。
     *
     * <p>已绑定时刻意不显示二维码：绑定码是长期凭证，绑定之后还摆在首页最显眼的位置
     * 没有意义，反而挡住了待办清单。
     */
    private void renderBindingCard(boolean bound) {
        binding.groupUnboundGuide.setVisibility(bound ? View.GONE : View.VISIBLE);
        binding.groupBoundInfo.setVisibility(bound ? View.VISIBLE : View.GONE);

        String deviceCode = store.getDeviceCode();
        boolean hasCode = !TextUtils.isEmpty(deviceCode);
        binding.textDeviceCode.setText(hasCode ? deviceCode : "—");

        if (!bound) {
            renderDeviceCodeQr(deviceCode);
            binding.textBindSubtitle.setText(R.string.binding_unbound_subtitle);
            binding.textPairingHint.setText(R.string.binding_step_short);
            binding.buttonCopyCode.setEnabled(hasCode);
            return;
        }

        String name = store.getDeviceName();
        binding.textBoundSummary.setText(TextUtils.isEmpty(name)
                ? getString(R.string.binding_bound_title)
                : getString(R.string.binding_bound_named, name));
        binding.textBoundCode.setText(getString(R.string.binding_bound_device,
                hasCode ? deviceCode : "—"));
        binding.textBoundTip.setText(R.string.binding_bound_tip);
    }

    /** 把绑定码放进剪贴板，家长端可以直接粘贴。 */
    private void copyDeviceCode() {
        String code = store.getDeviceCode();
        if (TextUtils.isEmpty(code)) {
            Toast.makeText(this, R.string.toast_code_missing, Toast.LENGTH_SHORT).show();
            return;
        }
        ClipboardManager manager = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
        if (manager != null) {
            manager.setPrimaryClip(ClipData.newPlainText(
                    getString(R.string.label_device_code), code));
        }
        Toast.makeText(this, getString(R.string.toast_code_copied, code), Toast.LENGTH_SHORT).show();
    }

    /** 折叠 / 展开「高级 / 诊断」。 */
    private void toggleAdvanced() {
        boolean show = binding.groupAdvanced.getVisibility() != View.VISIBLE;
        binding.groupAdvanced.setVisibility(show ? View.VISIBLE : View.GONE);
        binding.imageAdvancedArrow.setRotation(show ? 180f : 0f);
        binding.textAdvancedState.setText(show ? R.string.action_collapse : R.string.action_expand);
        if (show) renderState();
    }

    // ============================================================
    // 待办清单：7 项权限，状态全部现读
    // ============================================================

    /**
     * 无障碍开关是否已开。
     *
     * <p>先问 {@link LockWatchdogService#isEnabledInSettings(Context)}（权威判据）；
     * 只有它为假时，才补读一次系统开关字符串。原因是服务重连的那几秒，
     * {@code AccessibilityManager.getEnabledAccessibilityServiceList()} 会短暂返回空，
     * 只按它判断会把「已开启」误报成「未开启」，还会连带把「一键开启权限」按钮点灰。
     * 补读只做加法：真关了开关时两边都是假，不会把关闭误报成开启。
     */
    private boolean isAccessibilityEnabledInSettings() {
        if (LockWatchdogService.isEnabledInSettings(this)) return true;
        try {
            String enabled = Settings.Secure.getString(getContentResolver(),
                    Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES);
            return enabled != null && enabled.contains(
                    getPackageName() + "/" + LockWatchdogService.class.getName());
        } catch (Exception e) {
            return false;
        }
    }

    /**
     * 渲染「需要开启」清单。
     *
     * <p>这里<b>不缓存任何一项状态</b>：无障碍问 {@link LockWatchdogService}、
     * 运行时权限问 {@link PermissionGranter}、使用情况访问走 AppOps 查询。
     * 所以家长刚在系统设置里开完返回、或者外部用 {@code appops} 撤销，
     * 界面都会在下一次 {@link #renderState()} 里如实翻过来。
     */
    private void renderTodoList() {
        boolean accessibilityOn = isAccessibilityEnabledInSettings();
        boolean accessibilityConnected = LockWatchdogService.isConnected();

        // 0. 设备所有者：防卸载、防强行停止的唯一前提，所以放第一位
        boolean ownerOn = LockController.isDeviceOwner(this);
        TodoRow owner = todoRows[TODO_OWNER];
        setTodoBasics(owner, R.drawable.ic_shield,
                R.string.todo_name_owner, R.string.todo_reason_owner);
        setTodoBadge(owner, ownerOn ? R.string.badge_on : R.string.badge_off,
                ownerOn ? BADGE_OK : BADGE_OFF);
        setTodoAction(owner, ownerOn);
        // 这一项没开就必须写在明面上：清单里其余项全绿也挡不住卸载
        binding.textTodoAlert.setVisibility(ownerOn ? View.GONE : View.VISIBLE);

        // 1. 无障碍：所有拦截动作的前提
        TodoRow accessibility = todoRows[TODO_ACCESSIBILITY];
        setTodoBasics(accessibility, R.drawable.ic_accessibility,
                R.string.todo_name_accessibility, R.string.todo_reason_accessibility);
        if (accessibilityOn && accessibilityConnected) {
            setTodoBadge(accessibility, R.string.badge_on, BADGE_OK);
        } else if (accessibilityOn) {
            // 开关开了但服务还没连上：别急着说「已开启」，家长会以为在生效了
            setTodoBadge(accessibility, R.string.badge_starting, BADGE_WARN);
        } else {
            setTodoBadge(accessibility, R.string.badge_off, BADGE_OFF);
        }
        setTodoAction(accessibility, accessibilityOn);

        // 2. 运行时权限：合成一行显示 N/M，点开看逐项
        List<String> required = PermissionGranter.requiredPermissions();
        int grantedCount = required.size() - PermissionGranter.missing(this).size();
        boolean runtimeDone = grantedCount >= required.size();
        TodoRow runtime = todoRows[TODO_RUNTIME];
        setTodoBasics(runtime, R.drawable.ic_key,
                R.string.todo_name_runtime, R.string.todo_reason_runtime);
        setTodoBadge(runtime, getString(R.string.todo_progress, grantedCount, required.size()),
                runtimeDone ? BADGE_OK : BADGE_OFF);
        setTodoAction(runtime, runtimeDone);

        // 3. 悬浮窗
        boolean overlayOn = Settings.canDrawOverlays(this);
        TodoRow overlay = todoRows[TODO_OVERLAY];
        setTodoBasics(overlay, R.drawable.ic_overlay,
                R.string.todo_name_overlay, R.string.todo_reason_overlay);
        setTodoBadge(overlay, overlayOn ? R.string.badge_on : R.string.badge_off,
                overlayOn ? BADGE_OK : BADGE_OFF);
        setTodoAction(overlay, overlayOn);

        // 4. 使用情况访问
        boolean usageOn = PermissionGranter.isSpecialGranted(this, PERMISSION_USAGE_STATS);
        TodoRow usage = todoRows[TODO_USAGE];
        setTodoBasics(usage, R.drawable.ic_usage,
                R.string.todo_name_usage, R.string.todo_reason_usage);
        setTodoBadge(usage, usageOn ? R.string.badge_on : R.string.badge_off,
                usageOn ? BADGE_OK : BADGE_OFF);
        setTodoAction(usage, usageOn);

        // 5. 电池优化白名单：M 以下这个系统概念不存在，如实写「本机不支持」
        boolean batterySupported = Build.VERSION.SDK_INT >= Build.VERSION_CODES.M;
        boolean batteryOn = isIgnoringBatteryOptimizations();
        TodoRow battery = todoRows[TODO_BATTERY];
        setTodoBasics(battery, R.drawable.ic_battery,
                R.string.todo_name_battery, R.string.todo_reason_battery);
        if (batterySupported) {
            setTodoBadge(battery, batteryOn ? R.string.badge_on : R.string.badge_off,
                    batteryOn ? BADGE_OK : BADGE_OFF);
        } else {
            setTodoBadge(battery, R.string.badge_unsupported, BADGE_OFF);
        }
        setTodoAction(battery, batteryOn || !batterySupported);

        // 6. 屏幕采集（可选）：家长没开就是「可选」，不是「未开启」，别制造焦虑
        boolean captureOn = store.isCaptureEnabled() && ScreenCapturer.hasProjection();
        TodoRow capture = todoRows[TODO_CAPTURE];
        setTodoBasics(capture, R.drawable.ic_screen,
                R.string.todo_name_capture, R.string.todo_reason_capture);
        setTodoBadge(capture, captureOn ? R.string.badge_on : R.string.badge_optional,
                captureOn ? BADGE_OK : BADGE_WARN);
        setTodoAction(capture, captureOn);

        // 7. 网址拦截 VPN（可选）：家长配了黑名单却还没授权，那才算「未开启」
        boolean vpnOn = DnsFilterVpnService.hasSystemConsent(this);
        boolean vpnWanted = DnsFilterVpnService.isWanted(this);
        TodoRow vpn = todoRows[TODO_VPN];
        setTodoBasics(vpn, R.drawable.ic_globe, R.string.todo_name_vpn, R.string.todo_reason_vpn);
        if (vpnOn) {
            setTodoBadge(vpn, R.string.badge_on, BADGE_OK);
        } else if (vpnWanted) {
            setTodoBadge(vpn, R.string.badge_off, BADGE_OFF);
        } else {
            setTodoBadge(vpn, R.string.badge_optional, BADGE_WARN);
        }
        setTodoAction(vpn, vpnOn);

        int doneRequired = (ownerOn ? 1 : 0) + (accessibilityOn ? 1 : 0) + (runtimeDone ? 1 : 0)
                + (overlayOn ? 1 : 0) + (usageOn ? 1 : 0) + (batteryOn ? 1 : 0);
        renderOneKeyButton(accessibilityOn, ownerOn, doneRequired);
    }

    /**
     * 清单头部的进度与「一键开启权限」按钮。
     *
     * <p>用户明确要求：<b>无障碍是前提</b>。所以无障碍没开时按钮直接置灰，
     * 并在旁边写清原因 —— 不置灰的话，家长点了只会看到一串「需要手动开启」，
     * 却不知道为什么，体验比不给按钮还差。
     */
    private void renderOneKeyButton(boolean accessibilityOn, boolean ownerOn, int doneRequired) {
        binding.textTodoProgress.setText(getString(R.string.todo_progress,
                doneRequired, REQUIRED_TODO_COUNT));
        // 设备所有者不在「一键开启」能力范围内（必须在设备未添加账号时用 adb 设置），
        // 所以判「其余项都开好了」时要把它排除在外，否则会永远显示「还有活没干完」。
        boolean restDone = doneRequired >= REQUIRED_TODO_COUNT - (ownerOn ? 0 : 1);
        if (!accessibilityOn) {
            binding.buttonOneKeyGrant.setEnabled(false);
            binding.buttonOneKeyGrant.setText(R.string.action_one_key_grant);
            binding.textOneKeyHint.setText(R.string.one_key_hint_need_accessibility);
        } else if (restDone && !ownerOn) {
            // 其余权限都齐了、只差设备所有者：按钮没活可干（置灰），但不能说「已全部开启」
            binding.buttonOneKeyGrant.setEnabled(false);
            binding.buttonOneKeyGrant.setText(R.string.action_one_key_grant);
            binding.textOneKeyHint.setText(R.string.one_key_hint_need_owner);
        } else if (restDone) {
            binding.buttonOneKeyGrant.setEnabled(false);
            binding.buttonOneKeyGrant.setText(R.string.action_one_key_done);
            binding.textOneKeyHint.setText(R.string.one_key_hint_all_done);
        } else {
            binding.buttonOneKeyGrant.setEnabled(true);
            binding.buttonOneKeyGrant.setText(R.string.action_one_key_grant);
            binding.textOneKeyHint.setText(R.string.one_key_hint_ready);
        }
    }

    private void setTodoBasics(TodoRow row, int iconRes, int nameRes, int reasonRes) {
        row.icon.setImageResource(iconRes);
        row.name.setText(nameRes);
        row.reason.setText(reasonRes);
    }

    private void setTodoBadge(TodoRow row, int textRes, int style) {
        setTodoBadge(row, getString(textRes), style);
    }

    private void setTodoBadge(TodoRow row, String text, int style) {
        int background;
        int color;
        switch (style) {
            case BADGE_OK:
                background = R.drawable.bg_badge_ok;
                color = R.color.wechat_green_dark;
                break;
            case BADGE_WARN:
                background = R.drawable.bg_badge_warn;
                color = R.color.warning_amber;
                break;
            default:
                background = R.drawable.bg_badge_off;
                color = R.color.text_secondary;
                break;
        }
        row.badge.setText(text);
        row.badge.setBackgroundResource(background);
        row.badge.setTextColor(ContextCompat.getColor(this, color));
    }

    /**
     * 已开启的行：按钮变「已开启 ✓」并置灰，图标染绿。
     *
     * <p>置灰而不是把按钮藏起来 —— 藏起来会让人怀疑「到底有没有这一项」。
     */
    private void setTodoAction(TodoRow row, boolean done) {
        row.action.setText(done ? R.string.action_granted_tick : R.string.action_open_now);
        row.action.setEnabled(!done);
        row.icon.setColorFilter(ContextCompat.getColor(this,
                done ? R.color.wechat_green : R.color.text_secondary));
    }

    /** 某一行的操作按钮。 */
    private void onTodoAction(int id) {
        switch (id) {
            case TODO_OWNER:
                // 这一项没有应用内开关：设备所有者只能在设备尚未添加任何账号时用 adb 设置，
                // 所以「去开启」给的是操作指引，不是跳系统页面。
                showOwnerGuide();
                break;
            case TODO_ACCESSIBILITY:
                openAccessibilitySettings();
                break;
            case TODO_RUNTIME:
                if (PermissionGranter.missing(this).isEmpty()) {
                    // 全部授权过还点进来，多半是某项被系统撤了却弹不出框，只能去应用信息页
                    PermissionGranter.openAppDetails(this);
                } else {
                    requestRuntimePermissions();
                }
                break;
            case TODO_OVERLAY:
                LockController.requestOverlayPermission(this);
                break;
            case TODO_USAGE:
                AppUsageTracker.openSettings(this);
                break;
            case TODO_BATTERY:
                requestIgnoreBatteryOptimization();
                break;
            case TODO_CAPTURE:
                requestCaptureAuthorization();
                break;
            case TODO_VPN:
                requestVpnConsent();
                break;
            default:
                break;
        }
    }

    /** 拉起系统的 VPN 授权页（网址拦截用）。 */
    private void requestVpnConsent() {
        try {
            Intent intent = VpnService.prepare(this);
            if (intent == null) {
                // 已经授权过了，系统不再需要弹框
                Toast.makeText(this, R.string.toast_vpn_already, Toast.LENGTH_SHORT).show();
                renderState();
                return;
            }
            specialGrantLauncher.launch(intent);
        } catch (Exception e) {
            EventLog.warn("无法打开 VPN 授权页：" + e.getMessage());
            Toast.makeText(this, R.string.toast_vpn_unavailable, Toast.LENGTH_LONG).show();
        }
    }

    /**
     * 点一行看详情：运行时权限列出逐项状态，其余项显示原因 + 当前状态。
     *
     * <p>状态直接复用刚刚渲染出来的徽标文字，而不是重新判一遍 ——
     * 重新判一遍就有两处判据，早晚会出现「徽标说已开启、弹框说未开启」。
     */
    private void showTodoDetail(int id) {
        TodoRow row = todoRows[id];
        if (row == null) return;

        AlertDialog.Builder builder = new AlertDialog.Builder(this);
        boolean allDone;
        if (id == TODO_RUNTIME) {
            builder.setTitle(row.name.getText());
            StringBuilder sb = new StringBuilder();
            // 同一个中文名可能对应多条权限（精确定位 + 粗略定位），合并成一行，
            // 免得家长看到两行一模一样的「定位：已开启」，以为界面重复渲染了。
            Map<String, Boolean> byLabel = new LinkedHashMap<>();
            for (String permission : PermissionGranter.requiredPermissions()) {
                boolean granted = ContextCompat.checkSelfPermission(this, permission)
                        == PackageManager.PERMISSION_GRANTED;
                String label = PermissionGranter.labelOf(permission);
                Boolean seen = byLabel.get(label);
                byLabel.put(label, seen == null ? granted : (seen || granted));
            }
            int missingInDialog = 0;
            for (Map.Entry<String, Boolean> entry : byLabel.entrySet()) {
                if (sb.length() > 0) sb.append('\n');
                sb.append(getString(entry.getValue() ? R.string.dialog_permission_line_on
                        : R.string.dialog_permission_line_off, entry.getKey()));
                if (!entry.getValue()) missingInDialog++;
            }
            builder.setMessage(sb.toString());
            allDone = missingInDialog == 0;
        } else {
            builder.setTitle(row.name.getText());
            builder.setMessage(row.reason.getText() + "\n\n"
                    + getString(R.string.dialog_todo_status_line, row.badge.getText()));
            // 这一项已经开好了：按钮本来就置灰，弹框里再摆一个「去开启」只会让人点空
            allDone = !row.action.isEnabled();
        }
        if (allDone) {
            builder.setPositiveButton(R.string.dialog_action_ok, null);
        } else {
            builder.setPositiveButton(R.string.action_open_now, (dialog, which) -> onTodoAction(id));
            builder.setNegativeButton(R.string.dialog_action_later, null);
        }
        builder.show();
    }

    // ============================================================
    // 一键开启权限
    // ============================================================

    /**
     * 「一键开启权限」。
     *
     * <p>前提是无障碍必须先开（用户明确要求）：锁定、拦截、限时全都靠无障碍执行，
     * 无障碍没开的时候把别的权限提前开完，只会让家长误以为已经生效。
     *
     * <p>顺序：设备所有者静默代授运行时权限 → 弹不出框就走系统弹框兜底 →
     * 悬浮窗 / 使用情况访问 → 电池白名单。每一步都<b>如实</b>汇报，
     * 拿不到的直接说「还需要手动开启 N 项」，绝不谎报成功。
     */
    private void runOneKeyGrant() {
        if (!isAccessibilityEnabledInSettings()) {
            Toast.makeText(this, R.string.toast_one_key_need_accessibility, Toast.LENGTH_SHORT).show();
            renderState();
            return;
        }

        boolean deviceOwner = LockController.isDeviceOwner(this);
        int grantedByOwner = PermissionGranter.grantAsDeviceOwner(this);
        int missingCount = PermissionGranter.missing(this).size();
        if (missingCount > 0) {
            // 只能靠系统弹框；等用户点完回来再继续后面的步骤
            oneKeyAwaitingRuntimeDialog = true;
            Toast.makeText(this, deviceOwner
                            ? getString(R.string.toast_one_key_partial, missingCount)
                            : getString(R.string.toast_one_key_dialog),
                    Toast.LENGTH_LONG).show();
            requestRuntimePermissions();
            return;
        }
        if (grantedByOwner > 0) {
            Toast.makeText(this, R.string.toast_one_key_owner, Toast.LENGTH_SHORT).show();
        }
        continueOneKeyGrant();
    }

    /** 一键开启的后半程：特殊权限 + 电池白名单，最后如实汇总还差几项。 */
    private void continueOneKeyGrant() {
        PermissionGranter.grantSpecialAsDeviceOwner(this);
        renderState();

        int manual = PermissionGranter.missing(this).size()
                + (Settings.canDrawOverlays(this) ? 0 : 1)
                + (PermissionGranter.isSpecialGranted(this, PERMISSION_USAGE_STATS) ? 0 : 1);
        boolean batteryNeeded = Build.VERSION.SDK_INT >= Build.VERSION_CODES.M
                && !isIgnoringBatteryOptimizations();

        if (manual == 0 && !batteryNeeded) {
            Toast.makeText(this, R.string.toast_one_key_all_done, Toast.LENGTH_SHORT).show();
        } else if (manual == 0) {
            Toast.makeText(this, R.string.toast_one_key_battery_last, Toast.LENGTH_SHORT).show();
        } else {
            // 「悬浮窗」和「使用情况访问」在多数 ROM 上系统拒绝代授，只能手动开 —— 如实说
            Toast.makeText(this, getString(R.string.toast_one_key_partial, manual),
                    Toast.LENGTH_LONG).show();
        }

        if (batteryNeeded) {
            requestIgnoreBatteryOptimization();
        }
        renderState();
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
        // 敏感界面封锁单独写一行：系统里没有「禁止打开系统设置」这条限制，它是无障碍
        // 盯前台窗口追出来的，所以不能和上面那些真正的设备所有者限制混在一起，
        // 而且必须写明「是拦截、有延迟」。
        if (hardening.length() > 0) hardening.append('\n');
        hardening.append(store.isHardeningEnabled()
                ? "敏感界面封锁：已开启 —— 进入系统设置 / 应用管理 / 卸载界面会自动退回桌面"
                        + "（拦截有约 0.1 秒延迟，不是设备所有者限制）"
                : "敏感界面封锁：已关闭（「管控加固」关着）");
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
        // 长活状态统一由 LongevityGuard.describe 给：守护服务、电池白名单、无障碍看门狗、
        // 受保护包（禁止强停/清数据），再加上当前所有「孩子能绕过」的缺口。
        // 这里刻意不自己拼字符串，否则界面与设备级断言会各说各话。
        keepAlive.append(LongevityGuard.describe(this, store));
        binding.textKeepAlive.setText(keepAlive.toString());
        binding.buttonBattery.setEnabled(!isIgnoringBatteryOptimizations());
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
        // 直接交给 LongevityGuard：它做的是同一套事（加固 + 授权 + 双看门狗 + 巡检上报），
        // 并且会把「哪一项没做到」写进日志、上报成 tamper 事件。
        // 在这里重复实现一遍只会让自检结果与后台自愈结果不一致。
        String summary = LongevityGuard.selfHeal(this, store, "家长手动自检");
        KioskController.prepare(this);
        if (!AgentService.isRunning()) {
            store.setAgentEnabled(true);
            AgentService.start(this);
        }
        Toast.makeText(this, "自检完成：" + summary, Toast.LENGTH_LONG).show();
        renderState();
    }

    /**
     * 请求屏幕采集授权。
     *
     * <p>两条路径已经不一样了：无障碍服务在跑（API 30+）时，截图走
     * {@code AccessibilityService.takeScreenshot()}，<b>完全不需要任何系统弹框</b>，
     * 这个按钮只是试拍一张确认链路可用；只有当无障碍不可用时才会回退到 MediaProjection，
     * 那时才必须在本机由人点一次授权框 —— 否则家长会看到「已开启但一直没有数据」，
     * 却不知道差在哪一步。
     */
    private void requestCaptureAuthorization() {
        boolean free = com.balloondog.agent.capability.AccessibilityScreenCapture.isAvailable();
        Toast.makeText(this, free
                ? "优先使用无障碍免授权截图（失败才会弹系统授权框）"
                : "请在弹出的系统对话框中允许屏幕采集", Toast.LENGTH_LONG).show();
        new Thread(() -> {
            try {
                com.balloondog.agent.capability.ScreenCapturer
                        .captureScreenshotLowRes(this, 480, 45, 60_000L);
                runOnUiThread(() -> {
                    Toast.makeText(this, free
                            ? "屏幕采集可用（无障碍免授权），之后会自动周期采样"
                            : "屏幕采集已授权，之后会自动周期采样", Toast.LENGTH_LONG).show();
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
            // 加固开启时这一页默认会被看门狗按返回推走（否则孩子也能进来关掉它），
            // 所以先开一张限时通行证 —— 见 SensitiveScreens 里「没有家长身份验证，
            // 应用内放行按钮不是安全边界」的说明。
            com.balloondog.agent.capability.SensitiveScreens.allowTemporarily(this,
                    com.balloondog.agent.capability.SensitiveScreens.HINT_ACCESSIBILITY);
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
            com.balloondog.agent.capability.SensitiveScreens.allowTemporarily(this,
                    com.balloondog.agent.capability.SensitiveScreens.HINT_GENERIC);
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
