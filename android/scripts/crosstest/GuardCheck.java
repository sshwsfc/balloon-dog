import com.balloondog.agent.capability.GuardRules;
import com.balloondog.agent.model.ModeConfig;
import com.balloondog.agent.model.PluginRule;

import java.util.*;

/**
 * 学习模式 / 插件管控「判定」部分的测试。
 *
 * <p>为什么用这种方式而不是模拟器端到端：这两套判定依赖应用界面上的**可见文本**，
 * 而模拟器里并没有装微信、QQ —— 端到端根本复现不出「朋友圈被打开」这个场景。
 * 与其写一条永远跑不到的端到端断言（等于没测），不如把判定抽成纯函数用合成界面逐条覆盖，
 * 再让端到端去验证「配置能下发、拦截链路能跑通」这两件事。
 *
 * <p>重点覆盖三类容易出人命的错误：
 * <ol>
 *   <li>把桌面 / systemui / 输入法拦掉 → 手机变砖；</li>
 *   <li>学习模式下把白名单应用也拦了 → 家长设了白名单却用不了；</li>
 *   <li>插件关键词匹配得上却没拦住（或反过来误伤）。</li>
 * </ol>
 */
public class GuardCheck {

    static int passed = 0;
    static int failed = 0;

    static void check(boolean cond, String msg) {
        if (cond) { passed++; System.out.println("  \u2713 " + msg); }
        else { failed++; System.out.println("  \u2717 " + msg); }
    }

    static PluginRule rule(String pkg, String key, boolean enabled, String... keywords) {
        return PluginRule.of(pkg, key, enabled, Arrays.asList(keywords));
    }

    public static void main(String[] args) {
        System.out.println("\n[学习模式判定]");

        int[][] mondaySlot = {{1, 8}};
        ModeConfig studyNow = ModeConfig.of(null, true, slots(mondaySlot),
                Arrays.asList("com.zhihu.android"));
        ModeConfig normalNow = ModeConfig.of("normal", false, Collections.<ModeConfig.Slot>emptyList(),
                Collections.<String>emptyList());

        long mondayAt8 = mondayAt(8);
        long mondayAt10 = mondayAt(10);

        // 1) 学习模式生效时的白名单与拦截
        check(GuardRules.matchStudyMode(studyNow, true, false, "com.zhihu.android", mondayAt8) == null,
                "白名单里的应用放行");
        check(GuardRules.matchStudyMode(studyNow, true, false, "com.tencent.mm", mondayAt8) != null,
                "不在白名单的可启动应用被拦");
        check(GuardRules.matchStudyMode(studyNow, true, false, "com.tencent.mm", mondayAt10) == null,
                "非学习时段不拦");

        // 2) 绝不能拦的东西
        check(GuardRules.matchStudyMode(studyNow, true, true, "com.google.android.apps.nexuslauncher", mondayAt8) == null,
                "桌面永远放行（拦了手机就没法用）");
        check(GuardRules.matchStudyMode(studyNow, true, false, "com.android.systemui", mondayAt8) == null,
                "systemui 永远放行");
        check(GuardRules.matchStudyMode(studyNow, true, false, "com.android.phone", mondayAt8) == null,
                "电话永远放行（安全底线：必须能打紧急电话）");
        check(GuardRules.matchStudyMode(studyNow, false, false, "com.example.service", mondayAt8) == null,
                "不可启动的系统组件不拦（不按包名黑名单去猜）");

        // 3) 普通模式不拦任何东西
        check(GuardRules.matchStudyMode(normalNow, true, false, "com.tencent.mm", mondayAt8) == null,
                "普通模式下不拦应用");

        System.out.println("\n[应用插件判定]");
        List<PluginRule> rules = new ArrayList<>();
        rules.add(rule("com.tencent.mm", "mm_moments", false, "朋友圈", "Moments"));
        rules.add(rule("com.tencent.mm", "mm_video_channel", true, "视频号"));

        check(GuardRules.matchPluginRules(rules, "com.tencent.mm", "朋友圈 发表文字") != null,
                "命中关键词 → 拦截");
        check(GuardRules.matchPluginRules(rules, "com.tencent.mm", "moments") != null,
                "英文关键词也命中（大小写不敏感）");
        check(GuardRules.matchPluginRules(rules, "com.tencent.mm", "视频号") == null,
                "家长允许的插件不拦（同一次匹配里既有禁止项也有放行项）");
        check(GuardRules.matchPluginRules(rules, "com.tencent.mm", "聊天 通讯录") == null,
                "没命中任何关键词 → 放行（不误伤正常聊天）");
        check(GuardRules.matchPluginRules(rules, "com.tencent.mobileqq", "朋友圈") == null,
                "包名不匹配时不下手（QQ 里的同名文字不该被微信的规则拦）");
        check(GuardRules.matchPluginRules(rules, "com.tencent.mm", "") == null,
                "界面文本为空 → 放行（宁可漏拦，不可误伤）");
        check(GuardRules.matchPluginRules(Collections.<PluginRule>emptyList(), "com.tencent.mm", "朋友圈") == null,
                "没有规则时放行");

        System.out.println("\n[优先级]");
        check(GuardRules.alwaysAllowedPackages().contains("com.android.systemui"),
                "系统界面在放行清单里（清单非空，避免被误删成空集合）");

        System.out.println("\n结果：" + passed + " 项通过，" + failed + " 项失败");
        System.exit(failed > 0 ? 1 : 0);
    }

    static List<ModeConfig.Slot> slots(int[][] pairs) {
        List<ModeConfig.Slot> out = new ArrayList<>();
        for (int[] p : pairs) out.add(ModeConfig.slot(p[0], p[1]));
        return out;
    }

    /** 造一个「某个周一 8 点」的时间戳（2026-09-28 是周一）。 */
    static long mondayAt(int hour) {
        Calendar c = Calendar.getInstance();
        c.clear();
        c.set(2026, Calendar.SEPTEMBER, 28, hour, 0, 0);
        return c.getTimeInMillis();
    }
}
