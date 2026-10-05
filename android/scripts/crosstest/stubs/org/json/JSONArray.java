package org.json;

/** 见 {@link JSONObject}：一律抛异常，避免桩悄悄返回错误数据。 */
public class JSONArray {
  private static UnsupportedOperationException boom() {
    return new UnsupportedOperationException("JSONArray 桩不支持该操作（交叉验证只覆盖求值逻辑）");
  }

  public JSONArray() { }
  public JSONArray(java.util.Collection<?> source) { throw boom(); }
  public JSONArray(String source) { throw boom(); }

  public int length() { throw boom(); }
  public int optInt(int i) { throw boom(); }
  public String optString(int i, String d) { throw boom(); }
  public JSONObject optJSONObject(int i) { throw boom(); }
  public JSONArray put(Object v) { throw boom(); }
  public JSONArray put(int i, Object v) { throw boom(); }
  @Override public String toString() { throw boom(); }
}
