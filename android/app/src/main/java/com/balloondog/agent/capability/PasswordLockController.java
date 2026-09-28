package com.balloondog.agent.capability;

import android.app.admin.DevicePolicyManager;
import android.content.Context;
import android.os.Build;
import android.util.Base64;

import com.balloondog.agent.data.AgentStore;
import com.balloondog.agent.data.EventLog;

import java.security.SecureRandom;

import javax.crypto.SecretKeyFactory;
import javax.crypto.spec.PBEKeySpec;

/**
 * 最高强度档：锁定瞬间把<b>系统锁屏密码</b>改成随机值。
 *
 * <h3>为什么这一档很危险，以及本类怎么兜住</h3>
 * 改了系统锁屏密码，就意味着连系统锁屏都进不去 —— 孩子彻底用不了手机。
 * 但如果家长端拿不到解锁指令（断网、后端挂了、手机没信号），
 * <b>手机就永久锁死了，连紧急电话都打不出去</b>。这是不可接受的失败模式，
 * 所以本类强制三条安全阀，缺一不可：
 *
 * <ol>
 *   <li><b>必须先设置本机应急密码</b>（{@link #hasEmergencyPassword}）。
 *       没有应急密码时 {@link #engage} 直接拒绝执行，由调用方降级为 Kiosk。
 *       应急密码只存在本机、绝不上传服务端 —— 它的用途正是「服务端不可用时」。</li>
 *   <li><b>重启后自动清除随机密码</b>（默认开，见 {@link AgentStore#isRebootClearsPassword()}）。
 *       这里是有意的取舍：孩子重启一次确实能短暂拿回手机，但 Agent 的开机自启会立刻
 *       按策略重新锁上；而家长在断网时至少有一条确定的复位路径。</li>
 *   <li>锁屏页始终保留「应急密码解锁」入口，不需要网络。</li>
 * </ol>
 *
 * <h3>技术前提</h3>
 * 只有<b>设备所有者</b>且系统 API ≥ 26 才能做到。Android 8.0 起 {@code resetPassword}
 * 对已有密码的设备不再可用，必须先用 {@code setResetPasswordToken} 预置一个重置令牌，
 * 之后才能随时用 {@code resetPasswordWithToken} 改写密码 —— 本类在首次启用时
 * 就把令牌一次性装好并保存到本机。
 */
public final class PasswordLockController {

    /** resetPasswordWithToken 需要的令牌长度（官方建议 32 字节熵）。 */
    private static final int TOKEN_BYTES = 32;
    /** 随机锁屏密码位数。6 位数字足够挡住孩子，又不至于让家长手输困难。 */
    private static final int PASSWORD_DIGITS = 6;
    private static final int PBKDF2_ITERATIONS = 10_000;
    private static final int PBKDF2_KEY_BITS = 256;

    private static final SecureRandom RANDOM = new SecureRandom();

    private PasswordLockController() {
    }

    /** 本机是否具备「随机改写锁屏密码」的能力。 */
    public static boolean isSupported(Context context) {
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                && LockController.isDeviceOwner(context);
    }

    // ============================================================
    // 应急密码（只存本机）
    // ============================================================

    /** 家长在本机设置应急解锁密码。 */
    public static void setEmergencyPassword(Context context, AgentStore store, String plain) {
        byte[] salt = new byte[16];
        RANDOM.nextBytes(salt);
        String hash = hashPassword(plain, salt);
        store.setEmergencyPasswordHash(Base64.encodeToString(salt, Base64.NO_WRAP) + ":" + hash);
        EventLog.success("应急解锁密码已设置（仅保存在本机）");
    }

    public static boolean hasEmergencyPassword(AgentStore store) {
        return store.hasEmergencyPassword();
    }

    /** 校验用户输入的应急密码。 */
    public static boolean verifyEmergencyPassword(AgentStore store, String input) {
        String stored = store.getEmergencyPasswordHash();
        if (stored == null || !stored.contains(":")) return false;
        String[] parts = stored.split(":", 2);
        try {
            byte[] salt = Base64.decode(parts[0], Base64.NO_WRAP);
            String candidate = hashPassword(input, salt);
            // 定长比较，避免时序侧信道（本地场景风险很低，但成本也就一行）
            return constantTimeEquals(candidate, parts[1]);
        } catch (IllegalArgumentException e) {
            return false;
        }
    }

    private static String hashPassword(String plain, byte[] salt) {
        try {
            PBEKeySpec spec = new PBEKeySpec(plain.toCharArray(), salt, PBKDF2_ITERATIONS, PBKDF2_KEY_BITS);
            SecretKeyFactory factory = SecretKeyFactory.getInstance("PBKDF2WithHmacSHA1");
            byte[] key = factory.generateSecret(spec).getEncoded();
            spec.clearPassword();
            return Base64.encodeToString(key, Base64.NO_WRAP);
        } catch (Exception e) {
            // PBKDF2WithHmacSHA1 在 Android 上一定存在；真出错时退回 SHA-256，
            // 仍然比明文好，且不会让「设置应急密码」这条路径直接失败
            try {
                java.security.MessageDigest digest = java.security.MessageDigest.getInstance("SHA-256");
                digest.update(salt);
                digest.update(plain.getBytes(java.nio.charset.StandardCharsets.UTF_8));
                return Base64.encodeToString(digest.digest(), Base64.NO_WRAP);
            } catch (Exception inner) {
                return Base64.encodeToString(plain.getBytes(java.nio.charset.StandardCharsets.UTF_8),
                        Base64.NO_WRAP);
            }
        }
    }

