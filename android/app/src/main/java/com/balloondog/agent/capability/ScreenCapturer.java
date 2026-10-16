package com.balloondog.agent.capability;

import android.app.AppOpsManager;
import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.PixelFormat;
import android.hardware.display.DisplayManager;
import android.hardware.display.VirtualDisplay;
import android.media.Image;
import android.media.ImageReader;
import android.media.MediaRecorder;
import android.media.projection.MediaProjection;
import android.media.projection.MediaProjectionManager;
import android.os.Build;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.SystemClock;
import android.util.DisplayMetrics;
import android.view.WindowManager;

import androidx.annotation.Nullable;

import com.balloondog.agent.data.EventLog;
import com.balloondog.agent.service.ScreenCaptureService;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.nio.ByteBuffer;
import java.util.UUID;

/**
 * 屏幕截图与屏幕录像（MediaProjection 的真实实现）。
 *
 * <h3>为什么这么绕</h3>
 * 平台要求必须同时满足三件事，缺一不可：
 * <ol>
 *   <li><b>先有前台服务</b>：Android 14 要求先以 {@code mediaProjection} 类型进入前台，
 *       才能调用 {@code getMediaProjection()} —— 由 {@link ScreenCaptureService} 承担；</li>
 *   <li><b>先有用户授权</b>：授权令牌只能由 Activity 拿到 —— 由
 *       {@link ProjectionConsentActivity} 承担；</li>
 *   <li><b>复用投影实例</b>：Android 14 起一份授权只能换一次 {@code MediaProjection}，
 *       本类把它缓存在静态字段里反复使用，「连续截两张图」不会弹两次授权。</li>
 * </ol>
 *
 * <h3>截图</h3>
 * {@code VirtualDisplay} + {@code ImageReader(RGBA_8888)} → Bitmap → JPEG。
 * 之所以不用 {@code PixelFormat.RGBA_8888} 之外的格式，是因为它免去了 YUV→RGB 的色彩转换，
 * 代码短且不容易出色偏。
 *
 * <h3>录像</h3>
 * {@code MediaRecorder(videoSource=SURFACE)} + {@code VirtualDisplay}，输出 MP4/H.264。
 * 分辨率按「长边不超过 {@link #VIDEO_MAX_LONG_EDGE}」等比缩放 —— 全分辨率录制在部分机型上
 * 会直接 prepare 失败，而且家长端只是要看画面，不需要 4K。
 */
public final class ScreenCapturer {

    /** 录像长边上限（720p 级别），兼顾清晰度、兼容性与上传体积。 */
    private static final int VIDEO_MAX_LONG_EDGE = 1280;
    private static final int VIDEO_FRAME_RATE = 25;
    private static final int VIDEO_BIT_RATE = 4_000_000;
    /** 截图 JPEG 质量。 */
    private static final int JPEG_QUALITY = 85;

    private static final Object LOCK = new Object();

    private static MediaProjection projection;
    private static HandlerThread projectionThread;
    private static Handler projectionHandler;

    private static MediaRecorder recorder;
    private static VirtualDisplay recordingDisplay;
    private static File recordingFile;
    private static String recordingId;
    private static long recordingStartedAt;

    /** 截屏实际走通的路径。 */
    public enum CapturePath {
        /** 无障碍 {@code AccessibilityService.takeScreenshot}：免授权，需要 API 30+ 且服务在跑 */
        ACCESSIBILITY,
        /** MediaProjection：需要孩子在系统弹框上点「立即开始」 */
        MEDIA_PROJECTION
    }

    /**
     * 最近一次截屏实际走通的路径（还没截过时为 {@code null}）。
     *
     * <p>存在的理由是可观测性：周期采样是「每 10 秒一张」的持续行为，日志不能每张都打，
     * 但必须能一眼看出「现在走的是免授权的无障碍路径，还是回退到了要点系统弹框的
     * MediaProjection」—— 这正是本次修复之前最查不清的一件事。
     */
    private static volatile CapturePath lastCapturePath;

