package com.balloondog.agent.capability;

import android.content.Context;
import android.content.SharedPreferences;

import com.balloondog.agent.data.EventLog;

import java.util.Arrays;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;

/**
 * 「敏感界面封锁」：孩子一进系统设置 / 应用管理 / 卸载界面就退回桌面。
 *
 * <p><b>为什么只能用这种办法。</b>Android <b>没有</b>「禁止打开系统设置」的设备所有者限制 ——
 * 逐条核对过 {@code android-33/android.jar} 的 {@code UserManager}，只有
 * DISALLOW_CONFIG_WIFI / _VPN / _DATE_TIME 这类单项常量，没有任何整体开关。
 * 设备所有者能做且已经做了的只有两件相关的事（见 {@link OwnerHardening}）：
 * <ul>
 *   <li>{@code DISALLOW_APPS_CONTROL} —— 把「设置 → 应用」里的卸载/强行停止按钮置灰；</li>
 *   <li>{@code DISALLOW_UNINSTALL_APPS} + {@code setUninstallBlocked} —— 让卸载动作本身失败。</li>
 * </ul>
 * 它们保证「卸不掉」，但挡不住孩子<b>进去看、去点</b>。要做到「一进去就弹回桌面」，
 * 只剩无障碍服务盯前台窗口这一条路 —— 也就是这个类配合
 * {@code LockWatchdogService#onAccessibilityEvent}。
 *
 * <p><b>它是追赶，不是墙。</b>目标页面会先出现一小会儿再被推走。真正保证「卸不掉」的
 * 仍然是上面那两条设备所有者限制，不要把这个类当成卸载防护的唯一依靠。
 *
 * <p><b>没有设备所有者时，还有一道闸：激活设备管理器。</b>三档对照是实测出来的
 * （Android 13，同一份 APK）：两者都没有 → 卸载成功；只激活设备管理器 →
 * {@code UninstallFinish: … DELETE_FAILED_DEVICE_POLICY_MANAGER}；设备所有者 →
 * {@code DELETE_FAILED_USER_RESTRICTED} + {@code no_uninstall_apps}。
 * 但「激活设备管理器」本身就只是一个可以关掉的开关（设置 → 安全 → 设备管理应用），
 * 所以那一页也纳入了本类的封锁范围，见 {@link #ADMIN_PAGE_WORDS}。
 *
 * <p><b>放行窗口是必需的，不是可选项。</b>本应用自己就要用系统设置页来完成授权
 * （无障碍开关、忽略电池优化、悬浮窗、使用情况访问、应用详情）。没有放行窗口的话，
 * 「一键开启权限」会把自己刚拉起来的页面立刻推走，家长看到的是「按钮点了没反应」。
 *
 * <p>放行窗口的两条约束，用来把它限制在「引导流程」里：
 * <ol>
 *   <li>窗口有时长（{@link #ALLOW_WINDOW_MS}），且只在应用内明确点击「去开启」时打开；</li>
 *   <li>进入系统页面的那一刻，<b>上一个前台应用必须还是本应用</b> ——
 *       孩子从桌面/最近任务自己点进设置不算，见
 *       {@code LockWatchdogService#updateSensitiveExcursion}。</li>
 * </ol>
 */
public final class SensitiveScreens {

    private SensitiveScreens() {
    }

    private static final String PREFS = "balloon_sensitive_screens";
    private static final String KEY_ALLOW_UNTIL = "allow_until";
    private static final String KEY_ALLOW_HINT = "allow_hint";

    /** 从应用内点开系统页面后的放行时长。够家长点完一项；越短越安全。 */
    public static final long ALLOW_WINDOW_MS = 45_000L;

    /** 家长从应用内点「开启无障碍」跳过去的：只有这一种放行允许打开无障碍设置页。 */
    public static final String HINT_ACCESSIBILITY = "accessibility";

    /** 其余授权引导（悬浮窗 / 使用情况访问 / 电池白名单 / 应用详情）。 */
    public static final String HINT_GENERIC = "generic";

    private static final String SETTINGS_PACKAGE = "com.android.settings";

    /**
     * 整包封锁的「卸载器 / 各 ROM 安全中心」。
     *
     * <p>这些包本身就只干一件事（卸载确认、应用管理、清理加速），整包封掉不会误伤
     * 本应用自己的授权引导 —— 所以它们不需要再判页面内容。
     *
     * <p>各 ROM 的「安全中心 / 应用管理」一并列入：小米、华为、OPPO、vivo、三星、一加这些
     * 包里装着各自的卸载与应用管理界面，只封 AOSP 的 packageinstaller 会漏。
     * 列表里不存在的包名不会命中，留着不影响别的机型。
     */
    private static final Set<String> BLOCKED_PACKAGES = new HashSet<>(Arrays.asList(
            "com.android.packageinstaller",
            "com.google.android.packageinstaller",
            "com.miui.packageinstaller",
            "com.samsung.android.packageinstaller",
            "com.miui.securitycenter",
            "com.huawei.systemmanager",
            "com.coloros.safecenter",
            "com.oplus.safecenter",
            "com.oppo.safe",
            "com.vivo.permissionmanager",
            "com.iqoo.secure",
            "com.samsung.android.lool",
            "com.oneplus.security"
    ));

