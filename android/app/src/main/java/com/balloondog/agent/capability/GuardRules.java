package com.balloondog.agent.capability;

import com.balloondog.agent.model.AppLimitRule;
import com.balloondog.agent.model.ModeConfig;
import com.balloondog.agent.model.PluginRule;

import java.util.Arrays;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
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
     * 应用插件规则匹配 —— 判「这一屏是入口、还是已经进了功能页、还是只是正文里提了一嘴」。
     *
     * <h3>两种拦截，两种后果</h3>
     * 命中时返回的决定带 {@link GuardDecision#entry}：
     * <ul>
     *   <li>{@code entry == true}：命中的是**入口行**（发现页上的「朋友圈」那一行）。
     *       只该吃掉这一次点击，<b>不能</b>弹「应用被禁止使用」整屏页 —— 否则孩子连同一页上
     *       家长允许的「扫一扫」都进不去，而家长以为自己只关了朋友圈。</li>
     *   <li>{@code entry == false}：孩子已经在**功能页**里（页面标题就是那个功能名），
     *       这时才该整屏拦下来。</li>
     * </ul>
     *
     * <p>只按文本 contains 匹配（不做分词、不做正则）是有意为之：无障碍读到的文本本身
     * 就可能带换行、省略号与噪声，规则宽松一点宁可漏拦，也好过把孩子正常聊天判成违规。
     *
     * @param windowTitle 当前窗口标题（{@code AccessibilityWindowInfo.getTitle()}，可能为 null）
     * @param nodes       当前窗口的可见文本节点，见 {@link WindowNode}
     * @return 命中的拦截决定；null 表示放行
     */
    public static GuardDecision matchPluginRules(List<PluginRule> rules, String pkg,
                                                 String windowTitle, List<WindowNode> nodes) {
        if (rules == null || rules.isEmpty()) return null;
        if (pkg == null || pkg.isEmpty()) return null;
        if (nodes == null || nodes.isEmpty()) return null;

        String lowerTitle = lower(windowTitle);

        for (PluginRule rule : rules) {
            if (!pkg.equals(rule.packageName)) continue;
            if (rule.enabled) continue; // 家长允许，跳过

            String reason = "该功能已被家长关闭（" + rule.label() + "）";

            // ① 页面内标志物：整窗任意位置比对。「确认支付」「请输入支付密码」这类串本身
            //    就说明正在做这件事，出现在哪儿都算 —— 但这类串必须辨识度足够，
            //    放弱词（如「支付」）就会把聊天里提一句也判成违规。
            for (WindowNode node : nodes) {
                if (node == null || node.text == null || node.text.isEmpty()) continue;
                for (String marker : rule.anywhereTexts) {
                    if (contains(lower(node.text), marker)) {
                        return new GuardDecision(reason, rule.key, false);
                    }
                }
            }

            // ② 功能页：窗口标题就是功能名，或者顶部标题条上有个不可点击的标题文本。
            //    限定「不可点击 + 不在列表里 + 在顶部」，是为了不把列表行内部的 TextView
            //    （自己不可点击、但整行可点击）和聊天正文当成了页面标题。
            for (String pageText : rule.pageTexts) {
                if (contains(lowerTitle, pageText)) {
                    return new GuardDecision(reason, rule.key, false);
                }
            }
            for (WindowNode node : nodes) {
                if (node == null || node.text == null || node.text.isEmpty()) continue;
                if (node.clickable || node.inList || !node.topStrip) continue;
                for (String pageText : rule.pageTexts) {
                    if (contains(lower(node.text), pageText)) {
                        return new GuardDecision(reason, rule.key, false);
                    }
                }
            }

            // ③ 入口：可点击的列表行。走到这里说明孩子还没进功能页（否则①②已经返回），
            //    所以这次命中的是「门」而不是「房间」。
            for (WindowNode node : nodes) {
                if (node == null || node.text == null || node.text.isEmpty()) continue;
                if (!node.clickable) continue;
                for (String entryText : rule.entryTexts) {
                    if (contains(lower(node.text), entryText)) {
                        return new GuardDecision(reason, rule.key, true);
                    }
                }
            }
        }
        return null;
    }

    private static String lower(String value) {
        return value == null ? "" : value.toLowerCase(Locale.US);
    }

    private static boolean contains(String lowerHaystack, String needle) {
        if (lowerHaystack == null || lowerHaystack.isEmpty()) return false;
        if (needle == null || needle.isEmpty()) return false;
        return lowerHaystack.contains(needle.toLowerCase(Locale.US));
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

    /**
     * 应用限时匹配（家长给单个应用定的每日分钟数）。
     *
     * <p>调用顺序上排在 {@link #matchStudyMode} <b>之后</b>：学习模式是「这一屏根本不许用」，
     * 限时是「用超了」，前者语义更强，先命中的原因对孩子也更好理解。
     *
     * @param usageSeconds 今日逐应用前台秒数（包名 → 秒）。缺项按 0 处理 ——
     *                     拿不到用量统计时宁可漏拦，也不要误拦「还没用过的应用」。
     * @param isLaunchable 只有「有桌面入口的普通应用」才拦，与学习模式同一套判据
     * @param isHome       桌面永远不拦
     * @return 拦截决定；null 表示放行
     */
    public static GuardDecision matchAppLimit(List<AppLimitRule> rules,
                                              Map<String, Integer> usageSeconds,
                                              boolean isLaunchable, boolean isHome, String pkg) {
        if (rules == null || rules.isEmpty()) return null;
        if (pkg == null || pkg.isEmpty()) return null;

        // 与学习模式同样的安全底线：桌面/系统界面/电话绝不能因为限额被拦成砖
        if (!isLaunchable) return null;
        if (isHome) return null;
        if (ALWAYS_ALLOWED.contains(pkg)) return null;

        AppLimitRule matched = null;
        for (AppLimitRule rule : rules) {
            if (pkg.equals(rule.packageName)) {
                matched = rule;
                break;
            }
        }
        if (matched == null) return null;
        if (matched.dailyLimitMinutes <= 0) return null;

        int usedSeconds = 0;
        if (usageSeconds != null) {
            Integer value = usageSeconds.get(pkg);
            if (value != null) usedSeconds = value;
        }
        int limitSeconds = matched.dailyLimitMinutes * 60;
        if (usedSeconds < limitSeconds) return null;

        return new GuardDecision(matched.displayName() + " 今日 " + matched.dailyLimitMinutes
                + " 分钟已用完", null);
    }

    /** 拦截决定。 */
    public static final class GuardDecision {
        /** 需要拦截时非 null，内容是人话原因（会写进设备事件，家长端能看到）。 */
        public final String reason;
        /** 命中的插件键；学习模式 / 应用限时拦截时为 null。 */
        public final String pluginKey;
        /**
         * 只对插件管控有意义：true = 命中的是**入口行**（该吃掉一次点击，不弹整屏页），
         * false = 已进入功能页 / 或学习模式、应用限时这类整屏拦截。
         */
        public final boolean entry;

        GuardDecision(String reason, String pluginKey) {
            this(reason, pluginKey, false);
        }

        GuardDecision(String reason, String pluginKey, boolean entry) {
            this.reason = reason;
            this.pluginKey = pluginKey;
            this.entry = entry;
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
