package com.balloondog.agent;

import android.app.Application;

import androidx.annotation.Nullable;

import com.balloondog.agent.data.AgentStore;
import com.balloondog.agent.data.EventLog;
import com.balloondog.agent.net.AgentApi;
import com.balloondog.agent.net.ApiClient;
import com.balloondog.agent.net.ApiException;
import com.balloondog.agent.service.AgentNotifications;

/**
 * 应用入口。
 *
 * <p>在这里把「令牌供给」注册给 {@link ApiClient}，好处是<b>不依赖 Agent 服务是否在跑</b>：
 * 答题解锁页、设置页自己发起的请求也能拿到令牌，令牌过期时同样能自动续订。
 */
public class AgentApp extends Application implements ApiClient.TokenProvider {

    private AgentStore store;

    @Override
    public void onCreate() {
        super.onCreate();
        store = new AgentStore(this);
        ApiClient.get().setTokenProvider(this);
        AgentNotifications.ensureChannels(this);

        // 把「无障碍看门狗是否可用」注入给 ui 层：它决定锁定窗口用哪种类型，
        // 进而决定通知栏能不能盖住锁定界面。用接口注入是为了避免 ui 包反向依赖 service 包。
        com.balloondog.agent.ui.LockWatchdogBridge.install(
                () -> com.balloondog.agent.service.LockWatchdogService.isEnabledInSettings(this));
        EventLog.info("气球狗 Agent 启动，设备码 " + store.getDeviceCode());
    }

    @Nullable
    @Override
    public String deviceToken() {
        return store.getDeviceToken();
    }

    /**
     * 401 时自动续订：用本机保存的 deviceCode + deviceSecret 重新换一个令牌。
     *
     * <p>只要这对密钥还在，设备就能证明「我还是原来那台」，
     * 重装、长期离线、令牌自然过期都不需要家长重新走一遍绑定流程。
     */
    @Nullable
    @Override
    public String renewToken() {
        if (!store.isRegistered()) return null;
        try {
            AgentApi.RegisterResult result = new AgentApi().register(
                    store.getBaseUrl(), store.getDeviceCode(), store.getDeviceSecret(), store.getDeviceName());
            store.applyRegistration(result.deviceId, result.deviceToken, result.bound);
            EventLog.success("已用设备密钥续订令牌");
            return result.deviceToken;
        } catch (ApiException e) {
            EventLog.error("续订令牌失败：" + e.describe());
            return null;
        }
    }
}
