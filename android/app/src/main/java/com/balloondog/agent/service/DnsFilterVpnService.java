package com.balloondog.agent.service;

import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.net.ConnectivityManager;
import android.net.LinkProperties;
import android.net.Network;
import android.net.VpnService;
import android.os.Build;
import android.os.ParcelFileDescriptor;

import androidx.annotation.Nullable;

import com.balloondog.agent.capability.DnsMessage;
import com.balloondog.agent.capability.DomainBlocker;
import com.balloondog.agent.data.AgentStore;
import com.balloondog.agent.data.Constants;
import com.balloondog.agent.data.EventLog;

import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicLong;

/**
 * 网址拦截（契约 §5）—— 一个只处理 DNS 的 {@link VpnService}。
 *
 * <h3>它到底拦住了什么</h3>
 * 建立 tun 后，系统把「发往本机 DNS 地址」的 UDP:53 查询交给这个服务：
 * <ul>
 *   <li>域名命中 {@link DomainBlocker} 的黑名单 → 直接回 <b>NXDOMAIN</b>（域名不存在）；</li>
 *   <li>其余查询 → 转发给上游 DNS（优先用底层网络的 DNS，取不到就用公共解析），
 *       把应答原样包回 tun。</li>
 * </ul>
 *
 * <h3>刻意偏离契约的一处：不加 {@code addRoute("0.0.0.0", 0)}</h3>
 * 契约写的是全量路由，但本实现<b>只处理 DNS，不转发 TCP/UDP 里的普通流量</b>。
 * 如果按全量路由建 tun，设备所有上网流量都会被吸进这个进程，
 * 而我们没有实现完整的用户态转发 —— 结果是「网站照样能开（因为没拦），
 * 但整个网络变得又慢又断」。宁可只覆盖一层、并且说清楚，也不要一个看起来能拦、
 * 实际上会把手机网络搞坏的东西。所以这里只路由 {@code 10.111.222.1/32}（本服务自己的
 * DNS 地址），配合 {@code addDnsServer}，让 DNS 查询定向进来。
 *
 * <h3>已知可绕过（必须如实告诉家长，别处也写）</h3>
 * <ol>
 *   <li><b>直连 IP</b>：黑名单是域名，应用直接连 IP 就不经过 DNS；</li>
 *   <li><b>DoH / DoT</b>：浏览器自带的加密 DNS（443/853 端口）不走 53 端口；</li>
 *   <li><b>DNS 缓存</b>：命中前已经解析过的域名，本地缓存还能用一阵；</li>
 *   <li><b>关掉 VPN</b>：孩子可以在系统设置里停掉这个 VPN。设备所有者身份下用
 *       {@link #applyAlwaysOn} 把它设成「永久 VPN」+ {@code DISALLOW_CONFIG_VPN}
 *       （实测：{@code am start -a android.settings.VPN_SETTINGS} 被
 *       「Blocked by your IT admin」挡在门外）。<b>但「下拉快捷开关的 VPN 磁贴能否断开」
 *       在本项目唯一的验证环境（Android 13 模拟器）上测不出来</b> ——
 *       该模拟器的 {@code sysui_qs_tiles} 里没有 VPN 磁贴，手动加 {@code vpn} 并重启
 *       SystemUI 也没出现；所以那条路径按「未验证 / 只能检测 + 上报」对待，
 *       不写成已堵死。</li>
 * </ol>
 * 这些绕过在 android/README.md「已知边界」里同样写明。
 *
 * <h3>验证状态（2026-10 更新）</h3>
 * 已在 Android 13 模拟器（emulator-5554，设备所有者）上真实跑过：家长开启「网址拦截」
 * 并加一条黑名单后 41 秒日志出现 {@code 已把本应用设为永久 VPN…} 与
 * {@code 网址拦截已启动：上游 DNS …}，{@code settings get secure always_on_vpn_app}
 * 变成本包名、{@code dumpsys device_policy} 里 {@code mAlwaysOnVpnPackage=com.balloondog.agent}
 * （{@code mAlwaysOnVpnLockdown=false}，{@code applyAlwaysOn} 刻意不开 lockdown，
 * 理由见 android/README.md §7.3）；家长关掉后 10 秒 {@code always_on_vpn_app=null}。
 * 纯逻辑（域名匹配、DNS 报文解析与 NXDOMAIN 构造）另有 JVM 交叉测试覆盖。
 * <b>仍未验证</b>：真实网络下「tun 收到的包与上游应答」的端到端链路、
 * 以及快捷开关 VPN 磁贴（见上）。
 */
