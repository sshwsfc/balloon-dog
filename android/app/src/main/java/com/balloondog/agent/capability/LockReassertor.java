package com.balloondog.agent.capability;

import android.app.ActivityManager;
import android.content.Context;
import android.os.PowerManager;
import android.os.SystemClock;

import com.balloondog.agent.data.AgentStore;
import com.balloondog.agent.data.EventLog;
import com.balloondog.agent.ui.LockOverlayWindow;

/**
 * 锁定状态复核器 —— 「只要没被杀死，就一定锁得住」的那一半。
 *
 * <h3>它解决什么问题</h3>
 * {@link LockEnforcer} 只在锁定状态<b>发生翻转</b>时执行一次。这留了一个缺口：
 * 孩子如果找到办法把锁屏界面弄掉（清掉悬浮窗、退出 Lock Task、把屏幕点亮后
 * 系统没恢复锁定页），状态并没有「翻转」，enforcer 就不会再动手，
 * 于是手机就一直裸奔到下一次策略变化。
 *
 * <p>本类每 {@link #CHECK_INTERVAL_MS} 毫秒做一次<b>实际情况核实</b>：
 * <pre>
 *   策略要求锁定？
 *     ├─ 屏幕是亮的？（PowerManager.isInteractive）
 *     └─ 实际真的锁着吗？
 *          · kiosk 档   → ActivityManager.getLockTaskModeState() == LOCKED
 *          · 悬浮窗档   → LockOverlayWindow.isShowing()
 *          · 密码档     → 被改写的随机密码仍在生效
 *   屏幕亮着 但 实际没锁 → 立刻重新锁定
 * </pre>
 *
 * <p>另外，亮屏广播（{@code ACTION_SCREEN_ON} / {@code ACTION_USER_PRESENT}）会
 * 触发一次<b>立即</b>复核，不必等下一个周期 —— 「孩子点亮屏幕」正是最需要马上反应的时刻。
 *
 * <h3>为什么不用「每 3 秒无条件重锁一次」</h3>
 * 那会让 {@code lockNow()} 每秒把屏幕关掉一次，孩子根本没法用手机，
 * 家长正常放行时也会被立刻打断。判断「实际没锁」再动手，
 * 才能既保证锁得住、又不误伤正常的解锁使用。
 */
public final class LockReassertor {

    /** 复核间隔。3 秒是「反应够快」与「不无谓唤醒」之间的折中。 */
    private static final long CHECK_INTERVAL_MS = 3_000L;

    /** 两次「强制重新锁定」之间的最小间隔，避免在异常状态下疯狂 lockNow。 */
    private static final long MIN_REASSERT_INTERVAL_MS = 5_000L;

    private final Context appContext;
    private final AgentStore store;
    /** 由 AgentService 注入：真正执行一次锁定。 */
    private final LockEnforcer enforcer;

    private long lastCheckAt;
    private long lastReassertAt;
    private int consecutiveFailures;

    public LockReassertor(Context context, AgentStore store, LockEnforcer enforcer) {
        this.appContext = context.getApplicationContext();
        this.store = store;
        this.enforcer = enforcer;
    }

    /**
     * 由 Agent 的 1 秒 ticker 调用；内部自己按 {@link #CHECK_INTERVAL_MS} 节流。
     *
     * @return 本次是否执行了强制重新锁定
     */
    public boolean tick() {
        long now = SystemClock.elapsedRealtime();
        if (now - lastCheckAt < CHECK_INTERVAL_MS) return false;
        lastCheckAt = now;
        return reassertIfNeeded("周期复核", false);
    }

    /**
     * 亮屏 / 解锁广播触发。
     *
     * <p>这是<b>最狠也最贴合需求</b>的一条：需求明确要求「锁屏状态下屏幕被打开，就再锁一次」。
     * 所以这里不看「实际是否还锁着」——只要策略要求锁定，屏幕一亮就直接再锁一次
     * （{@code lockNow()} 会把屏幕重新关掉）。孩子靠任何办法点亮屏幕，
     * 几秒内就会被打回去，看不到也操作不了任何东西。
     */
    public boolean onScreenOn() {
        lastCheckAt = SystemClock.elapsedRealtime();
        return reassertIfNeeded("屏幕被点亮", true);
    }

    /**
     * 核实并（必要时）重新锁定。
     *
     * @param trigger 触发来源，写进日志便于排查「到底是谁发现没锁上」
     */
    public boolean reassertIfNeeded(String trigger) {
        return reassertIfNeeded(trigger, false);
    }

