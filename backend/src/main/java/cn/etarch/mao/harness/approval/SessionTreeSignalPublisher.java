package cn.etarch.mao.harness.approval;

import cn.etarch.mao.harness.tool.AskUserQuestionsRegistry;
import cn.etarch.mao.session.entity.Session;
import cn.etarch.mao.session.mapper.SessionMapper;
import cn.etarch.mao.session.ws.StreamingWsRegistry;
import cn.etarch.mao.session.ws.WsEvent;
import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 任务树信号发布器：Side Task 状态变化时，重新聚合父主会话的整棵任务树信号
 * （待审批 / 待回答 / 未读 / 运行中 / 失败）并推送 {@code session_tree_status} 事件，
 * 供前端聚焦模式实时重排（父任务无需再次拉取列表）。
 */
@Slf4j
@Component
public class SessionTreeSignalPublisher {

    private final SessionMapper sessionMapper;
    private final ApprovalRegistry approvalRegistry;
    private final AskUserQuestionsRegistry askUserQuestionsRegistry;
    private final StreamingWsRegistry streamingWsRegistry;

    public SessionTreeSignalPublisher(SessionMapper sessionMapper,
                                      ApprovalRegistry approvalRegistry,
                                      AskUserQuestionsRegistry askUserQuestionsRegistry,
                                      StreamingWsRegistry streamingWsRegistry) {
        this.sessionMapper = sessionMapper;
        this.approvalRegistry = approvalRegistry;
        this.askUserQuestionsRegistry = askUserQuestionsRegistry;
        this.streamingWsRegistry = streamingWsRegistry;
    }

    /**
     * 若指定会话是边路任务，则重新聚合其父任务信号并推送；非边路任务不推送。
     * 供 Side Task phase / 审批 / 待回答 / 未读 变化点调用。
     */
    public void publishIfSideTask(Long sessionId) {
        if (sessionId == null) {
            return;
        }
        Session s = sessionMapper.selectById(sessionId);
        if (s == null || !"SIDE_TASK".equals(s.getSessionType()) || s.getParentSessionId() == null) {
            return;
        }
        publish(s.getParentSessionId());
    }

    /**
     * 按会话类型统一分流发布任务树信号：边路任务 → 发布其父会话；主会话 → 发布自身。
     * 用于审批 / 待回答等「主会话自身也会触发」的变化点，保证主会话自身的 tree* 也能实时刷新
     * （否则主会话自身待审批/待回答结束时，前端快照 tree* 残留，聚焦模式滞留最高优先级）。
     */
    public void publishForSession(Long sessionId) {
        if (sessionId == null) {
            return;
        }
        Session s = sessionMapper.selectById(sessionId);
        if (s == null) {
            return;
        }
        if ("SIDE_TASK".equals(s.getSessionType()) && s.getParentSessionId() != null) {
            publish(s.getParentSessionId());
        } else {
            publish(sessionId);
        }
    }

    /**
     * 重新聚合主会话 + 全部边路任务的任务树信号并推送 session_tree_status 事件。
     */
    public void publish(Long parentSessionId) {
        Session parent = sessionMapper.selectById(parentSessionId);
        if (parent == null || parent.getUserId() == null) {
            return;
        }
        List<Session> sides = sessionMapper.selectList(new LambdaQueryWrapper<Session>()
                .eq(Session::getParentSessionId, parentSessionId)
                .eq(Session::getSessionType, "SIDE_TASK")
                .ne(Session::getStatus, "ARCHIVED"));

        List<Long> allIds = new ArrayList<>();
        allIds.add(parentSessionId);
        for (Session st : sides) {
            allIds.add(st.getId());
        }
        Map<Long, Integer> approvalCounts = approvalRegistry.countForSessionIds(allIds);
        Map<Long, Integer> questionCounts = askUserQuestionsRegistry.countPendingBySessionIds(allIds);

        int approval = approvalCounts.getOrDefault(parentSessionId, 0);
        int question = questionCounts.getOrDefault(parentSessionId, 0);
        boolean unread = Integer.valueOf(1).equals(parent.getUnread());
        boolean running = isRunningPhase(parent.getPhase());
        boolean failed = "FAILED".equals(parent.getPhase());

        for (Session st : sides) {
            approval += approvalCounts.getOrDefault(st.getId(), 0);
            question += questionCounts.getOrDefault(st.getId(), 0);
            unread |= Integer.valueOf(1).equals(st.getUnread());
            running |= isRunningPhase(st.getPhase());
            failed |= "FAILED".equals(st.getPhase());
        }

        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("treePendingApprovalCount", approval);
        payload.put("treePendingQuestionCount", question);
        payload.put("treeUnread", unread);
        payload.put("treeRunning", running);
        payload.put("treeFailed", failed);

        streamingWsRegistry.send(parent.getUserId(), WsEvent.of("session_tree_status", parentSessionId, payload));
        log.debug("Published session_tree_status for parent {}: approval={}, question={}, unread={}, running={}, failed={}",
                parentSessionId, approval, question, unread, running, failed);
    }

    private static boolean isRunningPhase(String phase) {
        return "RUNNING".equals(phase) || "RESUMING".equals(phase)
                || "WAITING_APPROVAL".equals(phase) || "CANCELLING".equals(phase);
    }
}
