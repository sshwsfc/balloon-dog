package org.json;
public class JSONObject {
  public String optString(String k) { return null; }
  public String optString(String k, String d) { return d; }
  public int optInt(String k, int d) { return d; }
  public boolean optBoolean(String k, boolean d) { return d; }
  public JSONArray optJSONArray(String k) { return null; }
}
