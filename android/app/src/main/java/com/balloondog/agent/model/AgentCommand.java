package com.balloondog.agent.model;

import androidx.annotation.Nullable;

import org.json.JSONObject;

/**
 * 一条待执行 / 已执行的设备指令。
 *
 * <p>字段与 {@code commands.service.ts} 的 {@code toCommandView()} 一一对应。
 * 注意 {@code payload} 里不会出现服务端的内部回滚字段 {@code __revert}（服务端已剥离）。
 */
public class AgentCommand {

    public final String id;
    public final String type;
    /** 服务端给的中文名，例如「锁屏」「远程拍照」。 */
    public final String label;
    public final JSONObject payload;
    public final String status;
    public final long expiresAt;

    public AgentCommand(String id, String type, String label, JSONObject payload, String status, long expiresAt) {
        this.id = id;
        this.type = type;
        this.label = label;
        this.payload = payload == null ? new JSONObject() : payload;
        this.status = status;
        this.expiresAt = expiresAt;
    }

    public static AgentCommand from(@Nullable JSONObject json) {
        if (json == null) return null;
        return new AgentCommand(
                json.optString("id"),
                json.optString("type"),
                json.optString("label", json.optString("type")),
                json.optJSONObject("payload"),
                json.optString("status"),
                JsonUtils.parseIsoMillis(json.optString("expiresAt", null)));
    }

    /** 取字符串型的 payload 字段（例如 stop_recording 的 recordingId）。 */
    public String payloadString(String key) {
        return payload.optString(key, null);
    }

    public long payloadLong(String key, long fallback) {
        return payload.optLong(key, fallback);
    }

    @Override
    public String toString() {
        return "[" + label + "] (" + type + ", id=" + id + ")";
    }
}