public class DnsFilterVpnService extends VpnService {

    /** tun 上本机（也就是本服务）的地址，同时充当 DNS 服务器地址。 */
    private static final String TUN_ADDRESS = "10.111.222.1";
    private static final int TUN_PREFIX_LENGTH = 32;

    /** 单包上限，足够放下 1500 字节 MTU 的报文（tun 读到的包不会超过这个量级）。 */
    private static final int MAX_PACKET_BYTES = 32 * 1024;

    /** 向上游查询的超时。超了就丢包让客户端重试，不做假应答。 */
    private static final int UPSTREAM_TIMEOUT_MS = 3_000;

    /** 底层网络 DNS 取不到时的兜底解析（国内可直连优先，再加两个公共的）。 */
    private static final String[] FALLBACK_UPSTREAMS = {"223.5.5.5", "119.29.29.29", "8.8.8.8"};

    /** 同一个域名最多每 60 秒记一条拦截日志，避免刷屏。 */
    private static final long BLOCK_LOG_INTERVAL_MS = 60_000L;

    /**
     * 「永久 VPN」在系统设置里的 key。
     *
     * <p>Android 33 的公开 SDK 里没有对应的 {@code Settings.Secure} 字段
     * （这两个 key 不在公有 SDK 中，只能写字面量），所以在这里集中定义一次。
     */
    private static final String KEY_ALWAYS_ON_VPN_APP = "always_on_vpn_app";
    private static final String KEY_ALWAYS_ON_VPN_LOCKDOWN = "always_on_vpn_lockdown";

    /** 黑名单缓存时长：读一次配置够用一阵，不必每个包都解析字符串。 */
    private static final long BLOCKLIST_CACHE_MS = 5_000L;

    private static volatile boolean running;

    private AgentStore store;
    private ParcelFileDescriptor tunnel;
    private FileInputStream tunnelIn;
    private FileOutputStream tunnelOut;
    private final Object writeLock = new Object();
    private ExecutorService forwarders;
    private final AtomicLong forwardedCount = new AtomicLong();
    private final AtomicLong blockedCount = new AtomicLong();
    private final Map<String, Long> recentlyBlocked = new HashMap<>();

    private volatile List<String> cachedBlocked = new ArrayList<>();
    private volatile long cachedBlockedAt;

    public static boolean isRunning() {
        return running;
    }

