package com.balloondog.agent.ui;

import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.graphics.drawable.Drawable;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.TextUtils;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;

import androidx.annotation.Nullable;
import androidx.appcompat.app.AppCompatActivity;

import com.balloondog.agent.R;
import com.balloondog.agent.capability.StudyHomeController;
import com.balloondog.agent.capability.StudyLauncher;
import com.balloondog.agent.capability.StudyModeEngine;
import com.balloondog.agent.capability.TrustedClock;
import com.balloondog.agent.data.AgentStore;
import com.balloondog.agent.databinding.ActivityStudyHomeBinding;
import com.balloondog.agent.model.ModeConfig;

import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;
import java.util.Locale;

/**
 * 学习模式专用桌面（规划 §4.4）。
 *
 * <p>它替系统桌面当 HOME：只有学习模式开着、且本应用是设备所有者时才会被系统选中
 * （{@link StudyHomeController}）。桌面上只列家长允许的应用 + 安全底线的系统应用，
 * 底部两个出口是「今天还剩多少」与「求助家长」—— 学习模式下孩子仍然要能查时间、能找人。
 *
 * <h3>三条自我约束</h3>
 * <ol>
 *   <li><b>不该接管时立刻还回去</b>：{@link #onResume()} 每次都重新求值学习模式，
 *       一旦不在学习模式就释放 HOME 偏好并跳到系统桌面 —— 进程被杀、家长刚关掉学习模式、
 *       时段刚过整点，都不会把孩子困在一个过期的学习桌面上；</li>
 *   <li><b>接管失败要说出来</b>：没有设备所有者时桌面没法被钉住，页面照常可看，
 *       但顶部会明说「桌面没有被接管」，不让家长以为管控生效了；</li>
 *   <li><b>桌面不联网</b>：列应用、算状态全部本地完成，断网照常成立。</li>
 * </ol>
 */
public class StudyHomeActivity extends AppCompatActivity {

    private static final int COLUMNS = 4;
    private static final long CLOCK_INTERVAL_MS = 30_000L;

    private ActivityStudyHomeBinding binding;
    private AgentStore store;

    private final Handler clockHandler = new Handler(Looper.getMainLooper());
    private final Runnable clockTick = new Runnable() {
        @Override
        public void run() {
            renderClock();
            clockHandler.postDelayed(this, CLOCK_INTERVAL_MS);
        }
    };

    public static Intent createIntent(Context context) {
        Intent intent = new Intent(context, StudyHomeActivity.class);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        return intent;
    }

    @Override
    protected void onCreate(@Nullable Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        binding = ActivityStudyHomeBinding.inflate(getLayoutInflater());
        setContentView(binding.getRoot());
        store = new AgentStore(this);

        binding.buttonChildHome.setOnClickListener(v ->
                startActivity(ChildHomeActivity.createIntent(this)));
        binding.buttonSos.setOnClickListener(v -> startActivity(
                ChildHomeActivity.createIntent(this).putExtra(ChildHomeActivity.EXTRA_OPEN_SOS, true)));
    }

    @Override
    protected void onResume() {
        super.onResume();
        syncMode();
        renderClock();
        clockHandler.removeCallbacks(clockTick);
        clockHandler.postDelayed(clockTick, CLOCK_INTERVAL_MS);
    }

    @Override
    protected void onPause() {
        super.onPause();
        clockHandler.removeCallbacks(clockTick);
    }

    /** 每次回到前台都重新求值：不在学习模式就还回系统桌面，不能把孩子困在过期的桌面上。 */
    private void syncMode() {
        ModeConfig config = store.getModeConfig();
        boolean study = StudyModeEngine.isStudy(config, TrustedClock.now());
        if (!study) {
            StudyHomeController.release(this);
            goRealHome();
            return;
        }
        render(config);
    }

    private void render(ModeConfig config) {
        List<StudyLauncher.Entry> entries = StudyLauncher.entries(config, installedLaunchableApps());

        String notice = StudyLauncher.noticeText(entries.size());
        if (!StudyHomeController.isHeld(this)) {
            notice = notice + "（本机没有设备所有者权限，桌面没有被接管；应用拦截仍然生效。）";
        }
        binding.textStudyNotice.setText(notice);

        binding.appGrid.removeAllViews();
        if (entries.isEmpty()) {
            binding.textStudyEmpty.setVisibility(View.VISIBLE);
            binding.textStudyEmpty.setText(StudyLauncher.emptyText());
            return;
        }
        binding.textStudyEmpty.setVisibility(View.GONE);

        LinearLayout row = null;
        for (int i = 0; i < entries.size(); i++) {
            if (i % COLUMNS == 0) {
                row = new LinearLayout(this);
                row.setOrientation(LinearLayout.HORIZONTAL);
                row.setLayoutParams(new LinearLayout.LayoutParams(
                        LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT));
                binding.appGrid.addView(row);
            }
            row.addView(buildCell(entries.get(i)));
        }
        // 最后一行补空位，卡片列宽才对得齐（否则少的那几个会被拉宽）
        if (row != null) {
            for (int i = entries.size() % COLUMNS; i != 0 && i < COLUMNS; i++) {
                row.addView(buildSpacer());
            }
        }
    }

