package com.balloondog.agent.capability;

import androidx.annotation.Nullable;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

/**
 * DNS 报文的读与「伪造拒绝应答」（契约 §5）。
 *
 * <p>同样是<b>零 Android 依赖的纯字节处理</b>，因为这是整条 VPN 链路里最容易写错、
 * 又最需要被自动化测试按住的一段：DNS 报文全是长度前缀 + 紧凑二进制，
 * 越界一位就是设备上「拦截没生效」或者「整个网络解析不了」。
 * 交给 JVM 交叉测试，比在真机上靠肉眼试靠谱。
 *
 * <p>只实现「看」和「答 NXDOMAIN」两件事，不做完整 DNS 库：
 * <ul>
 *   <li>上游应答是原样转发的，不需要解析；</li>
 *   <li>被拦时的应答只回问题段，不带任何附加记录（NXDOMAIN 本来就不该有 ANSWER）。</li>
 * </ul>
 */
public final class DnsMessage {

    /** DNS 头长度。 */
    public static final int HEADER_LENGTH = 12;

    /** RCODE：域名不存在。 */
    public static final int RCODE_NXDOMAIN = 3;

    private DnsMessage() {
    }

    /** 是否是标准查询（QR=0 且 opcode=0）。其它类型（应答、更新等）一律不碰。 */
    public static boolean isStandardQuery(byte[] message) {
        if (message == null || message.length < HEADER_LENGTH) return false;
        int qr = (message[2] >> 7) & 0x01;
        int opcode = (message[2] >> 3) & 0x0F;
        return qr == 0 && opcode == 0;
    }

    public static int questionCount(byte[] message) {
        if (message == null || message.length < HEADER_LENGTH) return 0;
        return ((message[4] & 0xFF) << 8) | (message[5] & 0xFF);
    }

    /**
     * 问题段（QUESTION）结束后的偏移。
     *
     * @return 偏移量；报文不完整或名字里有非法长度时返回 -1（调用方应改为原样转发）
     */
    public static int questionsEnd(byte[] message) {
        if (message == null || message.length < HEADER_LENGTH) return -1;
        int count = questionCount(message);
        if (count <= 0 || count > 8) return -1; // 正常查询就是 1 条，给到 8 已经非常宽松
        int offset = HEADER_LENGTH;
        for (int i = 0; i < count; i++) {
            int next = skipName(message, offset);
            if (next < 0) return -1;
            // QTYPE + QCLASS
            next += 4;
            if (next > message.length) return -1;
            offset = next;
        }
        return offset;
    }

    /**
     * 取出第一条问题的域名（小写）。
     *
     * @return 域名；解析失败返回 null
     */
    @Nullable
    public static String firstQuestionName(byte[] message) {
        if (message == null || message.length < HEADER_LENGTH) return null;
        if (questionCount(message) <= 0) return null;
        StringBuilder sb = new StringBuilder();
        int offset = HEADER_LENGTH;
        while (offset < message.length) {
            int length = message[offset] & 0xFF;
            if (length == 0) return sb.length() == 0 ? null : sb.toString();
            if ((length & 0xC0) == 0xC0) return sb.length() == 0 ? null : sb.toString(); // 指针：查询里罕见，够用就停
            if (length > 63) return null;
            offset++;
            if (offset + length > message.length) return null;
            if (sb.length() > 0) sb.append('.');
            sb.append(new String(message, offset, length, StandardCharsets.US_ASCII));
            offset += length;
            if (sb.length() > 253) return null;
        }
        return null;
    }

    /**
     * 针对一个查询构造 NXDOMAIN 应答。
     *
     * <p>为什么是 NXDOMAIN 而不是 {@code 0.0.0.0}：前者语义就是「这个域名不存在」，
     * 浏览器会立刻报域名解析失败；后者会让浏览器去连 {@code 0.0.0.0} 然后超时卡住几十秒，
     * 孩子看到的是一张转圈的白页 —— 那更像「网络坏了」，不如直白地解析失败。
     *
     * <p>问题段原样保留（客户端据此核对事务），但<b>附加段一律丢弃</b>：
     * 查询常带 EDNS(OPT) 记录，若只把 ARCOUNT 清零却留着字节，报文就畸形了。
     *
     * @return 应答字节；查询本身不完整时返回 null（调用方应改为原样转发）
     */
    @Nullable
    public static byte[] buildNxDomain(byte[] query, int questionsEnd) {
        if (query == null || query.length < HEADER_LENGTH) return null;
        if (questionsEnd < HEADER_LENGTH || questionsEnd > query.length) return null;

        byte[] response = new byte[questionsEnd];
        System.arraycopy(query, 0, response, 0, questionsEnd);

        // flags：QR=1（应答），RD 沿用查询，RA=1（我们确实转了/能转），RCODE=NXDOMAIN
        response[2] = (byte) (0x80 | (query[2] & 0x01));
        response[3] = (byte) (0x80 | RCODE_NXDOMAIN);
        // ANCOUNT = 0
        response[6] = 0;
        response[7] = 0;
        // NSCOUNT = 0
        response[8] = 0;
        response[9] = 0;
        // ARCOUNT = 0（EDNS 记录已在上面被截掉）
        response[10] = 0;
        response[11] = 0;
        return response;
    }

