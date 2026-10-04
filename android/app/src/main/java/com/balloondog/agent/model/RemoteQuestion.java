package com.balloondog.agent.model;

import androidx.annotation.Nullable;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * {@code GET /api/agent/quiz/question} 返回的一道题。
 *
 * <p>响应形状：
 * <pre>
 * { "enabled": true, "rewardMinutes": 3, "randomMode": false,
 *   "question": { "id": "...", "type": "english", "grade": "grade1",
 *                 "question": "…", "options": ["A","B"], "explanation": "" } }
 * </pre>
 * 取题接口<b>不返回正确答案</b>，答案在 {@code POST /agent/quiz/answer} 的响应里才给出。
 */
public class RemoteQuestion {

    public final String id;
    public final String type;
    public final String grade;
    public final String question;
    public final List<String> options;
    public final int rewardMinutes;

    /** 直接构造（屏幕答题：题目来自服务端的屏幕洞察，不经题库接口）。 */
    public RemoteQuestion(String id, String type, String grade, String question,
                          List<String> options, int rewardMinutes) {
        this.id = id;
        this.type = type;
        this.grade = grade;
        this.question = question;
        this.options = options;
        this.rewardMinutes = rewardMinutes;
    }

    @Nullable
    public static RemoteQuestion from(@Nullable JSONObject response) {
        if (response == null) return null;
        JSONObject question = response.optJSONObject("question");
        if (question == null) return null;

        List<String> options = new ArrayList<>();
        JSONArray array = question.optJSONArray("options");
        if (array != null) {
            for (int i = 0; i < array.length(); i++) {
                options.add(array.optString(i));
            }
        }
        return new RemoteQuestion(
                question.optString("id"),
                question.optString("type", "english"),
                question.optString("grade", "grade1"),
                question.optString("question", ""),
                Collections.unmodifiableList(options),
                response.optInt("rewardMinutes", 3));
    }

    /** 题型的中文标签，用于答题页标题。 */
    public String typeLabel() {
        if ("poetry".equals(type)) return "古诗填空";
        if ("english".equals(type)) return "英语单词";
        return "随机出题";
    }
}
