package com.balloondog.agent.service;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.os.SystemClock;
import android.provider.Settings;
import android.text.TextUtils;

import com.balloondog.agent.capability.AppUsageTracker;
import com.balloondog.agent.capability.LockController;
import com.balloondog.agent.capability.OwnerHardening;
import com.balloondog.agent.capability.PermissionGranter;
import com.balloondog.agent.data.AgentStore;
import com.balloondog.agent.data.Constants;
import com.balloondog.agent.data.EventLog;

import java.util.ArrayList;
import java.util.List;

/**
 * 长活（保活 + 防篡改自愈）总闸。
 *
 * <h3>它解决什么问题</h3>
 *
 * <p>需求 2 要的是「不能被杀死、不能被关闭、保持长活」。Android 上这件事只有一半能靠代码做，
 * 另一半必须靠设备所有者：
 *
 * <ul>
 *   <li><b>能靠代码做的</b>：前台服务 + {@code START_STICKY} + {@code stopWithTask="false"}
 *       + {@code onTaskRemoved()} 自拉起 + 闹钟/JobScheduler 双看门狗 + 开机自启。</li>
 *   <li><b>只有设备所有者能做的</b>：让孩子在「设置 → 应用 → 强行停止」里<b>点不动</b>按钮。
 *       这就是 {@code DevicePolicyManager.setUserControlDisabledPackages}（API 30+，见
 *       {@link OwnerHardening}）。没有它，上面的自拉起全都不成立 —— 一旦进入 stopped 状态，
 *       任何广播、闹钟、Job 都唤不醒本应用。</li>
 * </ul>
 *
 * <h3>自愈而不是「设置一次就完事」</h3>
 *
 * <p>孩子会在家长看不见的时候动手：关掉无障碍看门狗、撤销悬浮窗权限、关掉 VPN 授权、
 * 把电池优化白名单取消。本类每隔 {@link #HEAL_INTERVAL_MS} 巡检一次，
 * <b>能自动补的自动补</b>（重新施加加固、补授权、重排看门狗），
 * <b>补不了的如实上报</b>（记审计日志 + 发一条 {@code tamper} 设备事件给家长端），
 * 绝不假装「仍然安全」。
 */
public final class LongevityGuard {

    /** 日志前缀，设备级断言按它取。 */
    public static final String TAG = "气球狗保活";

    /** 巡检间隔。5 分钟：足够快，又不至于让 DPM 调用变成电量负担。 */
    public static final long HEAL_INTERVAL_MS = 5 * 60_000L;

    private static volatile long lastHealAt = 0L;
    private static volatile String lastProblemSignature = "";
    /**
     * 上一次上报过的缺口清单。
     *
     * <p>存清单而不是只存签名，是为了能算出「这次新增了哪几条」「哪几条修好了」：
     * 环境里天然存在修不好的缺口（例如电池优化白名单必须家长点系统框），
     * 只比整串签名的话，孩子关掉无障碍再打开时，恢复消息会被那条永久缺口盖掉。
     */
    private static volatile List<String> lastProblems = null;
    /** 是否已经成功把电池优化白名单这件事记过一次日志，避免每 5 分钟刷一条。 */
    private static volatile Boolean lastBatteryOk = null;

    private LongevityGuard() {
    }

    // ------------------------------------------------------------ 电池优化白名单

    /**
     * 是否已经在电池优化白名单里（Doze 不会冻结本应用的长轮询）。
     *
     * <p>设备所有者应用在多数 ROM 上会被系统默认加入白名单，但这不是 AOSP 的硬保证，
     * 所以这里始终读取真实状态，不假设。
     */
    public static boolean isIgnoringBatteryOptimizations(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return true;
        try {
            PowerManager pm = (PowerManager) context.getSystemService(Context.POWER_SERVICE);
            return pm != null && pm.isIgnoringBatteryOptimizations(context.getPackageName());
        } catch (Exception e) {
            return false;
        }
    }

