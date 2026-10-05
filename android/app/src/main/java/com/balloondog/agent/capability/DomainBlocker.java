package com.balloondog.agent.capability;

import androidx.annotation.Nullable;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Locale;

/**
 * 网址拦截的黑名单匹配（契约 §5）。
 *
 * <p>刻意做成<b>零 Android 依赖的纯函数</b>：DNS 过滤那条链路上唯一能脱离真机验证的
 * 就是「这个名字该不该拦」，所以把它单独拎出来，交给 JVM 交叉测试（crosstest/GuardCheck）守住。
 *
 * <p>匹配口径是<b>域名后缀</b>：
 * <ul>
 *   <li>{@code example.com} 拦 {@code example.com} 与 {@code a.b.example.com}；</li>
 *   <li>但<b>不</b>拦 {@code notexample.com}（必须落在点边界上，否则
 *       {@code evil-example.com} 这种会被误伤，而误伤在家长那里就是「网站打不开」的投诉）；</li>
 *   <li>大小写不敏感，末尾的点（DNS 根写法）统一去掉。</li>
 * </ul>
 *
 * <p>服务端存的字段是「域名或网址」（{@code BlockedUrl.url}），所以这里要先把
 * {@code https://example.com/foo?x=1} 归一化成 {@code example.com}。
 * 归一化后如果是 IP 字面量则<b>跳过</b>：IP 不经过 DNS 解析，放在这里只会给人
 * 「已经拦住了」的错觉 —— 这类绕过写进 README，不在这里假装能拦。
 */
public final class DomainBlocker {

    private DomainBlocker() {
    }

    /**
     * 把服务端下发的逗号分隔串切成规整的条目列表。
     *
     * <p>顺带容忍换行与空格分隔：这些串是人手工维护的，出现分隔符混用很正常，
     * 因为一个分隔符就整条失效是最糟的结果。
     */
    public static List<String> parseList(@Nullable String joined) {
        if (joined == null || joined.trim().isEmpty()) return Collections.emptyList();
        List<String> result = new ArrayList<>();
        for (String raw : joined.split("[,，\\s]+")) {
            String entry = normalize(raw);
            if (entry != null && !result.contains(entry)) result.add(entry);
        }
        return result;
    }

    /**
     * 归一化一条黑名单条目。
     *
     * @return 主机名（小写、无 scheme/路径/端口/尾点）；无法作为域名使用时返回 null
     */
    @Nullable
    public static String normalize(@Nullable String entry) {
        if (entry == null) return null;
        String value = entry.trim().toLowerCase(Locale.US);
        if (value.isEmpty()) return null;

        // 去掉 scheme
        int scheme = value.indexOf("://");
        if (scheme >= 0) value = value.substring(scheme + 3);
        // 去掉 userinfo@（极少见，但出现了就会让主机名解析错）
        int at = value.indexOf('@');
        if (at >= 0) value = value.substring(at + 1);
        // 去掉路径/查询/片段
        for (String separator : new String[]{"/", "?", "#"}) {
            int index = value.indexOf(separator);
            if (index >= 0) value = value.substring(0, index);
        }
        // 去掉端口（主机名里不会出现冒号；IPv6 字面量在下面会被整体丢弃）
        int colon = value.indexOf(':');
        if (colon >= 0) value = value.substring(0, colon);

        while (value.startsWith(".")) value = value.substring(1);
        while (value.endsWith(".")) value = value.substring(0, value.length() - 1);
        if (value.isEmpty()) return null;

        // 通配写法 "*.example.com" → example.com（后缀匹配本来就覆盖子域）
        if (value.startsWith("*.")) value = value.substring(2);
        if (value.isEmpty()) return null;

        if (isIpLiteral(value)) return null;
        // 必须像个域名：至少一个点，且不含空格
        if (!value.contains(".") || value.contains(" ")) return null;
        // 只保留合法字符，避免把奇奇怪怪的东西塞进匹配表
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            boolean ok = (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9')
                    || c == '.' || c == '-' || c == '_';
            if (!ok) return null;
        }
        return value;
    }

    /** 该主机名是否命中黑名单里任意一条（后缀匹配）。 */
    public static boolean isBlocked(List<String> entries, @Nullable String host) {
        String name = normalizeHost(host);
        if (name == null) return false;
        for (String entry : entries) {
            if (matches(name, entry)) return true;
        }
        return false;
    }

    /** 单条匹配：{@code host} 等于 {@code entry} 或落在它的子域里。 */
    public static boolean matches(@Nullable String host, @Nullable String entry) {
        String name = normalizeHost(host);
        if (name == null || entry == null || entry.isEmpty()) return false;
        if (name.equals(entry)) return true;
        return name.length() > entry.length() + 1 && name.endsWith("." + entry);
    }

    @Nullable
    private static String normalizeHost(@Nullable String host) {
        if (host == null) return null;
        String value = host.trim().toLowerCase(Locale.US);
        while (value.endsWith(".")) value = value.substring(0, value.length() - 1);
        return value.isEmpty() ? null : value;
    }

    private static boolean isIpLiteral(String value) {
        if (value.contains(":")) return true; // IPv6
        String[] parts = value.split("\\.", -1);
        if (parts.length != 4) return false;
        for (String part : parts) {
            if (part.isEmpty() || part.length() > 3) return false;
            for (int i = 0; i < part.length(); i++) {
                if (part.charAt(i) < '0' || part.charAt(i) > '9') return false;
            }
        }
        return true;
    }
}
