package com.balloondog.agent.model;

import androidx.annotation.Nullable;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * 一条「安全区」（家长在地图上圈出来的区域）。
 *
 * <p>结构严格对应服务端 {@code /api/agent/config} 的 {@code safeZones} 块：
 * {@code [{ id, name, latitude, longitude, radiusMeters }]}（服务端只下发 enabled 的）。
 *
 * <p>规则随配置落盘（{@code AgentStore.KEY_SAFE_ZONES}），因此断网时围栏判定照常工作 ——
 * 否则孩子一拔网线就能溜出安全区而不留任何事件。
 */
public final class SafeZone {

    public final String id;
    public final String name;
    public final double latitude;
    public final double longitude;
    public final int radiusMeters;

    private SafeZone(String id, String name, double latitude, double longitude, int radiusMeters) {
        this.id = id;
        this.name = name;
        this.latitude = latitude;
        this.longitude = longitude;
        this.radiusMeters = radiusMeters;
    }

    /**
     * 直接构造；坏数据返回 {@code null}（<b>而不是抛异常</b>）。
     *
     * <p>为什么校验放在这里而不是只放在 {@link #parseAll}：校验规则只有一份，
     * 才能被 JVM 交叉测试直接钉死。{@code parseAll} 的 org.json 在交叉测试里是
     * 「一调用就抛异常」的桩，造不出数据来测，于是「半径 0 的区必须丢弃」这类
     * 要命的边界就会长期没有测试覆盖。
     *
     * <p>给纯逻辑验证用（{@code android/scripts/crosstest/PureLogicCheck.java} 跑在普通 JVM 上）。
     */
    @Nullable
    public static SafeZone of(String id, String name, double latitude, double longitude,
                              int radiusMeters) {
        if (id == null || id.isEmpty()) return null;
        if (Double.isNaN(latitude) || Double.isNaN(longitude)) return null;
        if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return null;
        if (radiusMeters <= 0) return null; // 半径 0 的区永远「不在区内」，没有意义
        return new SafeZone(id, name, latitude, longitude, radiusMeters);
    }

    /** 解析 {@code safeZones} 数组；缺字段/坐标越界的项直接丢弃（宁可少一个区，也不要一个错区）。 */
    public static List<SafeZone> parseAll(JSONArray array) {
        List<SafeZone> out = new ArrayList<>();
        if (array == null) return out;
        for (int i = 0; i < array.length(); i++) {
            JSONObject item = array.optJSONObject(i);
            if (item == null) continue;
            String id = item.optString("id", "");
            SafeZone zone = of(id, item.optString("name", id),
                    item.optDouble("latitude", Double.NaN),
                    item.optDouble("longitude", Double.NaN),
                    item.optInt("radiusMeters", 0));
            if (zone != null) out.add(zone);
        }
        return out;
    }

    public static List<SafeZone> parseJson(String json) {
        if (json == null || json.isEmpty()) return Collections.emptyList();
        try {
            return parseAll(new JSONArray(json));
        } catch (Exception e) {
            // 落盘的数据坏掉时按「没有安全区」处理：围栏少判一次是可接受的降级，
            // 绝不能因为解析失败让整个 Agent 起不来。
            return Collections.emptyList();
        }
    }

    public static String toJson(List<SafeZone> zones) {
        JSONArray array = new JSONArray();
        if (zones == null) return array.toString();
        for (SafeZone zone : zones) {
            JSONObject item = new JSONObject();
            try {
                item.put("id", zone.id);
                item.put("name", zone.name);
                item.put("latitude", zone.latitude);
                item.put("longitude", zone.longitude);
                item.put("radiusMeters", zone.radiusMeters);
            } catch (Exception ignored) {
                // 全部是原生类型，实际不会抛
            }
            array.put(item);
        }
        return array.toString();
    }

    /** 事件文案里的名称，空名回落到 id。 */
    public String displayName() {
        return name == null || name.isEmpty() ? id : name;
    }
}