    private View buildCell(StudyLauncher.Entry entry) {
        LinearLayout cell = new LinearLayout(this);
        cell.setOrientation(LinearLayout.VERTICAL);
        cell.setGravity(Gravity.CENTER_HORIZONTAL);
        cell.setPadding(0, dp(10), 0, dp(10));
        cell.setLayoutParams(new LinearLayout.LayoutParams(
                0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f));

        ImageView icon = new ImageView(this);
        Drawable drawable = loadIcon(entry.packageName);
        if (drawable != null) icon.setImageDrawable(drawable);
        LinearLayout.LayoutParams iconParams = new LinearLayout.LayoutParams(dp(44), dp(44));
        icon.setLayoutParams(iconParams);
        cell.addView(icon);

        TextView label = new TextView(this);
        label.setText(entry.label);
        label.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        label.setGravity(Gravity.CENTER);
        label.setMaxLines(1);
        label.setEllipsize(TextUtils.TruncateAt.END);
        label.setPadding(0, dp(4), 0, 0);
        label.setLayoutParams(new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT));
        cell.addView(label);

        cell.setOnClickListener(v -> launch(entry.packageName, entry.label));
        return cell;
    }

    private View buildSpacer() {
        View spacer = new View(this);
        spacer.setLayoutParams(new LinearLayout.LayoutParams(
                0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f));
        return spacer;
    }

    private List<StudyLauncher.Entry> installedLaunchableApps() {
        PackageManager pm = getPackageManager();
        Intent launcher = new Intent(Intent.ACTION_MAIN);
        launcher.addCategory(Intent.CATEGORY_LAUNCHER);
        List<ResolveInfo> resolved = pm.queryIntentActivities(launcher, 0);
        String self = getPackageName();

        List<StudyLauncher.Entry> entries = new ArrayList<>();
        for (ResolveInfo info : resolved) {
            if (info == null || info.activityInfo == null) continue;
            String pkg = info.activityInfo.packageName;
            if (pkg == null || pkg.equals(self)) continue; // 自己不上学习桌面（家长入口在别处）
            CharSequence label = info.loadLabel(pm);
            boolean system = info.activityInfo.applicationInfo != null
                    && (info.activityInfo.applicationInfo.flags
                    & android.content.pm.ApplicationInfo.FLAG_SYSTEM) != 0;
            entries.add(new StudyLauncher.Entry(pkg, label == null ? pkg : label.toString(), system));
        }
        return entries;
    }

    @Nullable
    private Drawable loadIcon(String packageName) {
        try {
            return getPackageManager().getApplicationIcon(packageName);
        } catch (Throwable t) {
            return null;
        }
    }

    private void launch(String packageName, String label) {
        Intent intent = getPackageManager().getLaunchIntentForPackage(packageName);
        if (intent == null) {
            // 应用刚被卸载/停用：说一句实话，别让孩子对着一个点不动的图标
            binding.textStudyNotice.setText("「" + label + "」现在打不开。如果家长刚卸载了它，请刷新这一页。");
            return;
        }
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            startActivity(intent);
        } catch (Throwable t) {
            binding.textStudyNotice.setText("「" + label + "」打不开（" + t.getClass().getSimpleName() + "）。");
        }
    }

    /** 不再接管时把孩子送回系统桌面（HOME 偏好已经清掉，这个意图会落到真正的桌面上）。 */
    private void goRealHome() {
        Intent home = new Intent(Intent.ACTION_MAIN);
        home.addCategory(Intent.CATEGORY_HOME);
        home.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            startActivity(home);
        } catch (Throwable ignored) {
            // 找不到别的桌面（极少数设备）：留在这一页，至少不是一块黑屏
            finish();
            return;
        }
        finish();
    }

    private void renderClock() {
        String time = new SimpleDateFormat("HH:mm", Locale.getDefault()).format(new Date());
        binding.textStudyClock.setText(time + " · 学习模式");
    }

    /** 学习桌面上按返回键不许离开（离开就等于回到了「那个能翻抽屉的桌面」，等于没接管）。 */
    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        // 故意什么都不做
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }
}
