package com.balloondog.agent.capability;

import android.content.Context;

import androidx.annotation.Nullable;

import com.balloondog.agent.data.AgentStore;
import com.balloondog.agent.data.EventLog;
import com.balloondog.agent.model.ScheduleRule;
import com.balloondog.agent.ui.CountdownOverlay;
import com.balloondog.agent.ui.LockOverlayWindow;
import com.balloondog.agent.ui.LockScreenActivity;

import org.json.JSONArray;

import java.util.List;

/**
 * 把 {@link LockState} 的判定结果<b>落地</b>成设备上的实际行为。
 *
 * <p>判定与执行刻意分成两个类：
 * <ul>
 *   <li>{@link LockState} 是纯函数，只回答「该不该锁」，不碰任何系统 API；</li>
 *   <li>本类负责「怎么锁」—— 走 Kiosk 还是随机密码、要不要禁状态栏、什么时候弹倒计时悬浮窗。</li>
 * </ul>
 * 这样锁定策略可以单独推理和测试，而执行细节集中在一处，不会散落到服务与界面里各写一遍。
 *
 * <p>{@link #buildInputs} 是服务端状态到判定输入的<b>唯一</b>转换点：
 * {@code AgentService} 每秒调它一次，{@code LockScreenActivity} 也调它一次来自救
 * （服务被杀时锁定页仍要能自行判断该不该解锁，否则孩子会被永久困在锁定页上）。
 */
public final class LockEnforcer {

    /** 上一次已落地的状态，用于识别「状态翻转」而不是每次都重复执行副作用。 */
    private boolean lastLocked;
    private boolean lastCountdownVisible;
    private boolean passwordEngaged;
    private boolean statusBarDisabled;
    /** 上一次实际生效的强度，用于检测「锁定期间家长改了强度」 */
    private String lastAppliedStrength;

    // ============================================================
    // 输入构造
    // ============================================================

    /**
     * 从本地持久化状态拼出判定输入。
     *
     * <p>刻意<b>只读本地</b>、不访问网络：锁屏必须在断网时照常工作。
     * 服务端下发的策略已经在 {@code applyConfig} 时落盘了。
     */
    public static LockState.Inputs buildInputs(AgentStore store, long now) {
        LockState.Inputs in = new LockState.Inputs();
        in.now = now;
        in.remoteLocked = store.isLocked();
        in.grantUntil = store.anyGrantUntil();
        in.scheduleEnabled = store.isScheduleEnabled();
        in.rules = parseRules(store.getScheduleJson());
        in.countdownSeconds = store.getCountdownSeconds();

        // 护眼锁定：强制休息（固定截止时刻）与夜间护眼（每秒按当前小时判定）。
        // 由 EyeCareController 统一算好原因文案，这里只负责搬进 Inputs ——
        // 放在这里而不是 LockState 里，是因为 LockState 应当保持纯函数、不碰 SharedPreferences。
        try {
            Object[] eyeLock = EyeCareController.currentLock(store, now);
            if (eyeLock != null) {
                in.eyeLockReason = (String) eyeLock[0];
                in.eyeLockUntil = (Long) eyeLock[1];
            }
        } catch (Exception ignored) {
            // 护眼判定失败绝不能影响主锁定链路
        }

        // 局数 / 集数预算：服务端算好的权威计数，设备端只负责执行（离线也拦得住）
        try {
            in.budgetLockReason = budgetLockReason(store);
        } catch (Exception ignored) {
            // 预算判定失败绝不能影响主锁定链路
        }

        // 每日额度：按 1:1 实时消耗推算耗尽时刻，与 tickUsage 的记账口径保持一致
        if (store.isTimePlanEnabled()) {
            int limitMinutes = store.getDailyLimitMinutes();
            if (limitMinutes > 0) {
                long usedSeconds = store.getUsageSecondsToday();
                long limitSeconds = limitMinutes * 60L;
                in.dailyLimitExhausted = usedSeconds >= limitSeconds;
                if (!in.dailyLimitExhausted) {
                    in.dailyLimitAt = now + (limitSeconds - usedSeconds) * 1000L;
                }
            }
        }
        return in;
    }

    /**
     * 预算耗尽的原因文案；没超就返回 null。
     *
     * <p>只有「家长开启了该项且用量已达上限」才算数。{@code limit <= 0} 一律视为不限 ——
     * 否则一个手滑设成 0 的配置会把孩子手机直接锁死，而家长根本不知道发生了什么。
     */
    @Nullable
    private static String budgetLockReason(AgentStore store) {
        if (store.isGameRoundsLimited()) {
            int limit = store.getGameRoundsLimit();
            int used = store.getGameRoundsUsed();
            if (limit > 0 && used >= limit) {
                return "今日游戏局数已用完（" + used + "/" + limit + " 局）";
            }
        }
        if (store.isVideoEpisodesLimited()) {
            int limit = store.getVideoEpisodesLimit();
            int used = store.getVideoEpisodesUsed();
            if (limit > 0 && used >= limit) {
                return "今日动画集数已看完（" + used + "/" + limit + " 集）";
            }
        }
        return null;
    }

