package com.balloondog.agent.capability;

import android.app.admin.DevicePolicyManager;
import android.content.ComponentName;
import android.content.Context;
import android.os.Build;
import android.os.Bundle;
import android.os.UserManager;
import android.provider.Settings;
import android.text.TextUtils;

import com.balloondog.agent.data.EventLog;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * 设备所有者级「防卸载 / 防强停 / 防恢复出厂」加固。
 *
 * <p>对应需求 1。必须先讲清楚一件事：<b>在不是设备所有者的设备上，这一整套都做不到。</b>
 * 孩子可以在「设置 → 应用 → 强行停止」里一键停掉本应用，而应用一旦进入 stopped 状态，
 * 任何广播、JobScheduler、AlarmManager 都无法再把它唤醒 —— 双进程互相拉起也一样，
 * 因为强停会杀掉该应用<b>所有</b>进程。这是 Android 的设计，不是实现缺陷。
 * 唯一可靠的解法是设备所有者 + 下面这些限制项。
 *
 * <p>本类里每一项都做了 try/catch：不同厂商 ROM 对部分限制项的实现并不完整，
 * 一个失败不应该让整个加固流程中断。{@link #audit(Context)} 会逐项如实回报
 * 「支持 / 已生效 / 失败原因」，{@link #apply(Context)} 每次都把清单重新施加一遍，
 * 因此天然幂等：孩子若抢在加固生效前钻了一次空子，下次启动会被补上。
 *
 * <p>日志格式（给设备级断言用，`adb logcat -s BalloonDog`）：
 * <pre>气球狗加固[id] applied=true supported=true label=… detail=…</pre>
 * 每项一行，前缀固定，便于机器解析。
 */
public final class OwnerHardening {

    /** 日志前缀，e2e 脚本按它抓取逐项加固报告。 */
    public static final String LOG_TAG = "气球狗加固";

    private OwnerHardening() {
    }

    // ---------------------------------------------------------------- 可枚举清单

    /** 一条加固项的自检结果。 */
    public static final class Item {
        public final String id;
        public final String label;
        /** 当前是否确实生效（读回设备真实状态，不是「我调过 API」）。 */
        public final boolean applied;
        /** 本机 Android 版本是否支持这一项。 */
        public final boolean supported;
        /** 中文说明：生效细节 / 降级后少了什么 / 失败原因。 */
        public final String detail;

        Item(String id, String label, boolean applied, boolean supported, String detail) {
            this.id = id;
            this.label = label;
            this.applied = applied;
            this.supported = supported;
            this.detail = detail;
        }

        /** 界面展示用：「禁止卸载本应用：已生效」。 */
        public String render() {
            if (!supported) return label + "：本机不支持（" + detail + "）";
            return label + "：" + (applied ? "已生效" : "未生效") + (detail.isEmpty() ? "" : "（" + detail + "）");
        }
    }

    /** 一条「用户限制」的定义。 */
    private static final class Restriction {
        final String id;
        final String label;
        final String key;
        final int minApi;

        Restriction(String id, String label, String key, int minApi) {
            this.id = id;
            this.label = label;
            this.key = key;
            this.minApi = minApi;
        }
    }

    /**
     * 用户限制清单。刻意把「最影响家长的」排前面，便于排查。
     *
     * <p>取舍（写在这里也写进 README）：{@code DISALLOW_FACTORY_RESET} 同时挡住家长自己
     * 在设置里恢复出厂、{@code DISALLOW_CONFIG_WIFI} 让家长也改不了 Wi-Fi —— 不挡这些，
     * 孩子一次恢复出厂/断网就能把管控全部抹掉。家长需要先在应用里关掉「最强防护」。
     */
    private static final List<Restriction> RESTRICTIONS = Arrays.asList(
            // 禁止 强行停止 / 清除数据 / 卸载 / 停用 任何应用（含本应用）
            new Restriction("no_apps_control", "禁止强行停止/清除数据/停用应用",
                    UserManager.DISALLOW_APPS_CONTROL, 21),
            new Restriction("no_uninstall_apps", "禁止卸载任何应用",
                    UserManager.DISALLOW_UNINSTALL_APPS, 18),
            // 刻意不在这里放 DISALLOW_INSTALL_APPS：它是<b>动态</b>的，归「应用审核」特性
            // 独占管理（家长批准安装后要临时放开 30 分钟，见 syncInstallRestriction）。
            // 放进静态清单会出现「自愈时加上、配置刷新时又清掉」的反复横跳，
            // 而且每次自愈都会短暂放开安装限制 —— 那是真漏洞，不是加固。
            new Restriction("no_factory_reset", "禁止恢复出厂设置",
                    UserManager.DISALLOW_FACTORY_RESET, 21),
            new Restriction("no_safe_boot", "禁止进入安全模式",
                    UserManager.DISALLOW_SAFE_BOOT, 23),
            new Restriction("no_network_reset", "禁止「重置网络设置」",
                    UserManager.DISALLOW_NETWORK_RESET, 23),
            new Restriction("no_add_user", "禁止新建用户/访客/分身",
                    UserManager.DISALLOW_ADD_USER, 21),
            new Restriction("no_remove_user", "禁止删除用户",
                    UserManager.DISALLOW_REMOVE_USER, 18),
            new Restriction("no_user_switch", "禁止切换用户",
                    UserManager.DISALLOW_USER_SWITCH, 28),
            new Restriction("no_unified_password", "禁止设置多用户统一锁屏密码",
                    UserManager.DISALLOW_UNIFIED_PASSWORD, 28),
            new Restriction("no_config_date_time", "禁止修改日期/时间/时区",
                    UserManager.DISALLOW_CONFIG_DATE_TIME, 28),
            // 注意：Android 的 UserManager 里<b>没有</b> DISALLOW_CONFIG_TIMEZONE 这个常量
            // （时区与日期时间共用 no_config_date_time 这一条），所以别照抄任务书里的名字。
            new Restriction("no_config_locale", "禁止修改语言/区域",
                    UserManager.DISALLOW_CONFIG_LOCALE, 28),
            new Restriction("no_config_private_dns", "禁止修改私有 DNS（堵 DoT/DoH 绕过）",
                    UserManager.DISALLOW_CONFIG_PRIVATE_DNS, 29),
            new Restriction("no_config_vpn", "禁止修改/关闭 VPN（保住网址拦截）",
                    UserManager.DISALLOW_CONFIG_VPN, 21),
            new Restriction("no_config_wifi", "禁止修改 Wi-Fi 配置",
                    UserManager.DISALLOW_CONFIG_WIFI, 18),
            new Restriction("no_config_mobile_networks", "禁止修改移动网络设置",
                    UserManager.DISALLOW_CONFIG_MOBILE_NETWORKS, 21),
            new Restriction("no_airplane_mode", "禁止开启飞行模式",
                    UserManager.DISALLOW_AIRPLANE_MODE, 28),
            new Restriction("no_config_credentials", "禁止修改锁屏密码/凭据",
                    UserManager.DISALLOW_CONFIG_CREDENTIALS, 18),
            new Restriction("no_usb_file_transfer", "禁止 USB 文件传输",
                    UserManager.DISALLOW_USB_FILE_TRANSFER, 18),
            new Restriction("no_system_error_dialogs", "禁止系统错误弹框",
                    UserManager.DISALLOW_SYSTEM_ERROR_DIALOGS, 28),
            // 下面这条刻意排除在默认施加之外，见 DEBUGGING_RESTRICTION 注释
            new Restriction("no_debugging_features", "禁止开发者选项与 USB 调试",
                    UserManager.DISALLOW_DEBUGGING_FEATURES, 21)
    );

    private static final String ID_DEBUGGING = "no_debugging_features";

    /**
     * 是否施加「禁止 USB 调试」。
     *
     * <p>这一项会关掉 {@code Settings.Global.ADB_ENABLED}，在模拟器上会直接切断 adb ——
     * 一旦切断，本机的 e2e 断言、故障恢复（{@code dpm remove-active-admin}）全部不可用，
     * 也就无法自证「它到底生效了没有」。所以模拟器上如实跳过并在日志里标注原因，
     * 真机上（{@code ro.kernel.qemu} 不为 1）默认施加。
     */
    private static boolean allowDebuggingRestriction() {
        return !"1".equals(readSystemProperty("ro.kernel.qemu"));
    }

    private static String readSystemProperty(String key) {
        try {
            Class<?> clazz = Class.forName("android.os.SystemProperties");
            Object value = clazz.getMethod("get", String.class).invoke(null, key);
            return value == null ? "" : value.toString();
        } catch (Exception e) {
            return "";
        }
    }

    /** 类注释里的「本机是模拟器」。 */
    public static boolean isEmulator() {
        return "1".equals(readSystemProperty("ro.kernel.qemu"))
                || Build.FINGERPRINT == null
                || Build.FINGERPRINT.contains("generic");
    }

    /** 人话名称（保留旧 API，日志与界面都用它）。 */
    private static String label(String restriction) {
        for (Restriction r : RESTRICTIONS) {
            if (r.key.equals(restriction)) return r.label;
        }
        return restriction;
    }

    // ---------------------------------------------------------------- 施加

    /**
     * 应用加固（幂等：每次调用都把整份清单重新施加一遍）。
     *
     * @return 逐项自检结果；非设备所有者时返回一条说明项（清单为空时不返回空列表，
     *         而是保留「不可用」的事实，避免界面显示成「全部生效」）
     */
    public static List<Item> apply(Context context) {
        List<Item> items = new ArrayList<>();
        if (!LockController.isDeviceOwner(context)) {
            items.add(new Item("device_owner", "设备所有者权限", false, false,
                    "本机未设为本应用为设备所有者，防卸载/防强停全部无法实施，孩子可在系统设置里直接停用或卸载"));
            EventLog.warn(LOG_TAG + "][device_owner] applied=false supported=false label=设备所有者权限 detail=未获得设备所有者权限");
            return items;
        }
        DevicePolicyManager dpm =
                (DevicePolicyManager) context.getSystemService(Context.DEVICE_POLICY_SERVICE);
        if (dpm == null) {
            items.add(new Item("device_policy_service", "设备策略服务", false, false, "无法获取 DevicePolicyManager"));
            return items;
        }
        ComponentName admin = LockController.adminComponent(context);
        String pkg = context.getPackageName();

        // 1) 禁止卸载本应用（最直接的一条）
        try {
            dpm.setUninstallBlocked(admin, pkg, true);
        } catch (SecurityException e) {
            EventLog.warn("禁止卸载失败：" + e.getMessage());
        }

        // 2) 受保护包（API 30+）：让用户在「应用信息」里点不动「强行停止」「清除数据」
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            try {
                List<String> current = dpm.getUserControlDisabledPackages(admin);
                if (current == null || !current.contains(pkg)) {
                    List<String> target = new ArrayList<>();
                    if (current != null) target.addAll(current);
                    target.add(pkg);
                    dpm.setUserControlDisabledPackages(admin, target);
                }
            } catch (SecurityException | IllegalArgumentException e) {
                EventLog.warn("设置受保护包失败：" + e.getMessage());
            }
        }

        // 3) 逐项添加用户限制
        for (Restriction r : RESTRICTIONS) {
            if (r.id.equals(ID_DEBUGGING) && !allowDebuggingRestriction()) continue;
            if (Build.VERSION.SDK_INT < r.minApi) continue;
            try {
                dpm.addUserRestriction(admin, r.key);
            } catch (SecurityException | IllegalArgumentException e) {
                // 部分 ROM 不支持个别限制项，跳过即可
                EventLog.warn("限制项 " + r.label + " 未能生效：" + e.getMessage());
            }
        }

        // 4) 全局设置：关私有 DNS（堵 DoT/DoH）、关「自动停用不常用应用」、关飞行模式
        applyGlobalSetting(context, dpm, "global_private_dns",
                "关闭私有 DNS（阻断加密 DNS 绕过网址拦截）", "private_dns_mode", "off");
        applyGlobalSetting(context, dpm, "global_private_dns_specifier",
                "清空私有 DNS 主机名", "private_dns_specifier", "");
        applyGlobalSetting(context, dpm, "global_app_auto_restriction",
                "关闭「自动停用不常用应用」（防止系统自动收回本应用权限）",
                "app_auto_restriction_enabled", "0", DO_CANNOT_WRITE);
        applyGlobalSetting(context, dpm, "global_airplane_mode",
                "强制关闭飞行模式（离线绕过）", "airplane_mode_on", "0");

        // 5) 只允许本应用 + 已启用的无障碍服务（堵住第三方「冻结/强停」类辅助功能应用）
        applyAccessibilityLockdown(context, dpm);

        return audit(context);
    }

    /**
     * Android 13 实测结论：这几个系统 key 设备所有者<b>写不进去</b>，只能用 shell/root。
     *
     * <p>实证原文（{@code adb logcat -s BalloonDog}）：
     * {@code Permission denial: device owners cannot update app_auto_restriction_enabled}。
     * 既然系统明确拒绝，就不能把它报成「缺口，等我修」—— 那会变成一条永远修不好的
     * 假警报。这里如实标成 {@code supported=false}，并在详情里写清是系统限制。
     */
    private static final Set<String> DO_CANNOT_WRITE =
            new HashSet<>(Arrays.asList("app_auto_restriction_enabled"));

    private static void applyGlobalSetting(Context context, DevicePolicyManager dpm, String id,
                                           String label, String key, String value) {
        applyGlobalSetting(context, dpm, id, label, key, value, null);
    }

    private static void applyGlobalSetting(Context context, DevicePolicyManager dpm, String id,
                                           String label, String key, String value,
                                           Set<String> knownUnsupported) {
        String current;
        try {
            current = Settings.Global.getString(context.getContentResolver(), key);
        } catch (Exception e) {
            current = null;
        }
        String normalized = current == null ? "" : current;
        if (normalized.equals(value)) return;   // 已经是目标值，幂等短路
        try {
            dpm.setGlobalSetting(LockController.adminComponent(context), key, value);
        } catch (SecurityException | IllegalArgumentException e) {
            boolean expected = knownUnsupported != null && knownUnsupported.contains(key);
            EventLog.warn("全局设置「" + label + "」被系统拒绝（"
                    + (expected ? "系统明确不允许设备所有者改这个 key" : "未预期") + "）："
                    + e.getMessage());
        }
    }

    /**
     * 把「允许运行的无障碍服务」收紧到 本应用 + 当前已启用的服务。
     *
     * <p>为什么保留「当前已启用」而不是只留自己：TalkBack 这类已启用的无障碍服务属于
     * 无障碍刚需，强行关掉会让设备对视力障碍用户不可用；而孩子临时装一个第三方
     * 「一键冻结/强停」类无障碍服务会立刻被系统拒绝 —— 那才是我们要堵的绕过面。
     */
    private static void applyAccessibilityLockdown(Context context, DevicePolicyManager dpm) {
        List<String> allow = new ArrayList<>();
        allow.add(context.getPackageName());
        try {
            String enabled = Settings.Secure.getString(context.getContentResolver(),
                    Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES);
            if (!TextUtils.isEmpty(enabled)) {
                for (String flattened : enabled.split(":")) {
                    int slash = flattened.indexOf('/');
                    if (slash <= 0) continue;
                    String pkg = flattened.substring(0, slash);
                    if (!allow.contains(pkg)) allow.add(pkg);
                }
            }
        } catch (Exception e) {
            EventLog.warn("读取已启用的无障碍服务失败：" + e.getMessage());
        }
        try {
            List<String> current = dpm.getPermittedAccessibilityServices(
                    LockController.adminComponent(context));
            if (current != null && current.containsAll(allow) && allow.containsAll(current)) return;
            dpm.setPermittedAccessibilityServices(LockController.adminComponent(context), allow);
        } catch (SecurityException | IllegalArgumentException e) {
            EventLog.warn("收紧可用的无障碍服务失败：" + e.getMessage());
        }
    }

    /** 解除加固。家长在应用内关闭「最强防护」时调用。 */
    public static void release(Context context) {
        if (!LockController.isDeviceOwner(context)) return;
        DevicePolicyManager dpm =
                (DevicePolicyManager) context.getSystemService(Context.DEVICE_POLICY_SERVICE);
        if (dpm == null) return;
        ComponentName admin = LockController.adminComponent(context);

        try {
            dpm.setUninstallBlocked(admin, context.getPackageName(), false);
        } catch (SecurityException e) {
            EventLog.warn("解除禁止卸载失败：" + e.getMessage());
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            try {
                List<String> current = dpm.getUserControlDisabledPackages(admin);
                if (current != null && current.contains(context.getPackageName())) {
                    List<String> target = new ArrayList<>(current);
                    target.remove(context.getPackageName());
                    dpm.setUserControlDisabledPackages(admin, target);
                }
            } catch (SecurityException | IllegalArgumentException e) {
                EventLog.warn("解除受保护包失败：" + e.getMessage());
            }
        }
        for (Restriction r : RESTRICTIONS) {
            try {
                dpm.clearUserRestriction(admin, r.key);
            } catch (SecurityException | IllegalArgumentException ignored) {
                // 未生效过的限制项清除时也会抛，忽略
            }
        }
        try {
            dpm.setPermittedAccessibilityServices(admin, null);
        } catch (SecurityException | IllegalArgumentException ignored) {
            // 同上
        }
        EventLog.warn("最强防护已解除");
    }

    // ---------------------------------------------------------------- 自检

    /**
     * 只读自检：读回设备真实状态，逐项给出「是否生效」。
     *
     * <p>注意这是<b>读</b>，不做任何写入，可以随时调用来回答「现在到底加没加固上」。
     */
    public static List<Item> audit(Context context) {
        List<Item> items = new ArrayList<>();
        if (!LockController.isDeviceOwner(context)) {
            items.add(new Item("device_owner", "设备所有者权限", false, false,
                    "不是设备所有者：孩子可以在系统设置里「强行停止」或卸载本应用"));
            return items;
        }
        DevicePolicyManager dpm =
                (DevicePolicyManager) context.getSystemService(Context.DEVICE_POLICY_SERVICE);
        if (dpm == null) {
            items.add(new Item("device_policy_service", "设备策略服务", false, false, "无法获取 DevicePolicyManager"));
            return items;
        }
        ComponentName admin = LockController.adminComponent(context);
        String pkg = context.getPackageName();

        items.add(new Item("device_owner", "设备所有者权限", true, true, "本机已将本应用设为设备所有者"));

        // 禁止卸载
        boolean uninstallBlocked = false;
        try {
            uninstallBlocked = dpm.isUninstallBlocked(admin, pkg);
        } catch (Exception ignored) {
        }
        items.add(new Item("uninstall_blocked", "禁止卸载本应用", uninstallBlocked, true, ""));

        // 受保护包
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            boolean protectedPkg = false;
            try {
                List<String> current = dpm.getUserControlDisabledPackages(admin);
                protectedPkg = current != null && current.contains(pkg);
            } catch (Exception ignored) {
            }
            items.add(new Item("protected_package", "受保护包（设置里点不动强行停止/清除数据）",
                    protectedPkg, true, protectedPkg ? "" : "尚未写入 getUserControlDisabledPackages"));
        } else {
            items.add(new Item("protected_package", "受保护包（设置里点不动强行停止/清除数据）",
                    false, false,
                    "需 Android 11(API 30) 起；本机 " + Build.VERSION.SDK_INT
                            + "，降级后少了「应用信息页强行停止/清除数据按钮变灰」，只能靠 DISALLOW_APPS_CONTROL 兜"));
        }

        // 用户限制逐项
        Bundle restrictions = null;
        try {
            restrictions = dpm.getUserRestrictions(admin);
        } catch (Exception ignored) {
        }
        for (Restriction r : RESTRICTIONS) {
            boolean supported = Build.VERSION.SDK_INT >= r.minApi
                    && !(r.id.equals(ID_DEBUGGING) && !allowDebuggingRestriction());
            boolean active = restrictions != null && restrictions.getBoolean(r.key, false);
            String detail = "";
            if (!supported) {
                detail = r.id.equals(ID_DEBUGGING)
                        ? "模拟器上会切断 adb，无法自证与恢复，故如实跳过；真机上默认施加"
                        : "需 Android " + apiName(r.minApi) + " 起，本机为 " + Build.VERSION.SDK_INT;
            }
            items.add(new Item(r.id, r.label, active, supported, detail));
        }

        // 全局设置逐项
        items.add(globalSettingItem(context, "global_private_dns",
                "关闭私有 DNS（阻断加密 DNS 绕过网址拦截）", "private_dns_mode", "off"));
        items.add(globalSettingItem(context, "global_private_dns_specifier",
                "清空私有 DNS 主机名", "private_dns_specifier", ""));
        items.add(globalSettingItem(context, "global_app_auto_restriction",
                "关闭「自动停用不常用应用」", "app_auto_restriction_enabled", "0", true));
        items.add(globalSettingItem(context, "global_airplane_mode",
                "强制关闭飞行模式（离线绕过）", "airplane_mode_on", "0"));

        // 无障碍收紧
        boolean locked = false;
        String detail = "未收紧：任何第三方无障碍服务都能开（可用来冻结/强停本应用）";
        try {
            List<String> permitted = dpm.getPermittedAccessibilityServices(admin);
            if (permitted != null) {
                locked = permitted.contains(pkg);
                detail = locked ? "只允许本应用与已启用的无障碍服务" : "列表里没有本应用";
            }
        } catch (Exception ignored) {
        }
        items.add(new Item("accessibility_lockdown", "收紧可用的无障碍服务", locked, true, detail));

        return items;
    }

    private static Item globalSettingItem(Context context, String id, String label,
                                          String key, String expected) {
        return globalSettingItem(context, id, label, key, expected, false);
    }

    private static Item globalSettingItem(Context context, String id, String label,
                                          String key, String expected, boolean doForbidden) {
        String current;
        try {
            current = Settings.Global.getString(context.getContentResolver(), key);
        } catch (Exception e) {
            current = null;
        }
        String normalized = current == null ? "" : current;
        boolean applied = normalized.equals(expected);
        if (doForbidden) {
            // 系统明确拒绝设备所有者写这个 key：如实标成「本机不支持」而不是「缺口」，
            // 否则会变成一条永远修不好的假警报（原文见 DO_CANNOT_WRITE 的注释）。
            return new Item(id, label, applied, false,
                    "Android 13 实测：device owners cannot update " + key
                            + "（当前值 " + (normalized.isEmpty() ? "(空)" : normalized) + "）");
        }
        return new Item(id, label, applied, true,
                applied ? ("当前值 " + (normalized.isEmpty() ? "(空)" : normalized))
                        : ("当前值 " + (normalized.isEmpty() ? "(空)" : normalized) + "，期望 " + expected));
    }

    /** 逐项回报当前生效状态（界面直接展示，避免「以为开了其实没开」）。 */
    public static List<String> status(Context context) {
        List<String> lines = new ArrayList<>();
        if (!LockController.isDeviceOwner(context)) {
            lines.add("未获得设备所有者权限：孩子可以在系统设置里「强行停止」或卸载本应用");
            return lines;
        }
        for (Item item : audit(context)) {
            lines.add(item.render());
        }
        return lines;
    }

    /** 「X/Y 项生效」的短句，用于日志与界面标题。 */
    public static String summary(List<Item> items) {
        int total = 0;
        int applied = 0;
        int unsupported = 0;
        for (Item item : items) {
            total++;
            if (item.applied) applied++;
            if (!item.supported) unsupported++;
        }
        // 「本机不支持」必须与「该生效却没生效」分开报：前者是系统限制（如实标注、无需修复），
        // 后者才是真缺口。混在一起报会让家长和测试都分不清该不该管。
        return applied + "/" + total + " 项生效"
                + (unsupported > 0 ? ("（" + unsupported + " 项本机不支持）") : "");
    }

    /**
     * 把逐项结果写进日志环（也进 logcat）。
     *
     * <p>每项一行、前缀固定，设备级断言可以按前缀 + id 精确取到某一条。
     */
    public static void logReport(List<Item> items, String reason) {
        // 周期自愈每 5 分钟就会调一次：那时只打「没生效的项」+ 汇总行，
        // 否则每次 27~28 行会把 EventLog 的 200 行内存环刷掉、把有用的历史挤走。
        // 服务启动/开机/家长手动自检仍然逐项全打 —— e2e 的断言就是抓那批行。
        boolean full = reason == null || !reason.contains("周期巡检");
        for (Item item : items) {
            if (!full && item.applied) continue;
            String line = LOG_TAG + "[" + item.id + "] applied=" + item.applied
                    + " supported=" + item.supported
                    + " label=" + item.label
                    + " detail=" + (item.detail.isEmpty() ? "-" : item.detail);
            if (item.applied) {
                EventLog.info(line);
            } else {
                EventLog.warn(line);
            }
        }
        EventLog.success(LOG_TAG + "自检（" + reason + "）：" + summary(items)
                + (isEmulator() ? "，模拟器" : "，真机"));
    }

    /** 是否有任何一项加固生效（用于界面上的总开关状态）。 */
    public static boolean isActive(Context context) {
        if (!LockController.isDeviceOwner(context)) return false;
        DevicePolicyManager dpm =
                (DevicePolicyManager) context.getSystemService(Context.DEVICE_POLICY_SERVICE);
        if (dpm == null) return false;
        try {
            if (dpm.isUninstallBlocked(LockController.adminComponent(context), context.getPackageName())) {
                return true;
            }
            return dpm.getUserRestrictions(LockController.adminComponent(context))
                    .getBoolean(UserManager.DISALLOW_APPS_CONTROL, false);
        } catch (Exception e) {
            return false;
        }
    }

    /** 是否支持运行时的用户限制 API（API 21+ 一直有，这里留个位置便于将来扩展）。 */
    public static boolean isSupported() {
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP;
    }

    /**
     * 本应用是否已被标成「受保护包」——即孩子无法在「应用信息」页点强行停止 / 清除数据。
     *
     * <p>这是长活链路上最关键的一条，而且只有 Android 11(API 30) 起才有。
     */
    public static boolean hasProtectedPackage(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return false;
        if (!LockController.isDeviceOwner(context)) return false;
        DevicePolicyManager dpm =
                (DevicePolicyManager) context.getSystemService(Context.DEVICE_POLICY_SERVICE);
        if (dpm == null) return false;
        try {
            List<String> current =
                    dpm.getUserControlDisabledPackages(LockController.adminComponent(context));
            return current != null && current.contains(context.getPackageName());
        } catch (Exception e) {
            return false;
        }
    }

    private static String apiName(int api) {
        switch (api) {
            case 18: return "4.3";
            case 21: return "5.0";
            case 23: return "6.0";
            case 28: return "9";
            case 29: return "10";
            case 30: return "11";
            default: return "API " + api;
        }
    }

    // ---------------- 应用审核：安装限制随批准窗口开合（契约 §3） ----------------

    /** 上一次同步给日志用的状态，避免配置每 60 秒刷新一次就刷一条重复日志。 */
    private static volatile Boolean lastInstallRestricted = null;

    /**
     * 按「应用审核」特性同步「禁止安装应用」限制。
     *
     * <p>为什么要单开一个方法而不是塞进 {@link #RESTRICTIONS}：这一项是<b>动态</b>的 ——
     * 家长批准安装后服务端会把 {@code installApprovalUntil} 往后推 30 分钟，
     * 这期间必须放开；窗口一过又要自动收紧。塞进静态清单就没法开合。
     *
     * <p>{@code DISALLOW_INSTALL_APPS} 同样只有设备所有者能设置：非设备所有者时
     * 这里只如实记一条日志（一次状态变化记一次），不假装已生效。
     *
     * @param auditEnabled 家长是否开启应用审核（appAudit 特性）
     * @param windowOpen   是否处于家长刚批准后的放行窗口
     * @return true 表示当前确实处于「禁止安装」状态
     */
    public static boolean syncInstallRestriction(Context context, boolean auditEnabled, boolean windowOpen) {
        boolean shouldBlock = auditEnabled && !windowOpen;
        if (!LockController.isDeviceOwner(context)) {
            if (lastInstallRestricted == null || lastInstallRestricted != shouldBlock) {
                lastInstallRestricted = shouldBlock;
                EventLog.warn(auditEnabled
                        ? "应用审核已开启，但本机不是设备所有者，无法阻止安装（孩子仍可自行安装应用）"
                        : "应用审核未开启：不限制安装");
            }
            return false;
        }
        DevicePolicyManager dpm =
                (DevicePolicyManager) context.getSystemService(Context.DEVICE_POLICY_SERVICE);
        if (dpm == null) return false;

        boolean currently;
        try {
            currently = dpm.getUserRestrictions(LockController.adminComponent(context))
                    .getBoolean(UserManager.DISALLOW_INSTALL_APPS, false);
        } catch (Exception e) {
            currently = false;
        }

        try {
            if (shouldBlock) {
                dpm.addUserRestriction(LockController.adminComponent(context),
                        UserManager.DISALLOW_INSTALL_APPS);
            } else {
                dpm.clearUserRestriction(LockController.adminComponent(context),
                        UserManager.DISALLOW_INSTALL_APPS);
            }
        } catch (Exception e) {
            EventLog.warn("同步「禁止安装应用」失败：" + e.getMessage());
            return currently;
        }

        if (currently != shouldBlock || lastInstallRestricted == null
                || lastInstallRestricted != shouldBlock) {
            lastInstallRestricted = shouldBlock;
            if (shouldBlock) {
                EventLog.info("应用审核：已禁止安装新应用（家长批准后会临时放开 30 分钟）");
            } else if (windowOpen) {
                EventLog.success("家长已批准安装：临时放开安装限制");
            } else {
                EventLog.info("应用审核：已解除安装限制");
            }
        }
        return shouldBlock;
    }

    /** 供测试与界面只读使用：清单里的固定项数量。 */
    public static int itemCount(Context context) {
        return audit(context).size();
    }
}
