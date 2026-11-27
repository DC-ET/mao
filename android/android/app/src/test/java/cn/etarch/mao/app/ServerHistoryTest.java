package cn.etarch.mao.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.util.List;

public class ServerHistoryTest {

    @Test
    public void mergePutsNewestFirstAndDedupes() throws Exception {
        String json = ServerHistory.merge("[]", "https://a.example.com", false, "t1");
        json = ServerHistory.merge(json, "https://b.example.com", true, "t2");
        json = ServerHistory.merge(json, "https://a.example.com", false, "t3");

        List<ServerHistory.Entry> entries = ServerHistory.parse(json);
        assertEquals(2, entries.size());
        assertEquals("https://a.example.com", entries.get(0).serverBaseUrl);
        assertEquals("t3", entries.get(0).lastConnectedAt);
        assertEquals("https://b.example.com", entries.get(1).serverBaseUrl);
        assertTrue(entries.get(1).allowHttp);
    }

    @Test
    public void mergeCapsAtTen() throws Exception {
        String json = "[]";
        for (int i = 0; i < 12; i++) {
            json = ServerHistory.merge(json, "https://s" + i + ".example.com", false, "t" + i);
        }
        List<ServerHistory.Entry> entries = ServerHistory.parse(json);
        assertEquals(ServerHistory.LIMIT, entries.size());
        assertEquals("https://s11.example.com", entries.get(0).serverBaseUrl);
        assertEquals("https://s2.example.com", entries.get(9).serverBaseUrl);
    }

    @Test
    public void corruptJsonFallsBackToEmpty() {
        assertTrue(ServerHistory.parse("{bad json").isEmpty());
        assertTrue(ServerHistory.parse(null).isEmpty());
    }

    @Test
    public void parseDropsInvalidEntries() {
        String json = "[{\"serverBaseUrl\":\"ftp://bad\"},{\"serverBaseUrl\":\"https://ok.example.com\"}]";
        List<ServerHistory.Entry> entries = ServerHistory.parse(json);
        assertEquals(1, entries.size());
        assertEquals("https://ok.example.com", entries.get(0).serverBaseUrl);
    }

    @Test
    public void removeDropsMatchingEntry() {
        String json = ServerHistory.merge("[]", "https://a.example.com", false, "t1");
        json = ServerHistory.merge(json, "https://b.example.com", false, "t2");
        json = ServerHistory.remove(json, "https://a.example.com");
        List<ServerHistory.Entry> entries = ServerHistory.parse(json);
        assertEquals(1, entries.size());
        assertEquals("https://b.example.com", entries.get(0).serverBaseUrl);
    }
}