    private static List<ScheduleRule> parseRules(String json) {
        try {
            return ScheduleRule.listFrom(new JSONArray(json == null || json.isEmpty() ? "[]" : json));
        } catch (Exception e) {
            // 配置损坏时按「没有时间表」处理，绝不因为一段坏 JSON 就让设备永远锁着
            EventLog.warn("时间表配置解析失败，本次按无时间表处理：" + e.getMessage());
            return java.util.Collections.emptyList();
        }
    }

    // ============================================================
    // 落地
    // ============================================================

    /**
     * 应用一次判定结果。
     *
     * @param quizEnabled 是否显示「答题解锁」入口（家长开启答题解锁时才有意义）
     * @return 本次是否发生了状态翻转
     */
    public boolean apply(Context context, AgentStore store, LockState state, boolean quizEnabled) {
        boolean changed = false;

        // ---- 倒计时预告悬浮窗（需求 4）----
        if (state.countdownActive && !state.locked) {
            // 用「下一次锁定的原因」而不是当前原因：倒计时发生在锁定之前，
            // state.detail 此刻本来就是空的，直接用会导致预告只剩一句「还有 xx 秒」
            boolean ok = CountdownOverlay.show(context, state.countdownRemainingSeconds,
                    state.nextLockReason != null ? state.nextLockReason : state.detail, quizEnabled);
            if (!ok) {
                EventLog.warn("倒计时预告未能显示：缺少「在其他应用上层显示」权限");
            }
            lastCountdownVisible = true;
        } else if (lastCountdownVisible) {
            CountdownOverlay.hide();
            lastCountdownVisible = false;
        }

        // ---- 锁定 / 解锁 ----
        if (state.locked && !lastLocked) {
            enterLock(context, store, state, quizEnabled);
            lastLocked = true;
            changed = true;
        } else if (!state.locked && lastLocked) {
            exitLock(context, store);
            lastLocked = false;
            changed = true;
        } else if (state.locked) {
            // 已经锁着，但家长可能刚刚改了锁屏强度（例如从 Kiosk 切到「随机密码」）。
            // 不重新应用的话，家长以为已经升级到最高强度，设备其实还停在旧档位上 ——
            // 这正是需求 2 最不能容忍的那种静默失效。
            String effective = LockCapability.effectiveStrength(context, store.getLockStrength());
            if (lastAppliedStrength != null && !lastAppliedStrength.equals(effective)) {
                EventLog.warn("锁定强度已变更（" + lastAppliedStrength + " → " + effective
                        + "），正在对已锁定的设备重新应用");
                // 从最高强度档降下来时，要先把被改写的系统锁屏密码还原，
                // 否则设备会一直停留在「进不去」的状态
                if ("password".equals(lastAppliedStrength) && passwordEngaged) {
                    PasswordLockController.disengage(context, store);
                    passwordEngaged = false;
                }
                enterLock(context, store, state, quizEnabled);
                changed = true;
            }
        }
        return changed;
    }

    /** 进入锁定。 */
    private void enterLock(Context context, AgentStore store, LockState state, boolean quizEnabled) {
        CountdownOverlay.hide();
        lastCountdownVisible = false;
        EventLog.warn("进入锁定：" + state.describe());
        com.balloondog.agent.service.AgentService.recordEventStatic(
                com.balloondog.agent.data.Constants.EVENT_LOCK,
                state.detail == null ? "设备已锁定" : "设备已锁定（" + state.detail + "）");

        // 1) 最强防护：禁卸载 / 禁强行停止 / 禁恢复出厂 / 禁安全模式（需求 1）
        if (store.isHardeningEnabled()) {
            OwnerHardening.apply(context);
            // 顺手把运行时权限重新授一次：设备所有者可以静默自授。
            // 每次进入锁定都做，是为了让「孩子在系统设置里把权限关掉」这个绕过手段失效 ——
            // 否则关掉定位权限就能让安全区彻底失灵，而家长端只会看到「设备一直没有位置」。
            PermissionGranter.grantAsDeviceOwner(context);
        }

        // 2) 期望强度 → 本机实际能做到的强度，并如实记录降级
        String requested = store.getLockStrength();
        String effective = LockCapability.effectiveStrength(context, requested);
        String degrade = LockCapability.degradeReason(context, requested);
        if (degrade != null) {
            EventLog.warn("锁屏强度降级：" + degrade);
        }

        // 3) 最高强度档：把系统锁屏密码改成随机值
        if ("password".equals(effective)) {
            String pin = PasswordLockController.engage(context, store);
            if (pin == null) {
                // engage 已经写明了拒绝原因（多半是没设应急密码）
                effective = "kiosk";
                EventLog.warn("随机密码档不可用，本次按 Kiosk 锁定执行");
            } else {
                passwordEngaged = true;
            }
        }

        // 4) 选锁定手段 —— 这是「能不能被绕过」的分水岭
        boolean owner = LockCapability.detect(context) == LockCapability.Tier.OWNER;
        if (owner) {
            // 设备所有者：Lock Task。系统级，连通知栏和电源菜单都禁掉，没有任何绕法。
            // 白名单必须在 startLockTask 之前设好，否则只会进「屏幕固定」
            KioskController.prepare(context);
        }

        // 5) 锁定期间禁掉状态栏：只有设备所有者做得到，
        //    做不到时会返回 false，由 LockOverlayWindow 的文案如实说明「通知栏仍可下拉」
        statusBarDisabled = LockController.setStatusBarDisabled(context, true);

        // 6) 关闭屏幕；孩子再打开时看到的应该是我们的锁定界面
        LockController.lockNow(context);

        // 7) 挂上锁定界面
        showLockUi(context, store, state);
        lastAppliedStrength = effective;
    }

