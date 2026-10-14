package com.balloondog.agent.capability;

import android.app.admin.DeviceAdminReceiver;
import android.content.Context;
import android.content.Intent;
import android.widget.Toast;

import com.balloondog.agent.data.AgentStore;
import com.balloondog.agent.data.EventLog;

import java.util.List;

/**
 * 设备管理器接收器。
 *
 * <p>只有激活了设备管理器，应用才能调用 {@code DevicePolicyManager.lockNow()} 真正锁屏 ——
 * 这是「一键锁屏」从「界面上显示已锁定」变成「屏幕真的锁上」的关键一步。
 *
 * <p>若进一步把应用设为 <b>Device Owner</b>（设备所有者），还能做到：
 * <ul>
 *   <li>{@code setKeyguardDisabled} —— 无密码设备上临时解锁（配合家长端的「临时使用」）；</li>
 *   <li>{@code setApplicationHidden} —— 真正禁用被限制的应用；</li>
 *   <li>{@code setStatusBarDisabled} —— 锁定时禁止下拉状态栏绕过。</li>
 * </ul>
 * Device Owner 只能在设备未添加任何账号时通过 adb 设置：
 * <pre>
 * adb shell dpm set-device-owner com.balloondog.agent/.capability.AgentAdminReceiver
 * </pre>
 */
public class AgentAdminReceiver extends DeviceAdminReceiver {

    public static final String TAG = "AgentAdminReceiver";

    @Override
    public void onEnabled(Context context, Intent intent) {
        super.onEnabled(context, intent);
        if (!LockController.isDeviceOwner(context)) {
            EventLog.success("设备管理器已激活，可以真正锁屏了");
            return;
        }
        // 刚被 `dpm set-device-owner` 设成设备所有者的这一刻，AgentService 很可能还没起来。
        // 不在这里下发限制的话，「已是设备所有者、但限制还没加上」的窗口里应用照样能被卸载 ——
        // 家长看到的现象就是「明明设了设备所有者还是卸掉了」。
        applyHardening(context, "成为设备所有者");
    }

    /**
     * 走 QR / NFC 预置流程时系统回调这里 —— 同样是「刚成为设备所有者」的时刻。
     *
     * <p>只依赖 {@code AgentService} 启动时的自愈会留下一段空窗：预置结束到首次打开应用之间，
     * 卸载拦截与用户限制都还没生效。
     */
    @Override
    public void onProfileProvisioningComplete(Context context, Intent intent) {
        super.onProfileProvisioningComplete(context, intent);
        applyHardening(context, "设备预置完成");
    }

    /**
     * 立刻下发加固限制。
     *
     * <p>与 {@code LongevityGuard.selfHeal()} 保持一致：家长关掉「加固」开关时不下发，
     * 否则会出现「家长刚关掉、这里又偷偷加上」的反复横跳。
     */
    private static void applyHardening(Context context, String reason) {
        try {
            AgentStore store = new AgentStore(context);
            if (!store.isHardeningEnabled()) {
                EventLog.warn("加固开关已关闭，跳过下发限制（" + reason + "）");
                return;
            }
            List<OwnerHardening.Item> items = OwnerHardening.apply(context);
            OwnerHardening.logReport(items, reason);
            EventLog.success("设备所有者已就位，加固限制已下发：" + OwnerHardening.summary(items));
        } catch (Exception e) {
            EventLog.warn("下发加固限制失败：" + e.getMessage());
        }
    }

    @Override
    public void onDisabled(Context context, Intent intent) {
        super.onDisabled(context, intent);
        EventLog.warn("设备管理器被关闭，锁屏能力失效（会退化为应用内遮罩锁定）");
    }

    @Override
    public CharSequence onDisableRequested(Context context, Intent intent) {
        return "关闭后气球狗将无法锁定这台设备的屏幕。确定要关闭吗？";
    }

    @Override
    public void onPasswordFailed(Context context, Intent intent) {
        // 家长端后续可基于此扩展「密码错误次数」告警，这里只留日志便于排查
        EventLog.warn("设备锁屏密码输入错误");
    }

    @Override
    public void onLockTaskModeEntering(Context context, Intent intent, String pkg) {
        Toast.makeText(context, "已进入锁定任务模式", Toast.LENGTH_SHORT).show();
    }
}
