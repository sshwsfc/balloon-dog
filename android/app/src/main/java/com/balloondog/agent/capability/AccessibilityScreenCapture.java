package com.balloondog.agent.capability;

import android.accessibilityservice.AccessibilityService;
import android.graphics.Bitmap;
import android.hardware.HardwareBuffer;
import android.os.Build;
import android.view.Display;

import androidx.annotation.Nullable;

import com.balloondog.agent.data.EventLog;

import java.io.ByteArrayOutputStream;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executor;
import java.util.concurrent.TimeUnit;

/**
 * 免授权的屏幕截图：走无障碍服务的 {@code AccessibilityService.takeScreenshot()}。
 *
 * <h3>为什么需要它</h3>
 * 截图原先唯一可用的路径是 {@link ScreenCapturer} 的 MediaProjection，而 Android 的安全模型
 * 决定了 <b>每次新的投影会话都必须由设备本人在系统弹框上点一次「立即开始」</b>
 * （Android 14 起授权令牌一次性，更严格）。孩子不会配合，所以家长点「截图」时只会
 * 20 秒超时，媒体库里永远没有 {@code screenshot} 这类资源 —— 这就是「截图功能不好用」的根因。
 *
 * <p>{@code takeScreenshot()} 是 API 30 引入的系统接口，<b>完全不需要用户授权弹框</b>，
 * 也不需要 MediaProjection 前台服务。代价是它要求无障碍服务正在运行，且需要
 * {@code AndroidManifest} 里声明的服务在 {@code res/xml/accessibility_watchdog.xml} 中
 * 加上 {@code android:canTakeScreenshot="true"}。
 *
 * <h3>边界（诚实说明）</h3>
 * <ul>
 *   <li>API &lt; 30 没有这个接口，本类一律返回 {@code null}，由 {@link ScreenCapturer} 回退到
 *       MediaProjection（所以 {@code minSdk 24} 的机型仍然要孩子点授权框）；</li>
 *   <li>无障碍服务被系统关掉/杀掉时实例为空，同样返回 {@code null} 而不是抛异常；</li>
 *   <li>系统对 {@code takeScreenshot} 有最小调用间隔限制（过密会回
 *       {@code ERROR_TAKE_SCREENSHOT_INTERVAL_TIME_SHORT}，即上面错误码里的 3）。
 *       实测我们的两个调用方都碰不到这条线：手动截图是家长按一次发一条指令；
 *       周期采样的间隔下限是 {@code ScreenSampler} 里的
 *       {@code Math.max(10, captureIntervalSeconds) * 1000L}，即<b>最快也是 10 秒一张</b>，
 *       而系统限制在几百毫秒量级。真出现错误码 3 时也只丢掉这一帧、由上层决定下次再拍。</li>
 *   <li>实际踩到最多的失败是错误码 1（内部错误），成因是<b>无障碍服务被系统记进了
 *       {@code dumpsys accessibility} 的 Crashed services 名单</b>（例如刚装过新包、
 *       服务进程被杀）。此时本类会持续返回 {@code null}，整条链路静默退化成要点授权框的
 *       MediaProjection；家长重新开关一次无障碍开关即可恢复。这是系统行为，不是本类的缺陷，
 *       详见 {@code android/README.md} §10.5。</li>
 * </ul>
 *
 * <p>本类所有方法都可能阻塞（最长 {@code timeoutMs}），<b>禁止在主线程调用</b>。
 */
public final class AccessibilityScreenCapture {

    /** 默认 JPEG 质量，与 MediaProjection 主路径保持一致。 */
    private static final int JPEG_QUALITY = 85;

    private static final Object LOCK = new Object();

    /**
     * 当前已连接的无障碍服务实例。
     *
     * <p>{@code takeScreenshot()} 是实例方法，而截图指令来自 {@code AgentService} 那条线程，
     * 所以必须在 {@code LockWatchdogService.onServiceConnected()} 时把实例登记进来，
     * 断开 / 销毁时再注销（避免继续拿着已经失效的实例）。
     */
    @Nullable
    private static volatile AccessibilityService service;

    private AccessibilityScreenCapture() {
    }

    /** 由 {@code LockWatchdogService.onServiceConnected()} 调用。 */
    public static void attach(AccessibilityService target) {
        synchronized (LOCK) {
            service = target;
            EventLog.info("无障碍截图能力已就绪（API " + Build.VERSION.SDK_INT + "，免授权截图）");
        }
    }

    /** 由 {@code LockWatchdogService.onUnbind()} / {@code onDestroy()} 调用。 */
    public static void detach(AccessibilityService target) {
        synchronized (LOCK) {
            if (service == target) {
                service = null;
            }
        }
    }

