package com.getcapacitor;
import java.util.LinkedHashMap;
import java.util.Map;
public class JSObject {
    private final Map<String, Object> data = new LinkedHashMap<>();
    public JSObject put(String key, Object value) { data.put(key, value); return this; }
    public JSObject put(String key, boolean value) { data.put(key, value); return this; }
    public JSObject put(String key, int value) { data.put(key, value); return this; }
    public JSObject put(String key, long value) { data.put(key, value); return this; }
    public Object get(String key) { return data.get(key); }
    public boolean has(String key) { return data.containsKey(key); }
}