    /**
     * 弹系统框申请电池优化白名单。
     *
     * <p>这是<b>唯一</b>能让本应用进入 Doze 白名单的公开手段：没有 DPM API 可以静默完成，
     * 所以设备所有者身份在这里帮不上忙，必须家长点一次。返回 true 表示系统框已经拉起，
     * 不代表用户已经同意。
     */
    public static boolean requestBatteryExemption(Context context) {
        try {
            // 加固开启时系统页面默认会被看门狗推回桌面，先给自己开一张限时通行证
            // （见 SensitiveScreens：这不是安全边界，只是让家长点得动这个按钮）
            com.balloondog.agent.capability.SensitiveScreens.allowTemporarily(context,
                    com.balloondog.agent.capability.SensitiveScreens.HINT_GENERIC);
            Intent intent = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
            intent.setData(Uri.parse("package:" + context.getPackageName()));
            if (!(context instanceof Activity)) {
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            }
            context.startActivity(intent);
            EventLog.info("已请求加入电池优化白名单（Doze 下保持长轮询）");
            return true;
        } catch (Exception e) {
            EventLog.warn("申请电池优化白名单失败：" + e.getMessage());
            return false;
        }
    }

    // ------------------------------------------------------------ 无障碍看门狗被关掉时的即时反应

    /**
     * 无障碍看门狗刚失效时的<b>即时</b>反应（{@code LockWatchdogService.onUnbind()} 调用）。
     *
     * <p>为什么除了 5 分钟巡检还要这一条：巡检最多晚 5 分钟才说话，而
     * {@code onUnbind} 是系统给的第一个信号。但 {@code onUnbind} <b>不可靠</b>
     * —— 进程被整个杀掉、或设备直接重启时它不一定触发 —— 所以两条链路都要有，
     * 缺一条就会出现「以为有人看着、其实早就瞎了」。
     *
     * <p>只做事实与自救，不夸大：能重新打开就发一条「已恢复」，打不开就发一条
     * 「已被关闭」把缺口交给家长端。
     */
    public static void onAccessibilityLost(final Context context, final String where) {
        final Context app = context.getApplicationContext();
        final AgentStore store = new AgentStore(app);
        if (!store.isAgentEnabled()) {
            // 家长自己停的守护，不算被篡改
            return;
        }
        EventLog.warn(TAG + "检测到无障碍看门狗失效（" + where + "），立即尝试自救");
        AgentService.recordEventStatic(Constants.EVENT_TAMPER,
                "无障碍守护已被关闭（" + where + "）：锁定、限时、应用拦截与免授权截图都会失效，正在尝试自救");

        Thread worker = new Thread(() -> {
            boolean back = tryReEnableAccessibility(app);
            if (back) {
                EventLog.success(TAG + "无障碍看门狗已被自动恢复");
                AgentService.recordEventStatic(Constants.EVENT_TAMPER,
                        "无障碍守护已自动恢复，管控功能重新生效");
            } else {
                EventLog.warn(TAG + "无法自动恢复无障碍看门狗：孩子可以在设置里一直关着它，"
                        + "这期间锁定只能靠悬浮窗（SYSTEM_ALERT_WINDOW）兜底");
                AgentService.recordEventStatic(Constants.EVENT_TAMPER,
                        "无法自动恢复无障碍守护：需要家长在本机重新开启「气球狗守护」无障碍服务");
            }
            WatchdogScheduler.scheduleWatchdog(app);
        }, "balloon-a11y-heal");
        worker.setDaemon(true);
        worker.start();
    }

    // ------------------------------------------------------------ 无障碍看门狗能否被 DO 强行打开