    private static boolean constantTimeEquals(String a, String b) {
        byte[] x = a.getBytes(java.nio.charset.StandardCharsets.UTF_8);
        byte[] y = b.getBytes(java.nio.charset.StandardCharsets.UTF_8);
        return java.security.MessageDigest.isEqual(x, y);
    }

    // ============================================================
    // 重置令牌
    // ============================================================

    /**
     * 首次启用时预置重置令牌。
     *
     * <p>这是 Android 8.0 起的硬性要求：没有预置令牌，之后就无法改写已有密码。
     * 所以必须在「家长还拿着手机、能正常操作」的时候把它装好。
     */
    public static boolean ensureResetToken(Context context, AgentStore store) {
        if (!isSupported(context)) return false;
        if (store.getResetToken() != null) return true;

        byte[] token = new byte[TOKEN_BYTES];
        RANDOM.nextBytes(token);
        DevicePolicyManager dpm =
                (DevicePolicyManager) context.getSystemService(Context.DEVICE_POLICY_SERVICE);
        if (dpm == null) return false;
        try {
            dpm.setResetPasswordToken(LockController.adminComponent(context), token);
            store.setResetToken(Base64.encodeToString(token, Base64.NO_WRAP));
            EventLog.success("已预置锁屏密码重置令牌");
            return true;
        } catch (SecurityException e) {
            EventLog.error("预置重置令牌失败：" + e.getMessage());
            return false;
        }
    }

    // ============================================================
    // 锁定 / 解锁
    // ============================================================

    /**
     * 把系统锁屏密码改成随机值并立即锁屏。
     *
     * @return 本次生成的密码；失败返回 null（调用方应降级为 Kiosk 并如实告知家长）
     */
    public static String engage(Context context, AgentStore store) {
        if (!isSupported(context)) {
            EventLog.warn("本机不支持随机改写锁屏密码，降级为 Kiosk 锁定");
            return null;
        }
        // 安全阀 1：没有应急密码就绝不改系统密码，否则可能把设备永久锁死
        if (!hasEmergencyPassword(store)) {
            EventLog.error("尚未设置应急解锁密码，拒绝启用「随机锁屏密码」档，已降级为 Kiosk");
            return null;
        }
        if (!ensureResetToken(context, store)) {
            return null;
        }

        String password = randomPin();
        DevicePolicyManager dpm =
                (DevicePolicyManager) context.getSystemService(Context.DEVICE_POLICY_SERVICE);
        if (dpm == null) return null;

        try {
            byte[] token = Base64.decode(store.getResetToken(), Base64.NO_WRAP);
            dpm.resetPasswordWithToken(LockController.adminComponent(context), password, token, 0);
            store.setCurrentRandomPassword(password);
            EventLog.warn("已把系统锁屏密码改为随机值并锁屏（家长可在本机或远程解锁）");
            return password;
        } catch (SecurityException | IllegalArgumentException e) {
            EventLog.error("改写锁屏密码失败：" + e.getMessage());
            return null;
        }
    }

    /**
     * 清除随机密码，让设备重新可用。
     *
     * <p>远程解锁 / 应急密码解锁 / 开机复位都走这里。
     * 清除后设备变成「无锁屏密码」，这是刻意的：宁可短暂降低系统安全性，
     * 也不能出现「家长拿不回自己孩子手机」的局面。
     */
    public static boolean disengage(Context context, AgentStore store) {
        if (!isSupported(context)) return false;
        DevicePolicyManager dpm =
                (DevicePolicyManager) context.getSystemService(Context.DEVICE_POLICY_SERVICE);
        if (dpm == null) return false;

        boolean cleared = false;
        String tokenValue = store.getResetToken();
        if (tokenValue != null) {
            try {
                byte[] token = Base64.decode(tokenValue, Base64.NO_WRAP);
                // password 传 null 表示清除密码
                dpm.resetPasswordWithToken(LockController.adminComponent(context), null, token, 0);
                cleared = true;
            } catch (SecurityException | IllegalArgumentException e) {
                EventLog.warn("用令牌清除锁屏密码失败，改用兼容方式：" + e.getMessage());
            }
        }
        if (!cleared) {
            try {
                @SuppressWarnings("deprecation")
                boolean ok = dpm.resetPassword("", 0);
                cleared = ok;
            } catch (SecurityException e) {
                EventLog.error("清除锁屏密码失败：" + e.getMessage());
            }
        }

        if (cleared) {
            store.setCurrentRandomPassword(null);
            EventLog.success("已清除随机锁屏密码，设备恢复可用");
        }
        return cleared;
    }

    /** 当前是否处于「随机密码已生效」状态。 */
    public static boolean isEngaged(AgentStore store) {
        String password = store.getCurrentRandomPassword();
        return password != null && !password.isEmpty();
    }

    /** 生成 6 位随机数字密码（首位不为 0，避免被系统当成无效长度处理）。 */
    private static String randomPin() {
        StringBuilder sb = new StringBuilder(PASSWORD_DIGITS);
        sb.append(1 + RANDOM.nextInt(9));
        for (int i = 1; i < PASSWORD_DIGITS; i++) {
            sb.append(RANDOM.nextInt(10));
        }
        return sb.toString();
    }

    /** 供界面展示当前随机密码（家长用应急密码进入本应用后能看到）。 */
    public static String describeState(AgentStore store) {
        if (!isEngaged(store)) return "未启用（系统锁屏密码未被修改）";
        return "已启用：当前系统锁屏密码为 " + store.getCurrentRandomPassword()
                + "（可用本机应急密码或家长端远程解锁）";
    }
}
