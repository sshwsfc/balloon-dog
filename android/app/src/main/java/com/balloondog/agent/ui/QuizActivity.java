package com.balloondog.agent.ui;

import android.content.res.ColorStateList;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.LayoutInflater;
import android.view.View;
import android.widget.Toast;

import androidx.annotation.Nullable;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.content.ContextCompat;

import com.balloondog.agent.R;
import com.balloondog.agent.data.AgentStore;
import com.balloondog.agent.data.EventLog;
import com.balloondog.agent.databinding.ActivityQuizBinding;
import com.balloondog.agent.databinding.ItemQuizOptionBinding;
import com.balloondog.agent.model.JsonUtils;
import com.balloondog.agent.model.RemoteQuestion;
import com.balloondog.agent.net.AgentApi;
import com.balloondog.agent.net.ApiException;
import com.balloondog.agent.service.AgentService;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * 答题解锁。
 *
 * <p>孩子被锁屏后，如果家长开启了「答题解锁」，就能在这里答题换取使用时长：
 * <ol>
 *   <li>{@code GET /api/agent/quiz/question} 取题（接口刻意不返回答案）；</li>
 *   <li>孩子选一个选项；</li>
 *   <li>{@code POST /api/agent/quiz/answer} 交卷，服务端判定并**自动延长可用时长**；</li>
 *   <li>答对则本地立刻解除锁定（服务端已经改了 locked / tempUnlockUntil）。</li>
 * </ol>
 * 判定完全在服务端做 —— 客户端拿不到正确答案，改本地状态也没用，
 * 下一次 {@code /agent/config} 就会把真实状态同步回来。
 */
public class QuizActivity extends AppCompatActivity {

    private ActivityQuizBinding binding;
    private AgentStore store;
    private final AgentApi api = new AgentApi();
    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private final Handler main = new Handler(Looper.getMainLooper());

    private RemoteQuestion current;
    private final List<ItemQuizOptionBinding> optionBindings = new ArrayList<>();
    private int selectedIndex = -1;
    private boolean answered;

    @Override
    protected void onCreate(@Nullable Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        binding = ActivityQuizBinding.inflate(getLayoutInflater());
        setContentView(binding.getRoot());

        store = new AgentStore(this);
        binding.buttonPrimary.setOnClickListener(v -> {
            if (answered) {
                loadQuestion();
            } else {
                submit();
            }
        });
        binding.buttonFinish.setOnClickListener(v -> finish());

        loadQuestion();
    }

    @Override
    protected void onDestroy() {
        executor.shutdownNow();
        super.onDestroy();
    }

    // ============================================================
    // 取题
    // ============================================================

    private void loadQuestion() {
        answered = false;
        selectedIndex = -1;
        current = null;
        binding.optionContainer.removeAllViews();
        optionBindings.clear();
        binding.textFeedback.setVisibility(View.GONE);
        binding.buttonFinish.setVisibility(View.GONE);
        binding.buttonPrimary.setText(R.string.quiz_submit);
        binding.buttonPrimary.setEnabled(false);
        binding.textType.setText(R.string.quiz_loading);
        binding.textQuestion.setText("");

        executor.execute(() -> {
            try {
                RemoteQuestion question = api.fetchQuizQuestion(store.getBaseUrl());
                main.post(() -> renderQuestion(question));
            } catch (ApiException e) {
                main.post(() -> renderError(e));
            }
        });
    }

    private void renderQuestion(@Nullable RemoteQuestion question) {
        if (question == null || question.options.isEmpty()) {
            binding.textType.setText("");
            binding.textQuestion.setText("题库暂时没有可用题目，请稍后再试。");
            return;
        }
        current = question;
        binding.textType.setText(question.typeLabel() + " · 答对奖励 "
                + question.rewardMinutes + " 分钟");
        binding.textQuestion.setText(question.question);

        binding.optionContainer.removeAllViews();
        optionBindings.clear();
        LayoutInflater inflater = LayoutInflater.from(this);
        for (int i = 0; i < question.options.size(); i++) {
            ItemQuizOptionBinding optionBinding = ItemQuizOptionBinding.inflate(
                    inflater, binding.optionContainer, false);
            final int index = i;
            optionBinding.getRoot().setText(label(i) + ". " + question.options.get(i));
            optionBinding.getRoot().setOnClickListener(v -> selectOption(index));
            binding.optionContainer.addView(optionBinding.getRoot());
            optionBindings.add(optionBinding);
        }
        binding.buttonPrimary.setEnabled(false);
    }

    private void renderError(ApiException error) {
        binding.textType.setText("");
        binding.textQuestion.setText(error.userMessage());
        binding.buttonPrimary.setEnabled(false);

        // 「答题解锁功能未开启」是常见情况（家长没开或已关闭），给出明确指引
        if (error.status() == 400) {
            binding.textFeedback.setVisibility(View.VISIBLE);
            binding.textFeedback.setTextColor(ContextCompat.getColor(this, R.color.warning_amber));
            binding.textFeedback.setText("提示：请让家长在家长端「答题解锁」里开启此功能。");
        }
        EventLog.warn("取题失败：" + error.describe());
    }

