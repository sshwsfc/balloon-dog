package com.balloondog.agent.data;

import android.os.Handler;
import android.os.Looper;

import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.LinkedList;
import java.util.List;
import java.util.Locale;

/**
 * 进程内的运行日志环。
 *
 * <p>孩子设备上没法方便地看 logcat，所以把 Agent 的关键动作（注册、心跳、收到指令、
 * 执行结果、失败原因）留一份在内存里，主界面直接展示最近 200 条，
 * 家长/实施人员一眼就能看出「到底是哪一步没通」。
 */
public final class EventLog {

    private static final int MAX_LINES = 200;
    /** logcat 标签，统一便于过滤：adb logcat -s BalloonDog */
    public static final String TAG = "BalloonDog";

    private static final LinkedList<Line> LINES = new LinkedList<>();
    private static final List<Listener> LISTENERS = new ArrayList<>();
    private static final Handler MAIN = new Handler(Looper.getMainLooper());
    private static final SimpleDateFormat TIME = new SimpleDateFormat("HH:mm:ss", Locale.US);

    private EventLog() {
    }

    public interface Listener {
        void onLogLine(Line line);
    }

    public static final class Line {
        public final long timestamp;
        public final Level level;
        public final String text;

        Line(long timestamp, Level level, String text) {
            this.timestamp = timestamp;
            this.level = level;
            this.text = text;
        }

        /** "12:03:41  收到指令 [锁屏]" */
        public String render() {
            return TIME.format(new Date(timestamp)) + "  " + text;
        }
    }

    public enum Level {
        INFO, SUCCESS, WARN, ERROR
    }

    public static void info(String text) {
        add(Level.INFO, text);
    }

    public static void success(String text) {
        add(Level.SUCCESS, text);
    }

    public static void warn(String text) {
        add(Level.WARN, text);
    }

    public static void error(String text) {
        add(Level.ERROR, text);
    }

    public static synchronized void add(Level level, String text) {
        // 同步写一份到 logcat：应用内的日志环只有打开界面才看得到，
        // 而联调/线上排障往往只能通过 adb logcat 观察。两处内容完全一致。
        switch (level) {
            case SUCCESS:
                android.util.Log.i(TAG, text);
                break;
            case WARN:
                android.util.Log.w(TAG, text);
                break;
            case ERROR:
                android.util.Log.e(TAG, text);
                break;
            default:
                android.util.Log.i(TAG, text);
                break;
        }

        final Line line = new Line(System.currentTimeMillis(), level, text);
        LINES.addLast(line);
        while (LINES.size() > MAX_LINES) {
            LINES.removeFirst();
        }
        MAIN.post(() -> {
            List<Listener> snapshot;
            synchronized (EventLog.class) {
                snapshot = new ArrayList<>(LISTENERS);
            }
            for (Listener listener : snapshot) {
                listener.onLogLine(line);
            }
        });
    }

    public static synchronized List<Line> snapshot() {
        return new ArrayList<>(LINES);
    }

    public static synchronized void addListener(Listener listener) {
        LISTENERS.add(listener);
    }

    public static synchronized void removeListener(Listener listener) {
        LISTENERS.remove(listener);
    }

    public static synchronized void clear() {
        LINES.clear();
    }
}
