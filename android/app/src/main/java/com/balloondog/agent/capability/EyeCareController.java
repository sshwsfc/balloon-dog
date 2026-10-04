package com.balloondog.agent.capability;

import android.content.Context;
import android.os.SystemClock;

import com.balloondog.agent.data.AgentStore;
import com.balloondog.agent.data.EventLog;
import com.balloondog.agent.model.EyeCareConfig;

/**
 * 护眼设置的实际执行者。
 *
 * <h3>三件事，三种做法</h3>
 * <ol>
 *   <li><b>连续用眼强制休息</b>：屏幕亮着就累计，到点写一个「休息截止时刻」到
 *       {@link LockState.Inputs#eyeLockUntil}，由既有的锁定体系真锁屏。
 *       休息结束自动解锁 —— 不是提示一下就完事。</li>
 *   <li><b>夜间护眼</b>：落在时段内就持续提供锁定原因（若家长开了夜间锁定）。</li>
 *   <li><b>亮度上限</b>：需要 {@code WRITE_SETTINGS}。拿不到就如实记一条警告，
 *       不假装已经限了 —— 家长以为限了其实没限，比没有这个功能更糟。</li>
 * </ol>
 *
 * <h3>为什么用「屏幕亮着」而不是「在用某个应用」来计时</h3>
 * 看视频、看小说、刷网页都属于用眼，而这些都是「屏幕亮着」。
 * 用前台应用来计时会漏掉「一直停在同一个应用里」这种最典型的长时间用眼场景。
 */
public final class EyeCareController {

    /** 两次 tick 之间允许的最大时间差；超过就认为是时钟跳变或休眠，不计入。 */
    private static final long MAX_TICK_GAP_MS = 15_000L;

    private static final String SETTINGS_WRITE_HINT =
            "护眼亮度上限需要「修改系统设置」权限，当前未授予，亮度限制未生效";

    private final Context context;
    private final AgentStore store;

    private long lastTickAt;
    private long lastBrightnessApplyAt;
    private boolean brightnessHintLogged;

    public EyeCareController(Context context, AgentStore store) {
        this.context = context.getApplicationContext();
        this.store = store;
    }

    /**
     * 每秒调用一次。
     *
     * @param screenOn 屏幕是否亮着
     * @param locked   当前是否已被别的规则锁定（锁着时不算「用眼」）
     * @return true 表示本次 tick 改变了护眼状态（例如刚触发强制休息），调用方应立刻重算锁定
     */
    public boolean tick(boolean screenOn, boolean locked, long nowWall) {
        EyeCareConfig config = store.getEyeCareConfig();
        long now = SystemClock.elapsedRealtime();

        if (!config.enabled) {
            if (store.getEyeContinuousMs() != 0) store.setEyeContinuousMs(0);
            lastTickAt = now;
            return false;
        }

        boolean changed = false;

        // ---- 1) 强制休息到点：自动解除 ----
        long restUntil = store.getEyeRestUntil();
        if (restUntil > 0 && nowWall >= restUntil) {
            store.setEyeRestUntil(0);
            EventLog.success("护眼休息结束，设备恢复可用");
            changed = true;
        }

        // ---- 2) 连续用眼计时 ----
        long gap = lastTickAt == 0 ? 0 : now - lastTickAt;
        lastTickAt = now;

        boolean actuallyUsing = screenOn && !locked && store.getEyeRestUntil() == 0;
        if (!actuallyUsing || gap <= 0 || gap > MAX_TICK_GAP_MS) {
            // 熄屏或已锁定：连续用眼中断，计时归零。
            // 刻意不在「刚熄屏的那一秒」就归零 —— 短暂切后台不该让计时白攒。
            // 这里用 MAX_TICK_GAP_MS 兜住：真正的熄屏会让 tick 的时间差变大。
            if (!actuallyUsing && gap > MAX_TICK_GAP_MS && store.getEyeContinuousMs() != 0) {
                store.setEyeContinuousMs(0);
            }
        } else {
            long continuous = store.getEyeContinuousMs() + gap;
            store.setEyeContinuousMs(continuous);

            long threshold = config.continuousMinutes * 60_000L;
            if (continuous >= threshold) {
                long until = nowWall + config.restMinutes * 60_000L;
                store.setEyeRestUntil(until);
                store.setEyeContinuousMs(0);
                EventLog.warn("护眼：连续用眼已达 " + config.continuousMinutes + " 分钟，强制休息 "
                        + config.restMinutes + " 分钟");
                changed = true;
            }
        }

        // ---- 3) 亮度上限 ----
        applyBrightnessCap(config);

        return changed;
    }

