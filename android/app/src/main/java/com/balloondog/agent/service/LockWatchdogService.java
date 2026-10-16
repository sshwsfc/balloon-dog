package com.balloondog.agent.service;

import android.accessibilityservice.AccessibilityService;
import android.accessibilityservice.AccessibilityServiceInfo;
import android.content.ComponentName;
import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;
import android.view.accessibility.AccessibilityWindowInfo;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;

import com.balloondog.agent.capability.AccessibilityScreenCapture;
import com.balloondog.agent.capability.LockEnforcer;
import com.balloondog.agent.capability.SensitiveScreens;
import com.balloondog.agent.capability.StudyHomeController;
import com.balloondog.agent.capability.StudyLauncher;
import com.balloondog.agent.capability.StudyModeEngine;
import com.balloondog.agent.capability.LockState;
import com.balloondog.agent.data.AgentStore;
import com.balloondog.agent.data.Constants;
import com.balloondog.agent.data.EventLog;
import com.balloondog.agent.ui.LockOverlayWindow;
import com.balloondog.agent.ui.StudyHomeActivity;
import com.balloondog.agent.capability.TrustedClock;

import java.util.Arrays;
import java.util.HashMap;
import java.util.List;
import java.util.HashSet;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/**
 * 无障碍看门狗 —— 没有设备所有者时，把「锁不住的那几百毫秒」压下去。
 *
 * <h3>它补的是哪个洞</h3>
 * 无设备所有者时，锁定界面是一个全屏悬浮窗。它挡得住 Home 与最近任务，
 * 但有三条路能逃出去：
 * <ol>
 *   <li><b>下拉通知栏</b> —— 通知栏是 SystemUI 绘制的系统窗口，层级高于任何应用悬浮窗；</li>
 *   <li><b>进设置撤销「显示在其他应用上层」权限</b> —— 悬浮窗会连同权限一起消失；</li>
 *   <li><b>进设置关掉本服务本身</b> —— 所以它必须顺手把设置界面也挡住。</li>
 * </ol>
 * 本服务的做法是「打地鼠」：监听前台窗口变化，一旦发现锁定界面被抢走，
 * 立刻把锁定界面重新挂上；如果是通知栏就收回去，是设置类界面就补一次返回。
 *
 * <h3>它仍然不是「不可绕过」</h3>
 * 它依赖无障碍权限，而<b>无障碍服务本身可以在系统设置里被关掉</b>。
 * 本服务通过拦截设置界面把这条路也堵上，但拦截有 ~100-300ms 延迟，
 * 手足够快的人仍可能抢在前面关掉它。要真正没有绕法，只有设备所有者 + Lock Task。
 * 这一点在 README 与界面上都如实写明，不做「已经锁死」的假象。
 *
 * <h3>刻意保留的例外</h3>
 * <b>紧急呼叫与来电永远放行。</b> 这是产品底线：无论家长怎么设置，
 * 孩子必须能打紧急电话、必须能接到电话。看门狗绝不拦截这些窗口。
 */
public class LockWatchdogService extends AccessibilityService {

    /**
     * 锁定时仍然放行的包。
     *
     * <p>这是<b>安全底线</b>而不是功能取舍：一个能把孩子与紧急呼叫隔开的管控工具是不可接受的。
     * 所以这里列出的是「必须放行」，而不是「可以放行」。
     */
    private static final Set<String> ALLOWED_WHILE_LOCKED = new HashSet<>(Arrays.asList(
            // 紧急呼叫界面
            "com.android.emergency",
            "com.android.emergencyinfo",
            // 来电 / 通话中界面（不同 ROM 包名不同，多列几个）
            "com.android.incallui",
            "com.android.server.telecom",
            "com.android.phone",
            "com.android.dialer",
            // 系统权限弹窗本身需要能被处理，否则会卡死整个流程
            "android"
    ));

    /**
     * 「设置类」包名：命中就补一次返回，把它们推走。
     *
     * <p>包含权限控制器与应用安装器 —— 撤销悬浮窗权限、卸载应用都在这两个界面里。
     */
    private static final Set<String> SETTINGS_LIKE = new HashSet<>(Arrays.asList(
            "com.android.settings",
            "com.android.permissioncontroller",
            "com.google.android.permissioncontroller",
            "com.android.packageinstaller",
            "com.google.android.packageinstaller"
    ));

    /** 两次强制之间的最小间隔，避免在事件风暴里疯狂 addView / startActivity。 */
    private static final long ENFORCE_INTERVAL_MS = 400L;

    /**
     * 应用安装器（契约 §3）。
     *
     * <p>不同 ROM 的包名不同，这两个覆盖了 AOSP 与 GMS 两条线。
     * 注意它们同时也在 {@link #SETTINGS_LIKE} 里（锁定时要把安装界面推走），
     * 两处用途不同：这里是「孩子要装东西了，通知家长」，
     * 那里是「锁定期间不允许改系统设置」。
     */
    private static final Set<String> INSTALLER_PACKAGES = new HashSet<>(Arrays.asList(
            "com.android.packageinstaller",
            "com.google.android.packageinstaller"
    ));

    /** 同一个应用 10 分钟内只向家长申请一次，避免点来点去刷屏（契约 §3）。 */
    private static final long INSTALL_AUDIT_DEDUP_MS = 10 * 60_000L;

    /** 系统「设置」包名。无障碍设置页拦截只认它（见 {@link #isAccessibilitySettingsPage}）。 */
    private static final String SETTINGS_PACKAGE = "com.android.settings";

    /** 无障碍设置页拦截的日志/事件节流：孩子反复点那一项时不要刷屏。 */
    private static final long A11Y_SETTINGS_BLOCK_INTERVAL_MS = 1_500L;

    /** 已上报过的「安装申请」标识 → 上报时刻（仅进程内，见 {@link #maybeReportInstallAttempt}）。 */
    private final Map<String, Long> installAuditReportedAt = new HashMap<>();

    /** 上报在后台线程做，结果要回到主线程才能弹 Toast / 发通知。 */
    private final Handler mainHandler = new Handler(Looper.getMainLooper());

    /** 无障碍设置页拦截：上次记录事件的时刻（节流）。 */
    private long lastA11ySettingsBlockAt;
    /** 加固关着时「放行无障碍设置页」只记一次日志的时刻。 */
    private long lastA11ySettingsAllowedAt;
    /** 家长从应用内点「开启无障碍」放行这一页时的日志节流。 */
    private long lastA11yGuideAllowedAt;
    /** 上次被拦的无障碍设置页类名 + 时刻，用来判断「按了返回它还在不在」。 */
    private String lastA11yBlockedClass = "";
    private long lastA11yBlockedAt;
    private int a11yBlockFailStreak;
    private boolean a11yBlockFailReported;

