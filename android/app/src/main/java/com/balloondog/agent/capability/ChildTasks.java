package com.balloondog.agent.capability;

import java.util.Collections;
import java.util.List;

/**
 * 孩子端「今日任务」的展示逻辑（规划 §5.2）。
 *
 * <p>为什么单独抽出来：这一页孩子看的是「今天要做什么」，家长在家长端布置什么，
 * 这里就得显示什么 —— 文字本身要能被逐条钉死（{@code PureLogicCheck} 里覆盖），
 * 而网络与控件留在 Activity 里。页面上只有三句话：标题（带不带孩子的名字）、
 * 进度（还剩几条）、以及勾动之后那句「正在告诉家长…」。
 *
 * <p>三条自我约束：
 * <ul>
 *   <li><b>没有任务就不显示这一块</b> —— 一块「家长还没有布置任务」的空白只会让孩子
 *       以为自己漏看了什么；</li>
 *   <li><b>勾动先乐观显示、失败自己退回去</b> —— 界面上的勾必须能对服务端那一条，
 *       点击没反应和勾了没生效都是最糟的失败方式；</li>
 *   <li><b>名字要说清楚是谁的任务</b> —— 一台设备挂在一个孩子名下，但家长可能有多个孩子，
 *       标题带上名字才不会被误当成「我的」。</li>
 * </ul>
 */
public final class ChildTasks {

    private ChildTasks() {
    }

    /** 一条今日任务。{@code done} 可变：孩子勾一下先乐观改本地，服务端回执再对齐。 */
    public static final class Task {
        public final String id;
        public final String title;
        public boolean done;

        public Task(String id, String title, boolean done) {
            this.id = id;
            this.title = title;
            this.done = done;
        }
    }

    /** 没有任务时的空清单（不可变，调用方不需要再判 null）。 */
    public static List<Task> none() {
        return Collections.emptyList();
    }

    /** 一条任务都没有时整块不出现。 */
    public static boolean visible(int total) {
        return total > 0;
    }

    /**
     * 「谁的、哪天的」：家长建的档案名叫「小明」时是「「小明」今天的任务」，
     * 没建档案（或名字只有空白）时退回「今天的任务」—— 不显示一个空的引号对。
     */
    public static String headerText(String childName) {
        if (childName == null || childName.trim().isEmpty()) return "今天的任务";
        return "「" + childName.trim() + "」今天的任务";
    }

    /** 已完成几条（null 元素按未完成算，不让一条坏数据把整段进度带偏）。 */
    public static int doneCount(List<Task> tasks) {
        if (tasks == null) return 0;
        int done = 0;
        for (Task task : tasks) {
            if (task != null && task.done) done++;
        }
        return done;
    }

    /**
     * 进度文案。三种情况分开说，不合并成「0/0」：
     * 没布置任务 / 还剩几条 / 全做完了。
     */
    public static String progressText(int done, int total) {
        if (total <= 0) return "家长还没有布置任务";
        if (done >= total) return "今天的任务都做完了，真棒";
        return "已完成 " + done + "/" + total;
    }

    /** 请求还在路上时的提示（勾上 / 取消两种方向）。 */
    public static String pendingText(boolean target) {
        return target ? "正在告诉家长…" : "正在取消…";
    }

    /** 请求失败时的提示 —— 明说「没能告诉家长」，不含糊成「操作失败」。 */
    public static String failureText(boolean target) {
        return target ? "没能告诉家长，稍后再试一次" : "没能取消，稍后再试一次";
    }
}
