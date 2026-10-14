package com.balloondog.agent.capability;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

import com.balloondog.agent.data.EventLog;
import com.balloondog.agent.ui.MainActivity;

/**
 * 隐藏桌面图标之后的「家长入口」：在系统拨号盘输入 {@code *#*#2887#*#*} 打开主界面。
 *
 * <p>为什么需要它：{@link IconHider} 一旦禁用 {@code MainActivityLauncher} 这个
 * activity-alias，设备本机上就再也没有任何可见入口。家长要给自己的手机做绑定、
 * 自检或改后端地址时，如果只能靠 adb 就太苛刻了 —— 于是留这条系统拨号暗码：
 * 暗码是设备本机唯一「不显示在桌面上、又能进去」的通道。
 *
 * <p><b>它不是「只有家长能用」的通道，也不该被当成安全边界</b>：
 * {@code android.provider.Telephony.SECRET_CODE} 只是一条普通广播，系统没有对发送方做任何限制，
 * 第三方应用同样能发出同一条 Intent；而 {@code MainActivity} 本来就是
 * {@code exported=true}（家长端远程启动要用），任何应用都能显式拉起它。
 * 也就是说，暗码提供的是「<b>不显示在桌面上的入口</b>」这个便利性，而不是「孩子打不开」。
 * 这在本功能里可以接受：主界面只展示状态与自检，管控（锁定 / 学习模式 / 拦截）完全由
 * 常驻服务与设备所有者策略执行，孩子看到主界面并不等于绕过。
 *
 * <p>需要如实说明的两个前提：
 * <ul>
 *   <li>拨号暗码由系统拨号盘转发，部分 ROM / 第三方拨号器不转发 {@code SECRET_CODE}
 *       给第三方应用，这种情况下拨了没反应；家长端远程改配置与 adb
 *       （{@code pm enable .../MainActivityLauncher}）始终是兜底路径。</li>
 *   <li>图标隐藏本身不影响本类：它靠清单里的静态注册，与 activity-alias 的启用状态无关。</li>
 * </ul>
 */
public class SecretCodeReceiver extends BroadcastReceiver {

    /**
     * 家长入口暗码，与 {@code AndroidManifest.xml} 里 {@code <data android:host="2887"/>}
     * 必须保持一致。公开出来给设置页的提示文案复用，避免第二个地方再抄一遍字面量。
     */
    public static final String DIAL_CODE = "*#*#2887#*#*";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (context == null) return;
        try {
            Intent launch = new Intent(context, MainActivity.class);
            // NEW_TASK：从广播上下文启动 Activity 必须带；
            // CLEAR_TOP | SINGLE_TOP：连按暗码时复用已有实例，不叠一摞主界面。
            launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK
                    | Intent.FLAG_ACTIVITY_CLEAR_TOP
                    | Intent.FLAG_ACTIVITY_SINGLE_TOP);
            context.startActivity(launch);
            EventLog.success("经拨号入口（*#*#2887#*#*）打开主界面");
        } catch (Exception e) {
            // 少数 ROM 会拦后台启动 Activity：如实记日志，不假装已经打开了
            EventLog.warn("拨号入口（*#*#2887#*#*）打开主界面失败：" + e.getMessage());
        }
    }
}
