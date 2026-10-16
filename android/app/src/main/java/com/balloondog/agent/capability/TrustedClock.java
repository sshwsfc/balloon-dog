package com.balloondog.agent.capability;

import android.os.SystemClock;

import androidx.annotation.Nullable;

import java.text.ParsePosition;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.TimeZone;

/**
 * 抗篡改的时钟：判定「现在几点」不再直接信系统墙钟。
 *
 * <h3>它防的是什么</h3>
 *
 * <p>设备端所有时间判定（定时锁屏、屏幕时间额度、护眼计时、答题奖励有效期）原来都走
 * {@code System.currentTimeMillis()}。设备所有者时 {@code DISALLOW_CONFIG_DATE_TIME} 挡住了
 * 系统设置改时间，但**非设备所有者时没有任何兜底** —— 孩子把时间调回昨天，定时锁屏立刻失效，
 * 而且家长端看不出来（设备依旧在线、依旧「已锁定」）。
 *
 * <h3>怎么做的</h3>
 *
 * <p>以 {@link SystemClock#elapsedRealtime()} 为基准：它从开机起单调递增，<b>改墙钟不会动它</b>，
 * 也不能被普通应用改写。每次心跳服务端都会回一个权威的 {@code serverTime}，用它算出一个偏移量：
 *
 * <pre>
 *   offset = serverTime − elapsedRealtime     // 心跳那一刻锚定
 *   now()  = elapsedRealtime + offset         // 之后的「可信现在」
 *   skew   = wallClock − serverTime           // 设备墙钟比服务端快/慢多少
 * </pre>
 *
 * <p>两次心跳之间 {@code skew} 只可能因为「有人改了设备时间」而跳变（服务端时间与开机时长
 * 都在正常前进），所以 {@code |Δskew| > JUMP_THRESHOLD_MS} 就是一次可疑的改时间动作：
 * {@link #sync} 会返回 true，由调用方（{@code AgentService.doHeartbeat}）记一条 {@code tamper}
 * 事件并立刻补一次健康上报，把 {@code clockSkewSeconds} 送到家长端。
 *
 * <p>这个类<b>刻意不依赖 EventLog</b>：它只做时间数学，不产生副作用 —— 否则就没法在普通
 * JVM 上逐条钉死「墙钟被调回去之后 {@link #now()} 一步都不动」这类关键性质（见
 * {@code android/scripts/crosstest/PureLogicCheck.java}）。
 *
 * <h3>诚实的边界</h3>
 *
 * <p>这只是「发现并如实上报」，不是「阻止」：非设备所有者时我们无法禁止改时间。
 * 另外长轮询/心跳断掉期间 {@code elapsedRealtime} 仍然在走（它不受 Doze 影响），
 * 所以 offset 的有效期只受「设备重启」限制 —— 重启后 {@code elapsedRealtime} 归零，
 * 此时 {@link #isAnchored()} 变 false，调用方应退回墙钟并尽快等下一次心跳重新锚定。
 */
public final class TrustedClock {

    /** 两次心跳之间 skew 变化超过这个值就判定「有人改过时间」。 */
    public static final long JUMP_THRESHOLD_MS = 60_000L;

    private static final Object LOCK = new Object();

    /** serverTime − elapsedRealtime（毫秒）。未锚定时为 0。 */
    private static volatile long offsetMs = 0L;
    /** 设备墙钟 − 服务端时间（毫秒）。正数表示设备时间偏快。 */
    private static volatile long skewMs = 0L;
    /** 是否已经用服务端时间锚定过，且开机时长没有归零。 */
    private static volatile boolean anchored = false;
    /** 锚定时的 elapsedRealtime：用来识别「设备重启了」（重启后当前值会比它小）。 */
    private static volatile long anchoredAtElapsed = 0L;
    /** 累计检出改时间的次数。 */
    private static volatile int jumpCount = 0;

    private TrustedClock() {
    }

    /**
     * 时间源替身。<b>只有 JVM 交叉验证会替换它</b>（{@code PureLogicCheck}）：
     * 那两个系统调用在普通 JVM 上不存在，而其语义（单调 / 可被改）又正是被测对象的一部分。
     */
    public interface TimeSource {
        long elapsedRealtime();

        long wallMillis();
    }

