package cn.etarch.mao.harness.approval;

import cn.etarch.mao.session.entity.Session;
import cn.etarch.mao.session.mapper.SessionMapper;
import cn.etarch.mao.session.service.SessionService;
import cn.etarch.mao.session.ws.StreamingWsRegistry;
import cn.etarch.mao.session.ws.WsEvent;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.util.Collection;
import java.util.HashMap;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

/**
 * 会话级待审批注册表（轻量）：sessionId → 待审批请求 ID 集合。
 *
 * <p>背景：AgentLoop 对同一轮多个工具调用并行执行（CompletableFuture.runAsync），
 * 同一会话可同时挂起多个需要审批的 LOCAL 工具；单一 phase 无法表达「仍有未处理审批」，
 * 故引入本注册表做精确计数：</p>
 *
 * <ul>
 *   <li>首个待审批请求登记时置 phase=WAITING_APPROVAL；</li>
 *   <li>批准 / 拒绝 / 超时 / 断连 / 取消后在 finally 中移除当前请求；</li>
 *   <li>该会话计数归零时才尝试恢复 RUNNING（条件更新，不覆盖终态）。</li>
 * </ul>
 *
 * <p>多会话（含 Side Task）各自独立计数。服务重启后内存清空，属可接受限制
 * （与 harness Agent 执行上下文同为内存态）。</p>
 */
@Slf4j
@Component
public class ApprovalRegistry {

    private final ConcurrentHashMap<Long, Set<String>> pending = new ConcurrentHashMap<>();

    private final SessionService sessionService;
    private final SessionMapper sessionMapper;
    private final StreamingWsRegistry streamingWsRegistry;

    public ApprovalRegistry(SessionService sessionService,
                            SessionMapper sessionMapper,
                            StreamingWsRegistry streamingWsRegistry) {
        this.sessionService = sessionService;
        this.sessionMapper = sessionMapper;
        this.streamingWsRegistry = streamingWsRegistry;
    }

    /**
     * 登记一个待审批请求。首个请求使会话进入 WAITING_APPROVAL。
     */
    public void register(Long sessionId, String requestId) {
        if (sessionId == null || requestId == null) {
            return;
        }
        Set<String> ids = pending.computeIfAbsent(sessionId, k -> ConcurrentHashMap.newKeySet());
        boolean first;
        synchronized (ids) {
            first = ids.isEmpty();
            ids.add(requestId);
        }
        if (first) {
            // 条件更新：会话当前非终态时才进入 WAITING_APPROVAL（避免覆盖 CANCELLED/FAILED/COMPLETED）
            boolean entered = sessionService.enterWaitingApproval(sessionId);
            if (entered) {
                publishPhase(sessionId, "WAITING_APPROVAL");
            }
            log.debug("Session {} entered WAITING_APPROVAL (requestId={}, entered={})", sessionId, requestId, entered);
        } else {
            log.debug("Session {} approval count -> {} (requestId={})", sessionId, ids.size(), requestId);
        }
    }

    /**
     * 移除一个已完成的待审批请求（批准 / 拒绝 / 超时 / 断连 / 取消）。
     * 仅当该会话计数归零时尝试恢复 RUNNING（条件更新，不覆盖终态）。
     */
    public void unregister(Long sessionId, String requestId) {
        if (sessionId == null || requestId == null) {
            return;
        }
        Set<String> ids = pending.get(sessionId);
        if (ids == null) {
            return;
        }
        boolean empty;
        synchronized (ids) {
            ids.remove(requestId);
            empty = ids.isEmpty();
            if (empty) {
                pending.remove(sessionId, ids);
            }
        }
        if (empty) {
            boolean restored = sessionService.restoreRunningAfterApproval(sessionId);
            if (restored) {
                publishPhase(sessionId, "RUNNING");
            }
            log.debug("Session {} approval count cleared, restoreRunning={}", sessionId, restored);
        } else {
            log.debug("Session {} approval count -> {} after removing requestId={}",
                    sessionId, ids.size(), requestId);
        }
    }

    /**
     * 单个会话的待审批计数（真实值，0/1/N）。
     */
    public int countForSession(Long sessionId) {
        if (sessionId == null) {
            return 0;
        }
        Set<String> ids = pending.get(sessionId);
        return ids == null ? 0 : ids.size();
    }

    /**
     * 批量计数：返回计数 &gt; 0 的 sessionId → 计数。供列表 VO 批量填充，单次遍历。
     */
    public Map<Long, Integer> countForSessionIds(Collection<Long> sessionIds) {
        Map<Long, Integer> result = new HashMap<>();
        if (sessionIds == null) {
            return result;
        }
        for (Long sid : sessionIds) {
            int c = countForSession(sid);
            if (c > 0) {
                result.put(sid, c);
            }
        }
        return result;
    }

    private void publishPhase(Long sessionId, String phase) {
        Session session = sessionMapper.selectById(sessionId);
        if (session == null || session.getUserId() == null) {
            return;
        }
        Long userId = session.getUserId();
        streamingWsRegistry.send(userId, WsEvent.of("session_status", sessionId,
                Map.of("phase", phase)));
        streamingWsRegistry.send(userId, WsEvent.of("session_list_update", sessionId,
                Map.of("phase", phase)));
    }
}