    /**
     * 尝试用设备所有者身份把本应用的无障碍服务重新写回系统设置。
     *
     * <p>背景（这是本工程<b>最诚实的一条边界说明</b>）：Android 不允许任何应用 ——
     * 包括设备所有者 —— 静默打开<b>第三方</b>无障碍服务，这是系统有意的隐私保护。
     * 但「打开自己」能不能做到，取决于 {@code DevicePolicyManager.setSecureSetting}
     * 的 key 白名单是否包含 {@code Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES}。
     *
     * <p>所以这里不推理、只实测：真去写一次，然后<b>回读系统设置验证</b>。
     * 写不进去就返回 false 并在日志里明说「这条路走不通，孩子仍可在设置里关掉它」，
     * 由 {@link #problems} 把它报成缺口 —— 绝不假装已经堵住。
     *
     * @return true 表示<b>轮询确认</b>无障碍服务已被系统启用<b>且</b>本进程真的绑上了它
     */
    public static boolean tryReEnableAccessibility(Context context) {
        String ours = context.getPackageName() + "/" + LockWatchdogService.class.getName();

        // 判据必须是「系统真的认为它开着」：isEnabledInSettings() 走
        // AccessibilityManager.getEnabledAccessibilityServiceList()，同时覆盖无障碍<b>总开关</b>
        // 与每服务启用列表。
        //
        // 旧实现只读 Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES，孩子<b>只关总开关</b>
        // （每服务的条目被系统保留）时它会立刻返回 true，于是家长端先收到「无障碍守护已自动恢复」，
        // 12 毫秒后巡检又报「仍有缺口」——两条互相矛盾的动态，而真相是管控已经死了。
        //
        // 而且「在启用列表里」不等于「真的绑上了」（装包后服务进 Crashed services
        // 就是这种：列表里有、实际没连上），所以还要 isConnected()。
        if (accessibilityHealthy(context)) return true;

        if (!LockController.isDeviceOwner(context)) {
            EventLog.warn("无障碍看门狗已被关闭，且本机不是设备所有者，无法尝试远程开启");
            return false;
        }
        android.app.admin.DevicePolicyManager dpm =
                (android.app.admin.DevicePolicyManager)
                        context.getSystemService(Context.DEVICE_POLICY_SERVICE);
        if (dpm == null) return false;

        String current = Settings.Secure.getString(
                context.getContentResolver(), Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES);
        String merged = (current == null || current.isEmpty()) ? ours : current + ":" + ours;
        try {
            dpm.setSecureSetting(LockController.adminComponent(context),
                    Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES, merged);
            dpm.setSecureSetting(LockController.adminComponent(context),
                    Settings.Secure.ACCESSIBILITY_ENABLED, "1");
        } catch (Exception e) {
            EventLog.warn("设备所有者无法重开无障碍看门狗（系统 key 白名单不含无障碍设置）："
                    + e.getMessage());
            return false;
        }

        boolean ok = waitForAccessibility(context, 2_000L);
        if (ok) {
            EventLog.success("设备所有者已把无障碍看门狗重新写回系统设置");
        } else {
            EventLog.warn("设备所有者写无障碍设置后回读仍是未启用：这条路在 Android 13 上走不通");
        }
        return ok;
    }

    /**
     * 权威判据：系统认为无障碍服务已启用 <b>且</b> 本进程真的绑上了它。
     *
     * <p>只看其中一个都会给出假结论：只看设置列表 → 总开关关掉时误报「已恢复」；
     * 只看 {@link LockWatchdogService#isConnected()} → 服务和系统设置不一致时误报缺口。
     */
    private static boolean accessibilityHealthy(Context context) {
        return LockWatchdogService.isEnabledInSettings(context) && LockWatchdogService.isConnected();
    }

    /**
     * 轮询等待无障碍恢复：每 200ms 一次，最多 {@code timeoutMs}。
     *
     * <p>刻意<b>不</b>在写完设置后立刻回读：系统重新绑定无障碍服务有延迟，
     * 立刻读必然得到假阴性（写成功了也报失败）。
     */
    private static boolean waitForAccessibility(Context context, long timeoutMs) {
        long deadline = SystemClock.uptimeMillis() + timeoutMs;
        while (true) {
            if (accessibilityHealthy(context)) return true;
            if (SystemClock.uptimeMillis() >= deadline) return false;
            try {
                Thread.sleep(200L);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                return false;
            }
        }
    }

