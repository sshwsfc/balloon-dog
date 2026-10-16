package com.balloondog.agent.capability;

import androidx.annotation.Nullable;

import java.util.Locale;

/**
 * IPv4 报文的读与「构造一个 TCP RST」—— 网址拦截的直连阻断要用（契约 §5）。
 *
 * <h3>为什么需要它</h3>
 * 把某个 IP 的流量路由进 tun 之后，我们只能<b>丢弃</b>它（没有实现用户态转发）。
 * 丢弃的后果是：孩子点开被拦的网站，浏览器会一直转圈直到超时（几十秒），
 * 看起来像「网络坏了」—— 比直接失败更糟，也更容易让孩子以为「再等等就能开」。
 * 所以对被阻断的 TCP 连接，我们回一个 RST：连接立刻失败，行为接近「这台主机拒绝连接」。
 *
 * <h3>为什么是纯 Java</h3>
 * 校验和写错一位，发出的报文会被对端直接丢掉（表现为「什么也没发生」），
 * 在真机上靠眼睛完全看不出来。所以这一段和 {@link DnsMessage} 一样，
 * 必须是<b>零 Android 依赖</b>、能被 JVM 交叉测试按在手里的纯函数。
 *
 * <h3>刻意不做的</h3>
 * <ul>
 *   <li><b>不做用户态转发</b>：不构造 SYN-ACK、不维护连接状态、不转发 payload。
 *       真要拦的是「不该通的连接」，而不是「替它把连接打通」。</li>
 *   <li><b>UDP 只丢不答</b>：回 ICMP port-unreachable 需要再算一套校验和，
 *       而丢弃已经足够让 UDP 应用失败（DNS 层本来就有 NXDOMAIN 兜着）。</li>
 *   <li><b>不做 IPv6</b>：隧道地址是 IPv4，且 IPv6 的扩展头链会让「只读固定偏移」
 *       变成一段真正的解析器 —— 与其写半个，不如只做 IPv4 并如实写明。</li>
 * </ul>
 */
public final class IpPackets {

    /** IP 协议号：TCP。 */
    public static final int PROTOCOL_TCP = 6;

    /** IP 协议号：UDP。 */
    public static final int PROTOCOL_UDP = 17;

    /** TCP 标志位。 */
    public static final int TCP_FIN = 0x01;
    public static final int TCP_SYN = 0x02;
    public static final int TCP_RST = 0x04;
    public static final int TCP_ACK = 0x10;

    private IpPackets() {
    }

    /** IPv4 头长度（字节）；不是 IPv4 或长度不合法返回 -1。 */
    public static int ipv4HeaderLength(@Nullable byte[] packet) {
        if (packet == null || packet.length < 20) return -1;
        if (((packet[0] >> 4) & 0x0F) != 4) return -1;
        int ihl = (packet[0] & 0x0F) * 4;
        if (ihl < 20 || ihl > packet.length) return -1;
        return ihl;
    }

    /** 目的 IPv4（点分十进制）；不合法返回 null。 */
    @Nullable
    public static String destIpv4(@Nullable byte[] packet) {
        int ihl = ipv4HeaderLength(packet);
        if (ihl < 0) return null;
        return formatIpv4(packet, 16);
    }

    /** 源 IPv4；不合法返回 null。 */
    @Nullable
    public static String sourceIpv4(@Nullable byte[] packet) {
        int ihl = ipv4HeaderLength(packet);
        if (ihl < 0) return null;
        return formatIpv4(packet, 12);
    }

    /** 传输层协议号；不是 IPv4 返回 -1。 */
    public static int protocol(@Nullable byte[] packet) {
        if (ipv4HeaderLength(packet) < 0) return -1;
        return packet[9] & 0xFF;
    }

    /** 目的端口；不是 TCP/UDP 或报文不完整返回 -1。 */
    public static int destPort(@Nullable byte[] packet) {
        int ihl = ipv4HeaderLength(packet);
        if (ihl < 0 || ihl + 4 > packet.length) return -1;
        int proto = packet[9] & 0xFF;
        if (proto != PROTOCOL_TCP && proto != PROTOCOL_UDP) return -1;
        return readU16(packet, ihl + 2);
    }

    /** 源端口；判据同上。 */
    public static int sourcePort(@Nullable byte[] packet) {
        int ihl = ipv4HeaderLength(packet);
        if (ihl < 0 || ihl + 4 > packet.length) return -1;
        int proto = packet[9] & 0xFF;
        if (proto != PROTOCOL_TCP && proto != PROTOCOL_UDP) return -1;
        return readU16(packet, ihl);
    }

    /** TCP 标志位；不是 IPv4/TCP 返回 -1。 */
    public static int tcpFlags(@Nullable byte[] packet) {
        int ihl = ipv4HeaderLength(packet);
        if (ihl < 0 || packet[9] != (byte) PROTOCOL_TCP || ihl + 14 > packet.length) return -1;
        return packet[ihl + 13] & 0xFF;
    }

