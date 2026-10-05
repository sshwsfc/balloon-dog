package com.balloondog.agent.net;

import android.os.Build;
import android.text.TextUtils;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;

import com.balloondog.agent.data.Constants;
import com.balloondog.agent.model.AgentCommand;
import com.balloondog.agent.model.DeviceConfig;
import com.balloondog.agent.model.JsonUtils;
import com.balloondog.agent.model.MediaRef;
import com.balloondog.agent.model.RemoteQuestion;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * {@code /api/agent/*} 这一组设备端接口的类型化封装。
 *
 * <p>七个接口，一个不多一个不少（对应 server/README.md 的「设备端 Agent 协议」）：
 * <table>
 *   <tr><td>POST</td><td>/agent/register</td><td>自助注册 / 续订令牌</td></tr>
 *   <tr><td>POST</td><td>/agent/heartbeat</td><td>报活（电量 / 网络 / 版本）</td></tr>
 *   <tr><td>GET</td><td>/agent/config</td><td>拉取管控策略</td></tr>
 *   <tr><td>GET</td><td>/agent/commands/next?wait=25</td><td>长轮询领指令</td></tr>
 *   <tr><td>POST</td><td>/agent/commands/:id/result</td><td>回报执行结果</td></tr>
 *   <tr><td>POST</td><td>/agent/locations</td><td>上报位置</td></tr>
 *   <tr><td>POST</td><td>/agent/media</td><td>上传媒体（multipart）</td></tr>
 *   <tr><td>GET/POST</td><td>/agent/quiz/question, /agent/quiz/answer</td><td>答题解锁</td></tr>
 * </table>
 */
public class AgentApi {

    private final ApiClient client;

    public AgentApi() {
        this.client = ApiClient.get();
    }

    /** 每个方法都显式接收 baseUrl（由 AgentStore 提供），避免在这里维护第二份地址状态。 */
    @NonNull
    private static String base(@Nullable String baseUrl) {
        return TextUtils.isEmpty(baseUrl) ? Constants.DEFAULT_BASE_URL : baseUrl;
    }

    // ============================================================
    // 1. 注册 / 续订令牌
    // ============================================================

    public static class RegisterResult {
        public final boolean created;
        public final String deviceToken;
        public final String deviceId;
        public final String deviceCode;
        public final boolean bound;

        RegisterResult(boolean created, String deviceToken, String deviceId, String deviceCode, boolean bound) {
            this.created = created;
            this.deviceToken = deviceToken;
            this.deviceId = deviceId;
            this.deviceCode = deviceCode;
            this.bound = bound;
        }
    }

    /**
     * 自助注册。同一对 {@code deviceCode + deviceSecret} 重复调用是幂等的：
     * 服务端校验密钥后重新签发令牌，用于 App 重装 / 重启后恢复身份。
     * 密钥不匹配返回 403 —— 别人光知道设备码也冒充不了这台设备。
     */
    public RegisterResult register(String baseUrl, String deviceCode, String deviceSecret,
                                   String deviceName) throws ApiException {
        JSONObject body = new JSONObject();
        try {
            body.put("deviceCode", deviceCode);
            body.put("deviceSecret", deviceSecret);
            body.put("name", deviceName);
            body.put("model", Build.MANUFACTURER + " " + Build.MODEL);
            body.put("os", "Android");
            body.put("osVersion", Build.VERSION.RELEASE == null ? "" : Build.VERSION.RELEASE);
            body.put("agentVersion", Constants.AGENT_VERSION);
        } catch (JSONException e) {
            throw ApiException.network("构造注册请求失败：" + e.getMessage());
        }

        JSONObject json = client.post(base(baseUrl), Constants.PATH_REGISTER, body);
        return new RegisterResult(
                json.optBoolean("created", false),
                json.optString("deviceToken", null),
                json.optString("deviceId", null),
                json.optString("deviceCode", deviceCode),
                json.optBoolean("bound", false));
    }

    // ============================================================
    // 2. 心跳
    // ============================================================

    public static class HeartbeatResult {
        public final boolean bound;
        public final boolean locked;
        public final long tempUnlockUntil;
        public final String serverTime;

        HeartbeatResult(boolean bound, boolean locked, long tempUnlockUntil, String serverTime) {
            this.bound = bound;
            this.locked = locked;
            this.tempUnlockUntil = tempUnlockUntil;
            this.serverTime = serverTime;
        }
    }

    /**
     * 心跳。
     *
     * @param effectiveLocked 设备上<b>实际</b>是否处于锁定。与服务端的 {@code locked}
     *                        （家长的期望值）不是一回事：设备可能因为作息表或每日额度
     *                        而锁定，上报之后家长端才能显示真实状态。
     * @param lockReason      锁定原因的人话说明，直接展示给家长
     */
    public HeartbeatResult heartbeat(String baseUrl, int battery, String network, String agentVersion,
                                     boolean effectiveLocked, String lockReason) throws ApiException {
        JSONObject body = new JSONObject();
        try {
            body.put("battery", battery);
            body.put("network", network);
            body.put("agentVersion", agentVersion);
            body.put("effectiveLocked", effectiveLocked);
            if (lockReason != null && !lockReason.isEmpty()) {
                body.put("lockReason", lockReason);
            }
        } catch (JSONException ignored) {
            // 均为原生类型，实际不会抛
        }
        JSONObject json = client.post(base(baseUrl), Constants.PATH_HEARTBEAT, body);
        return new HeartbeatResult(
                json.optBoolean("bound", false),
                json.optBoolean("locked", false),
                JsonUtils.parseIsoMillis(json.optString("tempUnlockUntil", null)),
                json.optString("serverTime", null));
    }

    // ============================================================
    // 3. 管控策略
    // ============================================================

    public DeviceConfig fetchConfig(String baseUrl) throws ApiException {
        JSONObject json = client.get(base(baseUrl), Constants.PATH_CONFIG, null, false);
        return DeviceConfig.from(json);
    }

    // ============================================================
    // 4. 长轮询领指令
    // ============================================================

    /**
     * 领取下一条指令。
     *
     * @param waitSeconds 无指令时的挂起秒数（0 表示立即返回），服务端上限 50
     * @return 没有指令时返回 null
     */
    @Nullable
    public AgentCommand nextCommand(String baseUrl, int waitSeconds) throws ApiException {
        JSONObject json = client.get(base(baseUrl), Constants.PATH_COMMANDS_NEXT,
                "wait=" + waitSeconds, true);

        // 服务端两种写法都要认：{"command": null} 与 {"command": {...}}
        if (json.isNull("command")) return null;
        JSONObject command = json.optJSONObject("command");
        if (command == null) return null;
        return AgentCommand.from(command);
    }

    // ============================================================
    // 5. 回报结果
    // ============================================================

    public static class ResultAck {
        public final String status;
        /** 服务端认为该指令已经结算过（设备重试的常见情况）。 */
        public final boolean alreadySettled;

        ResultAck(String status, boolean alreadySettled) {
            this.status = status;
            this.alreadySettled = alreadySettled;
        }
    }

    public ResultAck reportResult(String baseUrl, String commandId, boolean succeeded,
                                  @Nullable JSONObject result, @Nullable String error) throws ApiException {
        JSONObject body = new JSONObject();
        try {
            body.put("status", succeeded ? "succeeded" : "failed");
            if (result != null) body.put("result", result);
            if (!TextUtils.isEmpty(error)) body.put("error", error);
        } catch (JSONException ignored) {
            // 同上，均为原生类型
        }
        JSONObject json = client.post(base(baseUrl), Constants.pathCommandResult(commandId), body);
        JSONObject command = json.optJSONObject("command");
        return new ResultAck(
                command != null ? command.optString("status", "") : "",
                json.optBoolean("alreadySettled", false));
    }

    // ============================================================
    // 6. 位置上报
    // ============================================================

    public static class LocationAck {
        public final boolean deduplicated;

        LocationAck(boolean deduplicated) {
            this.deduplicated = deduplicated;
        }
    }

    /**
     * 上报一次定位。服务端会把同设备 30 秒内的重复上报折叠为一条（更新而非新增），
     * 所以这里不需要自己做节流。
     */
    public LocationAck reportLocation(String baseUrl, double latitude, double longitude,
                                      float accuracy, @Nullable String address) throws ApiException {
        JSONObject body = new JSONObject();
        try {
            body.put("latitude", latitude);
            body.put("longitude", longitude);
            if (accuracy > 0) body.put("accuracy", accuracy);
            if (!TextUtils.isEmpty(address)) body.put("address", address);
            body.put("recordedAt", JsonUtils.toIso(System.currentTimeMillis()));
        } catch (JSONException ignored) {
            // 同上
        }
        JSONObject json = client.post(base(baseUrl), Constants.PATH_LOCATIONS, body);
        return new LocationAck(json.optBoolean("deduplicated", false));
    }

    // ============================================================
    // 7. 媒体上传
    // ============================================================

    /**
     * 上传采集到的媒体。
     *
     * @param kind photo / screenshot / video / audio —— 必须与 mimeType 前缀匹配，
     *             否则服务端返回 400（例如把 audio/mp4 当成 photo 上传）
     * @param commandId 产生该媒体的指令 id，用于在指令历史里关联；可为空
     */
    @Nullable
    public MediaRef uploadMedia(String baseUrl, byte[] bytes, String filename, String mimeType,
                                String kind, @Nullable String commandId) throws ApiException {
        JSONObject json = client.uploadMedia(base(baseUrl), bytes, filename, mimeType, kind, commandId);
        return MediaRef.from(json);
    }

    // ============================================================
    // 8. 答题解锁
    // ============================================================

    @Nullable
    public RemoteQuestion fetchQuizQuestion(String baseUrl) throws ApiException {
        JSONObject json = client.get(base(baseUrl), Constants.PATH_QUIZ_QUESTION, null, false);
        return RemoteQuestion.from(json);
    }

    public static class AnswerResult {
        public final boolean correct;
        public final int correctAnswer;
        public final String explanation;
        public final int rewardMinutes;
        public final long tempUnlockUntil;

        AnswerResult(boolean correct, int correctAnswer, String explanation, int rewardMinutes,
                     long tempUnlockUntil) {
            this.correct = correct;
            this.correctAnswer = correctAnswer;
            this.explanation = explanation;
            this.rewardMinutes = rewardMinutes;
            this.tempUnlockUntil = tempUnlockUntil;
        }
    }

    /** 交卷。答对后服务端自动延长可用时长（锁屏状态会顺带解锁）。 */
    public AnswerResult submitQuizAnswer(String baseUrl, String questionId, int answer) throws ApiException {
        JSONObject body = new JSONObject();
        try {
            body.put("questionId", questionId);
            body.put("answer", answer);
        } catch (JSONException ignored) {
            // 同上
        }
        JSONObject json = client.post(base(baseUrl), Constants.PATH_QUIZ_ANSWER, body);
        return new AnswerResult(
                json.optBoolean("isCorrect", false),
                json.optInt("correctAnswer", -1),
                json.optString("explanation", ""),
                json.optInt("rewardMinutes", 0),
                JsonUtils.parseIsoMillis(json.optString("tempUnlockUntil", null)));
    }

    // ============================================================
    // 9. 屏幕行为洞察（截屏包上传 + 屏幕答题）
    // ============================================================

    /** 上传截屏包后服务端的回执。 */
    public static final class ScreenBatchAck {
        public final String batchId;
        public final int frames;
        public final String analysisStatus;
        public final String analysisProvider;
        public final String analysisNote;

        ScreenBatchAck(String batchId, int frames, String analysisStatus,
                       String analysisProvider, String analysisNote) {
            this.batchId = batchId;
            this.frames = frames;
            this.analysisStatus = analysisStatus;
            this.analysisProvider = analysisProvider;
            this.analysisNote = analysisNote;
        }
    }

    /**
     * 上传一个截屏包。
     *
     * @param zip          stored 模式的 zip（帧图 + manifest.json）
     * @param framesMeta   帧元数据，服务端会与包内图片按顺序对齐
     */
    public ScreenBatchAck uploadScreenBatch(String baseUrl, byte[] zip,
                                            String startedAtIso, String endedAtIso,
                                            JSONArray framesMeta, String agentVersion)
            throws ApiException {
        JSONObject json = client.uploadScreenBatch(
                base(baseUrl), zip, startedAtIso, endedAtIso, framesMeta, agentVersion);
        JSONObject analysis = json.optJSONObject("analysis");
        return new ScreenBatchAck(
                json.optString("batchId", ""),
                json.optInt("frames", 0),
                analysis == null ? "" : analysis.optString("status", ""),
                analysis == null ? "" : analysis.optString("provider", ""),
                analysis == null ? "" : analysis.optString("note", ""));
    }

    /**
     * 取一道基于屏幕内容的题。
     *
     * <p>响应里 {@code source} 会告诉我们这道题是来自屏幕内容还是回退到了普通题库 ——
     * 界面据此可以显示「这题来自你刚才看的内容」，对孩子更有代入感。
     */
    public static final class ScreenQuestion {
        public final String source;   // screen | bank
        public final String id;
        public final String type;
        public final String question;
        public final java.util.List<String> options;

        ScreenQuestion(String source, String id, String type, String question,
                       java.util.List<String> options) {
            this.source = source;
            this.id = id;
            this.type = type;
            this.question = question;
            this.options = options;
        }

        public boolean fromScreen() {
            return "screen".equals(source);
        }
    }

    @Nullable
    public ScreenQuestion fetchScreenQuizQuestion(String baseUrl) throws ApiException {
        JSONObject json = client.get(base(baseUrl), Constants.PATH_SCREEN_QUIZ_NEXT, null, false);
        JSONObject question = json.optJSONObject("question");
        if (question == null) return null;
        java.util.List<String> options = new java.util.ArrayList<>();
        JSONArray array = question.optJSONArray("options");
        if (array != null) {
            for (int i = 0; i < array.length(); i++) options.add(array.optString(i));
        }
        return new ScreenQuestion(
                json.optString("source", "bank"),
                question.optString("id"),
                question.optString("type", "english"),
                question.optString("question", ""),
                options);
    }

    /** 交屏幕题。判定与奖励完全在服务端做，客户端拿不到答案。 */
    public AnswerResult submitScreenQuizAnswer(String baseUrl, String questionId, int answer)
            throws ApiException {
        JSONObject body = new JSONObject();
        try {
            body.put("questionId", questionId);
            body.put("answer", answer);
        } catch (JSONException ignored) {
            // 原生类型
        }
        JSONObject json = client.post(base(baseUrl), Constants.PATH_SCREEN_QUIZ_ANSWER, body);
        return new AnswerResult(
                json.optBoolean("isCorrect", false),
                json.optInt("correctAnswer", -1),
                json.optString("explanation", ""),
                json.optInt("rewardMinutes", 0),
                JsonUtils.parseIsoMillis(json.optString("tempUnlockUntil", null)));
    }

    // ============================================================
    // 辅助
    // ============================================================

    /** 便捷方法：把一串字符串装成 JSON 数组（调试用）。 */
    /** 上报已安装应用清单（全量替换）。 */
    public void reportApps(String baseUrl,
                           java.util.List<com.balloondog.agent.capability.AppInventory.AppEntry> apps)
            throws ApiException {
        JSONArray array = new JSONArray();
        for (com.balloondog.agent.capability.AppInventory.AppEntry a : apps) {
            JSONObject o = new JSONObject();
            try {
                o.put("packageName", a.packageName);
                o.put("appName", a.appName);
                o.put("isSystem", a.isSystem);
                o.put("isLaunchable", a.isLaunchable);
            } catch (Exception ignored) {
                // 常量 key
            }
            array.put(o);
        }
        JSONObject body = new JSONObject();
        try {
            body.put("apps", array);
        } catch (Exception ignored) {
            // 常量 key
        }
        client.post(base(baseUrl), Constants.PATH_AGENT_APPS, body);
    }

    /** 批量上报设备事件。 */
    public void reportEvents(String baseUrl, JSONArray events) throws ApiException {
        JSONObject body = new JSONObject();
        try {
            body.put("events", events);
        } catch (Exception ignored) {
            // 常量 key
        }
        client.post(base(baseUrl), Constants.PATH_AGENT_EVENTS, body);
    }

    public static JSONArray toJsonArray(Iterable<String> values) {
        JSONArray array = new JSONArray();
        for (String value : values) {
            array.put(value);
        }
        return array;
    }

    // ============================================================
    // 应用审核 / 应用用量 / 通话短信（契约 §3、§4、§8）
    // ============================================================

    /**
     * 向家长发起一次安装申请（契约 §3）。
     *
     * <p>服务端对「同一设备 + 同一包名 + 仍处于 pending」做幂等 upsert：
     * 重复提交不会产生多条待审记录，返回的仍是同一条。
     */
    @NonNull
    public AuditResult submitAuditRequest(String baseUrl, String appName, String packageName)
            throws ApiException {
        JSONObject body = new JSONObject();
        try {
            body.put("appName", appName);
            body.put("packageName", packageName);
        } catch (JSONException ignored) {
            // 常量 key
        }
        JSONObject json = client.post(base(baseUrl), Constants.PATH_AGENT_AUDIT_REQUESTS, body);
        return new AuditResult(
                json.optString("id", ""),
                json.optString("status", "pending"));
    }

    /** 上报逐应用前台用量（全量替换当日，契约 §4）。 */
    public void reportAppUsage(String baseUrl, JSONArray usage) throws ApiException {
        JSONObject body = new JSONObject();
        try {
            body.put("usage", usage);
        } catch (JSONException ignored) {
            // 常量 key
        }
        client.post(base(baseUrl), Constants.PATH_AGENT_APP_USAGE, body);
    }

    /** 上报通话记录（批量全量替换最近 N 条，契约 §8）。 */
    public void reportCalls(String baseUrl, JSONArray calls) throws ApiException {
        JSONObject body = new JSONObject();
        try {
            body.put("calls", calls);
        } catch (JSONException ignored) {
            // 常量 key
        }
        client.post(base(baseUrl), Constants.PATH_AGENT_CALLS, body);
    }

    /** 上报短信（批量全量替换最近 N 条，契约 §8）。 */
    public void reportSms(String baseUrl, JSONArray sms) throws ApiException {
        JSONObject body = new JSONObject();
        try {
            body.put("sms", sms);
        } catch (JSONException ignored) {
            // 常量 key
        }
        client.post(base(baseUrl), Constants.PATH_AGENT_SMS, body);
    }

    /** 安装申请的服务端回执。 */
    public static final class AuditResult {
        public final String id;
        /** {@code pending | approved | rejected} */
        public final String status;

        AuditResult(String id, String status) {
            this.id = id;
            this.status = status;
        }
    }
}
