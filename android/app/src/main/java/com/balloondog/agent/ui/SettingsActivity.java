package com.balloondog.agent.ui;

import android.content.Intent;
import android.os.Build;
import android.os.Bundle;
import android.text.TextUtils;
import android.widget.Toast;

import androidx.annotation.Nullable;
import androidx.appcompat.app.AlertDialog;
import androidx.appcompat.app.AppCompatActivity;

import com.balloondog.agent.BuildConfig;
import com.balloondog.agent.R;
import com.balloondog.agent.capability.LockController;
import com.balloondog.agent.capability.ScreenCapturer;
import com.balloondog.agent.data.AgentStore;
import com.balloondog.agent.data.EventLog;
import com.balloondog.agent.databinding.ActivitySettingsBinding;
import com.balloondog.agent.service.AgentService;

/**
 * 设置页：后端地址、设备名称、自动定位开关，以及「重置设备身份」这个兜底出口。
 *
 * <p>「重置设备身份」必须存在且必须解释清楚后果：当设备密钥与服务端对不上
 * （例如服务端数据库被清空、或设备码被别人抢先注册），唯一出路就是换一套新身份重新配对。
 * 悄悄自动重置会让家长端留下一台永远离线的幽灵设备，所以这里强制走人工确认。
 */
public class SettingsActivity extends AppCompatActivity {

    /** VPN 授权弹窗（系统弹窗，必须由 Activity 触发）。 */
    private static final int REQUEST_VPN_CONSENT = 4001;

    /** 运行时权限弹窗（定位 / 相机 / 麦克风 / 通话记录 / 短信 / 通知）。 */
    private static final int REQUEST_RUNTIME_PERMISSIONS = 4002;

    private ActivitySettingsBinding binding;
    private AgentStore store;

    @Override
    protected void onCreate(@Nullable Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        binding = ActivitySettingsBinding.inflate(getLayoutInflater());
        setContentView(binding.getRoot());

        store = new AgentStore(this);

        binding.editServer.setText(store.getBaseUrl());
        binding.editDeviceName.setText(store.getDeviceName());
        binding.switchAutoLocation.setChecked(store.isAutoLocationEnabled());

        binding.textAbout.setText(buildAboutText());

        binding.buttonSave.setOnClickListener(v -> save());
        binding.buttonReset.setOnClickListener(v -> confirmReset());
        binding.buttonUsageAccess.setOnClickListener(v -> requestUsageAccess());
        binding.buttonVpn.setOnClickListener(v -> requestVpnConsent());
        binding.buttonGrantRuntime.setOnClickListener(v -> requestRuntimePermissions());
        updatePermissionState();
    }

    @Override
    protected void onResume() {
        super.onResume();
        // 家长可能刚从系统设置页回来，授权状态要重新读一遍
        updatePermissionState();
    }

    /** 把「运行时权限 / 应用限时 / 网址拦截 / 通话短信 / 桌面图标」的实际状态如实写出来。 */
    private void updatePermissionState() {
        StringBuilder sb = new StringBuilder();

        // 运行时权限（定位 / 相机 / 麦克风 / 通话记录 / 短信 / 通知）。
        // 这几个是「危险权限」：不在代码里主动申请就永远是拒绝状态，
        // 于是定位上报、远程拍照、远程录音、通话与短信上报会静默失效 ——
        // 家长端只会看到「一直没有数据」，看不出是权限没给。
        java.util.List<String> missing =
                com.balloondog.agent.capability.PermissionGranter.missing(this);
        sb.append("运行时权限：")
                .append(missing.isEmpty()
                        ? "已全部授权"
                        : "还差 " + missing.size() + " 项（"
                                + joinPermissionLabels(missing) + "）")
                .append('\n');

        sb.append("使用情况访问：")
                .append(com.balloondog.agent.capability.AppUsageTracker.hasPermission(this)
                        ? "已授权" : "未授权（应用限时无法判定超额）")
                .append('\n');

        boolean vpnRunning = com.balloondog.agent.service.DnsFilterVpnService.isRunning();
        boolean vpnConsent = com.balloondog.agent.service.DnsFilterVpnService.hasSystemConsent(this);
        sb.append("网址拦截：")
                .append(vpnRunning ? "运行中（仅 DNS 解析层）"
                        : vpnConsent ? "已授权，等家长开启「网址拦截」特性"
                        : "未授权（需要系统 VPN 授权）")
                .append('\n');

        sb.append("通话记录：")
                .append(com.balloondog.agent.capability.CallLogReader.hasPermission(this)
                        ? "已授权" : "未授权（上报时会跳过并记日志）")
                .append('\n');
        sb.append("短信：")
                .append(com.balloondog.agent.capability.SmsReader.hasPermission(this)
                        ? "已授权" : "未授权（上报时会跳过并记日志）")
                .append('\n');

        sb.append("桌面图标：")
                .append(com.balloondog.agent.capability.IconHider.isHidden(this)
                        ? "已隐藏（本机无入口，需家长端远程恢复或 adb 启用 MainActivityLauncher）"
                        : "显示中");
        binding.textPermissionState.setText(sb.toString());
    }

