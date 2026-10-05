import com.balloondog.agent.capability.DnsMessage;
import com.balloondog.agent.capability.DomainBlocker;
import com.balloondog.agent.capability.Geofence;
import com.balloondog.agent.capability.GuardRules;
import com.balloondog.agent.model.AppLimitRule;
import com.balloondog.agent.model.SafeZone;

import java.io.ByteArrayOutputStream;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * 本轮新增的「纯逻辑」的单元测试：安全区（§2）、应用限时判定（§4）、网址归一化与 DNS 报文（§5）。
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
}
