package com.balloondog.agent.capability;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

/**
 * 「本设备由家长守护」的知情说明（规划 §3.4）。
 *
 * <h3>为什么要有这一页</h3>
 * 管控类应用对孩子最容易犯的两个错：一是什么都不说（孩子只感到被锁，不知道谁锁的、
 * 为什么锁、还有多久），二是说了假话（页面上写「不采集位置」，代码里明明在采集）。
 * 第二个错更严重 —— 它把「家长在守护你」变成了「家长在骗你」。
 *
 * <p>所以这一页的规则是：**每一类敏感数据都必须有明确的一句话，要么说清会上报什么，
 * 要么说清不采集**，不允许靠沉默蒙过去。这条规则不是靠自觉，而是
 * {@link #topics()} 把它变成可断言的数据：{@code android/scripts/crosstest/run.sh}
 * 会把每个 Topic 声明的 {@code permission} 与 {@code AndroidManifest.xml} 里的真实权限
 * 逐条对照 —— 清单里加了权限而这里还写着「不采集」，测试直接红。
 *
 * <h3>它同时是「现在正在发生什么」</h3>
 * 静态说明只能回答「一般会怎样」。孩子真正想知道的是「现在」：现在在录我吗？
 * 现在在截屏吗？所以 {@link #liveLines} 按本机当前的真实开关生成状态行，
 * 与锁屏页说清「为什么锁」是同一个思路：能说准才说，不说就承认不知道。
 *
 * <p>本类是纯 Java（不 import 任何 android.*），因此可以在普通 JVM 上跑断言；
 * 读取本机开关、权限这类事由 {@code ui/GuardianInfoActivity} 做完再传进来。
 */
public final class GuardianNotice {

    private GuardianNotice() {
    }

    /** 说明页的一节：一个标题 + 若干行。 */
    public static final class Section {
        public final String heading;
        public final List<String> lines;

        Section(String heading, String... lines) {
            this.heading = heading;
            this.lines = Arrays.asList(lines);
        }
    }

    /**
     * 一类敏感数据 + 它对应哪一个系统权限。
     *
     * <p>{@code collected} 是「本应用是否真的会拿到/上报这类数据」。它必须与
     * {@code AndroidManifest.xml} 一致，由 crosstest 的第 7 步机械校验 —— 这是
     * 「说明页不许说谎」这条规则的执行方式。
     */
    public static final class Topic {
        /** 说明页里用的短名字（测试会拿它在正文中找这句话）。 */
        public final String label;
        /** 对应的系统权限；没有对应权限的用空串（本机自行产生的数据）。 */
        public final String permission;
        /** true = 会上报，false = 不采集。 */
        public final boolean collected;

        Topic(String label, String permission, boolean collected) {
            this.label = label;
            this.permission = permission;
            this.collected = collected;
        }
    }

    /**
     * 敏感数据的完整清单 —— **每一类都必须在这里出现一次**。
     *
     * <p>顺序无关，但「collected」必须与清单里的权限、以及与代码里的实际上报路径一致。
     * 新增任何采集能力时，如果不更新这里，第 7 步的校验会失败（这正是它存在的意义）。
     */
    public static List<Topic> topics() {
        List<Topic> out = new ArrayList<>();
        // ---- 真的会采集的 ----
        out.add(new Topic("位置", "android.permission.ACCESS_FINE_LOCATION", true));
        out.add(new Topic("通话记录", "android.permission.READ_CALL_LOG", true));
        out.add(new Topic("短信正文", "android.permission.READ_SMS", true));
        out.add(new Topic("相机", "android.permission.CAMERA", true));
        out.add(new Topic("麦克风", "android.permission.RECORD_AUDIO", true));
        out.add(new Topic("使用时长", "android.permission.PACKAGE_USAGE_STATS", true));
        out.add(new Topic("已安装的应用", "android.permission.QUERY_ALL_PACKAGES", true));
        out.add(new Topic("屏幕画面", "", true));
        // ---- 明确不采集的（没有对应权限就是最硬的证据） ----
        out.add(new Topic("通讯录", "android.permission.READ_CONTACTS", false));
        out.add(new Topic("相册里已有的照片", "android.permission.READ_MEDIA_IMAGES", false));
        out.add(new Topic("聊天记录", "", false));
        out.add(new Topic("键盘输入", "", false));
        out.add(new Topic("通话录音", "", false));
        return out;
    }

