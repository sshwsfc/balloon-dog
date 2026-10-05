package com.balloondog.agent.capability;

import android.content.Context;
import android.text.TextUtils;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;

import com.balloondog.agent.data.AgentStore;
import com.balloondog.agent.data.Constants;
import com.balloondog.agent.data.EventLog;
import com.balloondog.agent.model.AgentCommand;
import com.balloondog.agent.model.DeviceConfig;
import com.balloondog.agent.model.MediaRef;
import com.balloondog.agent.net.AgentApi;
import com.balloondog.agent.net.ApiException;
import com.balloondog.agent.service.AgentService;
import com.balloondog.agent.service.LockWatchdogService;

import org.json.JSONException;
import org.json.JSONObject;

/**
 * 把一条指令真正执行掉。
 *
 * <p>这是整个 Agent 的核心：服务端只会「把指令排进队列」，真正让锁屏发生、让照片出现、
 * 让录音上传的，只有这里。每条指令都返回一个明确成败的结论 ——
 * 失败必须带可读原因，绝不静默吞掉（否则家长端会显示「已下发」而设备毫无反应）。
 *
 * <pre>
 * 指令类型                真实动作                                  回报结果
 * ─────────────────────  ────────────────────────────────────────  ────────────────────────
 * lock                   DevicePolicyManager.lockNow()             { locked: true }
 * unlock                 setKeyguardDisabled(true) + 收起遮罩       { locked: false }
 * temp_unlock            本地放开 N 分钟，到期自动回锁               { until, minutes }
 * cancel_temp_unlock     立刻回到锁定态                            { locked: true }
 * remote_photo           Camera2 前置摄像头拍 JPEG → 上传           { mediaId }
 * screenshot             MediaProjection 截屏 → 上传               { mediaId }
 * start_recording        MediaProjection + MediaRecorder 起录        { recordingId }
 * stop_recording         停止录制 → 上传 MP4                       { mediaId, recordingId }
 * start_audio            MediaRecorder 麦克风起录                   { recordingId }
 * stop_audio             停止录音 → 上传 M4A                       { mediaId, recordingId }
 * fetch_location         LocationManager 取点 → POST /agent/locations { reported, latitude… }
 * sync_config            重新拉取并应用管控策略                      { synced: true }
 * sync_apps              重新扫描并上报已安装应用清单                { synced: true }
 * start_ambient          每 5 分钟一段循环录音 → 逐段上传（有安全阀）  { chunkSeconds }
 * stop_ambient           停止环境监听（当前段录完即上传）             { stopped: true }
 * remote_action          无障碍全局动作 / 拉起指定应用                { action, performed }
 * sync_calls_sms         立刻读取通话记录与短信并上报                { summary }
 * </pre>
 */
public class CommandExecutor {

    /** 单条指令的执行结论。 */
    public static final class Outcome {
        public final boolean succeeded;
        public final JSONObject result;
        public final String error;

        private Outcome(boolean succeeded, @Nullable JSONObject result, @Nullable String error) {
            this.succeeded = succeeded;
            this.result = result == null ? new JSONObject() : result;
            this.error = error;
        }

        static Outcome ok(@NonNull JSONObject result) {
            return new Outcome(true, result, null);
        }

        static Outcome fail(String message) {
            return new Outcome(false, null, truncate(message));
        }
    }

    /** 服务端 agentCommandResultSchema 限制 error 最长 500 字符。 */
    private static String truncate(String message) {
        if (message == null) return "未知错误";
        return message.length() <= 480 ? message : message.substring(0, 477) + "…";
    }

    private final Context appContext;
    private final AgentStore store;
    private final AgentApi api;
    private final ConfigApplier configApplier;

    /** 由 AgentService 提供：应用一份新拉到的管控策略。 */
    public interface ConfigApplier {
        DeviceConfig applyConfig() throws ApiException;

