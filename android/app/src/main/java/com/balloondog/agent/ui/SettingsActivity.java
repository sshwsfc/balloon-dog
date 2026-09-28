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

        // 把服务端下发的策略如实列出来。网址拦截 / 应用限额在本工程里只做到
        // 「同步 + 可查」，并没有真正强制执行（原因见 android/README.md「已知边界」），
        // 所以这里必须把状态写清楚，不能让家长误以为已经在管了。
        String blocked = store.getBlockedUrls();
        int blockedCount = blocked.isEmpty() ? 0 : blocked.split(",").length;
        sb.append("网址黑名单：").append(blockedCount).append(" 条")
                .append(blockedCount > 0 ? "（已同步，未强制拦截）" : "").append('\n');
        String limits = store.getAppLimits();
        int limitCount = limits.isEmpty() ? 0 : limits.split(",").length;
        sb.append("应用限额：").append(limitCount).append(" 条")
                .append(limitCount > 0 ? "（已同步，未强制限时）" : "").append('\n');

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
