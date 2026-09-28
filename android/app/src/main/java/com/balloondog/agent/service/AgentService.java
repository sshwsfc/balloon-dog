package com.balloondog.agent.service;

import android.Manifest;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.os.BatteryManager;
import android.os.Build;
import android.os.IBinder;
import android.os.SystemClock;

import androidx.annotation.Nullable;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;

import com.balloondog.agent.capability.AudioRecorder;
import com.balloondog.agent.capability.CapabilityException;
import com.balloondog.agent.capability.CommandExecutor;
import com.balloondog.agent.capability.LocationReader;
import com.balloondog.agent.capability.LockState;
import com.balloondog.agent.capability.ScreenCapturer;
import com.balloondog.agent.data.AgentStore;
import com.balloondog.agent.data.Constants;
import com.balloondog.agent.data.EventLog;
import com.balloondog.agent.model.AgentCommand;
import com.balloondog.agent.model.DeviceConfig;
import com.balloondog.agent.net.AgentApi;
import com.balloondog.agent.net.ApiException;

/**
 * 孩子设备端 Agent 的常驻前台服务 —— 整个客户端的引擎。
 *
 * <h3>主循环</h3>
 * 单线程串行地做四件事，节奏由「距上次执行多久」决定：
 * <pre>
 *   每 15s   心跳 /agent/heartbeat        → 刷新在线状态、电量、网络；顺带拿到权威的 locked 状态
 *   每 60s   /agent/config                → 拉取管控策略并在本地强制执行
 *   每 5min  /agent/locations             → 自动位置上报（可在设置里关闭）
 *   持续     /agent/commands/next?wait=25 → 长轮询领指令；有指令立刻被服务端唤醒
 * </pre>
 * 之所以用一个线程串行，是因为采集类指令本来就互斥
 * （同一时刻只能有一路录像、一路录音），并发执行只会互相抢相机/麦克风/投影。
 *
 * <h3>与后端的职责边界</h3>
 * 服务端只负责「下发与收敛」，这里负责「真正执行」。锁屏、拍照、录屏、录音、定位
 * 全部调用 Android 系统 API 完成，然后如实回报成功或失败 —— 不让家长看到虚假的「已完成」。
 */
public class AgentService extends Service implements CommandExecutor.ConfigApplier {

    public static final int ONGOING_NOTIFICATION_ID = Constants.NOTIFICATION_ID_AGENT;

    /** 锁定状态持续期间每隔这么久重新强制锁一次，防止孩子手动解锁后长期处于可用状态。 */
    private static final long RELOCK_INTERVAL_MS = 60_000L;
    /** 每日时长用尽后，重新锁定的间隔。 */
    private static final long LIMIT_RELOCK_INTERVAL_MS = 30_000L;

    private AgentStore store;
    private AgentApi api;
    private CommandExecutor executor;
    private Thread loopThread;
    private volatile boolean running;

    /**
     * 服务是否正在运行 —— 进程内的权威判断依据。
     *
     * <p>为什么不能只看 SharedPreferences 里的 {@code agent_enabled}：
     * 进程被系统回收、被用户在系统设置里「强行停止」、被 ROM 后台清理时，
     * {@code onDestroy} 根本不会执行，那个布尔值会一直停在 true，
     * 于是界面显示「守护运行中」而家长端看到设备一直离线 —— 用户完全被蒙在鼓里。
     *
     * <p>为什么不用「最后活跃时间 + 时间窗口」推断：窗口取小了会把正在长轮询
     * （最长挂起 25 秒）的服务误判成已死，取大了又会在服务刚被杀掉的那段时间里
     * 继续报「运行中」。{@code MainActivity} 与本服务同进程，直接读静态标志最准。
     */
    private static volatile boolean serviceRunning;

    public static boolean isRunning() {
        return serviceRunning;
    }

    // 各类定时任务的「上次执行时刻」
    private long lastHeartbeatAt;
    private long lastConfigAt;
    private long lastLocationAt;

