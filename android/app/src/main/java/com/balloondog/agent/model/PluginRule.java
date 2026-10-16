package com.balloondog.agent.model;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * 一条「应用插件」管控规则。
 *
 * <p>服务端**只下发被家长改动过**的项，并且连同匹配文本一起发下来 ——
 * 这样设备端不需要内置一份插件目录，也就不存在「服务端加了插件、设备端还不知道」
 * 这种静默失效。（早先的计划是两端各存一份目录，实现时发现纯属多余：
 * 设备端只用得到规则，用不到目录。）
 *
 * <h3>两套匹配文本，对应两种拦截</h3>
 * 一个功能名会同时出现在「入口列表」和「功能页标题」上，两者的管控后果完全不同
 * （入口要吃掉点击但不能整屏拦，否则同一页上家长允许的功能也一起废掉），所以规则分开存：
 * <ul>
 *   <li>{@link #entryTexts}：入口行上的文本，只与**可点击节点**比对；</li>
 *   <li>{@link #pageTexts}：功能页的标题文本，只与**窗口标题 / 顶部标题条**比对。
 *       服务端没给（旧格式）时回落到入口文本，此时靠「标题才匹配」这一条约束区分两者；</li>
 *   <li>{@link #anywhereTexts}：页面内标志物，与整窗**任意位置**的文本比对。
 *       只放「出现即说明正在做这件事」且辨识度足够的串（「请输入支付密码」），
 *       不放弱词 —— 聊天里提一句「支付」就把整个应用拦掉，正是这一版要修的误伤。</li>
 * </ul>
 *
 * <p>规则随配置一起落盘，所以断网照常生效。
 *
 * @see com.balloondog.agent.capability.GuardRules#matchPluginRules
 */
public final class PluginRule {

    public final String packageName;
    public final String key;
    /** true = 允许，false = 拦截。 */
    public final boolean enabled;
    /** 给家长 / 孩子看的功能名（「朋友圈」），拦截原因里用它，而不是拿关键词凑。 */
    public final String label;
    /** 入口行文本（如「朋友圈」「扫一扫」），命中可点击节点即认为孩子在点这个入口。 */
    public final List<String> entryTexts;
    /** 功能页标题文本；为空时回落到 {@link #entryTexts}。 */
    public final List<String> pageTexts;
    /** 页面内标志物（任意位置比对）：「确认支付」「请输入支付密码」这类辨识度足够的串。 */
    public final List<String> anywhereTexts;

    private PluginRule(String packageName, String key, boolean enabled, String label,
                       List<String> entryTexts, List<String> pageTexts, List<String> anywhereTexts) {
        this.packageName = packageName;
        this.key = key;
        this.enabled = enabled;
        this.entryTexts = Collections.unmodifiableList(
                entryTexts == null ? new ArrayList<String>() : entryTexts);
        List<String> pages = (pageTexts == null || pageTexts.isEmpty()) ? this.entryTexts : pageTexts;
        this.pageTexts = Collections.unmodifiableList(new ArrayList<>(pages));
        this.anywhereTexts = Collections.unmodifiableList(
                anywhereTexts == null ? new ArrayList<String>() : anywhereTexts);
        if (label != null && !label.isEmpty()) {
            this.label = label;
        } else if (!this.entryTexts.isEmpty()) {
            this.label = this.entryTexts.get(0);
        } else if (!this.pageTexts.isEmpty()) {
            this.label = this.pageTexts.get(0);
        } else if (!this.anywhereTexts.isEmpty()) {
            this.label = this.anywhereTexts.get(0);
        } else {
            this.label = key;
        }
    }

    /**
     * 直接构造一条规则（入口文本 + 功能页标题）。
     *
     * <p>给判定逻辑的单元级验证用（见 {@code android/scripts/crosstest/GuardCheck.java}）：
     * 那条链路跑在普通 JVM 上，没有真正的 JSON 解析器。
     */
    public static PluginRule of(String packageName, String key, boolean enabled,
                                List<String> entryTexts, List<String> pageTexts) {
        return new PluginRule(packageName, key, enabled, null, entryTexts, pageTexts, null);
    }

    /** 完整构造：人话名字 + 入口 / 功能页标题 / 页面内标志物三组文本。 */
    public static PluginRule of(String packageName, String key, boolean enabled, String label,
                                List<String> entryTexts, List<String> pageTexts,
                                List<String> anywhereTexts) {
        return new PluginRule(packageName, key, enabled, label, entryTexts, pageTexts, anywhereTexts);
    }

    /**
     * 旧格式：只有一组关键词（旧服务端 / 旧缓存）。
     *
     * <p>这一组词既当入口文本又当页面标题（见 {@link #pageTexts} 的回落规则）——
     * 对旧数据来说这是最接近原意的解释，且不会再把「发现」页整页拦掉。
     */
    public static PluginRule of(String packageName, String key, boolean enabled,
                                List<String> keywords) {
        return new PluginRule(packageName, key, enabled, null, keywords, null, null);
    }

    /** 人话名字，用于拦截原因（家长端「最新动态」里会显示）。 */
    public String label() {
        return label;
    }

    /**
     * 解析服务端 {@code appPlugins} 块：
     * {@code [{packageName, plugins:[{key, enabled, entryTexts:[], pageTexts:[]}]}]}。
     *
     * <p>兼容只有 {@code keywords} 的旧格式（见 {@link #of(String, String, boolean, List)}）。
     */
    public static List<PluginRule> parseAll(JSONArray array) {
        List<PluginRule> out = new ArrayList<>();
        if (array == null) return out;

        for (int i = 0; i < array.length(); i++) {
            JSONObject target = array.optJSONObject(i);
            if (target == null) continue;
            String pkg = target.optString("packageName", "");
            if (pkg.isEmpty()) continue;

            JSONArray plugins = target.optJSONArray("plugins");
            if (plugins == null) continue;
            for (int j = 0; j < plugins.length(); j++) {
                JSONObject p = plugins.optJSONObject(j);
                if (p == null) continue;
                String key = p.optString("key", "");
                if (key.isEmpty()) continue;

                List<String> entries = strings(p.optJSONArray("entryTexts"));
                List<String> pages = strings(p.optJSONArray("pageTexts"));
                List<String> anywhere = strings(p.optJSONArray("anywhereTexts"));
                if (entries.isEmpty()) {
                    // 旧格式：只有 keywords
                    entries = strings(p.optJSONArray("keywords"));
                }
                if (entries.isEmpty() && pages.isEmpty() && anywhere.isEmpty()) {
                    continue; // 无法执行的规则，直接丢
                }

                out.add(new PluginRule(pkg, key, p.optBoolean("enabled", true),
                        p.optString("label", ""), entries, pages, anywhere));
            }
        }
        return out;
    }

    public static String toJson(List<PluginRule> rules) {
        JSONArray targets = new JSONArray();
        try {
            // 按包名聚合回服务端的结构，便于原样存取
            java.util.LinkedHashMap<String, JSONArray> byPkg = new java.util.LinkedHashMap<>();
            for (PluginRule r : rules) {
                JSONArray list = byPkg.get(r.packageName);
                if (list == null) {
                    list = new JSONArray();
                    byPkg.put(r.packageName, list);
                }
                JSONObject o = new JSONObject();
                o.put("key", r.key);
                o.put("enabled", r.enabled);
                o.put("label", r.label);
                o.put("entryTexts", new JSONArray(r.entryTexts));
                o.put("pageTexts", new JSONArray(r.pageTexts));
                o.put("anywhereTexts", new JSONArray(r.anywhereTexts));
                list.put(o);
            }
            for (java.util.Map.Entry<String, JSONArray> e : byPkg.entrySet()) {
                JSONObject t = new JSONObject();
                t.put("packageName", e.getKey());
                t.put("plugins", e.getValue());
                targets.put(t);
            }
        } catch (Exception ignored) {
            // 常量 key，不会抛
        }
        return targets.toString();
    }

    private static List<String> strings(JSONArray array) {
        List<String> out = new ArrayList<>();
        if (array == null) return out;
        for (int i = 0; i < array.length(); i++) {
            String value = array.optString(i, "");
            if (!value.isEmpty()) out.add(value);
        }
        return out;
    }
}
