package com.balloondog.agent.capability;

import androidx.annotation.Nullable;

import java.nio.charset.StandardCharsets;

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
}
