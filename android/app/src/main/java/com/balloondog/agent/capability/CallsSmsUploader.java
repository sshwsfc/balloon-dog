package com.balloondog.agent.capability;

import android.content.Context;
import android.os.SystemClock;

import com.balloondog.agent.data.AgentStore;
import com.balloondog.agent.data.EventLog;
import com.balloondog.agent.model.CallLogEntry;
import com.balloondog.agent.model.SmsMessage;
import com.balloondog.agent.net.AgentApi;

import org.json.JSONArray;

import java.util.List;

/**
 * 通话记录与短信的上报（契约 §8）。
 *
 * <p>两条与「不伪造」直接相关的规矩：
 * <ol>
 *   <li><b>没权限就跳过并记日志</b>：{@code READ_CALL_LOG} / {@code READ_SMS} 是
 *       Google Play 的受限权限，得单独申报审核。拿不到就什么都不报，
 *       绝不上报一份空数据让家长以为「孩子今天没打电话」。</li>
 *   <li><b>0 条不报</b>：服务端对空数组返回 422（防止误调用清空家长可见数据），
 *       所以本地读到 0 条时直接跳过，而不是发一个空数组去撞错误。</li>
 * </ol>
 *
 * <p>另外必须说明：{@code READ_SMS} 在 Android 上只能读短信数据库，
 * 读不到 RCS/端到端加密的聊天应用内容。这条写进 README，不做「能看所有消息」的暗示。
 */
public final class CallsSmsUploader {

    private CallsSmsUploader() {
    }

    /**
     * 立即读一次通话记录与短信并上报。
     *
     * @return 给人看的中文小结（进指令回报 / 日志）
     */
    public static String upload(Context context, AgentStore store, AgentApi api) {
        StringBuilder summary = new StringBuilder();
        boolean attempted = false;

        // ---- 通话记录 ----
        if (!CallLogReader.hasPermission(context)) {
            summary.append("通话记录：未授予「读取通话记录」权限，已跳过");
        } else {
            try {
                List<CallLogEntry> entries = CallLogReader.readRecent(context);
                attempted = true;
                if (entries.isEmpty()) {
                    summary.append("通话记录：0 条，未上报");
                } else {
                    JSONArray array = new JSONArray();
                    for (CallLogEntry entry : entries) array.put(entry.toJson());
                    api.reportCalls(store.getBaseUrl(), array);
                    summary.append("通话记录：").append(entries.size()).append(" 条");
                }
            } catch (CapabilityException e) {
                summary.append("通话记录：").append(e.getMessage());
            } catch (Exception e) {
                summary.append("通话记录：上报失败（").append(e.getMessage()).append("）");
            }
        }

        summary.append("；");

        // ---- 短信 ----
        if (!SmsReader.hasPermission(context)) {
            summary.append("短信：未授予「读取短信」权限，已跳过");
        } else {
            try {
                List<SmsMessage> messages = SmsReader.readRecent(context);
                attempted = true;
                if (messages.isEmpty()) {
                    summary.append("短信：0 条，未上报");
                } else {
                    JSONArray array = new JSONArray();
                    for (SmsMessage message : messages) array.put(message.toJson());
                    api.reportSms(store.getBaseUrl(), array);
                    summary.append("短信：").append(messages.size()).append(" 条");
                }
            } catch (CapabilityException e) {
                summary.append("短信：").append(e.getMessage());
            } catch (Exception e) {
                summary.append("短信：上报失败（").append(e.getMessage()).append("）");
            }
        }

        if (attempted) store.setCallsSmsReportedAt(SystemClock.elapsedRealtime());
        EventLog.info("通话/短信上报：" + summary);
        return summary.toString();
    }
}
