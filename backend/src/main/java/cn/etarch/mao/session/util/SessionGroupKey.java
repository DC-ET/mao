package cn.etarch.mao.session.util;

import cn.etarch.mao.session.entity.Session;
import com.baomidou.mybatisplus.core.conditions.query.QueryWrapper;

/**
 * Session sidebar group key — must stay in sync with desktop
 * {@code cloudGroupKey()} in {@code desktop/src/utils/cloud-project.ts}.
 */
public final class SessionGroupKey {

    public static final String CLOUD_TEMP = "CLOUD:临时工作区";
    public static final String LOCAL_UNSET = "LOCAL:未设置";

    private SessionGroupKey() {}

    public static String of(Session session) {
        return of(session.getExecutionMode(), session.getWorkspace());
    }

    public static String of(String executionMode, String workspace) {
        if (!"CLOUD".equals(executionMode)) {
            return (workspace != null && !workspace.isEmpty()) ? "LOCAL:" + workspace : LOCAL_UNSET;
        }
        if (workspace != null && workspace.contains("/projects/")) {
            return "CLOUD:" + workspace;
        }
        return CLOUD_TEMP;
    }

    public static String formatLabel(String key) {
        if (CLOUD_TEMP.equals(key)) {
            return "临时工作区";
        }
        if (key.startsWith("CLOUD:")) {
            String ws = key.substring(6);
            String[] parts = ws.replace('\\', '/').split("/");
            int projectsIdx = -1;
            for (int i = 0; i < parts.length; i++) {
                if ("projects".equals(parts[i])) {
                    projectsIdx = i;
                    break;
                }
            }
            if (projectsIdx >= 0 && projectsIdx < parts.length - 1 && !parts[projectsIdx + 1].isEmpty()) {
                return parts[projectsIdx + 1];
            }
            for (int i = parts.length - 1; i >= 0; i--) {
                if (!parts[i].isEmpty()) {
                    return parts[i];
                }
            }
            return ws;
        }
        if (key.startsWith("LOCAL:")) {
            String ws = key.substring(6);
            if ("未设置".equals(ws)) {
                return "未设置";
            }
            String[] parts = ws.split("/");
            for (int i = parts.length - 1; i >= 0; i--) {
                if (!parts[i].isEmpty()) {
                    return parts[i];
                }
            }
            return ws;
        }
        return key;
    }

    /** Default group ordering before user preference: CLOUD temp → CLOUD* → LOCAL*. */
    public static int compareKeys(String a, String b) {
        if (CLOUD_TEMP.equals(a)) return -1;
        if (CLOUD_TEMP.equals(b)) return 1;
        boolean aCloud = a.startsWith("CLOUD:");
        boolean bCloud = b.startsWith("CLOUD:");
        if (aCloud && !bCloud) return -1;
        if (!aCloud && bCloud) return 1;
        return a.compareTo(b);
    }

    public static void applyFilter(QueryWrapper<Session> qw, String groupKey) {
        if (groupKey == null || groupKey.isBlank()) {
            throw new IllegalArgumentException("groupKey is required");
        }
        if (LOCAL_UNSET.equals(groupKey)) {
            qw.eq("execution_mode", "LOCAL");
            qw.and(w -> w.isNull("workspace").or().eq("workspace", ""));
            return;
        }
        if (groupKey.startsWith("LOCAL:")) {
            qw.eq("execution_mode", "LOCAL");
            qw.eq("workspace", groupKey.substring(6));
            return;
        }
        if (CLOUD_TEMP.equals(groupKey)) {
            qw.eq("execution_mode", "CLOUD");
            qw.and(w -> w.isNull("workspace")
                    .or().eq("workspace", "")
                    .or().notLike("workspace", "%/projects/%"));
            return;
        }
        if (groupKey.startsWith("CLOUD:")) {
            qw.eq("execution_mode", "CLOUD");
            qw.eq("workspace", groupKey.substring(6));
            return;
        }
        throw new IllegalArgumentException("Invalid groupKey: " + groupKey);
    }

    public static boolean isActivePhase(String phase) {
        return "RUNNING".equals(phase) || "RESUMING".equals(phase) || "WAITING_APPROVAL".equals(phase);
    }

    /** Within-group order: active phases first, then pin, then updated_at desc, then id desc. */
    public static int compareSessions(Session a, Session b) {
        boolean aActive = isActivePhase(a.getPhase());
        boolean bActive = isActivePhase(b.getPhase());
        if (aActive != bActive) {
            return aActive ? -1 : 1;
        }
        int aPin = a.getIsPinned() != null && a.getIsPinned() == 1 ? 1 : 0;
        int bPin = b.getIsPinned() != null && b.getIsPinned() == 1 ? 1 : 0;
        if (aPin != bPin) {
            return Integer.compare(bPin, aPin);
        }
        if (a.getUpdatedAt() == null && b.getUpdatedAt() == null) {
            // fall through to id
        } else if (a.getUpdatedAt() == null) {
            return 1;
        } else if (b.getUpdatedAt() == null) {
            return -1;
        } else {
            int byUpdated = b.getUpdatedAt().compareTo(a.getUpdatedAt());
            if (byUpdated != 0) {
                return byUpdated;
            }
        }
        // Tie-break: newer id first (avoids ASC creation order when updated_at ties, e.g. batch touch)
        long aId = a.getId() != null ? a.getId() : 0L;
        long bId = b.getId() != null ? b.getId() : 0L;
        return Long.compare(bId, aId);
    }
}