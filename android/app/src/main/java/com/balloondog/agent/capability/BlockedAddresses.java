package com.balloondog.agent.capability;

import androidx.annotation.Nullable;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import java.util.Locale;

/**
 * 「把流量引进隧道」的地址集合：IP 字面量 / CIDR 规则的解析与匹配（契约 §5，规划 §4.1）。
 *
 * <h3>它解决的问题</h3>
 * 只拦 DNS 有一个天然漏洞：域名解析出来之后，IP 就留在应用自己的缓存里了。
 * 家长今天把 {@code gambling.com} 加进黑名单，孩子昨天解析到的 IP 照样能连，
 * 而且直连 IP（连域名都不需要）从来不会经过 53 端口。
 *
 * <p>做法是：把「这个名字对应的 IP」变成隧道的一条 {@code /32} 路由 ——
 * 路由是内核级的，管你从哪拿到这个 IP、用什么端口（含 853 的 DoT），
 * 只要目的地是它，包就会进 tun，我们就可以丢掉。
 *
 * <h3>为什么是纯 Java</h3>
 * 「哪些条目是 IP、它和哪个网段重叠」这类判断错了，孩子那边就是「网站打不开」或者
 * 「拦不住」，而这两种错在真机上都不好看出来。所以它是零 Android 依赖的纯函数，
 * 由 JVM 交叉测试守住。
 *
 * <h3>几条刻意的口径</h3>
 * <ul>
 *   <li><b>域名条目不算地址</b>：域名要靠解析才知道 IP，那是服务里做的事；
 *       这里只认「本来就是 IP / IP 段」的条目。</li>
 *   <li><b>IPv4 支持 CIDR，IPv6 只支持字面量</b>：IPv6 的 /N 要按 128 位算，
 *       而隧道地址是 IPv4、tun 上实际也收不到 v6 包；这里只把它当「要加进路由表的
 *       精确地址」对待，不假装支持网段。</li>
 *   <li><b>加密 DNS 端口是「分类」不是「开关」</b>：853（DoT）、784、8853（DoQ）
 *       被丢的时候会单独计数，好让家长看到「孩子试过加密 DNS」；
 *       {@code 443}（DoH）<b>故意不列</b> —— 443 上的 HTTPS 与 DoH 在包里长得一模一样，
 *       把它算成「加密 DNS」只会制造虚假的安全感。</li>
 * </ul>
 */
public final class BlockedAddresses {

    /** 加密 DNS 常用端口：DoT 853、DoQ 784 / 8853。DoH（443）故意不在内，见类注释。 */
    private static final int[] ENCRYPTED_DNS_PORTS = {853, 784, 8853};

    private BlockedAddresses() {
    }

    /** 这个端口是不是已知的加密 DNS 端口（DoH 的 443 不算）。 */
    public static boolean isEncryptedDnsPort(int port) {
        for (int candidate : ENCRYPTED_DNS_PORTS) {
            if (candidate == port) return true;
        }
        return false;
    }

    /** 是不是 IPv4 字面量（四段十进制、每段 0-255）。 */
    public static boolean isIpv4Literal(@Nullable String value) {
        return parseIpv4(value) >= 0;
    }

    /**
     * 是不是 IPv6 字面量。
     *
     * <p>只做「看起来像」的判断（含冒号、含至少一个十六进制块），不做完整校验 ——
     * 这里唯一的用途是「别把 IPv6 当成域名塞进黑名单匹配表」，
     * 而完整的 IPv6 解析器投入产出比太低。
     */
    public static boolean isIpv6Literal(@Nullable String value) {
        if (value == null) return false;
        String v = value.trim().toLowerCase(Locale.US);
        if (!v.contains(":") || v.contains(" ")) return false;
        if (v.contains(".")) return false; // IPv4-mapped 另说，这里一律不当 v6
        return v.matches("[0-9a-f:]+") && v.contains(":");
    }

    /** 是不是 IP 字面量（v4 或 v6）。 */
    public static boolean isIpLiteral(@Nullable String value) {
        return isIpv4Literal(value) || isIpv6Literal(value);
    }

    /**
     * 把 IPv4 点分十进制解析成无符号 32 位（放在 long 里）。
     *
     * @return 0..4294967295；不合法返回 -1
     */
    public static long parseIpv4(@Nullable String value) {
        if (value == null) return -1;
        String v = value.trim();
        String[] parts = v.split("\\.", -1);
        if (parts.length != 4) return -1;
        long result = 0;
        for (String part : parts) {
            if (part.isEmpty() || part.length() > 3) return -1;
            int number = 0;
            for (int i = 0; i < part.length(); i++) {
                char c = part.charAt(i);
                if (c < '0' || c > '9') return -1;
                number = number * 10 + (c - '0');
            }
            if (number > 255) return -1;
            result = (result << 8) | number;
        }
        return result;
    }

    /**
     * {@code ip} 是否落在 {@code rule} 里。
     *
     * <p>{@code rule} 可以是字面量（{@code 1.2.3.4}）或 CIDR（{@code 1.2.3.0/24}）；
     * IPv6 只在字面量精确相等时算命中。
     */
    public static boolean matches(@Nullable String ip, @Nullable String rule) {
        if (ip == null || rule == null) return false;
        String target = ip.trim();
        String candidate = rule.trim();
        if (candidate.isEmpty()) return false;

        long targetValue = parseIpv4(target);
        int slash = candidate.indexOf('/');
        if (slash < 0) {
            if (targetValue >= 0) {
                return targetValue == parseIpv4(candidate);
            }
            return isIpv6Literal(target) && target.equalsIgnoreCase(candidate);
        }

        if (targetValue < 0) return false; // IPv6 网段不支持，见类注释
        String networkPart = candidate.substring(0, slash);
        long network = parseIpv4(networkPart);
        if (network < 0) return false;
        int prefix;
        try {
            prefix = Integer.parseInt(candidate.substring(slash + 1).trim());
        } catch (NumberFormatException e) {
            return false;
        }
        if (prefix < 0 || prefix > 32) return false;
        if (prefix == 0) return true;
        long mask = (0xFFFFFFFFL << (32 - prefix)) & 0xFFFFFFFFL;
        return (targetValue & mask) == (network & mask);
    }

