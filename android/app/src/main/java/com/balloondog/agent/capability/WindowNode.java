package com.balloondog.agent.capability;

/**
 * 当前窗口里「一个可见文本节点」对判定有用的全部事实。
 *
 * <p>这是无障碍层采集到的原始观察结果，判定本身（{@link GuardRules}）不碰任何 Android 类 ——
 * 只有这样它才能在普通 JVM 上被 {@code android/scripts/crosstest/GuardCheck.java} 逐条覆盖：
 * 模拟器里没有装微信，端到端复现不出「朋友圈入口被点了一下」这件事。
 *
 * <h3>为什么需要「可点击 / 在列表里 / 在顶部标题条」这三个布尔位</h3>
 *
 * 「功能名」这三个字会同时出现在三个地方，而**它们的管控含义完全不同**：
 * <ul>
 *   <li>**入口列表**：微信「发现」页上「朋友圈」那一行 —— 这是孩子进入功能的门，要挡住；</li>
 *   <li>**功能页标题**：朋友圈页顶部的「朋友圈」 —— 说明孩子已经进来了，要拦下来；</li>
 *   <li>**正文内容**：聊天里别人发来一句「朋友圈」 —— 与管控毫无关系，必须放行。</li>
 * </ul>
 *
 * 光看整窗文本这三者无法区分（这正是旧实现把「发现」页整个拦掉、聊天里提一句也被拦的原因），
 * 能区分它们的只有界面结构：入口行**可点击且位于列表里**，功能页标题**不可点击且落在顶部标题条**，
 * 正文两者都不是。
 *
 * @see GuardRules#matchPluginRules
 */
public final class WindowNode {

    /** 节点上的可见文本（{@code getText()} 或 {@code getContentDescription()}）。 */
    public final String text;
    /**
     * 它自身、或它的某个祖先可点击。
     *
     * <p>必须把祖先算进来：列表行的可点击节点通常是外层容器，里面的
     * {@code TextView}（真正带「朋友圈」三个字的那个）自己并不 clickable。
     */
    public final boolean clickable;
    /** 位于列表容器（{@code RecyclerView} / {@code ListView} / 可滚动容器）内部。 */
    public final boolean inList;
    /** 落在窗口顶部的标题条区域（按窗口高度比例估算，见采集端注释）。 */
    public final boolean topStrip;

    public WindowNode(String text, boolean clickable, boolean inList, boolean topStrip) {
        this.text = text;
        this.clickable = clickable;
        this.inList = inList;
        this.topStrip = topStrip;
    }

    /** 静态工厂：给判定测试用（那套测试跑在普通 JVM 上）。 */
    public static WindowNode of(String text, boolean clickable, boolean inList, boolean topStrip) {
        return new WindowNode(text, clickable, inList, topStrip);
    }

    @Override
    public String toString() {
        return "WindowNode{" + text + ", clickable=" + clickable
                + ", inList=" + inList + ", topStrip=" + topStrip + '}';
    }
}
