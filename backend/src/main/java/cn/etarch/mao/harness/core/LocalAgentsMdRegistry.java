package cn.etarch.mao.harness.core;

import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * 会话级 AGENTS.md 内容上报登记表（内存态，仅 LOCAL 模式使用）。
 * <p>
 * 桌面客户端在 LOCAL 模式下发送消息时，附带读取到的本地 AGENTS.md 内容。
 * 服务端缓存后在构建系统提示词时注入。
 */
@Slf4j
@Component
public class LocalAgentsMdRegistry {

    /** AGENTS.md 内容最大字符数限制（100KB） */
    private static final int MAX_CONTENT_LENGTH = 100 * 1024;

    /** sessionId → 最近一次上报的 AGENTS.md 内容 */
    private final Map<Long, String> reported = new ConcurrentHashMap<>();

    /**
     * 上报（覆盖式）某会话当前的 AGENTS.md 内容。
     * @param sessionId 会话 ID
     * @param content   AGENTS.md 文件内容，null 或空白表示文件不存在
     */
    public void report(Long sessionId, String content) {
        if (sessionId == null) return;
        if (content == null || content.isBlank()) {
            reported.remove(sessionId);
        } else {
            // 限制内容长度，防止超大内容导致内存问题
            if (content.length() > MAX_CONTENT_LENGTH) {
                log.warn("AGENTS.md content too large ({} chars), truncating to {} chars for session {}",
                        content.length(), MAX_CONTENT_LENGTH, sessionId);
                content = content.substring(0, MAX_CONTENT_LENGTH);
            }
            reported.put(sessionId, content);
        }
    }

    /**
     * 获取某会话最近一次上报的 AGENTS.md 内容（可能为 null）。
     */
    public String get(Long sessionId) {
        if (sessionId == null) return null;
        return reported.get(sessionId);
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
