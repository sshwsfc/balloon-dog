package com.balloondog.agent.capability;

import android.content.Context;

import com.balloondog.agent.data.AgentStore;
import com.balloondog.agent.data.Constants;
import com.balloondog.agent.data.EventLog;
import com.balloondog.agent.net.AgentApi;
import com.balloondog.agent.service.AgentNotifications;

/**
 * 环境监听：按固定时长分段录音并逐段上传（契约 §6）。
 *
 * <p>与 {@code start_audio / stop_audio} 的区别：那条是「家长手动录一段」，
 * 这条是「家长开一段时间」。所以这里循环 {@link AudioRecorder}：
 * 录满一段（默认 {@link Constants#AMBIENT_CHUNK_MS}，5 分钟）就停、上传、再录下一段，
 * 直到收到 {@code stop_ambient} 或达到安全阀 {@link Constants#AMBIENT_MAX_TOTAL_MS}。
 *
 * <p>三条刻意为之的约束：
 * <ul>
 *   <li><b>绝不隐蔽</b>：全程挂一条「家长开启了环境监听」的常驻通知
 *       （见 {@link AgentNotifications#notifyAmbient}）。</li>
 *   <li><b>进程被杀后不自动恢复</b>：状态只在内存里，没有持久化「应该在录音」这个事实。
 *       自动续录会在孩子不知情的时候把麦克风一直打开，风险远大于收益。</li>
 *   <li><b>有安全阀</b>：即使没收到停止指令（指令丢了 / 服务端挂了），
 *       录满 {@link Constants#AMBIENT_MAX_TOTAL_MS} 也会自己停下并记日志。</li>
 * </ul>
 */
public final class AmbientRecorder {

    private static final Object LOCK = new Object();
    private static volatile boolean running = false;
    private static Thread worker;

    private AmbientRecorder() {
    }

    public static boolean isRunning() {
        return running;
    }

    /**
     * 开始环境监听。
     *
     * @return 给家长端看的说明（每段多长）
     * @throws CapabilityException 已有监听在跑，或麦克风权限缺失（由 {@link AudioRecorder#start} 抛出）
     */
    public static String start(Context context, AgentStore store, AgentApi api, int chunkSeconds)
            throws CapabilityException {
        final Context appContext = context.getApplicationContext();
        final int chunk = chunkSeconds > 0 ? chunkSeconds : (int) (Constants.AMBIENT_CHUNK_MS / 1000L);
        synchronized (LOCK) {
            if (running) {
                throw new CapabilityException("环境监听已在运行");
            }
            if (AudioRecorder.isRecording()) {
                // 同一部手机只有一路麦克风：正在手动录音时先拒绝，避免把那段录音搞坏
                throw new CapabilityException("设备上正在录音（manual），请先停止后开启环境监听");
            }
            // 先试起第一段：权限缺失 / 麦克风被占用要在「指令回报」里就说清楚，
            // 不能先返回成功再在后台线程里悄悄失败。
            AudioRecorder.start(appContext);

            running = true;
            worker = new Thread(() -> loop(appContext, store, api, chunk), "ambient-recorder");
            worker.setDaemon(true);
            worker.start();
        }
        EventLog.success("环境监听已开始：每 " + chunk + " 秒一段，最长 "
                + (Constants.AMBIENT_MAX_TOTAL_MS / 60_000L) + " 分钟");
        AgentNotifications.notifyAmbient(appContext, "正在录音，每 " + chunk + " 秒上传一段");
        return "每 " + chunk + " 秒一段";
    }

    /** 停止环境监听。已在录制的这一段会被正常收尾并上传，不做丢弃。 */
    public static void stop(String reason) {
        synchronized (LOCK) {
            if (!running) return;
            running = false;
        }
        Thread current = worker;
        if (current != null && current != Thread.currentThread()) {
            // 等它把当前这段录完并上传，最多等 30 秒（超出就让它在后台自己收尾）
            try {
                current.join(30_000L);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
        }
        EventLog.warn("环境监听已停止：" + reason);
    }

    // ---------------- 内部 ----------------

    private static void loop(Context context, AgentStore store, AgentApi api, int chunkSeconds) {
        long startedAt = System.currentTimeMillis();
        boolean firstChunk = true;
        int index = 0;
        try {
            while (running) {
                if (!firstChunk) {
                    // 第一段已经在 start() 里起好了，这里只负责后续段
                    if (!running) break;
                    try {
                        AudioRecorder.start(context);
                    } catch (CapabilityException e) {
                        EventLog.error("环境监听无法继续录音：" + e.getMessage());
                        break;
                    }
                }
                firstChunk = false;

                if (!sleepWhileRunning(chunkSeconds * 1000L)) {
                    // 收到停止：这一段照样收尾上传，不丢数据
                }

                AudioRecorder.AudioClip clip;
                try {
                    clip = AudioRecorder.stop(context);
                } catch (CapabilityException e) {
                    EventLog.warn("环境监听这一段录制失败：" + e.getMessage());
                    continue;
                }

                index++;
                upload(context, store, api, clip, index);

                long elapsed = System.currentTimeMillis() - startedAt;
                if (elapsed >= Constants.AMBIENT_MAX_TOTAL_MS) {
                    EventLog.warn("环境监听达到安全阀时长（"
                            + (Constants.AMBIENT_MAX_TOTAL_MS / 60_000L)
                            + " 分钟），已自动停止；如需继续请家长重新开启");
                    break;
                }
                if (running) {
                    AgentNotifications.notifyAmbient(context,
                            "已上传 " + index + " 段，正在继续录音");
                }
            }
        } finally {
            running = false;
            AudioRecorder.discard();
            AgentNotifications.clearAmbient(context);
        }
    }

    /** @return true 表示睡满；false 表示中途被要求停止 */
    private static boolean sleepWhileRunning(long totalMillis) {
        long remaining = totalMillis;
        while (remaining > 0) {
            if (!running) return false;
            long slice = Math.min(1000L, remaining);
            try {
                Thread.sleep(slice);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                return false;
            }
            remaining -= slice;
        }
        return running;
    }

    private static void upload(Context context, AgentStore store, AgentApi api,
                               AudioRecorder.AudioClip clip, int index) {
        String filename = "ambient-" + System.currentTimeMillis() + ".m4a";
        try {
            api.uploadMedia(store.getBaseUrl(), clip.bytes, filename, "audio/mp4", "audio", null);
            EventLog.success("环境监听第 " + index + " 段已上传（"
                    + (clip.bytes.length / 1024) + " KB，" + (clip.durationMillis / 1000) + " 秒）");
        } catch (Exception e) {
            // 上传失败就丢掉这一段并如实记日志：缓存整段音频到磁盘等重传，
            // 会把孩子的隐私数据留在设备上，风险更大。
            EventLog.error("环境监听第 " + index + " 段上传失败（已丢弃）：" + e.getMessage());
        }
    }
}
