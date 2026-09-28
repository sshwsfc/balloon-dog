package com.balloondog.agent.capability;

/**
 * 设备能力执行失败。
 *
 * <p>message 会被原样写进指令结果的 {@code error} 字段（服务端限制 500 字符），
 * 家长端在「指令历史」里直接看到它，所以必须是能看懂的中文原因，
 * 例如「相机权限未授予」「需要先激活设备管理器」「屏幕录制授权被拒绝」。
 */
public class CapabilityException extends Exception {

    public CapabilityException(String message) {
        super(message);
    }

    public CapabilityException(String message, Throwable cause) {
        super(message, cause);
    }
}
