import com.balloondog.agent.capability.StudyModeEngine;
import com.balloondog.agent.model.ModeConfig;

import java.util.*;

/**
 * 用真实的 Android {@link StudyModeEngine} 复算后端 mode.service 的参考结果。
 *
 * <p>为什么值得单独做：{@code evaluateMode} 被实现了两遍 ——
 * 后端用它给家长端展示「当前模式」，Android 用它在本地强制执行。
 * 两份一旦漂移，就会出现「家长端显示普通模式、孩子手机却在学习模式」这类
 * 最难排查的问题。「一格都没选 = 全天学习模式」这条尤其容易只改一边。
 */
public class ModeCrossCheck {

    static ModeConfig cfg(String manual, boolean scheduleOn, int[][] slots) {
        List<ModeConfig.Slot> list = new ArrayList<>();
        for (int[] s : slots) list.add(ModeConfig.slot(s[0], s[1]));
        return ModeConfig.of(manual, scheduleOn, list, Collections.<String>emptyList());
    }

    static String esc(String s) { return s.replace("\\", "\\\\").replace("\"", "\\\""); }

    public static void main(String[] args) throws Exception {
        List<Object[]> cases = new ArrayList<>();

        cases.add(new Object[]{"手动学习模式", cfg("study", false, new int[][]{})});
        cases.add(new Object[]{"手动普通模式", cfg("normal", false, new int[][]{})});
        cases.add(new Object[]{"未设置且不按时间", cfg(null, false, new int[][]{})});
        // 这条是最容易两边写不一致的：开启时段规划却一格都没选 → 全天学习模式
        cases.add(new Object[]{"开启时段但一格没选(全天学习)", cfg(null, true, new int[][]{})});
        cases.add(new Object[]{"周一8/9点+周二10点为学习", cfg(null, true,
                new int[][]{{1,8},{1,9},{2,10}})});
        cases.add(new Object[]{"手动学习覆盖时段规划", cfg("study", true, new int[][]{{1,8}})});
        cases.add(new Object[]{"手动普通覆盖时段规划", cfg("normal", true, new int[][]{{1,8}})});
        cases.add(new Object[]{"周日全天为学习", cfg(null, true,
                sundayAllDay())});
        cases.add(new Object[]{"每天0点与23点为学习", cfg(null, true,
                new int[][]{{0,0},{1,0},{2,0},{3,0},{4,0},{5,0},{6,0},
                            {0,23},{1,23},{2,23},{3,23},{4,23},{5,23},{6,23}})});

        // 从一个周一 00:00 开始，每 30 分钟采一次，共 7 天 = 336 点
        Calendar start = Calendar.getInstance();
        start.clear();
        start.set(2026, Calendar.SEPTEMBER, 28, 0, 0, 0); // 2026-09-28 是周一

        StringBuilder out = new StringBuilder("[");
        boolean firstCase = true;
        for (Object[] c : cases) {
            if (!firstCase) out.append(',');
            firstCase = false;
            out.append("{\"case\":\"").append(esc((String) c[0])).append("\",\"points\":[");
            ModeConfig config = (ModeConfig) c[1];
            for (int i = 0; i < 7 * 48; i++) {
                long t = start.getTimeInMillis() + i * 30L * 60_000L;
                String mode = StudyModeEngine.evaluate(config, t);
                if (i > 0) out.append(',');
                out.append("{\"t\":").append(t).append(",\"mode\":\"").append(mode).append("\"}");
            }
            out.append("]}");
        }
        out.append(']');
        System.out.println(out);
    }

    /** 周日（0）的 0..23 全部为学习模式。 */
    static int[][] sundayAllDay() {
        int[][] slots = new int[24][];
        for (int h = 0; h < 24; h++) slots[h] = new int[]{0, h};
        return slots;
    }
}
