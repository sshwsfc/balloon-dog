package com.balloondog.agent.ui;

import android.app.AlertDialog;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.TextUtils;
import android.view.View;
import android.widget.Toast;

import androidx.annotation.Nullable;
import androidx.appcompat.app.AppCompatActivity;

import com.balloondog.agent.R;
import com.balloondog.agent.capability.ChildStatus;
import com.balloondog.agent.capability.ChildTasks;
import com.balloondog.agent.capability.LockEnforcer;
import com.balloondog.agent.capability.LockState;
import com.balloondog.agent.capability.TrustedClock;
import com.balloondog.agent.data.AgentStore;
import com.balloondog.agent.databinding.ActivityChildHomeBinding;
import com.balloondog.agent.databinding.ItemChildTaskBinding;
import com.balloondog.agent.model.JsonUtils;
import com.balloondog.agent.net.AgentApi;
import com.balloondog.agent.net.ApiException;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * 孩子端主页（规划 §3.2 / §5.2）。
 *
 * <p>孩子打开这一页要能一眼得到四件事，顺序也就是页面上的顺序：
 * <ol>
 *   <li><b>今天还剩多少</b> —— 额度和用量都在本机，离线也说得准，口径与锁定判定完全一致
 *       （都读 {@link AgentStore#getDailyLimitMinutes()} 与
 *       {@link AgentStore#getUsageSecondsToday()}）；</li>
 *   <li><b>今天要做什么</b> —— 家长布置的今日任务，勾上就是「告诉家长我做完了」（规划 §5.2）；</li>
 *   <li><b>怎么赚时长</b> —— 答题解锁（家长开着才出现）；</li>
 *   <li><b>怎么找家长</b> —— 求助（服务端发一条 danger 级通知 + 一条动态）与直接拨号。</li>
 * </ol>
 *
 * <p>三条自我约束（与锁定页同一套规矩）：
 * <ul>
 *   <li><b>算不准就直说</b>：没设额度、额度用完、被家长远程锁定是三种不同的情况，
 *       各说各的话，不合并成一句「剩余 0 分钟」；</li>
 *   <li><b>需要网络的动作离开主线程</b>（OkHttp 是同步的）：孩子点了求助或者勾了任务却卡住不动，
 *       是最糟的失败方式；</li>
 *   <li><b>没被认领就如实说</b>：这时求助发不出去，界面上要写清楚，
 *       而不是弹一个「已通知家长」。</li>
 * </ul>
 *
 * <p>本页是**几乎只读**：三个动作（求助 / 拨号 / 勾今天的任务），勾任务只改「做完了没有」
 * 这一个布尔值。改设置一律在家长端（孩子的设备上不做家长开关，连隐藏的入口也不留）。
 */
public class ChildHomeActivity extends AppCompatActivity {

    /**
     * 通知栏上的「查看剩余时间」入口。
     *
     * <p>孩子端的本机入口就是常驻通知上的这颗按钮（图标可能被家长隐藏、
     * 桌面也可能被学习模式接管，而通知栏始终在）。不用 singleInstance：
     * 从通知进来再返回应该回到孩子刚才在的地方。
     */
    public static android.content.Intent createIntent(android.content.Context context) {
        android.content.Intent intent = new android.content.Intent(context, ChildHomeActivity.class);
        intent.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK
                | android.content.Intent.FLAG_ACTIVITY_CLEAR_TOP);
        return intent;
    }

    public static android.app.PendingIntent createPendingIntent(android.content.Context context) {
        int flags = android.app.PendingIntent.FLAG_UPDATE_CURRENT;
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.M) {
            flags |= android.app.PendingIntent.FLAG_IMMUTABLE;
        }
        return android.app.PendingIntent.getActivity(context, 1, createIntent(context), flags);
    }

    /** 从学习桌面点「求助家长」进来时，直接弹求助框（少一步点击，急事上很值）。 */
    public static final String EXTRA_OPEN_SOS = "open_sos";

    private ActivityChildHomeBinding binding;
    private AgentStore store;
    private final AgentApi api = new AgentApi();
    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private final Handler main = new Handler(Looper.getMainLooper());

    /** 服务端回来的「谁在守护」；没拿到时保持 null（按钮据此禁用，不假装能打通）。 */
    @Nullable
    private AgentApi.ChildHomeResult home;
    private boolean sosInFlight = false;

    /** 今日任务（家长布置的）。勾选是本机乐观改，服务端回执再对齐。 */
    private final List<ChildTasks.Task> tasks = new ArrayList<>();
    /** 正在等服务端回执的任务 id —— 这期间那一行不能再点，避免连点出两个不同的状态。 */
    private final Set<String> taskBusy = new HashSet<>();
    private boolean tasksDirty = true;

    private final Runnable ticker = new Runnable() {
        @Override
        public void run() {
            render();
            main.postDelayed(this, 1000L);
        }
    };

    @Override
    protected void onCreate(@Nullable Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        binding = ActivityChildHomeBinding.inflate(getLayoutInflater());
        setContentView(binding.getRoot());
        store = new AgentStore(this);

        binding.buttonQuiz.setOnClickListener(v ->
                startActivity(new Intent(this, QuizActivity.class)));
        binding.buttonSos.setOnClickListener(v -> confirmSos());
        binding.buttonCall.setOnClickListener(v -> callParent());
        binding.buttonGuardianInfo.setOnClickListener(v ->
                startActivity(GuardianInfoActivity.createIntent(this)));

        loadHome();

        if (getIntent() != null && getIntent().getBooleanExtra(EXTRA_OPEN_SOS, false)) {
            confirmSos();
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        main.removeCallbacks(ticker);
        main.post(ticker);
    }

    @Override
    protected void onPause() {
        super.onPause();
        main.removeCallbacks(ticker);
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        main.removeCallbacks(ticker);
        executor.shutdownNow();
    }

    /** 每秒重画一次：剩余时间与锁状态都可能在这一秒里变。 */
    private void render() {
        int limitMinutes = store.isTimePlanEnabled() ? store.getDailyLimitMinutes() : 0;
        long usedSeconds = store.getUsageSecondsToday();
        ChildStatus.Snapshot snapshot = ChildStatus.compute(limitMinutes, usedSeconds);

        binding.textRemaining.setText(ChildStatus.remainingText(limitMinutes, usedSeconds));
        binding.textUsage.setText(ChildStatus.usageText(limitMinutes, usedSeconds));
        binding.progressRemaining.setProgress(snapshot.remainingPercent);

        LockState state = LockState.compute(LockEnforcer.buildInputs(store, TrustedClock.now()));
        binding.textStatus.setText(state.locked
                ? "现在被锁定：" + (state.detail == null ? "家长已锁定这台设备" : state.detail)
                : "现在可以正常使用");
        binding.textNext.setText(nextText(state));

        renderTasks();

        // 家长没开答题时按钮直接不出现 —— 留一个点不动的按钮比没有更让人困惑
        binding.buttonQuiz.setVisibility(store.isQuizEnabled() ? View.VISIBLE : View.GONE);
        binding.buttonCall.setEnabled(home != null && !TextUtils.isEmpty(home.parentPhone));
    }

    /** 「接下来会发生什么」：说得出时刻就说，说不出来就说规则，不编时间。 */
    private String nextText(LockState state) {
        if (state.locked) {
            long autoUnlockAt = LockState.probeAutoUnlockAt(
                    LockEnforcer.buildInputs(store, TrustedClock.now()));
            if (autoUnlockAt > 0L) {
                long wait = Math.max(0L, autoUnlockAt - TrustedClock.now());
                return "预计 " + JsonUtils.humanizeDuration(wait) + "后自动解锁";
            }
            return "解锁时间由家长决定";
        }
        if (state.nextLockAt > 0L) {
            long wait = Math.max(0L, state.nextLockAt - TrustedClock.now());
            String why = state.nextLockReason == null ? "" : "（" + state.nextLockReason + "）";
            return JsonUtils.humanizeDuration(wait) + "后进入休息" + why;
        }
        return "今天没有其他安排";
    }

    /**
     * 重画今日任务（规划 §5.2）。
     *
     * <p>只在数据真的变了才重建行：这个页面每秒都会 {@link #render()} 一次，
     * 若每秒重建一遍勾选框，孩子的手正按在屏幕上时会被自己的点击打断
     * （点下去的一瞬间控件被换掉，那一下就不算数了）。
     *
     * <p>一条任务都没有时整块藏起来 —— 「家长还没有布置任务」这种话留给家长端说。
     */
    private void renderTasks() {
        if (!tasksDirty) return;
        tasksDirty = false;
        binding.taskList.removeAllViews();
        boolean visible = ChildTasks.visible(tasks.size());
        binding.taskSection.setVisibility(visible ? View.VISIBLE : View.GONE);
        if (!visible) return;

        binding.textTasksHeader.setText(ChildTasks.headerText(home == null ? null : home.childName));
        binding.textTasksProgress.setText(ChildTasks.progressText(ChildTasks.doneCount(tasks), tasks.size()));

        for (ChildTasks.Task task : tasks) {
            ItemChildTaskBinding row = ItemChildTaskBinding.inflate(getLayoutInflater(), binding.taskList, false);
            row.textTaskTitle.setText(task.title);
            // 先设勾选态、再挂监听：否则程序化的 setChecked 会立刻回调一次，像孩子点了一下
            row.checkTask.setChecked(task.done);
            row.checkTask.setEnabled(!taskBusy.contains(task.id));
            row.checkTask.setOnCheckedChangeListener((button, checked) -> onTaskToggled(task, checked));
            binding.taskList.addView(row.getRoot());
        }
    }

    /**
     * 孩子勾上 / 取消一条任务。
     *
     * <p>先乐观改本地（勾一下必须立刻有反应），服务端说不通就**退回去**并如实说一声 ——
     * 勾了没生效、还看不出来，比明说失败糟得多。请求离开主线程，同一条任务在回执前不能连点。
     */
    private void onTaskToggled(ChildTasks.Task task, boolean target) {
        if (target == task.done) return;
        boolean previous = task.done;
        task.done = target;
        taskBusy.add(task.id);
        tasksDirty = true;
        renderTasks();
        binding.textTasksProgress.setText(ChildTasks.pendingText(target));

        executor.execute(() -> {
            try {
                AgentApi.TaskAck ack = api.setTaskDone(store.getBaseUrl(), task.id, target);
                main.post(() -> {
                    if (isFinishing()) return;
                    // 服务端是唯一的真相：回执说这条是什么状态，本地就跟着走
                    if (ack.task != null) task.done = ack.task.done;
                    taskBusy.remove(task.id);
                    tasksDirty = true;
                    renderTasks();
                });
            } catch (ApiException e) {
                main.post(() -> {
                    if (isFinishing()) return;
                    task.done = previous;
                    taskBusy.remove(task.id);
                    tasksDirty = true;
                    renderTasks();
                    binding.textTasksProgress.setText(ChildTasks.failureText(target));
                });
            }
        });
    }

    /**
     * 拉「谁在守护」与今天的任务。
     *
     * <p>失败也不挡住主页：剩余时间是本机算的，照常显示；只有拨号按钮会保持禁用，
     * 并在家长那行如实写明「暂时联系不上服务端」。任务那一块在拿到之前不出现 ——
     * 不能把「还没拿到」显示成「家长没有布置任务」。
     */
    private void loadHome() {
        binding.textParent.setText("正在读取家长信息…");
        executor.execute(() -> {
            try {
                AgentApi.ChildHomeResult result = api.getChildHome(store.getBaseUrl());
                main.post(() -> {
                    if (isFinishing()) return;
                    home = result;
                    tasks.clear();
                    tasks.addAll(result.tasks);
                    taskBusy.clear();
                    tasksDirty = true;
                    renderParent(result);
                    render();
                });
            } catch (ApiException e) {
                main.post(() -> {
                    if (isFinishing()) return;
                    binding.textParent.setText("暂时联系不上服务端（" + e.userMessage() + "）");
                    binding.textParentHint.setText("求助可以先试，服务端恢复后会补上");
                });
            }
        });
    }

    private void renderParent(AgentApi.ChildHomeResult result) {
        if (!result.bound) {
            binding.textParent.setText("这台设备还没有被家长认领");
            binding.textParentHint.setText("认领之后，求助才能发到家长手机上");
            return;
        }
        String name = TextUtils.isEmpty(result.parentName) ? "家长" : result.parentName;
        binding.textParent.setText("守护这台设备的是：" + name);
        binding.textParentHint.setText(TextUtils.isEmpty(result.parentPhone)
                ? "家长没有留手机号，可以用求助通知他"
                : "家长手机号 " + result.parentPhone);
    }

    private void confirmSos() {
        if (sosInFlight) return;
        View content = getLayoutInflater().inflate(R.layout.dialog_sos_reason, null);
        android.widget.EditText input = content.findViewById(R.id.inputSosReason);
        new AlertDialog.Builder(this)
                .setTitle("求助家长")
                .setMessage("会给家长发一条醒目的通知。如果说不清楚，可以先写一句是什么事。")
                .setView(content)
                .setNegativeButton("取消", null)
                .setPositiveButton("发送求助", (d, w) -> {
                    String reason = input.getText() == null ? "" : input.getText().toString().trim();
                    submitSos(reason.isEmpty() ? null : reason);
                })
                .show();
    }

    /**
     * 真的把求助发出去。
     *
     * <p>必须离开主线程：OkHttp 的 execute 是同步的，在主线程上会让整个页面卡住 ——
     * 一个着急求助的孩子按下去没反应，比没有这个按钮更糟。
     */
    private void submitSos(@Nullable String message) {
        sosInFlight = true;
        binding.buttonSos.setEnabled(false);
        binding.textSosState.setText("正在通知家长…");
        executor.execute(() -> {
            try {
                AgentApi.SosResult result = api.submitSos(store.getBaseUrl(), message);
                main.post(() -> {
                    sosInFlight = false;
                    binding.buttonSos.setEnabled(true);
                    if (isFinishing()) return;
                    if (result.success) {
                        binding.textSosState.setText("已经通知家长了");
                        Toast.makeText(this, "已经通知家长了", Toast.LENGTH_LONG).show();
                        if (!TextUtils.isEmpty(result.parentPhone)) {
                            callNumber(result.parentPhone);
                        }
                    } else {
                        // 「发不出去」必须说清楚原因，绝不说「已通知」
                        binding.textSosState.setText(result.reason.equals("unbound")
                                ? "这台设备还没有被家长认领，求助发不出去"
                                : "求助没有发出去，请直接打电话");
                    }
                });
            } catch (ApiException e) {
                main.post(() -> {
                    sosInFlight = false;
                    binding.buttonSos.setEnabled(true);
                    if (isFinishing()) return;
                    binding.textSosState.setText("求助没有发出去（" + e.userMessage() + "）");
                });
            }
        });
    }

    /** 直接拨给家长；没号码就提示用求助。 */
    private void callParent() {
        if (home == null || TextUtils.isEmpty(home.parentPhone)) {
            Toast.makeText(this, "还没有拿到家长的手机号，先用求助通知他", Toast.LENGTH_LONG).show();
            return;
        }
        callNumber(home.parentPhone);
    }

    private void callNumber(String phone) {
        try {
            startActivity(new Intent(Intent.ACTION_DIAL, Uri.parse("tel:" + phone)));
        } catch (Exception e) {
            Toast.makeText(this, "这台设备不能打电话，请用求助通知家长", Toast.LENGTH_LONG).show();
        }
    }
}