    /** 敏感界面封锁：上次执行「退回桌面」的时刻（内容变化事件很密，动作要节流）。 */
    private long lastSensitiveBlockAt;
    /** 敏感界面封锁：上次写日志的时刻。 */
    private long lastSensitiveLogAt;
    /** 敏感界面封锁：上次向家长上报事件的时刻（比日志更稀，孩子反复点也不刷屏）。 */
    private long lastSensitiveReportAt;
    /** 敏感界面封锁：上次给放行窗口续期的时刻（SharedPreferences 写入要节流）。 */
    private long lastSensitiveRenewAt;
    /** 敏感界面封锁：本次「从应用内跳进系统页面」的行程是否已经开始。 */
    private boolean sensitiveExcursion;
    /** 敏感界面封锁：加固关着时「放行系统设置页」只记一次日志的时刻。 */
    private long lastSensitivePassLogAt;
    /** 上一次的前台包名：判断这次进系统页面是不是「刚从本应用跳过去」。 */
    private String lastForegroundPackage;

    /** 敏感界面封锁的动作节流。 */
    private static final long SENSITIVE_BLOCK_INTERVAL_MS = 800L;
    /** 敏感界面封锁的日志节流。 */
    private static final long SENSITIVE_LOG_INTERVAL_MS = 2_000L;
    /** 敏感界面封锁向家长上报的节流。 */
    private static final long SENSITIVE_REPORT_INTERVAL_MS = 60_000L;
    /** 放行窗口续期的节流。 */
    private static final long SENSITIVE_RENEW_INTERVAL_MS = 5_000L;

    /**
     * 临时盖在系统设置页上面的系统弹框 —— 它们<b>不</b>算「离开了这次行程」。
     *
     * <p>不排除的话，家长在「忽略电池优化」页上被系统权限弹框盖一下，回到设置页就会被
     * 我们自己推回桌面，表现是「点两下就闪退」。
     */
    private static final Set<String> SENSITIVE_EXCURSION_TRANSIENT = new HashSet<>(Arrays.asList(
            "com.android.permissioncontroller",
            "com.google.android.permissioncontroller",
            "com.android.vpndialogs",
            "com.android.systemui",
            "android"
    ));

    private static volatile boolean connected;
    /**
     * 当前活着的实例，供远程协助（契约 §7）跨进程调用。
     *
     * <p>{@code performGlobalAction} / {@code startActivity} 都是实例方法，
     * 而指令是从 {@code AgentService} 那条线程发过来的 —— 没有这个引用就只能干瞪眼。
     * 服务断开时置空，避免用法已经失效的实例。
     */
    private static volatile LockWatchdogService instance;

    private AgentStore store;
    private long lastEnforceAt;
    /** 服务是否已连接（界面据此显示状态）。 */
    public static boolean isConnected() {
        return connected;
    }

    /**
     * 从系统设置里读取本服务是否已启用。
     *
     * <p>{@link #isConnected()} 只在进程活着时有意义；重新打开界面时进程可能是新的，
     * 所以要另外问一次系统。
     */
    public static boolean isEnabledInSettings(Context context) {
        try {
            android.view.accessibility.AccessibilityManager manager =
                    (android.view.accessibility.AccessibilityManager)
                            context.getSystemService(Context.ACCESSIBILITY_SERVICE);
            if (manager == null) return false;
            for (AccessibilityServiceInfo info : manager.getEnabledAccessibilityServiceList(
                    AccessibilityServiceInfo.FEEDBACK_ALL_MASK)) {
                String id = info.getId();
                if (id != null && id.contains(context.getPackageName())) return true;
            }
        } catch (Exception e) {
            return false;
        }
        return false;
    }

    @Override
    protected void onServiceConnected() {
        super.onServiceConnected();
        store = new AgentStore(this);
        connected = true;
        instance = this;
        // 把本实例登记给无障碍截图能力：takeScreenshot() 是实例方法，
        // 而截图指令来自别的线程，没有这个引用就只能回退到需要孩子点授权框的 MediaProjection。
        AccessibilityScreenCapture.attach(this);
        // 把「用无障碍服务上下文起 Activity」的能力注入 ui 层。
        // 悬浮窗权限被撤销时，应用上下文起 Activity 会被系统静默拦掉，
        // 只有走无障碍服务这条合法豁免才能把锁定页重新拉起来。
        com.balloondog.agent.ui.LockWatchdogBridge.installActivityStarter(intent -> {
            try {
                startActivity(intent);
                return true;
            } catch (Exception e) {
                EventLog.warn("经无障碍服务启动锁定页失败：" + e.getMessage());
                return false;
            }
        });
        EventLog.success("无障碍看门狗已连接：锁定界面被抢走时会自动拉回来");
    }

    @Override
    public boolean onUnbind(android.content.Intent intent) {
        connected = false;
        instance = null;
        // 服务已失效，必须注销截图实例，否则截图会一直卡在「调用成功但没有回调」上
        AccessibilityScreenCapture.detach(this);
        EventLog.warn("无障碍看门狗已断开（被系统关闭或在设置里关掉了），截图将回退到需要授权的屏幕共享");
        // 这是「孩子绕过管控」里最要命的一条：关掉无障碍，锁定、限时、插件拦截、
        // 免授权截图全部失效。立刻上报家长端并尝试自救（能不能重开取决于系统
        // key 白名单，实测结论见 LongevityGuard.tryReEnableAccessibility）。
        LongevityGuard.onAccessibilityLost(this, "无障碍服务被关闭");
        return super.onUnbind(intent);
    }

    @Override
    public void onDestroy() {
        // onUnbind 不一定被调用（例如进程内直接销毁），这里再兜一次底。
        // 刻意不在这里上报「被关闭」：进程正常销毁（升级、家长停止守护）时
        // onDestroy 也会被调用，在那上面报篡改会产生假警报；漏报由
        // LongevityGuard 的 5 分钟巡检兜住。
        AccessibilityScreenCapture.detach(this);
        super.onDestroy();
    }

    // ---------------- 远程协助（契约 §7） ----------------

