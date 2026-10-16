package com.balloondog.agent.ui;

import android.content.Context;
import android.content.Intent;
import android.os.Bundle;
import android.view.View;
import android.widget.LinearLayout;
import android.widget.TextView;

import androidx.appcompat.app.AppCompatActivity;

import com.balloondog.agent.R;
import com.balloondog.agent.capability.AmbientRecorder;
import com.balloondog.agent.capability.CallLogReader;
import com.balloondog.agent.capability.GuardianNotice;
import com.balloondog.agent.capability.LocationReader;
import com.balloondog.agent.capability.SmsReader;
import com.balloondog.agent.data.AgentStore;
import com.balloondog.agent.databinding.ActivityGuardianInfoBinding;
import com.balloondog.agent.service.AgentService;

import java.util.List;

/**
 * 「本设备由家长守护」知情说明页（规划 §3.4）。
 *
 * <p>这一页存在的理由只有一条：**孩子有权知道这台设备的真相**。锁定页回答「为什么现在不能用」，
 * 这一页回答「这台设备到底在做什么、谁在看、我能不能拒绝」。
 *
 * <p>三条刻意的做法：
 * <ul>
 *   <li><b>文本全部来自 {@link GuardianNotice}（纯 Java）</b>，本类只负责读本机状态并渲染。
 *       这样「页面上到底写了什么」只有一个来源，JVM 测试断言的文本与孩子看到的文本是同一份；</li>
 *   <li><b>顶部先讲「现在」</b>：周期截屏、环境监听、位置/短信/通话上报、守护服务是否在跑，
 *       都按本机真实开关生成 —— 静态说明容易被理解成「反正都是套话」；</li>
 *   <li><b>不联网</b>：这是知情说明，不是功能页。断网、未绑定时也必须能打开、能读完
 *       （家长端那边的同意留痕属 §5.3，不在这里做）。</li>
 * </ul>
 */
public class GuardianInfoActivity extends AppCompatActivity {

    /** 入口在通知栏的「查看剩余时间」页上；也可以从说明链接进来。 */
    public static Intent createIntent(Context context) {
        return new Intent(context, GuardianInfoActivity.class);
    }

    private ActivityGuardianInfoBinding binding;
    private AgentStore store;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        binding = ActivityGuardianInfoBinding.inflate(getLayoutInflater());
        setContentView(binding.getRoot());
        store = new AgentStore(this);

        renderLive();
        renderSections();

        binding.buttonNoticeBack.setOnClickListener(v -> finish());
    }

    /** 顶部状态：每一条都来自本机真实开关或真实权限，没有一条是写死的。 */
    private void renderLive() {
        List<String> lines = GuardianNotice.liveLines(
                store.isCaptureEnabled(),
                store.getCaptureIntervalSeconds(),
                AmbientRecorder.isRunning(),
                CallLogReader.hasPermission(this),
                SmsReader.hasPermission(this),
                LocationReader.hasPermission(this),
                AgentService.isRunning());
        binding.textLive.setText(String.join("\n", lines));
    }

    /** 各节说明：标题 + 正文，全部来自 GuardianNotice.sections()。 */
    private void renderSections() {
        LinearLayout container = binding.noticeContainer;
        container.removeAllViews();
        for (GuardianNotice.Section section : GuardianNotice.sections()) {
            container.addView(buildHeading(section.heading));
            container.addView(buildBody(String.join("\n", section.lines)));
        }
    }

    private View buildHeading(String text) {
        TextView view = new TextView(this);
        view.setText(text);
        view.setTextSize(15f);
        view.setTextColor(0xFF1A1A1A);
        view.setTypeface(view.getTypeface(), android.graphics.Typeface.BOLD);
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        params.topMargin = dp(20);
        view.setLayoutParams(params);
        return view;
    }

    private View buildBody(String text) {
        TextView view = new TextView(this);
        view.setText(text);
        view.setTextSize(13f);
        view.setTextColor(0xFF4A4A4A);
        view.setLineSpacing(dp(3), 1f);
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        params.topMargin = dp(8);
        view.setLayoutParams(params);
        return view;
    }

    private int dp(int value) {
        return Math.round(getResources().getDisplayMetrics().density * value);
    }
}
