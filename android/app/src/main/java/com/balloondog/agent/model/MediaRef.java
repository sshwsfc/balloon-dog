package com.balloondog.agent.model;

import androidx.annotation.Nullable;

import org.json.JSONObject;

/**
 * {@code POST /api/agent/media} 的返回：一条已落库的媒体。
 *
 * <p>设备执行 {@code remote_photo} / {@code screenshot} 后，必须把这里拿到的
 * {@link #id} 回填到指令结果 {@code { mediaId }}，家长端的指令历史才能关联到这张照片。
 */
public class MediaRef {

    public final String id;
    public final String kind;
    public final String mimeType;
    public final long sizeBytes;

    private MediaRef(String id, String kind, String mimeType, long sizeBytes) {
        this.id = id;
        this.kind = kind;
        this.mimeType = mimeType;
        this.sizeBytes = sizeBytes;
    }

    @Nullable
    public static MediaRef from(@Nullable JSONObject uploadResponse) {
        if (uploadResponse == null) return null;
        JSONObject media = uploadResponse.optJSONObject("media");
        if (media == null) return null;
        return new MediaRef(
                media.optString("id"),
                media.optString("kind"),
                media.optString("mimeType"),
                media.optLong("sizeBytes", 0L));
    }
}