        /**
         * 让 Agent 立刻上报一次已安装应用清单（`sync_apps` 指令用）。
         *
         * <p>它是唯一一条「读类」指令：不改变设备状态，只把清单发上去。
         */
        void reportAppsNow();
    }

    public CommandExecutor(Context context, AgentStore store, ConfigApplier configApplier) {
        this.appContext = context.getApplicationContext();
        this.store = store;
        this.api = new AgentApi();
        this.configApplier = configApplier;
    }

    /**
     * 执行一条指令。
     *
     * <p>方法内部<b>不会</b>抛异常：任何失败都收敛成 {@link Outcome#succeeded}=false，
     * 由调用方统一回报给服务端。
     */
    public Outcome execute(@NonNull AgentCommand command) {
        EventLog.info("开始执行：" + command.label + "（" + command.type + "）");
        try {
            switch (command.type) {
                case Constants.CMD_LOCK:
                    return doLock();
                case Constants.CMD_UNLOCK:
                    return doUnlock();
                case Constants.CMD_TEMP_UNLOCK:
                    return doTempUnlock(command);
                case Constants.CMD_CANCEL_TEMP_UNLOCK:
                    return doCancelTempUnlock();
                case Constants.CMD_REMOTE_PHOTO:
                    return doRemotePhoto(command);
                case Constants.CMD_SCREENSHOT:
                    return doScreenshot(command);
                case Constants.CMD_START_RECORDING:
                    return doStartRecording();
                case Constants.CMD_STOP_RECORDING:
                    return doStopRecording(command);
                case Constants.CMD_START_AUDIO:
                    return doStartAudio();
                case Constants.CMD_STOP_AUDIO:
                    return doStopAudio(command);
                case Constants.CMD_FETCH_LOCATION:
                    return doFetchLocation();
                case Constants.CMD_SYNC_CONFIG:
                    return doSyncConfig();
                case Constants.CMD_SYNC_APPS:
                    return doSyncApps();
                case Constants.CMD_START_AMBIENT:
                    return doStartAmbient(command);
                case Constants.CMD_STOP_AMBIENT:
                    return doStopAmbient();
                case Constants.CMD_REMOTE_ACTION:
                    return doRemoteAction(command);
                case Constants.CMD_SYNC_CALLS_SMS:
                    return doSyncCallsSms();
                default:
                    return Outcome.fail("不支持的指令类型：" + command.type);
            }
        } catch (CapabilityException e) {
            EventLog.error(command.label + "执行失败：" + e.getMessage());
            return Outcome.fail(e.getMessage());
        } catch (ApiException e) {
            EventLog.error(command.label + "上报失败：" + e.describe());
            return Outcome.fail("与服务器通信失败：" + e.userMessage());
        } catch (Exception e) {
            EventLog.error(command.label + "执行异常：" + e);
            return Outcome.fail("执行异常：" + e.getClass().getSimpleName()
                    + (e.getMessage() == null ? "" : " " + e.getMessage()));
        }
    }

    // ============================================================
    // 锁屏 / 解锁
    // ============================================================

    private Outcome doLock() {
        // 家长显式锁定必须压过之前留下的一切放行宽限：
        // 否则「家长先点了解锁（拿到 30 分钟宽限）、随后又点锁定」会变成锁不上 ——
        // 这是个真实踩到过的坑，宽限状态留在本地就会让远程锁定静默失效。
        store.setLockState(true, 0L);
        store.setManualUnlockUntil(0L);

        boolean systemLocked = LockController.lockNow(appContext);
        LockController.setStatusBarDisabled(appContext, true);

        JSONObject result = new JSONObject();
        try {
            result.put("locked", true);
            result.put("systemLock", systemLocked);
            result.put("message", systemLocked
                    ? "已调用系统锁屏"
                    : "未激活设备管理器，仅弹出应用内锁定页");
        } catch (JSONException ignored) {
            // 原生类型
        }
        // 没有设备管理器时不算失败：遮罩锁定仍然生效，但要如实告知强度
        EventLog.success("锁屏指令已执行");
        return Outcome.ok(result);
    }