    /** 最近一次截屏实际走通的路径；{@code null} 表示本进程还没成功截过屏。 */
    public static CapturePath lastCapturePath() {
        return lastCapturePath;
    }

    private ScreenCapturer() {
    }

    // ============================================================
    // 对外能力
    // ============================================================

    /**
     * 截一张屏，返回原始分辨率的 JPEG 字节（远程截图指令用）。
     *
     * <p><b>优先走免授权的无障碍截图</b>（{@link AccessibilityScreenCapture}，API 30+ 且无障碍
     * 服务在跑时完全不需要用户点任何弹框）；拿不到才回退到需要授权的 MediaProjection。
     */
    public static byte[] captureScreenshot(Context context, long timeoutMs) throws CapabilityException {
        return capture(context, 0, JPEG_QUALITY, timeoutMs, false);
    }

    /**
     * 截一张<b>低分辨率</b>的屏，用于周期采样。
     *
     * <p>MediaProjection 回退路径刻意在 {@code VirtualDisplay} 这一层就按目标尺寸创建，
     * 而不是先拍全分辨率再缩放：1080×2340 的 ARGB_8888 位图约 10 MB，每分钟拍两张的话
     * 内存压力相当可观；直接在 480 像素宽上合成，位图只有约 2 MB，且省掉一次缩放。
     * 无障碍路径由系统直接给全分辨率画面，只能拿到之后再缩放 + 重压（见 {@link #resizeJpeg}）。
     *
     * @param longEdge 目标长边像素（例如 480）
     * @param quality  JPEG 质量（例如 45）
     */
    public static byte[] captureScreenshotLowRes(Context context, int longEdge, int quality, long timeoutMs)
            throws CapabilityException {
        return capture(context, longEdge, quality, timeoutMs, true);
    }

    /**
     * 截屏核心。
     *
     * @param longEdge  目标长边；{@code <= 0} 表示保持屏幕原始分辨率
     * @param quiet     采样用途时不要每张都打日志（否则日志环会被刷屏）
     */
    private static byte[] capture(Context context, int longEdge, int quality, long timeoutMs, boolean quiet)
            throws CapabilityException {
        // 1) 先试免授权的无障碍截图。这条路径不需要任何人点系统弹框，是「截图」能不能
        //    真正用起来的关键；也正因为排在 ensureProjection() 之前，孩子不会被弹框打扰。
        byte[] viaAccessibility = AccessibilityScreenCapture.takeScreenshotBlocking(timeoutMs);
        if (viaAccessibility != null) {
            byte[] jpeg = viaAccessibility;
            if (longEdge > 0) {
                byte[] shrunk = resizeJpeg(viaAccessibility, longEdge, quality);
                // 缩放失败就退回全分辨率原图：宁可存一张大图，也不要让整条链路失败
                if (shrunk != null) jpeg = shrunk;
            }
            lastCapturePath = CapturePath.ACCESSIBILITY;
            if (!quiet) {
                EventLog.success("已通过无障碍接口截屏（免授权），" + (jpeg.length / 1024) + " KB");
            }
            return jpeg;
        }

        // 2) 无障碍不可用（API < 30 / 服务没开 / 抓取失败）→ 回退到需要用户授权的 MediaProjection
        Context app = context.getApplicationContext();
        ensureProjection(app, timeoutMs);

        DisplayMetrics metrics = realMetrics(app);
        int width = metrics.widthPixels;
        int height = metrics.heightPixels;

        if (longEdge > 0) {
            int[] scaled = scaleToLimit(width, height, longEdge);
            width = scaled[0];
            height = scaled[1];
        }

        ImageReader reader = ImageReader.newInstance(width, height, PixelFormat.RGBA_8888, 2);
        VirtualDisplay display = null;
        try {
            display = projection.createVirtualDisplay(
                    "balloon-screenshot",
                    width, height, metrics.densityDpi,
                    DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
                    reader.getSurface(), null, projectionHandler);

            Image image = awaitImage(reader, timeoutMs);
            if (image == null) {
                throw new CapabilityException("截屏超时，没有拿到屏幕画面");
            }

            Bitmap bitmap = null;
            try {
                bitmap = toBitmap(image, width, height);
            } finally {
                image.close();
            }
            if (bitmap == null) {
                throw new CapabilityException("截屏画面解析失败");
            }

            byte[] jpeg;
            try {
                ByteArrayOutputStream out = new ByteArrayOutputStream();
                bitmap.compress(Bitmap.CompressFormat.JPEG, quality, out);
                jpeg = out.toByteArray();
            } finally {
                bitmap.recycle();
            }

            if (jpeg.length == 0) {
                throw new CapabilityException("截屏压缩后为空");
            }
            lastCapturePath = CapturePath.MEDIA_PROJECTION;
            if (!quiet) {
                EventLog.success("已截屏 " + width + "×" + height + "，" + (jpeg.length / 1024) + " KB");
            }
            return jpeg;
        } finally {
            if (display != null) {
                try {
                    display.release();
                } catch (Exception ignored) {
                    // 释放失败无影响
                }
            }
            try {
                reader.close();
            } catch (Exception ignored) {
                // 同上
            }
            // 单次截图用完就收起前台服务，避免常驻通知。
            // 采样（quiet=true）时不收 —— 它每几十秒就要再拍一张，
            // 反复起停前台服务既费电又会让通知闪来闪去。
            if (!quiet && !isRecording()) {
                releaseProjection();
                ScreenCaptureService.stopIfIdle(app);
            }
        }
    }

