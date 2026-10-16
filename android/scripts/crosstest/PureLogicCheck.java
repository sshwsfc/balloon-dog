import com.balloondog.agent.capability.BlockedAddresses;
import com.balloondog.agent.capability.DnsMessage;
import com.balloondog.agent.capability.DomainBlocker;
import com.balloondog.agent.capability.Geofence;
import com.balloondog.agent.capability.GuardianNotice;
import com.balloondog.agent.capability.GuardRules;
import com.balloondog.agent.capability.IpPackets;
import com.balloondog.agent.capability.StudyLauncher;
import com.balloondog.agent.capability.ChildStatus;
import com.balloondog.agent.capability.ChildTasks;
import com.balloondog.agent.capability.LockState;
import com.balloondog.agent.capability.TrustedClock;
import com.balloondog.agent.model.AppLimitRule;
import com.balloondog.agent.model.ModeConfig;
import com.balloondog.agent.model.SafeZone;
import com.balloondog.agent.model.ScheduleRule;

import java.io.ByteArrayOutputStream;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.text.SimpleDateFormat;
import java.util.Locale;
import java.util.Map;
import java.util.TimeZone;

/**
 * 「纯逻辑」的单元测试：安全区（§2）、应用限时判定（§4）、网址归一化与 DNS 报文（§5），
 * 以及抗篡改时钟（§1.6）。
 *
 * <p>为什么必须在这里测：这三样东西在模拟器上要么根本跑不出来（VpnService 需要系统授权与
 * 真实网络），要么跑出来也看不出对错（应用限时依赖真实使用时长累积）。
 * 与其写一条「跑得过但什么也没验证」的端到端断言，不如把算法抽成纯函数逐条钉死，
 * 而把端到端留给「配置能下发、服务能起来」这类真的需要设备的事。
 *
 * <p>重点覆盖的是那种<b>静默出错</b>的边界：
 * 半开半闭的半径比较、子域名匹配误伤、DNS 报文里忘清 ARCOUNT。
 */
public class PureLogicCheck {

    static int passed = 0;
    static int failed = 0;

    static void check(boolean cond, String msg) {
        if (cond) { passed++; System.out.println("  \u2713 " + msg); }
        else { failed++; System.out.println("  \u2717 " + msg); }
    }

    static void near(double actual, double expected, double tolerance, String msg) {
        check(Math.abs(actual - expected) <= tolerance,
                msg + "（实际 " + actual + "，期望 " + expected + "±" + tolerance + "）");
    }

    public static void main(String[] args) {
        checkGeofence();
        checkAppLimit();
        checkDomainBlocker();
        checkDnsMessage();
        checkTrustedClock();
        checkUnlockProbe();
        checkChildStatus();
        checkGuardianNotice();
        checkBlockedAddresses();
        checkStudyLauncher();
        checkChildTasks();

        System.out.println("\n结果：" + passed + " 项通过，" + failed + " 项失败");
        System.exit(failed > 0 ? 1 : 0);
    }

    // ============================================================
    // §2 安全区
    // ============================================================

    static void checkGeofence() {
        System.out.println("\n[安全区：距离与包含判定]");

        near(Geofence.haversineMeters(39.9042, 116.4074, 39.9042, 116.4074), 0.0, 0.001,
                "同一点距离为 0");
        // 1 个纬度 ≈ 111.19 公里（地球半径取 6371008.8 米的平均值）
        near(Geofence.haversineMeters(0.0, 0.0, 1.0, 0.0), 111194.9, 1.0,
                "1 个纬度约 111.19 公里");
        // 北京—上海直线约 1067 公里
        double beijingShanghai = Geofence.haversineMeters(39.9042, 116.4074, 31.2304, 121.4737);
        check(beijingShanghai > 1_050_000 && beijingShanghai < 1_090_000,
                "北京到上海约 1067 公里（实际 " + Math.round(beijingShanghai / 1000) + " 公里）");
        check(Geofence.haversineMeters(39.9042, 116.4074, 31.2304, 121.4737)
                        == Geofence.haversineMeters(31.2304, 121.4737, 39.9042, 116.4074),
                "距离对称（起点终点互换结果相同）");

        SafeZone school = SafeZone.of("z1", "学校", 39.9042, 116.4074, 300);
        List<SafeZone> zones = Collections.singletonList(school);

        check(Geofence.findContaining(zones, 39.9042, 116.4074) == school, "圆心处判定为在区内");
        check(Geofence.findContaining(zones, 39.9052, 116.4074) == school,
                "向北约 111 米（半径内）判定为在区内");
        check(Geofence.findContaining(zones, 39.9072, 116.4074) == null,
                "向北约 333 米（半径外）判定为不在区内");
        check(Geofence.insideAny(Collections.<SafeZone>emptyList(), 39.9, 116.4) == false,
                "没有安全区时永远不在区内（不误报）");

        // 半开半闭的边界：0.001 度 ≈ 111.19 米。
        // 半径 111 米应当「差一点点」不算进，半径 112 米才算 ——
        // 这条用来钉死 distance <= radius 的语义（写成 < 也不会被发现，所以必须卡在这 1 米上）
        SafeZone tight = SafeZone.of("z2", "阈值", 0.0, 0.0, 111);
        SafeZone loose = SafeZone.of("z3", "阈值", 0.0, 0.0, 112);
        check(Geofence.findContaining(Collections.singletonList(tight), 0.001, 0.0) == null,
                "半径 111 米、距离 111.19 米 → 不在区内");
        check(Geofence.findContaining(Collections.singletonList(loose), 0.001, 0.0) != null,
                "半径 112 米、距离 111.19 米 → 在区内");

        // 多个区时返回包含它的那一个
        SafeZone home = SafeZone.of("z4", "家", 31.2304, 121.4737, 500);
        List<SafeZone> two = Arrays.asList(school, home);
        check(Geofence.findContaining(two, 31.2304, 121.4737) == home, "多区时命中的是第二个区");
        check(Geofence.findContaining(two, 48.8566, 2.3522) == null, "巴黎不在任何区里");

        // 解析层面的坏数据必须被丢掉，否则会造出一个「永远命中」的区
        check(SafeZone.of("z5", "坏数据", Double.NaN, 0, 100) == null, "NaN 坐标的区被丢弃");
        check(SafeZone.of("z6", "坏数据", 0, 0, 0) == null, "半径 0 的区被丢弃");
        check(SafeZone.of("", "坏数据", 0, 0, 100) == null, "id 为空的区被丢弃");
    }

    // ============================================================
    // §4 应用限时判定
    // ============================================================

