package com.balloondog.agent.service;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

import com.balloondog.agent.capability.PasswordLockController;
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

        // ---- 最高优先级：解锁前先解除随机锁屏密码 ----
        //
        // 这一步必须排在最前面，而且不能有任何前置条件（不需要已注册、不需要家长开过守护）。
        // 原因：password 档随机改写了系统锁屏密码，如果设备在这时重启，
        // 用户会被卡在系统锁屏上；而本应用要等用户解锁后才能跑起来去清密码 ——
        // 死循环，设备直到恢复出厂都用不了。实测确认过：
        // dumpsys user 一直停在 RUNNING_LOCKED，界面停在 FallbackHome。
        //
        // LOCKED_BOOT_COMPLETED 是用户解锁之前就能收到的广播（需要 directBootAware），
        // 配合设备加密存储里的 reset 令牌与应急密码哈希，才真正打破了那个循环。
        if (Intent.ACTION_LOCKED_BOOT_COMPLETED.equals(action)) {
            clearRandomPasswordBeforeUnlock(context);
            // 解锁前不启动守护服务：它依赖凭据加密存储里的设备令牌，此刻读不到。
            // 清完密码让用户能正常进系统即可，剩下的事交给解锁后的 BOOT_COMPLETED。
            return;
        }

        if (!Intent.ACTION_BOOT_COMPLETED.equals(action)
                && !"android.intent.action.QUICKBOOT_POWERON".equals(action)
                && !Intent.ACTION_MY_PACKAGE_REPLACED.equals(action)) {
            return;
        }

        // 正常开机路径上再兜一次：万一某些设备没发 LOCKED_BOOT_COMPLETED，
        // 也不能让随机密码活过这次重启。
        clearRandomPasswordBeforeUnlock(context);

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

    /**
     * 开机时若「随机锁屏密码」仍在生效，立刻清掉它。
     *
     * <p>这是 {@code password} 档那条「重启后自动清除随机密码」安全阀的<b>真实实现</b>。
     * 不这么做的话，用户会停在一个自己不知道密码的系统锁屏上，
     * 而应急解锁入口在锁定页里 —— 可锁定页又要等用户解锁后才能显示，谁也进不去。
     */
    private static void clearRandomPasswordBeforeUnlock(Context context) {
        try {
            AgentStore store = new AgentStore(context);
            if (store.getCurrentRandomPassword() == null) return;
            EventLog.warn("检测到随机锁屏密码仍生效，开机时立即清除（避免把用户锁在系统锁屏外）");
            PasswordLockController.disengage(context, store);
        } catch (Exception e) {
            // 这里绝不能抛：抛了会让整个开机自启一起失败，后果更严重
            EventLog.error("开机清除随机锁屏密码失败：" + e.getMessage());
        }
    }
}
