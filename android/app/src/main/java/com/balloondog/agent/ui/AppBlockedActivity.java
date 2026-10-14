package com.balloondog.agent.ui;

import android.content.Context;
import android.content.Intent;
import android.os.Bundle;
import android.text.TextUtils;
import android.view.View;

import androidx.annotation.Nullable;
import androidx.appcompat.app.AppCompatActivity;

import com.balloondog.agent.data.EventLog;
import com.balloondog.agent.databinding.ActivityAppBlockedBinding;

/**
 * 「这个应用被禁止使用」说明页。
 *
 * <p>在此之前，看门狗拦下一个应用的做法只是按一下系统返回键：孩子被静默弹回上一个界面，
 * 既不知道发生了什么，也不知道该找谁 —— 观感就是「手机坏了」。
 * 这一页把拦截变成一次**看得懂的拒绝**：哪个应用、为什么被禁、想用该怎么办。
 *
 * <h3>它不做什么</h3>
 * <ul>
 *   <li>不要权限、不锁设备：这是一张说明页，不是锁定页（锁定走 {@link LockScreenActivity}）；</li>
 *   <li>不申请 {@code showWhenLocked} / 不进 kiosk：它只是一个普通的 NEW_TASK 页面。
 *       启动时先借 {@link LockWatchdogBridge#startActivityFromService} 走无障碍服务的豁免，
 *       失败再退回普通 {@code startActivity}（后台启动限制会拦后者）；</li>
 *   <li>唯一的出口是「回桌面」，所以孩子不会被扔回被禁的应用里。</li>
 * </ul>
 *
 * <p>布局里没有任何 {@code @string/} 引用：孩子端只有中文，静态文案直接写在
 * {@code res/layout/activity_app_blocked.xml} 里，动态部分由 Intent extras 带进来。
 */
public class AppBlockedActivity extends AppCompatActivity {

    private static final String EXTRA_APP_LABEL = "extra_app_label";
    private static final String EXTRA_REASON = "extra_reason";
    private static final String EXTRA_DETAIL = "extra_detail";

    /** {@code appLabel} 为空时的占位文案。 */
    private static final String FALLBACK_APP_LABEL = "这个应用";
    /** {@code reason} 为空时的兜底原因。 */
    private static final String FALLBACK_REASON = "家长设置了使用限制";

    private ActivityAppBlockedBinding binding;

    /**
     * 弹一页「这个应用被禁止使用」的说明。
     *
     * @param appLabel 被禁应用的名字（可为 null，null 时文案退回「这个应用」）
     * @param reason   为什么被禁，一句话（由拦截方算好，例如「学习模式：只允许使用白名单应用」）
     * @param detail   补充说明，可为 null
     */
    public static void show(Context context, @Nullable String appLabel,
                            @Nullable String reason, @Nullable String detail) {
        if (context == null) {
            return;
        }
        Intent intent = new Intent(context, AppBlockedActivity.class);
        intent.putExtra(EXTRA_APP_LABEL, appLabel);
        intent.putExtra(EXTRA_REASON, reason);
        intent.putExtra(EXTRA_DETAIL, detail);
        // 从服务 / 无障碍服务（没有 Activity 栈）里启动，NEW_TASK 是必需的；
        // CLEAR_TOP + SINGLE_TOP 配合 manifest 的 singleTop：连续拦截多个应用时
        // 复用同一个实例并走 onNewIntent 刷新文案，而不是堆一摞说明页。
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK
                | Intent.FLAG_ACTIVITY_CLEAR_TOP
                | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        // 先借无障碍服务的上下文启动 —— Android 10 起禁止后台应用自行弹 Activity，
        // 唯一的常用豁免是 SYSTEM_ALERT_WINDOW，而悬浮窗权限恰好是可以被撤销的
        // （LockOverlayWindow 的降级路就是被这一点堵死的，见 LockWatchdogBridge）。
        // 无障碍服务是另一条合法豁免，先走它，失败了再退回普通启动。
        if (LockWatchdogBridge.startActivityFromService(intent)) {
            return;
        }
        try {
            context.startActivity(intent);
        } catch (Exception e) {
            // 后台启动 Activity 在部分 ROM 上会被系统拦掉（后台启动限制 / 省电策略）。
            // 这里不该让拦截流程崩掉 —— 记一条日志，让家长端和孩子端主界面的运行日志能看出来。
            EventLog.warn("应用禁止说明页启动失败：" + e);
        }
    }

    @Override
    protected void onCreate(@Nullable Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        binding = ActivityAppBlockedBinding.inflate(getLayoutInflater());
        setContentView(binding.getRoot());

        binding.buttonBackHome.setOnClickListener(v -> goHome());
        render(getIntent());
    }

    /**
     * {@code singleTop} + {@code CLEAR_TOP}：说明页已经在前台时，新的拦截不会再建实例，
     * 而是把新的 Intent 投递到这里。必须重新渲染，否则孩子看到的是上一个应用的原因。
     */
    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        render(intent);
    }

    private void render(@Nullable Intent intent) {
        String appLabel = safeString(intent, EXTRA_APP_LABEL, FALLBACK_APP_LABEL);
        String reason = safeString(intent, EXTRA_REASON, FALLBACK_REASON);
        String detail = intent == null ? null : intent.getStringExtra(EXTRA_DETAIL);

        binding.textAppName.setText(appLabel);
        binding.textReason.setText(reason);

        if (TextUtils.isEmpty(detail)) {
            binding.textDetail.setVisibility(View.GONE);
        } else {
            binding.textDetail.setText(detail);
            binding.textDetail.setVisibility(View.VISIBLE);
        }
    }

    /**
     * 取一个一定非空的文案：extras 缺失、传了 null、或是空白串都退回兜底值。
     * 「应用」和「原因」是这一页存在的理由，不能出现空白。
     */
    private static String safeString(@Nullable Intent intent, String key, String fallback) {
        String value = intent == null ? null : intent.getStringExtra(key);
        return TextUtils.isEmpty(value) || value.trim().isEmpty() ? fallback : value;
    }

    /**
     * 返回键与「返回桌面」按钮做同一件事。
     *
     * <p>与 {@link LockScreenActivity} 的写法保持一致（重写 {@code onBackPressed}，
     * 不用 {@code OnBackPressedCallback}）。区别是这里**不吞掉**按键：
     * 孩子按返回是合理诉求，只是目的地必须是桌面，绝不能是刚才那个被禁的应用。
     */
    @Override
    public void onBackPressed() {
        goHome();
    }

    /** 唯一的出口：回桌面，然后关掉自己。 */
    private void goHome() {
        try {
            Intent home = new Intent(Intent.ACTION_MAIN);
            home.addCategory(Intent.CATEGORY_HOME);
            home.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(home);
        } catch (Exception e) {
            // 连桌面都拉不起来（极少见）也不能把页面卡在这儿 —— 直接关掉，
            // 前面被拦下的应用不会因此回到前台。
            EventLog.warn("应用禁止说明页返回桌面失败：" + e);
        }
        finish();
    }
}
