package com.balloondog.agent.model;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * 一条「应用插件」管控规则。
 *
 * <p>服务端**只下发被家长改动过**的项，并且连同匹配关键词一起发下来 ——
 * 这样设备端不需要内置一份插件目录，也就不存在「服务端加了插件、设备端还不知道」
 * 这种静默失效。（早先的计划是两端各存一份目录，实现时发现纯属多余：
 * 设备端只用得到规则，用不到目录。）
 *
 * <p>规则随配置一起落盘，所以断网照常生效。
 */
public final class PluginRule {

    public final String packageName;
    public final String key;
    /** true = 允许，false = 拦截。 */
    public final boolean enabled;
    /** 命中任意一个即认为「正在使用该功能」。 */
    public final List<String> keywords;

    private PluginRule(String packageName, String key, boolean enabled, List<String> keywords) {
        this.packageName = packageName;
        this.key = key;
        this.enabled = enabled;
        this.keywords = Collections.unmodifiableList(keywords);
    }

    /**
     * 直接构造一条规则。
     *
     * <p>给判定逻辑的单元级验证用（见 {@code android/scripts/crosstest/GuardCheck.java}）：
     * 那条链路跑在普通 JVM 上，没有真正的 JSON 解析器。
     */
    public static PluginRule of(String packageName, String key, boolean enabled,
                                java.util.List<String> keywords) {
        return new PluginRule(packageName, key, enabled, keywords);
    }

    /** 解析服务端 {@code appPlugins} 块：`[{packageName, plugins:[{key,enabled,keywords}]}]`。 */
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

                List<String> keywords = new ArrayList<>();
                JSONArray kw = p.optJSONArray("keywords");
                if (kw != null) {
                    for (int k = 0; k < kw.length(); k++) {
                        String w = kw.optString(k, "");
                        if (!w.isEmpty()) keywords.add(w);
                    }
                }
                if (keywords.isEmpty()) continue; // 没有关键词的规则无法执行，直接丢

                out.add(new PluginRule(pkg, key, p.optBoolean("enabled", true), keywords));
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
                o.put("keywords", new JSONArray(r.keywords));
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
}