    static void checkAppLimit() {
        System.out.println("\n[应用限时：超额判定]");

        List<AppLimitRule> rules = new ArrayList<>();
        rules.add(AppLimitRule.of("com.ss.android.ugc.aweme", "抖音", 60));
        rules.add(AppLimitRule.of("com.tencent.tmgp.sgame", "王者荣耀", 30));

        Map<String, Integer> usage = new HashMap<>();
        usage.put("com.ss.android.ugc.aweme", 3599);
        usage.put("com.tencent.tmgp.sgame", 1800);

        check(GuardRules.matchAppLimit(rules, usage, true, false, "com.ss.android.ugc.aweme") == null,
                "未到限额（3599 秒 < 3600 秒）放行");
        usage.put("com.ss.android.ugc.aweme", 3600);
        check(GuardRules.matchAppLimit(rules, usage, true, false, "com.ss.android.ugc.aweme") != null,
                "刚好到限额（3600 秒 = 60 分钟）拦截");

        GuardRules.GuardDecision decision =
                GuardRules.matchAppLimit(rules, usage, true, false, "com.tencent.tmgp.sgame");
        check(decision != null, "王者荣耀已到 30 分钟限额 → 拦截");
        check(decision != null && decision.reason != null && decision.reason.contains("30"),
                "拦截原因里带上限分钟数（家长端要能显示「今日 30 分钟已用完」）");

        check(GuardRules.matchAppLimit(rules, usage, true, false, "com.tencent.mm") == null,
                "没有限额规则的应用放行");

        // 安全底线：与学习模式同一套 —— 不按包名猜，只拦「有桌面入口」的应用
        check(GuardRules.matchAppLimit(rules, usage, false, false, "com.ss.android.ugc.aweme") == null,
                "不可启动的系统组件不拦");
        check(GuardRules.matchAppLimit(rules, usage, true, true, "com.ss.android.ugc.aweme") == null,
                "桌面永远放行（拦了手机就没法用）");

        Map<String, Integer> empty = Collections.emptyMap();
        check(GuardRules.matchAppLimit(rules, empty, true, false, "com.ss.android.ugc.aweme") == null,
                "还没采到用量时放行（宁可漏拦，不可误伤：没权限时不能把应用全锁死）");

        List<AppLimitRule> unlimited = Collections.singletonList(
                AppLimitRule.of("com.ss.android.ugc.aweme", "抖音", 0));
        check(GuardRules.matchAppLimit(unlimited, usage, true, false, "com.ss.android.ugc.aweme") == null,
                "限额 0 视为不限（与服务端 unlimited = limit === 0 的语义一致）");

        // 永不拦截的清单（systemui / 电话）也必须在这里生效
        List<AppLimitRule> dangerous = Collections.singletonList(
                AppLimitRule.of("com.android.systemui", "系统界面", 1));
        Map<String, Integer> huge = new HashMap<>();
        huge.put("com.android.systemui", 99999);
        check(GuardRules.matchAppLimit(dangerous, huge, true, false, "com.android.systemui") == null,
                "systemui 即便超限也不拦");
    }

    // ============================================================
    // §5 域名归一化与匹配
    // ============================================================

    static void checkDomainBlocker() {
        System.out.println("\n[网址拦截：域名归一化与后缀匹配]");

        check("example.com".equals(DomainBlocker.normalize("https://example.com/")),
                "去掉协议与路径");
        check("example.com".equals(DomainBlocker.normalize("HTTPS://Example.COM:8443/a/b?c=1#d")),
                "大小写、端口、查询串、片段都被去掉");
        check("example.com".equals(DomainBlocker.normalize("*.example.com")),
                "通配前缀去掉（后缀匹配本来就覆盖子域）");
        check("example.com".equals(DomainBlocker.normalize(".example.com")),
                "前导点去掉");
        check(DomainBlocker.normalize("1.2.3.4") == null,
                "IP 字面量被忽略（IP 不过 DNS，留着只会造成「已拦住」的错觉）");
        check(DomainBlocker.normalize("") == null, "空串被忽略");
        check(DomainBlocker.normalize("https://") == null, "只有协议没有域名 → 忽略");
        check(DomainBlocker.normalize("user:pw@example.com") == null
                        || "example.com".equals(DomainBlocker.normalize("user:pw@example.com")),
                "带 userinfo 的网址不会因为解析失败而误拦整串");

        List<String> entries = DomainBlocker.parseList("https://example.com/，*.taobao.com\nqq.com  example.com");
        check(entries.size() == 3, "混合分隔符 + 重复项 → 归一化去重后 3 条（实际 "
                + entries.size() + "）");
        check(entries.contains("example.com") && entries.contains("taobao.com") && entries.contains("qq.com"),
                "解析出的域名都正确");

        check(DomainBlocker.isBlocked(entries, "www.example.com"), "子域 www.example.com 命中 example.com");
        check(DomainBlocker.isBlocked(entries, "example.com"), "自身命中");
        check(DomainBlocker.isBlocked(entries, "EXAMPLE.COM"), "匹配大小写不敏感");
        check(!DomainBlocker.isBlocked(entries, "evil-example.com"),
                "evil-example.com 不被 example.com 误伤（点边界匹配）");
        check(!DomainBlocker.isBlocked(entries, "notexample.com"),
                "notexample.com 不被误伤");
        check(!DomainBlocker.isBlocked(entries, null), "host 为 null 时不拦");
        check(!DomainBlocker.isBlocked(Collections.<String>emptyList(), "example.com"),
                "黑名单为空时不拦任何域名");

        // 用 IP 填的黑名单不能拦住同名域的解析结果（这正是「不装」的那种假拦截）
        List<String> ipOnly = DomainBlocker.parseList("1.2.3.4");
        check(!DomainBlocker.isBlocked(ipOnly, "1.2.3.4"), "IP 项不参与 DNS 层拦截");
    }

    // ============================================================
    // §5 DNS 报文解析与 NXDOMAIN 构造
    // ============================================================

    static void checkDnsMessage() {
        System.out.println("\n[网址拦截：DNS 报文]");

        byte[] query = dnsQuery(0x1234, "www.example.com");
        check(DnsMessage.isStandardQuery(query), "标准查询（QR=0, opcode=0）被识别");
        check(DnsMessage.questionCount(query) == 1, "QDCOUNT = 1");

        int end = DnsMessage.questionsEnd(query);
        check(end == query.length, "question 段正好到报文末尾（实际 " + end + "，长度 " + query.length + "）");
        check("www.example.com".equals(DnsMessage.firstQuestionName(query)),
                "解析出查询域名");

        byte[] response = DnsMessage.buildNxDomain(query, end);
        check(response != null && response.length == end, "NXDOMAIN 应答只包含 header + question 段");
        check(response != null && (response[0] & 0xFF) == 0x12 && (response[1] & 0xFF) == 0x34,
                "事务 ID 原样保留（丢了 ID 客户端会丢弃应答并超时重试）");
        check(response != null && (response[2] & 0x80) != 0, "QR 置 1（这是应答）");
        check(response != null && (response[2] & 0x01) != 0, "RD 位保留（与查询一致）");
        check(response != null && (response[3] & 0x80) != 0, "RA 置 1（支持递归）");
        check(response != null && (response[3] & 0x0F) == 3, "RCODE = NXDOMAIN(3)");
        check(response != null && response[6] == 0 && response[7] == 0, "ANCOUNT = 0");
        check(response != null && response[8] == 0 && response[9] == 0, "NSCOUNT = 0");
        check(response != null && response[10] == 0 && response[11] == 0,
                "ARCOUNT = 0（必须清掉：查询里带 EDNS(OPT) 时不清这个字段会产出畸形报文）");

        // 带 EDNS(OPT) 的查询：ARCOUNT=1 且末尾多 11 字节，应答必须把 ARCOUNT 清零并丢掉那段
        byte[] withEdns = dnsQueryWithEdns(0x5678, "blocked.example.com");
        int ednsEnd = DnsMessage.questionsEnd(withEdns);
        byte[] ednsResponse = DnsMessage.buildNxDomain(withEdns, ednsEnd);
        check(ednsResponse != null && ednsResponse.length == ednsEnd, "带 EDNS 的查询也按 question 段截断");
        check(ednsResponse != null && ednsResponse[11] == 0 && ednsResponse[10] == 0,
                "带 EDNS 的查询：ARCOUNT 被清零");

        // 应答不是查询：不能被当成查询去转发（否则会和上游形成应答风暴）
        byte[] asResponse = dnsQuery(0x9999, "example.com");
        asResponse[2] = (byte) 0x81; // QR=1
        check(!DnsMessage.isStandardQuery(asResponse), "QR=1 的报文不被当作查询");

        // 截断的报文不能抛异常（网络上什么畸形包都有）
        byte[] truncated = Arrays.copyOf(query, 14);
        check(DnsMessage.questionsEnd(truncated) == -1
                        || DnsMessage.questionsEnd(truncated) > 0,
                "截断报文不抛异常（返回 -1 表示无法解析）");
        check(DnsMessage.firstQuestionName(truncated) == null
                        || DnsMessage.firstQuestionName(truncated).length() > 0,
                "截断报文不抛异常（解析不出名字时返回 null）");
        check(DnsMessage.questionsEnd(new byte[4]) == -1, "比 header 还短的报文返回 -1");
        check(DnsMessage.firstQuestionName(new byte[4]) == null, "比 header 还短的报文解析不出名字");
    }

