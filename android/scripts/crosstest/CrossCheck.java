import com.balloondog.agent.capability.ScheduleEngine;
import com.balloondog.agent.model.ScheduleRule;
import java.util.*;

/** 用真实的 Android ScheduleEngine 复算后端参考结果，逐点比对两套实现是否一致。 */
public class CrossCheck {
  static ScheduleRule R(String id, String action, int[] days, int s, int e, String name) {
    List<Integer> d = new ArrayList<>();
    for (int x : days) d.add(x);
    return new ScheduleRule(id, name, action, Collections.unmodifiableList(d), s, e, true);
  }
  static final int[] EVERY = {0,1,2,3,4,5,6};
  static final int[] WEEKDAYS = {1,2,3,4,5};

  static String esc(String s) { return s.replace("\\", "\\\\").replace("\"", "\\\""); }

  public static void main(String[] args) throws Exception {
    List<Object[]> cases = new ArrayList<>();
    cases.add(new Object[]{"每天22:00-07:00锁", Arrays.asList(R("a","lock",EVERY,1320,420,"睡觉"))});
    cases.add(new Object[]{"仅周五22:00-07:00锁(跨天单日)", Arrays.asList(R("b","lock",new int[]{5},1320,420,"周五晚"))});
    cases.add(new Object[]{"工作日08:00-12:00锁+每天12:00-13:00放行", Arrays.asList(
        R("c","lock",WEEKDAYS,480,720,"上课"), R("d","unlock",EVERY,720,780,"午休"))});
    cases.add(new Object[]{"全天锁00:00-24:00", Arrays.asList(R("e","lock",EVERY,0,1440,"全天"))});
    cases.add(new Object[]{"周日全天放行+每天22:00-07:00锁", Arrays.asList(
        R("f","unlock",new int[]{0},0,1440,"周日自由"), R("g","lock",EVERY,1320,420,"睡觉"))});
    cases.add(new Object[]{"周六10:00-20:00放行+每天09:00-21:00锁", Arrays.asList(
        R("h","unlock",new int[]{6},600,1200,"周六"), R("i","lock",EVERY,540,1260,"白天"))});

    Calendar start = Calendar.getInstance();
    start.clear();
    start.set(2026, Calendar.SEPTEMBER, 28, 0, 0, 0);
    long startMs = start.getTimeInMillis();

    StringBuilder sb = new StringBuilder("[");
    for (int ci = 0; ci < cases.size(); ci++) {
      @SuppressWarnings("unchecked") List<ScheduleRule> rules = (List<ScheduleRule>) cases.get(ci)[1];
      sb.append("{\"case\":\"").append(esc((String) cases.get(ci)[0])).append("\",\"points\":[");
      for (int i = 0; i < 7 * 48; i++) {
        long t = startMs + i * 30L * 60_000L;
        ScheduleEngine.Decision d = ScheduleEngine.evaluate(rules, t);
        if (i > 0) sb.append(',');
        sb.append("{\"t\":").append(t).append(",\"locked\":").append(d.locked)
          .append(",\"rule\":").append(d.rule == null ? "null" : "\"" + d.rule.id + "\"").append('}');
      }
      sb.append("],\"boundaryAtStart\":");
      ScheduleEngine.Boundary b = ScheduleEngine.nextBoundary(rules, startMs);
      sb.append(b == null ? "null" : "{\"at\":" + b.atMillis + ",\"locked\":" + b.locked + "}");
      sb.append('}');
      if (ci < cases.size() - 1) sb.append(',');
    }
    sb.append(']');
    System.out.println(sb);
  }
}
