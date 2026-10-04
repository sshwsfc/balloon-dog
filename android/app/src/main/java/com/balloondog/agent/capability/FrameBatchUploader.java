package com.balloondog.agent.capability;

import android.content.Context;
import android.os.SystemClock;

import com.balloondog.agent.data.AgentStore;
import com.balloondog.agent.data.Constants;
import com.balloondog.agent.data.EventLog;
import com.balloondog.agent.net.AgentApi;
import com.balloondog.agent.net.ApiException;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.List;

/**
 * 把一批采样帧打包上传到服务端。
 *
 * <h3>打包格式</h3>
 * 一个 ZIP 包（stored 模式，见 {@link FrameBatchArchiver}）：
 * <pre>
 *   frame-0000.jpg … frame-0009.jpg   低分辨率 JPEG，按时间顺序
 *   manifest.json                     每帧的拍摄时刻与前台包名
 * </pre>
 * 之所以把 manifest 也放进包里：服务端解包后即使拿不到表单字段，
 * 也能从包里恢复出完整的元数据，排查问题时不依赖「请求体还在不在」。
 *
 * <h3>失败与重试</h3>
 * 上传失败<b>不删除</b>本地帧，按 5s / 15s / 60s 退避重试。
 * 一个包最多尝试 {@link #MAX_ATTEMPTS} 次；超过后丢弃并如实记日志 ——
 * 不能让一个永远传不上去的包把磁盘配额一直占着，那会把后面的新帧挤掉。
 */
public final class FrameBatchUploader {

    private static final long[] BACKOFF_MS = { 5_000L, 15_000L, 60_000L };
    private static final int MAX_ATTEMPTS = 5;

    private final Context appContext;
    private final AgentStore store;
    private final AgentApi api = new AgentApi();

    private long lastAttemptAt;
    private int attempts;
    /** 当前这批的第一帧时间，用于识别「换了一批就重置失败计数」。 */
    private long currentBatchStart;

    public FrameBatchUploader(Context context, AgentStore store) {
        this.appContext = context.getApplicationContext();
        this.store = store;
    }

    /**
     * 由 Agent 主循环调用的入口。
     *
     * @param frames 待上传的批次（由 {@link ScreenSampler#takeBatchIfReady()} 给出）
     * @return 本次是否成功上传
     */
    public boolean upload(List<ScreenSampler.SampledFrame> frames) {
        if (frames == null || frames.isEmpty()) return false;

        // 换了一批就重置退避，避免上一批的失败拖慢新批次
        long batchStart = frames.get(0).capturedAt;
        if (batchStart != currentBatchStart) {
            currentBatchStart = batchStart;
            attempts = 0;
            lastAttemptAt = 0;
        }

        long now = SystemClock.elapsedRealtime();
        long backoff = attempts == 0 ? 0 : BACKOFF_MS[Math.min(attempts - 1, BACKOFF_MS.length - 1)];
        if (lastAttemptAt != 0 && now - lastAttemptAt < backoff) return false;
        lastAttemptAt = now;

        if (attempts >= MAX_ATTEMPTS) {
            EventLog.warn("该截屏包连续 " + MAX_ATTEMPTS + " 次上传失败，已丢弃 "
                    + frames.size() + " 帧，避免占满磁盘配额");
            ScreenSampler.deleteFrames(frames);
            attempts = 0;
            currentBatchStart = 0;
            return false;
        }

        try {
            byte[] zip = buildZip(frames);
            JSONArray meta = new JSONArray();
            for (int i = 0; i < frames.size(); i++) {
                ScreenSampler.SampledFrame frame = frames.get(i);
                JSONObject item = new JSONObject();
                item.put("seq", i);
                item.put("capturedAt", com.balloondog.agent.model.JsonUtils.toIso(frame.capturedAt));
                item.put("packageName", frame.packageName == null ? "" : frame.packageName);
                meta.put(item);
            }

            long endedAt = frames.get(frames.size() - 1).capturedAt;
            AgentApi.ScreenBatchAck ack = api.uploadScreenBatch(
                    store.getBaseUrl(), zip,
                    com.balloondog.agent.model.JsonUtils.toIso(frames.get(0).capturedAt),
                    com.balloondog.agent.model.JsonUtils.toIso(endedAt),
                    meta,
                    Constants.AGENT_VERSION);

            ScreenSampler.deleteFrames(frames);
            attempts = 0;
            currentBatchStart = 0;

            String analysisNote = ack.analysisProvider.isEmpty() ? "" : "（" + ack.analysisProvider + "）";
            EventLog.success("已上传截屏包 " + frames.size() + " 张，"
                    + (zip.length / 1024) + " KB" + analysisNote);
            if (!ack.analysisNote.isEmpty()) {
                EventLog.info("服务端分析说明：" + ack.analysisNote);
            }
            return true;
        } catch (ApiException e) {
            attempts++;
            EventLog.warn("上传截屏包失败（第 " + attempts + " 次）：" + e.userMessage());
            return false;
        } catch (Exception e) {
            attempts++;
            EventLog.warn("打包截屏失败（第 " + attempts + " 次）：" + e.getMessage());
            return false;
        }
    }