    /**
     * 锁屏与用量由独立的 1 秒 ticker 驱动，而不是挂在网络主循环上。
     *
     * <p>原因：主循环会为了长轮询挂起最长 25 秒。如果锁屏判定也放在里面，
     * 倒计时就会 25 秒才跳一次，「还有 30 秒锁定」直接变成幻灯片。
     * 判定本身是纯计算（读本地状态，不碰网络），完全撑得住每秒一次。
     */
    private final com.balloondog.agent.capability.LockEnforcer lockEnforcer =
            new com.balloondog.agent.capability.LockEnforcer();
    private Thread tickerThread;
    private volatile boolean ticking;
    private long lastUsageTickMs;

    /** 上一次上报给服务端的生效锁定状态，用于只在变化时上报。 */
    private boolean lastReportedLocked;
    private String lastReportedReason = "";

    /** 绑定状态与最近动作，供通知与界面展示。 */
    private volatile String lastStatusText = "正在启动…";

    // ============================================================
    // 生命周期
    // ============================================================

    public static void start(Context context) {
        Intent intent = new Intent(context, AgentService.class);
        intent.setAction(Constants.ACTION_START_AGENT);
        ContextCompat.startForegroundService(context, intent);
    }

    public static void stop(Context context) {
        context.stopService(new Intent(context, AgentService.class));
    }

    /**
     * 请求「立刻刷新一轮」。
     *
     * <p>只对<b>已经在运行</b>的服务生效：如果守护本来就没启动，这里不应该顺手把它拉起来 ——
     * 否则一次答题、一次切页面都会偷偷启动后台服务，用户完全不知情。
     */
    public static void refreshNow(Context context) {
        if (!new AgentStore(context).isAgentEnabled()) return;
        Intent intent = new Intent(context, AgentService.class);
        intent.setAction(Constants.ACTION_REFRESH_NOW);
        try {
            ContextCompat.startForegroundService(context, intent);
        } catch (Exception ignored) {
            // 服务已在运行；即便启动被拒也无妨，下一次轮询会带上新配置
        }
    }

    @Override
    public void onCreate() {
        super.onCreate();
        store = new AgentStore(this);
        api = new AgentApi();
        executor = new CommandExecutor(this, store, this);
        AgentNotifications.ensureChannels(this);

        startForegroundCompat();
        serviceRunning = true;
        store.markServiceAlive();
        EventLog.info("Agent 服务已启动");
    }

