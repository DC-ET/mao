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

    @Test
    void compareSessions_archivedIgnoresPhaseAndPin() {
        // 已归档区按「最近活动时间」倒序：忽略活跃阶段优先与置顶
        Session failedNewest = new Session();
        failedNewest.setId(1L);
        failedNewest.setStatus("ARCHIVED");
        failedNewest.setPhase("FAILED");
        failedNewest.setIsPinned(0);
        failedNewest.setUpdatedAt(java.time.LocalDateTime.of(2026, 8, 9, 10, 0, 0));

        Session pinnedCompleted = new Session();
        pinnedCompleted.setId(2L);
        pinnedCompleted.setStatus("ARCHIVED");
        pinnedCompleted.setPhase("COMPLETED");
        pinnedCompleted.setIsPinned(1);
        pinnedCompleted.setUpdatedAt(java.time.LocalDateTime.of(2026, 8, 7, 10, 0, 0));

        Session runningMid = new Session();
        runningMid.setId(3L);
        runningMid.setStatus("ARCHIVED");
        runningMid.setPhase("RUNNING");
        runningMid.setIsPinned(0);
        runningMid.setUpdatedAt(java.time.LocalDateTime.of(2026, 8, 8, 10, 0, 0));

        // 期望顺序：failedNewest(8/9) > runningMid(8/8) > pinnedCompleted(8/7)，
        // 即便 pinnedCompleted 置顶、failedNewest 是失败态也不影响。
        java.util.List<Session> list = new java.util.ArrayList<>(
                java.util.List.of(pinnedCompleted, runningMid, failedNewest));
        list.sort(SessionGroupKey::compareSessions);
        assertEquals(java.util.List.of(1L, 3L, 2L),
                list.stream().map(Session::getId).toList());
    }

    @Test
    void compareSessions_archivedVsActiveUsesActivePhaseRule() {
        // 归档与非归档混合比较：归档方参与普通排序（非 ARCHIVED 双方都时走原逻辑）
        Session active = new Session();
        active.setId(1L);
        active.setStatus("ACTIVE");
        active.setPhase("RUNNING");
        active.setUpdatedAt(java.time.LocalDateTime.of(2026, 8, 8, 10, 0, 0));

        Session archived = new Session();
        archived.setId(2L);
        archived.setStatus("ARCHIVED");
        archived.setPhase("COMPLETED");
        archived.setUpdatedAt(java.time.LocalDateTime.of(2026, 8, 9, 10, 0, 0));

        // active RUNNING 优先于 archived COMPLETED（活跃阶段优先仍生效）
        assertTrue(SessionGroupKey.compareSessions(active, archived) < 0);
    }
}