package cn.etarch.mao.harness.skill;

import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.regex.Pattern;

/**
 * 会话级本地未同步 Skill 上报登记表（内存态，仅 LOCAL 模式使用）。
 * <p>
 * 桌面客户端在 LOCAL 模式下发送消息时，会附带扫描到的本地 Skill 列表
 * （~/.agents/skills，尚未上传到服务端）。这些 Skill 无需上传即可用于本次本地任务：
 * Prompt 中直接引用桌面端本地文件路径，由 Electron 端在执行 read_file 等工具时就地读取。
 * <p>
 * 若用户希望在 CLOUD 模式任务中使用这些 Skill，仍需先上传（见 {@link SkillSyncService}）。
 */
@Slf4j
@Component
public class LocalSkillRegistry {

    /** 文件夹名安全校验：不允许路径穿越或分隔符 */
    private static final Pattern SAFE_FOLDER_NAME = Pattern.compile("^[^/\\\\]+$");

    /** sessionId → 最近一次上报的本地未同步 Skill 列表 */
    private final Map<Long, List<LocalSkillRef>> reported = new ConcurrentHashMap<>();

    /**
     * 上报（覆盖式）某会话当前的本地未同步 Skill 列表。
     */
    public void report(Long sessionId, List<LocalSkillRef> skills) {
        if (sessionId == null) return;
        if (skills == null || skills.isEmpty()) {
            reported.remove(sessionId);
            return;
        }
        List<LocalSkillRef> sanitized = new ArrayList<>();
        for (LocalSkillRef ref : skills) {
            if (ref == null || ref.getName() == null || ref.getName().isBlank()) continue;
            if (ref.getFolderName() == null || ref.getFolderName().isBlank()
                    || ref.getFolderName().startsWith(".")
                    || !SAFE_FOLDER_NAME.matcher(ref.getFolderName()).matches()) {
                log.warn("Ignoring local skill with unsafe folderName: {}", ref.getFolderName());
                continue;
            }
            sanitized.add(ref);
        }
        if (sanitized.isEmpty()) {
            reported.remove(sessionId);
        } else {
            reported.put(sessionId, sanitized);
        }
    }

    /**
     * 获取某会话最近一次上报的本地未同步 Skill 列表（可能为空）。
     */
    public List<LocalSkillRef> get(Long sessionId) {
        if (sessionId == null) return List.of();
        return reported.getOrDefault(sessionId, List.of());
    }

    /**
     * 会话结束时清理，避免内存无限增长。
     */
    public void clear(Long sessionId) {
        if (sessionId != null) {
            reported.remove(sessionId);
        }
    }
}
