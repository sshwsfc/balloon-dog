import com.balloondog.agent.capability.GuardRules;
import com.balloondog.agent.capability.WindowNode;
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
 *   <li>插件规则匹配得上却没拦住（或反过来误伤）—— 尤其是「功能名同时出现在入口列表、
 *       功能页标题和聊天正文里」这一种：只有入口与功能页该拦，正文必须放行，
 *       而旧实现按整窗文本匹配，把三种情况一锅端了。</li>
 * </ol>
 */
public class GuardCheck {

    static int passed = 0;
    static int failed = 0;

    static void check(boolean cond, String msg) {
        if (cond) { passed++; System.out.println("  \u2713 " + msg); }
        else { failed++; System.out.println("  \u2717 " + msg); }
    }

    static List<WindowNode> nodes(WindowNode... items) {
        return Arrays.asList(items);
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
        // 真实场景：家长在「插件列表」里只关掉了「朋友圈」，视频号仍然允许。
        List<PluginRule> rules = new ArrayList<>();
        rules.add(PluginRule.of("com.tencent.mm", "mm_moments", false,
                Arrays.asList("朋友圈", "Moments"), Arrays.asList("朋友圈")));
        rules.add(PluginRule.of("com.tencent.mm", "mm_video_channel", true,
                Arrays.asList("视频号"), Arrays.asList("视频号")));

        // 微信「发现」页：顶部标题「发现」，下面是一列可点击的入口行。
        List<WindowNode> discoverPage = nodes(
                WindowNode.of("发现", false, false, true),
                WindowNode.of("朋友圈", true, true, false),
                WindowNode.of("扫一扫", true, true, false),
                WindowNode.of("视频号", true, true, false));

        // 朋友圈功能页：顶部标题就是功能名，正文里另有内容。
        List<WindowNode> momentsPage = nodes(
                WindowNode.of("朋友圈", false, false, true),
                WindowNode.of("发表文字", false, false, false),
                WindowNode.of("返回", true, false, true));

        // 聊天页：窗口标题是「微信」，别人发来的一句话里提到了「朋友圈」。
        List<WindowNode> chatPage = nodes(
                WindowNode.of("微信", false, false, true),
                WindowNode.of("你朋友圈那条我看到了", false, false, false),
                WindowNode.of("输入", true, false, false));

        // 1) 入口行只吃点击，不整屏拦 —— 旧实现把「发现」页整个拦掉，连允许的扫一扫也进不去
        GuardRules.GuardDecision onDiscover =
                GuardRules.matchPluginRules(rules, "com.tencent.mm", "发现", discoverPage);
        check(onDiscover != null && onDiscover.entry,
                "发现页上关掉的入口 → 命中「入口」而不是整屏拦截");
        check(onDiscover != null && "mm_moments".equals(onDiscover.pluginKey),
                "命中的是朋友圈这一项（不是同页的其它入口）");
        check(onDiscover != null && onDiscover.reason.contains("朋友圈"),
                "拦截原因是人话（含功能名），能直接给家长看");

        // 2) 真的进了功能页 → 整屏拦
        GuardRules.GuardDecision onMoments =
                GuardRules.matchPluginRules(rules, "com.tencent.mm", "朋友圈", momentsPage);
        check(onMoments != null && !onMoments.entry, "朋友圈功能页 → 整屏拦截（孩子已经进来了）");
        check(GuardRules.matchPluginRules(rules, "com.tencent.mm", null, momentsPage) != null,
                "拿不到窗口标题时，靠顶部标题条上的不可点击文本也能认出功能页");

        // 3) 正文里提到这个词 ≠ 打开了这个功能
        check(GuardRules.matchPluginRules(rules, "com.tencent.mm", "微信", chatPage) == null,
                "聊天正文里出现「朋友圈」→ 放行（旧实现会把整个微信拦掉）");
        check(GuardRules.matchPluginRules(rules, "com.tencent.mm", "微信",
                        nodes(WindowNode.of("朋友圈", false, false, false))) == null,
                "不在顶部、不在列表里的正文文本永远不算功能页");

        // 4) 列表行里的 TextView 自己不可点击，但祖先可点击 —— 采集端会标成 clickable，
        //    这时即使它落在顶部条里也不能被当成「功能页标题」。
        check(GuardRules.matchPluginRules(rules, "com.tencent.mm", "发现",
                        nodes(WindowNode.of("朋友圈", true, true, true))) != null
                        && GuardRules.matchPluginRules(rules, "com.tencent.mm", "发现",
                        nodes(WindowNode.of("朋友圈", true, true, true))).entry,
                "可点击的列表行永远是「入口」，即使它落在顶部标题条区域");

        // 5) 允许的项、别的包、没有规则、空窗口
        check(GuardRules.matchPluginRules(rules, "com.tencent.mm", "发现",
                        nodes(WindowNode.of("视频号", true, true, false))) == null,
                "家长允许的插件不拦（同一次匹配里既有禁止项也有放行项）");
        check(GuardRules.matchPluginRules(rules, "com.tencent.mobileqq", "朋友圈", momentsPage) == null,
                "包名不匹配时不下手（QQ 里的同名文字不该被微信的规则拦）");
        check(GuardRules.matchPluginRules(Collections.<PluginRule>emptyList(), "com.tencent.mm", "朋友圈",
                momentsPage) == null, "没有规则时放行");
        check(GuardRules.matchPluginRules(rules, "com.tencent.mm", "发现",
                        Collections.<WindowNode>emptyList()) == null,
                "采不到任何节点 → 放行（宁可漏拦，不可误伤）");

        // 6) 旧格式（只有一组 keywords）：入口拦点击 + 标题命中时整屏拦，仍然不误伤聊天
        List<PluginRule> legacy = new ArrayList<>();
        legacy.add(PluginRule.of("com.tencent.mm", "mm_moments", false, Arrays.asList("朋友圈")));
        GuardRules.GuardDecision legacyEntry =
                GuardRules.matchPluginRules(legacy, "com.tencent.mm", "发现", discoverPage);
        check(legacyEntry != null && legacyEntry.entry, "旧格式规则照样只吃入口点击");
        GuardRules.GuardDecision legacyPage =
                GuardRules.matchPluginRules(legacy, "com.tencent.mm", "朋友圈", momentsPage);
        check(legacyPage != null && !legacyPage.entry, "旧格式规则靠页面标题仍能整屏拦");
        check(GuardRules.matchPluginRules(legacy, "com.tencent.mm", "微信", chatPage) == null,
                "旧格式规则不再把聊天正文判成违规");

        // 7) 页面内标志物：出现在屏幕中间（不在顶部、不在列表里）也要命中 ——
        //    支付弹窗就是长这样的；而弱词不许进这一层，聊天里提一句不能中招。
        List<PluginRule> payRules = new ArrayList<>();
        payRules.add(PluginRule.of("com.tencent.mm", "pay_password", false, "支付密码页",
                Collections.<String>emptyList(), Collections.<String>emptyList(),
                Arrays.asList("请输入支付密码")));
        GuardRules.GuardDecision onPaySheet = GuardRules.matchPluginRules(payRules, "com.tencent.mm",
                "微信", nodes(WindowNode.of("请输入支付密码", false, false, false)));
        check(onPaySheet != null && !onPaySheet.entry,
                "页面内标志物出现在屏幕中间也算命中，并且是整屏拦截");
        check(onPaySheet != null && onPaySheet.reason.contains("支付密码页"),
                "拦截原因用目录里的人话名字，而不是拿标志物凑");
        check(GuardRules.matchPluginRules(payRules, "com.tencent.mm", "张三",
                        nodes(WindowNode.of("他说支付密码忘了", false, false, false))) == null,
                "标志物按完整串匹配，聊天里提一句不会被误伤");

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
