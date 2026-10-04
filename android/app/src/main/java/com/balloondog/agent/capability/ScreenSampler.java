package com.balloondog.agent.capability;

import android.content.Context;

import com.balloondog.agent.data.AgentStore;
import com.balloondog.agent.data.EventLog;

import java.io.File;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.List;

/**
 * 周期截屏采样器。
 *
 * <h3>它做什么</h3>
 * 每 {@code captureIntervalSeconds} 秒截一张<b>低分辨率</b>屏（长边 480px、JPEG q=45，
 * 单张约 15~30 KB），落到应用缓存目录；攒够 {@code framesPerBatch}（默认 10）张后
 * 交给 {@link FrameBatchUploader} 打包上传。
 *
 * <h3>为什么元数据编码在文件名里</h3>
 * 帧要跨进程死亡存活 —— Agent 服务被系统回收是常态。把「拍摄时刻 + 前台包名」
 * 直接写进文件名（{@code 1727000000000_0000_com.tencent.mm.jpg}），
 * 重启后扫一遍目录就能重建整个待上传批次，不需要额外维护一份易丢的清单文件。
 *
 * <h3>磁盘配额</h3>
 * 缓存目录有硬上限：超过 {@link #MAX_PENDING_FRAMES} 张或 {@link #MAX_DIR_BYTES} 时
 * 丢弃最旧的帧。这是必须的 —— 后端长时间不可达时，采样器会一直往里写，
 * 没有配额会把这个孩子的手机存储占满。
 */
public final class ScreenSampler {

    /** 采样图的长边像素。够看清「在哪个界面、大概在做什么」，又不至于太占流量。 */
    private static final int SAMPLE_LONG_EDGE = 480;
    /** 采样 JPEG 质量。低分辨率下 q=45 仍然能看清文字标题。 */
    private static final int SAMPLE_JPEG_QUALITY = 45;
    /** 单张截图的超时。投影常驻时通常 200~400ms 出图。 */
    private static final long CAPTURE_TIMEOUT_MS = 8_000L;

    /** 待上传帧的硬上限（按 10 张一包算，约 10 个包）。 */
    private static final int MAX_PENDING_FRAMES = 120;
    /** 待上传目录的字节上限。 */
    private static final long MAX_DIR_BYTES = 8L * 1024 * 1024;

    private static final String DIR_NAME = "screen-frames";

    private final Context appContext;
    private final AgentStore store;

    /** 上一次采样的时刻（墙上时间）。 */
    private long lastSampleAt;

    public ScreenSampler(Context context, AgentStore store) {
        this.appContext = context.getApplicationContext();
        this.store = store;
    }

    /** 待上传的目录。 */
    public static File pendingDir(Context context) {
        File dir = new File(context.getCacheDir(), DIR_NAME);
        if (!dir.exists() && !dir.mkdirs()) {
            EventLog.warn("无法创建截图缓存目录：" + dir.getAbsolutePath());
        }
        return dir;
    }

    /**
     * 由 Agent 主循环每秒调用。
     *
     * @param nowMillis 当前墙上时间
     * @return 攒够一批时返回该批次的帧；否则 null
     */
    public List<SampledFrame> maybeSample(long nowMillis) {
        if (!store.isCaptureEnabled()) return null;

        // 锁定期间不采样。两个理由，缺一不可：
        //  1) 隐私与价值：这一刻屏幕上就是我们的锁定页，拍下来毫无分析价值；
        //  2) 更要紧的是，屏幕录制授权如果丢了（进程重启、Android 14 会话失效），
        //     采样器会去拉起 ProjectionConsentActivity 重新申请授权 ——
        //     那个系统弹框会盖在锁定页上面，等于**用一个系统弹框把锁屏顶掉了**。
        //     实测日志：START .../.capability.ProjectionConsentActivity from uid 10157
        //     出现在锁定之后，锁定界面因此没能在前台。
        try {
            LockState state = LockState.compute(
                    LockEnforcer.buildInputs(store, System.currentTimeMillis()));
            if (state.locked) return null;
        } catch (Exception e) {
            // 判定失败时按「不锁」处理，宁可少采一张也不要卡住采样
            EventLog.warn("采样前判定锁定状态失败：" + e.getMessage());
        }

        long interval = Math.max(10, store.getCaptureIntervalSeconds()) * 1000L;
        if (lastSampleAt != 0 && nowMillis - lastSampleAt < interval) {
            // 还没到下一张的时间，但可能已经有攒够的批次等着上传
            return takeBatchIfReady();
        }

        // 到点了：先试着截图。失败不推进 lastSampleAt，下一轮会立刻重试，
        // 这样「临时失败」不会让采样白白少一张
        try {
            byte[] jpeg = ScreenCapturer.captureScreenshotLowRes(
                    appContext, SAMPLE_LONG_EDGE, SAMPLE_JPEG_QUALITY, CAPTURE_TIMEOUT_MS);
            lastSampleAt = nowMillis;
            writeFrame(jpeg, nowMillis);
            enforceQuota();
        } catch (CapabilityException e) {
            // 屏幕录制授权失效是最常见的原因（Android 14 每次新会话都要重新授权）
            EventLog.warn("采样截图失败：" + e.getMessage());
            lastSampleAt = nowMillis; // 避免每秒钟都重试一次同样的失败
        } catch (Exception e) {
            EventLog.warn("采样截图异常：" + e.getMessage());
            lastSampleAt = nowMillis;
        }

        return takeBatchIfReady();
    }