    private Outcome doUnlock() {
        LockController.unlock(appContext);
        LockController.setStatusBarDisabled(appContext, false);
        store.setLockState(false, 0L);

        // 远程解锁要「好用」：如果此刻作息表正处在锁定窗口内（比如 22:30 点了解锁，
        // 而作息是 22:00→07:00），不设宽限的话设备下一轮判定就会立刻又锁上。
        // 所以把宽限精确设为「下一次本会锁定的时刻」——复用 LockState 的同一套推算，
        // 不自己拍一个 30 分钟。若未来 7 天内都不会锁，就是 0，不需要任何宽限。
        LockState.Inputs inputs = com.balloondog.agent.capability.LockEnforcer
                .buildInputs(store, System.currentTimeMillis());
        inputs.remoteLocked = false;
        inputs.grantUntil = 0L;
        long nextLockAt = LockState.findNextLockAt(inputs);
        store.setManualUnlockUntil(nextLockAt);
        EventLog.info(nextLockAt > 0
                ? "已解除锁定，将在下一个锁定点（" + com.balloondog.agent.model.JsonUtils.toIso(nextLockAt) + "）恢复"
                : "已解除锁定，当前策略下不会自动重新锁定");

        JSONObject result = new JSONObject();
        try {
            result.put("locked", false);
            result.put("deviceOwner", LockController.isDeviceOwner(appContext));
        } catch (JSONException ignored) {
            // 原生类型
        }
        EventLog.success("解锁指令已执行");
        return Outcome.ok(result);
    }

    private Outcome doTempUnlock(AgentCommand command) {
        long minutes = command.payloadLong("minutes", 30L);
        String untilText = command.payloadString("until");
        long untilMillis = com.balloondog.agent.model.JsonUtils.parseIsoMillis(untilText);
        if (untilMillis <= 0) {
            untilMillis = System.currentTimeMillis() + minutes * 60_000L;
        }

        store.setLockState(false, untilMillis);
        LockController.unlock(appContext);
        LockController.setStatusBarDisabled(appContext, false);

        JSONObject result = new JSONObject();
        try {
            result.put("until", com.balloondog.agent.model.JsonUtils.toIso(untilMillis));
            result.put("minutes", minutes);
        } catch (JSONException ignored) {
            // 原生类型
        }
        EventLog.success("临时解锁 " + minutes + " 分钟，到期自动恢复锁定");
        return Outcome.ok(result);
    }

    private Outcome doCancelTempUnlock() {
        store.setLockState(true, 0L);
        store.setManualUnlockUntil(0L);
        LockController.restoreKeyguard(appContext);
        LockController.setStatusBarDisabled(appContext, true);
        LockController.lockNow(appContext);

        JSONObject result = new JSONObject();
        try {
            result.put("locked", true);
        } catch (JSONException ignored) {
            // 原生类型
        }
        EventLog.success("已取消临时解锁并恢复锁定");
        return Outcome.ok(result);
    }

    // ============================================================
    // 采集类
    // ============================================================

    private Outcome doRemotePhoto(AgentCommand command) throws CapabilityException, ApiException {
        byte[] jpeg = PhotoCapturer.captureJpeg(appContext, true, 25_000L);
        String filename = "photo-" + System.currentTimeMillis() + ".jpg";
        MediaRef media = api.uploadMedia(store.getBaseUrl(), jpeg, filename,
                "image/jpeg", "photo", command.id);
        if (media == null) {
            return Outcome.fail("照片已拍摄，但服务端没有返回媒体记录");
        }

        JSONObject result = new JSONObject();
        try {
            // mediaId 必须回填：家长端的指令历史靠它关联到这张照片
            result.put("mediaId", media.id);
            result.put("sizeBytes", media.sizeBytes);
        } catch (JSONException ignored) {
            // 原生类型
        }
        EventLog.success("远程拍照完成并已上传：" + media.id);
        return Outcome.ok(result);
    }