    /**
     * 免授权截图当前是否「有可能」成功。
     *
     * <p>只是给界面做提示用；真正能不能拿到图，以 {@link #takeScreenshotBlocking(long)}
     * 是否返回 {@code null} 为准。
     */
    public static boolean isAvailable() {
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.R && service != null;
    }

    /**
     * 抓一张全分辨率的屏幕 JPEG。
     *
     * @return JPEG 字节；API &lt; 30、无障碍服务没连上、系统报错或超时时返回 {@code null}
     *         （调用方据此回退到 MediaProjection，而不是把失败当异常往上抛）
     */
    @Nullable
    public static byte[] takeScreenshotBlocking(long timeoutMs) {
        return takeScreenshotBlocking(timeoutMs, JPEG_QUALITY);
    }

    /** 同上，但指定 JPEG 质量（周期采样要更小的体积）。 */
    @Nullable
    public static byte[] takeScreenshotBlocking(long timeoutMs, final int quality) {
        // API 30 以下没有 AccessibilityService.takeScreenshot，直接让上层回退
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
            return null;
        }
        AccessibilityService target = service;
        if (target == null) {
            // 无障碍服务没在跑：返回 null，交给上层回退。这里绝不能抛异常 ——
            // 回退路径本来就有一整套可用的错误提示
            return null;
        }

        final CountDownLatch latch = new CountDownLatch(1);
        final byte[][] holder = new byte[1][];
        // 系统只要求一个 Executor 用来回调；用短命的后台线程，绝不占用主线程
        final Executor executor = command -> {
            Thread worker = new Thread(command, "balloon-a11y-screenshot");
            worker.setDaemon(true);
            worker.start();
        };

        try {
            target.takeScreenshot(Display.DEFAULT_DISPLAY, executor,
                    new AccessibilityService.TakeScreenshotCallback() {
                        @Override
                        public void onSuccess(AccessibilityService.ScreenshotResult result) {
                            holder[0] = encode(result, quality);
                            latch.countDown();
                        }

                        @Override
                        public void onFailure(int errorCode) {
                            EventLog.warn("无障碍截图失败，错误码 " + errorCode
                                    + "（1=内部错误 2=没有无障碍访问权限 3=两次截图间隔过短 4=显示器无效）");
                            latch.countDown();
                        }
                    });
        } catch (SecurityException e) {
            // XML 里没声明 canTakeScreenshot、或系统收回了权限时会走到这里
            EventLog.warn("无障碍截图被系统拒绝：" + e.getMessage());
            return null;
        } catch (Exception e) {
            EventLog.warn("调用无障碍截图接口失败：" + e.getMessage());
            return null;
        }

        try {
            if (!latch.await(Math.max(1_000L, timeoutMs), TimeUnit.MILLISECONDS)) {
                EventLog.warn("无障碍截图超时（" + timeoutMs + " ms 内系统没有回调）");
                return null;
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return null;
        }
        return holder[0];
    }

    /**
     * {@code ScreenshotResult} → JPEG。
     *
     * <p>路线固定为 {@code HardwareBuffer} → {@code Bitmap.wrapHardwareBuffer} →
     * {@code copy(ARGB_8888)} → {@code compress(JPEG)}。硬件位图是只读的，必须先拷贝；
     * 而图形缓冲是有限资源，<b>无论如何都要在 finally 里 close</b>，否则很快耗尽。
     */
    @Nullable
    private static byte[] encode(AccessibilityService.ScreenshotResult result, int quality) {
        HardwareBuffer buffer = result.getHardwareBuffer();
        Bitmap software = null;
        try {
            Bitmap hardware = Bitmap.wrapHardwareBuffer(buffer, result.getColorSpace());
            if (hardware == null) {
                EventLog.warn("无障碍截图返回的画面无法解析（wrapHardwareBuffer 为 null）");
                return null;
            }
            software = hardware.copy(Bitmap.Config.ARGB_8888, false);
            if (software == null) {
                EventLog.warn("无障碍截图的画面拷贝失败");
                return null;
            }
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            software.compress(Bitmap.CompressFormat.JPEG, quality, out);
            byte[] jpeg = out.toByteArray();
            if (jpeg.length == 0) {
                EventLog.warn("无障碍截图压缩后为空");
                return null;
            }
            return jpeg;
        } catch (Exception e) {
            EventLog.warn("无障碍截图编码失败：" + e.getMessage());
            return null;
        } finally {
            if (software != null) {
                software.recycle();
            }
            try {
                buffer.close();
            } catch (Exception ignored) {
                // 已关闭过 / 系统已回收，忽略
            }
        }
    }
}
