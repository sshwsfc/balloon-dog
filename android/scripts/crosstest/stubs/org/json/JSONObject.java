package org.json;

/**
 * 交叉验证用的极简 JSON 桩。
 *
 * <p>这些方法<b>一律抛异常</b>而不是返回默认值：交叉验证只跑求值逻辑，
 * 不跑 JSON 解析/序列化。如果哪天有人让被测代码走到了这里，
 * 会立刻炸出来 —— 比一个「悄悄返回 null」的桩安全得多。
 */
public class JSONObject {
  private static UnsupportedOperationException boom() {
    return new UnsupportedOperationException("JSONObject 桩不支持该操作（交叉验证只覆盖求值逻辑）");
  }
  public static final Object NULL = new Object();

  public JSONObject() { }
  public JSONObject(String source) { throw boom(); }

  public String optString(String k) { throw boom(); }
  public String optString(String k, String d) { throw boom(); }
  public int optInt(String k, int d) { throw boom(); }
  public double optDouble(String k, double d) { throw boom(); }
  public boolean optBoolean(String k, boolean d) { throw boom(); }
  public JSONArray optJSONArray(String k) { throw boom(); }
  public JSONObject optJSONObject(String k) { throw boom(); }
  public Object put(String k, Object v) { throw boom(); }
  public Object put(String k, boolean v) { throw boom(); }
  public Object put(String k, int v) { throw boom(); }
  @Override public String toString() { throw boom(); }
}