    private Outcome doScreenshot(AgentCommand command) throws CapabilityException, ApiException {
        byte[] jpeg = ScreenCapturer.captureScreenshot(appContext, 20_000L);
        String filename = "screenshot-" + System.currentTimeMillis() + ".jpg";
        MediaRef media = api.uploadMedia(store.getBaseUrl(), jpeg, filename,
                "image/jpeg", "screenshot", command.id);
        if (media == null) {
            return Outcome.fail("屏幕截图已生成，但服务端没有返回媒体记录");
        }

        JSONObject result = new JSONObject();
        try {
            result.put("mediaId", media.id);
            result.put("sizeBytes", media.sizeBytes);
        } catch (JSONException ignored) {
            // 原生类型
        }
        EventLog.success("屏幕截图完成并已上传：" + media.id);
        return Outcome.ok(result);
    }

    private Outcome doStartRecording() throws CapabilityException {
        String id = ScreenCapturer.startVideo(appContext, 20_000L);
        JSONObject result = new JSONObject();
        try {
            result.put("recordingId", id);
        } catch (JSONException ignored) {
            // 原生类型
        }
        return Outcome.ok(result);
    }

    private Outcome doStopRecording(AgentCommand command) throws CapabilityException, ApiException {
        String expected = command.payloadString("recordingId");
        String actual = ScreenCapturer.currentRecordingId();
        if (actual == null) {
            throw new CapabilityException("设备上没有正在进行的录像");
        }
        if (!TextUtils.isEmpty(expected) && !expected.equals(actual)) {
            throw new CapabilityException("录像 ID 不匹配（设备上是 " + actual + "），可能已结束");
        }

        ScreenCapturer.VideoClip clip = ScreenCapturer.stopVideo(appContext);
        String filename = "video-" + System.currentTimeMillis() + ".mp4";
        MediaRef media = api.uploadMedia(store.getBaseUrl(), clip.bytes, filename,
                "video/mp4", "video", command.id);
        if (media == null) {
            return Outcome.fail("录像已生成，但服务端没有返回媒体记录");
        }

        JSONObject result = new JSONObject();
        try {
            result.put("mediaId", media.id);
            result.put("recordingId", clip.recordingId);
            result.put("durationSeconds", clip.durationMillis / 1000);
        } catch (JSONException ignored) {
            // 原生类型
        }
        EventLog.success("录像完成并已上传：" + media.id);
        return Outcome.ok(result);
    }

    private Outcome doStartAudio() throws CapabilityException {
        String id = AudioRecorder.start(appContext);
        JSONObject result = new JSONObject();
        try {
            result.put("recordingId", id);
        } catch (JSONException ignored) {
            // 原生类型
        }
        return Outcome.ok(result);
    }

    private Outcome doStopAudio(AgentCommand command) throws CapabilityException, ApiException {
        String expected = command.payloadString("recordingId");
        String actual = AudioRecorder.currentRecordingId();
        if (actual == null) {
            throw new CapabilityException("设备上没有正在进行的录音");
        }
        if (!TextUtils.isEmpty(expected) && !expected.equals(actual)) {
            throw new CapabilityException("录音 ID 不匹配（设备上是 " + actual + "），可能已结束");
        }

        AudioRecorder.AudioClip clip = AudioRecorder.stop(appContext);
        String filename = "audio-" + System.currentTimeMillis() + ".m4a";
        // 服务端白名单：audio/mp4 → .m4a
        MediaRef media = api.uploadMedia(store.getBaseUrl(), clip.bytes, filename,
                "audio/mp4", "audio", command.id);
        if (media == null) {
            return Outcome.fail("录音已生成，但服务端没有返回媒体记录");
        }

        JSONObject result = new JSONObject();
        try {
            result.put("mediaId", media.id);
            result.put("recordingId", clip.recordingId);
            result.put("durationSeconds", clip.durationMillis / 1000);
        } catch (JSONException ignored) {
            // 原生类型
        }
        EventLog.success("录音完成并已上传：" + media.id);
        return Outcome.ok(result);
    }

