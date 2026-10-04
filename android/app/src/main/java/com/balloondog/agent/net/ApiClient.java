package com.balloondog.agent.net;

import android.text.TextUtils;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;

import com.balloondog.agent.data.Constants;
import com.balloondog.agent.data.EventLog;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.IOException;
import java.net.SocketTimeoutException;
import java.net.UnknownHostException;
import java.util.concurrent.TimeUnit;

import okhttp3.MediaType;
import okhttp3.MultipartBody;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;
import okhttp3.ResponseBody;

/**
 * 与后端的 HTTP 通道。
 *
 * <p>三件事集中在这里做，避免散落到各处：
 * <ol>
 *   <li>拼 URL 与 {@code Authorization: Bearer} 头；</li>
 *   <li>把后端统一错误体翻译成 {@link ApiException}（带可直接展示的中文 {@code userMessage}）；</li>
 *   <li>区分「普通请求」与「长轮询 / 大文件上传」两套超时。</li>
 * </ol>
 *
 * <p>长轮询必须用独立的 OkHttpClient：{@code /agent/commands/next?wait=25} 会挂起 25 秒，
 * 如果复用 30 秒读超时的客户端，一旦服务端稍慢就会误判为超时。
 */
public class ApiClient {

    private static final MediaType JSON = MediaType.get("application/json; charset=utf-8");

    private static volatile ApiClient instance;

    private final OkHttpClient standardClient;
    private final OkHttpClient longPollClient;
    private final OkHttpClient uploadClient;

    /** 由 {@code AgentService} 注入：令牌失效时用来重新注册续订。 */
    private TokenProvider tokenProvider;

    public interface TokenProvider {
        @Nullable
        String deviceToken();

        /** 令牌失效（401）时调用，返回续订后的新令牌；失败返回 null。 */
        @Nullable
        String renewToken();
    }

    private ApiClient() {
        standardClient = new OkHttpClient.Builder()
                .connectTimeout(Constants.CONNECT_TIMEOUT_MS, TimeUnit.MILLISECONDS)
                .readTimeout(Constants.READ_TIMEOUT_MS, TimeUnit.MILLISECONDS)
                .writeTimeout(Constants.READ_TIMEOUT_MS, TimeUnit.MILLISECONDS)
                .retryOnConnectionFailure(true)
                .build();

        longPollClient = standardClient.newBuilder()
                .readTimeout(Constants.LONG_POLL_READ_TIMEOUT_MS, TimeUnit.MILLISECONDS)
                .build();

        uploadClient = standardClient.newBuilder()
                .writeTimeout(Constants.UPLOAD_WRITE_TIMEOUT_MS, TimeUnit.MILLISECONDS)
                .readTimeout(Constants.UPLOAD_WRITE_TIMEOUT_MS, TimeUnit.MILLISECONDS)
                .build();
    }

    public static ApiClient get() {
        if (instance == null) {
            synchronized (ApiClient.class) {
                if (instance == null) instance = new ApiClient();
            }
        }
        return instance;
    }

    public void setTokenProvider(TokenProvider provider) {
        this.tokenProvider = provider;
    }

    // ============================================================
    // 请求
    // ============================================================

    /** GET，返回解析后的 JSON；失败抛 {@link ApiException}。 */
    public JSONObject get(@NonNull String baseUrl, @NonNull String path, @Nullable String query, boolean longPoll)
            throws ApiException {
        String url = buildUrl(baseUrl, path, query);
        Request request = baseRequest(url).get().build();
        return execute(request, longPoll ? longPollClient : standardClient, true);
    }

    /** POST JSON。 */
    public JSONObject post(@NonNull String baseUrl, @NonNull String path, @Nullable JSONObject body)
            throws ApiException {
        RequestBody requestBody = body == null
                ? RequestBody.create("{}", JSON)
                : RequestBody.create(body.toString(), JSON);
        Request request = baseRequest(buildUrl(baseUrl, path, null)).post(requestBody).build();
        return execute(request, standardClient, true);
    }

    /**
     * 上传媒体（multipart/form-data）。
     *
     * <p>字段名必须是 {@code file}，并附带 {@code kind}（photo/screenshot/video/audio）
     * 与可选 {@code commandId} —— 服务端用它校验「文件类型与用途是否匹配」，
     * 并把媒体关联回产生它的那条指令。
     */
    public JSONObject uploadMedia(
            @NonNull String baseUrl,
            @NonNull byte[] bytes,
            @NonNull String filename,
            @NonNull String mimeType,
            @NonNull String kind,
            @Nullable String commandId) throws ApiException {

        MultipartBody.Builder builder = new MultipartBody.Builder()
                .setType(MultipartBody.FORM)
                .addFormDataPart("file", filename,
                        RequestBody.create(bytes, MediaType.get(mimeType)))
                .addFormDataPart("kind", kind);
        if (!TextUtils.isEmpty(commandId)) {
            builder.addFormDataPart("commandId", commandId);
        }

        Request request = baseRequest(buildUrl(baseUrl, Constants.PATH_MEDIA, null))
                .post(builder.build())
                .build();
        return execute(request, uploadClient, true);
    }

    /**
     * 上传截屏包（multipart/form-data）。
     *
     * <p>字段：{@code file}=zip，{@code startedAt} / {@code endedAt} / {@code frames}（JSON 数组）
     * / {@code agentVersion}。元数据与包内图片按顺序一一对应。
     */
    public JSONObject uploadScreenBatch(
            @NonNull String baseUrl,
            @NonNull byte[] zip,
            @NonNull String startedAtIso,
            @NonNull String endedAtIso,
            @NonNull org.json.JSONArray framesMeta,
            @NonNull String agentVersion) throws ApiException {

        MultipartBody.Builder builder = new MultipartBody.Builder()
                .setType(MultipartBody.FORM)
                .addFormDataPart("file", "screen-batch.zip",
                        RequestBody.create(zip, MediaType.get("application/zip")))
                .addFormDataPart("startedAt", startedAtIso)
                .addFormDataPart("endedAt", endedAtIso)
                .addFormDataPart("frames", framesMeta.toString())
                .addFormDataPart("agentVersion", agentVersion);

        Request request = baseRequest(buildUrl(baseUrl, Constants.PATH_SCREEN_BATCHES, null))
                .post(builder.build())
                .build();
        return execute(request, uploadClient, true);
    }

