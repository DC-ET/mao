package cn.etarch.mao.session.util;

import cn.etarch.mao.session.entity.Session;
import com.baomidou.mybatisplus.core.conditions.query.QueryWrapper;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.*;

class SessionGroupKeyTest {

    @Test
    void of_matchesDesktopCloudGroupKey() {
        assertEquals("LOCAL:未设置", SessionGroupKey.of("LOCAL", null));
        assertEquals("LOCAL:未设置", SessionGroupKey.of("LOCAL", ""));
        assertEquals("LOCAL:/home/u/proj", SessionGroupKey.of("LOCAL", "/home/u/proj"));

        assertEquals("CLOUD:临时工作区", SessionGroupKey.of("CLOUD", null));
        assertEquals("CLOUD:临时工作区", SessionGroupKey.of("CLOUD", "/opt/mao/data/1/42"));
        assertEquals("CLOUD:/opt/mao/data/1/projects/demo",
                SessionGroupKey.of("CLOUD", "/opt/mao/data/1/projects/demo"));
    }

    @Test
    void formatLabel_extractsProjectSlugAndBasename() {
        assertEquals("临时工作区", SessionGroupKey.formatLabel("CLOUD:临时工作区"));
        assertEquals("demo", SessionGroupKey.formatLabel("CLOUD:/opt/mao/data/1/projects/demo"));
        assertEquals("proj", SessionGroupKey.formatLabel("LOCAL:/home/u/proj"));
        assertEquals("未设置", SessionGroupKey.formatLabel("LOCAL:未设置"));
    }

    @Test
    void applyFilter_localAndCloud() {
        assertDoesNotThrow(() ->
                SessionGroupKey.applyFilter(new QueryWrapper<>(), "LOCAL:/ws"));
        assertDoesNotThrow(() ->
                SessionGroupKey.applyFilter(new QueryWrapper<>(), "LOCAL:未设置"));
        assertDoesNotThrow(() ->
                SessionGroupKey.applyFilter(new QueryWrapper<>(), "CLOUD:临时工作区"));
        assertDoesNotThrow(() ->
                SessionGroupKey.applyFilter(new QueryWrapper<>(), "CLOUD:/opt/mao/data/1/projects/demo"));
        assertThrows(IllegalArgumentException.class, () ->
                SessionGroupKey.applyFilter(new QueryWrapper<>(), "OTHER:x"));
        assertThrows(IllegalArgumentException.class, () ->
                SessionGroupKey.applyFilter(new QueryWrapper<>(), ""));
    }

    @Test
    void compareSessions_activeFirst() {
        Session running = new Session();
        running.setId(1L);
        running.setPhase("RUNNING");
        running.setIsPinned(0);
        Session idle = new Session();
        idle.setId(2L);
        idle.setPhase("IDLE");
        idle.setIsPinned(1);
        assertTrue(SessionGroupKey.compareSessions(running, idle) < 0);
    }

    @Test
    void compareSessions_sameUpdatedAt_newerIdFirst() {
        Session older = new Session();
        older.setId(10L);
        older.setPhase("IDLE");
        older.setUpdatedAt(java.time.LocalDateTime.of(2026, 7, 20, 14, 11, 23));
        Session newer = new Session();
        newer.setId(90L);
        newer.setPhase("IDLE");
        newer.setUpdatedAt(java.time.LocalDateTime.of(2026, 7, 20, 14, 11, 23));
        assertTrue(SessionGroupKey.compareSessions(newer, older) < 0);
        assertTrue(SessionGroupKey.compareSessions(older, newer) > 0);
    }
}