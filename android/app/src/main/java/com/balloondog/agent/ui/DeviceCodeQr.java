package com.balloondog.agent.ui;

import android.graphics.Bitmap;
import android.graphics.Color;
import android.util.Log;

import androidx.annotation.Nullable;

import com.google.zxing.BarcodeFormat;
import com.google.zxing.EncodeHintType;
import com.google.zxing.WriterException;
import com.google.zxing.common.BitMatrix;
import com.google.zxing.qrcode.QRCodeWriter;
import com.google.zxing.qrcode.decoder.ErrorCorrectionLevel;

import java.util.EnumMap;
import java.util.Map;

/**
 * 把绑定码渲染成二维码，让家长端「扫一扫」就能读到，不必再手输那 8 位码。
 *
 * <p>本机只需要<b>生成</b>二维码，所以只引 {@code com.google.zxing:core}，
 * 没有引入 zxing-android-embedded 那套相机预览与解码组件。
 *
 * <p>二维码里放的就是绑定码本身（例如 {@code AB3D7K9M}），<b>不带</b>任何 URL 或前缀 ——
 * 家长端拿到扫码结果后，按裸码去认领设备。
 */
final class DeviceCodeQr {

    private static final String TAG = "DeviceCodeQr";

    /**
     * 纠错级别 M（约可容忍 15% 的破损）。
     *
     * <p>不选 L：这是屏幕上的二维码，家长常常隔着一段距离、斜着扫，屏幕反光和缩放躲不掉，
     * M 只比 L 多几个模块，抗污抗反光却明显更好；也不选 Q / H，那会把码点挤得更密，
     * 在 190dp 的展示尺寸下反而更难对准，得不偿失。
     */
    private static final ErrorCorrectionLevel ERROR_CORRECTION = ErrorCorrectionLevel.M;

    /**
     * 静区（quiet zone）宽度，单位是「模块」。
     *
     * <p>ZXing 默认留 4 个模块，在 190dp 的展示尺寸里白边会占掉一大圈、把码点挤小。
     * 这里收到 1 个模块，其余静区交给布局里 ImageView 的白色内边距去补 ——
     * 但绝不能设成 0：没有静区，扫描器找不到码的边界，很多机型会直接扫不出来。
     */
    private static final int MARGIN_MODULES = 1;

    private DeviceCodeQr() {
    }

    /**
     * 把 {@code content} 编码成二维码位图。
     *
     * @param content 二维码内容，即裸绑定码；为空时返回 {@code null}
     * @param sizePx  输出位图边长（像素）。模块会按整数倍缩放，因此不会出现半个像素的模糊边缘
     * @return 生成好的位图；编码失败（{@link WriterException}）时记日志并返回 {@code null}
     */
    @Nullable
    static Bitmap render(@Nullable String content, int sizePx) {
        if (content == null || content.isEmpty() || sizePx <= 0) return null;

        Map<EncodeHintType, Object> hints = new EnumMap<>(EncodeHintType.class);
        // 绑定码本身是 ASCII，显式声明字符集只是防止默认字符集在不同 ROM 上漂移
        hints.put(EncodeHintType.CHARACTER_SET, "UTF-8");
        hints.put(EncodeHintType.ERROR_CORRECTION, ERROR_CORRECTION);
        hints.put(EncodeHintType.MARGIN, MARGIN_MODULES);

        try {
            BitMatrix matrix = new QRCodeWriter()
                    .encode(content, BarcodeFormat.QR_CODE, sizePx, sizePx, hints);
            int width = matrix.getWidth();
            int height = matrix.getHeight();
            int[] pixels = new int[width * height];
            for (int y = 0; y < height; y++) {
                int offset = y * width;
                for (int x = 0; x < width; x++) {
                    // 白色模块必须显式写进像素数组：像素数组默认是全透明的，
                    // 只画黑点的话二维码就是「黑点浮在透明底上」，不仅难看还扫不出来。
                    pixels[offset + x] = matrix.get(x, y) ? Color.BLACK : Color.WHITE;
                }
            }
            return Bitmap.createBitmap(pixels, width, height, Bitmap.Config.ARGB_8888);
        } catch (WriterException e) {
            // 编码失败不该让整个配对页崩掉：调用方据此隐藏二维码，绑定码文字照常展示、照常可手输
            Log.w(TAG, "绑定码二维码生成失败，本次只显示文字绑定码", e);
            return null;
        }
    }
}