    /** 跳到系统的「使用情况访问」授权页（该权限没有运行时弹窗，只能手动开）。 */
    private void requestUsageAccess() {
        if (com.balloondog.agent.capability.AppUsageTracker.hasPermission(this)) {
            Toast.makeText(this, "使用情况访问已授权", Toast.LENGTH_SHORT).show();
            return;
        }
        com.balloondog.agent.capability.AppUsageTracker.openSettings(this);
        Toast.makeText(this, "请在列表里找到「气球狗」并允许使用情况访问", Toast.LENGTH_LONG).show();
    }

    /**
     * 授予定位 / 相机 / 麦克风 / 通话记录 / 短信 / 通知这些运行时权限。
     *
     * <p>设备所有者时直接<b>静默自授</b>，孩子端看不到任何弹框；否则只能弹系统框让用户点。
     * 全部被拒时引导到「应用信息」页手动开 —— 如实说明，不假装成功。
     */
    private void requestRuntimePermissions() {
        int silent = com.balloondog.agent.capability.PermissionGranter.grantAsDeviceOwner(this);
        if (com.balloondog.agent.capability.PermissionGranter.allGranted(this)) {
            Toast.makeText(this, "运行时权限已全部授予（设备所有者静默授予 " + silent + " 项）",
                    Toast.LENGTH_SHORT).show();
            updatePermissionState();
            return;
        }

        java.util.List<String> missing =
                com.balloondog.agent.capability.PermissionGranter.missing(this);
        requestPermissions(missing.toArray(new String[0]), REQUEST_RUNTIME_PERMISSIONS);
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(requestCode, permissions, results);
        if (requestCode != REQUEST_RUNTIME_PERMISSIONS) return;
        updatePermissionState();
        if (com.balloondog.agent.capability.PermissionGranter.allGranted(this)) {
            Toast.makeText(this, "权限已全部授予", Toast.LENGTH_SHORT).show();
        } else {
            // 用户点过「拒绝」之后，再调 requestPermissions 系统不再弹框，
            // 只能引导到应用信息页手动开。
            Toast.makeText(this, "仍有权限被拒绝，请在「应用信息 → 权限」里手动打开",
                    Toast.LENGTH_LONG).show();
            com.balloondog.agent.capability.PermissionGranter.openAppDetails(this);
        }
    }

    /** 把权限清单拼成「定位、相机」这样的人话，别在界面上露 {@code android.permission.*}。 */
    private static String joinPermissionLabels(java.util.List<String> permissions) {
        StringBuilder sb = new StringBuilder();
        for (String permission : permissions) {
            if (sb.length() > 0) sb.append('、');
            sb.append(com.balloondog.agent.capability.PermissionGranter.labelOf(permission));
        }
        return sb.toString();
    }

