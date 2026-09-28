package com.balloondog.agent.capability;

import android.Manifest;
import android.content.Context;
import android.content.pm.PackageManager;
import android.graphics.ImageFormat;
import android.hardware.camera2.CameraAccessException;
import android.hardware.camera2.CameraCaptureSession;
import android.hardware.camera2.CameraCharacteristics;
import android.hardware.camera2.CameraDevice;
import android.hardware.camera2.CameraManager;
import android.hardware.camera2.CameraMetadata;
import android.hardware.camera2.CaptureRequest;
import android.hardware.camera2.params.StreamConfigurationMap;
import android.media.Image;
import android.media.ImageReader;
import android.os.Handler;
import android.os.HandlerThread;
import android.util.Size;

import androidx.annotation.NonNull;
import androidx.core.content.ContextCompat;

import com.balloondog.agent.data.EventLog;

import java.nio.ByteBuffer;
import java.util.Arrays;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

/**
 * 远程拍照：用 Camera2 真正拍一张 JPEG。
 *
 * <p>为什么不用 CameraX / 调起系统相机：
 * <ul>
 *   <li>CameraX 需要 LifecycleOwner，而 Agent 跑在前台服务里，没有 Activity 生命周期；</li>
 *   <li>调起系统相机需要用户手动按快门 —— 远程拍照必须无感完成，家长点了就要有照片。</li>
 * </ul>
 * 因此这里直接用 Camera2 的 {@code TEMPLATE_STILL_CAPTURE} + {@code ImageReader}，
 * 在后台线程同步等到 JPEG 字节流。
 *
 * <p>默认使用<b>前置</b>摄像头：家长远程拍照的意图是「看看孩子现在在干什么」，
 * 前置摄像头正对使用者。设备没有前置摄像头时自动回退到后置。
 */
public final class PhotoCapturer {

    /** 单张照片的上传体积上限对应的大致边长；服务端 MEDIA_MAX_SIZE_MB 默认 10MB。 */
    private static final int MAX_TARGET_LONG_EDGE = 1920;

    private PhotoCapturer() {
    }

    /**
     * 拍一张 JPEG。
     *
     * @param preferFront true 优先前置（默认）
     * @param timeoutMs   总超时；超时抛 {@link CapabilityException}，避免 Agent 线程被卡死
     * @return JPEG 字节
     */
    public static byte[] captureJpeg(Context context, boolean preferFront, long timeoutMs)
            throws CapabilityException {

        if (ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA)
                != PackageManager.PERMISSION_GRANTED) {
            throw new CapabilityException("相机权限未授予，请在气球狗引导页里允许相机权限");
        }

        CameraManager manager = (CameraManager) context.getSystemService(Context.CAMERA_SERVICE);
        if (manager == null) {
            throw new CapabilityException("设备没有可用的相机服务");
        }

        String cameraId = pickCameraId(manager, preferFront);
        if (cameraId == null) {
            throw new CapabilityException("没有找到可用的摄像头");
        }

        Size size = pickSize(manager, cameraId);
        if (size == null) {
            throw new CapabilityException("摄像头不支持 JPEG 输出");
        }

        HandlerThread thread = new HandlerThread("balloon-camera");
        thread.start();
        Handler handler = new Handler(thread.getLooper());

        CountDownLatch done = new CountDownLatch(1);
        AtomicReference<byte[]> jpegRef = new AtomicReference<>();
        AtomicReference<String> errorRef = new AtomicReference<>();

        ImageReader reader = ImageReader.newInstance(size.getWidth(), size.getHeight(),
                ImageFormat.JPEG, 2);
        reader.setOnImageAvailableListener(imageReader -> {
            Image image = null;
            try {
                image = imageReader.acquireNextImage();
                if (image == null) return;
                ByteBuffer buffer = image.getPlanes()[0].getBuffer();
                byte[] bytes = new byte[buffer.remaining()];
                buffer.get(bytes);
                jpegRef.set(bytes);
            } catch (Exception e) {
                errorRef.set("读取照片数据失败：" + e.getMessage());
            } finally {
                if (image != null) image.close();
                done.countDown();
            }
        }, handler);

        CameraDevice[] deviceRef = new CameraDevice[1];
        CameraCaptureSession[] sessionRef = new CameraCaptureSession[1];

        CameraDevice.StateCallback deviceCallback = new CameraDevice.StateCallback() {
            @Override
            public void onOpened(@NonNull CameraDevice camera) {
                deviceRef[0] = camera;
                try {
                    CaptureRequest.Builder builder =
                            camera.createCaptureRequest(CameraDevice.TEMPLATE_STILL_CAPTURE);
                    builder.addTarget(reader.getSurface());
                    // 传感器方向 + 设备旋转角，保证照片不是躺着的
                    builder.set(CaptureRequest.JPEG_ORIENTATION, 90);
                    builder.set(CaptureRequest.CONTROL_MODE, CameraMetadata.CONTROL_MODE_AUTO);
                    builder.set(CaptureRequest.CONTROL_AF_MODE,
                            CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_PICTURE);

                    camera.createCaptureSession(
                            java.util.Collections.singletonList(reader.getSurface()),
                            new CameraCaptureSession.StateCallback() {
                                @Override
                                public void onConfigured(@NonNull CameraCaptureSession session) {
                                    sessionRef[0] = session;
                                    try {
                                        session.capture(builder.build(), new CameraCaptureSession.CaptureCallback() {
                                            // 结果通过 ImageReader 回调返回，这里无需处理
                                        }, handler);
                                    } catch (CameraAccessException e) {
                                        errorRef.set("发起拍照失败：" + e.getMessage());
                                        done.countDown();
                                    }
                                }

                                @Override
                                public void onConfigureFailed(@NonNull CameraCaptureSession session) {
                                    errorRef.set("相机会话配置失败，可能被其它应用占用");
                                    done.countDown();
                                }
                            },
                            handler);
                } catch (CameraAccessException e) {
                    errorRef.set("创建拍照请求失败：" + e.getMessage());
                    done.countDown();
                }
            }

            @Override
            public void onDisconnected(@NonNull CameraDevice camera) {
                errorRef.set("相机连接被断开（可能被其它应用抢占）");
                done.countDown();
            }

            @Override
            public void onError(@NonNull CameraDevice camera, int error) {
                errorRef.set("相机打开失败，错误码 " + error);
                done.countDown();
            }
        };

