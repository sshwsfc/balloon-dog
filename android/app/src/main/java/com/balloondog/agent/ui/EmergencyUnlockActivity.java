package com.balloondog.agent.ui;

import android.os.Bundle;
import android.widget.Toast;

import androidx.annotation.Nullable;
import androidx.appcompat.app.AppCompatActivity;

import com.balloondog.agent.capability.PasswordLockController;
import com.balloondog.agent.data.AgentStore;
import com.balloondog.agent.data.EventLog;
import com.balloondog.agent.databinding.ActivityEmergencyUnlockBinding;

/**
 * 应急解锁页。
 *
 * <p>为什么需要它：全屏锁定悬浮窗（{@link LockOverlayWindow}）的层级高于所有应用窗口，
 * 弹不出自己的 AlertDialog，所以需要在悬浮窗里点「应急解锁」时先把悬浮窗摘掉、
 * 再打开这个页面收密码。锁定页（Activity 形态）则可以直接用 AlertDialog，
 * 不需要经过这里。
 *
 * <p>校验完全离线：密码只存在本机，这里不发任何网络请求 ——
 * 它的存在意义正是「服务端不可用时的唯一出路」。
 */
public class EmergencyUnlockActivity extends AppCompatActivity {

    private ActivityEmergencyUnlockBinding binding;
    private AgentStore store;

    @Override
    protected void onCreate(@Nullable Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        binding = ActivityEmergencyUnlockBinding.inflate(getLayoutInflater());
        setContentView(binding.getRoot());

        store = new AgentStore(this);

        binding.buttonConfirm.setOnClickListener(v -> verify());
        binding.buttonCancel.setOnClickListener(v -> finish());
    }

    private void verify() {
        String input = binding.editPassword.getText().toString().trim();
        if (input.isEmpty()) {
            Toast.makeText(this, "请输入应急密码", Toast.LENGTH_SHORT).show();
            return;
        }
        if (!PasswordLockController.verifyEmergencyPassword(store, input)) {
            EventLog.warn("应急解锁失败：密码不正确");
            Toast.makeText(this, "应急密码不正确", Toast.LENGTH_LONG).show();
            return;
        }

        EventLog.warn("已通过应急密码解除锁定");
        // 清除被改写的随机锁屏密码，并给一段放行时间 ——
        // 家长既然已经拿到手机，不该 1 秒后又被锁回去
        PasswordLockController.disengage(this, store);
        store.setLockState(false, 0L);
        store.setManualUnlockUntil(System.currentTimeMillis() + 10 * 60_000L);
        Toast.makeText(this, "已解锁，10 分钟内不会自动锁定", Toast.LENGTH_LONG).show();
        finish();
    }
}
