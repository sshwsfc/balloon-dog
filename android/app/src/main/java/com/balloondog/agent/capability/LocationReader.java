package com.balloondog.agent.capability;

import android.Manifest;
import android.content.Context;
import android.content.pm.PackageManager;
import android.location.Address;
import android.location.Geocoder;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Looper;
import android.text.TextUtils;

import androidx.core.content.ContextCompat;

import com.balloondog.agent.data.EventLog;

import java.util.List;
import java.util.Locale;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

/**
 * 定位读取。
 *
 * <p>策略：先看各 provider 的 {@code getLastKnownLocation}（几乎无耗时，室内也常常可用），
 * 如果最新的一个已经很旧（超过 2 分钟），再主动请求一次单次定位并等待最多 {@code timeoutMs}。
 * 这样「家长点一下获取位置」不会因为室内没有 GPS 信号而干等到超时。
 *
 * <p>逆地理编码（把经纬度变成「北京市朝阳区…」）用 {@link Geocoder}，失败就留空 ——
 * 服务端的 {@code address} 本来就是可选字段，绝不能因为地图服务不可用导致整条定位上报失败。
 */
public final class LocationReader {

    /** lastKnownLocation 超过这个时长就认为不足以代表「现在」。 */
    private static final long FRESH_ENOUGH_MS = 2 * 60_000L;
    private static final long GEOCODE_TIMEOUT_MS = 4_000L;

    private LocationReader() {
    }

    public static final class Fix {
        public final double latitude;
        public final double longitude;
        public final float accuracy;
        public final String address;

        Fix(double latitude, double longitude, float accuracy, String address) {
            this.latitude = latitude;
            this.longitude = longitude;
            this.accuracy = accuracy;
            this.address = address;
        }
    }

