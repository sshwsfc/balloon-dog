package com.balloondog.agent.capability;

import android.Manifest;
import android.content.Context;
import android.content.pm.PackageManager;
import android.media.MediaRecorder;
import android.os.Build;
import android.os.SystemClock;

import androidx.core.content.ContextCompat;

import com.balloondog.agent.data.EventLog;

import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.UUID;

/**
 * 环境录音：{@code MediaRecorder} + 麦克风，输出 MPEG-4 容器里的 AAC。
 *
 * <p>为什么是 {@code .m4a / audio/mp4}：服务端 {@code media.storage.ts} 的白名单里
 * {@code audio/mp4 → .m4a}，而 Android 的 {@code MediaRecorder} 在任意版本上都能稳定产出它。
 *
 * <p>录音是「开始 / 停止」两段式：{@code start_audio} 指令只负责起录并回报
 * {@code recordingId}，真正的字节流在 {@code stop_audio} 时才上传 ——
 * 所以录音状态必须活在静态字段里（同一个进程内只有一路录音）。
 */
public final class AudioRecorder {

    private static MediaRecorder recorder;
    private static File outputFile;
    private static String recordingId;
    private static long startedAt;

    private AudioRecorder() {
    }

    public static synchronized boolean isRecording() {
        return recorder != null;
    }

    public static synchronized String currentRecordingId() {
        return recordingId;
    }

    /**
     * 开始录音。
     *
     * @return 本次录制的 recordingId，需要回报给服务端（家长端停止录音时原样带回来）
     */
    public static synchronized String start(Context context) throws CapabilityException {
        if (recorder != null) {
            throw new CapabilityException("设备上已有正在进行的录音（" + recordingId + "）");
        }
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO)
                != PackageManager.PERMISSION_GRANTED) {
            throw new CapabilityException("麦克风权限未授予，请在气球狗引导页里允许录音权限");
        }

        File file = newFile(context, "audio", ".m4a");
        MediaRecorder newRecorder = newRecorder(context);
        try {
            newRecorder.setAudioSource(MediaRecorder.AudioSource.MIC);
            newRecorder.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4);
            newRecorder.setAudioEncoder(MediaRecorder.AudioEncoder.AAC);
            newRecorder.setAudioSamplingRate(44_100);
            newRecorder.setAudioEncodingBitRate(96_000);
            newRecorder.setOutputFile(file.getAbsolutePath());
            newRecorder.prepare();
            newRecorder.start();
        } catch (IOException | RuntimeException e) {
            safeRelease(newRecorder);
            //noinspection ResultOfMethodCallIgnored
            file.delete();
            throw new CapabilityException("启动录音失败：" + e.getMessage(), e);
        }

        recorder = newRecorder;
        outputFile = file;
        recordingId = "audio-" + UUID.randomUUID().toString().substring(0, 8);
        startedAt = SystemClock.elapsedRealtime();
        EventLog.success("已开始录音，recordingId=" + recordingId);
        return recordingId;
    }

    /** 录音结果：字节流 + 时长。 */
    public static final class AudioClip {
        public final byte[] bytes;
        public final long durationMillis;
        public final String recordingId;

        AudioClip(byte[] bytes, long durationMillis, String recordingId) {
            this.bytes = bytes;
            this.durationMillis = durationMillis;
            this.recordingId = recordingId;
        }
    }

    /** 停止录音并读出字节。 */
    public static synchronized AudioClip stop(Context context) throws CapabilityException {
        if (recorder == null) {
            throw new CapabilityException("设备上没有正在进行的录音");
        }
        MediaRecorder current = recorder;
        File file = outputFile;
        String id = recordingId;
        long duration = SystemClock.elapsedRealtime() - startedAt;

        recorder = null;
        outputFile = null;
        recordingId = null;

        try {
            current.stop();
        } catch (RuntimeException e) {
            // 录制时间过短时 MediaRecorder.stop() 会抛，属常见情况，文件仍可能是有效的
            EventLog.warn("停止录音时系统报错（可能是录制时间过短）：" + e.getMessage());
        } finally {
            safeRelease(current);
        }

        if (file == null || !file.exists() || file.length() == 0) {
            if (file != null) {
                //noinspection ResultOfMethodCallIgnored
                file.delete();
            }
            throw new CapabilityException("录音文件为空，录制时间可能过短");
        }

        try {
            byte[] bytes = readAll(file);
            //noinspection ResultOfMethodCallIgnored
            file.delete();
            EventLog.success("录音结束，时长 " + (duration / 1000) + " 秒，" + (bytes.length / 1024) + " KB");
            return new AudioClip(bytes, duration, id);
        } catch (IOException e) {
            throw new CapabilityException("读取录音文件失败：" + e.getMessage(), e);
        }
    }

    /** 异常退出时丢弃当前录音。 */
    public static synchronized void discard() {
        if (recorder == null) return;
        try {
            recorder.stop();
        } catch (RuntimeException ignored) {
            // 已经在错误状态，忽略
        }
        safeRelease(recorder);
        if (outputFile != null) {
            //noinspection ResultOfMethodCallIgnored
            outputFile.delete();
        }
        recorder = null;
        outputFile = null;
        recordingId = null;
    }

    // ---------------- 内部 ----------------

    @SuppressWarnings("deprecation")
    private static MediaRecorder newRecorder(Context context) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            return new MediaRecorder(context);
        }
        return new MediaRecorder();
    }

    private static void safeRelease(MediaRecorder target) {
        try {
            target.reset();
            target.release();
        } catch (Exception ignored) {
            // 释放失败无需处理
        }
    }

    static File newFile(Context context, String category, String suffix) throws CapabilityException {
        File dir = new File(context.getCacheDir(), "capture");
        if (!dir.exists() && !dir.mkdirs()) {
            throw new CapabilityException("无法创建临时目录：" + dir.getAbsolutePath());
        }
        return new File(dir, category + "-" + System.currentTimeMillis() + suffix);
    }

    static byte[] readAll(File file) throws IOException {
        try (InputStream in = new FileInputStream(file)) {
            byte[] buffer = new byte[(int) file.length()];
            int offset = 0;
            int read;
            while (offset < buffer.length && (read = in.read(buffer, offset, buffer.length - offset)) > 0) {
                offset += read;
            }
            if (offset != buffer.length) {
                byte[] trimmed = new byte[offset];
                System.arraycopy(buffer, 0, trimmed, 0, offset);
                return trimmed;
            }
            return buffer;
        }
    }
}
