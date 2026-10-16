package com.balloondog.agent.capability;

import android.app.admin.DevicePolicyManager;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;

import java.util.List;

/**
 * 学习模式专用桌面（规划 §4.4）的**执行**部分：把默认桌面钉到学习桌面 / 结束学习模式时还回去。
 *
 * <p>为什么只有设备所有者能做：改默认桌面是系统级设置，普通应用顶多弹一个选择框。
 * 本应用在受管设备上是设备所有者（授权流程见 android/README §2），所以可用
 * {@link DevicePolicyManager#addPersistentPreferredActivity} 把 HOME 意图永久指向我们，
 * 结束时用 {@code clearPackagePersistentPreferredActivities} 立刻还回去。
 *
 * <p><b>接管是「钉住」而不是「抢一次」</b>：孩子按 home 键、长按 home、上滑回桌面，
 * 系统都会把他送回我们这里。真正的出口只有两个 —— 家长结束学习模式，或家长端解绑设备
 * （解绑时 {@code AgentStore.healStalePolicyCache()} 会调 {@link #release(Context)}）。
 *
 * <p><b>失败必须留痕、而且不能装成功</b>：没有设备所有者时 {@link #hold} 返回 false
 * 并把「未接管」写进偏好，调用方据此在动态里如实说明，而不是让孩子对着一个假的
 * 学习桌面以为管控生效了。
 */
public final class StudyHomeController {

    private static final String PREFS = "study_home";
    private static final String KEY_HELD = "held";

    private StudyHomeController() {
    }

    public static boolean isDeviceOwner(Context context) {
        DevicePolicyManager dpm = devicePolicy(context);
        if (dpm == null) return false;
        try {
            return dpm.isDeviceOwnerApp(context.getPackageName());
        } catch (Throwable t) {
            return false;
        }
    }

    /**
     * 把默认桌面钉到 {@code launcher}。只有设备所有者会真的成功。
     *
     * @return 是否真的钉上了（false 时调用方要在动态里如实说明）
     */
    public static boolean hold(Context context, ComponentName launcher) {
        DevicePolicyManager dpm = devicePolicy(context);
        if (dpm == null || launcher == null || !isDeviceOwner(context)) return false;
        try {
            dpm.addPersistentPreferredActivity(admin(context), homeFilter(), launcher);
        } catch (Throwable t) {
            return false;
        }
        prefs(context).edit().putBoolean(KEY_HELD, true).apply();
        return true;
    }

    /** 把桌面还回系统原来的应用（幂等：没钉上过、系统行为不同都不该让退出学习模式失败）。 */
    public static void release(Context context) {
        DevicePolicyManager dpm = devicePolicy(context);
        if (dpm != null && isDeviceOwner(context)) {
            try {
                dpm.clearPackagePersistentPreferredActivities(admin(context), context.getPackageName());
            } catch (Throwable ignored) {
                // 尽力而为：清除失败也不该阻塞别的收尾动作
            }
        }
        prefs(context).edit().putBoolean(KEY_HELD, false).apply();
    }

    /** 上一次是否真的钉住了桌面 —— 进程重启后靠它恢复判断，避免重复钉或忘记还。 */
    public static boolean isHeld(Context context) {
        return prefs(context).getBoolean(KEY_HELD, false);
    }

    /**
     * 系统里真正的桌面（排除我们自己），用于「不再接管时把孩子送回他自己的桌面」。
     *
     * @return 找不到时返回 null（调用方退回「不做任何跳转」）
     */
    public static String realHomePackage(Context context) {
        PackageManager pm = context.getPackageManager();
        List<ResolveInfo> homes = pm.queryIntentActivities(homeIntent(), 0);
        String self = context.getPackageName();
        for (ResolveInfo info : homes) {
            if (info == null || info.activityInfo == null) continue;
            String pkg = info.activityInfo.packageName;
            if (pkg != null && !pkg.equals(self)) return pkg;
        }
        return null;
    }

    /** DPM 要的是 IntentFilter（不是 Intent）：把 MAIN + HOME + DEFAULT 三条都声明齐，
     *  少一条系统就不认这个「默认桌面」意图。 */
    private static IntentFilter homeFilter() {
        IntentFilter filter = new IntentFilter(Intent.ACTION_MAIN);
        filter.addCategory(Intent.CATEGORY_HOME);
        filter.addCategory(Intent.CATEGORY_DEFAULT);
        return filter;
    }

    private static Intent homeIntent() {
        Intent intent = new Intent(Intent.ACTION_MAIN);
        intent.addCategory(Intent.CATEGORY_HOME);
        intent.addCategory(Intent.CATEGORY_DEFAULT);
        return intent;
    }

    private static DevicePolicyManager devicePolicy(Context context) {
        return (DevicePolicyManager) context.getSystemService(Context.DEVICE_POLICY_SERVICE);
    }

    private static ComponentName admin(Context context) {
        return new ComponentName(context, AgentAdminReceiver.class);
    }

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }
}
