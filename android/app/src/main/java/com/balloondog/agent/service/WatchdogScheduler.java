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
import com.balloondog.agent.capability.TrustedClock;

/**
 * 保活看门狗（需求 2「不能被杀死 / 保持长活」的兜底链路）。
 *
 * <h3>先说清楚它<b>做不到</b>什么</h3>
 * 用户在系统设置里点「强行停止」后，应用进入 stopped 状态，
 * <b>任何</b> AlarmManager、JobScheduler、广播都无法再把它唤醒 —— 包括另一个进程，
 * 因为强停会杀掉该应用的所有进程。双进程互相拉起在这种情况下是无效的表演。
 * 唯一可靠的解法是设备所有者 + {@code DISALLOW_APPS_CONTROL} +
 * {@code setUserControlDisabledPackages}（见
 * {@link com.balloondog.agent.capability.OwnerHardening}），让那个按钮直接变灰。
 *
 * <h3>它真正解决什么</h3>
 * 低内存回收、厂商 ROM 的后台清理、Doze 冻结 —— 这些场景下进程只是被杀死，
 * 并没有进入 stopped 状态，此时 AlarmManager 与 JobScheduler 都能把它拉回来：
 * <ul>
 *   <li><b>AlarmManager（主）</b>：每 60 秒一次，自己重新排下一次（比 setRepeating 更可控，
 *       能配合 {@code setAndAllowWhileIdle} 在 Doze 下也触发）；</li>
 *   <li><b>AlarmManager（备）</b>：每 15 分钟一次，走 {@code setExactAndAllowWhileIdle}
 *       争取更硬的唤醒窗口 —— 主闹钟被 Doze 推迟时它还能醒来，两者互相重排，不依赖任何单一通道；</li>
 *   <li><b>JobScheduler</b>：15 分钟一次的兜底，带 {@code setPersisted} 能在重启后保留；</li>
 *   <li><b>onTaskRemoved</b>：用户从最近任务划掉时立刻自救（见 AgentService）。</li>
 * </ul>
 * 三者叠加，把「非强停」这个区间守住了；配合设备所有者把强停本身堵死。
 * 另外 {@code LongevityGuard} 会用同一套唤醒源做「加固项被改动」的周期巡检与自愈。
 */
public final class WatchdogScheduler {

    /** 看门狗心跳间隔。太短会耗电，太长则掉线窗口过大；60 秒是折中。 */
    private static final long WATCHDOG_INTERVAL_MS = 60_000L;

    /** JobScheduler 兜底任务的周期（系统下限就是 15 分钟）。 */
    private static final long JOB_INTERVAL_MS = 15 * 60_000L;
    private static final int JOB_ID = 0x8A11;

    private WatchdogScheduler() {
    }

    /** 备用看门狗闹钟的间隔。它存在的意义是「主闹钟被 Doze 推迟时还能醒来」。 */
    private static final long BACKUP_INTERVAL_MS = 15 * 60_000L;

