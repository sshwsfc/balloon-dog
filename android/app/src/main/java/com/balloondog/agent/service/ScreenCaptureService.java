package com.balloondog.agent.service;

import android.app.Notification;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.IBinder;

import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;
import androidx.core.content.ContextCompat;

import com.balloondog.agent.R;
import com.balloondog.agent.data.Constants;
import com.balloondog.agent.data.EventLog;
import com.balloondog.agent.ui.MainActivity;

import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * 屏幕采集的「前台服务外壳」。
 *
 * <p>它本身不做任何采集，存在的唯一理由是满足 Android 14（API 34）的硬性要求：
 * <blockquote>
 * 应用必须先在 <b>mediaProjection</b> 类型的前台服务里调用 {@code startForeground()}，
 * 然后才能调用 {@code MediaProjectionManager.getMediaProjection()}。
 * </blockquote>
 * 顺序反了会直接抛 {@code SecurityException}。所以 {@link ScreenCapturer} 在使用
 * MediaProjection 之前，一定会先通过 {@link #ensureRunning(Context)} 把这个服务拉起来并
 * 等到 {@code startForeground()} 真正执行完毕。
 *
 * <p>采集结束后由 {@link ScreenCapturer} 调用 {@link #stopIfIdle(Context)} 关掉，
 * 不留常驻通知。
 */
public class ScreenCaptureService extends Service {

    private static final AtomicBoolean FOREGROUND_STARTED = new AtomicBoolean(false);
    private static volatile CountDownLatch readyLatch = new CountDownLatch(1);

    /** 拉起服务并等待它进入前台；返回 false 表示超时（系统限制或权限缺失）。 */
    public static boolean ensureRunning(Context context) {
        if (FOREGROUND_STARTED.get()) return true;

        readyLatch = new CountDownLatch(1);
        Intent intent = new Intent(context, ScreenCaptureService.class);
        try {
            ContextCompat.startForegroundService(context, intent);
        } catch (Exception e) {
            EventLog.error("启动屏幕采集服务失败：" + e.getMessage());
            return false;
        }
        try {
            return readyLatch.await(5, TimeUnit.SECONDS) && FOREGROUND_STARTED.get();
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return false;
        }
    }

    /** 采集结束、没有正在进行的录像时关掉服务。 */
    public static void stopIfIdle(Context context) {
        if (!FOREGROUND_STARTED.get()) return;
        context.stopService(new Intent(context, ScreenCaptureService.class));
    }

    public static boolean isRunning() {
        return FOREGROUND_STARTED.get();
    }

    @Override
    public void onCreate() {
        super.onCreate();
        AgentNotifications.ensureChannels(this);

        Notification notification = new NotificationCompat.Builder(this, Constants.CHANNEL_AGENT)
                .setContentTitle(getString(R.string.app_name))
                .setContentText("正在采集屏幕内容")
                .setSmallIcon(R.drawable.ic_stat_agent)
                .setOngoing(true)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .setContentIntent(MainActivity.createPendingIntent(this))
                .build();

        try {
            ForegroundCompat.start(this, Constants.NOTIFICATION_ID_SCREEN, notification,
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION);
            FOREGROUND_STARTED.set(true);
        } catch (Exception e) {
            // 缺少 FOREGROUND_SERVICE_MEDIA_PROJECTION 权限或系统策略禁止时走到这里
            FOREGROUND_STARTED.set(false);
            EventLog.error("进入屏幕采集前台服务失败：" + e.getMessage());
        } finally {
            readyLatch.countDown();
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        // 不粘性重启：采集是一次性动作，进程被杀后不应该自动重来（否则会反复弹授权）
        return START_NOT_STICKY;
    }

    @Override
    public void onDestroy() {
        FOREGROUND_STARTED.set(false);
        // 系统允许直接停止前台服务；显式再调一次以清理通知
        ForegroundCompat.stop(this);
        super.onDestroy();
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        // 同进程内直接调用静态方法即可，不需要 Binder
        return null;
    }
}