    /** 拼一个最小的 DNS 查询：单问题、无附加记录。 */
    static byte[] dnsQuery(int id, String name) {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        out.write((id >> 8) & 0xFF);
        out.write(id & 0xFF);
        out.write(0x01); // RD = 1
        out.write(0x00);
        out.write(0x00); out.write(0x01); // QDCOUNT
        out.write(0x00); out.write(0x00); // ANCOUNT
        out.write(0x00); out.write(0x00); // NSCOUNT
        out.write(0x00); out.write(0x00); // ARCOUNT
        for (String label : name.split("\\.")) {
            out.write(label.length());
            for (int i = 0; i < label.length(); i++) out.write(label.charAt(i));
        }
        out.write(0x00);
        out.write(0x00); out.write(0x01); // QTYPE A
        out.write(0x00); out.write(0x01); // QCLASS IN
        return out.toByteArray();
    }

    // ============================================================
    // §1.6 抗篡改时钟
    // ============================================================

    /**
     * 可控时间源：把「开机时长」和「系统墙钟」拆开，才能单独把墙钟调来调去。
     *
     * <p>这正是真实攻击的样子 —— 孩子改的是墙钟，而 {@code elapsedRealtime()} 一步不动。
     */
    static final class FakeTime implements TrustedClock.TimeSource {
        long elapsed;
        long wall;

        FakeTime(long elapsed, long wall) {
            this.elapsed = elapsed;
            this.wall = wall;
        }

        @Override
        public long elapsedRealtime() {
            return elapsed;
        }

        @Override
        public long wallMillis() {
            return wall;
        }
    }

    /** 服务端权威时间的 ISO 表达（与后端 {@code new Date().toISOString()} 同格式）。 */
    static String iso(long millis) {
        SimpleDateFormat fmt = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSSXXX", Locale.US);
        fmt.setTimeZone(TimeZone.getTimeZone("UTC"));
        return fmt.format(new java.util.Date(millis));
    }

    static void checkTrustedClock() {
        System.out.println("\n[抗篡改时钟：墙钟被改，判定用的「现在」不能跟着动]");

        final long baseWall = 1_800_000_000_000L;
        final long elapsed0 = 5_000_000L;

        // ---- 1) 还没锚定：只能退回墙钟，且不报假的偏差 ----
        FakeTime t = new FakeTime(elapsed0, baseWall);
        TrustedClock.setSourceForTest(t);
        check(!TrustedClock.isAnchored(), "没有服务端时间时 isAnchored() 为 false");
        check(TrustedClock.now() == baseWall, "未锚定时 now() 就是系统墙钟");
        check(TrustedClock.skewSeconds() == 0L, "未锚定时 clockSkewSeconds 报 0 而不是编一个");

        // ---- 2) 首次锚定：没有「上一次」可比，不算跳变 ----
        check(!TrustedClock.sync(iso(baseWall)), "首次锚定不判为改时间");
        check(TrustedClock.isAnchored(), "锚定后 isAnchored() 为 true");
        check(TrustedClock.skewSeconds() == 0L, "墙钟与服务器一致时偏差为 0 秒");

        // ---- 3) 正常前进：墙钟与开机时长同步走，不该报警 ----
        t.elapsed += 60_000L;
        t.wall += 60_000L;
        check(!TrustedClock.sync(iso(t.wall)), "墙钟正常前进 60 秒不算改时间");
        check(TrustedClock.now() == t.wall, "锚定后 now() 跟着开机时长前进");

        // ---- 4) 把墙钟调回一天前：必须检出，且判定用的「现在」一动不动 ----
        long beforeJump = TrustedClock.now();
        t.wall -= 86_400_000L;
        t.elapsed += 15_000L;
        check(TrustedClock.sync(iso(beforeJump + 15_000L)), "墙钟被调回一天前：检出改时间");
        check(TrustedClock.jumpCount() == 1, "改时间次数累计为 1");
        check(TrustedClock.now() == beforeJump + 15_000L,
                "改完墙钟后 now() 仍按开机时长走（不受调时间影响）");
        check(TrustedClock.skewSeconds() == -86_415L, "偏差如实报出（设备比服务器慢 86415 秒）");

        // ---- 5) 墙钟调快：同样检出 ----
        t.wall += 3_600_000L;
        t.elapsed += 15_000L;
        check(TrustedClock.sync(iso(TrustedClock.now())), "墙钟被调快一小时：检出改时间");
        check(TrustedClock.jumpCount() == 2, "改时间次数累计为 2");

        // ---- 6) 阈值以内的抖动不算：别把 NTP 微调当成恶意 ----
        t.wall -= 30_000L;
        t.elapsed += 15_000L;
        check(!TrustedClock.sync(iso(TrustedClock.now())), "偏差只差 30 秒（阈值 60 秒内）不算改时间");
        check(TrustedClock.jumpCount() == 2, "阈值内的抖动不累加改时间次数");

        // ---- 7) 设备重启：开机时长归零，锚点作废，退回墙钟等下一次心跳 ----
        long wallBeforeReboot = t.wall;
        t.elapsed = 1_000L;
        check(!TrustedClock.isAnchored(), "设备重启（开机时长归零）后 isAnchored() 变回 false");
        check(TrustedClock.now() == wallBeforeReboot, "锚点作废后退回墙钟");
        check(!TrustedClock.sync(iso(wallBeforeReboot)), "重启后的首次同步重新锚定，不算改时间");
        check(TrustedClock.isAnchored(), "重新锚定成功");

        // ---- 8) 坏输入 / 缺字段：不崩、不改状态 ----
        check(!TrustedClock.sync(null), "serverTime 为 null 时静默返回 false");
        check(!TrustedClock.sync(""), "serverTime 为空串时静默返回 false");
        check(!TrustedClock.sync("昨天下午"), "serverTime 不是 ISO 时间时静默返回 false");
        check(TrustedClock.isAnchored(), "坏输入不会破坏已有的锚点");

        // ---- 9) 不带毫秒的 ISO 也认：这次让服务端比设备慢 2 分钟，
        //      能据此检出跳变，才说明那一串真的被解析出来了（解析失败只会静默返回 false） ----
        t.elapsed += 10_000L;
        t.wall = TrustedClock.now() + 10_000L;
        String plain = iso(t.wall - 120_000L).replaceFirst("\\.\\d{3}", "");
        check(TrustedClock.sync(plain),
                "不带毫秒的 ISO8601 也能解析（否则这次 2 分钟跳变检不出来）");

        TrustedClock.resetForTest();
    }

    // ============================================================
    // §3.3 锁定页的「还剩多久」
    // ============================================================