    /**
     * @param force true 表示「只要策略要求锁定就重新锁」，不检查实际锁定状态。
     *              亮屏广播走这条路 —— 需求要的就是「屏幕一亮就再锁一次」。
     */
    public boolean reassertIfNeeded(String trigger, boolean force) {
        LockState state = LockState.compute(
                LockEnforcer.buildInputs(store, System.currentTimeMillis()));
        if (!state.locked) {
            consecutiveFailures = 0;
            return false;
        }

        boolean screenOn = isScreenInteractive();
        boolean actuallyLocked = isActuallyLocked();

        // 非强制时：只有「实际没锁住」才动手。
        // 否则每 3 秒无条件 lockNow 会把屏幕反复关掉，家长正常放行时也会被误伤。
        if (!force && actuallyLocked) {
            consecutiveFailures = 0;
            return false;
        }

        // 熄屏时不做周期补锁：屏幕都关着，孩子什么都看不见也用不了，
        // 这一刻本来就是安全的。而强制路径（亮屏）会在屏幕亮起的那一瞬间接手。
        //
        // 不加这一条会有实实在在的浪费：系统锁屏盖在我们的锁定页上面时，
        // 锁定页 Activity 处于 stopped 状态（isShowing() 为 false），
        // 周期复核就会每 3 秒把它重新拉起来一次 —— 屏幕关着，谁也不看，
        // 纯粹白耗电，还会把日志刷满。
        if (!force && !screenOn) {
            return false;
        }

        // 强制（亮屏）时也要节流：解锁广播与亮屏广播可能几乎同时到达
        long now = SystemClock.elapsedRealtime();
        if (now - lastReassertAt < MIN_REASSERT_INTERVAL_MS) return false;
        lastReassertAt = now;

        // 亮屏、而且锁定界面确实还在最前：把界面重新摆一次就够，**不要关屏**。
        //
        // 关屏看着更狠，实际是自伤：孩子按一下电源键屏幕立刻又黑，
        // 既看不到「为什么被锁」，也点不到答题解锁入口 —— 家长设置的锁屏说明等于白设，
        // 体验上还像设备坏了。安全上也没有任何增益：锁定界面就在最前，什么都操作不了。
        // 真正需要关屏的是「实际没锁住」（孩子已经绕过去了），那时走下面的兜底分支。
        if (force && actuallyLocked) {
            EventLog.warn("锁定复核（" + trigger + "）：屏幕被点亮，重新把锁定界面摆回最前");
            LockEnforcer.showLockUi(appContext, store, state);
            consecutiveFailures = 0;
            return true;
        }

        consecutiveFailures++;
        if (force) {
            EventLog.warn("锁定复核（" + trigger + "）：策略要求锁定，但实际未锁住，正在重新锁上");
        } else if (consecutiveFailures == 1 || consecutiveFailures % 5 == 0) {
            EventLog.warn(String.format(
                    "锁定复核（%s）：策略要求锁定，但实际未锁住（屏幕%s），正在重新锁定%s",
                    trigger,
                    screenOn ? "亮着" : "已熄屏",
                    consecutiveFailures > 1 ? "（第 " + consecutiveFailures + " 次）" : ""));
        }

        LockEnforcer.showLockUi(appContext, store, state);
        // 没有设备管理器时 showLockUi 只能给个遮罩；再调一次 lockNow 把屏幕也关掉，
        // 争取让「亮屏 → 锁定页」这条链路重新闭合
        LockController.lockNow(appContext);
        return true;
    }

    /** 屏幕是否处于交互状态（亮着且未息屏）。 */
    private boolean isScreenInteractive() {
        try {
            PowerManager power = (PowerManager) appContext.getSystemService(Context.POWER_SERVICE);
            return power != null && power.isInteractive();
        } catch (Exception e) {
            return false;
        }
    }

    /**
     * 设备上「实际」是否处于锁定。
     *
     * <p>判据按能力档区分，而不是只看某一个标志：
     * kiosk 看系统的 Lock Task 状态（唯一权威），悬浮窗档看窗口是否真的还挂着。
     */
    private boolean isActuallyLocked() {
        try {
            ActivityManager am = (ActivityManager) appContext.getSystemService(Context.ACTIVITY_SERVICE);
            if (am != null && am.getLockTaskModeState() == ActivityManager.LOCK_TASK_MODE_LOCKED) {
                return true;
            }
        } catch (Exception ignored) {
            // 读不到就当没锁，宁可多锁一次
        }
        if (LockOverlayWindow.isShowing()) return true;

        // 锁定页（Activity 形态）在前台也算锁着。用 dumpsys 之外的方式判断代价太高，
        // 这里靠 LockScreenActivity 自己维护的静态标志。
        return com.balloondog.agent.ui.LockScreenActivity.isShowing();
    }

    /** 供界面展示：当前是否真的锁着。 */
    public boolean isCurrentlyLocked() {
        return isActuallyLocked();
    }
}
