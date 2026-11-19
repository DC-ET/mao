package com.getcapacitor;
import java.util.HashMap;
import java.util.Map;
public class PluginCall {
    public final Map<String, String> params = new HashMap<>();
    public boolean resolved = false;
    public boolean rejected = false;
    public JSObject resolvedData;
    public String rejectMessage;
    public String rejectCode;
    public String getString(String key) { return params.get(key); }
    public void resolve(JSObject data) { this.resolved = true; this.resolvedData = data; }
    public void resolve() { this.resolved = true; }
    public void reject(String message) { this.rejected = true; this.rejectMessage = message; }
    public void reject(String message, String code, JSObject data) {
        this.rejected = true; this.rejectMessage = message; this.rejectCode = code;
    }
}