    // ------------------------------------------------------------ 巡检

    /**
     * 只读巡检：列出当前所有「能让孩子绕过管控」的缺口。
     *
     * <p>每一条都是人话，直接可展示给家长。
     */
    public static List<String> problems(Context context, AgentStore store) {
        List<String> problems = new ArrayList<>();
        if (!LockController.isDeviceOwner(context)) {
            problems.add("设备所有者已被撤销：防卸载、防强停全部失效，孩子可直接卸载本应用");
        }
        if (!LockController.isAdminActive(context)) {
            problems.add("设备管理器未激活：锁屏能力降级到悬浮窗");
        }
        if (!LockController.canDrawOverlays(context)) {
            problems.add("悬浮窗权限已关闭：锁定页只能靠无障碍看门狗拉回，按返回键有概率逃出");
        }
        if (!LockWatchdogService.isEnabledInSettings(context)) {
            problems.add("无障碍看门狗已被关闭：孩子可下拉通知栏、进设置、按最近任务绕过锁定");
        }
        if (!isIgnoringBatteryOptimizations(context)) {
            problems.add("未加入电池优化白名单：息屏后可能被 Doze 冻结，心跳与指令会延迟");
        }
        // 判据用 isWanted()（开关开着<b>且</b>黑名单非空）而不是光看开关：
        // 黑名单为空时本来就不会建 VPN，那种情况报缺口是假警报。
        if (DnsFilterVpnService.isWanted(context) && !DnsFilterVpnService.hasSystemConsent(context)) {
            problems.add("网址拦截的 VPN 授权已被撤销：DNS 拦截已停");
        }
        // 永久 VPN 绑定只查「还在不在」：少了它，孩子从快捷开关一划就能断掉网址拦截。
        if (DnsFilterVpnService.isWanted(context) && !DnsFilterVpnService.isAlwaysOn(context)) {
            problems.add("网址拦截未设为「永久 VPN」：孩子可从快捷开关断开（每次自愈会重新绑定）");
        }
        // 「使用情况访问」是 appop，设备所有者代授在 Android 13 上被系统拒绝（见
        // PermissionGranter 的实测注释），所以只能检测 + 上报。
        // 刻意只在「家长真的在用需要它的功能」时才报：没配限额却报这条是假警报。
        if (!AppUsageTracker.hasPermission(context)
                && (store.isTimePlanEnabled() || !store.getAppLimitRules().isEmpty())) {
            problems.add("「使用情况访问」权限已被关闭：逐应用限时与今日时长统计不会生效，"
                    + "请在系统设置 → 应用 → 特殊应用权限 → 使用情况访问里重新开启");
        }
        if (store.isHardeningEnabled() && LockController.isDeviceOwner(context)) {
            for (OwnerHardening.Item item : OwnerHardening.audit(context)) {
                if (!item.supported || item.applied) continue;
                // 「禁止安装应用」不在此列：它由「应用审核」特性动态开合
                // （家长批准安装后要临时放开 30 分钟），关着是正常状态而不是被篡改。
                // 不排除的话每 5 分钟就会给家长发一条假的「管控被改动」。
                if ("no_install_apps".equals(item.id)) continue;
                // detail 为空时不要拼出「禁止修改语言/区域（）」这种给人看的怪句子
                String detail = item.detail == null || item.detail.isEmpty()
                        ? "" : "（" + item.detail + "）";
                problems.add("加固项未生效：" + item.label + detail);
            }
        }
        return problems;
    }

