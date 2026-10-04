package com.balloondog.agent.capability;

import java.io.ByteArrayOutputStream;
import java.nio.charset.Charset;
import java.util.List;
import java.util.zip.CRC32;

/**
 * 把若干帧打成一个 ZIP 包。
 *
 * <h3>为什么用 stored（不压缩）</h3>
 * 帧本身已经是 JPEG —— 有损压缩后的数据再 deflate 一遍通常只能省 1~2%，
 * 却要吃满 CPU 并拖慢上传准备。ZIP 在这里的价值是「把 N 张图 + 元数据装进一个请求」，
 * 而不是「压得更小」。所以用 stored 模式，零 CPU 开销。
 *
 * <h3>为什么自己写</h3>
 * 只用到 ZIP 的一个子集：stored 条目、无加密、无 zip64（单包几十 KB，远不到 4GB）。
 * 这点代码量不值得引一个第三方库进来，而且自己写能保证服务端解析器与它完全对齐
 * （服务端的 {@code screen.storage.ts} 支持 stored 与 deflate 两种，向后兼容标准工具产出的包）。
 */
public final class FrameBatchArchiver {

    private static final Charset UTF8 = Charset.forName("UTF-8");

    private FrameBatchArchiver() {
    }

    /** 包内一个文件。 */
    public static final class Entry {
        public final String name;
        public final byte[] data;

        public Entry(String name, byte[] data) {
            this.name = name;
            this.data = data;
        }
    }

    /** 打包成一个 ZIP。 */
    public static byte[] buildZip(List<Entry> entries) {
        ByteArrayOutputStream out = new ByteArrayOutputStream(256 * 1024);
        // 每个条目的中央目录记录（最后统一写）
        ByteArrayOutputStream central = new ByteArrayOutputStream(4096);
        int offset = 0;

        for (Entry entry : entries) {
            byte[] name = entry.name.getBytes(UTF8);
            byte[] data = entry.data;

            CRC32 crc = new CRC32();
            crc.update(data);
            long crcValue = crc.getValue();

            // ---- 本地文件头 ----
            writeInt(out, 0x04034b50);      // signature
            writeShort(out, 20);            // version needed
            writeShort(out, 0x0800);        // 通用位标记：文件名是 UTF-8
            writeShort(out, 0);             // 压缩方式 0 = stored
            writeShort(out, 0);             // 修改时间
            writeShort(out, 0);             // 修改日期
            writeInt(out, (int) crcValue);
            writeInt(out, data.length);     // 压缩后大小
            writeInt(out, data.length);     // 原始大小
            writeShort(out, name.length);
            writeShort(out, 0);             // 扩展字段长度
            out.write(name, 0, name.length);
            out.write(data, 0, data.length);

            // ---- 中央目录记录 ----
            writeInt(central, 0x02014b50);
            writeShort(central, 20);        // version made by
            writeShort(central, 20);        // version needed
            writeShort(central, 0x0800);
            writeShort(central, 0);         // 压缩方式
            writeShort(central, 0);         // 时间
            writeShort(central, 0);         // 日期
            writeInt(central, (int) crcValue);
            writeInt(central, data.length);
            writeInt(central, data.length);
            writeShort(central, name.length);
            writeShort(central, 0);         // 扩展字段
            writeShort(central, 0);         // 注释
            writeShort(central, 0);         // 起始磁盘号
            writeShort(central, 0);         // 内部属性
            writeInt(central, 0);           // 外部属性
            writeInt(central, offset);      // 本地头偏移
            central.write(name, 0, name.length);

            offset += 30 + name.length + data.length;
        }

        byte[] centralBytes = central.toByteArray();
        out.write(centralBytes, 0, centralBytes.length);

        // ---- 中央目录结尾 ----
        writeInt(out, 0x06054b50);
        writeShort(out, 0);                     // 当前磁盘号
        writeShort(out, 0);                     // 中央目录起始磁盘号
        writeShort(out, entries.size());        // 本磁盘条目数
        writeShort(out, entries.size());        // 总条目数
        writeInt(out, centralBytes.length);
        writeInt(out, offset);
        writeShort(out, 0);                     // 注释长度

        return out.toByteArray();
    }

    private static void writeShort(ByteArrayOutputStream out, int value) {
        out.write(value & 0xff);
        out.write((value >>> 8) & 0xff);
    }

    private static void writeInt(ByteArrayOutputStream out, int value) {
        out.write(value & 0xff);
        out.write((value >>> 8) & 0xff);
        out.write((value >>> 16) & 0xff);
        out.write((value >>> 24) & 0xff);
    }
}
