package com.balloondog.agent.service;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.os.Build;

import androidx.core.app.NotificationCompat;

import com.balloondog.agent.R;
import com.balloondog.agent.data.Constants;
import com.balloondog.agent.ui.MainActivity;

/**
 * 通知渠道与常驻通知的集中构造。
 *
 * <p>Android 8.0+ 必须先建渠道再发通知；Android 13+ 还需要用户授予
 * {@code POST_NOTIFICATIONS} 运行时权限，否则通知会被静默丢弃 ——
 * 而前台服务在没有通知的情况下会被系统在几十秒内杀掉，表现就是「Agent 老是掉线」。
 * 所以引导页把「通知权限」列为必选项。
 */
public final class AgentNotifications {

    private AgentNotifications() {
    }

    public static void ensureChannels(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager =
                (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null) return;

        NotificationChannel agent = new NotificationChannel(
                Constants.CHANNEL_AGENT,
                context.getString(R.string.channel_agent),
                NotificationManager.IMPORTANCE_LOW);
        agent.setDescription(context.getString(R.string.channel_agent_desc));
        agent.setShowBadge(false);
        manager.createNotificationChannel(agent);

        NotificationChannel events = new NotificationChannel(
                Constants.CHANNEL_EVENTS,
                context.getString(R.string.channel_events),
                NotificationManager.IMPORTANCE_DEFAULT);
        events.setDescription(context.getString(R.string.channel_events_desc));
        manager.createNotificationChannel(events);
    }

    /** Agent 常驻通知：一眼能看到绑定状态与最近动作。 */
    public static Notification buildAgentNotification(Context context, String title, String content) {
        ensureChannels(context);
        return new NotificationCompat.Builder(context, Constants.CHANNEL_AGENT)
                .setContentTitle(title)
                .setContentText(content)
                .setStyle(new NotificationCompat.BigTextStyle().bigText(content))
                .setSmallIcon(R.drawable.ic_stat_agent)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .setContentIntent(MainActivity.createPendingIntent(context))
                .build();
    }

    /** 事件通知（例如「家长下发了锁屏指令」）。 */
    public static void notifyEvent(Context context, int id, String title, String content) {
        ensureChannels(context);
        NotificationManager manager =
                (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null) return;

        PendingIntent intent = PendingIntent.getActivity(
                context, id, MainActivity.createIntent(context),
                PendingIntent.FLAG_UPDATE_CURRENT | pendingIntentFlag());

        Notification notification = new NotificationCompat.Builder(context, Constants.CHANNEL_EVENTS)
                .setContentTitle(title)
                .setContentText(content)
                .setStyle(new NotificationCompat.BigTextStyle().bigText(content))
                .setSmallIcon(R.drawable.ic_stat_agent)
                .setAutoCancel(true)
                .setContentIntent(intent)
                .build();
        manager.notify(id, notification);
    }

    private static int pendingIntentFlag() {
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.M ? PendingIntent.FLAG_IMMUTABLE : 0;
    }
}
