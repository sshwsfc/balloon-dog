package com.balloondog.agent.capability;

import com.balloondog.agent.model.JsonUtils;

/**
 * 孩子端主页上「今天还剩多少时间」的纯计算（规划 §3.2）。
 *
 * <p>为什么把它单独抽出来：这段话每天要给孩子看几十次，说错一次孩子就会盯着一个
 * 不对的数字过一天 —— 而它恰恰是没法用模拟器验的那类东西（要真的用掉几个小时）。
 * 这里的输入只有两个整数（家长设的额度、今天已用的秒数），判定与文案都是纯函数，
 * 于是可以在普通 JVM 上把边界逐条钉死（见 {@code PureLogicCheck.checkChildStatus}）。
 *
 * <p>口径刻意与 {@link LockEnforcer} 的判定**共用同一组输入**（额度分钟 + 已用秒数）：
 * 孩子端主页说「还剩 5 分钟」而锁定判定认为「已经用完」这种事，比不显示更伤信任。
 * 所以两者都直接读 {@code store.getDailyLimitMinutes()} 与
 * {@code store.getUsageSecondsToday()}，不各自再算一遍。
 *
 * <p>「家长没有设置额度」与「额度已用完」必须分开说：前者是「你可以玩」，
 * 后者是「今天到此为止」。混成一句「剩余 0 分钟」会让孩子以为家长刚刚改了设置。
 */
public final class ChildStatus {

    private ChildStatus() {
    }

    /** 某一时刻的额度快照。字段都是不可变的。 */
    public static final class Snapshot {
        /** 家长是否设了每日额度。false 时下面几个字段都无意义（一律 0）。 */
        public final boolean hasLimit;
        public final long limitSeconds;
        /** 今天已用秒数（已夹到 >= 0）。 */
        public final long usedSeconds;
        /** 今天剩余秒数，已夹到 >= 0（超额时是 0，不会是负数）。 */
        public final long remainingSeconds;
        /** 有限额且已经用完 —— 注意这与 hasLimit=false 是两件完全不同的事。 */
        public final boolean exhausted;
        /** 剩余百分比（0..100），进度条直接用。 */
        public final int remainingPercent;

        Snapshot(boolean hasLimit, long limitSeconds, long usedSeconds,
                 long remainingSeconds, boolean exhausted, int remainingPercent) {
            this.hasLimit = hasLimit;
            this.limitSeconds = limitSeconds;
            this.usedSeconds = usedSeconds;
            this.remainingSeconds = remainingSeconds;
            this.exhausted = exhausted;
            this.remainingPercent = remainingPercent;
        }
    }

    /**
     * @param limitMinutes 家长设的每日额度分钟数；{@code <= 0} 视为不限（与 LockEnforcer 一致：
     *                     手滑设成 0 不该把孩子手机锁死）
     * @param usedSeconds  今天已用秒数；负数按 0 处理（时钟回拨等异常不该变成「欠费」）
     */
    public static Snapshot compute(int limitMinutes, long usedSeconds) {
        long used = Math.max(0L, usedSeconds);
        if (limitMinutes <= 0) {
            return new Snapshot(false, 0L, used, 0L, false, 0);
        }
        long limit = limitMinutes * 60L;
        long remaining = Math.max(0L, limit - used);
        boolean exhausted = remaining <= 0L;
        int percent = exhausted ? 0 : (int) Math.round(remaining * 100.0d / limit);
        if (percent < 0) percent = 0;
        if (percent > 100) percent = 100;
        return new Snapshot(true, limit, used, remaining, exhausted, percent);
    }

    /**
     * 一句话说清今天的额度。三种情况分开说，不合并：
     * 没设额度 / 已经用完 / 还剩多久。
     */
    public static String remainingText(int limitMinutes, long usedSeconds) {
        Snapshot s = compute(limitMinutes, usedSeconds);
        if (!s.hasLimit) {
            return "家长没有设置每日使用时长";
        }
        if (s.exhausted) {
            return "今天的时长已经用完，明天重新开始";
        }
        return "今天还剩 " + JsonUtils.humanizeDuration(s.remainingSeconds * 1000L);
    }

    /** 额度的副标题：已用多久 / 一共多少（没设额度时给出解释而不是「0 分钟」）。 */
    public static String usageText(int limitMinutes, long usedSeconds) {
        Snapshot s = compute(limitMinutes, usedSeconds);
        if (!s.hasLimit) {
            return "没有限制时，家长可以在家长端设置每天可用多久";
        }
        return "今天已用 " + JsonUtils.humanizeDuration(s.usedSeconds * 1000L)
                + "，额度 " + JsonUtils.humanizeDuration(s.limitSeconds * 1000L);
    }
}