    /** 开始录屏，返回 recordingId（需要回报给服务端）。 */
    public static String startVideo(Context context, long timeoutMs) throws CapabilityException {
        synchronized (LOCK) {
            if (recorder != null) {
                throw new CapabilityException("设备上已有正在进行的录像（" + recordingId + "）");
            }
            Context app = context.getApplicationContext();
            ensureProjection(app, timeoutMs);

            DisplayMetrics metrics = realMetrics(app);
            int[] size = scaleToLimit(metrics.widthPixels, metrics.heightPixels, VIDEO_MAX_LONG_EDGE);
            int width = size[0];
            int height = size[1];

            File file = AudioRecorder.newFile(app, "video", ".mp4");
            MediaRecorder newRecorder = newRecorder(app);
            VirtualDisplay display = null;
            try {
                newRecorder.setVideoSource(MediaRecorder.VideoSource.SURFACE);
                newRecorder.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4);
                newRecorder.setVideoEncoder(MediaRecorder.VideoEncoder.H264);
                newRecorder.setVideoSize(width, height);
                newRecorder.setVideoFrameRate(VIDEO_FRAME_RATE);
                newRecorder.setVideoEncodingBitRate(VIDEO_BIT_RATE);
                newRecorder.setOutputFile(file.getAbsolutePath());
                newRecorder.prepare();

                // 顺序很关键：prepare() → getSurface() → createVirtualDisplay() → start()
                display = projection.createVirtualDisplay(
                        "balloon-recording",
                        width, height, metrics.densityDpi,
                        DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
                        newRecorder.getSurface(), null, projectionHandler);

                newRecorder.start();
            } catch (Exception e) {
                if (display != null) {
                    try {
                        display.release();
                    } catch (Exception ignored) {
                        // 清理失败无影响
                    }
                }
                releaseRecorder(newRecorder);
                //noinspection ResultOfMethodCallIgnored
                file.delete();
                throw new CapabilityException("启动录屏失败：" + e.getMessage(), e);
            }

            recorder = newRecorder;
            recordingDisplay = display;
            recordingFile = file;
            recordingId = "video-" + UUID.randomUUID().toString().substring(0, 8);
            recordingStartedAt = SystemClock.elapsedRealtime();
            EventLog.success("已开始录屏 " + width + "×" + height + "，recordingId=" + recordingId);
            return recordingId;
        }
    }

    public static boolean isRecording() {
        synchronized (LOCK) {
            return recorder != null;
        }
    }

    @Nullable
    public static String currentRecordingId() {
        synchronized (LOCK) {
            return recordingId;
        }
    }

    /** 录像结果。 */
    public static final class VideoClip {
        public final byte[] bytes;
        public final long durationMillis;
        public final String recordingId;

        VideoClip(byte[] bytes, long durationMillis, String recordingId) {
            this.bytes = bytes;
            this.durationMillis = durationMillis;
            this.recordingId = recordingId;
        }
    }

    /** 停止录屏并读出 MP4 字节。 */
    public static VideoClip stopVideo(Context context) throws CapabilityException {
        MediaRecorder current;
        VirtualDisplay display;
        File file;
        String id;
        long duration;

        synchronized (LOCK) {
            if (recorder == null) {
                throw new CapabilityException("设备上没有正在进行的录像");
            }
            current = recorder;
            display = recordingDisplay;
            file = recordingFile;
            id = recordingId;
            duration = SystemClock.elapsedRealtime() - recordingStartedAt;

            recorder = null;
            recordingDisplay = null;
            recordingFile = null;
            recordingId = null;
        }

        try {
            current.stop();
        } catch (RuntimeException e) {
            EventLog.warn("停止录屏时系统报错（录制时间可能过短）：" + e.getMessage());
        } finally {
            releaseRecorder(current);
            if (display != null) {
                try {
                    display.release();
                } catch (Exception ignored) {
                    // 释放失败无影响
                }
            }
        }

        Context app = context.getApplicationContext();
        // 录像结束，投影没有别的用途了，一起收掉
        releaseProjection();
        ScreenCaptureService.stopIfIdle(app);

        if (file == null || !file.exists() || file.length() == 0) {
            if (file != null) {
                //noinspection ResultOfMethodCallIgnored
                file.delete();
            }
            throw new CapabilityException("录像文件为空，录制时间可能过短");
        }

        try {
            byte[] bytes = AudioRecorder.readAll(file);
            //noinspection ResultOfMethodCallIgnored
            file.delete();
            EventLog.success("录屏结束，时长 " + (duration / 1000) + " 秒，" + (bytes.length / 1024) + " KB");
            return new VideoClip(bytes, duration, id);
        } catch (Exception e) {
            throw new CapabilityException("读取录像文件失败：" + e.getMessage(), e);
        }
    }

    /** 进程退出 / 停机时清理一切采集资源。 */
    public static void shutdown() {
        synchronized (LOCK) {
            if (recorder != null) {
                try {
                    recorder.stop();
                } catch (RuntimeException ignored) {
                    // 已经处于错误状态
                }
                releaseRecorder(recorder);
                recorder = null;
                if (recordingFile != null) {
                    //noinspection ResultOfMethodCallIgnored
                    recordingFile.delete();
                }
                recordingFile = null;
                recordingId = null;
            }
            if (recordingDisplay != null) {
                try {
                    recordingDisplay.release();
                } catch (Exception ignored) {
                    // 忽略
                }
                recordingDisplay = null;
            }
        }
        releaseProjection();
    }

    /** 当前是否有可用的投影授权（用于界面提示「需要重新授权」）。 */
    public static boolean hasProjection() {
        synchronized (LOCK) {
            return projection != null;
        }
    }

    // ============================================================
    // 内部：投影生命周期
    // ============================================================

    private static void ensureProjection(Context context, long timeoutMs) throws CapabilityException {
        synchronized (LOCK) {
            if (projection != null) return;

            // 1) 先把 mediaProjection 类型的前台服务拉起来（Android 14 的硬性顺序要求）
            if (!ScreenCaptureService.ensureRunning(context)) {
                throw new CapabilityException("无法启动屏幕采集前台服务，请检查通知权限是否已授予");
            }

            // 2) 再向用户要一次授权（系统授权框只能由 Activity 弹出）
            //
            //    在等之前先把这个 AppOps 的状态打进日志：失败时它能直接区分
            //    「没人点授权框」和「系统把这个 op 记成了已忽略」。注意 ignore 只表示
            //    「上一次授权被划掉/超时」，实测授权框仍会出现、点了仍能成功（见
            //    explainProjectionFailure 的注释），所以这里只记录状态、不做任何拦截。
            EventLog.info("屏幕共享授权状态：AppOps android:project_media="
                    + projectMediaAppOpState(context));
            long consentTimeout = Math.max(15_000L, Math.min(timeoutMs, 45_000L));
            try {
                ProjectionConsentActivity.await(context, consentTimeout);
            } catch (CapabilityException e) {
                // 把「超时 / 被拒」翻译成家长能照着做的报错，见 explainProjectionFailure
                throw explainProjectionFailure(context, e);
            }

            MediaProjectionManager manager =
                    (MediaProjectionManager) context.getSystemService(Context.MEDIA_PROJECTION_SERVICE);
            if (manager == null) {
                throw new CapabilityException("系统不支持屏幕采集（缺少 MediaProjection 服务）");
            }

            if (projectionThread == null) {
                projectionThread = new HandlerThread("balloon-projection");
                projectionThread.start();
                projectionHandler = new Handler(projectionThread.getLooper());
            }

            // 3) 一份授权换一个 MediaProjection 实例，之后一直复用它
            try {
                projection = manager.getMediaProjection(
                        ProjectionConsentActivity.resultCode(),
                        ProjectionConsentActivity.resultData());
            } catch (Exception e) {
                throw new CapabilityException("创建屏幕投影失败：" + e.getMessage(), e);
            }
            if (projection == null) {
                throw new CapabilityException("创建屏幕投影失败（授权可能已失效，请重试）");
            }

            projection.registerCallback(new MediaProjection.Callback() {
                @Override
                public void onStop() {
                    // 系统回收（用户点了停止投屏 / 令牌过期）：清掉缓存，下次重新授权
                    EventLog.warn("屏幕共享授权已被系统回收，下次采集会重新请求授权");
                    releaseProjection();
                }
            }, projectionHandler);
        }
    }

    private static void releaseProjection() {
        synchronized (LOCK) {
            if (projection != null) {
                try {
                    projection.stop();
                } catch (Exception ignored) {
                    // 已经停止时会抛，忽略
                }
                projection = null;
            }
        }
    }

    private static void releaseRecorder(MediaRecorder target) {
        try {
            target.reset();
            target.release();
        } catch (Exception ignored) {
            // 忽略
        }
    }

    /**
     * 「屏幕共享」这个 AppOps 的名字。
     *
     * <p>写法是字面量而不是 {@code AppOpsManager.OPSTR_PROJECT_MEDIA}：后者虽然存在于 AOSP，
     * 但在 compileSdk 33 的公开 stub 里没有导出（实测编译报「找不到符号」）。
     * 这个字符串是平台稳定标识，`adb shell appops get <pkg> PROJECT_MEDIA` 打印的就是它。
     */
    private static final String OP_PROJECT_MEDIA = "android:project_media";

    /**
     * 「屏幕共享」这个 AppOps（{@code android:project_media}）的当前状态。
     *
     * <p>它才是屏幕共享能不能用的真正开关：{@code allow} 时系统直接放行（连授权框都不弹），
     * {@code ignore} / {@code deny} 时**连授权框都不会再出现**，家长点多少次截图都只会得到
     * 一句「等待授权超时」。所以失败时必须把它的值报出来，否则家长和排查的人都不知道差在哪。
     *
     * @return {@code "allow"} / {@code "ignore"} / {@code "deny"} / {@code "default"}；
     *         系统太老（API < 29）或读取失败时返回 {@code "unknown"}（不抛异常）
     */
    private static String projectMediaAppOpState(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return "unknown";
        try {
            AppOpsManager appOps =
                    (AppOpsManager) context.getSystemService(Context.APP_OPS_SERVICE);
            if (appOps == null) return "unknown";
            int mode = appOps.checkOpNoThrow(
                    OP_PROJECT_MEDIA,
                    context.getApplicationInfo().uid,
                    context.getPackageName());
            switch (mode) {
                case AppOpsManager.MODE_ALLOWED:
                    return "allow";
                case AppOpsManager.MODE_IGNORED:
                    return "ignore";
                case AppOpsManager.MODE_ERRORED:
                    return "deny";
                case AppOpsManager.MODE_DEFAULT:
                    return "default";
                default:
                    return "mode=" + mode;
            }
        } catch (Exception e) {
            // 少数 ROM 会在这里抛 SecurityException；报状态失败不应该让截图本身失败
            return "unknown";
        }
    }

    /**
     * 在「授权超时 / 被拒」的原因前面补上 {@code android:project_media} 的状态。
     *
     * <p>为什么值得单列：这句报错家长会看到，而「没人点授权框」和「系统把这个 op 记成了
     * 已忽略」在表面上完全一样（都是 20 秒超时），只有 AppOps 状态能把两者分开。
     *
     * <p>实测边界（写下来免得后人误判）：在 Android 13 模拟器上，即使把 op 设成
     * {@code ignore}，系统授权框**仍然会出现**，点「立即开始」后截图也能成功
     * （logcat 有 `Displayed com.android.systemui/.media.MediaProjectionPermissionActivity: +699ms`，
     * 点掉后紧跟着 `已截屏 1080×2340`）。所以 {@code ignore} 只是「上一次授权被划掉/超时」
     * 留下的记录，<b>不是永久封禁</b>。因此这里只如实报告状态 + 给出两条出路，
     * 不写「以后不会再弹框」这种没有验证过的断言。
     */
    private static CapabilityException explainProjectionFailure(
            Context context, CapabilityException cause) {
        // 「设备被锁，压根没申请授权」与 AppOps 无关，必须原样抛出，否则会把
        // 「孩子在锁屏」误报成「屏幕共享被系统禁止」，把排查带偏（实测踩过）。
        if (cause instanceof ProjectionConsentActivity.LockedException) {
            return cause;
        }
        String state = projectMediaAppOpState(context);
        if (!"ignore".equals(state) && !"deny".equals(state)) {
            return cause;
        }
        String message = "屏幕共享授权没拿到（AppOps android:project_media=" + state
                + "，通常是上一次授权框被划掉或超时留下的记录）。请在设备上点系统授权框的"
                + "「立即开始」，或让家长在系统设置里重新授权屏幕共享；也可以用 adb 放行："
                + "adb shell appops set " + context.getPackageName() + " PROJECT_MEDIA allow。"
                + "原始原因：" + cause.getMessage();
        EventLog.error(message);
        return new CapabilityException(message, cause);
    }

    // ============================================================
    // 内部：图像与尺寸
    // ============================================================

    /** 轮询等待第一帧；MediaProjection 建立后通常 100~300ms 内就有画面。 */
    @Nullable
    private static Image awaitImage(ImageReader reader, long timeoutMs) {
        // 单调时钟：墙钟在这里没有意义，而设备改时间会把 System.currentTimeMillis()
        // 往后拽 —— 那会让这个循环一直等下去（截屏卡死，家长端只看到「没反应」）。
        long deadline = SystemClock.elapsedRealtime() + timeoutMs;
        while (SystemClock.elapsedRealtime() < deadline) {
            Image image = reader.acquireLatestImage();
            if (image != null) return image;
            try {
                Thread.sleep(80L);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                return null;
            }
        }
        return null;
    }

    /**
     * ImageReader 的 RGBA_8888 每行可能有 padding（rowStride &gt; width * 4），
     * 直接按 width 建 Bitmap 会导致画面斜切，必须按 rowStride 建图后再裁掉多余列。
     */
    @Nullable
    private static Bitmap toBitmap(Image image, int width, int height) {
        Image.Plane plane = image.getPlanes()[0];
        ByteBuffer buffer = plane.getBuffer();
        int pixelStride = plane.getPixelStride();
        int rowStride = plane.getRowStride();
        int rowPadding = rowStride - pixelStride * width;

        int paddedWidth = width + rowPadding / pixelStride;
        Bitmap padded = Bitmap.createBitmap(paddedWidth, height, Bitmap.Config.ARGB_8888);
        buffer.rewind();
        padded.copyPixelsFromBuffer(buffer);

        if (paddedWidth == width) return padded;
        Bitmap cropped = Bitmap.createBitmap(padded, 0, 0, width, height);
        if (cropped != padded) padded.recycle();
        return cropped;
    }

    /**
     * 把一张完整 JPEG 缩到长边不超过 {@code longEdge}，并以 {@code quality} 重新压缩。
     *
     * <p>只有无障碍截图路径需要它：系统直接给的是全分辨率画面，而周期采样只要 480px 宽的
     * 小图。先用 {@code inJustDecodeBounds} 读尺寸、再按 2 的幂次降采样解码，
     * 避免把 1080×2340 的 ARGB_8888（约 10 MB）整张读进内存。
     *
     * @return 缩放后的 JPEG；参数异常或解码失败时返回 {@code null}（调用方退回原图）
     */
    @Nullable
    private static byte[] resizeJpeg(byte[] jpeg, int longEdge, int quality) {
        if (longEdge <= 0 || jpeg == null || jpeg.length == 0) return null;

        BitmapFactory.Options options = new BitmapFactory.Options();
        options.inJustDecodeBounds = true;
        BitmapFactory.decodeByteArray(jpeg, 0, jpeg.length, options);
        int width = options.outWidth;
        int height = options.outHeight;
        if (width <= 0 || height <= 0) return null;

        int sample = 1;
        int longSide = Math.max(width, height);
        while (longSide / (sample * 2) >= longEdge) {
            sample *= 2;
        }
        options.inJustDecodeBounds = false;
        options.inSampleSize = sample;

        Bitmap decoded = BitmapFactory.decodeByteArray(jpeg, 0, jpeg.length, options);
        if (decoded == null) return null;
        Bitmap target = decoded;
        try {
            int decodedLong = Math.max(decoded.getWidth(), decoded.getHeight());
            if (decodedLong > longEdge) {
                double ratio = (double) longEdge / decodedLong;
                int targetWidth = Math.max(1, (int) Math.round(decoded.getWidth() * ratio));
                int targetHeight = Math.max(1, (int) Math.round(decoded.getHeight() * ratio));
                target = Bitmap.createScaledBitmap(decoded, targetWidth, targetHeight, true);
            }
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            target.compress(Bitmap.CompressFormat.JPEG, quality, out);
            byte[] result = out.toByteArray();
            return result.length == 0 ? null : result;
        } catch (Exception e) {
            EventLog.warn("缩放无障碍截图失败，改用原图：" + e.getMessage());
            return null;
        } finally {
            if (target != decoded) target.recycle();
            decoded.recycle();
        }
    }

    /** 等比缩放到长边不超过 limit，并保证宽高都是偶数（H.264 要求）。 */
    private static int[] scaleToLimit(int width, int height, int limit) {
        int longEdge = Math.max(width, height);
        if (longEdge <= limit) {
            return new int[]{makeEven(width), makeEven(height)};
        }
        double ratio = (double) limit / longEdge;
        return new int[]{makeEven((int) (width * ratio)), makeEven((int) (height * ratio))};
    }

    private static int makeEven(int value) {
        int even = value % 2 == 0 ? value : value - 1;
        return Math.max(2, even);
    }

    @SuppressWarnings("deprecation")
    private static DisplayMetrics realMetrics(Context context) {
        DisplayMetrics metrics = new DisplayMetrics();
        WindowManager manager = (WindowManager) context.getSystemService(Context.WINDOW_SERVICE);
        if (manager != null && manager.getDefaultDisplay() != null) {
            manager.getDefaultDisplay().getRealMetrics(metrics);
        }
        if (metrics.widthPixels <= 0 || metrics.heightPixels <= 0) {
            metrics = context.getResources().getDisplayMetrics();
        }
        return metrics;
    }

    @SuppressWarnings("deprecation")
    private static MediaRecorder newRecorder(Context context) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            return new MediaRecorder(context);
        }
        return new MediaRecorder();
    }
}
