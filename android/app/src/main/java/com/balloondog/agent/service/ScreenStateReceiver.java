package com.balloondog.agent.service;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

import com.balloondog.agent.data.AgentStore;
import com.balloondog.agent.data.EventLog;

/**
 * 亮屏 / 解锁监听。
 *
 * <p>「孩子把屏幕点亮」正是最需要马上反应的时刻：如果这一刻策略要求锁定，
 * 不能等下一次 3 秒复核，更不能等下一次配置轮询。所以这里收到广播就立刻
 * 转发给 {@link AgentService} 做一次立即复核。
 *
 * <p>{@code ACTION_USER_PRESENT}（解锁完成）比 {@code ACTION_SCREEN_ON} 更关键 ——
 * 后者只是亮屏（可能还停在系统锁屏上），前者意味着人已经进来了。
 * 两个都监听，前者触发时锁定界面会盖上去。
 *
 * <p>注意这是<b>动态注册</b>的接收器（见 AgentService），不是清单声明的：
 * Android 8.0 起隐式广播不允许静态注册，SCREEN_ON/USER_PRESENT 都在禁止之列。
 */
public class ScreenStateReceiver extends BroadcastReceiver {

    @Override
    public void onReceive(Context context, Intent intent) {
        String action = intent == null ? null : intent.getAction();
        if (action == null) return;

        AgentStore store = new AgentStore(context);
        // 家长没开守护时什么都不做，避免「装了没配对就一直在后台跑」
        if (!store.isAgentEnabled()) return;

        boolean userPresent = Intent.ACTION_USER_PRESENT.equals(action);
        if (userPresent) {
            EventLog.info("检测到设备已解锁，立即复核锁定状态");
        }

        Intent forward = new Intent(context, AgentService.class);
        forward.setAction(com.balloondog.agent.data.Constants.ACTION_SCREEN_ON);
        forward.putExtra("userPresent", userPresent);
        context.startService(forward);
    }
}