    /**
     * 把锁定界面挂到最前 —— <b>锁定手段的唯一选择点</b>。
     *
     * <p>{@code LockEnforcer}（状态变化时）与 {@link com.balloondog.agent.service.LockWatchdogService}
     * （锁定界面被抢走时）都调这里。放在一处是有意的：
     * 两边各写一遍「什么时候用 kiosk、什么时候用悬浮窗」迟早会不一致。
     */
    public static void showLockUi(Context context, AgentStore store, LockState state) {
        boolean quizEnabled = store.isQuizEnabled();
        boolean emergency = PasswordLockController.hasEmergencyPassword(store);

        if (LockCapability.detect(context) == LockCapability.Tier.OWNER) {
            // 设备所有者：Lock Task 是系统级的，没有绕法
            LockOverlayWindow.hide();
            LockScreenActivity.show(context, state.detail, null);
            return;
        }

        // 非设备所有者：全屏悬浮窗是「按 Home 也切不走」的唯一选择
        if (LockOverlayWindow.canShow(context)) {
            LockOverlayWindow.show(context, state.detail, describeOverlayStrength(context),
                    quizEnabled, emergency);
            return;
        }

        // 悬浮窗权限被撤销了：只能退回 Activity。它挡不住 Home，
        // 但看门狗会不断把它拉回来，逃逸窗口因此被压到几百毫秒。
        EventLog.warn("悬浮窗权限已失效，退回锁定页（依赖无障碍看门狗持续拉回）");
        LockScreenActivity.show(context, state.detail, null);
    }

    /** 悬浮窗锁定档的能力说明：只承诺做得到的，并写清做不到的。 */
    private static String describeOverlayStrength(Context context) {
        if (LockController.setStatusBarDisabled(context, true)) {
            return "全屏悬浮窗锁定：按 Home 与最近任务都切不走，通知栏也已禁用";
        }
        if (com.balloondog.agent.ui.LockWatchdogBridge.isAccessibilityAvailable()) {
            return "全屏悬浮窗锁定：按 Home / 最近任务切不走，通知栏也无法盖住本界面";
        }
        return "全屏悬浮窗锁定：按 Home 键与最近任务都切不走；"
                + "但通知栏仍可下拉（开启无障碍看门狗即可堵住）";
    }

    /** 解除锁定。远程解锁 / 临时解锁 / 答题奖励 / 作息放行都汇聚到这里。 */
    private void exitLock(Context context, AgentStore store) {
        EventLog.success("解除锁定");
        com.balloondog.agent.service.AgentService.recordEventStatic(
                com.balloondog.agent.data.Constants.EVENT_UNLOCK, "设备已解锁");

        // 解除最高强度档：把系统锁屏密码清掉，让设备重新可用
        if (passwordEngaged || PasswordLockController.isEngaged(store)) {
            PasswordLockController.disengage(context, store);
            passwordEngaged = false;
        }

        if (statusBarDisabled) {
            LockController.setStatusBarDisabled(context, false);
            statusBarDisabled = false;
        }

        // 收起锁定页与遮罩（LockScreenActivity 会在结束时自己 stopLockTask）
        LockScreenActivity.dismiss(context);
        LockOverlayWindow.hide();
        CountdownOverlay.hide();
        lastCountdownVisible = false;
        LockController.unlock(context);
        lastAppliedStrength = null;
    }

    /**
     * 服务停止 / 家长关闭守护时，把本类施加过的所有副作用收干净。
     *
     * <p>刻意不解除「最强防护」的用户限制：那是家长显式开启的长期策略，
     * 不该因为服务重启就失效（否则孩子重启一次手机就能卸载了）。
     */
    public void releaseAll(Context context, AgentStore store) {
        exitLock(context, store);
    }

    /** 当前是否已把系统锁屏密码改成随机值。 */
    public boolean isPasswordEngaged() {
        return passwordEngaged;
    }

    public boolean isLocked() {
        return lastLocked;
    }

    @Nullable
    public static String describeStrength(Context context, AgentStore store) {
        String requested = store.getLockStrength();
        return LockCapability.describeEffective(context, requested);
    }
}
