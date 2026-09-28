package com.balloondog.agent.capability;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.media.projection.MediaProjectionManager;
import android.os.Bundle;
import android.view.Gravity;
import android.view.ViewGroup;
import android.widget.LinearLayout;
import android.widget.TextView;

import androidx.annotation.Nullable;

import com.balloondog.agent.data.EventLog;

import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/**
 * 申请「屏幕录制 / 截屏」授权的一次性透明页面。
 *
 * <p>Android 的安全模型决定了 <b>MediaProjection 的授权只能由 Activity 通过
 * {@code startActivityForResult} 拿到</b>，前台服务拿不到。所以这里放一个几乎不可见的
 * Activity，只负责弹出系统授权框、把结果交回给 {@link ScreenCapturer}，然后立刻结束。
 *
 * <p>Android 14 起，每次新的投影会话都要重新授权（授权令牌一次性）。
 * 因此本页可能被反复拉起 —— 这是系统行为，不是缺陷；
 * 但同一份授权换来的 {@code MediaProjection} 实例会被 {@link ScreenCapturer} 一直复用，
 * 所以「截图 → 截图 → 录像」不会每步都弹框。
 */
public class ProjectionConsentActivity extends Activity {

    private static final int REQUEST_CODE = 0x5C01;

    private static volatile CountDownLatch pendingLatch;
    private static volatile int pendingResultCode = Activity.RESULT_CANCELED;
    private static volatile Intent pendingData;

    /** 由 {@link ScreenCapturer} 调用：拉起授权页并等待结果。 */
    static boolean await(Context context, long timeoutMs) throws CapabilityException {
        CountDownLatch latch = new CountDownLatch(1);
        pendingLatch = latch;
        pendingResultCode = Activity.RESULT_CANCELED;
        pendingData = null;

        Intent intent = new Intent(context, ProjectionConsentActivity.class);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK
                | Intent.FLAG_ACTIVITY_CLEAR_TOP
                | Intent.FLAG_ACTIVITY_EXCLUDE_FROM_RECENTS);
        try {
            context.startActivity(intent);
        } catch (Exception e) {
            throw new CapabilityException("无法弹出屏幕共享授权框（后台启动界面被系统拦截）："
                    + e.getMessage(), e);
        }

        try {
            if (!latch.await(timeoutMs, TimeUnit.MILLISECONDS)) {
                throw new CapabilityException("等待屏幕共享授权超时，请在设备上点击「立即开始」");
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new CapabilityException("屏幕共享授权被中断");
        }

        if (pendingResultCode != Activity.RESULT_OK || pendingData == null) {
            throw new CapabilityException("屏幕共享授权被拒绝，无法截图或录屏");
        }
        return true;
    }

    @Override
    protected void onCreate(@Nullable Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setFinishOnTouchOutside(false);

        // 极简提示：系统弹框之外给一句中文说明，避免孩子/家长看到英文系统弹框一头雾水
        LinearLayout layout = new LinearLayout(this);
        layout.setOrientation(LinearLayout.VERTICAL);
        layout.setGravity(Gravity.CENTER);
        layout.setPadding(48, 48, 48, 48);
        layout.setBackgroundColor(0xE6000000);

        TextView title = new TextView(this);
        title.setText("家长正在查看这台设备的屏幕");
        title.setTextColor(0xFFFFFFFF);
        title.setTextSize(18f);
        layout.addView(title);

        TextView hint = new TextView(this);
        hint.setText("请在系统弹框中选择「立即开始」以授权");
        hint.setTextColor(0xFFB0B0B0);
        hint.setTextSize(14f);
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        params.topMargin = 24;
        layout.addView(hint, params);

        setContentView(layout);

        MediaProjectionManager manager =
                (MediaProjectionManager) getSystemService(Context.MEDIA_PROJECTION_SERVICE);
        if (manager == null) {
            deliver(RESULT_CANCELED, null);
            return;
        }
        try {
            startActivityForResult(manager.createScreenCaptureIntent(), REQUEST_CODE);
        } catch (Exception e) {
            EventLog.error("弹出屏幕共享授权框失败：" + e.getMessage());
            deliver(RESULT_CANCELED, null);
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, @Nullable Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == REQUEST_CODE) {
            deliver(resultCode, data);
        }
    }

    private void deliver(int resultCode, @Nullable Intent data) {
        pendingResultCode = resultCode;
        pendingData = data;
        CountDownLatch latch = pendingLatch;
        if (latch != null) latch.countDown();
        finish();
    }

    static int resultCode() {
        return pendingResultCode;
    }

    @Nullable
    static Intent resultData() {
        return pendingData;
    }
}
