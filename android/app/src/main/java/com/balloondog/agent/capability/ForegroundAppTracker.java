package com.balloondog.agent.capability;

import androidx.annotation.Nullable;

import java.util.ArrayList;
import java.util.List;

/**
 * 前台应用追踪。
 *
 * <p>由无障碍看门狗（{@link com.balloondog.agent.service.LockWatchdogService}）在每次
 * 窗口变化时写入。它的用途是给周期截屏的每一帧<b>标注当时的前台应用包名</b>。
 *
 * <h3>为什么值得单独做</h3>
 * 「这段时间在用什么 app」如果只靠 AI 看画面去猜包名，既不准也没必要 ——
 * 系统本来就知道前台是谁。带上包名之后：
 * <ul>
 *   <li>AI 的 prompt 里多了一个强提示，识别准确率明显更高；</li>
 *   <li>没有配置 AI 时，启发式降级也能给出「主要在王者荣耀待了 40 分钟」这种有价值的结论；</li>
 *   <li>家长端的时间线可以直接显示应用名，不必等 AI 逐张识别。</li>
 * </ul>
 *
 * <h3>为什么不用 UsageStatsManager</h3>
 * 那需要 {@code PACKAGE_USAGE_STATS} 这个「使用情况访问」特殊权限，
 * 要在系统设置里单独授权，而且拿到的是聚合统计而不是「此刻前台是谁」。
 * 既然已经为了防绕过装了无障碍服务，直接复用它更省一次授权。
 *
 * <p>环形缓冲只保留最近 {@link #CAPACITY} 条记录：截图最多间隔几分钟，
 * 留太多没有意义，还会一直占着内存。
 */
public final class ForegroundAppTracker {

    /** 保留多少条历史。按每分钟十几条窗口变化算，50 条足够覆盖几分钟。 */
    private static final int CAPACITY = 50;

    private static final Object LOCK = new Object();
    private static final List<Entry> HISTORY = new ArrayList<>();

    private ForegroundAppTracker() {
    }

    static final class Entry {
        final String packageName;
        final long at;

        Entry(String packageName, long at) {
            this.packageName = packageName;
            this.at = at;
        }
    }

    /** 无障碍服务每次收到窗口事件时调用。 */
    public static void record(String packageName) {
        if (packageName == null || packageName.isEmpty()) return;
        synchronized (LOCK) {
            Entry last = HISTORY.isEmpty() ? null : HISTORY.get(HISTORY.size() - 1);
            // 连续同一个包不重复记：窗口内容变化事件很密集，全记会把缓冲冲掉
            if (last != null && last.packageName.equals(packageName)) {
                return;
            }
            HISTORY.add(new Entry(packageName, System.currentTimeMillis()));
            while (HISTORY.size() > CAPACITY) {
                HISTORY.remove(0);
            }
        }
    }

    /**
     * 查询某个时刻的前台应用。
     *
     * <p>返回「不晚于该时刻的最近一条」记录 —— 截图发生在 T，
     * 而最后一次窗口变化可能稍早于 T，取之前的那条才是对的。
     *
     * @return 包名；没有可用记录时返回 null
     */
    @Nullable
    public static String packageAt(long timestamp) {
        synchronized (LOCK) {
            Entry best = null;
            for (Entry entry : HISTORY) {
                if (entry.at <= timestamp) {
                    best = entry;
                } else {
                    break;
                }
            }
            // 该时刻之前没有记录（比如刚开机）就退而取最早的一条，总比没有强
            if (best == null && !HISTORY.isEmpty()) {
                best = HISTORY.get(0);
            }
            return best == null ? null : best.packageName;
        }
    }

    /** 最近一次已知的前台应用。 */
    @Nullable
    public static String latest() {
        synchronized (LOCK) {
            return HISTORY.isEmpty() ? null : HISTORY.get(HISTORY.size() - 1).packageName;
        }
    }

    /** 清空（设备身份重置、家长关闭截屏时调用）。 */
    public static void clear() {
        synchronized (LOCK) {
            HISTORY.clear();
        }
    }
}
