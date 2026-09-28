package com.balloondog.agent.capability;

import android.content.Context;
import android.graphics.Bitmap;
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

    private ScreenCapturer() {
    }

    // ============================================================
    // 对外能力
    // ============================================================

    /** 截一张屏，返回 JPEG 字节。 */
    public static byte[] captureScreenshot(Context context, long timeoutMs) throws CapabilityException {
        Context app = context.getApplicationContext();
        ensureProjection(app, timeoutMs);

        DisplayMetrics metrics = realMetrics(app);
        int width = metrics.widthPixels;
        int height = metrics.heightPixels;

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
                bitmap.compress(Bitmap.CompressFormat.JPEG, JPEG_QUALITY, out);
                jpeg = out.toByteArray();
            } finally {
                bitmap.recycle();
            }

            if (jpeg.length == 0) {
                throw new CapabilityException("截屏压缩后为空");
            }
            EventLog.success("已截屏 " + width + "×" + height + "，" + (jpeg.length / 1024) + " KB");
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
            // 单次截图用完就收起前台服务，避免常驻通知
            if (!isRecording()) {
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
            long consentTimeout = Math.max(15_000L, Math.min(timeoutMs, 45_000L));
            ProjectionConsentActivity.await(context, consentTimeout);

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

    // ============================================================
    // 内部：图像与尺寸
    // ============================================================

    /** 轮询等待第一帧；MediaProjection 建立后通常 100~300ms 内就有画面。 */
    @Nullable
    private static Image awaitImage(ImageReader reader, long timeoutMs) {
        long deadline = System.currentTimeMillis() + timeoutMs;
        while (System.currentTimeMillis() < deadline) {
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