    /** 攒够一批就取走。 */
    public List<SampledFrame> takeBatchIfReady() {
        List<SampledFrame> pending = listPending();
        int framesPerBatch = Math.max(2, store.getFramesPerBatch());
        if (pending.size() < framesPerBatch) return null;
        return new ArrayList<>(pending.subList(0, framesPerBatch));
    }

    /** 列出待上传的帧，按拍摄时间升序。 */
    public static List<SampledFrame> listPending(Context context) {
        return sortFrames(pendingDir(context));
    }

    private List<SampledFrame> listPending() {
        return listPending(appContext);
    }

    private static List<SampledFrame> sortFrames(File dir) {
        File[] files = dir.listFiles((d, name) -> name.endsWith(".jpg"));
        if (files == null || files.length == 0) return new ArrayList<>();

        List<SampledFrame> frames = new ArrayList<>(files.length);
        for (File file : files) {
            SampledFrame frame = SampledFrame.parse(file);
            if (frame != null) frames.add(frame);
        }
        frames.sort(Comparator.comparingLong(f -> f.capturedAt));
        return frames;
    }

    /** 写入一帧。文件名自带元数据，跨进程死亡可恢复。 */
    private void writeFrame(byte[] jpeg, long capturedAt) {
        String packageName = ForegroundAppTracker.packageAt(capturedAt);
        String safePackage = sanitize(packageName);
        File file = new File(pendingDir(appContext), capturedAt + "_" + safePackage + ".jpg");
        try {
            java.io.FileOutputStream out = new java.io.FileOutputStream(file);
            try {
                out.write(jpeg);
            } finally {
                out.close();
            }
        } catch (Exception e) {
            EventLog.warn("写入采样帧失败：" + e.getMessage());
        }
    }

    /** 上传成功后删除这些帧。 */
    public static void deleteFrames(List<SampledFrame> frames) {
        for (SampledFrame frame : frames) {
            //noinspection ResultOfMethodCallIgnored
            frame.file.delete();
        }
    }

    /** 清空全部待上传帧（家长关闭截屏时调用）。 */
    public static void clear(Context context) {
        File dir = pendingDir(context);
        File[] files = dir.listFiles();
        if (files == null) return;
        for (File file : files) {
            //noinspection ResultOfMethodCallIgnored
            file.delete();
        }
        EventLog.info("已清空待上传的采样帧");
    }

    /**
     * 磁盘配额。
     *
     * <p>后端不可达时帧会一直堆积，没有配额就会把这个孩子的手机存储占满 ——
     * 一个管控应用把手机撑爆是不可接受的失败模式。
     */
    private void enforceQuota() {
        List<SampledFrame> frames = listPending();
        long total = 0;
        for (SampledFrame frame : frames) total += frame.sizeBytes;

        int index = 0;
        // 从最旧的开始丢，直到同时满足条数与字节两个上限
        while (index < frames.size()
                && (frames.size() - index > MAX_PENDING_FRAMES || total > MAX_DIR_BYTES)) {
            SampledFrame frame = frames.get(index);
            total -= frame.sizeBytes;
            //noinspection ResultOfMethodCallIgnored
            frame.file.delete();
            index++;
        }
        if (index > 0) {
            EventLog.warn("采样帧超出配额，已丢弃最旧的 " + index + " 张");
        }
    }

    /** 当前待上传帧数与占用，供界面展示。 */
    public static int[] pendingStats(Context context) {
        List<SampledFrame> frames = listPending(context);
        long bytes = 0;
        for (SampledFrame frame : frames) bytes += frame.sizeBytes;
        return new int[] { frames.size(), (int) Math.min(Integer.MAX_VALUE, bytes) };
    }

    /** 包名里的字符会进文件名，只留字母数字与点，其余折成下划线。 */
    private static String sanitize(String packageName) {
        if (packageName == null || packageName.isEmpty()) return "unknown";
        StringBuilder sb = new StringBuilder(packageName.length());
        for (char c : packageName.toCharArray()) {
            sb.append(Character.isLetterOrDigit(c) || c == '.' ? c : '_');
        }
        return sb.toString();
    }

    /** 一帧采样图。 */
    public static final class SampledFrame {
        public final File file;
        public final long capturedAt;
        public final String packageName;
        public final long sizeBytes;

        SampledFrame(File file, long capturedAt, String packageName, long sizeBytes) {
            this.file = file;
            this.capturedAt = capturedAt;
            this.packageName = packageName;
            this.sizeBytes = sizeBytes;
        }

        /** 从 {@code <capturedAt>_<package>.jpg} 还原元数据。 */
        static SampledFrame parse(File file) {
            String name = file.getName();
            int dot = name.lastIndexOf('.');
            String stem = dot > 0 ? name.substring(0, dot) : name;
            int underscore = stem.indexOf('_');
            if (underscore <= 0) return null;
            try {
                long capturedAt = Long.parseLong(stem.substring(0, underscore));
                String pkg = stem.substring(underscore + 1);
                if ("unknown".equals(pkg)) pkg = "";
                return new SampledFrame(file, capturedAt, pkg, file.length());
            } catch (NumberFormatException e) {
                // 文件名不符合约定，跳过并删掉，避免它一直卡在队首
                //noinspection ResultOfMethodCallIgnored
                file.delete();
                return null;
            }
        }

        @Override
        public String toString() {
            return Arrays.toString(new Object[] { file.getName(), capturedAt, packageName });
        }
    }
}
