package com.balloondog.agent.model;

import org.json.JSONObject;

/**
 * 一条通话记录（契约 §8）。
 *
 * <p>字段名与服务端模型一一对应：{@code type} 只有
 * {@code incoming | outgoing | missed} 三种 —— 其它系统类型（拒接、语音信箱、
 * 未识别）在读取处就被丢掉，不往服务端送一个它不认识的枚举值。
 */
public final class CallLogEntry {

    public final String phoneNumber;
    /** 系统缓存的联系人名，可能为空；设备端不做通讯录匹配。 */
    public final String name;
    public final String type;
    public final int durationSeconds;
    /** 通话发生时间（墙上毫秒） */
    public final long occurredAt;

    private CallLogEntry(String phoneNumber, String name, String type,
                         int durationSeconds, long occurredAt) {
        this.phoneNumber = phoneNumber;
        this.name = name;
        this.type = type;
        this.durationSeconds = durationSeconds;
        this.occurredAt = occurredAt;
    }

    public static CallLogEntry of(String phoneNumber, String name, String type,
                                  int durationSeconds, long occurredAt) {
        return new CallLogEntry(phoneNumber, name, type, durationSeconds, occurredAt);
    }

    /**
     * 服务端时间用 ISO-8601（与位置、事件等处一致），不复用设备本地毫秒 ——
     * 时区只有服务端知道，本地格式化反而容易引入偏差。
     */
    public JSONObject toJson() {
        JSONObject json = new JSONObject();
        try {
            json.put("phoneNumber", phoneNumber == null ? "" : phoneNumber);
            json.put("name", name == null ? "" : name);
            json.put("type", type);
            json.put("durationSeconds", durationSeconds);
            json.put("occurredAt", JsonUtils.toIso(occurredAt));
        } catch (Exception ignored) {
            // 常量 key
        }
        return json;
    }
}