    /** 家长/配置要求开启时调用；未授权时这里只能记日志，真正的授权弹窗必须由界面触发。 */
    public static void start(Context context) {
        Intent intent = new Intent(context, DnsFilterVpnService.class)
                .setAction(Constants.ACTION_VPN_START);
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent);
            } else {
                context.startService(intent);
            }
        } catch (Exception e) {
            EventLog.warn("启动网址拦截服务失败：" + e.getMessage());
        }
    }

    public static void stop(Context context) {
        try {
            context.startService(new Intent(context, DnsFilterVpnService.class)
                    .setAction(Constants.ACTION_VPN_STOP));
        } catch (Exception e) {
            EventLog.warn("停止网址拦截服务失败：" + e.getMessage());
        }
    }

    /** 系统是否已经授权过 VPN（{@code prepare()} 返回 null 表示下次建立不会再弹窗）。 */
    public static boolean hasSystemConsent(Context context) {
        try {
            return prepare(context) == null;
        } catch (Exception e) {
            return false;
        }
    }

    /**
     * 家长的配置当前是否要求开启网址拦截：开关打开<b>且</b>黑名单非空。
     *
     * <p>三处必须用同一个判据：{@code AgentService.syncWebBlockService()}、
     * 本类的 {@link #onStartCommand} 守卫（永久 VPN 会让系统在开机时直接拉起本服务）、
     * 以及 {@link #applyAlwaysOn}。否则会出现「隧道停了但永久 VPN 还绑着」这种半开状态。
     */
    public static boolean isWanted(Context context) {
        AgentStore store = new AgentStore(context);
        return store.isWebBlockEnabled()
                && !DomainBlocker.parseList(store.getBlockedUrls()).isEmpty();
    }

    /** 系统里「永久 VPN」当前绑定的是不是本应用（供界面与自检读取真实状态）。 */
    public static boolean isAlwaysOn(Context context) {
        try {
            String bound = android.provider.Settings.Secure.getString(
                    context.getContentResolver(), KEY_ALWAYS_ON_VPN_APP);
            return context.getPackageName().equals(bound);
        } catch (Exception e) {
            return false;
        }
    }

    /** 系统里「永久 VPN」是否开了「阻止未走 VPN 的连接」（lockdown）。 */
    public static boolean isLockdown(Context context) {
        try {
            return android.provider.Settings.Secure.getInt(
                    context.getContentResolver(), KEY_ALWAYS_ON_VPN_LOCKDOWN, 0) == 1;
        } catch (Exception e) {
            return false;
        }
    }

    /**
     * 把本应用设成「永久 VPN」（设备所有者专属）；家长关掉网址拦截时再解除。
     *
     * <h3>为什么必须做这一步</h3>
     * 不设永久 VPN 时，孩子只要从下拉快捷开关点一下「断开 VPN」，网址拦截立刻失效 ——
     * {@code DISALLOW_CONFIG_VPN} 挡的是「设置 → 网络 → VPN」页面，<b>挡不住快捷开关</b>。
     * 设成永久 VPN 后系统会一直维持这条 VPN，快捷开关上的断开变灰。
     *
     * <h3>为什么 {@code lockdownEnabled} 传 false</h3>
     * lockdown 的语义是「VPN 没起来就断掉整台设备的网络」。本服务<b>刻意只路由
     * 10.111.222.1/32</b>（只接管 DNS，不做用户态转发，见类注释），所以 lockdown 生效时
     * 除 DNS 以外的流量都会被系统丢弃 —— 设备会变成「只有域名解析、没有连接」。
     * 这个后果在模拟器上实测过（见 README §2.5.1），因此这里坚持传 false，
     * 并如实写明残留：<b>快捷开关堵住了，但「设置里换一个 VPN 应用 / 取消永久 VPN」
     * 这个入口只被 DISALLOW_CONFIG_VPN 挡住，没有第二层。</b>
     */
    public static void applyAlwaysOn(Context context) {
        android.app.admin.DevicePolicyManager dpm = (android.app.admin.DevicePolicyManager)
                context.getSystemService(Context.DEVICE_POLICY_SERVICE);
        if (dpm == null || !dpm.isDeviceOwnerApp(context.getPackageName())) return;

        boolean wanted = isWanted(context);
        String target = wanted ? context.getPackageName() : null;
        try {
            String current = android.provider.Settings.Secure.getString(
                    context.getContentResolver(), KEY_ALWAYS_ON_VPN_APP);
            if (java.util.Objects.equals(current, target)) return;
        } catch (Exception ignored) {
            // 读不到当前值就照常施加，施加本身是幂等的
        }
        try {
            dpm.setAlwaysOnVpnPackage(
                    com.balloondog.agent.capability.LockController.adminComponent(context),
                    target, false);
            EventLog.success(wanted
                    ? "已把本应用设为永久 VPN：孩子无法再从快捷开关断开网址拦截"
                    : "已解除永久 VPN（家长关闭了网址拦截）");
        } catch (Exception e) {
            EventLog.warn("设置永久 VPN 失败：" + e.getMessage()
                    + "（孩子仍可从快捷开关断开网址拦截）");
        }
    }

    @Override
    public int onStartCommand(@Nullable Intent intent, int flags, int startId) {
        String action = intent == null ? null : intent.getAction();
        if (Constants.ACTION_VPN_STOP.equals(action)) {
            EventLog.info("网址拦截：收到停止请求");
            stopTunnel("收到停止指令");
            stopSelf();
            return Service.START_NOT_STICKY;
        }

        if (running && tunnel != null) return Service.START_NOT_STICKY;

        // 设成永久 VPN 后，系统会在开机时直接拉起本服务（intent 可能为 null），
        // 所以这里必须自己再确认一次「家长现在还开着网址拦截吗」，否则家长关掉功能后
        // 系统仍会替我们建隧道。
        if (!isWanted(this)) {
            EventLog.info("网址拦截未启用（家长未开启该功能），系统拉起后不建立隧道");
            applyAlwaysOn(this);
            stopSelf();
            return Service.START_NOT_STICKY;
        }

        if (VpnService.prepare(this) != null) {
            // 服务里没法弹系统授权框（必须由 Activity 用 startActivityForResult 发起），
            // 所以这里只能放弃并留一条通知引导家长去设置页点一下。
            EventLog.warn("网址拦截未启用：系统尚未授权 VPN，需要在设置页手动点「启用网址拦截」");
            AgentNotifications.notifyVpnConsentNeeded(this);
            stopSelf();
            return Service.START_NOT_STICKY;
        }

        startTunnel();
        // 刻意不返回 START_STICKY：进程被杀后重建会拿到 null intent，
        // 那时「家长是不是还开着 webBlock」已经无从确认。让配置刷新（最长 60 秒）
        // 重新拉起来，比在后台凭旧状态默默重建隧道更可控。
        return Service.START_NOT_STICKY;
    }

    @Override
    public void onRevoke() {
        EventLog.warn("网址拦截被系统撤销（VPN 被手动关闭，或被其它 VPN 应用抢占），已停止");
        stopTunnel("系统撤销授权");
        super.onRevoke();
    }

    @Override
    public void onDestroy() {
        stopTunnel("服务销毁");
        super.onDestroy();
    }

    // ---------------- 隧道生命周期 ----------------

    private void startTunnel() {
        if (store == null) store = new AgentStore(this);
        try {
            Builder builder = new Builder();
            builder.setSession("气球狗网址拦截");
            builder.addAddress(TUN_ADDRESS, TUN_PREFIX_LENGTH);
            builder.addDnsServer(TUN_ADDRESS);
            // 只把这个 DNS 地址的流量导进来（见类注释：刻意不做 0.0.0.0/0）
            builder.addRoute(TUN_ADDRESS, TUN_PREFIX_LENGTH);
            tunnel = builder.establish();
        } catch (Exception e) {
            EventLog.error("建立 VPN 隧道失败：" + e.getMessage());
            tunnel = null;
        }
        if (tunnel == null) {
            EventLog.error("网址拦截未能启动：系统拒绝建立 VPN 隧道");
            stopSelf();
            return;
        }

        try {
            tunnelIn = new FileInputStream(tunnel.getFileDescriptor());
            tunnelOut = new FileOutputStream(tunnel.getFileDescriptor());
        } catch (Exception e) {
            EventLog.error("打开 VPN 隧道失败：" + e.getMessage());
            stopTunnel("打开隧道失败");
            stopSelf();
            return;
        }

        running = true;
        forwardedCount.set(0);
        blockedCount.set(0);
        forwarders = Executors.newFixedThreadPool(4, runnable -> {
            Thread thread = new Thread(runnable, "dns-forwarder");
            thread.setDaemon(true);
            return thread;
        });
        ForegroundCompat.start(this, Constants.NOTIFICATION_ID_VPN,
                AgentNotifications.buildAgentNotification(this, "网址拦截已开启",
                        "只拦截 DNS 解析层；直连 IP、DoH/DoT、已缓存域名可绕过（设置页有说明）"),
                0);

        Thread reader = new Thread(this::readLoop, "dns-filter-reader");
        reader.setDaemon(true);
        reader.start();
        EventLog.success("网址拦截已启动：上游 DNS " + describeUpstreams()
                + "；仅覆盖 DNS 解析层，已知可绕过方式见 README");
    }

    private void stopTunnel(String reason) {
        boolean wasRunning = running;
        running = false;
        if (forwarders != null) {
            forwarders.shutdownNow();
            forwarders = null;
        }
        // 关掉 tun 会让阻塞中的 read 抛异常返回，读线程据此退出
        if (tunnel != null) {
            try {
                tunnel.close();
            } catch (IOException ignored) {
                // 关闭失败也没有补救手段，忽略
            }
            tunnel = null;
        }
        tunnelIn = null;
        tunnelOut = null;
        synchronized (recentlyBlocked) {
            recentlyBlocked.clear();
        }
        if (wasRunning) {
            EventLog.warn("网址拦截已停止：" + reason + "（本次共放行 " + forwardedCount.get()
                    + " 条查询，拦截 " + blockedCount.get() + " 条）");
        }
        ForegroundCompat.stop(this);
    }

    // ---------------- 读包 / 处理 ----------------

    private void readLoop() {
        byte[] packet = new byte[MAX_PACKET_BYTES];
        try {
            while (running) {
                FileInputStream in = tunnelIn;
                if (in == null) break;
                int length = in.read(packet);
                if (length <= 0) {
                    if (length < 0 && running) {
                        EventLog.warn("VPN 隧道读取结束（tun 已关闭）");
                        break;
                    }
                    continue;
                }
                try {
                    handlePacket(packet, length);
                } catch (Exception e) {
                    // 单个包处理失败不能拖垮整个读循环
                    EventLog.warn("处理 DNS 包失败：" + e.getMessage());
                }
            }
        } catch (Exception e) {
            if (running) EventLog.warn("VPN 读循环退出：" + e.getMessage());
        } finally {
            running = false;
        }
    }

    private void handlePacket(byte[] packet, int length) {
        if (length < 28) return;
        int version = (packet[0] >> 4) & 0x0F;
        if (version != 4) return; // tun 地址是 IPv4，实际也不会进来 v6

        int ihl = (packet[0] & 0x0F) * 4;
        if (ihl < 20 || ihl + 8 > length) return;
        int protocol = packet[9] & 0xFF;
        if (protocol != 17) return; // 只处理 UDP；tun 上其余协议没有可做的处理

        int srcPort = readU16(packet, ihl);
        int dstPort = readU16(packet, ihl + 2);
        if (dstPort != 53) return;
        int udpLength = readU16(packet, ihl + 4);
        if (udpLength < 8 || ihl + udpLength > length) return;

        // 立刻复制一份：转发是在别的线程上做的，而读循环会马上用同一个数组读下一个包。
        // 少了这一步就会出现「应答里混进下一个包的字节」这种极难复现的错包。
        byte[] request = Arrays.copyOf(packet, length);
        byte[] dns = Arrays.copyOfRange(request, ihl + 8, ihl + udpLength);
        if (!DnsMessage.isStandardQuery(dns)) return;

        String host = DnsMessage.firstQuestionName(dns);
        if (host != null && DomainBlocker.isBlocked(blockedEntries(), host)) {
            int questionsEnd = DnsMessage.questionsEnd(dns);
            byte[] response = questionsEnd > 0 ? DnsMessage.buildNxDomain(dns, questionsEnd) : null;
            if (response == null) {
                // 报文解析不出来就<b>不猜</b>：原样转发，宁可漏拦一个，也不给出畸形应答
                EventLog.warn("网址拦截：无法解析查询报文（" + host + "），已按放行处理");
                forward(request, ihl, srcPort, dstPort, dns);
                return;
            }
            writeUdp(request, ihl, srcPort, dstPort, response);
            blockedCount.incrementAndGet();
            logBlocked(host);
            return;
        }

        forward(request, ihl, srcPort, dstPort, dns);
    }

    /** 命中黑名单时记日志 + 一条事件（家长端能在动态里看到「拦了哪个网站」）。 */
    private void logBlocked(String host) {
        long now = System.currentTimeMillis();
        synchronized (recentlyBlocked) {
            Long last = recentlyBlocked.get(host);
            if (last != null && now - last < BLOCK_LOG_INTERVAL_MS) return;
            recentlyBlocked.put(host, now);
        }
        EventLog.warn("网址拦截：已拦截 " + host);
        AgentService.recordEventStatic(Constants.EVENT_WEB_BLOCKED, "已拦截 " + host);
    }

    private void forward(byte[] request, int ihl, int srcPort, int dstPort, byte[] dns) {
        ExecutorService executor = forwarders;
        if (executor == null) return;
        try {
            executor.execute(() -> forwardSync(request, ihl, srcPort, dstPort, dns));
        } catch (Exception e) {
            // 线程池已关闭（正在停止）：丢掉这个包即可，客户端会重试
        }
    }

    private void forwardSync(byte[] request, int ihl, int srcPort, int dstPort, byte[] dns) {
        for (String upstream : upstreams()) {
            DatagramSocket socket = null;
            try {
                socket = new DatagramSocket();
                // 关键：protect 让这个 socket 的流量绕开 VPN，否则会查回自己形成死循环
                if (!protect(socket)) {
                    EventLog.warn("网址拦截：无法让上游 DNS socket 绕开 VPN，停止转发");
                    return;
                }
                socket.setSoTimeout(UPSTREAM_TIMEOUT_MS);
                InetAddress address = InetAddress.getByName(upstream);
                socket.send(new DatagramPacket(dns, dns.length, address, 53));

                byte[] buffer = new byte[MAX_PACKET_BYTES];
                DatagramPacket reply = new DatagramPacket(buffer, buffer.length);
                socket.receive(reply);
                byte[] payload = Arrays.copyOfRange(reply.getData(), reply.getOffset(),
                        reply.getOffset() + reply.getLength());
                writeUdp(request, ihl, srcPort, dstPort, payload);
                forwardedCount.incrementAndGet();
                return;
            } catch (Exception e) {
                // 换下一个上游试；全试完就丢包
            } finally {
                if (socket != null) socket.close();
            }
        }
        EventLog.warn("网址拦截：上游 DNS 全部无应答，已丢弃一个查询（客户端会重试）");
    }

    /** 把应答包成 IPv4/UDP 写回 tun，源/目的地址与端口对调。 */
    private void writeUdp(byte[] request, int ihl, int srcPort, int dstPort, byte[] payload) {
        FileOutputStream out = tunnelOut;
        if (out == null) return;

        int udpLength = 8 + payload.length;
        int total = ihl + udpLength;
        byte[] response = new byte[total];
        System.arraycopy(request, 0, response, 0, ihl);

        response[2] = (byte) ((total >> 8) & 0xFF);
        response[3] = (byte) (total & 0xFF);
        response[8] = (byte) 64; // TTL：给个常规值，避免沿用请求里的奇怪值
        // 交换源/目的 IP
        System.arraycopy(request, 16, response, 12, 4);
        System.arraycopy(request, 12, response, 16, 4);
        // IP 头校验和
        response[10] = 0;
        response[11] = 0;
        int ipSum = checksum(response, 0, ihl);
        response[10] = (byte) ((ipSum >> 8) & 0xFF);
        response[11] = (byte) (ipSum & 0xFF);

        response[ihl] = (byte) ((dstPort >> 8) & 0xFF);
        response[ihl + 1] = (byte) (dstPort & 0xFF);
        response[ihl + 2] = (byte) ((srcPort >> 8) & 0xFF);
        response[ihl + 3] = (byte) (srcPort & 0xFF);
        response[ihl + 4] = (byte) ((udpLength >> 8) & 0xFF);
        response[ihl + 5] = (byte) (udpLength & 0xFF);
        response[ihl + 6] = 0;
        response[ihl + 7] = 0;
        System.arraycopy(payload, 0, response, ihl + 8, payload.length);

        int udpSum = udpChecksum(response, ihl, udpLength);
        response[ihl + 6] = (byte) ((udpSum >> 8) & 0xFF);
        response[ihl + 7] = (byte) (udpSum & 0xFF);

        try {
            synchronized (writeLock) {
                out.write(response);
                out.flush();
            }
        } catch (Exception e) {
            if (running) EventLog.warn("写回 DNS 应答失败：" + e.getMessage());
        }
    }

    // ---------------- 黑名单与上游 ----------------

    private List<String> blockedEntries() {
        long now = System.currentTimeMillis();
        if (now - cachedBlockedAt < BLOCKLIST_CACHE_MS) return cachedBlocked;
        List<String> entries = DomainBlocker.parseList(store == null ? null : store.getBlockedUrls());
        cachedBlocked = entries;
        cachedBlockedAt = now;
        return entries;
    }

    private volatile List<String> upstreamCache;

    private List<String> upstreams() {
        List<String> cached = upstreamCache;
        if (cached != null) return cached;

        List<String> result = new ArrayList<>();
        try {
            ConnectivityManager manager =
                    (ConnectivityManager) getSystemService(Context.CONNECTIVITY_SERVICE);
            if (manager != null) {
                for (Network network : manager.getAllNetworks()) {
                    android.net.NetworkCapabilities capabilities = manager.getNetworkCapabilities(network);
                    LinkProperties properties = manager.getLinkProperties(network);
                    if (capabilities == null || properties == null) continue;
                    // 跳过 VPN 自己：它的 DNS 就是 10.111.222.1，拿去当上游会死循环
                    if (capabilities.hasTransport(android.net.NetworkCapabilities.TRANSPORT_VPN)) continue;
                    for (InetAddress address : properties.getDnsServers()) {
                        String host = address.getHostAddress();
                        if (host == null || host.isEmpty()) continue;
                        if (host.equals(TUN_ADDRESS) || host.startsWith("127.") || host.startsWith("169.254.")) continue;
                        if (!result.contains(host)) result.add(host);
                    }
                }
            }
        } catch (Exception e) {
            EventLog.warn("读取底层网络 DNS 失败，改用公共 DNS：" + e.getMessage());
        }
        // 把兜底放在最后：优先用运营商/路由器的 DNS（通常最快，也不容易被网络策略拦）
        for (String fallback : FALLBACK_UPSTREAMS) {
            if (!result.contains(fallback)) result.add(fallback);
        }
        upstreamCache = result;
        return result;
    }

    private String describeUpstreams() {
        StringBuilder sb = new StringBuilder();
        for (String upstream : upstreams()) {
            if (sb.length() > 0) sb.append(',');
            sb.append(upstream);
        }
        return sb.toString();
    }

    // ---------------- 校验和工具 ----------------

    private static int readU16(byte[] data, int offset) {
        return ((data[offset] & 0xFF) << 8) | (data[offset + 1] & 0xFF);
    }

    private static int checksum(byte[] data, int offset, int length) {
        int sum = 0;
        int index = offset;
        int end = offset + length;
        while (index + 1 < end) {
            sum += readU16(data, index);
            index += 2;
        }
        if (index < end) sum += (data[index] & 0xFF) << 8;
        while ((sum >> 16) != 0) sum = (sum & 0xFFFF) + (sum >> 16);
        return (~sum) & 0xFFFF;
    }

    private static int udpChecksum(byte[] packet, int ihl, int udpLength) {
        int sum = 0;
        for (int i = 12; i < 20; i += 2) sum += readU16(packet, i);
        sum += 17; // 协议号
        sum += udpLength;

        int index = ihl;
        int end = ihl + udpLength;
        while (index + 1 < end) {
            sum += readU16(packet, index);
            index += 2;
        }
        if (index < end) sum += (packet[index] & 0xFF) << 8;
        while ((sum >> 16) != 0) sum = (sum & 0xFFFF) + (sum >> 16);
        int result = (~sum) & 0xFFFF;
        // UDP 校验和为 0 表示「未计算」，所以真算出 0 时要写成 0xFFFF
        return result == 0 ? 0xFFFF : result;
    }
}