    // ============================================================
    // 位置 / 配置
    // ============================================================

    private Outcome doFetchLocation() throws CapabilityException, ApiException {
        LocationReader.Fix fix = LocationReader.read(appContext, 15_000L);
        api.reportLocation(store.getBaseUrl(), fix.latitude, fix.longitude, fix.accuracy, fix.address);
        // 自动上报那条路径会在 AgentService 里做安全区判定，这条也得做 ——
        // 否则「家长主动取一次位置」反而不会产生进出安全区的事件，看起来像围栏失灵
        AgentService.evaluateGeofenceStatic(fix.latitude, fix.longitude);

        JSONObject result = new JSONObject();
        try {
            result.put("reported", true);
            result.put("latitude", fix.latitude);
            result.put("longitude", fix.longitude);
            result.put("accuracy", fix.accuracy);
            result.put("address", fix.address == null ? "" : fix.address);
        } catch (JSONException ignored) {
            // 原生类型
        }
        EventLog.success(String.format(java.util.Locale.US,
                "已上报位置 %.5f, %.5f", fix.latitude, fix.longitude));
        return Outcome.ok(result);
    }

    /**
     * 重新上报已安装应用清单。
     *
     * <p>这是唯一一条「读类」指令：它不改变设备状态，只是把清单发上去，
     * 好让家长端的选择应用 / 功能管控看到最新的安装情况。
     */
    private Outcome doSyncApps() {
        if (configApplier == null) {
            return Outcome.fail("服务尚未就绪，无法上报应用清单");
        }
        configApplier.reportAppsNow();
        JSONObject result = new JSONObject();
        try {
            result.put("synced", true);
        } catch (JSONException ignored) {
            // 原生类型
        }
        return Outcome.ok(result);
    }

    private Outcome doSyncConfig() throws ApiException {
        DeviceConfig config = configApplier.applyConfig();
        JSONObject result = new JSONObject();
        try {
            result.put("synced", true);
            result.put("bound", config.bound);
            result.put("locked", config.locked);
            result.put("features", AgentApi.toJsonArray(config.features));
        } catch (JSONException ignored) {
            // 原生类型
        }
        return Outcome.ok(result);
    }

    // ============================================================
    // 环境监听（契约 §6）/ 远程协助（契约 §7）/ 电话短信（契约 §8）
    // ============================================================

    /**
     * 开始环境监听：每 N 秒一段循环录音，录完一段立刻上传一段。
     *
     * <p>要求的是 {@code audioRecord} 特性，<b>不是</b> {@code remoteRecord} ——
     * 后者对应的是「家长手动触发一次录音」（{@code start_audio}），
     * 两者在家长端是两个独立的开关，混用会让家长以为自己只开了其中一个。
     *
     * <p>这件事是<b>可见</b>的：前台通知明确写着「家长开启了环境监听」。
     * 也不在进程被杀后自动恢复 —— 进程都没了还接着录，那不叫守护。
     */
    private Outcome doStartAmbient(AgentCommand command) {
        if (!store.isFeatureEnabled("audioRecord")) {
            return Outcome.fail("家长端未开启「环境监听」，该指令不执行");
        }
        long requested = command.payloadLong("chunkSeconds", Constants.AMBIENT_CHUNK_MS / 1000L);
        // 夹到 60~900 秒：太短会造出成百上千个小文件，太长则「停止」要等很久才生效
        int chunkSeconds = (int) Math.max(60L, Math.min(900L, requested));

        try {
            String message = AmbientRecorder.start(appContext, store, api, chunkSeconds);
            JSONObject result = new JSONObject();
            try {
                result.put("chunkSeconds", chunkSeconds);
                result.put("maxTotalMinutes", Constants.AMBIENT_MAX_TOTAL_MS / 60_000L);
                result.put("message", message);
            } catch (JSONException ignored) {
                // 原生类型
            }
            return Outcome.ok(result);
        } catch (CapabilityException e) {
            return Outcome.fail(e.getMessage());
        }
    }

