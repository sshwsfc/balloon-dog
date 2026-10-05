package com.balloondog.agent.capability;

import android.Manifest;
import android.content.ContentResolver;
import android.content.Context;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.provider.Telephony;

import androidx.core.content.ContextCompat;

import com.balloondog.agent.data.EventLog;
import com.balloondog.agent.model.SmsMessage;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * 读取最近短信（契约 §8）。
 *
 * <p><b>权限现实</b>：{@code READ_SMS} 同样是 Google Play 的受限权限
 * （只有默认短信应用等少数场景可上架使用）。与通话记录一样，
 * 未授权 / 被系统限制时宁可返回「没有数据」并记日志，也不伪造内容。
 *
 * <p>只读收件箱与已发送，不碰草稿/发件箱/失败记录（见 {@link SmsMessage}）。
 */
public final class SmsReader {

    public static final int MAX_ENTRIES = 200;

    private SmsReader() {
    }

    public static boolean hasPermission(Context context) {
        return ContextCompat.checkSelfPermission(context, Manifest.permission.READ_SMS)
                == PackageManager.PERMISSION_GRANTED;
    }

    /**
     * 读取最近短信（按时间倒序）。
     *
     * @throws CapabilityException 权限未授予
     */
    public static List<SmsMessage> readRecent(Context context) throws CapabilityException {
        if (!hasPermission(context)) {
            throw new CapabilityException("未授予「读取短信」权限，跳过短信上报");
        }
        ContentResolver resolver = context.getContentResolver();
        List<SmsMessage> out = new ArrayList<>();
        Cursor cursor = null;
        try {
            cursor = resolver.query(Telephony.Sms.CONTENT_URI,
                    new String[]{
                            Telephony.Sms.ADDRESS,
                            Telephony.Sms.BODY,
                            Telephony.Sms.TYPE,
                            Telephony.Sms.DATE,
                    },
                    null, null,
                    Telephony.Sms.DATE + " DESC");
            if (cursor == null) {
                EventLog.warn("短信查询返回空游标（部分系统对非默认短信应用直接不给数据）");
                return out;
            }
            int addressIndex = cursor.getColumnIndex(Telephony.Sms.ADDRESS);
            int bodyIndex = cursor.getColumnIndex(Telephony.Sms.BODY);
            int typeIndex = cursor.getColumnIndex(Telephony.Sms.TYPE);
            int dateIndex = cursor.getColumnIndex(Telephony.Sms.DATE);

            while (cursor.moveToNext() && out.size() < MAX_ENTRIES) {
                String type = mapType(cursor.getInt(typeIndex));
                if (type == null) continue;
                out.add(SmsMessage.of(
                        cursor.getString(addressIndex),
                        cursor.getString(bodyIndex),
                        type,
                        cursor.getLong(dateIndex)));
            }
        } catch (SecurityException e) {
            throw new CapabilityException("读取短信被系统拒绝：" + e.getMessage());
        } catch (Exception e) {
            throw new CapabilityException("读取短信失败：" + e.getMessage());
        } finally {
            if (cursor != null) cursor.close();
        }
        if (out.isEmpty()) {
            EventLog.warn("短信列表为空（可能确实没有，也可能是受限权限导致系统不给数据）");
        }
        return Collections.unmodifiableList(out);
    }

    private static String mapType(int systemType) {
        if (systemType == Telephony.Sms.MESSAGE_TYPE_INBOX) return "inbox";
        if (systemType == Telephony.Sms.MESSAGE_TYPE_SENT) return "sent";
        return null;
    }
}
