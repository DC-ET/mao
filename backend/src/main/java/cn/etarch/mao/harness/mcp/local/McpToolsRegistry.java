package cn.etarch.mao.harness.mcp.local;

import cn.etarch.mao.harness.mcp.model.McpToolRef;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentMap;

/**
 * LOCAL 模式 MCP 工具清单缓存。
 * <p>
 * 桌面端经 WS 上报（mcp_tools_report）每台服务器的工具清单后写入，
 * {@code HarnessService.buildContext} 在 LOCAL 模式下读取并生成工具适配器。
 * 生命周期与技能同步缓存（LocalSkillRegistry）一致：会话执行结束或断连时清理。
 */
@Slf4j
@Component
public class McpToolsRegistry {

    private final ConcurrentMap<Long, List<McpToolRef>> sessionTools = new ConcurrentHashMap<>();

    /**
     * 记录某会话的 MCP 工具清单（覆盖式）。
     *
     * @param sessionId 会话 ID
     * @param tools     服务器上报的工具列表；仅上报成功的服务器会被加入
     */
    public void report(Long sessionId, List<McpToolRef> tools) {
        if (sessionId == null) {
            return;
        }
        if (tools == null || tools.isEmpty()) {
            sessionTools.remove(sessionId);
            return;
        }
        sessionTools.put(sessionId, new ArrayList<>(tools));
        log.info("McpToolsRegistry: recorded {} MCP tools for session {}", tools.size(), sessionId);
    }

    /**
     * 读取某会话的 MCP 工具清单；无记录返回空列表。
     */
    public List<McpToolRef> getSessionTools(Long sessionId) {
        if (sessionId == null) {
            return List.of();
        }
        List<McpToolRef> tools = sessionTools.get(sessionId);
        return tools != null ? List.copyOf(tools) : List.of();
    }

    /** 会话是否有已上报的 MCP 工具。 */
    public boolean hasTools(Long sessionId) {
        if (sessionId == null) {
            return false;
        }
        List<McpToolRef> tools = sessionTools.get(sessionId);
        return tools != null && !tools.isEmpty();
    }

    /** 会话执行结束 / 断连时清理。 */
    public void clear(Long sessionId) {
        if (sessionId == null) {
            return;
        }
        sessionTools.remove(sessionId);
    }
}
