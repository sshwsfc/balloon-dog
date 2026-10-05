package com.balloondog.agent.capability;

import android.Manifest;
import android.content.ContentResolver;
import android.content.Context;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.provider.CallLog;

import androidx.core.content.ContextCompat;

import com.balloondog.agent.data.EventLog;
import com.balloondog.agent.model.CallLogEntry;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * 读取最近通话记录（契约 §8）。
 *
 * <p><b>权限现实</b>：{@code READ_CALL_LOG} 是 Google Play 的<b>受限权限</b>，
 * 只有「默认电话/短信应用」类应用才能上架使用；Android 10 起系统对非默认应用
 * 直接返回空结果（不报错，就是查不到）。所以这里的失败模式是「静默拿到 0 条」——
 * 因此没有数据时也要记一条日志，避免家长端显示空白却看不出原因。
 *
 * <p>只读不写：{@code CallLog.Calls.CONTENT_URI} 全程只 query。
 */
public final class CallLogReader {

    /** 单次最多上报多少条：够家长看最近一段时间的来往，也不至于把请求撑爆。 */
    public static final int MAX_ENTRIES = 200;

    private CallLogReader() {
    }

    public static boolean hasPermission(Context context) {
        return ContextCompat.checkSelfPermission(context, Manifest.permission.READ_CALL_LOG)
                == PackageManager.PERMISSION_GRANTED;
    }

    /**
     * 读取最近通话记录（按时间倒序）。
     *
     * @throws CapabilityException 权限未授予 —— 由调用方如实记日志并跳过，
     *                             <b>不返回空列表冒充「没有记录」</b>
     */
    public static List<CallLogEntry> readRecent(Context context) throws CapabilityException {
        if (!hasPermission(context)) {
            throw new CapabilityException("未授予「读取通话记录」权限，跳过通话记录上报");
        }
        ContentResolver resolver = context.getContentResolver();
        List<CallLogEntry> out = new ArrayList<>();
        Cursor cursor = null;
        try {
            cursor = resolver.query(CallLog.Calls.CONTENT_URI,
                    new String[]{
                            CallLog.Calls.NUMBER,
                            CallLog.Calls.CACHED_NAME,
                            CallLog.Calls.TYPE,
                            CallLog.Calls.DURATION,
                            CallLog.Calls.DATE,
                    },
                    null, null,
                    CallLog.Calls.DATE + " DESC");
            if (cursor == null) {
                EventLog.warn("通话记录查询返回空游标（部分系统对非默认电话应用直接不给数据）");
                return out;
            }
            int numberIndex = cursor.getColumnIndex(CallLog.Calls.NUMBER);
            int nameIndex = cursor.getColumnIndex(CallLog.Calls.CACHED_NAME);
            int typeIndex = cursor.getColumnIndex(CallLog.Calls.TYPE);
            int durationIndex = cursor.getColumnIndex(CallLog.Calls.DURATION);
            int dateIndex = cursor.getColumnIndex(CallLog.Calls.DATE);

            while (cursor.moveToNext() && out.size() < MAX_ENTRIES) {
                String type = mapType(cursor.getInt(typeIndex));
                if (type == null) continue; // 系统里的其它类型（拒接/语音信箱等）不上报
                out.add(CallLogEntry.of(
                        cursor.getString(numberIndex),
                        nameIndex >= 0 ? cursor.getString(nameIndex) : null,
                        type,
                        Math.max(0, cursor.getInt(durationIndex)),
                        cursor.getLong(dateIndex)));
            }
        } catch (SecurityException e) {
            throw new CapabilityException("读取通话记录被系统拒绝：" + e.getMessage());
        } catch (Exception e) {
            throw new CapabilityException("读取通话记录失败：" + e.getMessage());
        } finally {
            if (cursor != null) cursor.close();
        }
        if (out.isEmpty()) {
            EventLog.warn("通话记录为空（可能确实没有，也可能是受限权限导致系统不给数据）");
        }
        return Collections.unmodifiableList(out);
    }

    /** 系统类型 → 契约里的三值枚举；不认识的一律返回 null（丢弃，不猜）。 */
    private static String mapType(int systemType) {
        switch (systemType) {
            case CallLog.Calls.INCOMING_TYPE:
                return "incoming";
            case CallLog.Calls.OUTGOING_TYPE:
                return "outgoing";
            case CallLog.Calls.MISSED_TYPE:
                return "missed";
            default:
                return null;
        }
    }
}
