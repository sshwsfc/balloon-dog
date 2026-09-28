package com.balloondog.agent.model;

import java.text.ParseException;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.TimeZone;

/**
 * 服务端时间字段（ISO-8601）与本地毫秒的互转。
 *
 * <p>刻意不依赖 {@code java.time}：那需要 core library desugaring 才能在 minSdk 24 上用，
 * 这里用 SimpleDateFormat 覆盖服务端实际会产出的几种写法即可。
 */
public final class JsonUtils {

    private static final String[] PATTERNS = {
            "yyyy-MM-dd'T'HH:mm:ss.SSSXXX",
            "yyyy-MM-dd'T'HH:mm:ssXXX",
            "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'",
            "yyyy-MM-dd'T'HH:mm:ss'Z'",
            "yyyy-MM-dd'T'HH:mm:ss.SSS",
            "yyyy-MM-dd'T'HH:mm:ss",
    };

    private JsonUtils() {
    }

    /** 解析服务端返回的时间字符串；无法解析时返回 0（调用方按「没有时间」处理）。 */
    public static long parseIsoMillis(String value) {
        if (value == null || value.isEmpty() || "null".equals(value)) return 0L;
        for (String pattern : PATTERNS) {
            SimpleDateFormat format = new SimpleDateFormat(pattern, Locale.US);
            if (pattern.endsWith("'Z'")) {
                format.setTimeZone(TimeZone.getTimeZone("UTC"));
            }
            try {
                Date date = format.parse(value);
                if (date != null) return date.getTime();
            } catch (ParseException ignored) {
                // 换下一种格式继续尝试
            }
        }
        return 0L;
    }

    /** 生成服务端能接受的 ISO-8601（UTC，带毫秒）字符串。 */
    public static String toIso(long millis) {
        SimpleDateFormat format = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US);
        format.setTimeZone(TimeZone.getTimeZone("UTC"));
        return format.format(new Date(millis));
    }

    /** 把时长渲染成「1小时23分钟」这类中文短句。 */
    public static String humanizeDuration(long millis) {
        if (millis <= 0) return "0分钟";
        long totalMinutes = millis / 60_000L;
        long hours = totalMinutes / 60;
        long minutes = totalMinutes % 60;
        if (hours > 0) {
            return minutes > 0 ? hours + "小时" + minutes + "分钟" : hours + "小时";
        }
        if (totalMinutes > 0) return totalMinutes + "分钟";
        return "不到 1 分钟";
    }
}
