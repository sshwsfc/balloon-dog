package com.balloondog.agent.capability;

import android.content.Context;

import com.balloondog.agent.data.AgentStore;

/**
 * 学习模式 / 应用插件管控 / 应用限时在无障碍服务里的**编排**部分。
 *
 * <p>它只负责四件事：取规则与今日用量（{@link AgentStore}）、查「这个包是不是可启动应用」
 * （{@link AppInventory}）、拼出当前窗口的可见文本、按固定顺序串起三个判定。
 * 真正的判定在 {@link GuardRules} 里 —— 那个类没有任何 Android 依赖，
 * 因此可以被逐条测试（模拟器上没有微信，端到端复现不出插件拦截的场景）。
 *
 * <p>判定顺序（先命中先返回）：插件管控 → 学习模式 → 应用限时。
 * 学习模式优先于限时，是因为「这一屏根本不许用」比「用超了」语义更强。
 *
 * <h3>这套机制的边界（如实告知，见 android/README.md）</h3>
 * <ul>
 *   <li><b>按可见文本匹配</b>：应用改版改了文案就会漏拦。所以规则给的是
 *       <b>一组</b>候选词而不是一条精确文本，且由服务端随配置下发，便于集中修正。</li>
 *   <li><b>只能拦界面，拦不住内容</b>：WebView、游戏画布里的东西看不见。</li>
 *   <li><b>有延迟</b>：无障碍事件到达、判定的耗时约几百毫秒，快速滑动可能闪过一帧。</li>
 *   <li><b>关掉无障碍权限即失效</b> —— 但关权限本身会被看门狗与设备所有者限制挡住。</li>
 * </ul>
 */
public final class AccessibilityGuard {

    private AccessibilityGuard() {
    }

    /**
     * 判定当前这一屏该不该拦。
     *
     * @param pkg        前台包名
     * @param windowText 当前窗口的可见文本
     * @param now        当前时间（毫秒），学习模式求值要用
     * @return 拦截决定；null 表示放行
     */
    public static GuardRules.GuardDecision check(AgentStore store, AppInventory inventory,
                                                 Context context, String pkg,
                                                 String windowText, long now) {
        if (pkg == null || pkg.isEmpty()) return null;

        // 本应用自己的界面（锁定页 / 答题页 / 设置页 / 应急解锁）永远放行，
        // 否则孩子一被拦就再也点不到「应急解锁」了。
        if (pkg.equals(context.getPackageName())) return null;

        GuardRules.GuardDecision plugin =
                GuardRules.matchPluginRules(store.getPluginRules(), pkg, windowText);
        if (plugin != null) return plugin;

        GuardRules.GuardDecision study = GuardRules.matchStudyMode(store.getModeConfig(),
                inventory.isLaunchable(pkg), inventory.isHome(pkg), pkg, now);
        if (study != null) return study;

        // 应用限时排在学习模式之后（契约 §4）：先判「这一屏根本不许用」，再判「用超了」。
        // 用量从 AgentStore 读缓存 —— 无障碍事件每秒都会来，这里绝不能去查 UsageStatsManager。
        // 缓存由 AgentService 的 ticker 定期刷新（见 AppUsageTracker）。
        return GuardRules.matchAppLimit(store.getAppLimitRules(), store.getAppUsageToday(),
                inventory.isLaunchable(pkg), inventory.isHome(pkg), pkg);
    }

    /** 供设置页展示：当前是不是学习模式。 */
    public static boolean isStudyNow(AgentStore store) {
        return StudyModeEngine.isStudy(store.getModeConfig(), System.currentTimeMillis());
    }

    /** 把界面文本压成一行便于 contains 匹配（转发到 {@link GuardRules#flatten}）。 */
    public static String flatten(CharSequence... parts) {
        return GuardRules.flatten(parts);
    }
}
