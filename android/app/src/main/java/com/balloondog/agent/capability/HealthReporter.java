package com.balloondog.agent.capability;

import android.Manifest;
import android.content.Context;
import android.content.pm.PackageManager;

import androidx.annotation.Nullable;

import com.balloondog.agent.data.AgentStore;
import com.balloondog.agent.service.AgentService;
import com.balloondog.agent.service.DnsFilterVpnService;
import com.balloondog.agent.service.LockWatchdogService;
import com.balloondog.agent.service.LongevityGuard;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 把「设备自己知道的真实状态」打包成一份健康快照。
 *
 * <h3>为什么需要它</h3>
 *
 * <p>孩子端 20 多项能力全都压在两三个开关上（设备所有者 / 无障碍看门狗 / 授权 / 电池白名单 / VPN）。
 * 任意一个被关掉，管控就<b>静默失效</b> —— 设备照样「在线」，家长端照样显示绿灯。
 * 这个类只做一件事：把 {@link LongevityGuard} 与各能力模块已经算出来的结论
 * 汇总成一个 JSON，交给 {@code /api/agent/health} 上报。
 *
 * <h3>三条硬规则</h3>
 *
 * <ol>
 *   <li><b>不新写检测</b>：每一项的取值都来自现有方法（{@code LockController} / {@code OwnerHardening}
 *       / {@code LongevityGuard}…），避免出现「两处判断不一致」。</li>
 *   <li><b>不猜未知</b>：某个 key 拿不到就不放进 {@code checks}，服务端会显示「未知」。
 *       编一个 {@code true} 出来比不报更危险 —— 家长会以为一切正常。</li>
 *   <li><b>缺口原文透传</b>：{@link LongevityGuard#problems} 那几句中文直接作为 {@code detail}
 *       上报，家长端不再重写一遍。两边各写一套迟早会说岔（设备说无障碍被关、家长端说悬浮窗被关）。</li>
 * </ol>
 */
public final class HealthReporter {

    /** 与 server 端 devices.constants.ts 的 HEALTH_CHECK_DEFS 对齐（顺序无关，key 必须一致）。 */
    public static final String KEY_DEVICE_OWNER = "deviceOwner";
    public static final String KEY_ADMIN_ACTIVE = "adminActive";
    public static final String KEY_OVERLAY = "overlay";
    public static final String KEY_ACCESSIBILITY = "accessibility";
    public static final String KEY_BATTERY = "batteryWhitelist";
    public static final String KEY_VPN_CONSENT = "vpnConsent";
    public static final String KEY_VPN_ALWAYS_ON = "vpnAlwaysOn";
    public static final String KEY_USAGE_ACCESS = "usageAccess";
    public static final String KEY_PROTECTED_PACKAGE = "protectedPackage";

    private HealthReporter() {
    }

    /**
     * 构建一份完整快照。
     *
     * <p>耗时只有本地 binder 调用，但仍建议在后台线程调用（{@code OwnerHardening.audit} 会遍历
     * 20 多条用户限制，每条都是一次 binder）。
     */
    public static JSONObject snapshot(Context context, AgentStore store) {
        JSONObject body = new JSONObject();
        try {
            List<LongevityGuard.Gap> gaps = LongevityGuard.gaps(context, store);
            body.put("level", levelOf(context, store, gaps));
            body.put("gaps", gapsToJson(gaps));
            body.put("checks", checks(context, store));
            body.put("permissions", permissions(context));
            body.put("restrictions", restrictions(context));
            body.put("serviceRunning", AgentService.isRunning());
            body.put("healCount", LongevityGuard.healCount());
            long lastHealAt = LongevityGuard.lastHealAt();
            if (lastHealAt > 0) body.put("lastHealAt", iso(lastHealAt));
            // 时钟偏移由 TrustedClock 维护：设备墙钟 − 服务端时间。
            // 孩子改系统时间就能绕过定时锁屏与屏幕时间限制，这个数字是识别它的唯一线索。
            body.put("clockSkewSeconds", TrustedClock.skewSeconds());
        } catch (JSONException ignored) {
            // 全部是原生类型与 JSONObject，实际不会抛
        }
        return body;
    }

    /**
     * 设备端自己的结论。
     *
     * <p>服务端也能用 {@code checks} 兜底推算（老 Agent 不发 level 时），但**关键项的定义在
     * 设备端**（哪一项关掉算危险），所以能自己判就自己判，两边不会打架。
     */
    public static String levelOf(Context context, AgentStore store, List<LongevityGuard.Gap> gaps) {
        for (LongevityGuard.Gap gap : gaps) {
            if (gap.critical) return "danger";
        }
        return gaps.isEmpty() ? "ok" : "warn";
    }

    /** 布尔开关一览。拿不到的项直接不放进 map（服务端显示「未知」）。 */
    private static JSONObject checks(Context context, AgentStore store) throws JSONException {
        JSONObject checks = new JSONObject();
        checks.put(KEY_DEVICE_OWNER, LockController.isDeviceOwner(context));
        checks.put(KEY_ADMIN_ACTIVE, LockController.isAdminActive(context));
        checks.put(KEY_OVERLAY, LockController.canDrawOverlays(context));
        checks.put(KEY_ACCESSIBILITY, LockWatchdogService.isEnabledInSettings(context));
        checks.put(KEY_BATTERY, LongevityGuard.isIgnoringBatteryOptimizations(context));
        checks.put(KEY_PROTECTED_PACKAGE, OwnerHardening.hasProtectedPackage(context));
        // VPN 两项只在「家长真的开着网址拦截」时才有意义：黑名单为空时本来就不建 VPN，
        // 报 false 会变成一条假缺口（LongevityGuard.problems 用的是同一判据）。
        if (DnsFilterVpnService.isWanted(context)) {
            checks.put(KEY_VPN_CONSENT, DnsFilterVpnService.hasSystemConsent(context));
            checks.put(KEY_VPN_ALWAYS_ON, DnsFilterVpnService.isAlwaysOn(context));
        }
        checks.put(KEY_USAGE_ACCESS, AppUsageTracker.hasPermission(context));
        return checks;
    }

    /**
     * 运行时权限快照。
     *
     * <p>用 {@code checkSelfPermission} 而不是读 {@code PermissionGranter} 的缓存：
     * 家长要在孩子撤销权限后立刻看到红灯，缓存会让它慢一拍。
     */
    private static JSONObject permissions(Context context) throws JSONException {
        JSONObject permissions = new JSONObject();
        permissions.put("location", granted(context, Manifest.permission.ACCESS_FINE_LOCATION));
        permissions.put("camera", granted(context, Manifest.permission.CAMERA));
        permissions.put("mic", granted(context, Manifest.permission.RECORD_AUDIO));
        permissions.put("callLog", granted(context, Manifest.permission.READ_CALL_LOG));
        permissions.put("sms", granted(context, Manifest.permission.READ_SMS));
        // POST_NOTIFICATIONS 只在 API 33+ 存在；低版本直接算「已授权」（系统本来就没有这个开关）
        if (android.os.Build.VERSION.SDK_INT >= 33) {
            permissions.put("notification", granted(context, "android.permission.POST_NOTIFICATIONS"));
        } else {
            permissions.put("notification", "granted");
        }
        return permissions;
    }

    private static String granted(Context context, String permission) {
        return context.checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED
                ? "granted" : "denied";
    }

    /** {@code OwnerHardening.audit()} 的原样输出：某一项在这台机器上支不支持、有没生效。 */
    private static JSONArray restrictions(Context context) throws JSONException {
        JSONArray array = new JSONArray();
        for (OwnerHardening.Item item : OwnerHardening.audit(context)) {
            JSONObject o = new JSONObject();
            o.put("id", item.id);
            o.put("label", item.label);
            o.put("supported", item.supported);
            o.put("applied", item.applied);
            array.put(o);
        }
        return array;
    }

    /**
     * 缺口 → 结构化 JSON。
     *
     * <p>{@code fixability=auto} 的项点「重新检测」（{@code self_check} 指令）就会自愈；
     * {@code manual} 必须有人在孩子手机上点系统框；{@code none} 是系统限制，如实告知。
     */
    private static JSONArray gapsToJson(List<LongevityGuard.Gap> gaps) throws JSONException {
        JSONArray array = new JSONArray();
        for (LongevityGuard.Gap gap : gaps) {
            JSONObject o = new JSONObject();
            o.put("id", gap.id);
            o.put("label", gap.label);
            o.put("detail", gap.detail);
            o.put("importance", gap.critical ? "critical" : gap.importance);
            o.put("fixability", gap.fixability);
            if (gap.fixHint != null && !gap.fixHint.isEmpty()) o.put("fixHint", gap.fixHint);
            array.put(o);
        }
        return array;
    }

    private static String iso(long millis) {
        return new java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", java.util.Locale.US)
                .format(new java.util.Date(millis));
    }

    /**
     * 自检摘要，给 {@code self_check} 指令的回报用。
     *
     * <p>家长端点「重新检测」后要看到「修好了什么 / 还差什么」，所以这里把自愈动作与
     * 剩余缺口一起说清楚，而不是只回一个 {@code success}。
     */
    public static JSONObject selfCheckResult(Context context, AgentStore store, String healSummary,
                                             @Nullable JSONObject healthAfter) {
        JSONObject result = new JSONObject();
        try {
            result.put("healed", healSummary == null ? "" : healSummary);
            if (healthAfter != null) {
                result.put("level", healthAfter.optString("level", "warn"));
                result.put("openGaps", healthAfter.optJSONArray("gaps") == null
                        ? 0 : healthAfter.optJSONArray("gaps").length());
            }
        } catch (JSONException ignored) {
            // 原生类型，不会抛
        }
        return result;
    }

    /** 便于日志与调试：把 checks 拍平成「key=true/false」的一行。 */
    public static String describe(JSONObject checks) {
        if (checks == null) return "";
        List<String> parts = new ArrayList<>();
        Map<String, Object> ordered = new LinkedHashMap<>();
        java.util.Iterator<String> it = checks.keys();
        while (it.hasNext()) {
            String key = it.next();
            ordered.put(key, checks.opt(key));
        }
        for (Map.Entry<String, Object> e : ordered.entrySet()) {
            parts.add(e.getKey() + "=" + e.getValue());
        }
        return android.text.TextUtils.join(", ", parts);
    }
}
