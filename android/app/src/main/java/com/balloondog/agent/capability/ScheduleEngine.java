package com.balloondog.agent.capability;

import androidx.annotation.Nullable;

import com.balloondog.agent.model.ScheduleRule;

import java.util.Calendar;
import java.util.List;
import java.util.Locale;

/**
 * 定时锁屏 / 定时解锁的本地求值引擎 —— 与后端 {@code schedule.service.ts} 同一套语义。
 *
 * <p><b>为什么设备端要自己算一遍，而不是直接听服务端的「现在该锁」？</b>
 * 因为锁屏必须在断网时也照常生效。孩子把 WiFi 关掉、或者后端挂了，
 * 作息表如果依赖服务端就成了摆设。所以规则随 {@code /agent/config} 下发到本地，
 * 之后完全由本地时钟驱动。
 *
 * <p>这也意味着两边必须严格一致，规则因此被刻意设计得足够简单：
 * <ol>
 *   <li>命中任意一条启用的 {@code unlock} 规则 → 允许使用；</li>
 *   <li>否则命中任意一条启用的 {@code lock} 规则 → 锁定；</li>
 *   <li>都没命中 → 时间表不锁定。</li>
 * </ol>
 * {@code unlock} 优先于 {@code lock}，「整晚锁定 + 中午放行」因此可以直接叠加表达。
 *
 * <p><b>时钟以设备本地时间为准</b>：家长说的「22:00」是孩子设备上的 22:00。
 * 后端返回的那份 preview 只是按服务器时间算的参考值，两者在跨时区部署时可能不同，
 * 最终以设备为准。
 */
public final class ScheduleEngine {

    private static final int MINUTES_PER_DAY = 1440;
    private static final int DAYS_PER_WEEK = 7;

    private ScheduleEngine() {
    }

    /** 一次求值的结果。 */
    public static final class Decision {
        public final boolean locked;
        @Nullable
        public final ScheduleRule rule;

        Decision(boolean locked, @Nullable ScheduleRule rule) {
            this.locked = locked;
            this.rule = rule;
        }

        public String ruleName() {
            if (rule == null) return null;
            return rule.name == null || rule.name.isEmpty() ? null : rule.name;
        }
    }

    /** 下一次状态发生变化的时刻。 */
    public static final class Boundary {
        public final long atMillis;
        /** 变化之后是否处于锁定态。 */
        public final boolean locked;
        @Nullable
        public final String ruleName;

        Boundary(long atMillis, boolean locked, @Nullable String ruleName) {
            this.atMillis = atMillis;
            this.locked = locked;
            this.ruleName = ruleName;
        }
    }

    /**
     * 判断某条规则是否覆盖「星期 day + 当天第 minute 分钟」。
     *
     * <p>跨天规则要拆成两段看：例如「周五 22:00 → 07:00」实际覆盖
     * 周五 22:00–24:00 与 <b>周六</b> 00:00–07:00。
     * 只判断 start 那天是最常见的实现错误 —— 会导致周六早上的锁屏整个失效。
     */
    static boolean covers(ScheduleRule rule, int dayOfWeek, int minute) {
        if (rule.endMinute > rule.startMinute) {
            // 同一天内的区间，例如 08:00 → 12:00
            return rule.daysOfWeek.contains(dayOfWeek)
                    && minute >= rule.startMinute
                    && minute < rule.endMinute;
        }
        // 跨天：(a) start 当天，从 startMinute 到 24:00
        if (rule.daysOfWeek.contains(dayOfWeek) && minute >= rule.startMinute) return true;
        // (b) 次日，从 00:00 到 endMinute 之前 —— 注意这里看的是「前一天」是否在生效星期里
        int previousDay = (dayOfWeek + 6) % 7;
        return rule.daysOfWeek.contains(previousDay) && minute < rule.endMinute;
    }

    /** 对给定时刻求值。 */
    public static Decision evaluate(List<ScheduleRule> rules, long atMillis) {
        Calendar calendar = Calendar.getInstance();
        calendar.setTimeInMillis(atMillis);
        // Calendar.DAY_OF_WEEK: 周日=1 … 周六=7；项目约定的 0=周日，因此减 1
        int dayOfWeek = calendar.get(Calendar.DAY_OF_WEEK) - 1;
        int minute = calendar.get(Calendar.HOUR_OF_DAY) * 60 + calendar.get(Calendar.MINUTE);

        ScheduleRule unlockMatch = null;
        ScheduleRule lockMatch = null;
        for (ScheduleRule rule : rules) {
            if (!rule.enabled) continue;
            if (!covers(rule, dayOfWeek, minute)) continue;
            if (rule.isUnlock()) {
                if (unlockMatch == null) unlockMatch = rule;
            } else if (rule.isLock() && lockMatch == null) {
                lockMatch = rule;
            }
        }

        if (unlockMatch != null) return new Decision(false, unlockMatch);
        if (lockMatch != null) return new Decision(true, lockMatch);
        return new Decision(false, null);
    }

    /**
     * 找下一次状态翻转的时刻，用于「锁屏前倒计时预告」。
     *
     * <p>逐分钟向后扫描最多 7 天（10080 次纯整数比较，开销可忽略）。
     * 之所以不「直接取下一条规则的 startMinute」：unlock 规则的<b>结束</b>同样是一次状态变化，
     * 而且多条规则叠加时「下一条 start」根本不是答案。
     */
    @Nullable
    public static Boundary nextBoundary(List<ScheduleRule> rules, long fromMillis) {
        if (rules == null || rules.isEmpty()) return null;

        boolean current = evaluate(rules, fromMillis).locked;

        Calendar cursor = Calendar.getInstance();
        cursor.setTimeInMillis(fromMillis);
        // 对齐到整分钟，避免秒数导致边界抖动
        cursor.set(Calendar.SECOND, 0);
        cursor.set(Calendar.MILLISECOND, 0);

        for (int i = 0; i < DAYS_PER_WEEK * MINUTES_PER_DAY; i++) {
            cursor.add(Calendar.MINUTE, 1);
            Decision decision = evaluate(rules, cursor.getTimeInMillis());
            if (decision.locked != current) {
                return new Boundary(cursor.getTimeInMillis(), decision.locked, decision.ruleName());
            }
        }
        return null;
    }

    /** 「今天 22:00」「明天 07:00」这类中文短句，用于锁定页与倒计时窗。 */
    public static String describeBoundary(long atMillis, long nowMillis) {
        Calendar target = Calendar.getInstance();
        target.setTimeInMillis(atMillis);
        Calendar now = Calendar.getInstance();
        now.setTimeInMillis(nowMillis);

        String time = String.format(Locale.US, "%02d:%02d",
                target.get(Calendar.HOUR_OF_DAY), target.get(Calendar.MINUTE));

        int dayDelta = target.get(Calendar.DAY_OF_YEAR) - now.get(Calendar.DAY_OF_YEAR);
        if (target.get(Calendar.YEAR) != now.get(Calendar.YEAR)) {
            // 跨年时 DAY_OF_YEAR 没有可比性，直接按天数差算
            long diff = (atMillis - nowMillis) / 86_400_000L;
            dayDelta = (int) diff;
        }
        if (dayDelta == 0) return "今天 " + time;
        if (dayDelta == 1) return "明天 " + time;
        if (dayDelta == 2) return "后天 " + time;
        return (target.get(Calendar.MONTH) + 1) + "月" + target.get(Calendar.DAY_OF_MONTH) + "日 " + time;
    }
}