    /** 界面上直接铺开显示的长活状态。 */
    public static String describe(Context context, AgentStore store) {
        StringBuilder sb = new StringBuilder();
        sb.append("守护服务：").append(AgentService.isRunning() ? "运行中" : "未运行");
        sb.append('\n').append(isIgnoringBatteryOptimizations(context)
                ? "电池优化：已加入白名单" : "电池优化：未加入白名单（息屏后可能被冻结）");
        sb.append('\n').append("无障碍看门狗：")
                .append(LockWatchdogService.isEnabledInSettings(context) ? "已启用" : "未启用");
        sb.append('\n').append("受保护包（禁止强停/清数据）：")
                .append(OwnerHardening.hasProtectedPackage(context) ? "已生效" : "未生效");
        List<String> problems = problems(context, store);
        if (problems.isEmpty()) {
            sb.append('\n').append("巡检：未发现缺口");
        } else {
            for (String problem : problems) {
                sb.append('\n').append("⚠ ").append(problem);
            }
        }
        return sb.toString();
    }

    /**
     * 完整自愈：重新施加加固 + 补授权 + 重排双看门狗 + 巡检上报。
     *
     * <p><b>幂等</b>，可以在服务启动、开机、家长点「自检」时随便调。
     * 有耗时（几十次 binder 调用 + 可能的网络上报），应在后台线程调用。
     *
     * @return 一句人话总结，供界面/日志使用
     */
    public static String selfHeal(Context context, AgentStore store, String reason) {
        List<String> actions = new ArrayList<>();

        if (store.isHardeningEnabled()) {
            List<OwnerHardening.Item> items = OwnerHardening.apply(context);
            OwnerHardening.logReport(items, reason);
            actions.add("加固 " + OwnerHardening.summary(items));
        } else {
            actions.add("加固开关已关闭，跳过");
        }

        int runtime = PermissionGranter.grantAsDeviceOwner(context);
        if (runtime > 0) actions.add("补授 " + runtime + " 项运行时权限");
        int special = PermissionGranter.grantSpecialAsDeviceOwner(context);
        if (special > 0) actions.add("补授 " + special + " 项特殊权限");

        // 无障碍看门狗被孩子关掉时，尽一切可能把它拉回来（实测结论见方法注释）
        if (!LockWatchdogService.isEnabledInSettings(context)
                && tryReEnableAccessibility(context)) {
            actions.add("已重开无障碍看门狗");
        }

        // 网址拦截的「永久 VPN」绑定：孩子从快捷开关断不掉，每次自愈都重新确认一次
        DnsFilterVpnService.applyAlwaysOn(context);

        WatchdogScheduler.scheduleWatchdog(context);
        actions.add("重排双看门狗");

        List<String> problems = problems(context, store);
        report(context, problems, reason);
        lastHealAt = System.currentTimeMillis();

        String summary = TextUtils.join("；", actions)
                + (problems.isEmpty() ? "；巡检无缺口" : "；仍有 " + problems.size() + " 项缺口");
        EventLog.info(TAG + "自愈（" + reason + "）：" + summary);
        return summary;
    }

    /**
     * 周期巡检 + <b>发现缺口就当场自愈</b>：由守护服务的 1 秒心跳调用，
     * 内部按 {@link #HEAL_INTERVAL_MS} 限频。
     *
     * <p>刻意放在心跳里而不是只靠闹钟：闹钟在 Doze 下可能被推迟到 15 分钟以上，
     * 而进程只要活着，心跳就一定会走到这里。
     *
     * <p><b>为什么不是「只上报、等下次服务重启再修」</b>：孩子关掉无障碍服务、撤销
     * VPN/使用情况访问授权这类动作发生在会话中途，而进程可能几天都不重启一次 ——
     * 那时「只上报」就等于「知道漏了却不补」。所以这里<b>只在有缺口时</b>调
     * {@link #selfHeal}（健康时只做只读巡检，几乎不耗电），而 selfHeal 本身是幂等的、
     * 且每一条都是「先读当前值，等于目标值就短路」，重复调用不会反复写系统设置。
     *
     * <p>自愈有几十次 binder 调用，因此丢进一个短命后台线程，不阻塞 1 秒锁定 ticker。
     */
    public static void tick(Context context, AgentStore store, long now) {
        if (now - lastHealAt < HEAL_INTERVAL_MS) return;
        lastHealAt = now;
        List<String> problems = problems(context, store);
        if (problems.isEmpty()) {
            report(context, problems, "周期巡检");
            return;
        }
        EventLog.warn(TAG + "周期巡检发现 " + problems.size() + " 项缺口，不再只上报，立即自愈");
        Context app = context.getApplicationContext() != null
                ? context.getApplicationContext() : context;
        Thread heal = new Thread(
                () -> selfHeal(app, store, "周期巡检发现缺口"),
                "balloon-guard-tick-heal");
        heal.setDaemon(true);
        heal.start();
    }

