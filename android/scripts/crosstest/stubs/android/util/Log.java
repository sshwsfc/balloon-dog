package android.util;

/**
 * 交叉验证用的 logcat 桩。
 *
 * <p>与 {@code stubs/org/json} 那两个桩不同，这里的方法<b>刻意什么都不做</b>，
 * 原因值得写下来：
 *
 * <ul>
 *   <li>JSON 桩之所以一律抛异常，是因为它们的<b>返回值会被业务逻辑消费</b> ——
 *       一个「悄悄返回 null」的桩会让被测代码算出一个错误但看不出来的结果。</li>
 *   <li>{@code Log} 的方法<b>全部返回 void</b>，没有任何逻辑会读到它。
 *       所以空实现不可能掩盖真实差异，抛异常反而会误伤 ——
 *       「丢弃一条限额规则」这条路径在交叉验证里是会被正常走到的。</li>
 * </ul>
 *
 * <p>这个桩是为了让 {@code model/AppLimitRule.java} 能被 {@code run.sh} 第 5、6 步编译
 * （{@code GuardRules} 引用了它，见 run.sh 里的注释）。它只覆盖日志级别方法，
 * 不覆盖任何真正有行为的东西 —— 一旦有人往被测代码里加别的 {@code android.util} 调用，
 * javac 仍会立刻报错，不会静默放过。
 */
public final class Log {

    private Log() {
    }

    public static int v(String tag, String msg) {
        return 0;
    }

    public static int v(String tag, String msg, Throwable tr) {
        return 0;
    }

    public static int d(String tag, String msg) {
        return 0;
    }

    public static int d(String tag, String msg, Throwable tr) {
        return 0;
    }

    public static int i(String tag, String msg) {
        return 0;
    }

    public static int i(String tag, String msg, Throwable tr) {
        return 0;
    }

    public static int w(String tag, String msg) {
        return 0;
    }

    public static int w(String tag, String msg, Throwable tr) {
        return 0;
    }

    public static int w(String tag, Throwable tr) {
        return 0;
    }

    public static int e(String tag, String msg) {
        return 0;
    }

    public static int e(String tag, String msg, Throwable tr) {
        return 0;
    }

    public static String getStackTraceString(Throwable tr) {
        return "";
    }
}
