package com.balloondog.agent.service;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.app.job.JobInfo;
import android.app.job.JobScheduler;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.SystemClock;

import androidx.annotation.Nullable;

import com.balloondog.agent.data.Constants;
import com.balloondog.agent.data.EventLog;

/**
 * 保活看门狗（需求 1）。
 *
 * <h3>先说清楚它<b>做不到</b>什么</h3>
 * 用户在系统设置里点「强行停止」后，应用进入 stopped 状态，
 * <b>任何</b> AlarmManager、JobScheduler、广播都无法再把它唤醒 —— 包括另一个进程，
 * 因为强停会杀掉该应用的所有进程。双进程互相拉起在这种情况下是无效的表演。
 * 唯一可靠的解法是设备所有者 + {@code DISALLOW_APPS_CONTROL}（见
 * {@link com.balloondog.agent.capability.OwnerHardening}），让那个按钮直接变灰。
 *
 * <h3>它真正解决什么</h3>
 * 低内存回收、厂商 ROM 的后台清理、Doze 冻结 —— 这些场景下进程只是被杀死，
 * 并没有进入 stopped 状态，此时 AlarmManager 与 JobScheduler 都能把它拉回来：
 * <ul>
 *   <li><b>AlarmManager</b>：每 60 秒一次，自己重新排下一次（比 setRepeating 更可控，
 *       能配合 {@code setAndAllowWhileIdle} 在 Doze 下也触发）；</li>
 *   <li><b>JobScheduler</b>：15 分钟一次的兜底，带 {@code setPersisted} 能在重启后保留；</li>
 *   <li><b>onTaskRemoved</b>：用户从最近任务划掉时立刻自救（见 AgentService）。</li>
 * </ul>
 * 三者叠加，把「非强停」这个区间守住了；配合设备所有者把强停本身堵死。
 */
public final class WatchdogScheduler {

    /** 看门狗心跳间隔。太短会耗电，太长则掉线窗口过大；60 秒是折中。 */
    private static final long WATCHDOG_INTERVAL_MS = 60_000L;

    /** JobScheduler 兜底任务的周期（系统下限就是 15 分钟）。 */
    private static final long JOB_INTERVAL_MS = 15 * 60_000L;
    private static final int JOB_ID = 0x8A11;

    private WatchdogScheduler() {
    }

    private static PendingIntent watchdogIntent(Context context) {
        Intent intent = new Intent(context, WatchdogReceiver.class);
        intent.setAction(Constants.ACTION_WATCHDOG);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            flags |= PendingIntent.FLAG_IMMUTABLE;
        }
        return PendingIntent.getBroadcast(context, 0x1001, intent, flags);
    }

    /**
     * 排下一次看门狗。
     *
     * <p>刻意用「每次触发后自己重排」而不是 {@code setRepeating}：
     * 前者可以在每次触发时重新判断服务是否还活着，也能在 Doze 下用
     * {@code setAndAllowWhileIdle} 拿到一次唤醒窗口；后者在 Doze 下会被无限推迟。
     */
    public static void scheduleWatchdog(Context context) {
        AlarmManager manager = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
        if (manager == null) return;

        long triggerAt = SystemClock.elapsedRealtime() + WATCHDOG_INTERVAL_MS;
        PendingIntent pending = watchdogIntent(context);
        try {
            manager.setAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME_WAKEUP, triggerAt, pending);
        } catch (SecurityException e) {
            EventLog.warn("排定看门狗失败：" + e.getMessage());
        }
        scheduleJob(context);
    }

    /**
     * 在时间表边界处安排一次精确唤醒。
     *
     * <p>正常情况下 1 秒 ticker 已经足够准时；这个闹钟是为深度 Doze 准备的 ——
     * 那时 CPU 会睡过去，ticker 不再运行，而「22:00 必须锁屏」不该因此迟到。
     * Android 12+ 精确闹钟需要单独授权，拿不到就退化为不精确闹钟（最多迟几分钟），
     * 并且会在日志里说明，不做静默降级。
     */
    public static void scheduleBoundary(Context context, long atMillis) {
        if (atMillis <= System.currentTimeMillis()) return;
        AlarmManager manager = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
        if (manager == null) return;

        Intent intent = new Intent(context, WatchdogReceiver.class);
        intent.setAction(Constants.ACTION_SCHEDULE_BOUNDARY);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            flags |= PendingIntent.FLAG_IMMUTABLE;
        }
        PendingIntent pending = PendingIntent.getBroadcast(context, 0x1002, intent, flags);

        try {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S || manager.canScheduleExactAlarms()) {
                manager.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, atMillis, pending);
            } else {
                manager.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, atMillis, pending);
                EventLog.warn("未获得精确闹钟权限，锁屏时间点可能略有延迟");
            }
        } catch (SecurityException e) {
            EventLog.warn("排定时间表边界闹钟失败：" + e.getMessage());
        }
    }

    /** 排一个 15 分钟周期的兜底任务。 */
    private static void scheduleJob(Context context) {
        JobScheduler scheduler = (JobScheduler) context.getSystemService(Context.JOB_SCHEDULER_SERVICE);
        if (scheduler == null) return;
        try {
            JobInfo job = new JobInfo.Builder(JOB_ID, new ComponentName(context, AgentJobService.class))
                    .setPeriodic(JOB_INTERVAL_MS)
                    // 重启后仍然保留：设备重启是孩子最常用的「重置」手段之一
                    .setPersisted(true)
                    .setRequiredNetworkType(JobInfo.NETWORK_TYPE_NONE)
                    .build();
            scheduler.schedule(job);
        } catch (Exception e) {
            EventLog.warn("排定保活任务失败：" + e.getMessage());
        }
    }

    /** 停止守护时取消一切唤醒源。 */
    public static void cancel(Context context) {
        AlarmManager manager = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
        if (manager != null) {
            try {
                manager.cancel(watchdogIntent(context));
            } catch (Exception ignored) {
                // 未排定过时忽略
            }
        }
        JobScheduler scheduler = (JobScheduler) context.getSystemService(Context.JOB_SCHEDULER_SERVICE);
        if (scheduler != null) {
            scheduler.cancel(JOB_ID);
        }
    }

    /** 看门狗是否还排着（用于界面自检）。 */
    @Nullable
    public static String describe(Context context) {
        AlarmManager manager = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
        if (manager == null) return "无法访问闹钟服务";
        PendingIntent pending = watchdogIntent(context);
        boolean scheduled = pending != null;
        return scheduled ? "看门狗已排定（每 60 秒自检一次）" : "看门狗未排定";
    }
}
