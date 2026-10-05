package com.balloondog.agent.capability;

import android.app.admin.DevicePolicyManager;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;

import com.balloondog.agent.data.EventLog;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

/**
 * 运行时权限的授予与自检。
 *
 * <h3>为什么需要这个类</h3>
 *
 * <p>本 App 依赖一批「危险权限」（定位 / 相机 / 麦克风 / 通话记录 / 短信 / 通知）。
 * 从 Android 6 起，这类权限<b>必须显式申请</b>，只在 {@code AndroidManifest.xml} 里声明
 * 是不会生效的。
 *
 * <p>在补这个类之前，全仓库搜 {@code requestPermissions} 与 {@code setPermissionGrantState}
 * <b>零命中</b>：{@link CallLogReader} 与 {@link SmsReader} 只 {@code checkSelfPermission}
 * 读状态，设置页也只把「未授权」写出来，<b>却没有给任何授权入口</b>。
 *
 * <p>之所以一直没暴露，是因为三套设备 E2E 都用 {@code adb install -r -g} 装包
 * （{@code android/scripts/e2e-agent.mjs:521} 等），{@code -g} 会一次性授予全部运行时权限；
 * {@code android/README.md} 给用户的安装命令也带着 {@code -g}，还自述「省去逐个点弹框」。
 * <b>测试全绿只是因为这面旗子</b>。孩子或家长按普通方式点 APK 安装时，
 * 定位、相机、麦克风、通话记录、短信<b>全是拒绝状态</b>，
 * 于是定位上报、远程拍照、远程录音、通话与短信上报会<b>静默失效</b>。
 *
 * <h3>两条授权路径</h3>
 *
 * <ol>
 *   <li><b>设备所有者</b>：用 {@link DevicePolicyManager#setPermissionGrantState}
 *       <b>静默自授</b>，不弹任何框，孩子端无感。这是本 App 的正常形态 ——
 *       强管控本来就要求先设为设备所有者（见 {@link OwnerHardening}）。</li>
 *   <li><b>非设备所有者</b>：只能由 Activity 调
 *       {@code ActivityCompat.requestPermissions} 弹系统框让用户点。
 *       权限清单见 {@link #requiredPermissions()}，入口是设置页的「一键授权」。</li>
 * </ol>
 *
 * <p><b>刻意不包含</b> {@code PACKAGE_USAGE_STATS}（使用情况访问）：
 * 它是 appop 型特殊权限，{@code setPermissionGrantState} 也授不了，
 * 只能在系统设置页手动开 —— 那条路见 {@link AppUsageTracker#openSettings(Context)}。
 * 也不包含 VPN 授权，那条见 {@code DnsFilterVpnService} 的 {@code VpnService.prepare()}。
 */
public final class PermissionGranter {

    private PermissionGranter() {
    }

    /**
     * 本 App 真正用到的运行时权限。
     *
     * <p>顺序即弹框顺序：把「不做就废掉整条功能链」的放前面。
     * {@code POST_NOTIFICATIONS} 只在 Android 13+ 存在，低版本加进来只会立刻返回「已授权」，
     * 所以按版本过滤，避免在旧机器上弹一个不存在的权限。
     */
    public static List<String> requiredPermissions() {
        List<String> list = new ArrayList<>(Arrays.asList(
                android.Manifest.permission.ACCESS_FINE_LOCATION,
                android.Manifest.permission.ACCESS_COARSE_LOCATION,
                android.Manifest.permission.CAMERA,
                android.Manifest.permission.RECORD_AUDIO,
                android.Manifest.permission.READ_CALL_LOG,
                android.Manifest.permission.READ_SMS));
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            list.add("android.permission.POST_NOTIFICATIONS");
        }
        return list;
    }

    /** 还没被授予的权限。已授予的不会再问，避免反复骚扰孩子。 */
    public static List<String> missing(Context context) {
        List<String> missing = new ArrayList<>();
        for (String permission : requiredPermissions()) {
            if (context.checkSelfPermission(permission) != PackageManager.PERMISSION_GRANTED) {
                missing.add(permission);
            }
        }
        return missing;
    }

    public static boolean allGranted(Context context) {
        return missing(context).isEmpty();
    }

    /**
     * 设备所有者静默自授。
     *
     * @return 本次新授成功的权限条数；不是设备所有者时返回 0（调用方应改走弹框或设置页）
     */
    public static int grantAsDeviceOwner(Context context) {
        DevicePolicyManager dpm =
                (DevicePolicyManager) context.getSystemService(Context.DEVICE_POLICY_SERVICE);
        if (dpm == null || !dpm.isDeviceOwnerApp(context.getPackageName())) return 0;

        ComponentName admin = new ComponentName(context, AgentAdminReceiver.class);
        int granted = 0;
        for (String permission : missing(context)) {
            try {
                boolean ok = dpm.setPermissionGrantState(
                        admin,
                        context.getPackageName(),
                        permission,
                        DevicePolicyManager.PERMISSION_GRANT_STATE_GRANTED);
                if (ok) granted++;
            } catch (Exception e) {
                // 个别权限在某些 ROM 上不允许由设备所有者代授，如实记日志后继续，
                // 不要因为一条失败就放弃其余权限。
                EventLog.warn("设备所有者代授 " + labelOf(permission) + " 失败：" + e.getMessage());
            }
        }
        if (granted > 0) {
            EventLog.success("设备所有者已静默授予 " + granted + " 项运行时权限");
        }
        return granted;
    }

    /**
     * 兜底：跳到本应用的「应用信息」页，让家长手动点权限。
     *
     * <p>用于「既不是设备所有者、孩子又把系统弹框点了拒绝」这种情况 ——
     * 此时 {@code requestPermissions} 不再弹框，只能引导到设置页。
     */
    public static void openAppDetails(Context context) {
        try {
            Intent intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
            intent.setData(Uri.fromParts("package", context.getPackageName(), null));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            context.startActivity(intent);
        } catch (Exception e) {
            EventLog.warn("无法打开应用信息页：" + e.getMessage());
        }
    }

    /** 给人看的一行状态，设置页直接铺开显示。 */
    public static String describe(Context context) {
        StringBuilder sb = new StringBuilder();
        for (String permission : requiredPermissions()) {
            boolean granted = context.checkSelfPermission(permission)
                    == PackageManager.PERMISSION_GRANTED;
            if (sb.length() > 0) sb.append('\n');
            sb.append(labelOf(permission)).append('：').append(granted ? "已授权" : "未授权");
        }
        return sb.toString();
    }

    /** 权限的中文名，别再让界面上出现 {@code android.permission.READ_SMS} 这种东西。 */
    public static String labelOf(String permission) {
        if (android.Manifest.permission.ACCESS_FINE_LOCATION.equals(permission)
                || android.Manifest.permission.ACCESS_COARSE_LOCATION.equals(permission)) {
            return "定位";
        }
        if (android.Manifest.permission.CAMERA.equals(permission)) return "相机";
        if (android.Manifest.permission.RECORD_AUDIO.equals(permission)) return "麦克风";
        if (android.Manifest.permission.READ_CALL_LOG.equals(permission)) return "通话记录";
        if (android.Manifest.permission.READ_SMS.equals(permission)) return "短信";
        if ("android.permission.POST_NOTIFICATIONS".equals(permission)) return "通知";
        return permission;
    }
}