    /**
     * 护眼锁定的原因与截止时刻。
     *
     * @return 长度为 2 的数组：{原因, 截止时刻(0=由当前条件决定)}；不需要锁定时返回 null
     */
    public static Object[] currentLock(AgentStore store, long nowWall) {
        EyeCareConfig config = store.getEyeCareConfig();
        if (!config.enabled) return null;

        long restUntil = store.getEyeRestUntil();
        if (restUntil > nowWall) {
            long minutes = Math.max(1, (restUntil - nowWall + 59_999) / 60_000);
            return new Object[]{"护眼休息中，还需 " + minutes + " 分钟", restUntil};
        }

        if (config.nightLockEnabled && config.nightEnabled()) {
            java.util.Calendar c = java.util.Calendar.getInstance();
            c.setTimeInMillis(nowWall);
            if (config.isNightHour(c.get(java.util.Calendar.HOUR_OF_DAY))) {
                return new Object[]{"夜间护眼时段（" + config.nightStartHour + ":00 - "
                        + config.nightEndHour + ":00）", 0L};
            }
        }
        return null;
    }

    /**
     * 施加亮度上限。
     *
     * <p>没有 {@code WRITE_SETTINGS} 时只记一次警告，不重复刷日志也不假装生效。
     */
    private void applyBrightnessCap(EyeCareConfig config) {
        if (config.maxBrightnessPercent <= 0) return;

        long now = SystemClock.elapsedRealtime();
        if (now - lastBrightnessApplyAt < 30_000L) return; // 30 秒一次，别频繁写系统设置
        lastBrightnessApplyAt = now;

        if (!android.provider.Settings.System.canWrite(context)) {
            if (!brightnessHintLogged) {
                brightnessHintLogged = true;
                EventLog.warn(SETTINGS_WRITE_HINT);
            }
            return;
        }

        try {
            int max = Math.max(1, Math.min(255, config.maxBrightnessPercent * 255 / 100));
            int current = android.provider.Settings.System.getInt(
                    context.getContentResolver(), android.provider.Settings.System.SCREEN_BRIGHTNESS, max);
            if (current > max) {
                android.provider.Settings.System.putInt(
                        context.getContentResolver(), android.provider.Settings.System.SCREEN_BRIGHTNESS, max);
                EventLog.info("护眼：已把屏幕亮度压到上限 " + config.maxBrightnessPercent + "%");
            }
        } catch (Exception e) {
            EventLog.warn("设置亮度上限失败：" + e.getMessage());
        }
    }

    /** 家长关掉护眼或解除锁定时，把休息状态清干净。 */
    public void clearRest() {
        if (store.getEyeRestUntil() != 0) {
            store.setEyeRestUntil(0);
        }
        store.setEyeContinuousMs(0);
    }

    /** 供设置页展示：距下次强制休息还有多久（分钟）；未启用返回 -1。 */
    public int minutesToRest() {
        EyeCareConfig config = store.getEyeCareConfig();
        if (!config.enabled) return -1;
        long continuous = store.getEyeContinuousMs();
        long remain = config.continuousMinutes * 60_000L - continuous;
        return (int) Math.max(0, (remain + 59_999) / 60_000);
    }
}
