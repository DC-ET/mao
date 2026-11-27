package cn.etarch.mao.app;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/**
 * 服务器历史（MRU，最多 10 条）。纯 JSON 逻辑，便于 JVM 单测。
 */
public final class ServerHistory {

    public static final int LIMIT = 10;

    private ServerHistory() {}

    public static final class Entry {
        public final String serverBaseUrl;
        public final boolean allowHttp;
        public final String lastConnectedAt;

        public Entry(String serverBaseUrl, boolean allowHttp, String lastConnectedAt) {
            this.serverBaseUrl = serverBaseUrl;
            this.allowHttp = allowHttp;
            this.lastConnectedAt = lastConnectedAt;
        }
    }

    public static List<Entry> parse(String json) {
        List<Entry> entries = new ArrayList<>();
        if (json == null || json.isEmpty()) return entries;
        try {
            JSONArray array = new JSONArray(json);
            for (int i = 0; i < array.length(); i++) {
                JSONObject object = array.optJSONObject(i);
                if (object == null) continue;
                String url = object.optString("serverBaseUrl", "");
                boolean allowHttp = object.optBoolean("allowHttp", false);
                ServerUrlNormalizer.Result normalized = ServerUrlNormalizer.normalize(url, allowHttp);
                if (!normalized.ok) continue;
                String lastConnectedAt = object.isNull("lastConnectedAt")
                        ? null
                        : object.optString("lastConnectedAt", null);
                entries.add(new Entry(normalized.baseUrl, allowHttp, lastConnectedAt));
            }
        } catch (Exception ignored) {
            return new ArrayList<>();
        }
        return entries;
    }

    public static String merge(String json, String serverBaseUrl, boolean allowHttp, String lastConnectedAt) {
        List<Entry> entries = parse(json);
        List<Entry> next = new ArrayList<>();
        next.add(new Entry(serverBaseUrl, allowHttp, lastConnectedAt));
        for (Entry entry : entries) {
            if (!entry.serverBaseUrl.equals(serverBaseUrl)) next.add(entry);
        }
        while (next.size() > LIMIT) next.remove(next.size() - 1);
        return toJson(next);
    }

    public static String remove(String json, String serverBaseUrl) {
        List<Entry> entries = parse(json);
        List<Entry> next = new ArrayList<>();
        for (Entry entry : entries) {
            if (!entry.serverBaseUrl.equals(serverBaseUrl)) next.add(entry);
        }
        return toJson(next);
    }

    public static String toJson(List<Entry> entries) {
        JSONArray array = new JSONArray();
        for (Entry entry : entries) {
            JSONObject object = new JSONObject();
            try {
                object.put("serverBaseUrl", entry.serverBaseUrl);
                object.put("allowHttp", entry.allowHttp);
                object.put("lastConnectedAt", entry.lastConnectedAt == null ? JSONObject.NULL : entry.lastConnectedAt);
            } catch (Exception ignored) {
                continue;
            }
            array.put(object);
        }
        return array.toString();
    }
}