package com.balloondog.agent.model;

import org.json.JSONObject;

/**
 * 一条短信（契约 §8）。
 *
 * <p>只读收件箱与已发送（{@code inbox | sent}）：草稿、发件箱、失败记录
 * 既不是「孩子收到了什么」也不是「孩子发出去了什么」，没有上报价值。
 *
 * <p>正文按 500 字截断：超长短信（尤其是推送类）会把接口体积撑爆，
 * 而家长端能看的也就前几百字。
 */
public final class SmsMessage {

    public static final int MAX_BODY_LENGTH = 500;

    public final String address;
    public final String body;
    public final String type;
    public final long occurredAt;

    private SmsMessage(String address, String body, String type, long occurredAt) {
        this.address = address;
        this.body = body;
        this.type = type;
        this.occurredAt = occurredAt;
    }

    public static SmsMessage of(String address, String body, String type, long occurredAt) {
        String trimmed = body == null ? "" : body;
        if (trimmed.length() > MAX_BODY_LENGTH) {
            trimmed = trimmed.substring(0, MAX_BODY_LENGTH) + "…";
        }
        return new SmsMessage(address, trimmed, type, occurredAt);
    }

    public JSONObject toJson() {
        JSONObject json = new JSONObject();
        try {
            json.put("address", address == null ? "" : address);
            json.put("body", body);
            json.put("type", type);
            json.put("occurredAt", JsonUtils.toIso(occurredAt));
        } catch (Exception ignored) {
            // 常量 key
        }
        return json;
    }
}