    /**
     * 向前试探自动解锁时刻。
     *
     * <p>为什么要测：锁定页会把这个时间直接显示给孩子看，说错了就是「告诉我 10 分钟后能玩，
     * 结果一直锁着」—— 比不显示更伤信任。而「探不出来」必须与「探得出来」严格区分：
     * 家长远程锁定、额度用尽这类往后看多久都还是锁着，只能如实说「由家长决定」。
     *
     * <p>用固定时刻而不是 {@code System.currentTimeMillis()}，否则用例会随运行时间漂移。
     */
    /**
     * 孩子端主页上那句「今天还剩多少」（规划 §3.2）。
     *
     * <p>这是孩子每天要看几十遍的一句话，而且它**没法用模拟器验**（要真的用掉几个小时）。
     * 所以口径在这里逐条钉死：没设额度 / 已经用完 / 还剩多久必须分开说，
     * 边界（刚好用完、剩余不足 1 分钟）不能出现「还剩 0分钟」却仍判可用的自相矛盾。
     */
    static void checkChildStatus() {
        System.out.println("\n[孩子端主页：今天还剩多少，三种情况分开说]");

        // ---- 1) 家长没设额度：说「没有设置」，不能说「还剩 0 分钟」 ----
        ChildStatus.Snapshot none = ChildStatus.compute(0, 3600L);
        check(!none.hasLimit && !none.exhausted,
                "额度 0（等于没设）时不算「用完」，只是没有限制");
        check("家长没有设置每日使用时长".equals(ChildStatus.remainingText(0, 3600L)),
                "没设额度时如实说「家长没有设置每日使用时长」");
        check(ChildStatus.compute(-30, 3600L).hasLimit == false,
                "负数额度按「没设」处理（手滑设负数不该把孩子锁死）");

        // ---- 2) 还剩多久：用与不使用都要能算准 ----
        ChildStatus.Snapshot full = ChildStatus.compute(120, 0L);
        check(full.remainingSeconds == 7200L && full.remainingPercent == 100,
                "额度 120 分钟、今天还没用：剩余 7200 秒、进度 100%");
        check("今天还剩 2小时".equals(ChildStatus.remainingText(120, 0L)),
                "剩余 2 小时说成「今天还剩 2小时」");
        ChildStatus.Snapshot part = ChildStatus.compute(120, 40 * 60L);
        check(part.remainingSeconds == 4800L && part.remainingPercent == 67,
                "额度 120 分钟、已用 40 分钟：剩余 4800 秒、进度 67%（四舍五入）");
        check("今天还剩 1小时20分钟".equals(ChildStatus.remainingText(120, 40 * 60L)),
                "剩余不足两小时时带上分钟，不四舍五入成「1小时」");
        check("今天已用 40分钟，额度 2小时".equals(ChildStatus.usageText(120, 40 * 60L)),
                "副标题同时给出已用与额度（孩子才知道还剩多少是怎么算出来的）");

        // ---- 3) 已经用完：与「没设额度」必须是两句不同的话 ----
        ChildStatus.Snapshot over = ChildStatus.compute(120, 3 * 3600L);
        check(over.hasLimit && over.exhausted && over.remainingSeconds == 0L
                        && over.remainingPercent == 0,
                "用量超过额度：剩余夹到 0（不出现负数）、进度 0、标记为已用完");
        check("今天的时长已经用完，明天重新开始".equals(ChildStatus.remainingText(120, 3 * 3600L)),
                "用完时说的是明天重新开始，而不是「还剩 0分钟」");

        // ---- 4) 边界：刚好用完算用完；剩不到 1 分钟也不能显示成 0 分钟 ----
        check(ChildStatus.compute(60, 60 * 60L).exhausted,
                "已用正好等于额度算「用完」（与 LockEnforcer 的判定同一个口径）");
        ChildStatus.Snapshot sub = ChildStatus.compute(1, 30L);
        check(!sub.exhausted && sub.remainingSeconds == 30L,
                "额度 1 分钟、已用 30 秒：还没用完，剩余 30 秒");
        check("今天还剩 不到 1 分钟".equals(ChildStatus.remainingText(1, 30L)),
                "剩余不足 1 分钟时说「不到 1 分钟」，不说「还剩 0分钟」");
        check(ChildStatus.compute(10, 600L).exhausted,
                "额度 10 分钟、已用 600 秒：正好用完");

        // ---- 5) 用量时钟异常（回拨成负数）不该变成「欠费」 ----
        ChildStatus.Snapshot weird = ChildStatus.compute(60, -500L);
        check(weird.usedSeconds == 0L && weird.remainingSeconds == 3600L,
                "已用秒数为负时按 0 处理（时钟回拨不该扣掉孩子的额度）");
    }

    static void checkUnlockProbe() {
        System.out.println("\n[还剩多久：能算准才给具体时间，算不准必须说不知道]");

        // 固定时刻（不是 System.currentTimeMillis()，否则用例会随运行时间漂移），
        // 再把它摆到当天的 21:30。
        long friday2130 = 1_800_000_000_000L;
        java.util.Calendar cal = java.util.Calendar.getInstance();
        cal.setTimeInMillis(friday2130);
        cal.set(java.util.Calendar.HOUR_OF_DAY, 21);
        cal.set(java.util.Calendar.MINUTE, 30);
        cal.set(java.util.Calendar.SECOND, 0);
        cal.set(java.util.Calendar.MILLISECOND, 0);
        friday2130 = cal.getTimeInMillis();

        // 父母设的作息：每天 21:00 - 次日 07:00 锁定
        List<Integer> everyDay = new ArrayList<>();
        for (int i = 1; i <= 7; i++) everyDay.add(i);
        ScheduleRule night = new ScheduleRule(
                "r1", "睡觉时间", "lock", everyDay, 21 * 60, 7 * 60, true);

        // ---- 1) 作息锁定：应探出「次日 07:00」 ----
        LockState.Inputs in = new LockState.Inputs();
        in.now = friday2130;
        in.scheduleEnabled = true;
        in.rules = Collections.singletonList(night);
        LockState state = LockState.compute(in);
        check(state.locked && state.reason == LockState.Reason.SCHEDULE,
                "周五 21:30 落在 21:00-次日 07:00 的作息里，判定为锁定");
        long unlockAt = LockState.probeAutoUnlockAt(in);
        java.util.Calendar expect = java.util.Calendar.getInstance();
        expect.setTimeInMillis(friday2130);
        // 跨天区间：21:30 落在窗口里，窗口到次日 07:00 结束
        expect.add(java.util.Calendar.DAY_OF_MONTH, 1);
        expect.set(java.util.Calendar.HOUR_OF_DAY, 7);
        expect.set(java.util.Calendar.MINUTE, 0);
        expect.set(java.util.Calendar.SECOND, 0);
        expect.set(java.util.Calendar.MILLISECOND, 0);
        check(unlockAt == expect.getTimeInMillis(),
                "作息锁定探出的是次日的 07:00 边界（实际 " + (unlockAt - friday2130) / 60_000L
                        + " 分钟后）");

        // ---- 2) 家长远程锁定：往后看 24 小时都还锁着，必须如实说不知道 ----
        LockState.Inputs remote = new LockState.Inputs();
        remote.now = friday2130;
        remote.remoteLocked = true;
        check(LockState.compute(remote).locked, "远程锁定判定为锁定");
        check(LockState.probeAutoUnlockAt(remote) == 0L,
                "远程锁定探不出自动解锁时刻（返回 0，页面才能说「由家长决定」）");

        // ---- 3) 今日额度耗尽：同理，明天重置这件事设备端算不出来 ----
        LockState.Inputs quota = new LockState.Inputs();
        quota.now = friday2130;
        quota.dailyLimitExhausted = true;
        check(LockState.probeAutoUnlockAt(quota) == 0L,
                "今日额度用完探不出自动解锁时刻（返回 0，页面改说「明天重新开始」）");

        // ---- 4) 护眼强制休息：有明确结束时刻，应正好探到那一刻 ----
        LockState.Inputs eye = new LockState.Inputs();
        eye.now = friday2130;
        eye.eyeLockReason = "连续用眼 40 分钟，休息一下";
        eye.eyeLockUntil = friday2130 + 15 * 60_000L;
        check(LockState.compute(eye).locked, "护眼强制休息判定为锁定");
        check(LockState.probeAutoUnlockAt(eye) == eye.eyeLockUntil,
                "护眼休息探出的就是休息结束的那一刻");

        // ---- 5) 已解锁时不该编出一个未来时刻 ----
        LockState.Inputs free = new LockState.Inputs();
        free.now = friday2130;
        check(LockState.probeAutoUnlockAt(free) == free.now,
                "本来就没锁时返回「现在」而不是未来的某个时间");
    }

