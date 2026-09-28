package com.balloondog.agent.service;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

import com.balloondog.agent.data.AgentStore;
import com.balloondog.agent.data.EventLog;

/**
 * 看门狗与时间表边界的接收器。
 *
 * <p>两条来路：
 * <ul>
 *   <li>{@code ACTION_WATCHDOG} —— 每 60 秒一次的自检，服务不在就拉起来；</li>
 *   <li>{@code ACTION_SCHEDULE_BOUNDARY} —— 作息表状态翻转的时刻（例如 22:00 该锁屏了），
 *       在深度 Doze 下 CPU 会睡过去、1 秒 ticker 停摆，靠这个精确闹钟把判定叫醒。</li>
 * </ul>
 * 无论哪条，第一件事都是「重新排下一次」—— 漏排一次就等于永久失去这条保活链路。
 */
public class WatchdogReceiver extends BroadcastReceiver {

    @Override
    public void onReceive(Context context, Intent intent) {
        String action = intent == null ? null : intent.getAction();
        AgentStore store = new AgentStore(context);

        // 家长没开守护时什么都不做，避免「装了没配对就一直在后台跑」
        if (!store.isAgentEnabled()) return;

        if (android.content.Intent.ACTION_BOOT_COMPLETED.equals(action)) {
            return; // 开机由 BootReceiver 负责
        }

        if (com.balloondog.agent.data.Constants.ACTION_SCHEDULE_BOUNDARY.equals(action)) {
            EventLog.info("到达作息时间表边界，触发一次锁屏状态复查");
        }

        if (!AgentService.isRunning()) {
            EventLog.warn("看门狗发现守护服务未在运行，正在拉起");
            AgentService.start(context);
        } else if (com.balloondog.agent.data.Constants.ACTION_SCHEDULE_BOUNDARY.equals(action)) {
            // 服务活着但可能刚从 Doze 醒来，催它立刻重新判定一次
            AgentService.refreshNow(context);
        }

        // 自续期：漏排一次就永久失效，所以每次触发都重排
        WatchdogScheduler.scheduleWatchdog(context);
    }
}