    /**
     * 把一条规则变成 {@code VpnService.Builder.addRoute} 用的「地址 + 前缀长度」。
     *
     * @return {@code {地址文本, 前缀长度}}；不是 IP 返回 null
     */
    @Nullable
    public static Route routeFor(@Nullable String ip) {
        if (ip == null) return null;
        String value = ip.trim();
        long parsed = parseIpv4(value);
        if (parsed >= 0) return new Route(value, 32);
        if (isIpv6Literal(value)) return new Route(value.toLowerCase(Locale.US), 128);
        return null;
    }

    /**
     * 从黑名单条目里挑出「本来就是地址」的那些（IP 字面量与 CIDR）。
     *
     * <p>顺序保留、去重，且 CIDR 会先做一次规范化（{@code 1.2.3.7/24 → 1.2.3.0/24}），
     * 免得同一段被写两遍。
     */
    public static List<String> addressRules(@Nullable List<String> entries) {
        List<String> result = new ArrayList<>();
        if (entries == null) return result;
        for (String entry : entries) {
            String rule = normalizeAddressRule(entry);
            if (rule != null && !result.contains(rule)) result.add(rule);
        }
        return result;
    }

    /**
     * 规范化一条地址规则；不是地址返回 null。
     *
     * <p>CIDR 会把主机位清零（{@code 1.2.3.7/24 → 1.2.3.0/24}）——
     * 内核路由表本来也只认网络地址，早点统一成一种写法，比较时就不会出现
     * 「同一个网段被当成两条路由」。
     */
    @Nullable
    public static String normalizeAddressRule(@Nullable String entry) {
        if (entry == null) return null;
        String value = entry.trim().toLowerCase(Locale.US);
        if (value.isEmpty()) return null;
        while (value.startsWith(".")) value = value.substring(1);

        long parsed = parseIpv4(value);
        if (parsed >= 0) return value;

        int slash = value.indexOf('/');
        if (slash <= 0) return isIpv6Literal(value) ? value : null;
        String networkPart = value.substring(0, slash);
        long network = parseIpv4(networkPart);
        if (network < 0) return null;
        int prefix;
        try {
            prefix = Integer.parseInt(value.substring(slash + 1).trim());
        } catch (NumberFormatException e) {
            return null;
        }
        if (prefix < 0 || prefix > 32) return null;
        long mask = prefix == 0 ? 0 : (0xFFFFFFFFL << (32 - prefix)) & 0xFFFFFFFFL;
        return formatIpv4(network & mask) + "/" + prefix;
    }

    /** 一组规则里有没有任何一条命中这个地址。 */
    public static boolean anyMatches(@Nullable String ip, @Nullable List<String> rules) {
        if (ip == null || rules == null) return false;
        for (String rule : rules) {
            if (matches(ip, rule)) return true;
        }
        return false;
    }

    /** 去重后加上一条地址（用于「按 DNS 应答学到的新 IP」累加）。 */
    public static void addIp(List<String> target, @Nullable String ip) {
        String rule = normalizeAddressRule(ip);
        if (rule != null && !target.contains(rule)) target.add(rule);
    }

    public static String formatIpv4(long value) {
        return ((value >> 24) & 0xFF) + "." + ((value >> 16) & 0xFF) + "."
                + ((value >> 8) & 0xFF) + "." + (value & 0xFF);
    }

    /** 一条要加进隧道的路由。 */
    public static final class Route {
        public final String address;
        public final int prefixLength;

        public Route(String address, int prefixLength) {
            this.address = address;
            this.prefixLength = prefixLength;
        }

        /** 路由表的键（用来判断「路由集合有没有变」，避免无谓地重建隧道）。 */
        public String key() {
            return address + "/" + prefixLength;
        }

        @Override
        public boolean equals(Object other) {
            return other instanceof Route && key().equals(((Route) other).key());
        }

        @Override
        public int hashCode() {
            return key().hashCode();
        }

        @Override
        public String toString() {
            return key();
        }
    }

    /** 把若干条规则展开成路由键列表（排序后，便于比较）。 */
    public static List<String> routeKeys(@Nullable List<String> rules) {
        List<String> keys = new ArrayList<>();
        if (rules == null) return keys;
        for (String rule : rules) {
            int slash = rule.indexOf('/');
            String address = slash < 0 ? rule : rule.substring(0, slash);
            int prefix = slash < 0 ? 32 : parsePrefix(rule, slash);
            if (address.isEmpty() || prefix < 0) continue;
            Route route = new Route(address, prefix);
            if (!keys.contains(route.key())) keys.add(route.key());
        }
        Collections.sort(keys);
        return keys;
    }

    private static int parsePrefix(String rule, int slash) {
        try {
            return Integer.parseInt(rule.substring(slash + 1));
        } catch (NumberFormatException e) {
            return -1;
        }
    }

    /** 常见公共加密 DNS 解析器的地址（只用于文案与统计，不自动拦截，见类注释）。 */
    public static List<String> knownEncryptedDnsResolvers() {
        return Collections.unmodifiableList(Arrays.asList(
                "1.1.1.1", "1.0.0.1", "8.8.8.8", "8.8.4.4", "9.9.9.9",
                "94.140.14.14", "223.5.5.5", "119.29.29.29", "180.76.76.76"));
    }
}
