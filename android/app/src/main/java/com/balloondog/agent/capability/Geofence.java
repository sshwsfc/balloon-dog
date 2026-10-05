package com.balloondog.agent.capability;

import com.balloondog.agent.model.SafeZone;

import java.util.List;

/**
 * 安全区围栏判定。
 *
 * <p>刻意<b>不 import 任何 Android 类</b>：这里的数学很容易在边界上写错
 * （半径恰好等于距离、跨 180° 经线、极点附近的 cos 退化），
 * 而模拟器上又没法真的把设备「搬进搬出」一个区域来复现。
 * 所以它被设计成纯函数，由 {@code android/scripts/crosstest/GuardCheck.java}
 * 在普通 JVM 上逐点验证，编排（取定位、读写上次所在区、发事件）留在
 * {@code AgentService} 里。
 */
public final class Geofence {

    /** 地球平均半径（IUGG 平均半径，米）。用球面近似足够：围栏动辄几百米，与椭球差在米级以下。 */
    private static final double EARTH_RADIUS_METERS = 6_371_008.8;

    private Geofence() {
    }

    /**
     * 两点间大圆距离（Haversine）。
     *
     * <p>用 {@code asin(min(1, sqrt(a)))} 而不是 {@code atan2}：两者等价，但前者在
     * 对跖点附近不会因为浮点误差让 {@code sqrt(a) > 1} 而算出 NaN。
     */
    public static double haversineMeters(double lat1, double lon1, double lat2, double lon2) {
        double dLat = Math.toRadians(lat2 - lat1);
        double dLon = Math.toRadians(lon2 - lon1);
        double sinLat = Math.sin(dLat / 2);
        double sinLon = Math.sin(dLon / 2);
        double a = sinLat * sinLat
                + Math.cos(Math.toRadians(lat1)) * Math.cos(Math.toRadians(lat2)) * sinLon * sinLon;
        return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1.0, Math.sqrt(Math.max(0.0, a))));
    }

    /**
     * 找出点所在的第一个安全区。
     *
     * <p>多个区重叠时返回列表里第一个 —— 判定只关心「在不在区内」，
     * 具体是哪一个区只影响事件文案，不值得为重叠定义更复杂的语义。
     *
     * @return 所在的区；不在任何区内时返回 null
     */
    public static SafeZone findContaining(List<SafeZone> zones, double latitude, double longitude) {
        if (zones == null || zones.isEmpty()) return null;
        for (SafeZone zone : zones) {
            double distance = haversineMeters(latitude, longitude, zone.latitude, zone.longitude);
            // 边界上算「在区内」：半径正好 500 米时不该报「已离开」
            if (distance <= zone.radiusMeters) return zone;
        }
        return null;
    }

    /** 点是否落在任一安全区内。 */
    public static boolean insideAny(List<SafeZone> zones, double latitude, double longitude) {
        return findContaining(zones, latitude, longitude) != null;
    }
}
