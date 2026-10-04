package com.balloondog.agent.service;

import android.accessibilityservice.AccessibilityService;
import android.accessibilityservice.AccessibilityServiceInfo;
import android.content.Context;
import android.os.SystemClock;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;

import androidx.annotation.Nullable;

import com.balloondog.agent.capability.LockEnforcer;
import com.balloondog.agent.capability.StudyModeEngine;
import com.balloondog.agent.capability.LockState;
import com.balloondog.agent.data.AgentStore;
import com.balloondog.agent.data.EventLog;
import com.balloondog.agent.ui.LockOverlayWindow;

import java.util.Arrays;
import java.util.List;
import java.util.HashSet;
import java.util.Locale;
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

    private static volatile boolean connected;

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
        EventLog.warn("无障碍看门狗已断开（被系统关闭或在设置里关掉了）");
        return super.onUnbind(intent);
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

        // 放行：本应用自己的界面（锁定页 / 答题页 / 应急解锁页）
        if (pkg.equals(context.getPackageName())) {
            LockOverlayWindow.setSuspended(false);
            return;
        }

        // ---- 学习模式 / 应用插件管控 ----
        //
        // 这一段<b>必须在「是否锁定」判定之前</b>：学习模式与插件管控是在设备
        // 正常可用的情况下也要生效的规则，与锁不锁屏无关。
        // 如果放在后面，家长会发现「没锁屏的时候学习模式根本不管用」。
        if (guard(context, event, pkg)) return;

        // 以下是锁定态的复核，只在策略要求锁定时才做
        LockState state = LockState.compute(
                LockEnforcer.buildInputs(store, System.currentTimeMillis()));
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
     * 学习模式 / 应用插件管控的拦截。
     *
     * @return true 表示已经拦下并处理（调用方应当直接返回，不要再走锁定复核）
     */
    private boolean guard(Context context, AccessibilityEvent event, String pkg) {
        if (inventory == null) inventory = new com.balloondog.agent.capability.AppInventory();
        inventory.ensureScanned(context);

        // 学习模式开着、却没拦下来时，把判定依据摊开说清楚。
        // 「设了学习模式但不管用」是最难查的一类反馈：可能是白名单写错了，
        // 也可能是这个包被当成了系统组件，光看「没有拦截日志」什么都推不出来。
        if (StudyModeEngine.isStudy(store.getModeConfig(), System.currentTimeMillis())) {
            long diagNow = SystemClock.elapsedRealtime();
            if (diagNow - lastStudyDiagAt > 5_000L) {
                lastStudyDiagAt = diagNow;
                EventLog.info("学习模式判定：" + pkg
                        + " 可启动=" + inventory.isLaunchable(pkg)
                        + " 是桌面=" + inventory.isHome(pkg)
                        + " 在白名单=" + store.getModeConfig().studyApps.contains(pkg));
            }
        }

        String windowText = collectWindowText(event);
        com.balloondog.agent.capability.GuardRules.GuardDecision decision =
                com.balloondog.agent.capability.AccessibilityGuard.check(
                        store, inventory, context, pkg, windowText, System.currentTimeMillis());
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

        // 拦截动作：把这一层推走。
        // 刻意不做「弹一层遮罩挡住」——遮罩会被应用的下一次重绘盖过去，
        // 而且孩子会以为手机坏了。推回上一层是更接近「这个功能用不了」的表达。
        performGlobalAction(GLOBAL_ACTION_BACK);
        return true;
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