        try {
            manager.openCamera(cameraId, deviceCallback, handler);
        } catch (CameraAccessException | SecurityException e) {
            cleanup(thread, handler, reader, deviceRef, sessionRef);
            throw new CapabilityException("打开相机失败：" + e.getMessage(), e);
        }

        boolean finished;
        try {
            finished = done.await(timeoutMs, TimeUnit.MILLISECONDS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            finished = false;
        }

        cleanup(thread, handler, reader, deviceRef, sessionRef);

        if (!finished) {
            throw new CapabilityException("拍照超时（" + timeoutMs / 1000 + " 秒内没有拿到图像）");
        }
        String error = errorRef.get();
        if (error != null) {
            throw new CapabilityException(error);
        }
        byte[] jpeg = jpegRef.get();
        if (jpeg == null || jpeg.length == 0) {
            throw new CapabilityException("没有取到照片数据");
        }
        EventLog.success("已拍摄照片 " + size.getWidth() + "×" + size.getHeight()
                + "，" + (jpeg.length / 1024) + " KB");
        return jpeg;
    }

    private static void cleanup(HandlerThread thread, Handler handler, ImageReader reader,
                                CameraDevice[] deviceRef, CameraCaptureSession[] sessionRef) {
        try {
            if (sessionRef[0] != null) sessionRef[0].close();
        } catch (Exception ignored) {
            // 关闭失败不影响主流程
        }
        try {
            if (deviceRef[0] != null) deviceRef[0].close();
        } catch (Exception ignored) {
            // 同上
        }
        try {
            reader.close();
        } catch (Exception ignored) {
            // 同上
        }
        thread.quitSafely();
    }

    /** 优先前置，没有前置时回退后置；都没有返回 null。 */
    private static String pickCameraId(CameraManager manager, boolean preferFront) {
        String front = null;
        String back = null;
        try {
            for (String id : manager.getCameraIdList()) {
                CameraCharacteristics characteristics = manager.getCameraCharacteristics(id);
                Integer facing = characteristics.get(CameraCharacteristics.LENS_FACING);
                if (facing == null) continue;
                if (facing == CameraCharacteristics.LENS_FACING_FRONT && front == null) front = id;
                if (facing == CameraCharacteristics.LENS_FACING_BACK && back == null) back = id;
            }
        } catch (CameraAccessException e) {
            return null;
        }
        if (preferFront) return front != null ? front : back;
        return back != null ? back : front;
    }

    /** 选一个不超过 MAX_TARGET_LONG_EDGE 的最大 JPEG 尺寸，兼顾清晰度与上传体积。 */
    private static Size pickSize(CameraManager manager, String cameraId) {
        try {
            CameraCharacteristics characteristics = manager.getCameraCharacteristics(cameraId);
            StreamConfigurationMap map =
                    characteristics.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP);
            if (map == null) return null;
            Size[] sizes = map.getOutputSizes(ImageFormat.JPEG);
            if (sizes == null || sizes.length == 0) return null;

            Arrays.sort(sizes, (a, b) ->
                    Long.compare((long) b.getWidth() * b.getHeight(), (long) a.getWidth() * a.getHeight()));

            for (Size size : sizes) {
                if (Math.max(size.getWidth(), size.getHeight()) <= MAX_TARGET_LONG_EDGE) {
                    return size;
                }
            }
            // 全都很大时退而取最小的一张，至少保证能拍
            return sizes[sizes.length - 1];
        } catch (CameraAccessException e) {
            return null;
        }
    }

    /** 摄像头数量与朝向摘要，用于主界面展示「远程拍照能不能用」。 */
    public static String describeCameras(Context context) {
        CameraManager manager = (CameraManager) context.getSystemService(Context.CAMERA_SERVICE);
        if (manager == null) return "无相机服务";
        try {
            String[] ids = manager.getCameraIdList();
            if (ids.length == 0) return "无摄像头";
            StringBuilder sb = new StringBuilder();
            for (String id : ids) {
                CameraCharacteristics characteristics = manager.getCameraCharacteristics(id);
                Integer facing = characteristics.get(CameraCharacteristics.LENS_FACING);
                String label;
                if (facing == null) {
                    label = "未知";
                } else if (facing == CameraCharacteristics.LENS_FACING_FRONT) {
                    label = "前置";
                } else if (facing == CameraCharacteristics.LENS_FACING_BACK) {
                    label = "后置";
                } else {
                    label = "外接";
                }
                if (sb.length() > 0) sb.append("、");
                sb.append(label);
            }
            return ids.length + " 个（" + sb + "）";
        } catch (CameraAccessException e) {
            return "读取摄像头信息失败";
        }
    }
}