    /**
     * 停止环境监听。
     *
     * <p>本来就没在跑时也返回成功 —— 家长要的结果（不再录音）已经达成，
     * 这时候报失败只会让家长端显示一个假的「执行失败」。
     */
    private Outcome doStopAmbient() {
        boolean wasRunning = AmbientRecorder.isRunning();
        if (wasRunning) {
            AmbientRecorder.stop("家长停止环境监听");
        }
        JSONObject result = new JSONObject();
        try {
            result.put("stopped", wasRunning);
            result.put("message", wasRunning
                    ? "已停止环境监听（当前这一段录完即上传）"
                    : "环境监听本来就没有在运行");
        } catch (JSONException ignored) {
            // 原生类型
        }
        return Outcome.ok(result);
    }

    /**
     * 远程协助：执行一个无障碍全局动作，或拉起一个应用（契约 §7）。
     *
     * <p>如实说明它的能力边界：这是「远程操作 + 家长端看屏」，
     * <b>不是</b>实时投屏，也不是注入触摸的远程控制。做不到的动作一律失败并说清原因，
     * 绝不返回一个看起来成功的空转。
     */
    private Outcome doRemoteAction(AgentCommand command) {
        if (!store.isFeatureEnabled("remoteHelp")) {
            return Outcome.fail("家长端未开启「远程协助」，该指令不执行");
        }
        String action = command.payloadString("action");
        if (TextUtils.isEmpty(action)) {
            return Outcome.fail("remote_action 缺少 action 参数");
        }

        if ("open_app".equals(action)) {
            String packageName = command.payloadString("packageName");
            if (TextUtils.isEmpty(packageName)) {
                return Outcome.fail("open_app 需要 packageName 参数");
            }
            String error = LockWatchdogService.launchApp(appContext, packageName);
            if (error != null) return Outcome.fail(error);
            JSONObject result = new JSONObject();
            try {
                result.put("action", action);
                result.put("packageName", packageName);
                result.put("performed", true);
            } catch (JSONException ignored) {
                // 原生类型
            }
            EventLog.success("远程协助：已拉起 " + packageName);
            return Outcome.ok(result);
        }

        int globalAction;
        switch (action) {
            case "back":
                globalAction = android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_BACK;
                break;
            case "home":
                globalAction = android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_HOME;
                break;
            case "recents":
                globalAction = android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_RECENTS;
                break;
            case "notifications":
                globalAction = android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_NOTIFICATIONS;
                break;
            default:
                return Outcome.fail("不支持的远程动作：" + action
                        + "（支持 back/home/recents/notifications/open_app）");
        }

        if (!LockWatchdogService.performRemoteGlobalAction(globalAction)) {
            return Outcome.fail("远程操作失败：无障碍服务未连接"
                    + "（请家长在系统设置里重新开启气球狗的「无障碍」开关）");
        }
        JSONObject result = new JSONObject();
        try {
            result.put("action", action);
            result.put("performed", true);
        } catch (JSONException ignored) {
            // 原生类型
        }
        EventLog.success("远程协助：已执行 " + action);
        return Outcome.ok(result);
    }

    /**
     * 立刻读一次通话记录与短信并上报（契约 §8）。
     *
     * <p>两个权限一个都没给时如实报失败：返回成功、家长端显示「已刷新」，
     * 但服务端什么新数据都没收到，这就是在伪造。
     */
    private Outcome doSyncCallsSms() {
        if (!CallLogReader.hasPermission(appContext) && !SmsReader.hasPermission(appContext)) {
            return Outcome.fail("未授予「读取通话记录」和「读取短信」权限，无法上报通话与短信");
        }
        String summary = CallsSmsUploader.upload(appContext, store, api);
        JSONObject result = new JSONObject();
        try {
            result.put("synced", true);
            result.put("summary", summary);
        } catch (JSONException ignored) {
            // 原生类型
        }
        return Outcome.ok(result);
    }
}