    /**
     * 执行一个全局动作（返回 / 主页 / 最近任务 / 通知栏）。
     *
     * <p>无障碍未连接时返回 false，由调用方如实回报失败 ——
     * <b>不做「假装点了」的兜底</b>：家长点「返回」却没反应，
     * 比告诉他「无障碍服务没连上」糟糕得多。
     */
    public static boolean performRemoteGlobalAction(int action) {
        LockWatchdogService service = instance;
        if (service == null || !connected) return false;
        try {
            return service.performGlobalAction(action);
        } catch (Exception e) {
            EventLog.warn("远程执行全局动作失败（action=" + action + "）：" + e.getMessage());
            return false;
        }
    }

    /**
     * 远程打开一个应用。
     *
     * <p>优先用无障碍服务的上下文 {@code startActivity}：Android 10+ 对后台应用
     * 启动 Activity 有严格限制，而无障碍服务是系统明确豁免的那一类。
     * 无障碍没连上时退回应用上下文（有悬浮窗权限时也能成功），并如实返回错误原因。
     *
     * @return null 表示已成功发出启动请求；否则是给人看的中文失败原因
     */
    @Nullable
    public static String launchApp(@NonNull Context context, @NonNull String packageName) {
        android.content.pm.PackageManager pm = context.getPackageManager();
        android.content.Intent launchIntent = pm.getLaunchIntentForPackage(packageName);
        if (launchIntent == null) {
            return "找不到应用 " + packageName + "（可能已被卸载，或它没有桌面入口）";
        }
        launchIntent.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK);