    private static volatile TimeSource source = new TimeSource() {
        @Override
        public long elapsedRealtime() {
            return SystemClock.elapsedRealtime();
        }

        @Override
        public long wallMillis() {
            return System.currentTimeMillis();
        }
    };

    /** 仅供 JVM 交叉验证：换掉时间源并清空锚定状态。生产代码永远不要调用。 */
    public static void setSourceForTest(TimeSource replacement) {
        synchronized (LOCK) {
            source = replacement;
            offsetMs = 0L;
            skewMs = 0L;
            anchored = false;
            anchoredAtElapsed = 0L;
            jumpCount = 0;
        }
    }

    /** 仅供 JVM 交叉验证：还原系统时间源。 */
    public static void resetForTest() {
        setSourceForTest(new TimeSource() {
            @Override
            public long elapsedRealtime() {
                return SystemClock.elapsedRealtime();
            }

            @Override
            public long wallMillis() {
                return System.currentTimeMillis();
            }
        });
    }

    /**
     * 用服务端回的权威时间锚定一次。心跳里调到即可，开销只有一次时间解析。
     *
     * @param serverTimeIso 服务端 {@code serverTime} 字段（ISO8601）
     * @return 本次是否检测到「设备时间被改动」
     */
    public static boolean sync(@Nullable String serverTimeIso) {
        Long serverMillis = parseIso(serverTimeIso);
        if (serverMillis == null) return false;

        long elapsed = source.elapsedRealtime();
        long wall = source.wallMillis();
        long newSkew = wall - serverMillis;
        boolean jumped = false;

        synchronized (LOCK) {
            boolean hadAnchor = anchored && elapsed >= anchoredAtElapsed;
            if (hadAnchor && Math.abs(newSkew - skewMs) > JUMP_THRESHOLD_MS) {
                jumped = true;
                jumpCount++;
            }
            offsetMs = serverMillis - elapsed;
            skewMs = newSkew;
            anchored = true;
            anchoredAtElapsed = elapsed;
        }
        return jumped;
    }

    /**
     * 可信的「现在」。
     *
     * <p>没锚定（刚开机、还没成功心跳过）时退回系统墙钟 —— 此时我们没有任何权威参照，
     * 编一个值出来只会让家长端更困惑。
     */
    public static long now() {
        return isAnchored() ? source.elapsedRealtime() + offsetMs : source.wallMillis();
    }

    /**
     * 设备墙钟与服务器时间的差（毫秒）。
     *
     * <p>{@link #isAnchored()} 为 false 时返回 0：没锚定就说不清差多少，
     * 报一个假数字会让家长端显示一条假警报。
     */
    public static long skewMs() {
        return isAnchored() ? skewMs : 0L;
    }

    /** 上报给服务端的 {@code clockSkewSeconds}。 */
    public static long skewSeconds() {
        return skewMs() / 1000L;
    }

    /**
     * 是否已经锚定。
     *
     * <p>{@link #now()} / {@link #skewMs()} 都用这一个条件 —— 开机时长比锚点时更小意味着
     * 设备重启过（{@code elapsedRealtime()} 归零），此时旧 offset 已经没有意义，
     * 必须和未锚定一样退回墙钟，而不是拿一个过期锚点算出一个past 的时间。
     */
    public static boolean isAnchored() {
        return anchored && source.elapsedRealtime() >= anchoredAtElapsed;
    }

    /** 累计检出「时间被改动」的次数，供健康上报与排查用。 */
    public static int jumpCount() {
        return jumpCount;
    }

    /** 需要判定「现在是否在某个时间段内」的地方统一走这个，而不是 System.currentTimeMillis()。 */
    public static Date nowDate() {
        return new Date(now());
    }

    private static Long parseIso(@Nullable String iso) {
        if (iso == null || iso.isEmpty()) return null;
        SimpleDateFormat fmt = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSSXXX", Locale.US);
        fmt.setTimeZone(TimeZone.getTimeZone("UTC"));
        Date parsed = fmt.parse(iso, new ParsePosition(0));
        if (parsed != null) return parsed.getTime();
        // 不带毫秒的变体（服务端 new Date().toISOString() 一定有毫秒，这里只是兜底）
        SimpleDateFormat plain = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ssXXX", Locale.US);
        plain.setTimeZone(TimeZone.getTimeZone("UTC"));
        Date fallback = plain.parse(iso, new ParsePosition(0));
        return fallback == null ? null : fallback.getTime();
    }
}