    /**
     * 为一条 TCP 报文构造对应的 RST，用来「立刻拒绝」而不是静默丢弃。
     *
     * <p>规则（与常见协议栈一致）：
     * <ul>
     *   <li>收到 SYN（不带 ACK）→ 回 {@code RST|ACK}，{@code seq=0}、{@code ack=对方seq+1}；</li>
     *   <li>其它 TCP 报文 → 回 {@code RST}，{@code seq=对方的ack}、{@code ack=0}
     *       （RFC 793 的「如果进来的段没有 ACK，就发 seq=0 的 RST」那条的常用近似）。</li>
     * </ul>
     *
     * <p>原报文的 IP 选项一律丢弃（新头固定 20 字节），校验和重新计算。
     *
     * @return RST 报文字节；不是 IPv4/TCP 或太短时返回 null（调用方应改为静默丢弃）
     */
    @Nullable
    public static byte[] buildTcpReset(@Nullable byte[] packet) {
        int ihl = ipv4HeaderLength(packet);
        if (ihl < 0 || packet[9] != (byte) PROTOCOL_TCP) return null;
        if (ihl + 20 > packet.length) return null;

        int srcPort = readU16(packet, ihl);
        int dstPort = readU16(packet, ihl + 2);
        long seq = readU32(packet, ihl + 4);
        long ack = readU32(packet, ihl + 8);
        int flags = packet[ihl + 13] & 0xFF;

        byte[] reset = new byte[40];

        // ---- IPv4 头（20 字节）----
        reset[0] = 0x45;                      // version 4, IHL 5
        reset[1] = 0;                         // DSCP/ECN 保持 0
        writeU16(reset, 2, 40);               // total length = 20 + 20
        reset[4] = 0;                         // identification 0（无需分片）
        reset[5] = 0;
        reset[6] = 0x40;                      // flags: Don't Fragment
        reset[7] = 0;
        reset[8] = 64;                        // TTL
        reset[9] = (byte) PROTOCOL_TCP;
        writeU16(reset, 10, 0);               // checksum 先置 0，最后算
        // 源/目的地址互换：RST 是从「被连接的目标」发回给孩子的
        reset[12] = packet[16];
        reset[13] = packet[17];
        reset[14] = packet[18];
        reset[15] = packet[19];
        reset[16] = packet[12];
        reset[17] = packet[13];
        reset[18] = packet[14];
        reset[19] = packet[15];

        // ---- TCP 头（20 字节）----
        writeU16(reset, 20, dstPort);         // 源端口 = 原目的端口
        writeU16(reset, 22, srcPort);         // 目的端口 = 原源端口
        boolean incomingSyn = (flags & TCP_SYN) != 0 && (flags & TCP_ACK) == 0;
        if (incomingSyn) {
            writeU32(reset, 24, 0);           // seq = 0
            writeU32(reset, 28, (seq + 1) & 0xFFFFFFFFL);
            reset[33] = (byte) (TCP_RST | TCP_ACK);
        } else {
            writeU32(reset, 24, ack & 0xFFFFFFFFL);
            writeU32(reset, 28, 0);
            reset[33] = (byte) TCP_RST;
        }
        reset[32] = 0x50;                     // data offset 5, 无选项
        writeU16(reset, 34, 0);               // window 0
        writeU16(reset, 36, 0);               // checksum 先置 0
        writeU16(reset, 38, 0);               // urgent pointer

        writeU16(reset, 36, tcpChecksum(reset));
        writeU16(reset, 10, ipChecksum(reset, 20));
        return reset;
    }

    // ---------------- 校验和 ----------------

    /** IPv4 头校验和（{@code header} 里校验和字段应已置 0）。 */
    public static int ipChecksum(byte[] header, int length) {
        int sum = 0;
        for (int i = 0; i + 1 < length; i += 2) {
            sum += readU16(header, i);
            sum = (sum & 0xFFFF) + (sum >> 16);
        }
        return (~sum) & 0xFFFF;
    }

    /** TCP 校验和（含 IPv4 伪头）。 */
    public static int tcpChecksum(byte[] packet) {
        int sum = 0;
        // 伪头：源地址、目的地址、零、协议、TCP 长度
        for (int i = 12; i < 20; i += 2) {
            sum += readU16(packet, i);
            sum = (sum & 0xFFFF) + (sum >> 16);
        }
        sum += PROTOCOL_TCP;
        sum += packet.length - 20;
        for (int i = 20; i + 1 < packet.length; i += 2) {
            sum += readU16(packet, i);
            sum = (sum & 0xFFFF) + (sum >> 16);
        }
        return (~sum) & 0xFFFF;
    }

    // ---------------- 小工具 ----------------

    public static int readU16(byte[] data, int offset) {
        return ((data[offset] & 0xFF) << 8) | (data[offset + 1] & 0xFF);
    }

    public static long readU32(byte[] data, int offset) {
        return ((long) (data[offset] & 0xFF) << 24)
                | ((data[offset + 1] & 0xFF) << 16)
                | ((data[offset + 2] & 0xFF) << 8)
                | (data[offset + 3] & 0xFF);
    }

    public static void writeU16(byte[] data, int offset, int value) {
        data[offset] = (byte) ((value >> 8) & 0xFF);
        data[offset + 1] = (byte) (value & 0xFF);
    }

    public static void writeU32(byte[] data, int offset, long value) {
        data[offset] = (byte) ((value >> 24) & 0xFF);
        data[offset + 1] = (byte) ((value >> 16) & 0xFF);
        data[offset + 2] = (byte) ((value >> 8) & 0xFF);
        data[offset + 3] = (byte) (value & 0xFF);
    }

    @Nullable
    private static String formatIpv4(byte[] packet, int offset) {
        if (offset + 4 > packet.length) return null;
        return String.format(Locale.US, "%d.%d.%d.%d",
                packet[offset] & 0xFF, packet[offset + 1] & 0xFF,
                packet[offset + 2] & 0xFF, packet[offset + 3] & 0xFF);
    }
}