    public static boolean hasPermission(Context context) {
        return ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_FINE_LOCATION)
                == PackageManager.PERMISSION_GRANTED
                || ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_COARSE_LOCATION)
                == PackageManager.PERMISSION_GRANTED;
    }

    /**
     * 取一次定位。
     *
     * @param timeoutMs 主动请求定位时的最长等待时间
     */
    public static Fix read(Context context, long timeoutMs) throws CapabilityException {
        if (!hasPermission(context)) {
            throw new CapabilityException("定位权限未授予，请在气球狗引导页里允许位置权限");
        }
        LocationManager manager = (LocationManager) context.getSystemService(Context.LOCATION_SERVICE);
        if (manager == null) {
            throw new CapabilityException("设备没有定位服务");
        }

        Location best = bestLastKnown(manager);
        if (best != null && System.currentTimeMillis() - best.getTime() <= FRESH_ENOUGH_MS) {
            EventLog.info("使用缓存的定位（" + describe(best) + "）");
        } else {
            Location fresh = requestSingleFix(context, manager, timeoutMs);
            if (fresh != null) {
                best = fresh;
            } else if (best == null) {
                throw new CapabilityException("暂时拿不到定位（室内无信号或定位开关未打开）");
            } else {
                EventLog.warn("主动定位超时，改用上一次的缓存位置");
            }
        }

        String address = reverseGeocode(context, best.getLatitude(), best.getLongitude());
        return new Fix(best.getLatitude(), best.getLongitude(), best.getAccuracy(), address);
    }

    private static Location bestLastKnown(LocationManager manager) {
        Location best = null;
        for (String provider : manager.getProviders(true)) {
            try {
                Location location = manager.getLastKnownLocation(provider);
                if (location == null) continue;
                if (best == null || location.getTime() > best.getTime()) {
                    best = location;
                }
            } catch (SecurityException | IllegalArgumentException ignored) {
                // 某个 provider 不可用/无权限，跳过
            }
        }
        return best;
    }

    /** 主动请求一次定位，拿到首个结果就返回；超时返回 null。 */
    private static Location requestSingleFix(Context context, LocationManager manager, long timeoutMs) {
        String provider = manager.isProviderEnabled(LocationManager.GPS_PROVIDER)
                ? LocationManager.GPS_PROVIDER
                : manager.isProviderEnabled(LocationManager.NETWORK_PROVIDER)
                ? LocationManager.NETWORK_PROVIDER
                : null;
        if (provider == null) return null;

        CountDownLatch latch = new CountDownLatch(1);
        AtomicReference<Location> result = new AtomicReference<>();

        LocationListener listener = new LocationListener() {
            @Override
            public void onLocationChanged(Location location) {
                result.compareAndSet(null, location);
                latch.countDown();
            }

            @Override
            public void onStatusChanged(String provider, int status, Bundle extras) {
                // 状态变化无需处理
            }

            @Override
            public void onProviderEnabled(String provider) {
                // 无需处理
            }

            @Override
            public void onProviderDisabled(String provider) {
                latch.countDown();
            }
        };

        try {
            // 用主 Looper 回调：Agent 线程是普通工作线程，没有 Looper
            manager.requestLocationUpdates(provider, 0L, 0f, listener, Looper.getMainLooper());
            latch.await(timeoutMs, TimeUnit.MILLISECONDS);
        } catch (SecurityException e) {
            return null;
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        } finally {
            try {
                manager.removeUpdates(listener);
            } catch (Exception ignored) {
                // 移除失败无影响
            }
        }
        return result.get();
    }

    /** 逆地理编码。失败/无网络时返回 null，调用方把地址留空即可。 */
    private static String reverseGeocode(Context context, double latitude, double longitude) {
        if (!Geocoder.isPresent()) return null;
        Geocoder geocoder = new Geocoder(context, Locale.CHINA);

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            // Android 13+ 的异步 API（主线程回调），自带超时保护
            CountDownLatch latch = new CountDownLatch(1);
            AtomicReference<String> addressRef = new AtomicReference<>();
            geocoder.getFromLocation(latitude, longitude, 1, new Geocoder.GeocodeListener() {
                @Override
                public void onGeocode(List<Address> addresses) {
                    if (addresses != null && !addresses.isEmpty()) {
                        addressRef.set(formatAddress(addresses.get(0)));
                    }
                    latch.countDown();
                }

                @Override
                public void onError(String errorMessage) {
                    latch.countDown();
                }
            });
            try {
                latch.await(GEOCODE_TIMEOUT_MS, TimeUnit.MILLISECONDS);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
            return addressRef.get();
        }

        // Android 12 及以下只有阻塞式 API：放到独立线程执行，用 latch 硬超时，
        // 避免在没有网络的环境里把 Agent 线程卡死。
        CountDownLatch latch = new CountDownLatch(1);
        AtomicReference<String> addressRef = new AtomicReference<>();
        Thread worker = new Thread(() -> {
            try {
                @SuppressWarnings("deprecation")
                List<Address> addresses = geocoder.getFromLocation(latitude, longitude, 1);
                if (addresses != null && !addresses.isEmpty()) {
                    addressRef.set(formatAddress(addresses.get(0)));
                }
            } catch (Exception ignored) {
                // 无网络 / 服务不可用：地址留空
            } finally {
                latch.countDown();
            }
        }, "balloon-geocode");
        worker.setDaemon(true);
        worker.start();
        try {
            latch.await(GEOCODE_TIMEOUT_MS, TimeUnit.MILLISECONDS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
        return addressRef.get();
    }

    private static String formatAddress(Address address) {
        StringBuilder sb = new StringBuilder();
        appendIfPresent(sb, address.getAdminArea());
        appendIfPresent(sb, address.getLocality());
        appendIfPresent(sb, address.getSubLocality());
        appendIfPresent(sb, address.getThoroughfare());
        appendIfPresent(sb, address.getSubThoroughfare());
        return sb.length() == 0 ? null : sb.toString();
    }

    private static void appendIfPresent(StringBuilder sb, String value) {
        if (TextUtils.isEmpty(value)) return;
        if (sb.indexOf(value) >= 0) return;
        sb.append(value);
    }

    private static String describe(Location location) {
        return String.format(Locale.US, "%.5f,%.5f ±%.0fm", location.getLatitude(),
                location.getLongitude(), location.getAccuracy());
    }

    /** 是否开启了位置服务（用于设置页给出可操作提示）。 */
    public static boolean isLocationEnabled(Context context) {
        LocationManager manager = (LocationManager) context.getSystemService(Context.LOCATION_SERVICE);
        if (manager == null) return false;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            return manager.isLocationEnabled();
        }
        return manager.isProviderEnabled(LocationManager.GPS_PROVIDER)
                || manager.isProviderEnabled(LocationManager.NETWORK_PROVIDER);
    }
}
