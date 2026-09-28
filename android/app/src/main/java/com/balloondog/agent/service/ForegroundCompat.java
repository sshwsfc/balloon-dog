package com.balloondog.agent.service;

import android.app.Notification;
import android.app.Service;
import android.os.Build;

/**
 * 前台服务启动的兼容封装。
 *
 * <p>为什么不直接用 {@code androidx.core.app.ServiceCompat.startForeground}：
 * 那个重载是 androidx.core 1.12.0 才加入的，而本工程为了兼容 compileSdk 33
 * 停在 core 1.10.1。这里手写同样的逻辑，行为完全一致：
 * <ul>
 *   <li>Android 10（API 29）及以上：带 {@code foregroundServiceType} 启动
 *       —— 这是 Android 11+ 在后台访问相机/麦克风、以及 Android 14 使用
 *       MediaProjection 的硬性前提；</li>
 *   <li>Android 9 及以下：走老的两参数重载（旧系统不认识 type，传了会抛异常）。</li>
 * </ul>
 */
final class ForegroundCompat {

    private ForegroundCompat() {
    }

    static void start(Service service, int id, Notification notification, int foregroundServiceType) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            service.startForeground(id, notification, foregroundServiceType);
        } else {
            service.startForeground(id, notification);
        }
    }

    static void stop(Service service) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            service.stopForeground(Service.STOP_FOREGROUND_REMOVE);
        } else {
            //noinspection deprecation
            service.stopForeground(true);
        }
    }
}