    /**
     * 申请 VPN 授权并启动网址拦截服务。
     *
     * <p>系统弹窗只能从界面弹出：服务端下发 webBlock 后，AgentService 里
     * {@code VpnService.prepare()} 拿到 Intent 却没有办法显示它，
     * 所以那一步只会发通知把家长引到这里。
     */
    private void requestVpnConsent() {
        android.content.Intent consent = android.net.VpnService.prepare(this);
        if (consent == null) {
            // 已经授权过（或本次没有可申请的内容）：直接拉起服务
            com.balloondog.agent.service.DnsFilterVpnService.start(this);
            Toast.makeText(this, "网址拦截已启动（只覆盖 DNS 解析层）", Toast.LENGTH_LONG).show();
            updatePermissionState();
            return;
        }
        startActivityForResult(consent, REQUEST_VPN_CONSENT);
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, @Nullable Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != REQUEST_VPN_CONSENT) return;
        if (resultCode == RESULT_OK) {
            com.balloondog.agent.service.DnsFilterVpnService.start(this);
            Toast.makeText(this, "已授权，网址拦截开始生效（只覆盖 DNS 解析层）",
                    Toast.LENGTH_LONG).show();
        } else {
            // 不假装成功：没授权就是没拦住，日志里也留一条
            EventLog.warn("家长拒绝了 VPN 授权，网址拦截无法启用");
            Toast.makeText(this, "未授权：网址拦截不会生效", Toast.LENGTH_LONG).show();
        }
        updatePermissionState();
    }

    private String buildAboutText() {
        StringBuilder sb = new StringBuilder();
        sb.append("版本：").append(BuildConfig.VERSION_NAME)
                .append("（").append(BuildConfig.VERSION_CODE).append("）\n");
        sb.append("设备码：").append(store.getDeviceCode()).append('\n');
        sb.append("设备 ID：").append(store.getDeviceId() == null ? "未注册" : store.getDeviceId()).append('\n');
        sb.append("绑定状态：").append(store.isBound() ? "已绑定" : "未绑定").append('\n');
        sb.append("锁屏能力：").append(LockController.capabilityLabel(this)).append('\n');
        sb.append("投影授权：").append(ScreenCapturer.hasProjection() ? "有效" : "未授权").append('\n');

        // 把服务端下发的策略如实列出来，并且把「本机到底做没做到」写清楚：
        // 网址拦截只在 DNS 解析层生效（还有 4 条已知绕过），应用限时则依赖
        // 「使用情况访问」权限。状态写模糊了，家长会以为已经在管了。
        String blocked = store.getBlockedUrls();
        int blockedCount = blocked.isEmpty() ? 0 : blocked.split(",").length;
        sb.append("网址黑名单：").append(blockedCount).append(" 条");
        if (blockedCount == 0) {
            sb.append('\n');
        } else if (com.balloondog.agent.service.DnsFilterVpnService.isRunning()) {
            sb.append("（DNS 层拦截中，可被直连 IP / DoH / 缓存绕过）\n");
        } else {
            sb.append("（未生效：需要系统 VPN 授权）\n");
        }

        String limits = store.getAppLimits();
        int limitCount = limits.isEmpty() ? 0 : limits.split(",").length;
        sb.append("应用限额：").append(limitCount).append(" 条");
        if (limitCount == 0) {
            sb.append('\n');
        } else if (com.balloondog.agent.capability.AppUsageTracker.hasPermission(this)) {
            sb.append("（超额会拦，今日用量每 30 分钟上报）\n");
        } else {
            sb.append("（未生效：需要「使用情况访问」权限）\n");
        }

        sb.append("最近活跃：").append(describeLastAlive()).append('\n');
        sb.append("系统：Android ").append(Build.VERSION.RELEASE)
                .append("（API ").append(Build.VERSION.SDK_INT).append("）\n");
        sb.append("机型：").append(Build.MANUFACTURER).append(' ').append(Build.MODEL);
        return sb.toString();
    }

    /** 「最后活跃时间」渲染成中文短句，用来判断守护是否真的还在跑。 */
    private String describeLastAlive() {
        long last = store.getLastAliveAt();
        if (last <= 0) return "从未";
        long diff = System.currentTimeMillis() - last;
        if (diff < 60_000L) return "刚刚";
        if (diff < 3_600_000L) return (diff / 60_000L) + " 分钟前";
        if (diff < 86_400_000L) return (diff / 3_600_000L) + " 小时前";
        return (diff / 86_400_000L) + " 天前";
    }

    private void save() {
        String server = binding.editServer.getText().toString().trim();
        if (TextUtils.isEmpty(server)) {
            Toast.makeText(this, "请填写后端地址", Toast.LENGTH_SHORT).show();
            return;
        }
        String normalized = AgentStore.normalizeBaseUrl(server);
        String name = binding.editDeviceName.getText().toString().trim();

        store.setBaseUrl(normalized);
        if (!TextUtils.isEmpty(name)) {
            store.setDeviceName(name);
        } else {
            // 留空表示「用默认名」，清掉旧值让服务端按机型生成
            store.setDeviceName(null);
        }
        store.setAutoLocationEnabled(binding.switchAutoLocation.isChecked());

        binding.editServer.setText(normalized);
        Toast.makeText(this, R.string.settings_saved, Toast.LENGTH_SHORT).show();

        // 地址变了：重新注册（服务端可能完全不同了），并立刻刷新一次
        store.setDeviceToken(null);
        store.setBound(false);
        AgentService.stop(this);
        if (store.isRegistered()) {
            store.setAgentEnabled(true);
            AgentService.start(this);
        }
    }

    private void confirmReset() {
        new AlertDialog.Builder(this)
                .setTitle(R.string.settings_reset)
                .setMessage(R.string.settings_reset_warning)
                .setNegativeButton("取消", null)
                .setPositiveButton("确定重置", (dialog, which) -> resetIdentity())
                .show();
    }

    private void resetIdentity() {
        AgentService.stop(this);
        store.resetIdentity();
        store.ensureIdentity();
        String newCode = store.getDeviceCode();
        EventLog.clear();
        EventLog.warn("设备身份已重置，新绑定码：" + newCode);

        // 重置后立刻把身份换成新的，准备重新配对
        Toast.makeText(this, getString(R.string.settings_reset_done) + newCode, Toast.LENGTH_LONG).show();
        startActivity(new Intent(this, MainActivity.class)
                .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP));
        finish();
    }
}