    /** 打 zip：帧图 + manifest.json。 */
    private byte[] buildZip(List<ScreenSampler.SampledFrame> frames) throws Exception {
        List<FrameBatchArchiver.Entry> entries = new ArrayList<>();

        JSONArray manifestFrames = new JSONArray();
        // 单包上限由服务端配置控制，这里先按 25 MB 自保，避免内存里拼出巨物
        long totalBytes = 0;

        for (int i = 0; i < frames.size(); i++) {
            ScreenSampler.SampledFrame frame = frames.get(i);
            byte[] data = readAll(frame.file);
            if (data == null) continue;
            totalBytes += data.length;
            if (totalBytes > 25L * 1024 * 1024) {
                EventLog.warn("截屏包超过 25 MB，本批只带上前 " + i + " 帧");
                break;
            }
            entries.add(new FrameBatchArchiver.Entry(
                    String.format(java.util.Locale.US, "frame-%04d.jpg", entries.size()), data));

            JSONObject item = new JSONObject();
            item.put("seq", entries.size() - 1);
            item.put("capturedAt", com.balloondog.agent.model.JsonUtils.toIso(frame.capturedAt));
            item.put("packageName", frame.packageName == null ? "" : frame.packageName);
            manifestFrames.put(item);
        }

        if (entries.isEmpty()) throw new IllegalStateException("没有任何可读的帧文件");

        JSONObject manifest = new JSONObject();
        manifest.put("frames", manifestFrames);
        manifest.put("agentVersion", Constants.AGENT_VERSION);
        manifest.put("note", "低分辨率采样帧（长边 480，JPEG q45）");
        entries.add(new FrameBatchArchiver.Entry("manifest.json",
                manifest.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8)));

        return FrameBatchArchiver.buildZip(entries);
    }

    private static byte[] readAll(File file) {
        if (!file.exists()) return null;
        try (InputStream in = new FileInputStream(file)) {
            byte[] buffer = new byte[(int) file.length()];
            int offset = 0;
            int read;
            while (offset < buffer.length && (read = in.read(buffer, offset, buffer.length - offset)) > 0) {
                offset += read;
            }
            return offset == buffer.length ? buffer : java.util.Arrays.copyOf(buffer, offset);
        } catch (Exception e) {
            // 文件被并发删除或损坏：当作这一帧不存在，不要因此让整批失败
            return null;
        }
    }

    /** 供界面展示的待上传状态。 */
    public static String describePending(Context context, AgentStore store) {
        int[] stats = ScreenSampler.pendingStats(context);
        int perBatch = Math.max(2, store.getFramesPerBatch());
        return stats[0] + " 帧待上传（约 " + (stats[0] / perBatch) + " 个包，"
                + (stats[1] / 1024) + " KB）";
    }
}