    /**
     * 系统设置包（含设置搜索）。它们<b>不再整包封</b>，只封「应用信息」页。
     *
     * <p>这一条是用户实测反馈逼出来的收窄：系统设置整包封会连带把本应用自己的授权页
     * （无障碍开关、忽略电池优化、悬浮窗、使用情况访问、应用详情）一起推走 ——
     * 那些页面全都长在设置包里，家长点「去开启」还没点完就被弹回桌面。
     * 现在只有「应用信息页」被封，那里才是卸载/强行停止按钮所在的地方。
     */
    private static final Set<String> SETTINGS_PACKAGES = new HashSet<>(Arrays.asList(
            SETTINGS_PACKAGE,
            "com.android.settings.intelligence",
            "com.google.android.settings.intelligence"
    ));

    /**
     * 「应用信息页」的标题词。
     *
     * <p><b>为什么必须靠页面文字而不是类名。</b>实测（Android 13 模拟器）在系统设置里翻页时，
     * {@code TYPE_WINDOW_STATE_CHANGED} 的 {@code getClassName()} 经常是
     * {@code android.widget.FrameLayout} / {@code android.widget.Button} 这类根视图类，
     * <b>不是</b>承载页面的 Activity 名 —— 只按类名根本分不出「设置首页」和「应用信息页」。
     * 页面文字是可靠的：应用信息页一定有这个标题。
     */
    private static final String[] APP_INFO_TITLES = {
            "应用信息", "应用详情", "App info", "App details"
    };

    /** 应用信息页上的「强行停止」按钮，与下面的「卸载」一起出现时也足以判定。 */
    private static final String[] FORCE_STOP_WORDS = {
            "强行停止", "强制停止", "Force stop", "FORCE STOP"
    };

    /** 卸载按钮文案。 */
    private static final String[] UNINSTALL_WORDS = {"卸载", "Uninstall", "UNINSTALL"};

    /**
     * 「设备管理应用」列表页（以及已激活管理员的详情页）的标题词。
     *
     * <p><b>为什么必须封这一页。</b>非设备所有者的设备上，「激活设备管理器」是唯一能挡住
     * 「长按图标 → 卸载」的东西（实测：未激活时卸载会成功，激活后系统直接回
     * {@code DELETE_FAILED_DEVICE_POLICY_MANAGER}）。但它只是<b>一道闸</b>：孩子走到
     * 「设置 → 安全 → 设备管理应用」把它关掉，卸载就又可行了。这一页就是那个开关所在的地方。
     *
     * <p>文案取自设备上的 Settings APK（{@code aapt2 dump resources} 的 zh-rCN/default）：
     * 列表页标题 = {@code manage_device_admin} =「设备管理应用」/ "Device admin apps"；
     * 已激活详情页的标题 = {@code active_device_admin_msg} =「设备管理应用」/"Device admin app"
     * —— 中文里这两句同源，所以中文靠下面的「停用」按钮词区分不出来，只能一起封。
     */
    private static final String[] ADMIN_PAGE_WORDS = {
            "设备管理应用", "设备管理器", "Device admin apps", "Device administrators"
    };

    /** 停用按钮：孩子点的就是它（{@code remove_device_admin} / {@code remove_and_uninstall_device_admin}）。 */
    private static final String[] ADMIN_DEACTIVATE_WORDS = {
            "停用此设备管理应用", "停用并卸载",
            "Deactivate this device admin app", "Deactivate & uninstall"
    };

    /**
     * 「启用」设备管理器那一页的文案：<b>必须放行</b>。
     *
     * <p>家长从本应用点「去开启设备管理器」打开的正是这一页（
     * {@code LockController.requestAdmin} → {@code ACTION_ADD_DEVICE_ADMIN}）。
     * 中文的提示语是「要启用此设备管理应用吗？」—— 它<b>包含</b>「设备管理应用」，
     * 如果只按上面的标题词判，这一页会被自己的看门狗推走，等于把这个权限彻底关死
     * （放行窗口虽然能兜住，但不该让唯一的开通路径依赖一张 45 秒的通行证）。
     */
    private static final String[] ADMIN_ACTIVATE_WORDS = {
            "要启用此设备管理应用吗", "启用此设备管理应用", "启用此管理应用",
            "Activate this device admin app", "Activate device admin app", "Activate this admin app"
    };

    private static boolean containsAny(String haystack, String[] needles) {
        if (haystack == null || haystack.isEmpty()) return false;
        for (String needle : needles) {
            if (haystack.contains(needle)) return true;
        }
        return false;
    }