    /**
     * 上报巡检结果。
     *
     * <p>语义是<b>集合差分</b>而不是「整串签名变了就发」：算出这次「新增了哪些缺口」
     * 与「修好了哪些缺口」，各发一条，避免每 5 分钟给家长端刷一样的告警。
     *
     * <p>为什么不用整串签名：设备上天然存在修不掉的缺口（电池优化白名单必须家长
     * 点系统框），只要它在，整串签名永远非空 —— 孩子关掉无障碍再打开，
     * 「已恢复正常」那条就会被那条永久缺口盖掉，家长端看不到恢复。
     *
     * <p>{@code synchronized}：{@link #selfHeal} 可从「服务启动」「心跳自愈线程」
     * 「家长手动自检」三处并发进入，同时 {@code lastProblems} 是静态的，
     * 不加锁会出现「58 毫秒内两条内容不同的缺口集合各自上报」这种自相矛盾的动态。
     */
    private static synchronized void report(Context context, List<String> problems, String reason) {
        List<String> previous = lastProblems;
        if (previous == null) {
            // 进程启动后的第一次巡检：只建立基线，措辞用「自检结果」而不是「被改动」，
            // 因为此刻并不知道这些缺口是刚出现的还是一直都在。
            lastProblems = new ArrayList<>(problems);
            lastProblemSignature = TextUtils.join("|", problems);
            if (problems.isEmpty()) {
                EventLog.success(TAG + "自检（" + reason + "）：未发现缺口");
                AgentService.recordEventStatic(Constants.EVENT_TAMPER,
                        "管控自检通过：所有加固项与看门狗都在生效");
            } else {
                for (String problem : problems) {
                    EventLog.warn(TAG + "缺口：" + problem);
                }
                AgentService.recordEventStatic(Constants.EVENT_TAMPER,
                        "管控自检发现 " + problems.size() + " 项缺口：" + TextUtils.join("；", problems));
            }
            return;
        }

        List<String> added = new ArrayList<>();
        List<String> fixed = new ArrayList<>();
        for (String problem : problems) {
            if (!previous.contains(problem)) added.add(problem);
        }
        for (String problem : previous) {
            if (!problems.contains(problem)) fixed.add(problem);
        }
        if (added.isEmpty() && fixed.isEmpty()) return;
        lastProblems = new ArrayList<>(problems);
        lastProblemSignature = TextUtils.join("|", problems);

        if (!fixed.isEmpty()) {
            EventLog.success(TAG + "已恢复（" + reason + "）：" + TextUtils.join("；", fixed));
            AgentService.recordEventStatic(Constants.EVENT_TAMPER,
                    "管控已恢复正常：" + TextUtils.join("；", fixed));
        }
        if (!added.isEmpty()) {
            for (String problem : added) {
                EventLog.warn(TAG + "新增缺口：" + problem);
            }
            AgentService.recordEventStatic(Constants.EVENT_TAMPER,
                    "检测到管控被改动：" + TextUtils.join("；", added));
        }
    }

    /** 设备所有者是否把本应用标成了「受保护包」（长活最关键的一条）。 */
    public static boolean protectedPackageActive(Context context) {
        return OwnerHardening.hasProtectedPackage(context);
    }

    /** 当前是否一切正常（供自检页与断言使用）。 */
    public static boolean allGood(Context context, AgentStore store) {
        return problems(context, store).isEmpty();
    }
}
