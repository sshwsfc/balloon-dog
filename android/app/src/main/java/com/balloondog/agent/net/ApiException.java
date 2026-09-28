package com.balloondog.agent.net;

/**
 * 后端统一错误体（{@code server/README.md` 的「错误体约定」）在客户端的映射。
 *
 * <pre>
 * {
 *   "title": "VALIDATION_ERROR",
 *   "status": 422,
 *   "message": "提交内容有 1 项未通过校验",   ← 可直接展示的中文短句
 *   "detail": "code: 验证码为 6 位数字",
 *   "errors": [{ "path": "code", "message": "..." }],
 *   "request_id": "8f3c…"
 * }
 * </pre>
 *
 * <p>{@link #userMessage} 就是服务端给的 {@code message}，界面上直接显示它，
 * 不要再自己拼「HTTP 400」这类对家长毫无意义的文案。
 */
public class ApiException extends Exception {

    /** 0 表示压根没拿到 HTTP 响应（断网 / DNS / 超时）。 */
    private final int status;
    private final String title;
    private final String userMessage;
    private final String detail;
    private final String requestId;

    public ApiException(int status, String title, String userMessage, String detail, String requestId) {
        super(userMessage);
        this.status = status;
        this.title = title;
        this.userMessage = userMessage;
        this.detail = detail;
        this.requestId = requestId;
    }

    public static ApiException network(String userMessage) {
        return new ApiException(0, "NETWORK_ERROR", userMessage, null, null);
    }

    public static ApiException timeout() {
        return new ApiException(0, "TIMEOUT", "请求超时，请检查设备网络后重试", null, null);
    }

    public int status() {
        return status;
    }

    public String title() {
        return title;
    }

    public String userMessage() {
        return userMessage;
    }

    public String detail() {
        return detail;
    }

    public String requestId() {
        return requestId;
    }

    /** 令牌失效（被解绑、被删除、所属家长被禁用）—— 调用方应重新 register 续订令牌。 */
    public boolean isUnauthorized() {
        return status == 401;
    }

    /** 设备密钥不匹配 —— 本地身份已与服务端对不上，需要用户手动重置设备身份。 */
    public boolean isDeviceSecretMismatch() {
        return status == 403;
    }

    /** 服务端地址配置错误（404 / 连不上）时的可读描述。 */
    public String describe() {
        if (status == 0) return userMessage;
        return "HTTP " + status + " " + title + "：" + userMessage;
    }
}
