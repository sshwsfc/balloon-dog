package com.balloondog.agent.capability;

import androidx.annotation.Nullable;

import com.balloondog.agent.model.ScheduleRule;

import java.util.Collections;
import java.util.List;

/**
 * 「此刻该不该锁」的唯一判定处。
 *
 * <p>整个 Agent 里只有这里决定锁定状态，{@code AgentService} 每秒调一次，
 * 把结果交给 {@link LockEnforcer} 落地。把判断收敛到一处，是为了避免
 * 「倒计时窗说还有 10 秒、锁定页却已经锁上」这类自相矛盾的状态。
 *
 * <h3>优先级（从高到低）</h3>
 * <ol>
 *   <li><b>放行期</b>（家长临时解锁 / 答题奖励 / 家长手动解锁）—— 家长与答题的显式授权压倒一切，
 *       包括时间表和每日额度。否则「家长刚点了临时使用，却被作息表立刻锁回去」会很荒谬。</li>
 *   <li><b>家长远程锁定</b> —— 显式指令，压过时间表。</li>
 *   <li><b>时间表</b> —— 按设备本地时钟求值。</li>
 *   <li><b>每日额度耗尽</b> —— 本地统计的使用时长上限。</li>
 * </ol>
 *
 * <h3>倒计时</h3>
 * {@link #nextLockAt} 是下一次「将进入锁定」的时刻，{@link #countdownActive} 表示
 * 是否应当弹出透明悬浮窗预告。两者是同一个时间点的两种表达，不会互相打架。
 */
public final class LockState {

    /** 锁定原因，用于展示与排查。 */
    public enum Reason {
        /** 不锁定 */
        NONE,
        /** 家长远程锁定 */
        REMOTE,
        /** 作息时间表 */
        SCHEDULE,
        /** 每日可用时长用完 */
        DAILY_LIMIT
    }

    public final boolean locked;
    public final Reason reason;
    /** 人类可读的原因说明（规则名等），可为空。 */
    @Nullable
    public final String detail;
    /** 下一次将进入锁定的时刻；0 表示未来 7 天内不会因当前策略锁定。 */
    public final long nextLockAt;
    /**
     * 下一次锁定的<b>原因</b>（例如「作息：睡觉时间」）。
     *
     * <p>倒计时预告必须把它显示出来：只说「还有 30 秒锁定」孩子会莫名其妙，
     * 说清「因为睡觉时间到了」才是预告该有的作用。
     * 注意它和 {@link #detail} 不是一回事 —— {@code detail} 是「此刻」锁定的原因，
     * 而倒计时发生在锁定之前，此刻并没有原因。
     */
    @Nullable
    public final String nextLockReason;
    /** 是否应显示锁屏倒计时悬浮窗。 */
    public final boolean countdownActive;
    /** 倒计时剩余秒数（countdownActive 为 true 时有意义）。 */
    public final int countdownRemainingSeconds;

    private LockState(boolean locked, Reason reason, @Nullable String detail, long nextLockAt,
                      @Nullable String nextLockReason,
                      boolean countdownActive, int countdownRemainingSeconds) {
        this.locked = locked;
        this.reason = reason;
        this.detail = detail;
        this.nextLockAt = nextLockAt;
        this.nextLockReason = nextLockReason;
        this.countdownActive = countdownActive;
        this.countdownRemainingSeconds = countdownRemainingSeconds;
    }

    /** 判定所需的全部输入。刻意做成朴素的字段集合，方便在测试里直接摆数据。 */
    public static final class Inputs {
        public long now;
        /** 家长是否下发了锁定（服务端 config.locked）。 */
        public boolean remoteLocked;
        /** 放行截止时间：家长临时解锁 / 答题奖励 / 手动解锁三者取最晚。 */
        public long grantUntil;
        public boolean scheduleEnabled = false;
        public List<ScheduleRule> rules = Collections.emptyList();
        /** 今日额度是否已耗尽。 */
        public boolean dailyLimitExhausted = false;
        /** 按 1:1 实时消耗推算的额度耗尽时刻；0 表示未开启或已无限。 */
        public long dailyLimitAt = 0L;
        /** 锁屏前预告秒数，0 表示不预告。 */
        public int countdownSeconds = 30;
    }

    /** 某个时刻如果处于锁定，原因是什么。与 {@link #isLockedAt} 的判断顺序保持一致。 */
    private static Reason reasonAt(Inputs in, long at) {
        if (in.grantUntil > at) return Reason.NONE;
        if (in.remoteLocked) return Reason.REMOTE;
        if (in.scheduleEnabled && !in.rules.isEmpty()
                && ScheduleEngine.evaluate(in.rules, at).locked) {
            return Reason.SCHEDULE;
        }
        if (in.dailyLimitExhausted || (in.dailyLimitAt > 0 && at >= in.dailyLimitAt)) {
            return Reason.DAILY_LIMIT;
        }
        return Reason.NONE;
    }

