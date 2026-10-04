package com.balloondog.agent.capability;

import com.balloondog.agent.model.ModeConfig;
import com.balloondog.agent.model.PluginRule;

import java.util.Arrays;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;

/**
 * 学习模式 / 应用插件管控的**判定规则**。
 *
 * <p>这个类刻意<b>不 import 任何 Android 类</b>：判定逻辑有一套容易写错、
 * 又很难在模拟器上复现的业务规则（模拟器里并没有装微信），所以它被设计成纯函数，
 * 由 {@code android/scripts/crosstest/GuardCheck.java} 在普通 JVM 上逐条覆盖。
 * 需要 Context / 存储的部分留在 {@link AccessibilityGuard} 里做编排。
 */
public final class GuardRules {

    /**
     * 学习模式下**永远放行**的系统包。
     *
     * <p>这不是功能取舍而是安全底线：把桌面、系统界面、输入法、电话拦掉，
     * 手机会立刻变成一块砖 —— 连紧急呼叫都打不出去。
     */
    private static final Set<String> ALWAYS_ALLOWED = new HashSet<>(Arrays.asList(
            "com.android.systemui",
            "com.android.settings",
            "com.android.phone",
            "com.android.server.telecom",
            "com.android.incallui",
            "com.android.dialer",
            "com.android.emergency",
            "com.android.emergencyinfo",
            "com.android.permissioncontroller",
            "com.google.android.permissioncontroller",
            "android"
    ));

    private GuardRules() {
    }

    /** 只读暴露放行清单，供验证脚本断言（不是给业务代码用的）。 */
    public static Set<String> alwaysAllowedPackages() {
        return Collections.unmodifiableSet(ALWAYS_ALLOWED);
    }

    /**
     * 应用插件规则匹配。
     *
     * @param windowText 当前窗口的可见文本（未小写化也可以，这里统一处理）
     * @return 命中的拦截决定；null 表示放行
     */
    public static GuardDecision matchPluginRules(List<PluginRule> rules, String pkg, String windowText) {
        if (rules == null || rules.isEmpty()) return null;
        if (pkg == null || pkg.isEmpty()) return null;
        if (windowText == null || windowText.isEmpty()) return null;

        String lower = windowText.toLowerCase(Locale.US);
        for (PluginRule rule : rules) {
            if (!pkg.equals(rule.packageName)) continue;
            if (rule.enabled) continue; // 家长允许，跳过

            for (String keyword : rule.keywords) {
                if (keyword == null || keyword.isEmpty()) continue;
                if (lower.contains(keyword.toLowerCase(Locale.US))) {
                    return new GuardDecision("该功能已被家长关闭（" + keyword + "）", rule.key);
                }
            }
        }
        return null;
    }

    /**
     * 学习模式匹配。
     *
     * @param isLaunchable 该包是否是「有桌面入口的普通应用」——只有这种才拦
     * @param isHome       该包是否是当前桌面
     * @return 拦截决定；null 表示放行
     */
    public static GuardDecision matchStudyMode(ModeConfig config, boolean isLaunchable,
                                               boolean isHome, String pkg, long now) {
        if (!StudyModeEngine.isStudy(config, now)) return null;
        if (pkg == null || pkg.isEmpty()) return null;

        // 只拦「可启动的普通应用」。系统组件一律放行 —— 见 ALWAYS_ALLOWED 的说明。
        if (!isLaunchable) return null;
        if (isHome) return null; // 桌面绝不能被拦
        if (ALWAYS_ALLOWED.contains(pkg)) return null;

        if (config.studyApps.contains(pkg)) return null;

        return new GuardDecision("学习模式中，该应用不在允许清单里", null);
    }

    /** 拦截决定。 */
    public static final class GuardDecision {
        /** 需要拦截时非 null，内容是人话原因（会写进设备事件，家长端能看到）。 */
        public final String reason;
        /** 命中的插件键；学习模式拦截时为 null。 */
        public final String pluginKey;

        GuardDecision(String reason, String pluginKey) {
            this.reason = reason;
            this.pluginKey = pluginKey;
        }

        public boolean blocked() {
            return reason != null;
        }
    }

    /**
     * 把界面文本压成一行便于 contains 匹配。
     *
     * <p>刻意不做分词、不做正则：无障碍读到的文本本来就可能带换行与省略号，
     * 简单地拼接并去掉换行，比引入一套规则更不容易出意外。
     */
    public static String flatten(CharSequence... parts) {
        StringBuilder sb = new StringBuilder();
        for (CharSequence part : parts) {
            if (part == null) continue;
            sb.append(part).append(' ');
        }
        return sb.toString().replace('\n', ' ');
    }
}