    /** 同上，但追加一条 EDNS0 OPT 记录（ARCOUNT=1）。真实客户端几乎都会带。 */
    static byte[] dnsQueryWithEdns(int id, String name) {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] base = dnsQuery(id, name);
        out.write(base, 0, base.length);
        byte[] bytes = out.toByteArray();
        bytes[11] = 0x01; // ARCOUNT = 1
        ByteArrayOutputStream all = new ByteArrayOutputStream();
        all.write(bytes, 0, bytes.length);
        all.write(0x00); // 根名字
        all.write(0x00); all.write(0x29); // TYPE = OPT(41)
        all.write(0x10); all.write(0x00); // UDP payload size
        all.write(0x00); all.write(0x00); all.write(0x00); all.write(0x00); // TTL
        all.write(0x00); all.write(0x00); // RDLEN = 0
        return all.toByteArray();
    }

    /**
     * 知情说明页（规划 §3.4）：**页面上写的每一句都必须与代码一致**。
     *
     * <p>这里断言的是「说了什么」和「有没有说假话」，不是「文案好不好看」：
     * 每一类敏感数据都必须有明确结论（采集就说采集、不采集就明说不采集），
     * 而且不能出现「不采集位置」这种与 AndroidManifest 相反的假话。
     * 与清单的机械对照在 run.sh 的第 7 步。
     */
    static void checkGuardianNotice() {
        System.out.println("\n[知情说明：每一类数据都有明确结论，且不说假话]");

        String collect = GuardianNotice.flatten(findSection("会上报给家长什么"));
        String refuse = GuardianNotice.flatten(findSection("不会做什么"));

        // ---- 1) 逐类数据：采集的必须写在「会上报」里，不采集的必须写在「不会做」里 ----
        int collectedTopics = 0;
        int refusedTopics = 0;
        boolean allExplicit = true;
        for (GuardianNotice.Topic topic : GuardianNotice.topics()) {
            if (topic.collected) {
                collectedTopics++;
                if (!collect.contains(topic.label)) {
                    allExplicit = false;
                    System.out.println("      缺少说明：" + topic.label);
                }
            } else {
                refusedTopics++;
                if (!refuse.contains(topic.label)) {
                    allExplicit = false;
                    System.out.println("      缺少说明：" + topic.label);
                }
                // 不采集的东西绝不能出现在「会上报」那一节里 —— 这就是假话
                if (collect.contains(topic.label)) {
                    allExplicit = false;
                    System.out.println("      自相矛盾：" + topic.label);
                }
            }
        }
        check(allExplicit, "每一类敏感数据都有明确结论（收 " + collectedTopics + " 类 / 不收 "
                + refusedTopics + " 类，共 " + GuardianNotice.topics().size() + " 类）");

        // ---- 2) 会采集的东西，页面绝不能说「不采集」 ----
        // 注意：「不会做什么」里**可以**出现已采集项的名字，只要那句话是在交代边界
        // （例如「不录通话内容：通话记录只有号码、时间和时长，没有通话录音」——
        // 这是把「通话记录会上报、但不含录音」讲清楚，不是否认采集）。
        // 所以要拦的是「否认句式」，不是名字本身。
        String[] denialVerbs = {"不采集", "不读", "不记录", "不录", "不上报", "不看", "不查"};
        boolean noFalseDenial = true;
        for (GuardianNotice.Topic topic : GuardianNotice.topics()) {
            if (!topic.collected) {
                continue;
            }
            for (String verb : denialVerbs) {
                if (refuse.contains(verb + topic.label)) {
                    noFalseDenial = false;
                    System.out.println("      假话：" + verb + topic.label);
                }
            }
        }
        check(noFalseDenial, "会上报的数据没有被「不采集 / 不读 / 不上报」否定（交代边界不算否定）");

        // ---- 3) 位置/通话/短信是真实采集项，必须有对应权限撑腰 ----
        check(hasTopic("位置", true) && hasTopic("通话记录", true) && hasTopic("短信正文", true),
                "位置、通话记录、短信正文都被承认会上报（本应用确实有这三个权限）");
        check(!hasTopic("位置", false), "位置不能写成「不采集」");

        // ---- 4) 两个独立权限：半授权时不能合并成一句「已授权」 ----
        check(GuardianNotice.describePhoneData(true, true).contains("已授权，会上报给家长"),
                "通话与短信都授权时说「已授权，会上报给家长」");
        check(GuardianNotice.describePhoneData(false, false).contains("未授权，现在不会上报"),
                "都没授权时说「未授权，现在不会上报」");
        String half = GuardianNotice.describePhoneData(true, false);
        check(half.contains("通话记录：已授权，会上报") && half.contains("短信：未授权，不会上报"),
                "只授权通话时分开说，不糊成一句「已授权」");

        // ---- 5) 顶部状态行按真实开关生成 ----
        List<String> live = GuardianNotice.liveLines(true, 30, true, true, true, true, true);
        String liveText = String.join("\n", live);
        check(liveText.contains("周期截屏：已开启") && liveText.contains("30 秒"),
                "开了周期截屏就说已开启并给出间隔");
        check(!String.join("\n", GuardianNotice.liveLines(false, 30, false, false, false, false, false))
                        .contains("已开启"),
                "没开的时候不说「已开启」");
        check(String.join("\n", GuardianNotice.liveLines(false, 30, true, false, false, false, false))
                        .contains("环境监听：正在录音"),
                "环境监听在跑时如实说「正在录音」");
        check(String.join("\n", GuardianNotice.liveLines(false, 30, false, false, false, false, false))
                        .contains("守护服务：当前没有在运行"),
                "守护服务没在跑时如实说「当前没有在运行」");
        check(String.join("\n", GuardianNotice.liveLines(false, 30, false, false, false, false, true))
                        .contains("本页不会假装有数据"),
                "位置未授权时明说家长看不到，而不是留空让人以为一切正常");

        // ---- 6) 底线与「不留白」 ----
        String all = GuardianNotice.everything(false, 30, false, false, false, false, false);
        check(all.contains("紧急呼叫永远放行"), "写明紧急呼叫永远放行（不可关闭的底线）");
        check(all.contains("不读聊天记录") && all.contains("截图里可能拍到聊天界面"),
                "不读聊天记录，但承认截屏可能拍到聊天界面（有边界就说边界）");
        check(all.contains("需要家长在家长端把这台设备解绑"),
                "解除守护的办法写清楚了（不是「请联系管理员」）");
        check(all.contains("没有藏起来的部分"), "明说这一页没有隐藏项");
        boolean sectionsSolid = true;
        for (GuardianNotice.Section section : GuardianNotice.sections()) {
            if (section.heading.isEmpty() || section.lines.size() < 2) {
                sectionsSolid = false;
            }
        }
        check(sectionsSolid && GuardianNotice.sections().size() >= 6,
                "每一节都有标题与至少两行实质内容（共 " + GuardianNotice.sections().size() + " 节）");
    }

    static GuardianNotice.Section findSection(String heading) {
        for (GuardianNotice.Section section : GuardianNotice.sections()) {
            if (heading.equals(section.heading)) {
                return section;
            }
        }
        throw new IllegalStateException("说明页缺少这一节：" + heading);
    }

    static boolean hasTopic(String label, boolean collected) {
        for (GuardianNotice.Topic topic : GuardianNotice.topics()) {
            if (topic.label.equals(label) && topic.collected == collected) {
                return true;
            }
        }
        return false;
    }


    /**
     * 直连阻断（规划 §4.1）：地址规则匹配、从 DNS 应答里学 IP、TCP RST 的构造。
     *
     * <p>这三样都是「静默出错」型：CIDR 差一位 → 拦不住或误伤正常网站；
     * A 记录解析错 → 把别人的 IP 引进隧道；RST 校验和错 → 对端直接丢弃，
     * 表现为「什么都没发生」，在真机上看不出来。
     */
    // ============================================================
    // 学习模式专用桌面（规划 §4.4）
    // ============================================================

    private static java.util.List<String> packagesOf(java.util.List<StudyLauncher.Entry> entries) {
        java.util.List<String> out = new java.util.ArrayList<>();
        for (StudyLauncher.Entry entry : entries) out.add(entry.packageName);
        return out;
    }

    private static ModeConfig studyConfig(String... apps) {
        return ModeConfig.of(null, true,
                java.util.Collections.<ModeConfig.Slot>emptyList(),
                java.util.Arrays.asList(apps));
    }

    static void checkStudyLauncher() {
        System.out.println("\n[学习模式专用桌面：该不该接管 / 桌面显示哪些应用]");

        check(StudyLauncher.canHoldHome(true, true), "学习模式 + 设备所有者 → 接管桌面");
        check(!StudyLauncher.canHoldHome(true, false), "学习模式但没有设备所有者 → 不接管（系统不允许）");
        check(!StudyLauncher.canHoldHome(false, true), "不是学习模式 → 绝不接管（哪怕有设备所有者）");

        java.util.List<StudyLauncher.Entry> installed = java.util.Arrays.asList(
                new StudyLauncher.Entry("com.game.studio", "游戏", false),
                new StudyLauncher.Entry("com.android.dialer", "电话", true),
                new StudyLauncher.Entry("com.tencent.mm", "微信", false),
                new StudyLauncher.Entry("com.android.systemui", "系统界面", true));

        java.util.List<String> visible = packagesOf(StudyLauncher.entries(studyConfig("com.tencent.mm"), installed));
        check(!visible.contains("com.game.studio"), "白名单之外的应用不出现在学习桌面上");
        check(visible.contains("com.tencent.mm"), "家长允许的应用出现在学习桌面上");
        check(visible.contains("com.android.dialer"), "安全底线的拨号也显示（不然打不出紧急呼叫）");
        check(visible.indexOf("com.tencent.mm") < visible.indexOf("com.android.dialer"),
                "按名字排序（同名时按包名兜底），顺序不能随查询顺序乱跳");

        java.util.List<String> safetyOnly = packagesOf(StudyLauncher.entries(null, installed));
        check(safetyOnly.size() == 2 && safetyOnly.contains("com.android.dialer"),
                "配置为空时只剩安全底线应用（实际 " + safetyOnly.size() + " 个）");

        java.util.List<String> notInstalled = packagesOf(StudyLauncher.entries(studyConfig("com.not.installed"), installed));
        check(!notInstalled.contains("com.not.installed"), "名单里没安装的应用不会凭空出现在桌面上");

        check(StudyLauncher.entries(studyConfig("com.tencent.mm"), java.util.Arrays.asList(
                new StudyLauncher.Entry("com.tencent.mm", "微信", false),
                new StudyLauncher.Entry("com.tencent.mm", "微信（克隆）", false))).size() == 1,
                "同一个包名被两个入口声明时只出现一次");

        check(StudyLauncher.entries(studyConfig("com.tencent.mm"), java.util.Arrays.asList(
                new StudyLauncher.Entry("", "", false),
                new StudyLauncher.Entry(null, null, false))).isEmpty(),
                "空包名/null 条目被跳过（PackageManager 偶发返回空）");

        check(StudyLauncher.entries(studyConfig("com.tencent.mm"), null).isEmpty()
                && StudyLauncher.entries(studyConfig("com.tencent.mm"),
                        java.util.Collections.<StudyLauncher.Entry>emptyList()).isEmpty(),
                "一个应用都查不到时返回空清单而不是 null");

        check(StudyLauncher.noticeText(3).contains("学习模式") && StudyLauncher.noticeText(3).contains("3"),
                "桌面顶部那句话要说清「学习模式」和几个应用");
        check(StudyLauncher.emptyText().contains("家长"), "桌面空着时的提示要指向家长，而不是一句「暂无数据」");
    }

    static void checkChildTasks() {
        System.out.println("\n[孩子端今日任务：显示什么 / 勾动的时候说什么]");

        check(!ChildTasks.visible(0), "一条任务都没有时整块不显示（不给一句「暂无数据」）");
        check(ChildTasks.visible(1) && ChildTasks.visible(7), "有任务就显示（1 条和 7 条都一样）");

        check(ChildTasks.headerText("小明").equals("「小明」今天的任务"), "有档案名时标题带上孩子的名字");
        check(ChildTasks.headerText("  小明  ").equals("「小明」今天的任务"), "名字两边的空白不能进标题（引号会飘）");
        check(ChildTasks.headerText(null).equals("今天的任务")
                && ChildTasks.headerText("   ").equals("今天的任务"),
                "没挂档案（或名字只有空白）时退回「今天的任务」，不出现空的引号对");

        java.util.List<ChildTasks.Task> tasks = new java.util.ArrayList<>();
        tasks.add(new ChildTasks.Task("t1", "练琴 30 分钟", true));
        tasks.add(new ChildTasks.Task("t2", "读英语", false));
        tasks.add(new ChildTasks.Task("t3", "整理书桌", false));
        check(ChildTasks.doneCount(tasks) == 1, "已完成数只数勾上的（3 条里 1 条完成）");

        tasks.add(null);
        check(ChildTasks.doneCount(tasks) == 1, "清单里混进一条 null 不会把进度带偏");
        check(ChildTasks.doneCount(null) == 0, "整份清单为 null 时算 0 条完成，而不是崩");

        check(ChildTasks.progressText(0, 0).contains("家长"), "一条都没有时说「家长还没有布置任务」");
        check(ChildTasks.progressText(1, 3).equals("已完成 1/3"), "有进展时显示「已完成 1/3」");
        check(ChildTasks.progressText(3, 3).contains("真棒")
                && ChildTasks.progressText(4, 3).contains("真棒"),
                "全做完时换一句夸奖（多算出来的也按全完成处理，不说 4/3）");

        check(ChildTasks.pendingText(true).contains("告诉家长")
                && ChildTasks.pendingText(false).contains("取消"),
                "请求在路上时分勾上 / 取消两种说法");
        check(ChildTasks.failureText(true).contains("告诉家长")
                && ChildTasks.failureText(false).contains("取消")
                && !ChildTasks.failureText(true).equals(ChildTasks.failureText(false)),
                "失败也要分方向说清「没能告诉家长」还是「没能取消」");

        ChildTasks.Task task = new ChildTasks.Task("t9", "倒垃圾", false);
        task.done = true;
        check(task.done && task.id.equals("t9") && task.title.equals("倒垃圾"),
                "勾选只改 done（本地乐观改的就是这一个字段）");
        check(ChildTasks.none().isEmpty() && ChildTasks.none() != null,
                "没有任务时返回空清单而不是 null（调用方不用再判空）");
    }

    private static void checkBlockedAddresses() {
        System.out.println("\n[直连阻断：地址规则]");
        check(BlockedAddresses.parseIpv4("1.2.3.4") == 0x01020304L, "IPv4 解析成 32 位无符号数");
        check(BlockedAddresses.parseIpv4("1.2.3.256") < 0 && BlockedAddresses.parseIpv4("1.2.3") < 0
                && BlockedAddresses.parseIpv4("1.2.3.4.5") < 0, "256 / 三段 / 五段都不算 IPv4");
        check(BlockedAddresses.isIpLiteral("1.2.3.4") && BlockedAddresses.isIpLiteral("::1")
                && !BlockedAddresses.isIpLiteral("example.com")
                && !BlockedAddresses.isIpLiteral("1.2.3.4.5"), "IP 字面量识别不会把域名算进来");

        check(BlockedAddresses.matches("1.2.3.255", "1.2.3.0/24")
                        && !BlockedAddresses.matches("1.2.4.0", "1.2.3.0/24"),
                "CIDR 只覆盖本网段（1.2.3.255 命中、1.2.4.0 不命中）");
        check(BlockedAddresses.matches("8.8.8.8", "1.2.3.0/0"), "/0 覆盖一切");
        check(!BlockedAddresses.matches("1.2.3.4", "1.2.3.0/33")
                && !BlockedAddresses.matches("1.2.3.4", "1.2.3.0/-1"), "前缀长度越界一律不命中（不猜）");
        check(!BlockedAddresses.matches("1.2.3.4", "garbage/24")
                && !BlockedAddresses.matches("1.2.3.4", ""), "坏规则不命中");
        check(BlockedAddresses.matches("1.2.3.4", "1.2.3.4")
                && !BlockedAddresses.matches("1.2.3.4", "1.2.3.5"), "字面量规则是精确匹配");
        check("1.2.3.0/24".equals(BlockedAddresses.normalizeAddressRule("1.2.3.7/24")),
                "CIDR 的主机位被清零（同一网段只有一种写法，免得被当成两条路由）");
        check("1.2.3.4".equals(BlockedAddresses.normalizeAddressRule(" 1.2.3.4 "))
                && BlockedAddresses.normalizeAddressRule("example.com") == null
                && BlockedAddresses.normalizeAddressRule("*.example.com") == null,
                "域名不是地址规则（域名要靠解析，这里不假装）");

        List<String> rules = BlockedAddresses.addressRules(
                Arrays.asList("1.2.3.0/24", "example.com", "1.2.3.4", "1.2.3.0/24"));
        check(rules.size() == 2 && rules.contains("1.2.3.0/24") && rules.contains("1.2.3.4"),
                "混合列表里只挑出地址并去重（域名交给解析那条路）");
        check(BlockedAddresses.routeKeys(Arrays.asList("1.2.3.4", "1.2.3.0/24", "1.2.3.0/24"))
                        .equals(Arrays.asList("1.2.3.0/24", "1.2.3.4/32")),
                "路由键排序去重（隧道要不要重建就看它变没变）");
        check(BlockedAddresses.routeFor("1.2.3.4").prefixLength == 32
                && BlockedAddresses.routeFor("::1").prefixLength == 128
                && BlockedAddresses.routeFor("example.com") == null,
                "路由：v4 /32、v6 /128、域名没有路由");
        check(BlockedAddresses.isEncryptedDnsPort(853) && BlockedAddresses.isEncryptedDnsPort(784)
                && BlockedAddresses.isEncryptedDnsPort(8853)
                && !BlockedAddresses.isEncryptedDnsPort(443)
                && !BlockedAddresses.isEncryptedDnsPort(53),
                "853/784/8853 算加密 DNS，443 不算（DoH 与普通 HTTPS 在包里无法区分，不制造假安全感）");
        check(BlockedAddresses.anyMatches("1.2.3.9", rules)
                && !BlockedAddresses.anyMatches("9.9.9.9", rules), "一组规则里任意一条命中即算命中");

        check(DomainBlocker.splitEntries("gambling.com, 1.2.3.4, 10.0.0.0/8").size() == 3,
                "splitEntries 保留 IP 与网段（网段里的斜杠不是 URL 路径，不能被砍成 10.0.0.0）");
        check(DomainBlocker.splitEntries("10.0.0.0/8").contains("10.0.0.0/8")
                && !DomainBlocker.parseList("10.0.0.0/8").contains("10.0.0.0/8")
                && DomainBlocker.parseList("gambling.com, 1.2.3.4").size() == 1,
                "域名匹配表（parseList）照旧丢掉 IP —— 两条链路各取所需，不互相污染");

        System.out.println("\n[直连阻断：从 DNS 应答里学 IP]");
        byte[] query = DnsMessage.buildQuery("gambling.com", 0x1234);
        check(query != null && DnsMessage.isStandardQuery(query)
                        && "gambling.com".equals(DnsMessage.firstQuestionName(query)),
                "自己构造的查询能被自己的解析器读回（域名 + 标准查询位）");
        check(query != null && DnsMessage.questionsEnd(query) == query.length,
                "查询的问题段正好落在报文末尾（QTYPE/QCLASS 紧跟其后，没有多余字节）");
        check(query != null && DnsMessage.questionCount(query) == 1,
                "查询只带一个问题（多了上游会当成畸形包）");
        check(DnsMessage.buildQuery("bad..label", 1) == null && DnsMessage.buildQuery("", 1) == null
                && DnsMessage.buildQuery(null, 1) == null,
                "空域名与空标签不构造查询（宁可不问，也不发畸形包）");

        byte[] answer = dnsAnswerWithAddresses("gambling.com", new String[]{"1.2.3.4", "5.6.7.8"});
        List<String> learned = DnsMessage.parseIpv4Answers(answer);
        check(learned.size() == 2 && learned.contains("1.2.3.4") && learned.contains("5.6.7.8"),
                "A 记录被逐条取出（含名字压缩指针）");
        check(DnsMessage.parseIpv4Answers(dnsAnswerWithAddresses("a.com", new String[]{"9.9.9.9"}))
                        .equals(Collections.singletonList("9.9.9.9")),
                "单条 A 记录也正确");

        List<String> onlyA = DnsMessage.parseIpv4Answers(dnsAnswerWithCnameThenAddress("gambling.com", "1.2.3.4"));
        check(onlyA.size() == 1 && "1.2.3.4".equals(onlyA.get(0)),
                "跳过 CNAME（非 A 记录整条跳，不能把它的字节当成地址）");
        check(DnsMessage.parseIpv4Answers(Arrays.copyOf(answer, answer.length - 3)).size() <= 2,
                "截断的应答不抛异常（拿到几条算几条，少拦一个 IP 也别让链路停摆）");
        check(DnsMessage.parseIpv4Answers(new byte[]{1, 2, 3}).isEmpty(), "太短的应答返回空列表");
        byte[] huge = dnsAnswerWithAddresses("a.com", new String[]{"1.2.3.4"});
        huge[6] = 0x7F;
        huge[7] = (byte) 0xFF;
        check(DnsMessage.parseIpv4Answers(huge).isEmpty(), "应答条数离谱时直接放弃（畸形包不猜）");

        System.out.println("\n[直连阻断：TCP RST 立刻拒绝]");
        byte[] syn = tcpPacket("10.0.0.5", 12345, "1.2.3.4", 443, 0x11223344L, IpPackets.TCP_SYN);
        check("1.2.3.4".equals(IpPackets.destIpv4(syn)) && "10.0.0.5".equals(IpPackets.sourceIpv4(syn))
                        && IpPackets.destPort(syn) == 443 && IpPackets.sourcePort(syn) == 12345
                        && IpPackets.protocol(syn) == IpPackets.PROTOCOL_TCP,
                "五元组读得对（这是判定的全部依据）");
        byte[] reset = IpPackets.buildTcpReset(syn);
        check(reset != null && reset.length == 40, "RST 是 40 字节（无选项的 IP 头 + TCP 头）");
        check(IpPackets.sourcePort(reset) == 443 && IpPackets.destPort(reset) == 12345,
                "RST 的源/目的端口对调（从被连的一方发回）");
        check("1.2.3.4".equals(IpPackets.sourceIpv4(reset))
                        && "10.0.0.5".equals(IpPackets.destIpv4(reset)), "RST 的源/目的地址对调");
        check((IpPackets.tcpFlags(reset) & (IpPackets.TCP_RST | IpPackets.TCP_ACK))
                        == (IpPackets.TCP_RST | IpPackets.TCP_ACK), "对 SYN 回 RST|ACK");
        check(IpPackets.readU32(reset, 28) == 0x11223345L, "ack = 对方 seq + 1");
        check(IpPackets.readU32(reset, 24) == 0L, "对 SYN 的 RST，seq 取 0");
        check(IpPackets.ipChecksum(reset, 20) == 0, "IP 头校验和自校验为 0（错一位对端就静默丢弃）");
        check(IpPackets.tcpChecksum(reset) == 0, "TCP 校验和（含伪头）自校验为 0");

        byte[] ackOnly = tcpPacket("10.0.0.5", 12345, "1.2.3.4", 443, 0x11223344L, IpPackets.TCP_ACK);
        ackOnly[28] = 0x11;
        ackOnly[29] = 0x22;
        ackOnly[30] = 0x33;
        ackOnly[31] = 0x44;
        byte[] reset2 = IpPackets.buildTcpReset(ackOnly);
        check(reset2 != null && IpPackets.tcpFlags(reset2) == IpPackets.TCP_RST
                        && IpPackets.readU32(reset2, 24) == 0x11223344L,
                "非 SYN 的报文回纯 RST，seq 取对方的 ack");
        byte[] udp = new byte[28];
        udp[0] = 0x45;
        udp[9] = (byte) IpPackets.PROTOCOL_UDP;
        IpPackets.writeU16(udp, 2, 28);
        check(IpPackets.buildTcpReset(udp) == null, "UDP 没有 RST 可回（静默丢弃）");
        check(IpPackets.buildTcpReset(new byte[]{1, 2, 3}) == null, "太短的包不构造 RST");

        byte[] withOptions = new byte[44];
        System.arraycopy(syn, 0, withOptions, 0, 20);
        System.arraycopy(syn, 20, withOptions, 24, 20);
        withOptions[0] = 0x46;
        check("1.2.3.4".equals(IpPackets.destIpv4(withOptions)) && IpPackets.destPort(withOptions) == 443,
                "带 IP 选项的报文也读得对（端口按 IHL 偏移，不写死 20）");
        byte[] resetWithOptions = IpPackets.buildTcpReset(withOptions);
        check(resetWithOptions != null && resetWithOptions.length == 40
                        && IpPackets.ipChecksum(resetWithOptions, 20) == 0,
                "带选项的报文也能回出合法 RST（新头固定 20 字节并重算校验和）");
    }

    /** 造一条 IPv4/TCP 报文（20 字节 IP 头 + 20 字节 TCP 头，校验和留 0 —— 这里不校验它）。 */
    private static byte[] tcpPacket(String srcIp, int srcPort, String dstIp, int dstPort,
                                    long seq, int flags) {
        byte[] packet = new byte[40];
        packet[0] = 0x45;
        IpPackets.writeU16(packet, 2, 40);
        packet[8] = 64;
        packet[9] = (byte) IpPackets.PROTOCOL_TCP;
        writeIpv4(packet, 12, srcIp);
        writeIpv4(packet, 16, dstIp);
        IpPackets.writeU16(packet, 20, srcPort);
        IpPackets.writeU16(packet, 22, dstPort);
        IpPackets.writeU32(packet, 24, seq);
        packet[32] = 0x50;
        packet[33] = (byte) flags;
        return packet;
    }

    private static void writeIpv4(byte[] packet, int offset, String ip) {
        String[] parts = ip.split("\\.");
        for (int i = 0; i < 4; i++) packet[offset + i] = (byte) Integer.parseInt(parts[i]);
    }

    /** 造一条 DNS 应答：一个问题 + N 条 A 记录（记录名用压缩指针指回问题段）。 */
    private static byte[] dnsAnswerWithAddresses(String host, String[] addresses) {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        writeDnsHeader(out, addresses.length);
        writeDnsQuestion(out, host);
        for (String address : addresses) {
            out.write(0xC0);
            out.write(0x0C);
            writeDnsRecordHead(out, 4);
            String[] parts = address.split("\\.");
            for (int i = 0; i < 4; i++) out.write(Integer.parseInt(parts[i]));
        }
        return out.toByteArray();
    }

    /** 造一条 DNS 应答：先一条 CNAME（要整条跳过），再一条 A。 */
    private static byte[] dnsAnswerWithCnameThenAddress(String host, String address) {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        writeDnsHeader(out, 2);
        writeDnsQuestion(out, host);
        // CNAME：名字指回问题段，RDLENGTH=2，内容是另一个指针
        out.write(0xC0);
        out.write(0x0C);
        writeDnsRecordHead(out, 2);
        out.write(0xC0);
        out.write(0x0C);
        // A 记录
        out.write(0xC0);
        out.write(0x0C);
        writeDnsRecordHead(out, 4);
        String[] parts = address.split("\\.");
        for (int i = 0; i < 4; i++) out.write(Integer.parseInt(parts[i]));
        return out.toByteArray();
    }

    private static void writeDnsHeader(ByteArrayOutputStream out, int answerCount) {
        out.write(0x12);
        out.write(0x34);
        out.write(0x81); // QR=1
        out.write(0x80);
        out.write(0x00);
        out.write(0x01); // QDCOUNT
        out.write((answerCount >> 8) & 0xFF);
        out.write(answerCount & 0xFF);
        out.write(0x00);
        out.write(0x00);
        out.write(0x00);
        out.write(0x00);
    }

    private static void writeDnsQuestion(ByteArrayOutputStream out, String host) {
        for (String label : host.split("\\.")) {
            out.write(label.length());
            for (int i = 0; i < label.length(); i++) out.write(label.charAt(i));
        }
        out.write(0);
        out.write(0x00);
        out.write(0x01); // QTYPE A
        out.write(0x00);
        out.write(0x01); // QCLASS IN
    }

    /** TYPE=A / CLASS=IN / TTL=300 / RDLENGTH，名字与 RDATA 由调用方写。 */
    private static void writeDnsRecordHead(ByteArrayOutputStream out, int rdLength) {
        out.write(0x00);
        out.write(0x01); // TYPE A
        out.write(0x00);
        out.write(0x01); // CLASS IN
        out.write(0x00);
        out.write(0x00);
        out.write(0x01);
        out.write(0x2C); // TTL 300
        out.write((rdLength >> 8) & 0xFF);
        out.write(rdLength & 0xFF);
    }
}
