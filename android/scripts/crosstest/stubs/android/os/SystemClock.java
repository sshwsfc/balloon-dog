package android.os;

/**
 * 交叉验证用的 {@link SystemClock} 桩。
 *
 * <p>和 {@code stubs/android/util/Log} 一样，这里的方法是空实现 —— 但原因不同，值得写清楚：
 * 被测的 {@code capability/TrustedClock.java} <b>只</b>在「生产时间源」里引用
 * {@code SystemClock.elapsedRealtime()}，而 JVM 用例做的第一件事就是
 * {@code TrustedClock.setSourceForTest(...)} 把它换掉。也就是说这个桩的返回值
 * <b>永远不会被任何断言读到</b>：读到的都是替身时间源。
 *
 * <p>它存在的唯一理由是让 {@code TrustedClock.java} 能编译（javac 需要一个符号），
 * 所以只覆盖 {@code elapsedRealtime()} / {@code uptimeMillis()}。
 * 一旦有人往 TrustedClock 里加别的 {@code SystemClock} 调用，javac 会立刻报错，
 * 不会静默放过 —— 这与 {@code Log} 桩的取舍一致。
 *
 * <p>为什么不干脆用真值：普通 JVM 上没有 {@code android.os}，而「单调时钟不随改墙钟变化」
 * 这条性质正是被测对象本身；用替身时间源显式驱动它，比依赖真机的开机时长可信得多。
 */
public final class SystemClock {

    private SystemClock() {
    }

    public static long elapsedRealtime() {
        return 0L;
    }

    public static long uptimeMillis() {
        return 0L;
    }
}