    /** 静态说明：为什么要装、会上报什么、不会做什么、家长/你能做什么、谁能看到、怎么解除。 */
    public static List<Section> sections() {
        List<Section> out = new ArrayList<>();

        out.add(new Section("这台设备为什么被守护",
                "家长在自己的手机上装了「气球狗」，把这台设备绑定为受守护的设备。",
                "绑定之后，家长会设置作息时间、每日可用时长、允许使用的应用与网站。",
                "这些约定要在这台设备上执行，所以本应用需要常驻运行。",
                "守护内容随时可以在本页、以及在锁定页面上看到 —— 我们不想让你猜。"));

        out.add(new Section("会上报给家长什么",
                "位置：这台设备现在和最近在哪里（家长在「行踪」里查看）。",
                "使用时长：每天用了哪些应用、各用了多久（家长在「应用管控」里查看）。",
                "已安装的应用：这台设备上装了什么，家长能看到列表。",
                "通话记录与短信正文：最近的通话与短信会同步给家长（「通话记录」「短信」）。",
                "相机与麦克风：只有家长主动发起时才会拍照或录音一次。",
                "屏幕画面：家长可以开启「周期截屏」（默认关闭），每隔一段时间拍一张低分辨率截图；"
                        + "开启后通知栏会有提示，具体状态见本页顶部。",
                "环境监听：家长可以开启一段时间的录音（默认关闭），每 5 分钟一段，"
                        + "开启期间通知栏常驻「家长开启了环境监听」，进程被杀后不会自动续录。",
                "设备状态：权限是否被关掉、守护服务是否在运行（家长在「设备健康」里看到）。"));

        out.add(new Section("不会做什么",
                "不录通话内容：通话记录只有号码、时间和时长，没有通话录音。",
                "不读聊天记录：微信、QQ 等应用的消息内容不会被读取（本应用没有通知读取权限）；"
                        + "但如果家长开了周期截屏，截图里可能拍到聊天界面 —— 这也是它默认关闭的原因。",
                "不读通讯录，也不读相册里已有的照片：本应用没有这两个权限。",
                "不记录键盘输入、不读剪贴板、不读已保存的密码。",
                "不会把你的照片、行踪、录音交给运维后台：后台只看设置和数量（比如照片占了多少空间），"
                        + "看不到内容。"));

        out.add(new Section("家长能做什么，不能做什么",
                "能：锁定设备、临时放行一段时间、限制应用与每日时长、拦截网站、出题让你答题换时长。",
                "不能：不留痕迹地操作。家长的每次锁定、放行、拍照都会写进设备「动态」，你在锁定页上"
                        + "也能看到被锁的原因和大概要等多久。",
                "不能看到别人家的数据：每个家长只能看到自己绑定的设备。"));

        out.add(new Section("你可以做什么",
                "看今天还剩多少时间：通知栏常驻通知上的「查看剩余时间」。",
                "答题赚时长：家长开启后，本页与锁定页会出现答题按钮。",
                "申请加时：把理由写给家长，家长同意后设备立刻多出一段可用时间。",
                "求助家长：一键给家长发提醒，并可以直接打开拨号盘打电话。",
                "紧急呼叫永远放行：拨号盘、来电、求助不受管控影响，这条不可关闭。"));

        out.add(new Section("谁能看到这些",
                "只有认领了这台设备的家长能看到上面那些内容。",
                "运维后台只看设置与数量，看不到照片、位置轨迹、录音和短信内容。",
                "解除绑定或删除账号后，这些数据会随账号一起删除。"));

        out.add(new Section("想解除守护怎么办",
                "需要家长在家长端把这台设备解绑，或者删除账号。",
                "家长开启了「设备所有者」时，本机无法卸载本应用 —— 这是家长刻意设置的保护。",
                "没开启设备所有者时，你可以在系统设置里卸载；但家长会立刻看到这台设备掉线。",
                "如果觉得哪里不对，先跟家长说。本页写的就是家长能看到的东西，没有藏起来的部分。"));

        return out;
    }

