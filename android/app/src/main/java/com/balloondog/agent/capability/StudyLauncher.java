package com.balloondog.agent.capability;

import com.balloondog.agent.model.ModeConfig;

import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * 学习模式专用桌面（规划 §4.4）的**判定**部分。
 *
 * <p>此前学习模式只是「白名单之外的应用点开就被盖回说明页」，桌面还是原来那个桌面 ——
 * 孩子照样能看见全部图标、翻应用抽屉、进设置里翻漏洞。要做到「桌面上只有家长允许的应用」，
 * 必须把默认桌面换成我们自己的（执行部分见 {@link StudyHomeController}，只有设备所有者能做到）。
 *
 * <p>这个类只做两件纯逻辑的事，因此能在普通 JVM 上逐条验证：
 * <ol>
 *   <li>该不该接管桌面（学习模式 + 设备所有者，缺一不可）；</li>
 *   <li>桌面上显示哪些应用（家长白名单，外加安全底线里的系统包）。</li>
 * </ol>
 *
 * <p>为什么白名单之外还要放系统包：把拨号、系统界面拦掉，手机会立刻变成一块砖
 * （连紧急呼叫都打不出去）。这条底线在 {@link GuardRules#alwaysAllowedPackages()} 里，
 * 与无障碍拦截共用同一份清单 —— 两处各写一份迟早会漂移成「拦截放行、桌面不显示」。
 */
public final class StudyLauncher {

    /** 学习桌面上的一张卡片：孩子点得开的应用。 */
    public static final class Entry {
        public final String packageName;
        public final String label;
        public final boolean system;

        public Entry(String packageName, String label, boolean system) {
            this.packageName = packageName == null ? "" : packageName;
            this.label = label == null ? "" : label;
            this.system = system;
        }
    }

    private StudyLauncher() {
    }

    /**
     * 该不该把默认桌面换成学习桌面。
     *
     * <p>两个条件缺一不可：①此刻是学习模式；②本应用是设备所有者。
     * 没有设备所有者时系统根本不允许改默认桌面（普通应用设 HOME 只会弹一个选择框），
     * 所以那种情况下如实降级 —— 学习模式仍然会拦应用，但桌面不接管，
     * 说明页与文档都要照实说，不能让孩子看到一个「假装接管了」的桌面。
     */
    public static boolean canHoldHome(boolean studyMode, boolean deviceOwner) {
        return studyMode && deviceOwner;
    }

    /**
     * 学习桌面上显示哪些应用。
     *
     * @param config    学习模式配置；{@code studyApps} 是家长允许的包名
     * @param installed 设备上**可启动**的应用（调用方用 PackageManager 查出来）
     * @return 按名字排序后的可见清单（同名时按包名兜底，避免顺序乱跳）
     */
    public static List<Entry> entries(ModeConfig config, List<Entry> installed) {
        if (installed == null || installed.isEmpty()) return Collections.emptyList();

        Set<String> allowed = new HashSet<>();
        if (config != null && config.studyApps != null) {
            for (String pkg : config.studyApps) {
                if (pkg != null && !pkg.isEmpty()) allowed.add(pkg);
            }
        }
        Set<String> safety = GuardRules.alwaysAllowedPackages();

        List<Entry> visible = new ArrayList<>();
        Set<String> seen = new HashSet<>();
        for (Entry entry : installed) {
            if (entry == null) continue;
            String pkg = entry.packageName;
            if (pkg.isEmpty()) continue;
            if (!allowed.contains(pkg) && !safety.contains(pkg)) continue;
            if (!seen.add(pkg)) continue;
            visible.add(entry);
        }

        Collections.sort(visible, new Comparator<Entry>() {
            @Override
            public int compare(Entry a, Entry b) {
                int byLabel = a.label.compareToIgnoreCase(b.label);
                return byLabel != 0 ? byLabel : a.packageName.compareTo(b.packageName);
            }
        });
        return visible;
    }

    /** 顶部那句话：让孩子一眼看懂桌面为什么变成这样（人数变化时也要跟着变）。 */
    public static String noticeText(int shownCount) {
        return "现在是学习模式：桌面上只保留家长允许的应用，"
                + "外加打电话这类必需功能（共 " + shownCount + " 个）。";
    }

    /** 桌面上一张卡片都没有时说什么（家长一个应用都没允许，且系统里没有可启动的安全底线应用）。 */
    public static String emptyText() {
        return "家长还没有允许任何应用。你可以用下面的按钮查看剩余时间，或者找家长添加。";
    }
}