    /** 某个时刻如果处于锁定，原因的人话说明。 */
    @Nullable
    private static String detailAt(Inputs in, long at, Reason reason) {
        switch (reason) {
            case REMOTE:
                return "家长已锁定";
            case SCHEDULE: {
                ScheduleEngine.Decision decision = ScheduleEngine.evaluate(in.rules, at);
                return decision.ruleName() == null ? "作息时间" : "作息：" + decision.ruleName();
            }
            case DAILY_LIMIT:
                return "今日可用时长已用完";
            default:
                return null;
        }
    }

    public static LockState compute(Inputs in) {
        long nextLockAt = findNextLockAt(in);
        boolean locked = isLockedAt(in, in.now);

        Reason reason = locked ? reasonAt(in, in.now) : Reason.NONE;
        String detail = locked ? detailAt(in, in.now, reason) : null;

        // 预告时要说清「因为什么要锁」，所以这里单独算一次下一次锁定的原因
        String nextLockReason = null;
        if (!locked && nextLockAt > 0) {
            Reason futureReason = reasonAt(in, nextLockAt);
            nextLockReason = detailAt(in, nextLockAt, futureReason);
        }

        boolean countdownActive = false;
        int remaining = 0;
        if (!locked && nextLockAt > 0 && in.countdownSeconds > 0) {
            long diff = nextLockAt - in.now;
            if (diff > 0 && diff <= in.countdownSeconds * 1000L) {
                countdownActive = true;
                // 向上取整：剩 0.4 秒时显示「1 秒」而不是「0 秒」，避免最后一秒闪一下 0
                remaining = (int) Math.ceil(diff / 1000.0);
            }
        }

        return new LockState(locked, reason, detail, nextLockAt, nextLockReason,
                countdownActive, remaining);
    }

    /** 某个时刻是否应处于锁定。 */
    static boolean isLockedAt(Inputs in, long at) {
        // 1) 放行期：家长临时解锁 / 答题奖励 / 手动解锁
        if (in.grantUntil > at) return false;

        // 2) 家长远程锁定
        if (in.remoteLocked) return true;

        // 3) 时间表（按设备本地时钟）
        if (in.scheduleEnabled && !in.rules.isEmpty()
                && ScheduleEngine.evaluate(in.rules, at).locked) {
            return true;
        }

        // 4) 每日额度：已耗尽，或在这个时刻之前会耗尽
        if (in.dailyLimitExhausted) return true;
        return in.dailyLimitAt > 0 && at >= in.dailyLimitAt;
    }

    /**
     * 找下一次进入锁定的时刻。
     *
     * <p>逐分钟向后扫描最多 7 天。相比「直接取时间表的下一个边界」这种取巧写法，
     * 扫描才能正确处理放行期与时间表叠加的情形（例如答题奖励 10 分钟、
     * 而作息表 2 小时后才锁 → 下一次锁定其实是 10 分钟后奖励到期的瞬间）。
     */
    static long findNextLockAt(Inputs in) {
        if (isLockedAt(in, in.now)) return 0; // 已经锁了，没有「下一次」

        long from = in.now;
        // 放行期内：最早可能的锁定时刻就是放行结束的那一刻，先单独判一下，
        // 省掉最长 7 天的扫描（这是最常见的情形：孩子刚答完题）
        if (in.grantUntil > from) {
            if (isLockedAt(in, in.grantUntil)) return in.grantUntil;
            from = in.grantUntil;
        }

        java.util.Calendar cursor = java.util.Calendar.getInstance();
        cursor.setTimeInMillis(from);
        cursor.set(java.util.Calendar.SECOND, 0);
        cursor.set(java.util.Calendar.MILLISECOND, 0);

        for (int i = 0; i < 7 * 1440; i++) {
            cursor.add(java.util.Calendar.MINUTE, 1);
            long at = cursor.getTimeInMillis();
            if (isLockedAt(in, at)) return at;
        }
        return 0;
    }

    /** 一句话摘要，用于通知与日志。 */
    public String describe() {
        if (!locked) {
            if (countdownActive) return "还有 " + countdownRemainingSeconds + " 秒锁定";
            return "未锁定";
        }
        switch (reason) {
            case REMOTE:
                return "已锁定（家长远程锁定）";
            case SCHEDULE:
                return "已锁定（作息：" + detail + "）";
            case DAILY_LIMIT:
                return "已锁定（今日时长已用完）";
            default:
                return "已锁定";
        }
    }
}