    /**
     * <b>只按类名封、不封整包</b>的包。
     *
     * <p>典型是 {@code com.android.permissioncontroller}：它既承载运行时权限对话框，
     * 又在部分 ROM 上承载卸载确认界面。封整包会让本应用自己的权限申请也被推走
     * （家长点「允许」的框一闪就没），所以只能按类名里有没有 uninstall 精确判断。
     *
     * <p>实测本机（Android 13）的卸载界面落在
     * {@code com.google.android.packageinstaller/com.android.packageinstaller.UninstallerActivity}，
     * permissioncontroller 这里只有一个「包已卸载」的广播接收器。
     */
    private static final Set<String> CLASS_ONLY_PACKAGES = new HashSet<>(Arrays.asList(
            "com.android.permissioncontroller",
            "com.google.android.permissioncontroller"
    ));

    /**
     * 这个前台窗口是不是敏感界面。
     *
     * @param pkg        前台包名
     * @param className  {@code TYPE_WINDOW_STATE_CHANGED} 的类名 —— 实测经常是根视图类，不可靠
     * @param windowText 前台窗口里的全部文字（{@code LockWatchdogService.collectWindowText} 采集）。
     *                   判定「应用信息页」必须靠它，理由见 {@link #APP_INFO_TITLES}
     * @return 给人看的中文类别（用于日志和上报），不是敏感界面时返回 null
     */
    public static String match(String pkg, CharSequence className, String windowText) {
        if (pkg == null || pkg.isEmpty()) return null;
        String cls = className == null ? "" : className.toString();
        String lower = cls.toLowerCase(Locale.ROOT);

        if (CLASS_ONLY_PACKAGES.contains(pkg)) {
            return lower.contains("uninstall") ? "应用卸载" : null;
        }

        // 系统设置包：<b>只封「应用信息 / 卸载」页，不再整包封</b>。
        //
        // 收窄是用户实测逼出来的：本应用自己的授权引导页（无障碍开关、忽略电池优化、
        // 悬浮窗、使用情况访问、应用详情）全部长在设置包里，整包封会把这些页面连同家长
        // 正在点的操作一起推走。而孩子想卸载守护软件，唯一必须进的就是「应用信息」页 ——
        // 那里才有卸载与强行停止按钮。
        if (SETTINGS_PACKAGES.contains(pkg)) {
            // 「启用设备管理器」页先放行：它是家长开通这条防线的唯一入口，
            // 中英文案里都含「设备管理应用 / Device admin app」，只能靠动词把它摘出来。
            if (containsAny(windowText, ADMIN_ACTIVATE_WORDS)) return null;
            if (lower.contains("uninstall")) return "应用卸载";
            if (containsAny(windowText, ADMIN_DEACTIVATE_WORDS)) return "停用设备管理器";
            if (containsAny(windowText, ADMIN_PAGE_WORDS)) return "设备管理应用";
            boolean appInfo = lower.contains("appinfo") || lower.contains("installedapp")
                    || containsAny(windowText, APP_INFO_TITLES)
                    || (containsAny(windowText, FORCE_STOP_WORDS)
                            && containsAny(windowText, UNINSTALL_WORDS));
            return appInfo ? "应用信息" : null;
        }

        if (!BLOCKED_PACKAGES.contains(pkg)) return null;

        if (pkg.contains("packageinstaller") || lower.contains("uninstall")) return "应用卸载";
        // 各 ROM 的「安全中心 / 应用管理」本身就是卸载与清理入口，整包封
        return "应用管理";
    }

    /** 打开一个放行窗口：应用内即将跳去系统页面。 */
    public static void allowTemporarily(Context context, String hint) {
        long until = TrustedClock.now() + ALLOW_WINDOW_MS;
        prefs(context).edit()
                .putLong(KEY_ALLOW_UNTIL, until)
                .putString(KEY_ALLOW_HINT, hint)
                .apply();
        EventLog.info("敏感界面封锁：从应用内打开系统页面，放行 "
                + (ALLOW_WINDOW_MS / 1000) + " 秒（" + hint + "）");
    }

    /** 家长还在系统页面里操作时续期，避免读到一半被推走。 */
    public static void renew(Context context) {
        prefs(context).edit()
                .putLong(KEY_ALLOW_UNTIL, TrustedClock.now() + ALLOW_WINDOW_MS)
                .apply();
    }

    public static long allowUntil(Context context) {
        return prefs(context).getLong(KEY_ALLOW_UNTIL, 0L);
    }

    /** 当前放行窗口是哪种引导。窗口过期后返回空串。 */
    public static String allowHint(Context context) {
        SharedPreferences p = prefs(context);
        if (TrustedClock.now() >= p.getLong(KEY_ALLOW_UNTIL, 0L)) return "";
        return p.getString(KEY_ALLOW_HINT, "");
    }

    public static void clear(Context context) {
        prefs(context).edit().remove(KEY_ALLOW_UNTIL).remove(KEY_ALLOW_HINT).apply();
    }

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }
}
