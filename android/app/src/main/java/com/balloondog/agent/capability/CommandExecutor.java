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
}
