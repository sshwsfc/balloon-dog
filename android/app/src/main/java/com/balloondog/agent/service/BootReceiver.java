package com.balloondog.agent.service;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

import com.balloondog.agent.data.AgentStore;
import com.balloondog.agent.data.EventLog;

/**
 * 开机自启。
 *
 * <p>没有它，孩子只要重启一次手机，守护就永久失效了 —— 而家长端只会看到设备一直离线，
 * 完全不知道原因。所以这里在开机、快速开机、应用被覆盖安装后都重新拉起服务。
 *
 * <p>只在用户此前明确启动过守护（{@code agent_enabled}）时才自启，
 * 避免「装完还没配对就一直在后台跑」这种莫名其妙的耗电。
 */
public class BootReceiver extends BroadcastReceiver {

    @Override
    public void onReceive(Context context, Intent intent) {
        String action = intent == null ? null : intent.getAction();
        if (action == null) return;
        if (!Intent.ACTION_BOOT_COMPLETED.equals(action)
                && !"android.intent.action.QUICKBOOT_POWERON".equals(action)
                && !Intent.ACTION_MY_PACKAGE_REPLACED.equals(action)) {
            return;
        }

        AgentStore store = new AgentStore(context);
        if (!store.isRegistered()) {
            EventLog.info("开机自启跳过：设备尚未注册");
            return;
        }
        if (!store.isAgentEnabled() && !store.isBound()) {
            EventLog.info("开机自启跳过：家长尚未启动守护");
            return;
        }

        EventLog.info("开机自启：正在恢复守护服务");
        AgentService.start(context);
    }
}