    // ============================================================
    // 内部
    // ============================================================

    private Request.Builder baseRequest(String url) {
        Request.Builder builder = new Request.Builder().url(url);
        String token = tokenProvider != null ? tokenProvider.deviceToken() : null;
        if (!TextUtils.isEmpty(token)) {
            builder.header("Authorization", "Bearer " + token);
        }
        return builder;
    }

    public static String buildUrl(String baseUrl, String path, @Nullable String query) {
        String base = baseUrl == null || baseUrl.isEmpty() ? Constants.DEFAULT_BASE_URL : baseUrl;
        while (base.endsWith("/")) {
            base = base.substring(0, base.length() - 1);
        }
        String url = base + path;
        if (!TextUtils.isEmpty(query)) {
            url = url + "?" + query;
        }
        return url;
    }

    /** 上一次真正去续订令牌的时间。 */
    private long lastRenewAt;
    /** 续订的最小间隔。 */
    private static final long RENEW_INTERVAL_MS = 30_000L;

    /**
     * 续订令牌，但带上最小间隔。
     *
     * <p>为什么必须节流：一旦出现「注册成功但令牌没能落盘」（磁盘满、prefs 文件被外部删掉等），
     * 每个请求都会 401 → 续订 → 下个请求又 401，形成注册风暴。实测见过每秒十几次
     * 「注册成功（设备已存在，令牌已续订）」把日志刷满，同时真正的业务请求全部拿不到结果。
     * 宁可让这几十秒内的请求按 401 失败（上层本来就有自己的重试节奏），
     * 也不能把服务端和自己的日志打垮。
     */
    private synchronized String renewTokenThrottled() {
        long now = android.os.SystemClock.elapsedRealtime();
        if (now - lastRenewAt < RENEW_INTERVAL_MS) {
            EventLog.warn("续订令牌过于频繁，已跳过本次（避免注册风暴）");
            return null;
        }
        lastRenewAt = now;
        return tokenProvider.renewToken();
    }

    private JSONObject execute(Request request, OkHttpClient client, boolean allowTokenRenew)
            throws ApiException {
        Response response;
        try {
            response = client.newCall(request).execute();
        } catch (SocketTimeoutException e) {
            throw ApiException.timeout();
        } catch (UnknownHostException e) {
            throw ApiException.network("无法解析服务器地址，请检查「设置」里的后端地址");
        } catch (IOException e) {
            throw ApiException.network("无法连接服务器（" + e.getMessage() + "）");
        }

        try (ResponseBody body = response.body()) {
            String text = body != null ? body.string() : "";
            int status = response.code();

            // 401 只有一次续订机会：续订后再放行，避免递归
            if (status == 401 && allowTokenRenew && tokenProvider != null) {
                EventLog.warn("设备令牌已失效，正在用设备密钥重新注册续订…");
                String renewed = renewTokenThrottled();
                if (!TextUtils.isEmpty(renewed)) {
                    Request retry = request.newBuilder()
                            .header("Authorization", "Bearer " + renewed)
                            .build();
                    return execute(retry, client, false);
                }
                // 续订被节流挡下（刚试过）：直接按 401 报错，让上层按自己的节奏重试，
                // 绝不在这里原地再打一轮 —— 那会退化成每秒十几次的注册风暴。
                throw parseError(status, text);
            }

            if (status >= 200 && status < 300) {
                if (TextUtils.isEmpty(text)) return new JSONObject();
                try {
                    return new JSONObject(text);
                } catch (JSONException e) {
                    throw new ApiException(status, "BAD_RESPONSE",
                            "服务器返回了无法解析的内容，请确认后端地址指向气球狗服务", text, null);
                }
            }

            throw parseError(status, text);
        } catch (IOException e) {
            throw ApiException.network("读取响应失败（" + e.getMessage() + "）");
        }
    }

    /** 把后端错误体翻译成 ApiException；后端没给 message 时按状态码兜底中文文案。 */
    private static ApiException parseError(int status, String text) {
        String title = "HTTP_" + status;
        String message = null;
        String detail = null;
        String requestId = null;
        try {
            JSONObject json = new JSONObject(text);
            title = json.optString("title", title);
            message = json.optString("message", null);
            detail = json.optString("detail", null);
            requestId = json.optString("request_id", null);
        } catch (JSONException ignored) {
            // 非 JSON 错误体（例如 Nginx 的 502 页面），走下面的兜底文案
        }
        if (TextUtils.isEmpty(message)) {
            message = defaultMessage(status);
        }
        return new ApiException(status, title, message, detail, requestId);
    }

    private static String defaultMessage(int status) {
        switch (status) {
            case 400: return "请求参数有误";
            case 401: return "设备令牌已失效，正在重新配对";
            case 403: return "设备密钥不匹配，请重置设备身份后重新配对";
            case 404: return "接口不存在，请检查后端地址是否正确";
            case 409: return "数据冲突，请刷新后重试";
            case 422: return "提交内容未通过校验";
            case 429: return "操作过于频繁，请稍后再试";
            case 503: return "服务暂时不可用，请稍后重试";
            default: return "服务器开小差了（HTTP " + status + "）";
        }
    }
}