        LockWatchdogService service = instance;
        if (service != null && connected) {
            try {
                service.startActivity(launchIntent);
                return null;
            } catch (Exception e) {
                EventLog.warn("经无障碍服务启动应用失败：" + e.getMessage());
            }
        }
        try {
            context.startActivity(launchIntent);
            return null;
        } catch (Exception e) {
            return "启动应用失败（无障碍未连接，且系统拦住了后台启动）" + e.getMessage();
        }
    }

    @Override
    public void onAccessibilityEvent(@Nullable AccessibilityEvent event) {
        if (event == null) return;
        Context context = getApplicationContext();
        if (store == null) store = new AgentStore(context);

        CharSequence packageName = event.getPackageName();
        if (packageName == null) return;
        String pkg = packageName.toString();
        if (pkg.isEmpty()) return;

        // 先记录前台应用 —— 这一步与本服务「是否处于锁定」无关，
        // 因为周期截屏要给每一帧标注当时的前台包名，而截屏在锁定与非锁定期间都会发生。
        com.balloondog.agent.capability.ForegroundAppTracker.record(pkg);

        // 记下「上一个前台应用」：敏感界面封锁要靠它区分「家长从应用内点『去开启』跳过去的」
        // 与「孩子自己从桌面点进设置的」。放在所有 return 之前，保证它一直是最新的。
        String previousForeground = lastForegroundPackage;
        lastForegroundPackage = pkg;

        // ---- 应用审核：孩子点「安装」（契约 §3） ----
        //
        // 放在最前面：这件事与锁不锁屏、是不是学习时段都无关，
        // 只要家长开了「应用审核」，每一次走到安装器界面都要让家长知道。
        maybeReportInstallAttempt(context, event, pkg);

        // 放行：本应用自己的界面（锁定页 / 答题页 / 应急解锁页）
        if (pkg.equals(context.getPackageName())) {
            LockOverlayWindow.setSuspended(false);
            return;
        }

        // ---- 先判定这是不是敏感界面（应用信息 / 卸载 / 各 ROM 安全中心） ----
        //
        // 必须排在下面两条拦截之前：无障碍设置页也长在系统设置包里，它要不要放行取决于
        // 这次是不是「家长从应用内点『开启无障碍』跳过来的」，所以两条拦截共用同一个判定。
        //
        // 窗口文字只取一次、两处共用：敏感界面判定要靠它区分「设置首页」与「应用信息页」
        // （实测事件类名经常是 FrameLayout/Button 这类根视图类，不可靠），
        // 下面的 GuardRules 也要用同一份文本，取两次没有意义。
        String windowText = collectWindowText(event);
        String sensitive = SensitiveScreens.match(pkg, event.getClassName(), windowText);
        boolean accessibilityPage = isAccessibilitySettingsPage(pkg, event);
        boolean excursion = false;
        // 无障碍设置页也长在设置包里，而收窄之后它不再算「敏感界面」（只有应用信息页算），
        // 所以这里必须把 accessibilityPage 一并纳入放行窗口的判定 ——
        // 否则家长从应用内点「开启无障碍」跳进来时敏感界面判定为 null，
        // 会直接走下面的 else 分支把 excursion 清零，家长自己反被挡在门外（自锁死）。
        if (sensitive != null || accessibilityPage) {
            excursion = updateSensitiveExcursion(context, previousForeground);
        } else if (!SENSITIVE_EXCURSION_TRANSIENT.contains(pkg)) {
            // 离开系统页面（且不是盖在上面的系统弹框）＝ 这一次引导行程结束，
            // 下次再进设置就得重新从应用内点「去开启」。
            sensitiveExcursion = false;
        }

        // ---- 无障碍设置页拦截（只在「管控加固」开着时） ----
        //
        // 为什么值得单列一条：Android 不允许任何人 —— 包括设备所有者 —— 静默重开一个
        // 无障碍服务（实测原文：Device owners cannot update enabled_accessibility_services，
        // 见 LongevityGuard.tryReEnableAccessibility）。既然「关掉之后」救不回来，
        // 那就只能「在关掉之前」把路挡住：孩子一进这一页就按返回推走。
        //
        // 刻意<b>不</b>塞进 GuardRules：那里是学习模式/插件的文本匹配逻辑，
        // 而 ALWAYS_ALLOWED 放行整个 settings 包是那条链路的前提，混进去会破坏它。
        if (accessibilityPage) {
            if (!store.isHardeningEnabled()) {
                // 家长关掉了加固：这一页就是家长自己的逃生通道，放行并留一条日志便于排查
                long allowedAt = SystemClock.elapsedRealtime();
                if (allowedAt - lastA11ySettingsAllowedAt > 30_000L) {
                    lastA11ySettingsAllowedAt = allowedAt;
                    EventLog.info("看门狗：管控加固已关闭，放行无障碍设置页（家长逃生通道）");
                }
            } else if (excursion
                    && SensitiveScreens.HINT_ACCESSIBILITY.equals(SensitiveScreens.allowHint(context))) {
                // 家长从应用内点「开启无障碍」跳进来的 —— 必须放行。
                //
                // 这是本轮修掉的死锁：加固开着时无障碍一旦关掉就再也开不回来
                // （系统不允许设备所有者静默重开，见上），而唯一能手动开的入口又正好是这一页。
                // 不放行 = 这台设备永久失去看门狗，只能卸载重装。
                // 代价是孩子点同一个按钮也能进来 —— 见 SensitiveScreens 里关于
                // 「没有家长身份验证，应用内放行按钮就不是安全边界」的说明。
                long allowedAt = SystemClock.elapsedRealtime();
                if (allowedAt - lastA11yGuideAllowedAt > 30_000L) {
                    lastA11yGuideAllowedAt = allowedAt;
                    EventLog.info("看门狗：家长从应用内点「开启无障碍」进来，放行这一页（加固仍开着）");
                }
            } else {
                blockAccessibilitySettings(event);
                return;
            }
        }

        // ---- 敏感界面封锁：其余的系统设置 / 应用管理 / 卸载界面，一进去就退回桌面 ----
        //
        // Android 没有「禁止打开系统设置」的设备所有者限制（逐条核对过 android-33 的
        // UserManager，只有 DISALLOW_CONFIG_WIFI 这类单项），所以只能用无障碍盯前台窗口。
        // 保证「卸不掉」的仍然是 DISALLOW_UNINSTALL_APPS + setUninstallBlocked；
        // 这一段是「别让孩子进去乱点」，是追赶不是墙。详见 SensitiveScreens。
        if (sensitive != null && !accessibilityPage) {
            if (!store.isHardeningEnabled()) {
                long now = SystemClock.elapsedRealtime();
                if (now - lastSensitivePassLogAt > 30_000L) {
                    lastSensitivePassLogAt = now;
                    EventLog.info("看门狗：管控加固已关闭，放行「" + sensitive + "」（家长逃生通道）");
                }
            } else if (!excursion) {
                blockSensitiveScreen(event, sensitive);
                return;
            }
        }

        // ---- 学习模式 / 应用插件管控 ----
        //
        // 这一段<b>必须在「是否锁定」判定之前</b>：学习模式与插件管控是在设备
        // 正常可用的情况下也要生效的规则，与锁不锁屏无关。
        // 如果放在后面，家长会发现「没锁屏的时候学习模式根本不管用」。
        if (guard(context, event, pkg, windowText)) return;

        // 以下是锁定态的复核，只在策略要求锁定时才做
        LockState state = LockState.compute(
                LockEnforcer.buildInputs(store, TrustedClock.now()));
        if (!state.locked) return;
        // 放行：紧急呼叫与来电 —— 安全底线，无条件。
        // 不仅要放行，还要主动把锁定界面撤掉，否则它会盖在拨号/接听界面上，
        // 孩子依然按不到「拨打」和「接听」。
        if (ALLOWED_WHILE_LOCKED.contains(pkg)) {
            LockOverlayWindow.setSuspended(true);
            return;
        }
        LockOverlayWindow.setSuspended(false);

        long now = SystemClock.elapsedRealtime();

        // ---- 系统锁屏盖在最上面时，什么都不要做 ----
        //
        // 两个理由，第二个是实测踩出来的：
        //  1) 设备此刻由系统锁着，本来就没被绕开，没有可防的东西；
        //  2) 我们的锁定页<b>盖不到系统锁屏上面去</b>，强行去拉只会形成
        //     「拉上来 → 系统锁屏重新压回去 → 再拉」的死循环。实测在
        //     password 档下每 400ms 一次，疯狂耗电，而且锁定页被反复重建，
        //     家长连「应急解锁」入口都点不到 —— 那是需求 2 的安全底线，不能失效。
        //
        // 等孩子把系统锁屏解开（或用了应急密码），isKeyguardLocked() 变 false，
        // 看门狗立刻恢复工作，把锁定页重新摆回最前。
        if (isKeyguardShowing(context)) {
            if (now - lastKeyguardNoticeAt > 30_000L) {
                lastKeyguardNoticeAt = now;
                EventLog.info("看门狗：系统锁屏正盖在最上面，暂停拉取锁定页（避免与系统锁屏互相打架）");
            }
            return;
        }

        if (now - lastEnforceAt < ENFORCE_INTERVAL_MS) return;
        lastEnforceAt = now;

        enforce(context, pkg, event, state);
    }

    /**
     * 检测到安装器界面时，向家长发起一次安装审核申请，并明确告诉孩子「已请求家长批准」。
     *
     * <p><b>这里只做两件事</b>：上报一次申请 + 给孩子一句说明。真正「禁止安装」的
     * 是 {@link com.balloondog.agent.capability.OwnerHardening} 里的
     * {@code DISALLOW_INSTALL_APPS} 用户限制（需要设备所有者）。
     * 刻意不做「找到安装按钮再点返回」这类假动作：拦不住不说，还会把安装器搞成奇怪的状态，
     * 而安装器本身是系统界面，乱按会误导孩子。
     *
     * <p>去重按「尽力取到的应用名」做，取不到就退回安装器包名。
     * 安装器窗口里没有待安装应用的包名（只有展示名），硬按包名去重只会永远退化成
     * 「同一台机器 10 分钟最多报一条」，反而漏掉换一个应用再装的情况。
     */
    private void maybeReportInstallAttempt(Context context, AccessibilityEvent event, String pkg) {
        if (!INSTALLER_PACKAGES.contains(pkg) || store == null) return;
        // 家长没开「应用审核」时，装应用与他无关，不要制造骚扰
        if (!store.isFeatureEnabled("appAudit")) return;

        String appName = guessAppNameFromWindowText(collectWindowText(event));
        boolean named = appName != null && !appName.isEmpty();
        String identity = named ? appName : pkg;

        long now = SystemClock.elapsedRealtime();
        Long last = installAuditReportedAt.get(identity);
        if (last != null && now - last < INSTALL_AUDIT_DEDUP_MS) return;
        installAuditReportedAt.put(identity, now);
        store.setInstallAuditLastAt(System.currentTimeMillis());

        String display = named ? appName : pkg;
        // onAccessibilityEvent 跑在主线程上，而上报是一次同步网络请求：
        // 直接调用会抛 NetworkOnMainThreadException，被 catch 后永远走到「联系不上家长端」那一支，
        // 于是家长端永远收不到申请。放到后台线程，再把结果发回主线程显示。
        final Context appContext = context.getApplicationContext();
        new Thread(() -> {
            final boolean sent = AgentService.reportInstallAttempt(display, pkg);
            mainHandler.post(() -> showInstallAuditResult(appContext, display, sent));
        }, "install-audit-report").start();
    }

    /** 把「申请是否送达」如实告诉孩子；失败就是失败，不写成「已请求」。 */
    private void showInstallAuditResult(Context context, String display, boolean sent) {
        String message = sent
                ? "已请求家长批准：正在安装「" + display + "」"
                : "检测到安装「" + display + "」，但暂时联系不上家长端，请稍后再试";
        EventLog.info("安装审核：" + message);
        try {
            android.widget.Toast.makeText(context, message, android.widget.Toast.LENGTH_LONG).show();
        } catch (Exception e) {
            // Toast 在少数 ROM 上会因通知/悬浮权限被拦，失败不影响上报本身
            EventLog.warn("安装审核提示未能显示：" + e.getMessage());
        }
        AgentNotifications.notifyEvent(context, Constants.NOTIFICATION_ID_AUDIT,
                sent ? "已请求家长批准" : "安装审核上报失败", message);
    }

    /**
     * 从安装器窗口文本里尽力猜出正在安装的应用名。
     *
     * <p>纯启发式，猜不到就返回 null 由调用方兜底。安装器的文案各 ROM 差异很大，
     * 这里只覆盖最常见的几种（带书名号的、以及「要安装/安装应用 …… 吗」句式）。
     */
    @Nullable
    private static String guessAppNameFromWindowText(@Nullable String text) {
        if (text == null || text.isEmpty()) return null;
        String[] patterns = {
                "安装应用[「“\"]([^」”\"]{1,40})[」”\"]",
                "要安装[「“\"]?([^，。？!？]{1,30}?)[」”\"]?吗",
                "安装[「“\"]([^」”\"]{1,40})[」”\"]",
                "「([^」]{1,40})」"
        };
        for (String pattern : patterns) {
            try {
                java.util.regex.Matcher matcher = java.util.regex.Pattern.compile(pattern).matcher(text);
                if (matcher.find()) {
                    String found = matcher.group(1);
                    if (found != null && found.trim().length() > 0) return found.trim();
                }
            } catch (Exception ignored) {
                // 正则只是尽力而为，出错就当没匹配上
            }
        }
        return null;
    }

    /**
     * 是否是系统「无障碍」设置页。
     *
     * <p>判据刻意用<b>类名</b>而不是文本：无障碍事件是 {@code TYPE_WINDOW_STATE_CHANGED}，
     * {@code event.getClassName()} 给的就是 Activity 类名 —— 实测是
     * {@code com.android.settings.Settings$AccessibilitySettingsActivity}
     * 与 {@code com.android.settings.accessibility.AccessibilitySettings}，
     * 换语言也不会变。文本匹配（学习模式/插件那套妥协做法）换个语言就废，不要用在这里。
     *
     * <p>三个条件缺一不可：包名是 {@code com.android.settings}、类名在这个包下、
     * 类名含 {@code Accessibility}。这样既不会拦到 Wi-Fi/语言/电池这些家长自己要用的页面，
     * 也不会漏掉各 ROM 的命名差异（例如 {@code ...AccessibilityDetailsSettingsActivity}
     * 是单个服务的详情页，正是关掉开关的地方，一起拦掉）。
     */
    private static boolean isAccessibilitySettingsPage(String pkg, AccessibilityEvent event) {
        if (!SETTINGS_PACKAGE.equals(pkg)) return false;
        CharSequence cls = event.getClassName();
        if (cls == null) return false;
        String name = cls.toString();
        return name.startsWith(SETTINGS_PACKAGE + ".") && name.contains("Accessibility");
    }

    /**
     * 把系统的无障碍设置页推走（按返回）。
     *
     * <p><b>三条边界，都不要越界：</b>
     * <ol>
     *   <li>只在家长开着「管控加固」时拦（调用点已判断）；关掉加固就是家长自己的逃生通道。</li>
     *   <li>只拦这一页，<b>不</b>拦整个 Settings —— 家长还要改 Wi-Fi、语言、电池。</li>
     *   <li>拦不住不装成功：同一页在 3 秒内反复出现，说明上一次按返回没把它推走，
     *       如实记一条「没拦住」而不是继续报「已阻止」。</li>
     * </ol>
     */
    private void blockAccessibilitySettings(AccessibilityEvent event) {
        String cls = event.getClassName() == null ? "unknown" : event.getClassName().toString();
        long now = SystemClock.elapsedRealtime();

        // 推走之后就不会再有这一页的窗口事件；同一个类名在 3 秒内反复出现 = 上一次没推走
        if (cls.equals(lastA11yBlockedClass) && now - lastA11yBlockedAt < 3_000L) {
            a11yBlockFailStreak++;
        } else {
            a11yBlockFailStreak = 0;
            a11yBlockFailReported = false;
        }
        lastA11yBlockedClass = cls;
        lastA11yBlockedAt = now;

        // 按返回的动作每次都做（节流只节流日志/事件）：孩子多点一次就多推一次，
        // 这与 enforce() 里「设置类界面逐层推出」是同一个思路。
        if (now - lastA11ySettingsBlockAt > A11Y_SETTINGS_BLOCK_INTERVAL_MS) {
            lastA11ySettingsBlockAt = now;
            if (a11yBlockFailStreak >= 3 && !a11yBlockFailReported) {
                a11yBlockFailReported = true;
                EventLog.warn("看门狗：连续按返回后仍反复进入无障碍设置页（" + cls
                        + "），如实记录：这条路径没能拦住");
                com.balloondog.agent.service.AgentService.recordEventStatic(Constants.EVENT_TAMPER,
                        "未能阻止进入无障碍设置页：连续按返回无效，孩子仍可能在这一页关闭「气球狗守护」");
            } else {
                EventLog.warn("看门狗：拦截无障碍设置页（按返回推走；加固开启期间不允许在设备上关闭守护服务）");
                com.balloondog.agent.service.AgentService.recordEventStatic(Constants.EVENT_TAMPER,
                        "已拦截无障碍设置页：加固开启期间无法在设备上关闭「气球狗守护」，"
                                + "家长需要先关掉「管控加固」");
            }
        }
        performGlobalAction(GLOBAL_ACTION_BACK);
    }

    /**
     * 维护「从应用内跳进系统页面」的行程状态。
     *
     * <p>放行窗口本身只说明「刚刚有人从应用内点了『去开启』」，还需要两条约束把它钉在引导流程上：
     * <ol>
     *   <li>进入系统页面的那一刻，上一个前台应用必须<b>还是本应用</b> ——
     *       孩子从桌面/最近任务自己点进设置不算；</li>
     *   <li>行程一旦离开系统页面就结束（{@link #SENSITIVE_EXCURSION_TRANSIENT} 里的系统弹框
     *       不算离开），所以「点一次引导页换来一张 45 秒通行证」只在一直待在系统页面里时有效。</li>
     * </ol>
     *
     * @return 本次是否在放行范围内
     */
    private boolean updateSensitiveExcursion(Context context, String previousForeground) {
        long until = SensitiveScreens.allowUntil(context);
        if (TrustedClock.now() >= until) {
            sensitiveExcursion = false;
            return false;
        }
        if (context.getPackageName().equals(previousForeground)) {
            sensitiveExcursion = true;
        }
        if (!sensitiveExcursion) return false;
        // 家长还在系统页面里操作：续期，免得读到一半被我们推走
        long now = SystemClock.elapsedRealtime();
        if (now - lastSensitiveRenewAt > SENSITIVE_RENEW_INTERVAL_MS) {
            lastSensitiveRenewAt = now;
            SensitiveScreens.renew(context);
        }
        return true;
    }

    /**
     * 把敏感界面推回桌面。
     *
     * <p>按<b>桌面</b>而不是返回：用户要的是「退回到桌面」这个明确结果。按返回只退一层，
     * 孩子还能从「设置 → 应用」一层层点进去；按桌面把整条路径一起收掉。
     *
     * <p>失败要如实记：无障碍没连上时 {@code performGlobalAction} 返回 false，
     * 这时候写「已退回桌面」就是谎报。
     */
    private void blockSensitiveScreen(AccessibilityEvent event, String label) {
        long now = SystemClock.elapsedRealtime();
        if (now - lastSensitiveBlockAt <= SENSITIVE_BLOCK_INTERVAL_MS) return;
        lastSensitiveBlockAt = now;

        String cls = event.getClassName() == null ? "unknown" : event.getClassName().toString();
        boolean ok = performGlobalAction(GLOBAL_ACTION_HOME);

        if (now - lastSensitiveLogAt <= SENSITIVE_LOG_INTERVAL_MS) return;
        lastSensitiveLogAt = now;

        if (!ok) {
            EventLog.warn("敏感界面封锁：想拦「" + label + "」（" + cls
                    + "）但退回桌面失败（无障碍未连接？）");
            return;
        }
        if (now - lastSensitiveReportAt > SENSITIVE_REPORT_INTERVAL_MS) {
            lastSensitiveReportAt = now;
            EventLog.warn("敏感界面封锁：拦截「" + label + "」（" + cls + "），已退回桌面");
            com.balloondog.agent.service.AgentService.recordEventStatic(Constants.EVENT_TAMPER,
                    "已拦截「" + label + "」：加固开启期间不允许在设备上进入系统设置/应用管理/卸载界面，"
                            + "已退回桌面");
        } else {
            EventLog.warn("敏感界面封锁：拦截「" + label + "」（" + cls + "），已退回桌面（上报已节流）");
        }
    }

    /**
     * 学习模式 / 应用限时 / 应用插件管控的拦截。
     *
     * @return true 表示已经拦下并处理（调用方应当直接返回，不要再走锁定复核）
     */
    /**
     * 学习模式专用桌面（规划 §4.4）：上一次同步后的状态。null 表示还没同步过。
     *
     * <p>只在**状态翻转**时动 DPM（钉住 / 还回去），不是每个无障碍事件都去改默认桌面。
     */
    private Boolean studyHomeApplied = null;

    /**
     * 把「默认桌面该不该是学习桌面」同步到系统。
     *
     * <p>为什么放在无障碍事件里：这个服务是事件驱动的（没有轮询循环），而学习模式的变化
     * 总要等孩子动一下手机（按 home、切应用）才谈得上「他要看到桌面」。代价是接管
     * 发生的时刻是「下一次前台变化」，不是整点那一秒 —— 这一点在文档里如实写明。
     *
     * <p>没有设备所有者时 {@link StudyHomeController#hold} 会返回 false，动态里会留下
     * 「桌面接管失败」，而不是让孩子对着一个假的桌面以为管控生效了。
     */
    private void syncStudyHome(Context context) {
        boolean study = StudyModeEngine.isStudy(store.getModeConfig(), TrustedClock.now());
        boolean owner = StudyHomeController.isDeviceOwner(context);
        boolean want = StudyLauncher.canHoldHome(study, owner);

        if (studyHomeApplied == null) studyHomeApplied = StudyHomeController.isHeld(context);
        if (want == studyHomeApplied) return;

        if (want) {
            boolean ok = StudyHomeController.hold(context,
                    new ComponentName(context, StudyHomeActivity.class));
            studyHomeApplied = ok;
            if (ok) {
                EventLog.info("学习模式：已接管桌面（只显示家长允许的应用）");
            } else {
                EventLog.warn("学习模式：桌面接管失败（本机不是设备所有者，系统不允许改默认桌面）");
            }
        } else {
            StudyHomeController.release(context);
            studyHomeApplied = false;
            EventLog.info("学习模式结束：已把默认桌面还回去");
        }
    }

    private boolean guard(Context context, AccessibilityEvent event, String pkg, String windowText) {
        if (inventory == null) inventory = new com.balloondog.agent.capability.AppInventory();
        inventory.ensureScanned(context);

        // 桌面接管与「拦不拦这个应用」无关，但它必须跟着学习模式一起翻转，
        // 所以放在这里（每个无障碍事件都会经过，状态没变时是一行比较的开销）。
        syncStudyHome(context);

        // 只有「孩子正在看的那一屏」才谈得上拦。
        //
        // 无障碍事件不区分前后台：桌面的搜索框、后台应用的界面刷新一样会发
        // typeWindowContentChanged 过来。照单全收会把人逼进死循环 —— 实测按下
        // 「返回桌面」后，桌面(GOOGLE 搜索那一屏，包名 com.google.android.googlequicksearchbox)
        // 刚起来就被判成「学习模式中不在允许清单里」，说明页立刻盖回去，桌面永远回不去。
        // 判定与拦截都按前台包名做，所以「事件包名 ≠ 当前活动窗口的包名」时直接放行，
        // 不会漏拦：真正越界的应用就在前台，它的窗口就是活动窗口。
        if (!isForegroundEvent(pkg)) return false;

        // 学习模式开着、却没拦下来时，把判定依据摊开说清楚。
        // 「设了学习模式但不管用」是最难查的一类反馈：可能是白名单写错了，
        // 也可能是这个包被当成了系统组件，光看「没有拦截日志」什么都推不出来。
        if (StudyModeEngine.isStudy(store.getModeConfig(), TrustedClock.now())) {
            long diagNow = SystemClock.elapsedRealtime();
            if (diagNow - lastStudyDiagAt > 5_000L) {
                lastStudyDiagAt = diagNow;
                EventLog.info("学习模式判定：" + pkg
                        + " 可启动=" + inventory.isLaunchable(pkg)
                        + " 是桌面=" + inventory.isHome(pkg)
                        + " 在白名单=" + store.getModeConfig().studyApps.contains(pkg));
            }
        }

        com.balloondog.agent.capability.GuardRules.GuardDecision decision =
                com.balloondog.agent.capability.AccessibilityGuard.check(
                        store, inventory, context, pkg, windowText, TrustedClock.now());
        if (decision == null || decision.reason == null) return false;

        long now = SystemClock.elapsedRealtime();
        // 与锁定复核共用同一个节流：同一个界面连续触发时不要疯狂按返回
        if (now - lastGuardAt < GUARD_INTERVAL_MS) return true;
        lastGuardAt = now;

        // 同一个应用 + 同一个原因，10 秒内只记一条事件。
        // 不加这个去重的话，孩子停在被拦的页面上会刷出成百上千条重复动态，
        // 家长端的「最新动态」会瞬间被淹没。
        String dedupKey = pkg + "|" + decision.reason;
        if (!dedupKey.equals(lastGuardKey) || now - lastGuardEventAt > 10_000L) {
            lastGuardKey = dedupKey;
            lastGuardEventAt = now;
            String type = decision.pluginKey != null
                    ? com.balloondog.agent.data.Constants.EVENT_PLUGIN_BLOCKED
                    : com.balloondog.agent.data.Constants.EVENT_APP_BLOCKED;
            EventLog.warn("看门狗：拦截 " + pkg + " —— " + decision.reason);
            com.balloondog.agent.service.AgentService.recordEventStatic(type, decision.reason);
        }

        // 拦截动作：弹一页「这个应用被禁止使用」，把原因说清楚。
        //
        // 在此之前只是按一下系统返回键：孩子被静默弹回上一个界面，既不知道发生了什么、
        // 也不知道该找谁 —— 观感就是「手机坏了」。说明页唯一的出口是「回桌面」，
        // 所以孩子不会被扔回被禁的应用里。
        //
        // 判定链上的三种拦截（插件管控 / 学习模式 / 应用限时）都是按前台包名判的，
        // 不存在「只拦某个网页」的情况，所以「这个应用被禁止」这句话始终成立。
        com.balloondog.agent.ui.AppBlockedActivity.show(
                context, appLabelOf(context, pkg), decision.reason, null);
        return true;
    }

    /** 取应用名用于「禁止使用」说明页；取不到返回 null，由页面自己回退成「这个应用」。 */
    private static String appLabelOf(Context context, String pkg) {
        try {
            android.content.pm.PackageManager pm = context.getPackageManager();
            return pm.getApplicationLabel(pm.getApplicationInfo(pkg, 0)).toString();
        } catch (Exception e) {
            return null;
        }
    }

    /**
     * 这个事件是不是来自「孩子正在看的那一屏」（当前活动窗口）。
     *
     * <p>无障碍事件里 {@code getPackageName()} 只说明「这条事件是哪个包发的」，
     * 不说明它是不是在前台 —— 桌面的搜索框（com.google.android.googlequicksearchbox）、
     * 后台应用的界面刷新都会发 {@code typeWindowContentChanged}。只看包名就会把
     * 后台刷新当成越界使用。
     *
     * <p>判不出来时一律返回 {@code true}（按老逻辑处理）：宁可偶尔拦错，
     * 也不能因为系统不给窗口信息就整个管控失效。
     */
    private boolean isForegroundEvent(String pkg) {
        String activePkg = null;
        try {
            List<AccessibilityWindowInfo> windows = getWindows();
            if (windows == null || windows.isEmpty()) return true;
            for (AccessibilityWindowInfo window : windows) {
                if (window == null || !window.isActive()) continue;
                AccessibilityNodeInfo root = window.getRoot();
                if (root != null && root.getPackageName() != null) {
                    activePkg = root.getPackageName().toString();
                }
                break;
            }
        } catch (Exception e) {
            return true;
        }
        if (activePkg == null || activePkg.isEmpty()) return true;
        if (activePkg.equals(pkg)) return true;

        long now = SystemClock.elapsedRealtime();
        if (!pkg.equals(lastBackgroundSkipPkg) || now - lastBackgroundSkipAt > 30_000L) {
            lastBackgroundSkipPkg = pkg;
            lastBackgroundSkipAt = now;
            EventLog.info("看门狗：放行后台窗口事件 " + pkg + "（当前活动窗口是 " + activePkg + "）");
        }
        return false;
    }

    /**
     * 收集当前窗口的可见文本，供插件关键词匹配。
     *
     * <p>遍历是有界且带预算的：无障碍节点树可能非常大，无节制遍历会拖慢主线程，
     * 反而让整个无障碍服务被系统判定为无响应。
     */
    private String collectWindowText(AccessibilityEvent event) {
        StringBuilder sb = new StringBuilder();
        try {
            List<CharSequence> texts = event.getText();
            if (texts != null) {
                for (CharSequence t : texts) {
                    if (t != null) sb.append(t).append(' ');
                }
            }
            if (event.getContentDescription() != null) {
                sb.append(event.getContentDescription()).append(' ');
            }
            if (event.getClassName() != null) {
                sb.append(event.getClassName()).append(' ');
            }

            AccessibilityNodeInfo root = getRootInActiveWindow();
            if (root != null) {
                int[] budget = {MAX_TEXT_NODES};
                collectNodeText(root, sb, 0, budget);
            }
        } catch (Exception e) {
            // 取文本失败就只用事件自带的那点信息，绝不能因此中断拦截链路
        }
        return sb.toString();
    }

    private void collectNodeText(AccessibilityNodeInfo node, StringBuilder sb, int depth, int[] budget) {
        if (node == null || depth > MAX_TEXT_DEPTH || budget[0] <= 0) return;
        budget[0]--;

        if (node.getText() != null) sb.append(node.getText()).append(' ');
        if (node.getContentDescription() != null) sb.append(node.getContentDescription()).append(' ');

        int count = node.getChildCount();
        for (int i = 0; i < count; i++) {
            if (budget[0] <= 0) break;
            collectNodeText(node.getChild(i), sb, depth + 1, budget);
        }
    }

    /** 把锁定界面重新拉回最前；必要时补一次返回把逃逸的界面推走。 */
    private void enforce(Context context, String pkg, AccessibilityEvent event, LockState state) {
        // 孩子正在解锁流程里（锁定页自己的应急密码弹窗 / 答题解锁页）时不要拉锁定界面：
        // 拉起走的是 CLEAR_TOP，会把答题页直接弹掉，孩子连题目都看不完。
        // 这两个页面本身就是锁定态，没有「被绕过」可言。
        if (com.balloondog.agent.capability.LockReassertor.isOwnUnlockUiOnTop()) return;

        String windowClass = event.getClassName() == null ? "" : event.getClassName().toString();
        if (isNotificationShade(pkg, windowClass)) {
            // 通知栏本身不需要「拉回锁定界面」——锁定界面就在它下面，拉也盖不住。
            // 真正解决它的是 LockOverlayWindow 用的 TYPE_ACCESSIBILITY_OVERLAY（层级高于状态栏），
            // 所以这里只记一笔日志，便于排查「为什么通知栏没被挡住」。
            EventLog.warn("看门狗：通知栏被下拉（锁定界面已采用无障碍层级，应仍在其之上）");
            return;
        }

        EventLog.warn("看门狗：检测到「" + pkg + "」抢到前台，正在把锁定界面拉回来");

        // 重新挂上锁定界面（内部按能力档选择 kiosk 还是全屏悬浮窗）。
        // 这里刻意传 <b>this</b>（无障碍服务自身）而不是 ApplicationContext：
        // TYPE_ACCESSIBILITY_OVERLAY 这个能盖住通知栏的层级，只认正在运行的无障碍服务上下文。
        LockEnforcer.showLockUi(isAccessibilityContextUsable() ? this : context, store, state);

        // 设置类界面：持续按返回把它一路推出去。
        //
        // 刻意<b>不</b>做「同一个包只按一次」的去重：设置页是一层套一层的
        // （应用详情 → 应用列表 → 设置首页），按一次只是退了一层，界面仍然在。
        // 节流已经由 ENFORCE_INTERVAL_MS（400ms）兜住，不会疯狂按键。
        if (SETTINGS_LIKE.contains(pkg)) {
            performGlobalAction(GLOBAL_ACTION_BACK);
            EventLog.warn("看门狗：正在把设置类界面「" + pkg + "」逐层推出（阻止撤销权限 / 关闭本服务）");
        }
    }

    /** 上一次因为「系统锁屏在最上面」而跳过拉取时打日志的时间（避免刷屏）。 */
    private long lastKeyguardNoticeAt;

    /** 上一次打印「学习模式判定依据」的时间（排查用，5 秒最多一条）。 */
    private long lastStudyDiagAt;

    /** 上一次因为「事件来自后台窗口」而放行时打日志的时间与包名（避免刷屏）。 */
    private long lastBackgroundSkipAt;
    private String lastBackgroundSkipPkg = "";

    /** 学习模式 / 插件拦截用的应用清单（延迟创建，本服务可能很早就被系统拉起）。 */
    private com.balloondog.agent.capability.AppInventory inventory;
    /** 两次学习模式 / 插件拦截之间的最小间隔。 */
    private static final long GUARD_INTERVAL_MS = 400L;
    private long lastGuardAt;
    /** 拦截事件的去重键与时间，避免同一个被拦页面刷出成百上千条动态。 */
    private String lastGuardKey = "";
    private long lastGuardEventAt;
    /** 单次文本收集的节点预算与深度上限。 */
    private static final int MAX_TEXT_NODES = 200;
    private static final int MAX_TEXT_DEPTH = 14;

    /** 系统锁屏（Keyguard）此刻是否正盖在最上面。 */
    private static boolean isKeyguardShowing(Context context) {
        try {
            android.app.KeyguardManager km =
                    (android.app.KeyguardManager) context.getSystemService(Context.KEYGUARD_SERVICE);
            return km != null && km.isKeyguardLocked();
        } catch (Exception e) {
            // 读不到就当没有锁屏：宁可多拉一次，也不要因为异常而完全停止防护
            return false;
        }
    }

    /** 本服务是否已连接（连接后才拿得到有效的无障碍窗口上下文）。 */
    private boolean isAccessibilityContextUsable() {
        return connected;
    }

    /** 判断是不是通知栏 / 状态栏窗口。 */
    private static boolean isNotificationShade(String pkg, String windowClass) {
        if (!pkg.contains("systemui")) return false;
        String lower = windowClass.toLowerCase(Locale.US);
        return lower.contains("shade") || lower.contains("statusbar") || lower.contains("notification");
    }

    @Override
    public void onInterrupt() {
        // 系统要求实现；被中断时不需要额外处理，下次事件会继续工作
    }

    /** 供界面判断：无设备所有者时是否已开启看门狗（未开启则锁定可被绕过）。 */
    public static String describeStatus(Context context) {
        boolean enabled = isEnabledInSettings(context);
        boolean alive = isConnected();
        if (!enabled) {
            return "未开启：锁定期间可下拉通知栏或进设置绕过";
        }
        if (!alive) {
            // 已启用但进程没连上：通常是刚开机或服务被系统重启中
            return "已开启（服务正在启动）";
        }
        return "已开启：通知栏会被收起，设置界面会被推走";
    }

    /** 提示用：无设备所有者时，锁定强度完全取决于这个开关。 */
    public static boolean shouldRecommend(Context context) {
        boolean owner = com.balloondog.agent.capability.LockCapability.detect(context)
                == com.balloondog.agent.capability.LockCapability.Tier.OWNER;
        // 设备所有者已经用 Lock Task 锁死了，看门狗只是锦上添花，不再提示
        return !owner && !isEnabledInSettings(context);
    }

    /** 悬浮窗权限是否还在 —— 被撤销时看门狗只能退回 Activity，界面要提示。 */
    public static boolean hasOverlayPermission(Context context) {
        return LockOverlayWindow.canShow(context);
    }
}
