package com.balloondog.agent.capability;

import com.balloondog.agent.model.ModeConfig;

import java.util.Calendar;

/**
 * 「此刻是不是学习模式」的**本地**求值。
 *
 * <p>为什么一定要在设备端算：学习模式决定孩子现在能不能用手机。
 * 如果判定依赖服务端，孩子拔网线、进飞行模式就绕过了 —— 那这个功能等于没有。
 * 所以服务端把规则原样下发，这里本地判定。
 *
 * <h3>与服务端保持一致</h3>
 * 服务端 {@code mode.service.ts} 的 {@code evaluateMode} 是同一套逻辑。
 * 两边不一致会出现最让人困惑的那种错位：家长端显示「普通模式」，孩子手机却在学习模式。
 * 因此有 {@code server/scripts/crosscheck-mode.mjs} 逐点比对两边的结果。
 *
 * <p>时区口径：两端都用**各自的本地时区**（服务端用服务器时区，设备端用手机时区）。
 * 这是现有作息时间表就采用的口径，一致性由「家长与孩子通常在同一时区」这个前提保证；
 * 跨时区的边界情况在 README 里如实写明。
 */
public final class StudyModeEngine {

    public static final String STUDY = "study";
    public static final String NORMAL = "normal";

    private StudyModeEngine() {
    }

    /**
     * 求值规则（与服务端逐条对应）：
     * <ol>
     *   <li>{@code manualMode} 非空 → 手动模式优先，时段规划不参与；</li>
     *   <li>否则若开启时段规划：一格都没选 → <b>全天学习模式</b>；否则命中格子为学习模式；</li>
     *   <li>其余 → 普通模式。</li>
     * </ol>
     */
    public static String evaluate(ModeConfig config, long nowMillis) {
        if (config == null) return NORMAL;

        if (STUDY.equals(config.manualMode)) return STUDY;
        if (NORMAL.equals(config.manualMode)) return NORMAL;

        if (!config.scheduleEnabled) return NORMAL;
        if (config.slots.isEmpty()) return STUDY;

        Calendar c = Calendar.getInstance();
        c.setTimeInMillis(nowMillis);
        // Calendar.DAY_OF_WEEK: 周日=1 … 周六=7；项目约定的 0=周日，因此减 1
        int dayOfWeek = c.get(Calendar.DAY_OF_WEEK) - 1;
        int hour = c.get(Calendar.HOUR_OF_DAY);

        for (ModeConfig.Slot s : config.slots) {
            if (s.dayOfWeek == dayOfWeek && s.hour == hour) return STUDY;
        }
        return NORMAL;
    }

    public static boolean isStudy(ModeConfig config, long nowMillis) {
        return STUDY.equals(evaluate(config, nowMillis));
    }
}
