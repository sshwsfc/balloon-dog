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

import com.balloondog.agent.capability.ChildTasks;

import java.util.ArrayList;
import java.util.List;

/**
 * {@code /api/agent/*} 这一组设备端接口的类型化封装。
 *
 * <p>对应 server/README.md 的「设备端 Agent 协议」：
 * <table>
 *   <tr><td>POST</td><td>/agent/register</td><td>自助注册 / 续订令牌</td></tr>
 *   <tr><td>POST</td><td>/agent/heartbeat</td><td>报活（电量 / 网络 / 版本）</td></tr>
 *   <tr><td>GET</td><td>/agent/config</td><td>拉取管控策略</td></tr>
 *   <tr><td>GET</td><td>/agent/commands/next?wait=25</td><td>长轮询领指令</td></tr>
 *   <tr><td>POST</td><td>/agent/commands/:id/result</td><td>回报执行结果</td></tr>
 *   <tr><td>POST</td><td>/agent/locations</td><td>上报位置</td></tr>
 *   <tr><td>POST</td><td>/agent/media</td><td>上传媒体（multipart）</td></tr>
 *   <tr><td>GET/POST</td><td>/agent/quiz/question, /agent/quiz/answer</td><td>答题解锁</td></tr>
 *   <tr><td>GET</td><td>/agent/child-home</td><td>孩子端主页（家长的称呼 + 今天的任务）</td></tr>
 *   <tr><td>POST</td><td>/agent/sos</td><td>孩子点的求助</td></tr>
 *   <tr><td>POST</td><td>/agent/tasks/:id</td><td>勾 / 取消一条今日任务（规划 §5.2）</td></tr>
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
    // 2.5 健康快照（规划 §1 设备健康可见性）
    // ============================================================

    /**
     * 上报一份完整的健康快照（覆盖式，不是增量）。
     *
     * <p>服务端会把它与前一份合并/替换，并把「哪些开关被关了」翻译成家长端能看的清单。
     * 覆盖式的语义很重要：某条缺口修好后不再出现在 {@code gaps} 里，家长端才会消掉它。
     *
     * @return 服务端确认结果，含权威 {@code serverTime} 与它算出的等级
     */
    public JSONObject reportHealth(String baseUrl, JSONObject body) throws ApiException {
        return client.post(base(baseUrl), Constants.PATH_HEALTH, body);
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
        // 图标以 base64 塞在同一个请求里。服务端的 JSON 上限是 4MB，
        // 这里留足余量：超过 3MB 就不再带图标，宁可少几张图也不能让整份清单上报失败。
        final int iconBudgetChars = 3_000_000;
        int iconChars = 0;

        JSONArray array = new JSONArray();
        for (com.balloondog.agent.capability.AppInventory.AppEntry a : apps) {
            JSONObject o = new JSONObject();
            try {
                o.put("packageName", a.packageName);
                o.put("appName", a.appName);
                o.put("isSystem", a.isSystem);
                o.put("isLaunchable", a.isLaunchable);
                if (a.icon != null && a.icon.length > 0 && iconChars < iconBudgetChars) {
                    String encoded = android.util.Base64.encodeToString(a.icon, android.util.Base64.NO_WRAP);
                    o.put("icon", encoded);
                    iconChars += encoded.length();
                }
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

    // ============================================================
    // 孩子的申请：加时 / 延后锁屏（规划 §3.1）
    // ============================================================

    /**
     * 向家长发起一次「加时 / 延后锁屏」申请。
     *
     * <p>与安装申请同理，服务端对「同一设备 + 同一类型 + 仍处于 pending」幂等：
     * 孩子把同一份申请点两次不会在家长端堆出两条待办。
     *
     * <p>{@code reason} 可以为空 —— 「我想玩」也是有效的理由，不该因为没填就发不出去。
     */
    @NonNull
    public TimeRequestResult submitTimeRequest(String baseUrl, String kind, int minutes,
                                               @Nullable String reason) throws ApiException {
        JSONObject body = new JSONObject();
        try {
            body.put("kind", kind);
            body.put("minutes", minutes);
            if (reason != null && !reason.trim().isEmpty()) {
                body.put("reason", reason.trim());
            }
        } catch (JSONException ignored) {
            // 常量 key
        }
        JSONObject json = client.post(base(baseUrl), Constants.PATH_AGENT_TIME_REQUESTS, body);
        return TimeRequestResult.from(json, kind, minutes);
    }

    /**
     * 查一条申请的最新状态。
     *
     * <p>它只负责「把结果说清楚」：真正的解锁不依赖这个轮询 ——
     * 家长批准后服务端会下发 temp_unlock 指令，设备端的放行窗口一生效，
     * 锁定页自己就关了（见 LockScreenActivity 的每秒判定）。
     */
    @NonNull
    public TimeRequestResult getTimeRequest(String baseUrl, String id) throws ApiException {
        JSONObject json = client.get(base(baseUrl), Constants.pathTimeRequest(id), null, false);
        return TimeRequestResult.from(json, "extend_time", 0);
    }

    /**
     * 孩子端主页：这台设备是谁在守护、今天要做什么（规划 §3.2 / §5.2）。
     *
     * <p>孩子端主页上的「今天还剩多少」是**本机算的**（额度与用量都在本机，离线也算得出来）；
     * 需要服务端的只有这些 —— 家长的称呼与手机号（让孩子能一键拨出去），以及家长布置的
     * 今日任务（任务的取舍只有家长知道，本机不能猜）。
     */
    public ChildHomeResult getChildHome(String baseUrl) throws ApiException {
        JSONObject json = client.get(base(baseUrl), Constants.PATH_AGENT_CHILD_HOME, null, false);
        return ChildHomeResult.from(json);
    }

    /**
     * 孩子勾上 / 取消一条今日任务（规划 §5.2）。
     *
     * <p>这是孩子端**唯一**会改服务端数据的地方，所以把它做小：只发一个布尔值，
     * 回来的是服务端对齐后的那一条。家庭是「孩子说做完了」和「家长看到做完了」两个事实，
     * 只要 `done` 变了就由服务端决定发不发通知，本机不自己判断。
     */
    public TaskAck setTaskDone(String baseUrl, String taskId, boolean done) throws ApiException {
        JSONObject body = new JSONObject();
        try {
            body.put("done", done);
        } catch (JSONException ignored) {
            // 常量 key
        }
        JSONObject json = client.post(base(baseUrl), Constants.pathChildTask(taskId), body);
        return TaskAck.from(json);
    }

    /**
     * 孩子点的求助（规划 §3.2）。
     *
     * <p>回包里带着家长手机号，所以求助完可以顺手把拨号盘打开 ——
     * 但**能不能拨出去是系统的事**（没插 SIM 卡 / 没拨号权限时我们不假装成功，
     * 服务端那条通知已经发出去了，那才是保底通道）。
     */
    public SosResult submitSos(String baseUrl, @Nullable String message) throws ApiException {
        JSONObject body = new JSONObject();
        try {
            if (message != null && !message.trim().isEmpty()) {
                body.put("message", message.trim());
            }
        } catch (JSONException ignored) {
            // 常量 key
        }
        JSONObject json = client.post(base(baseUrl), Constants.PATH_AGENT_SOS, body);
        return SosResult.from(json);
    }

    /** {@code GET /agent/child-home} 的回执。 */
    public static final class ChildHomeResult {
        /** 设备已被家长认领。false = 没人守护（这时求助发不出去，界面要如实说）。 */
        public final boolean bound;
        public final String deviceName;
        /** 家长称呼；服务端没设昵称时为 null。 */
        public final String parentName;
        /** 家长手机号；没有时 null（可能家长账号已注销）。 */
        public final String parentPhone;
        /** 这台设备挂在哪个孩子的档案上；没挂档案时为 null（标题退回「今天的任务」）。 */
        public final String childName;
        /** 家长布置的今日任务；一条都没有时是空清单（不是 null）。 */
        public final List<ChildTasks.Task> tasks;

        public ChildHomeResult(boolean bound, String deviceName, String parentName, String parentPhone,
                               String childName, List<ChildTasks.Task> tasks) {
            this.bound = bound;
            this.deviceName = deviceName;
            this.parentName = parentName;
            this.parentPhone = parentPhone;
            this.childName = childName;
            this.tasks = tasks;
        }

        static ChildHomeResult from(JSONObject json) {
            return new ChildHomeResult(
                    json.optBoolean("bound", false),
                    json.optString("deviceName", ""),
                    json.isNull("parentName") ? null : json.optString("parentName", null),
                    json.isNull("parentPhone") ? null : json.optString("parentPhone", null),
                    json.isNull("childName") ? null : json.optString("childName", null),
                    parseTasks(json.optJSONArray("tasks")));
        }
    }

    /** {@code POST /agent/tasks/:id} 的回执。 */
    public static final class TaskAck {
        public final boolean success;
        /** 服务端对齐后的那一条；回包里没有 task 时为 null（界面就沿用本地的乐观值）。 */
        public final ChildTasks.Task task;

        public TaskAck(boolean success, ChildTasks.Task task) {
            this.success = success;
            this.task = task;
        }

        static TaskAck from(JSONObject json) {
            return new TaskAck(json.optBoolean("success", false), parseTask(json.optJSONObject("task")));
        }
    }

    /**
     * 解析今日任务清单。
     *
     * <p>缺 id 或缺标题的行**直接丢掉**：一条点不动的任务比少一条任务更让人困惑
     * （点不动的时候孩子只会以为是自己没点到）。服务端从不下发这种行，这里只是不让
     * 一个坏字段把整块清单带崩。
     */
    static List<ChildTasks.Task> parseTasks(@Nullable JSONArray array) {
        List<ChildTasks.Task> tasks = new ArrayList<>();
        if (array == null) return tasks;
        for (int i = 0; i < array.length(); i++) {
            ChildTasks.Task task = parseTask(array.optJSONObject(i));
            if (task != null) tasks.add(task);
        }
        return tasks;
    }

    @Nullable
    static ChildTasks.Task parseTask(@Nullable JSONObject json) {
        if (json == null) return null;
        String id = json.optString("id", "");
        String title = json.optString("title", "");
        if (TextUtils.isEmpty(id) || TextUtils.isEmpty(title)) return null;
        return new ChildTasks.Task(id, title, json.optBoolean("done", false));
    }

    /** {@code POST /agent/sos} 的回执。 */
    public static final class SosResult {
        /** 真的通知到家长了。false = 没人守护（reason=unbound），**不是**「成功了但你没看见」。 */
        public final boolean success;
        public final String parentPhone;
        public final String reason;

        public SosResult(boolean success, String parentPhone, String reason) {
            this.success = success;
            this.parentPhone = parentPhone;
            this.reason = reason;
        }

        static SosResult from(JSONObject json) {
            return new SosResult(
                    json.optBoolean("success", false),
                    json.isNull("parentPhone") ? null : json.optString("parentPhone", null),
                    json.optString("reason", ""));
        }
    }

    /** 加时 / 延后锁屏申请的回执。 */
    public static final class TimeRequestResult {
        public final String id;
        /** {@code extend_time | delay_lock} */
        public final String kind;
        /** 已解析的分钟数：未审批时是孩子申请的，批准后是家长实际给的。 */
        public final int minutes;
        /** {@code pending | approved | rejected} */
        public final String status;
        /** 家长留的话（拒绝时最有用）。空串表示没留。 */
        public final String note;

        public TimeRequestResult(String id, String kind, int minutes, String status, String note) {
            this.id = id;
            this.kind = kind;
            this.minutes = minutes;
            this.status = status;
            this.note = note;
        }

        /**
         * 服务端两个接口返回的字段并不完全一样（新建只回 id/status/minutes，
         * 查询回 status/minutes/note），缺的用提交时的本地值兜底。
         */
        static TimeRequestResult from(JSONObject json, String fallbackKind, int fallbackMinutes) {
            return new TimeRequestResult(
                    json.optString("id", ""),
                    json.optString("kind", fallbackKind),
                    json.optInt("minutes", fallbackMinutes),
                    json.optString("status", "pending"),
                    json.optString("note", ""));
        }

        public boolean isPending() {
            return "pending".equals(status);
        }
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