    private static PendingIntent watchdogIntent(Context context, int extraFlags) {
        Intent intent = new Intent(context, WatchdogReceiver.class);
        intent.setAction(Constants.ACTION_WATCHDOG);
        int flags = extraFlags;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            flags |= PendingIntent.FLAG_IMMUTABLE;
        }
        return PendingIntent.getBroadcast(context, 0x1001, intent, flags);
    }

    private static PendingIntent backupIntent(Context context, int extraFlags) {
        Intent intent = new Intent(context, WatchdogReceiver.class);
        intent.setAction(Constants.ACTION_WATCHDOG);
        int flags = extraFlags;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            flags |= PendingIntent.FLAG_IMMUTABLE;
        }
        return PendingIntent.getBroadcast(context, 0x1003, intent, flags);
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
        PendingIntent pending = watchdogIntent(context, PendingIntent.FLAG_UPDATE_CURRENT);
        try {
            manager.setAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME_WAKEUP, triggerAt, pending);
        } catch (SecurityException e) {
            EventLog.warn("排定看门狗失败：" + e.getMessage());
        }
        scheduleBackupAlarm(context);
        scheduleJob(context);
    }

    /**
     * 备用看门狗闹钟：比主看门狗更少触发（15 分钟一次），但争取走<b>精确</b>通道。
     *
     * <p>为什么要两条闹钟：{@code setAndAllowWhileIdle} 在 Doze 下每个应用每 9 分钟才允许一次，
     * 而且系统可以把它推迟到「维护窗口」；实测在长时间息屏后主看门狗的触发间隔会被拉到十几分钟。
     * 备用闹钟用 {@code setExactAndAllowWhileIdle} 拿到更硬的唤醒窗口，两条互相兜底，
     * 任意一条醒来都会重新排定对方。
     *
     * <p><b>功耗说明</b>：每次唤醒只做三件极轻的事（读 {@code AgentService.isRunning()}、
     * 必要时 {@code startForegroundService}、重排下一次）。实测本工程 60 秒主闹钟 +
     * 15 分钟备用闹钟的组合在模拟器上不产生可观测的额外耗电；如果将来要更省电，
     * 把 {@link #WATCHDOG_INTERVAL_MS} 调到 5 分钟是安全的。
     *
     * <p>Android 12(API 31) 起精确闹钟需要 {@code SCHEDULE_EXACT_ALARM} 授权；
     * 拿不到就退化为不精确闹钟并如实记一条 warn，不做静默降级。
     */
    private static void scheduleBackupAlarm(Context context) {
        AlarmManager manager = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
        if (manager == null) return;

        long triggerAt = SystemClock.elapsedRealtime() + BACKUP_INTERVAL_MS;
        PendingIntent pending = backupIntent(context, PendingIntent.FLAG_UPDATE_CURRENT);
        try {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S || manager.canScheduleExactAlarms()) {
                manager.setExactAndAllowWhileIdle(
                        AlarmManager.ELAPSED_REALTIME_WAKEUP, triggerAt, pending);
            } else {
                manager.setAndAllowWhileIdle(
                        AlarmManager.ELAPSED_REALTIME_WAKEUP, triggerAt, pending);
                EventLog.warn("未获得精确闹钟权限，备用看门狗退化为不精确闹钟（Doze 下最多延迟约 15 分钟）");
            }
        } catch (SecurityException e) {
            EventLog.warn("排定备用看门狗失败：" + e.getMessage());
        }
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
        // 家长配的是「22:00」这种墙钟时刻，但闹钟**不能**用 RTC 排：
        // 孩子把系统时间一改，RTC 闹钟就跟着错位（改早＝提前锁、改晚＝永远不锁）。
        // 用可信时钟算出「还有多久」，再交给单调的 ELAPSED_REALTIME 去数（规划 §1.6）。
        long delay = atMillis - TrustedClock.now();
        if (delay <= 0) return;
        long triggerAt = SystemClock.elapsedRealtime() + delay;
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
                manager.setExactAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME_WAKEUP, triggerAt, pending);
            } else {
                manager.setAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME_WAKEUP, triggerAt, pending);
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
                PendingIntent pending = watchdogIntent(context, PendingIntent.FLAG_NO_CREATE);
                if (pending != null) manager.cancel(pending);
                PendingIntent backup = backupIntent(context, PendingIntent.FLAG_NO_CREATE);
                if (backup != null) manager.cancel(backup);
            } catch (Exception ignored) {
                // 未排定过时忽略
            }
        }
        JobScheduler scheduler = (JobScheduler) context.getSystemService(Context.JOB_SCHEDULER_SERVICE);
        if (scheduler != null) {
            scheduler.cancel(JOB_ID);
        }
    }

    /**
     * 兜底 JobScheduler 任务是否真的排着。
     *
     * <p>这一条系统提供公开查询（{@code getPendingJob}，API 24+），所以它是<b>确切</b>的。
     */
    public static boolean isJobScheduled(Context context) {
        JobScheduler scheduler = (JobScheduler) context.getSystemService(Context.JOB_SCHEDULER_SERVICE);
        if (scheduler == null) return false;
        try {
            return scheduler.getPendingJob(JOB_ID) != null;
        } catch (Exception e) {
            return false;
        }
    }

    /**
     * 看门狗闹钟的 PendingIntent 是否已注册。
     *
     * <p><b>注意这不是「闹钟此刻一定在排队」的证明</b>：Android 没有公开 API 能查询
     * AlarmManager 里还有哪些闹钟（{@code getNextAlarmClock} 只覆盖 {@code setAlarmClock}）。
     * 这里只能说「我们注册过」，所以界面上必须如实写清楚，
     * 不能像旧实现那样凭一个恒非 null 的返回值就报「已排定」。
     */
    public static boolean hasWatchdogPendingIntent(Context context) {
        try {
            return watchdogIntent(context, PendingIntent.FLAG_NO_CREATE) != null;
        } catch (Exception e) {
            return false;
        }
    }

    /**
     * 保活链路的人类可读状态（用于界面自检）。
     *
     * <p>旧实现只看 {@code PendingIntent.getBroadcast(...) != null}，而那个调用永远返回非 null，
     * 所以它<b>恒报「看门狗已排定」</b>——这是个假阳性。现在分开说清楚哪一条是系统可查的实测结果、
     * 哪一条只是「本应用注册过」。
     */
    @Nullable
    public static String describe(Context context) {
        AlarmManager manager = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
        if (manager == null) return "无法访问闹钟服务";

        StringBuilder sb = new StringBuilder();
        if (hasWatchdogPendingIntent(context)) {
            sb.append("看门狗闹钟：已注册（每 60 秒一次；系统未提供查询排队状态的公开 API）");
        } else {
            sb.append("看门狗闹钟：未注册");
        }
        sb.append('\n').append(isJobScheduled(context)
                ? "兜底任务：已排定（15 分钟一次，系统实测）"
                : "兜底任务：未排定（系统实测）");
        return sb.toString();
    }
}
