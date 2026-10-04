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

    /**
     * 锁定状态复核器：每 3 秒核实「策略要求锁定，实际是不是真的锁着」，
     * 没锁就再锁一次。这是「只要进程还在，就一定锁得住」的那一半。
     */
    /**
     * 当前运行中的实例。
     *
     * <p>给无障碍看门狗用：它要上报「拦截了某个插件」这类事件，而事件上报必须走
     * AgentService 里那套统一的令牌刷新与网络栈，不能在服务里再开一条。
     * 服务没跑时为 null，调用方需要自己判空。
     */
    private static volatile AgentService current;

    private com.balloondog.agent.capability.LockReassertor lockReassertor;
    /** 护眼执行者：连续用眼计时 → 强制休息；夜间护眼；亮度上限。 */
    private com.balloondog.agent.capability.EyeCareController eyeCare;
    /** 已安装应用清单：学习模式拦截的权威判据 + 上报家长端的数据来源。 */
    private final com.balloondog.agent.capability.AppInventory appInventory =
            new com.balloondog.agent.capability.AppInventory();
    /**
     * 待上报的设备事件。
     *
     * <p>刻意在内存里排队、批量上报：解锁、亮屏这类事件一天可能上百条，
     * 每条一个请求既费电又容易被限流。攒够一批或隔一段时间统一发。
     * 进程被杀会丢掉未发送的事件 —— 这是可接受的取舍（它是展示用的动态流，
     * 不是计费数据），换来的是不必为此再建一张本地表。
     */
    private final java.util.List<org.json.JSONObject> pendingEvents =
            java.util.Collections.synchronizedList(new java.util.ArrayList<org.json.JSONObject>());
    private long lastEventFlushAt;

    /** 周期截屏采样（家长开启后才工作）。 */
    private com.balloondog.agent.capability.ScreenSampler screenSampler;
    private com.balloondog.agent.capability.FrameBatchUploader frameUploader;

    /** 亮屏 / 解锁接收器。Android 8+ 隐式广播不能静态注册，只能动态注册。 */
    private ScreenStateReceiver screenStateReceiver;
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

        lockReassertor = new com.balloondog.agent.capability.LockReassertor(this, store, lockEnforcer);
        eyeCare = new com.balloondog.agent.capability.EyeCareController(this, store);
        screenSampler = new com.balloondog.agent.capability.ScreenSampler(this, store);
        frameUploader = new com.balloondog.agent.capability.FrameBatchUploader(this, store);
        registerScreenStateReceiver();

        // 进程刚起来时清理可能残留的 Lock Task。
        // 进程在锁定期被杀掉的话，Lock Task 状态是系统持久化的，不会随进程消失，
        // 会留下「系统认为还在锁定任务里、但任务已经不存在」的诡异状态。
        // 此刻我们的锁定页必然不在前台，所以任何残留都是陈旧的，可以安全清掉。
        try {
            com.balloondog.agent.capability.KioskController.releaseStaleLockTask(this);
        } catch (Exception e) {
            EventLog.warn("清理残留 Lock Task 失败：" + e.getMessage());
        }

        // 丢掉不属于当前设备的陈旧锁定策略：身份变过（解绑后重新注册）却还留着旧策略时，
        // 设备会被一台已经不存在的设备锁死。放在这里是为了让已经卡住的设备也能自己恢复。
        try {
            store.healStalePolicyCache();
        } catch (Exception e) {
            EventLog.warn("清理陈旧锁定策略失败：" + e.getMessage());
        }

        current = this;
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

        // 亮屏 / 解锁：立即复核一次锁定状态，不等 3 秒周期。
        // 这条路径是「孩子想绕过管控点亮屏幕」的第一道反应。
        if (Constants.ACTION_SCREEN_ON.equals(action) && lockReassertor != null) {
            store.setAgentEnabled(true);
            // 「点亮屏幕」与「解锁完成」是家长最想看到的两种动态，分开记：
            // 前者说明孩子动了手机，后者说明他真的进到系统里了。
            recordEvent(isUserPresentExtra(intent)
                            ? Constants.EVENT_UNLOCK : Constants.EVENT_SCREEN_ON,
                    isUserPresentExtra(intent) ? "解锁并点亮屏幕" : "点亮屏幕");
            lockReassertor.onScreenOn();
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
        current = null;
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
        unregisterScreenStateReceiver();
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

            if (store.applyRegistration(result.deviceId, result.deviceToken, result.bound)) {
                // 身份变了：本地锁定态已经清掉，立刻重新拉一次配置，
                // 不要让设备在旧策略下多锁一秒
                lastConfigAt = 0L;
            }

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

        // 模式切换 / 护眼 / 应用插件：三样都必须落盘 ——
        // 学习模式与插件拦截是「孩子拿不到网也必须生效」的规则，
        // 只放在内存里等于拔网线即失效。
        String previousMode = com.balloondog.agent.capability.StudyModeEngine
                .evaluate(store.getModeConfig(), System.currentTimeMillis());
        store.setModeConfig(config.mode);
        store.setEyeCareConfig(config.eyeCare);
        store.setPluginRules(config.appPlugins);
        String currentMode = com.balloondog.agent.capability.StudyModeEngine
                .evaluate(config.mode, System.currentTimeMillis());
        if (!previousMode.equals(currentMode)) {
            EventLog.warn("study".equals(currentMode) ? "已进入学习模式（只允许白名单应用）" : "已退出学习模式");
            recordEvent(Constants.EVENT_MODE_ENTER,
                    "study".equals(currentMode) ? "进入学习模式" : "退出学习模式");
        }

        // 屏幕行为洞察：截屏设置与今日额度。
        // 额度必须落盘 —— 离线时设备端还要靠它兜底锁屏。
        boolean captureChanged = config.captureEnabled != store.isCaptureEnabled();
        store.setCaptureEnabled(config.captureEnabled);
        store.setCaptureIntervalSeconds(config.captureIntervalSeconds);
        store.setFramesPerBatch(config.framesPerBatch);
        store.setQuizFromScreen(config.quizFromScreen);
        store.setGameRoundsBudget(config.gameRoundsLimited, config.gameRoundsLimit, config.gameRoundsUsed);
        store.setVideoEpisodesBudget(config.videoEpisodesLimited, config.videoEpisodesLimit, config.videoEpisodesUsed);
        if (captureChanged) {
            EventLog.warn(config.captureEnabled
                    ? "家长已开启周期截屏（每 " + config.captureIntervalSeconds + " 秒一张，"
                            + config.framesPerBatch + " 张一包）"
                    : "家长已关闭周期截屏，正在清空本地缓存帧");
            if (!config.captureEnabled) {
                com.balloondog.agent.capability.ScreenSampler.clear(this);
            }
        }

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

                // ---- 1.5) 护眼计时 ----
                // 必须排在 LockState 判定之前：这一秒刚好到点的话，
                // 同一次 tick 就应该直接进入强制休息，而不是等下一秒。
                boolean eyeChanged = false;
                try {
                    eyeChanged = eyeCare.tick(isScreenInteractive(), store.isLocked(), nowWall);
                    if (eyeChanged) {
                        recordEvent(Constants.EVENT_EYE_REST, "护眼：进入强制休息");
                    }
                } catch (Exception e) {
                    EventLog.warn("护眼计时异常：" + e.getMessage());
                }

                // ---- 2) 判定 + 落地 ----
                LockState state = LockState.compute(
                        com.balloondog.agent.capability.LockEnforcer.buildInputs(store, nowWall));
                boolean changed = lockEnforcer.apply(this, store, state, store.isQuizEnabled());

                // ---- 3) 锁定状态复核：即便状态没翻转，也要核实「实际是不是真锁着」。
                //      孩子用任何办法把锁屏弄掉，这里都会在 3 秒内发现并重新锁上。
                if (lockReassertor != null && lockReassertor.tick()) {
                    changed = true;
                }

                // ---- 4) 周期截屏采样与打包上传（家长开启后才做）----
                tickScreenSampling(nowWall);

                // ---- 4.5) 应用清单与设备事件上报 ----
                tickAppInventory(nowWall);
                tickEventFlush(nowWall);
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

    // ============================================================
    // 模式 / 护眼 / 应用的支撑逻辑
    // ============================================================

    /** 转发过来的广播里是否带了「用户已解锁」标记（见 ScreenStateReceiver）。 */
    private static boolean isUserPresentExtra(android.content.Intent intent) {
        return intent != null && intent.getBooleanExtra("userPresent", false);
    }

    /** 屏幕是否亮着（护眼计时与「亮屏才算用眼」的判据）。 */
    private boolean isScreenInteractive() {
        try {
            android.os.PowerManager pm =
                    (android.os.PowerManager) getSystemService(POWER_SERVICE);
            return pm != null && pm.isInteractive();
        } catch (Exception e) {
            // 读不到就当作熄屏：宁可少算一次用眼，也不要因为异常把休息计时算错
            return false;
        }
    }

    /**
     * 记一条设备事件，攒着批量上报。
     *
     * <p>供本类与无障碍看门狗（拦截事件）调用。用静态实例指针而不是让看门狗自己发请求：
     * 上报要走同一个令牌刷新与 401 重试链路，散落成多处迟早会出现「某一处没重试」。
     */
    public static void recordEventStatic(String type, String detail) {
        AgentService instance = current;
        if (instance != null) instance.recordEvent(type, detail);
    }

    private void recordEvent(String type, String detail) {
        try {
            org.json.JSONObject o = new org.json.JSONObject();
            o.put("type", type);
            o.put("detail", detail == null ? "" : detail);
            o.put("at", System.currentTimeMillis());
            pendingEvents.add(o);
            // 事件流是展示用的，堆太多没意义；超出就丢最旧的
            while (pendingEvents.size() > 200) pendingEvents.remove(0);
        } catch (Exception ignored) {
            // 记事件失败绝不能影响主流程
        }
    }

    /** 定期把攒下的事件发上去。 */
    private void tickEventFlush(long nowWall) {
        if (pendingEvents.isEmpty()) return;
        if (lastEventFlushAt != 0
                && nowWall - lastEventFlushAt < Constants.EVENT_FLUSH_INTERVAL_MS) {
            return;
        }
        lastEventFlushAt = nowWall;

        java.util.List<org.json.JSONObject> batch;
        synchronized (pendingEvents) {
            batch = new java.util.ArrayList<>(pendingEvents);
            pendingEvents.clear();
        }
        try {
            api.reportEvents(store.getBaseUrl(), new org.json.JSONArray(batch));
        } catch (Exception e) {
            // 发失败就丢掉这一批：事件是展示用的动态流，不值得为它做重试队列
            // （重试队列是给指令结果那种「必须送达」的东西准备的）。
            EventLog.warn("上报设备事件失败（本批 " + batch.size() + " 条，已丢弃）："
                    + e.getMessage());
        }
    }

    /**
     * 应用清单上报。
     *
     * <p>平时每 12 小时一次（应用安装/卸载并不频繁），家长点「刷新应用列表」时会
     * 通过 sync_apps 指令立刻触发一次。
     */
    private void tickAppInventory(long nowWall) {
        long last = store.getAppsReportedAt();
        if (last != 0 && nowWall - last < Constants.APP_REPORT_INTERVAL_MS) return;
        reportAppsNow();
    }

    /** 立刻上报应用清单（也会顺带刷新本地可启动应用缓存）。 */
    public void reportAppsNow() {
        try {
            appInventory.scan(this);
            java.util.List<com.balloondog.agent.capability.AppInventory.AppEntry> apps =
                    appInventory.snapshot(this);
            api.reportApps(store.getBaseUrl(), apps);
            store.setAppsReportedAt(System.currentTimeMillis());
            EventLog.info("已上报应用清单，共 " + apps.size() + " 个");
        } catch (Exception e) {
            EventLog.warn("上报应用清单失败：" + e.getMessage());
        }
    }

    /** 供无障碍看门狗做学习模式拦截时查询「这个包是不是可启动的普通应用」。 */
    public com.balloondog.agent.capability.AppInventory appInventory() {
        return appInventory;
    }

    /**
     * 周期截屏与上传。
     *
     * <p>采样与上传都在 ticker 线程里串行做：截图本身要几百毫秒，
     * 并发只会让投影争用（和采集类指令同一个道理）。
     * 上传走网络可能较慢，但它有自己的退避，失败不会卡住 ticker。
     */
    private void tickScreenSampling(long nowWall) {
        if (screenSampler == null || frameUploader == null) return;
        if (!store.isCaptureEnabled()) return;

        try {
            java.util.List<com.balloondog.agent.capability.ScreenSampler.SampledFrame> batch =
                    screenSampler.maybeSample(nowWall);
            if (batch != null && !batch.isEmpty()) {
                frameUploader.upload(batch);
            }
        } catch (Exception e) {
            // 采样绝不能把 ticker 弄挂 —— 它挂了锁定复核也就停了
            EventLog.warn("截屏采样异常：" + e.getMessage());
        }
    }

    private void registerScreenStateReceiver() {
        if (screenStateReceiver != null) return;
        screenStateReceiver = new ScreenStateReceiver();
        android.content.IntentFilter filter = new android.content.IntentFilter();
        filter.addAction(android.content.Intent.ACTION_SCREEN_ON);
        filter.addAction(android.content.Intent.ACTION_USER_PRESENT);
        try {
            if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.TIRAMISU) {
                // 必须是 EXPORTED：ACTION_USER_PRESENT 由 com.android.systemui（另一个 uid）发出，
                // RECEIVER_NOT_EXPORTED 会被系统直接判为「Exported Denial」丢弃 ——
                // 实测日志：BroadcastQueue: Exported Denial: sending Intent { act=...USER_PRESENT }
                // ... not specifying RECEIVER_EXPORTED。也就是「解锁完成」这一刻我们根本收不到。
                //
                // 被第三方伪造的风险可接受：这个接收器只会触发一次「锁定状态复核」，
                // 而复核只会让设备更锁、绝不会解锁，所以伪造最多造成一次多余的重新锁定。
                registerReceiver(screenStateReceiver, filter, Context.RECEIVER_EXPORTED);
            } else {
                registerReceiver(screenStateReceiver, filter);
            }
        } catch (Exception e) {
            EventLog.warn("注册亮屏监听失败：" + e.getMessage());
            screenStateReceiver = null;
        }
    }

    private void unregisterScreenStateReceiver() {
        if (screenStateReceiver == null) return;
        try {
            unregisterReceiver(screenStateReceiver);
        } catch (IllegalArgumentException ignored) {
            // 未注册成功时忽略
        }
        screenStateReceiver = null;
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