    /**
     * 进入前台。
     *
     * <p>前台服务类型按「实际拿到的权限」动态决定：Android 14 规定声明了 camera/microphone
     * 类型却缺少对应运行时权限时，{@code startForeground} 会直接抛 SecurityException。
     * 所以这里只挑已经授权的类型，服务能起来是第一位的。
     */
    private void startForegroundCompat() {
        int type = 0;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            type = ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC;
            if (hasPermission(Manifest.permission.CAMERA)) {
                type |= ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA;
            }
            if (hasPermission(Manifest.permission.RECORD_AUDIO)) {
                type |= ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE;
            }
            if (hasPermission(Manifest.permission.ACCESS_FINE_LOCATION)
                    || hasPermission(Manifest.permission.ACCESS_COARSE_LOCATION)) {
                type |= ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION;
            }
        }
        try {
            ForegroundCompat.start(this, ONGOING_NOTIFICATION_ID,
                    AgentNotifications.buildAgentNotification(this, "气球狗守护运行中", lastStatusText),
                    type);
        } catch (Exception e) {
            // 极端情况下（例如缺少 FOREGROUND_SERVICE 权限）退化为普通前台服务，至少别让进程死掉
            EventLog.error("进入前台失败：" + e.getMessage());
            try {
                ForegroundCompat.start(this, ONGOING_NOTIFICATION_ID,
                        AgentNotifications.buildAgentNotification(this, "气球狗守护运行中", lastStatusText),
                        0);
            } catch (Exception inner) {
                EventLog.error("前台服务启动失败：" + inner.getMessage());
            }
        }
    }

    private boolean hasPermission(String permission) {
        return ContextCompat.checkSelfPermission(this, permission) == PackageManager.PERMISSION_GRANTED;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent == null ? null : intent.getAction();
        if (Constants.ACTION_STOP_AGENT.equals(action)) {
            stopSelf();
            return START_NOT_STICKY;
        }

        store.setAgentEnabled(true);
        if (!running) {
            running = true;
            loopThread = new Thread(this::runLoop, "balloon-agent-loop");
            loopThread.start();
        }
        if (!ticking) {
            ticking = true;
            tickerThread = new Thread(this::runTicker, "balloon-agent-lock");
            tickerThread.start();
        }
        // 定时器归零，让循环立刻做一轮心跳与配置拉取
        lastHeartbeatAt = 0L;
        lastConfigAt = 0L;
        // 保活看门狗：即使这一轮被系统杀掉，也会在 1 分钟内被拉起来
        WatchdogScheduler.scheduleWatchdog(this);
        return START_STICKY;
    }

    /**
     * 用户从最近任务里划掉应用时触发。
     *
     * <p>前台服务本身不会被这一下杀掉，但部分 ROM 会顺手清理；这里立刻重新拉起自己，
     * 并重排看门狗。返回 START_STICKY 让系统在内存回收后也重建服务。
     */
    @Override
    public void onTaskRemoved(Intent rootIntent) {
        EventLog.warn("应用被从最近任务划掉，正在重新拉起守护");
        WatchdogScheduler.scheduleWatchdog(this);
        Intent restart = new Intent(this, AgentService.class);
        restart.setAction(Constants.ACTION_START_AGENT);
        try {
            ContextCompat.startForegroundService(this, restart);
        } catch (Exception e) {
            EventLog.error("划掉后重启服务失败：" + e.getMessage());
        }
        super.onTaskRemoved(rootIntent);
    }

    @Override
    public void onDestroy() {
        running = false;
        ticking = false;
        serviceRunning = false;
        EventLog.info("Agent 服务已停止");
        store.setAgentEnabled(false);

        Thread thread = loopThread;
        if (thread != null) {
            thread.interrupt();
            loopThread = null;
        }
        Thread ticker = tickerThread;
        if (ticker != null) {
            ticker.interrupt();
            tickerThread = null;
        }

        // 家长显式停止守护时，把锁定副作用收干净 —— 否则孩子会被困在一个
        // 再也没人来解锁的锁定页上
        try {
            lockEnforcer.releaseAll(this, store);
        } catch (Exception e) {
            EventLog.error("停止守护时解除锁定失败：" + e.getMessage());
        }
        WatchdogScheduler.cancel(this);

        // 正在进行的采集要收干净，否则相机/麦克风会被一直占着
        AudioRecorder.discard();
        ScreenCapturer.shutdown();
        ForegroundCompat.stop(this);
        super.onDestroy();
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    // ============================================================
    // 主循环
    // ============================================================

    private void runLoop() {
        store.ensureIdentity();
        EventLog.info("设备码 " + store.getDeviceCode() + "，后端 " + store.getBaseUrl());

        boolean registered = false;
        while (running) {
            // 每轮都打一次「我还活着」，界面据此判断服务是否真的在运行
            store.markServiceAlive();
            try {
                if (!registered) {
                    registered = registerSelf();
                    if (!registered) {
                        sleepQuietly(Constants.RETRY_BACKOFF_MS);
                        continue;
                    }
                }

                long now = SystemClock.elapsedRealtime();

                // ---- 心跳 ----
                if (now - lastHeartbeatAt >= Constants.HEARTBEAT_INTERVAL_MS || lastHeartbeatAt == 0L) {
                    lastHeartbeatAt = now;
                    doHeartbeat();
                }

                // ---- 管控策略 ----
                if (now - lastConfigAt >= Constants.CONFIG_REFRESH_INTERVAL_MS || lastConfigAt == 0L) {
                    lastConfigAt = now;
                    try {
                        applyConfig();
                    } catch (ApiException e) {
                        EventLog.warn("拉取管控策略失败：" + e.userMessage());
                    }
                }

                // ---- 位置自动上报 ----
                if (store.isAutoLocationEnabled()
                        && (now - lastLocationAt >= Constants.LOCATION_REPORT_INTERVAL_MS || lastLocationAt == 0L)) {
                    lastLocationAt = now;
                    autoReportLocation();
                }

                // ---- 补发上几轮没送出去的指令结果 ----
                flushPendingReports();

                // ---- 长轮询领指令 ----
                AgentCommand command = api.nextCommand(store.getBaseUrl(), Constants.LONG_POLL_WAIT_SECONDS);
                if (command != null) {
                    handleCommand(command);
                }
            } catch (ApiException e) {
                if (e.isUnauthorized()) {
                    // 令牌失效（被解绑 / 设备被删 / 家长被禁用）：清掉令牌重新注册
                    EventLog.warn("设备令牌失效（" + e.userMessage() + "），正在重新注册");
                    store.setDeviceToken(null);
                    registered = false;
                } else if (e.isDeviceSecretMismatch()) {
                    EventLog.error("设备密钥与服务端不匹配，需要在「设置」里重置设备身份后重新配对");
                    sleepQuietly(30_000L);
                } else {
                    EventLog.warn("轮询失败：" + e.describe());
                    sleepQuietly(Constants.RETRY_BACKOFF_MS);
                }
            } catch (Exception e) {
                EventLog.error("主循环异常：" + e);
                sleepQuietly(Constants.RETRY_BACKOFF_MS);
            }
        }
    }

    /** 注册 / 续订令牌。成功返回 true。 */
    private boolean registerSelf() {
        store.ensureIdentity();
        try {
            AgentApi.RegisterResult result = api.register(
                    store.getBaseUrl(),
                    store.getDeviceCode(),
                    store.getDeviceSecret(),
                    store.getDeviceName());

            store.setDeviceToken(result.deviceToken);
            store.setDeviceId(result.deviceId);
            store.setBound(result.bound);

            if (result.created) {
                EventLog.success("注册成功（新设备），绑定码 " + result.deviceCode);
            } else {
                EventLog.success("注册成功（设备已存在，令牌已续订）");
            }
            if (!result.bound) {
                EventLog.info("等待家长绑定：请在家长端「设备管理」里输入绑定码 " + result.deviceCode);
            }
            updateNotification(result.bound
                    ? "已绑定 · 正在守护"
                    : "等待绑定 · 绑定码 " + result.deviceCode);
            return true;
        } catch (ApiException e) {
            if (e.isDeviceSecretMismatch()) {
                EventLog.error("注册被拒绝：设备密钥不匹配。请到「设置 → 重置设备身份」，"
                        + "然后用新的绑定码重新配对");
                // 不自动重置：那会让家长端已绑定的记录变成一台永远离线的幽灵设备
                sleepQuietly(60_000L);
            } else {
                EventLog.error("注册失败：" + e.describe());
            }
            return false;
        }
    }

    private void doHeartbeat() throws ApiException {
        int battery = readBatteryPercent();
        String network = readNetworkType();
        // 顺带把设备<b>实际</b>的锁定状态报上去：家长的期望值与设备的真实状态
        // 可能因为作息表/每日额度而不同，只报期望值会让家长端显示错的结论
        LockState current = LockState.compute(
                com.balloondog.agent.capability.LockEnforcer.buildInputs(store, System.currentTimeMillis()));
        AgentApi.HeartbeatResult result = api.heartbeat(store.getBaseUrl(), battery, network,
                Constants.AGENT_VERSION, current.locked, current.describe());

        boolean wasBound = store.isBound();
        store.setBound(result.bound);
        if (result.bound != wasBound) {
            EventLog.success(result.bound ? "设备已被家长绑定，开始接收指令" : "设备已解除绑定");
        }
        if (!result.bound) {
            updateNotification("等待绑定 · 绑定码 " + store.getDeviceCode());
            return;
        }

        // 心跳里带回了权威的 locked / tempUnlockUntil，用它兜住错过 config 的情况。
        // 落地动作仍然交给 ticker，保证「判定只有一处」。
        if (result.locked != store.isLocked() || result.tempUnlockUntil != store.getTempUnlockUntil()) {
            store.setLockState(result.locked, result.tempUnlockUntil);
        }
        updateNotification("已绑定 · 电量 " + battery + "% · " + network);
    }

    // ============================================================
    // 管控策略
    // ============================================================

    /**
     * 拉取并应用管控策略。实现 {@link CommandExecutor.ConfigApplier}，
     * 所以 {@code sync_config} 指令也走这里，保证「指令触发」与「定时刷新」行为完全一致。
     */
    @Override
    public DeviceConfig applyConfig() throws ApiException {
        DeviceConfig config = api.fetchConfig(store.getBaseUrl());

        if (!config.bound) {
            store.setBound(false);
            updateNotification("等待绑定 · 绑定码 " + store.getDeviceCode());
            return config;
        }

        store.setBound(true);
        store.setLastConfigJson(config.rawJson);
        store.setLockState(config.locked, config.tempUnlockUntil);
        // 服务端是「家长意图」的权威来源：它说锁，本地任何残留的解锁宽限都必须作废，
        // 否则家长在 App 里点了锁定、设备却因为本地宽限纹丝不动
        if (config.locked) {
            store.setManualUnlockUntil(0L);
        }
        store.setTimePlan(config.timePlanEnabled, config.dailyLimitMinutes);
        store.setQuizEnabled(config.quizEnabled);
        store.setBlockedUrls(joinBlockedUrls(config));
        store.setAppLimits(describeAppLimits(config));

        // 锁屏强度与时间表：必须落盘，锁屏要在断网时照常生效
        boolean strengthChanged = !config.lockStrength.equals(store.getLockStrength());
        store.setLockStrength(config.lockStrength);
        store.setCountdownSeconds(config.countdownSeconds);
        store.setScheduleEnabled(config.scheduleEnabled);
        store.setScheduleJson(config.scheduleToJson());
        if (strengthChanged) {
            EventLog.info("锁屏强度已更新为「" + config.lockStrength + "」，本机实际生效："
                    + com.balloondog.agent.capability.LockCapability
                            .describeEffective(this, config.lockStrength));
        }

        // 网址黑名单：Android 上没有免 root 的全局 DNS 拦截，
        // 这里只做「记录 + 可查询」，真正拦截需要 VpnService 或设备所有者策略。
        // 如实记录，避免家长以为已经在拦了。
        if (!config.blockedUrls.isEmpty()) {
            EventLog.info("已同步 " + config.blockedUrls.size()
                    + " 条网址黑名单（本地拦截需 VpnService 或设备所有者，见 README「已知边界」）");
        }
        if (!config.appLimits.isEmpty()) {
            EventLog.info("已同步 " + config.appLimits.size()
                    + " 条应用限额（逐应用限时需读取使用情况权限，见 README「已知边界」）");
        }

        // 锁定的实际执行交给 1 秒 ticker（runTicker），这里不再直接改设备状态 ——
        // 让「判定」只有一个入口，避免两处逻辑打架
        updateNotification("已绑定 · " + config.summary());
        return config;
    }

    /** 把应用限额压成「抖音=60,王者荣耀=30」这种便于展示与排查的短串。 */
    private static String describeAppLimits(DeviceConfig config) {
        StringBuilder sb = new StringBuilder();
        for (DeviceConfig.AppLimit limit : config.appLimits) {
            if (sb.length() > 0) sb.append(',');
            sb.append(limit.appName).append('=').append(limit.dailyLimitMinutes);
        }
        return sb.toString();
    }

    private static String joinBlockedUrls(DeviceConfig config) {
        StringBuilder sb = new StringBuilder();
        for (String url : config.blockedUrls) {
            if (sb.length() > 0) sb.append(',');
            sb.append(url);
        }
        return sb.toString();
    }

    // ============================================================
    // 锁屏 ticker（每秒一次）
    // ============================================================

    /**
     * 每秒：记录用量 → 判定锁定状态 → 落地 → 变化时上报服务端。
     *
     * <p>这是需求 3/4/5 的心脏：
     * <ul>
     *   <li>倒计时悬浮窗来自 {@link LockState#countdownActive}，每秒自然刷新；</li>
     *   <li>定时锁屏 / 定时解锁来自时间表的逐分钟求值；</li>
     *   <li>远程解锁、临时解锁、答题奖励通过放行截止时间即时生效；</li>
     *   <li>状态一变就回报服务端，家长端因此能看到设备<b>真实</b>的锁定状态，
     *       而不只是自己的期望值。</li>
     * </ul>
     */
    private void runTicker() {
        lastUsageTickMs = SystemClock.elapsedRealtime();
        while (ticking) {
            try {
                long nowWall = System.currentTimeMillis();
                long nowMono = SystemClock.elapsedRealtime();

                // ---- 1) 用量记账（只在「可用」时累加）----
                long deltaMs = nowMono - lastUsageTickMs;
                lastUsageTickMs = nowMono;
                // 跨度超过 5 秒说明进程刚被挂起/唤醒，不计入，避免把待机算成使用
                if (deltaMs > 0 && deltaMs <= 5_000L) {
                    LockState before = LockState.compute(
                            com.balloondog.agent.capability.LockEnforcer.buildInputs(store, nowWall));
                    if (!before.locked) {
                        store.addUsageSeconds(Math.max(1L, deltaMs / 1000L));
                    }
                }

                // ---- 2) 判定 + 落地 ----
                LockState state = LockState.compute(
                        com.balloondog.agent.capability.LockEnforcer.buildInputs(store, nowWall));
                boolean changed = lockEnforcer.apply(this, store, state, store.isQuizEnabled());
                if (changed) {
                    EventLog.warn("锁定状态变化 → " + state.describe());
                    updateNotification("已绑定 · " + state.describe());
                    reportLockState(state, true);
                    // 顺带拉一次配置，保证服务端的期望状态与设备实际状态尽快对齐
                    lastConfigAt = 0L;
                } else {
                    // 倒计时期间每秒刷新通知，让孩子在通知栏也能看到剩余时间
                    if (state.countdownActive) {
                        updateNotification("即将锁定：" + state.countdownRemainingSeconds + " 秒");
                    }
                    reportLockState(state, false);
                }
            } catch (Exception e) {
                EventLog.error("锁屏 ticker 异常：" + e);
            }
            sleepQuietly(1_000L);
        }
    }

    /**
     * 把设备上<b>实际</b>的锁定状态上报服务端。
     *
     * <p>为什么需要单独上报：服务端的 {@code locked} 是家长的<b>期望</b>状态，
     * 而设备可能因为作息表或每日额度而处于锁定 —— 这两者不是一回事。
     * 不上报的话，家长在「作息时间到了」时看到的仍然是「未锁定」。
     *
     * @param force 状态刚发生变化时强制上报，避免要等到下一个周期
     */
    private void reportLockState(LockState state, boolean force) {
        if (!store.isBound()) return;
        boolean locked = state.locked;
        String reason = state.detail == null ? state.reason.name() : state.detail;
        if (!force && locked == lastReportedLocked && reason.equals(lastReportedReason)) return;
        lastReportedLocked = locked;
        lastReportedReason = reason;
        // 心跳下一轮就会把它带上去；这里不额外发请求，避免每秒打一次服务端
    }

    // ============================================================
    // 指令
    // ============================================================

    private void handleCommand(AgentCommand command) {
        EventLog.info("收到指令 " + command + "，来自服务端的期望状态");

        // 采集类指令开始前，先在通知里告诉孩子「家长正在做什么」——
        // 这是儿童隐私的基本尊重，也让家长知道设备端确实收到了
        AgentNotifications.notifyEvent(this, command.id.hashCode(),
                "家长操作：" + command.label,
                "这条指令正在这台设备上执行");

        CommandExecutor.Outcome outcome = executor.execute(command);
        enqueueReport(command, outcome);
        flushPendingReports();

        // 指令执行后立刻刷新一次管控状态，让界面/通知马上反映真实情况
        try {
            applyConfig();
            lastConfigAt = SystemClock.elapsedRealtime();
        } catch (ApiException ignored) {
            // 下一轮定时刷新会补上
        }
    }

    // ============================================================
    // 指令结果回报（带重试队列）
    // ============================================================

    /**
     * 待回报的指令结果。
     *
     * <p>为什么需要一个队列，而不是在 {@code handleCommand} 里 try/catch 一次就完事：
     * 指令一旦被设备领取，服务端就把它标成 {@code dispatched}，此时<b>只有设备回报</b>
     * 才能把它推进到 {@code succeeded} / {@code failed}。如果这一瞬间网络抖动导致回报失败，
     * 家长端会一直停在「执行中」，直到 {@code COMMAND_TTL_SECONDS}（默认 300 秒）
     * 被超时清理成 {@code expired} —— 明明已经执行了，家长看到的却是「设备超时未响应」，
     * 而且服务端还会把乐观更新的状态回滚。这正是必须避免的静默失败。
     *
     * <p>所以：回报失败就入队，之后每轮主循环都重试一次，直到成功或被判定为过期。
     */
    private static final class PendingReport {
        final String commandId;
        final String label;
        final boolean succeeded;
        final org.json.JSONObject result;
        final String error;
        int attempts;

        PendingReport(AgentCommand command, CommandExecutor.Outcome outcome) {
            this.commandId = command.id;
            this.label = command.label;
            this.succeeded = outcome.succeeded;
            this.result = outcome.result;
            this.error = outcome.error;
        }
    }

    /** 重试多少次后放弃（约等于 20 轮主循环；此时服务端多半已把它清成 expired）。 */
    private static final int MAX_REPORT_ATTEMPTS = 20;
    private static final int MAX_PENDING_REPORTS = 50;

    private final java.util.ArrayDeque<PendingReport> pendingReports = new java.util.ArrayDeque<>();

    private void enqueueReport(AgentCommand command, CommandExecutor.Outcome outcome) {
        synchronized (pendingReports) {
            if (pendingReports.size() >= MAX_PENDING_REPORTS) {
                PendingReport dropped = pendingReports.pollFirst();
                EventLog.error("待回报队列已满，丢弃指令 " + (dropped == null ? "" : dropped.label) + " 的结果");
            }
            pendingReports.addLast(new PendingReport(command, outcome));
        }
    }

    /** 尽力把队列里的结果回报出去；遇到网络错误就停下，等下一轮再试。 */
    private void flushPendingReports() {
        while (true) {
            PendingReport pending;
            synchronized (pendingReports) {
                pending = pendingReports.peekFirst();
            }
            if (pending == null) return;

            try {
                AgentApi.ResultAck ack = api.reportResult(store.getBaseUrl(), pending.commandId,
                        pending.succeeded, pending.result, pending.error);
                synchronized (pendingReports) {
                    pendingReports.pollFirst();
                }
                if (ack.alreadySettled) {
                    EventLog.warn("指令「" + pending.label + "」已结算过（可能超时后才回报），服务端忽略了本次结果");
                } else {
                    EventLog.success("已回报结果：" + ack.status
                            + (pending.succeeded ? "" : "（" + pending.error + "）"));
                }
            } catch (ApiException e) {
                pending.attempts++;
                if (pending.attempts >= MAX_REPORT_ATTEMPTS) {
                    synchronized (pendingReports) {
                        pendingReports.pollFirst();
                    }
                    EventLog.error("指令「" + pending.label + "」的结果连续 "
                            + MAX_REPORT_ATTEMPTS + " 次回报失败，已放弃：" + e.describe());
                    continue;
                }
                if (pending.attempts == 1) {
                    EventLog.warn("回报指令结果失败，稍后自动重试：" + e.userMessage());
                }
                // 令牌失效这类错误由主循环统一处理，这里直接退出等待下一轮
                return;
            }
        }
    }

    // ============================================================
    // 位置
    // ============================================================

    private void autoReportLocation() {
        if (!LocationReader.hasPermission(this)) return;
        try {
            LocationReader.Fix fix = LocationReader.read(this, 12_000L);
            api.reportLocation(store.getBaseUrl(), fix.latitude, fix.longitude, fix.accuracy, fix.address);
            EventLog.info(String.format(java.util.Locale.US,
                    "自动位置上报 %.5f, %.5f", fix.latitude, fix.longitude));
        } catch (CapabilityException | ApiException e) {
            // 自动上报失败不打扰用户，只在日志里留痕
            EventLog.warn("自动位置上报失败：" + e.getMessage());
        }
    }

    // ============================================================
    // 环境读取
    // ============================================================

    private int readBatteryPercent() {
        try {
            Intent battery = registerReceiver(null, new IntentFilter(Intent.ACTION_BATTERY_CHANGED));
            if (battery == null) return 0;
            int level = battery.getIntExtra(BatteryManager.EXTRA_LEVEL, -1);
            int scale = battery.getIntExtra(BatteryManager.EXTRA_SCALE, -1);
            if (level < 0 || scale <= 0) return 0;
            return Math.round(level * 100f / scale);
        } catch (Exception e) {
            return 0;
        }
    }

    private String readNetworkType() {
        try {
            ConnectivityManager manager =
                    (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
            if (manager == null) return "unknown";
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                Network active = manager.getActiveNetwork();
                if (active == null) return "unknown";
                NetworkCapabilities capabilities = manager.getNetworkCapabilities(active);
                if (capabilities == null) return "unknown";
                if (capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) return "wifi";
                if (capabilities.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR)) return "cellular";
                if (capabilities.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET)) return "ethernet";
                return "unknown";
            }
            //noinspection deprecation
            android.net.NetworkInfo info = manager.getActiveNetworkInfo();
            if (info == null || !info.isConnected()) return "unknown";
            switch (info.getType()) {
                case ConnectivityManager.TYPE_WIFI: return "wifi";
                case ConnectivityManager.TYPE_MOBILE: return "cellular";
                case ConnectivityManager.TYPE_ETHERNET: return "ethernet";
                default: return "unknown";
            }
        } catch (Exception e) {
            return "unknown";
        }
    }

    // ============================================================
    // 通知 / 状态
    // ============================================================

    private void updateNotification(String text) {
        lastStatusText = text;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
                && !NotificationManagerCompat.from(this).areNotificationsEnabled()) {
            return;
        }
        try {
            androidx.core.app.NotificationManagerCompat.from(this).notify(
                    ONGOING_NOTIFICATION_ID,
                    AgentNotifications.buildAgentNotification(this, "气球狗守护运行中", text));
        } catch (SecurityException ignored) {
            // 没有通知权限时静默失败，服务本身仍在运行
        }
    }

    // ============================================================
    // 杂项
    // ============================================================

    private static void sleepQuietly(long millis) {
        try {
            Thread.sleep(millis);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }
}