    private static String label(int index) {
        return String.valueOf((char) ('A' + index));
    }

    // ============================================================
    // 选择与提交
    // ============================================================

    private void selectOption(int index) {
        if (answered || current == null) return;
        selectedIndex = index;
        for (int i = 0; i < optionBindings.size(); i++) {
            boolean selected = i == index;
            optionBindings.get(i).getRoot().setStrokeColor(ColorStateList.valueOf(
                    ContextCompat.getColor(this, selected ? R.color.wechat_green : R.color.divider)));
            optionBindings.get(i).getRoot().setTextColor(ContextCompat.getColor(this,
                    selected ? R.color.wechat_green_dark : R.color.text_primary));
        }
        binding.buttonPrimary.setEnabled(true);
    }

    private void submit() {
        if (current == null || selectedIndex < 0) return;
        binding.buttonPrimary.setEnabled(false);
        binding.buttonPrimary.setText("正在判定…");

        executor.execute(() -> {
            try {
                AgentApi.AnswerResult result =
                        api.submitQuizAnswer(store.getBaseUrl(), current.id, selectedIndex);
                main.post(() -> renderAnswer(result));
            } catch (ApiException e) {
                main.post(() -> {
                    Toast.makeText(this, e.userMessage(), Toast.LENGTH_LONG).show();
                    binding.buttonPrimary.setEnabled(true);
                    binding.buttonPrimary.setText(R.string.quiz_submit);
                });
            }
        });
    }

    private void renderAnswer(AgentApi.AnswerResult result) {
        answered = true;
        binding.buttonPrimary.setText(R.string.quiz_next);
        binding.buttonPrimary.setEnabled(true);
        binding.buttonFinish.setVisibility(View.VISIBLE);
        binding.textFeedback.setVisibility(View.VISIBLE);

        // 标出正确答案与孩子选的答案
        for (int i = 0; i < optionBindings.size(); i++) {
            int color;
            if (i == result.correctAnswer) {
                color = R.color.wechat_green;
            } else if (i == selectedIndex) {
                color = R.color.danger_red;
            } else {
                color = R.color.divider;
            }
            optionBindings.get(i).getRoot().setStrokeColor(
                    ColorStateList.valueOf(ContextCompat.getColor(this, color)));
            optionBindings.get(i).getRoot().setTextColor(ContextCompat.getColor(this, color));
        }

        if (result.correct) {
            // 服务端答对时已经把设备解锁并把可用时长往后延了，这里同步到本地立刻生效。
            //
            // 「重置锁屏倒计时」不需要额外代码：锁屏倒计时由 LockState 每秒重算，
            // 它盯的是「下一次将进入锁定的时刻」。奖励把放行截止时间往后推之后，
            // 那个时刻自然变成「奖励到期的那一刻」，倒计时会在到期前 N 秒重新出现。
            // 这正是把倒计时做成纯计算结果、而不是自己维护一个计时器的好处。
            long until = result.tempUnlockUntil > 0
                    ? result.tempUnlockUntil
                    : System.currentTimeMillis() + result.rewardMinutes * 60_000L;
            store.setLockState(false, until);
            store.setManualUnlockUntil(0L);

            binding.textFeedback.setTextColor(ContextCompat.getColor(this, R.color.wechat_green));
            StringBuilder sb = new StringBuilder(getString(R.string.quiz_correct));
            if (result.rewardMinutes > 0) {
                sb.append("，").append(getString(R.string.quiz_reward_prefix))
                        .append(result.rewardMinutes).append(getString(R.string.quiz_minutes));
            }
            sb.append("。可用至 ").append(JsonUtils.humanizeDuration(until - System.currentTimeMillis()))
                    .append("后结束。");
            binding.textFeedback.setText(sb.toString());

            EventLog.success("答题正确，获得 " + result.rewardMinutes + " 分钟使用时长，倒计时已重置");
            // 让锁定页与服务立刻重新求值：锁定页会自己退出 kiosk 并关闭
            LockScreenActivity.dismiss(this);
            // 让服务端状态与本地尽快对齐（也顺便刷新家长端看到的 expected 状态）
            AgentService.refreshNow(this);
        } else {
            binding.textFeedback.setTextColor(ContextCompat.getColor(this, R.color.danger_red));
            String text = getString(R.string.quiz_wrong) + "。"
                    + getString(R.string.quiz_correct_answer) + label(result.correctAnswer);
            if (result.explanation != null && !result.explanation.isEmpty()) {
                text = text + "\n" + result.explanation;
            }
            binding.textFeedback.setText(text);
            EventLog.info("答题错误");
        }
    }
}