    /**
     * 构造一条 A 记录查询（规划 §4.1 的直连阻断要用它自己解析黑名单域名）。
     *
     * <p>标准查询：{@code RD=1}、一条问题（QTYPE=A、QCLASS=IN），不带 EDNS。
     * 域名按 DNS 的标签格式编成长度前缀，最后补一个 0 长度标签（根）。
     *
     * @return 查询报文字节；域名非法（空、超长、含空标签）时返回 null
     */
    @Nullable
    public static byte[] buildQuery(@Nullable String host, int transactionId) {
        if (host == null) return null;
        String name = host.trim().toLowerCase(java.util.Locale.US);
        while (name.endsWith(".")) name = name.substring(0, name.length() - 1);
        if (name.isEmpty() || name.length() > 253) return null;
        String[] labels = name.split("\\.", -1);
        int length = HEADER_LENGTH + 1 + 4;
        for (String label : labels) {
            if (label.isEmpty() || label.length() > 63) return null;
            length += 1 + label.length();
        }
        byte[] query = new byte[length];
        query[0] = (byte) ((transactionId >> 8) & 0xFF);
        query[1] = (byte) (transactionId & 0xFF);
        query[2] = 0x01;                      // RD=1，要求递归
        query[5] = 0x01;                      // QDCOUNT = 1
        int offset = HEADER_LENGTH;
        for (String label : labels) {
            query[offset] = (byte) label.length();
            offset++;
            for (int i = 0; i < label.length(); i++) {
                query[offset + i] = (byte) label.charAt(i);
            }
            offset += label.length();
        }
        query[offset] = 0;                    // 根标签
        offset++;
        query[offset + 1] = 0x01;             // QTYPE = A
        query[offset + 3] = 0x01;             // QCLASS = IN
        return query;
    }

    /**
     * 从一条 DNS <b>应答</b>里取出所有 A 记录（IPv4 地址）。
     *
     * <p>用途：把「家长拦的那个域名」解析出来的地址加进隧道路由（规划 §4.1）——
     * 孩子手里可能早就缓存了这个 IP，光靠 DNS 层回 NXDOMAIN 拦不住它。
     *
     * <p>只认 {@code TYPE=A(1)} 且 {@code CLASS=IN(1)} 且 {@code RDLENGTH=4} 的记录，
     * 其余（AAAA / CNAME / OPT…）整条跳过。名字压缩指针按标准 2 字节处理。
     *
     * <p>报文不完整时<b>返回已经拿到的那些</b>，不抛异常：少拦一个 IP 比让整条链路
     * 因为一个畸形包而停摆要好。
     *
     * @return A 记录地址列表（可能为空，永不为 null）
     */
    public static List<String> parseIpv4Answers(@Nullable byte[] message) {
        List<String> addresses = new ArrayList<>();
        if (message == null || message.length < HEADER_LENGTH) return addresses;
        int questionCount = ((message[4] & 0xFF) << 8) | (message[5] & 0xFF);
        int answerCount = ((message[6] & 0xFF) << 8) | (message[7] & 0xFF);
        if (questionCount < 0 || questionCount > 8) return addresses;
        if (answerCount <= 0 || answerCount > 64) return addresses;

        int offset = HEADER_LENGTH;
        for (int i = 0; i < questionCount; i++) {
            offset = skipNameForAnswer(message, offset);
            if (offset < 0) return addresses;
            offset += 4; // QTYPE + QCLASS
            if (offset > message.length) return addresses;
        }

        for (int i = 0; i < answerCount; i++) {
            offset = skipNameForAnswer(message, offset);
            if (offset < 0) return addresses;
            if (offset + 10 > message.length) return addresses;
            int type = ((message[offset] & 0xFF) << 8) | (message[offset + 1] & 0xFF);
            int klass = ((message[offset + 2] & 0xFF) << 8) | (message[offset + 3] & 0xFF);
            int rdLength = ((message[offset + 8] & 0xFF) << 8) | (message[offset + 9] & 0xFF);
            offset += 10;
            if (offset + rdLength > message.length) return addresses;
            if (type == 1 && klass == 1 && rdLength == 4) {
                addresses.add((message[offset] & 0xFF) + "."
                        + (message[offset + 1] & 0xFF) + "."
                        + (message[offset + 2] & 0xFF) + "."
                        + (message[offset + 3] & 0xFF));
            }
            offset += rdLength;
        }
        return addresses;
    }

    /** 跳过一个域名，返回它之后的偏移；非法返回 -1。 */
    private static int skipName(byte[] message, int offset) {
        while (offset < message.length) {
            int length = message[offset] & 0xFF;
            if (length == 0) return offset + 1;
            if ((length & 0xC0) == 0xC0) {
                // 压缩指针：2 字节，且只能在问题段里出现（严格说问题段也不该压缩）
                return offset + 2 <= message.length ? offset + 2 : -1;
            }
            if (length > 63) return -1;
            offset += 1 + length;
        }
        return -1;
    }

    /**
     * 应答段里的名字跳过：与 {@link #skipName} 同口径，单独留一份是因为应答段的
     * 名字<b>经常</b>用压缩指针（问题段基本不用），语义上分开更容易读。
     */
    private static int skipNameForAnswer(byte[] message, int offset) {
        return skipName(message, offset);
    }
}