    /**
     * 「现在正在发生什么」—— 按本机当前的真实状态生成，不预测、不美化。
     *
     * @param captureEnabled       家长是否开了周期截屏
     * @param captureIntervalSeconds 截屏间隔（秒），仅 captureEnabled 时有意义
     * @param ambientRunning       环境监听是否正在录音
     * @param callsGranted         通话记录权限是否已授予
     * @param smsGranted           短信权限是否已授予
     * @param locationGranted      位置权限是否已授予
     * @param serviceRunning       守护服务当前是否在运行
     */
    public static List<String> liveLines(boolean captureEnabled,
                                         int captureIntervalSeconds,
                                         boolean ambientRunning,
                                         boolean callsGranted,
                                         boolean smsGranted,
                                         boolean locationGranted,
                                         boolean serviceRunning) {
        List<String> out = new ArrayList<>();
        out.add(captureEnabled
                ? "周期截屏：已开启（约每 " + Math.max(1, captureIntervalSeconds) + " 秒一张）"
                : "周期截屏：未开启");
        out.add(ambientRunning
                ? "环境监听：正在录音（通知栏有常驻提示）"
                : "环境监听：未在进行");
        out.add(locationGranted
                ? "位置上报：已授权，家长可以查看行踪"
                : "位置上报：未授权，家长现在看不到行踪（本页不会假装有数据）");
        out.add(describePhoneData(callsGranted, smsGranted));
        out.add("守护服务：" + (serviceRunning ? "运行中" : "当前没有在运行"));
        return out;
    }

    /**
     * 通话记录与短信是**两个独立权限**，一个给了一个没给是常态（部分 ROM 只放其中一个）。
     * 合成一句「已授权 / 未授权」会在半授权时说假话，所以分开算、分开说。
     */
    public static String describePhoneData(boolean calls, boolean sms) {
        if (calls && sms) {
            return "通话记录与短信：已授权，会上报给家长";
        }
        if (!calls && !sms) {
            return "通话记录与短信：未授权，现在不会上报";
        }
        return "通话记录：" + (calls ? "已授权，会上报" : "未授权，不会上报")
                + "；短信：" + (sms ? "已授权，会上报" : "未授权，不会上报");
    }

    /** 把某一节摊平成一段文本（测试与 UI 都用它，保证断言看的就是页面上的字）。 */
    public static String flatten(Section section) {
        StringBuilder sb = new StringBuilder(section.heading);
        for (String line : section.lines) {
            sb.append('\n').append(line);
        }
        return sb.toString();
    }

    /** 整页正文（含标题与状态行），供测试断言「页面上到底写了什么」。 */
    public static String everything(boolean captureEnabled,
                                    int captureIntervalSeconds,
                                    boolean ambientRunning,
                                    boolean callsGranted,
                                    boolean smsGranted,
                                    boolean locationGranted,
                                    boolean serviceRunning) {
        StringBuilder sb = new StringBuilder();
        sb.append("现在正在发生什么");
        for (String line : liveLines(captureEnabled, captureIntervalSeconds, ambientRunning,
                callsGranted, smsGranted, locationGranted, serviceRunning)) {
            sb.append('\n').append(line);
        }
        for (Section section : sections()) {
            sb.append('\n').append(flatten(section));
        }
        return sb.toString();
    }
}
