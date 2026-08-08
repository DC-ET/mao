package cn.etarch.mao.harness.tool.impl;

import cn.etarch.mao.config.DelegateConfig;
import cn.etarch.mao.harness.core.AgentExecutionContext;
import cn.etarch.mao.harness.core.AgentLoop;
import cn.etarch.mao.harness.core.HarnessService;
import cn.etarch.mao.harness.delegate.AgentDefinition;
import cn.etarch.mao.harness.delegate.AgentDefinitionRegistry;
import cn.etarch.mao.harness.delegate.SubAgentResultCollector;
import cn.etarch.mao.harness.delegate.SubAgentVisibilityService;
import cn.etarch.mao.harness.delegate.entity.SubagentExecution;
import cn.etarch.mao.harness.delegate.mapper.SubagentExecutionMapper;
import cn.etarch.mao.harness.llm.ChatUsage;
import cn.etarch.mao.harness.local.LocalToolSessionRegistry;
import cn.etarch.mao.harness.tool.Tool;
import cn.etarch.mao.session.entity.Message;
import cn.etarch.mao.session.entity.Session;
import cn.etarch.mao.session.mapper.MessageMapper;
import cn.etarch.mao.session.mapper.SessionMapper;
import cn.etarch.mao.session.service.SessionCompactionService;
import cn.etarch.mao.session.service.SessionService;
import com.baomidou.mybatisplus.core.MybatisConfiguration;
import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.baomidou.mybatisplus.core.conditions.update.LambdaUpdateWrapper;
import com.baomidou.mybatisplus.core.metadata.TableInfoHelper;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.apache.ibatis.builder.MapperBuilderAssistant;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.concurrent.atomic.AtomicBoolean;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyBoolean;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.contains;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

@SuppressWarnings("unchecked")
class DelegateFollowupToolTest {

    private final ObjectMapper objectMapper = new ObjectMapper();
    private final AgentDefinitionRegistry definitionRegistry = mock(AgentDefinitionRegistry.class);
    private final HarnessService harnessService = mock(HarnessService.class);
    private final AgentLoop agentLoop = mock(AgentLoop.class);
    private final SessionService sessionService = mock(SessionService.class);
    private final SessionMapper sessionMapper = mock(SessionMapper.class);
    private final MessageMapper messageMapper = mock(MessageMapper.class);
    private final SessionCompactionService sessionCompactionService = mock(SessionCompactionService.class);
    private final SubagentExecutionMapper subagentExecutionMapper = mock(SubagentExecutionMapper.class);
    private final LocalToolSessionRegistry localToolSessionRegistry = mock(LocalToolSessionRegistry.class);
    private final SubAgentVisibilityService visibilityService = mock(SubAgentVisibilityService.class);
    private final DelegateTool delegateTool = mock(DelegateTool.class);
    private final DelegateConfig delegateConfig = new DelegateConfig();
    private final DelegateFollowupTool tool = new DelegateFollowupTool(
            definitionRegistry, harnessService, agentLoop, sessionService, sessionMapper,
            messageMapper, sessionCompactionService, subagentExecutionMapper, localToolSessionRegistry,
            visibilityService, delegateTool, delegateConfig, objectMapper);

    @BeforeAll
    static void initMyBatisPlusTableInfo() {
        TableInfoHelper.initTableInfo(
                new MapperBuilderAssistant(new MybatisConfiguration(), ""), SubagentExecution.class);
        TableInfoHelper.initTableInfo(
                new MapperBuilderAssistant(new MybatisConfiguration(), ""), Session.class);
    }

    private Session parentSession(Long id) {
        Session s = new Session();
        s.setId(id);
        s.setUserId(7L);
        s.setAgentId(3L);
        s.setExecutionMode("CLOUD");
        return s;
    }

    private Session childSession(Long id, Long parentId, String sessionType, String phase) {
        Session s = new Session();
        s.setId(id);
        s.setUserId(7L);
        s.setAgentId(3L);
        s.setParentSessionId(parentId);
        s.setSessionType(sessionType);
        s.setPhase(phase);
        return s;
    }

    private SubagentExecution execution(String agentType) {
        SubagentExecution e = new SubagentExecution();
        e.setId(1L);
        e.setChildSessionId(100L);
        e.setAgentType(agentType);
        return e;
    }

    // ---------- 参数校验 ----------

    @Test
    void missingParamsReturnsError() throws Exception {
        JsonNode result = objectMapper.readTree(tool.execute("{\"task\":\"x\"}", 1L, null));
        assertThat(result.get("error").asText()).contains("缺少必填参数");

        JsonNode result2 = objectMapper.readTree(tool.execute("{\"child_session_id\":100}", 1L, null));
        assertThat(result2.get("error").asText()).contains("缺少必填参数");
    }

    @Test
    void nonIntegerChildSessionIdRejected() throws Exception {
        JsonNode result = objectMapper.readTree(tool.execute(
                "{\"child_session_id\":\"abc\",\"task\":\"跟进审查\"}", 1L, null));
        assertThat(result.get("error").asText()).contains("必须是整数");

        JsonNode result2 = objectMapper.readTree(tool.execute(
                "{\"child_session_id\":100.5,\"task\":\"跟进审查\"}", 1L, null));
        assertThat(result2.get("error").asText()).contains("必须是整数");
    }

    @Test
    void parentSessionMissingReturnsError() throws Exception {
        when(sessionMapper.selectById(1L)).thenReturn(null);
        JsonNode result = objectMapper.readTree(tool.execute(
                "{\"child_session_id\":100,\"task\":\"跟进审查\"}", 1L, null));
        assertThat(result.get("error").asText()).contains("父会话不存在");
    }

    // ---------- 子会话校验 ----------

    @Test
    void childSessionNotFoundRejected() throws Exception {
        when(sessionMapper.selectById(1L)).thenReturn(parentSession(1L));
        when(sessionMapper.selectById(100L)).thenReturn(null);
        JsonNode result = objectMapper.readTree(tool.execute(
                "{\"child_session_id\":100,\"task\":\"跟进审查\"}", 1L, null));
        assertThat(result.get("error").asText()).contains("子代理会话不存在");
        verify(subagentExecutionMapper, never()).insert(any());
    }

    @Test
    void nonSubagentSessionRejected() throws Exception {
        when(sessionMapper.selectById(1L)).thenReturn(parentSession(1L));
        when(sessionMapper.selectById(100L)).thenReturn(childSession(100L, 1L, "NORMAL", "COMPLETED"));
        JsonNode result = objectMapper.readTree(tool.execute(
                "{\"child_session_id\":100,\"task\":\"跟进审查\"}", 1L, null));
        assertThat(result.get("error").asText()).contains("不是子代理会话");
        verify(subagentExecutionMapper, never()).insert(any());
    }

    @Test
    void childOfOtherParentRejected() throws Exception {
        when(sessionMapper.selectById(1L)).thenReturn(parentSession(1L));
        when(sessionMapper.selectById(100L)).thenReturn(childSession(100L, 999L, "SUBAGENT", "COMPLETED"));
        JsonNode result = objectMapper.readTree(tool.execute(
                "{\"child_session_id\":100,\"task\":\"跟进审查\"}", 1L, null));
        assertThat(result.get("error").asText()).contains("不属于当前会话");
        verify(subagentExecutionMapper, never()).insert(any());
    }

    @Test
    void runningSessionRejected() throws Exception {
        when(sessionMapper.selectById(1L)).thenReturn(parentSession(1L));
        when(sessionMapper.selectById(100L)).thenReturn(childSession(100L, 1L, "SUBAGENT", "RUNNING"));
        JsonNode result = objectMapper.readTree(tool.execute(
                "{\"child_session_id\":100,\"task\":\"跟进审查\"}", 1L, null));
        assertThat(result.get("error").asText()).contains("正在执行中");
        verify(subagentExecutionMapper, never()).insert(any());
    }

    @Test
    void concurrentClaimLostRejected() throws Exception {
        // phase 预检通过（COMPLETED），但原子抢占失败（并发窗口内被其他线程抢先置 RUNNING）
        when(sessionMapper.selectById(1L)).thenReturn(parentSession(1L));
        when(sessionMapper.selectById(100L)).thenReturn(childSession(100L, 1L, "SUBAGENT", "COMPLETED"));
        when(subagentExecutionMapper.selectList(any(LambdaQueryWrapper.class))).thenReturn(List.of(execution("reviewer")));
        when(definitionRegistry.getDefinition("reviewer"))
                .thenReturn(AgentDefinition.builder().name("reviewer").build());
        when(sessionMapper.update(any(), any(LambdaUpdateWrapper.class))).thenReturn(0);

        JsonNode result = objectMapper.readTree(tool.execute(
                "{\"child_session_id\":100,\"task\":\"跟进审查\"}", 1L, null));

        assertThat(result.get("error").asText()).contains("正在执行中");
        // 抢占失败：不落 USER 消息、不插审计
        verify(sessionService, never()).saveMessage(any(), any(), any(), any(), any(), any(), any(), any());
        verify(subagentExecutionMapper, never()).insert(any());
    }

    @Test
    void noExecutionRecordRejected() throws Exception {
        when(sessionMapper.selectById(1L)).thenReturn(parentSession(1L));
        when(sessionMapper.selectById(100L)).thenReturn(childSession(100L, 1L, "SUBAGENT", "COMPLETED"));
        when(subagentExecutionMapper.selectList(any(LambdaQueryWrapper.class))).thenReturn(List.of());
        JsonNode result = objectMapper.readTree(tool.execute(
                "{\"child_session_id\":100,\"task\":\"跟进审查\"}", 1L, null));
        assertThat(result.get("error").asText()).contains("无执行记录");
    }

    @Test
    void unknownAgentTypeRejected() throws Exception {
        when(sessionMapper.selectById(1L)).thenReturn(parentSession(1L));
        when(sessionMapper.selectById(100L)).thenReturn(childSession(100L, 1L, "SUBAGENT", "COMPLETED"));
        when(subagentExecutionMapper.selectList(any(LambdaQueryWrapper.class))).thenReturn(List.of(execution("ghost")));
        when(definitionRegistry.getDefinition("ghost")).thenReturn(null);
        JsonNode result = objectMapper.readTree(tool.execute(
                "{\"child_session_id\":100,\"task\":\"跟进审查\"}", 1L, null));
        assertThat(result.get("error").asText()).contains("未知的子代理类型");
    }

    // ---------- 成功路径 ----------

    @Test
    void followupSuccessReusesSubagentSession() throws Exception {
        when(sessionMapper.selectById(1L)).thenReturn(parentSession(1L));
        when(sessionMapper.selectById(100L)).thenReturn(childSession(100L, 1L, "SUBAGENT", "COMPLETED"));
        when(subagentExecutionMapper.selectList(any(LambdaQueryWrapper.class))).thenReturn(List.of(execution("reviewer")));
        when(definitionRegistry.getDefinition("reviewer"))
                .thenReturn(AgentDefinition.builder().name("reviewer").description("code review").build());
        // 原子抢占成功
        when(sessionMapper.update(any(), any(LambdaUpdateWrapper.class))).thenReturn(1);
        // 清理不完整尾部（无压缩记录 → boundary=0）
        when(sessionCompactionService.loadValidated(100L)).thenReturn(null);
        when(sessionCompactionService.boundaryOf(null)).thenReturn(0L);

        when(agentLoop.getCancelFlag(1L)).thenReturn(null);
        when(agentLoop.registerCancelFlag(100L)).thenReturn(new AtomicBoolean(false));

        AgentExecutionContext subCtx = new AgentExecutionContext();
        subCtx.setCurrentRound(2);
        when(delegateTool.buildSubContext(any(Session.class), any(AgentDefinition.class))).thenReturn(subCtx);

        SubAgentResultCollector collector = new SubAgentResultCollector();
        collector.onThinkingStart();
        collector.onContentDelta("第二轮审查结论：修复到位，无新问题");
        collector.onMessageEnd(ChatUsage.builder()
                .promptTokens(100).completionTokens(50).totalTokens(150).build());
        when(visibilityService.executeVisibleWithTimeout(any(Session.class), any(AgentExecutionContext.class),
                anyBoolean(), any(AtomicBoolean.class), anyLong(), anyLong()))
                .thenReturn(new SubAgentVisibilityService.VisibleRunResult(collector, "exec-1"));
        when(subagentExecutionMapper.selectCount(any(LambdaQueryWrapper.class))).thenReturn(2L, 1L);

        JsonNode result = objectMapper.readTree(tool.execute(
                "{\"child_session_id\":100,\"task\":\"已修复上一轮问题，请核查并继续审查\"}", 1L, null));

        assertThat(result.get("success").asBoolean()).isTrue();
        assertThat(result.get("follow_up").asBoolean()).isTrue();
        assertThat(result.get("child_session_id").asLong()).isEqualTo(100L);
        assertThat(result.get("round").asLong()).isEqualTo(2L);
        assertThat(result.get("completed_rounds").asLong()).isEqualTo(1L);
        assertThat(result.get("agent_type").asText()).isEqualTo("reviewer");
        assertThat(result.get("result").asText()).contains("修复到位");

        // 追问 USER 消息落库（与普通聊天一致）
        verify(sessionService).saveMessage(eq(100L), eq("USER"), eq("已修复上一轮问题，请核查并继续审查"),
                any(), any(), any(), any(), any());
        // 落库前先清理不完整尾部（防误删追问消息）
        verify(sessionService).cleanupIncompleteTailAfterId(eq(100L), eq(0L));
        // 审计记录每轮一条
        verify(subagentExecutionMapper).insert(any(SubagentExecution.class));
        // 终态推送
        verify(visibilityService).finishSubagent(eq(100L), eq(7L), eq("COMPLETED"), eq("exec-1"));
        // 兜底订阅
        verify(visibilityService).ensureSubscribed(7L, 100L);
    }

    @Test
    void orphanTrailingUserRemovedBeforeFollowupMessage() throws Exception {
        // 上一轮 delegate 首轮被取消，子会话以孤立 USER 结尾（其后无任何回复）；
        // 追问落库前应先删除该孤立 USER，避免历史出现连续 USER 消息触发部分 LLM 端点 400
        when(sessionMapper.selectById(1L)).thenReturn(parentSession(1L));
        when(sessionMapper.selectById(100L)).thenReturn(childSession(100L, 1L, "SUBAGENT", "CANCELLED"));
        when(subagentExecutionMapper.selectList(any(LambdaQueryWrapper.class))).thenReturn(List.of(execution("reviewer")));
        when(definitionRegistry.getDefinition("reviewer"))
                .thenReturn(AgentDefinition.builder().name("reviewer").description("code review").build());
        when(sessionMapper.update(any(), any(LambdaUpdateWrapper.class))).thenReturn(1);
        when(sessionCompactionService.loadValidated(100L)).thenReturn(null);
        when(sessionCompactionService.boundaryOf(null)).thenReturn(0L);
        Message orphan = new Message();
        orphan.setId(150L);
        orphan.setRole("USER");
        // 第一次 selectOne 返回孤立 USER，循环第二次返回 null（无可删）后退出
        when(messageMapper.selectOne(any(LambdaQueryWrapper.class))).thenReturn(orphan, null);

        when(agentLoop.getCancelFlag(1L)).thenReturn(null);
        when(agentLoop.registerCancelFlag(100L)).thenReturn(new AtomicBoolean(false));

        AgentExecutionContext subCtx = new AgentExecutionContext();
        subCtx.setCurrentRound(2);
        when(delegateTool.buildSubContext(any(Session.class), any(AgentDefinition.class))).thenReturn(subCtx);

        SubAgentResultCollector collector = new SubAgentResultCollector();
        collector.onThinkingStart();
        collector.onContentDelta("增量核查通过");
        collector.onMessageEnd(ChatUsage.builder()
                .promptTokens(50).completionTokens(30).totalTokens(80).build());
        when(visibilityService.executeVisibleWithTimeout(any(Session.class), any(AgentExecutionContext.class),
                anyBoolean(), any(AtomicBoolean.class), anyLong(), anyLong()))
                .thenReturn(new SubAgentVisibilityService.VisibleRunResult(collector, "exec-1"));

        JsonNode result = objectMapper.readTree(tool.execute(
                "{\"child_session_id\":100,\"task\":\"已修复，请继续核查\"}", 1L, null));

        assertThat(result.get("success").asBoolean()).isTrue();
        // 孤立 USER 先删除，追问 USER 再落库，历史不出现连续 USER
        verify(messageMapper).deleteById(150L);
        verify(sessionService).saveMessage(eq(100L), eq("USER"), eq("已修复，请继续核查"),
                any(), any(), any(), any(), any());
    }

    // ---------- 执行失败（FAILED 分支） ----------

    @Test
    void executionFailureWritesFailedTerminal() throws Exception {
        when(sessionMapper.selectById(1L)).thenReturn(parentSession(1L));
        when(sessionMapper.selectById(100L)).thenReturn(childSession(100L, 1L, "SUBAGENT", "COMPLETED"));
        when(subagentExecutionMapper.selectList(any(LambdaQueryWrapper.class))).thenReturn(List.of(execution("reviewer")));
        when(definitionRegistry.getDefinition("reviewer"))
                .thenReturn(AgentDefinition.builder().name("reviewer").build());
        when(sessionMapper.update(any(), any(LambdaUpdateWrapper.class))).thenReturn(1);
        when(sessionCompactionService.loadValidated(100L)).thenReturn(null);
        when(sessionCompactionService.boundaryOf(null)).thenReturn(0L);
        when(agentLoop.getCancelFlag(1L)).thenReturn(null);
        when(agentLoop.registerCancelFlag(100L)).thenReturn(new AtomicBoolean(false));
        when(delegateTool.buildSubContext(any(Session.class), any(AgentDefinition.class)))
                .thenReturn(new AgentExecutionContext());
        // 子代理执行报错：collector.onError → 失败分支
        when(visibilityService.executeVisibleWithTimeout(any(Session.class), any(AgentExecutionContext.class),
                anyBoolean(), any(AtomicBoolean.class), anyLong(), anyLong()))
                .thenAnswer(inv -> {
                    SubAgentResultCollector collector = new SubAgentResultCollector();
                    collector.onError(new RuntimeException("boom"));
                    return new SubAgentVisibilityService.VisibleRunResult(collector, "exec-fail");
                });
        when(subagentExecutionMapper.selectCount(any(LambdaQueryWrapper.class))).thenReturn(2L);

        JsonNode result = objectMapper.readTree(tool.execute(
                "{\"child_session_id\":100,\"task\":\"跟进审查\"}", 1L, null));

        assertThat(result.get("success").asBoolean()).isFalse();
        assertThat(result.get("result").asText()).contains("子代理执行失败");
        // 失败路径补 ASSISTANT 失败消息 + FAILED 终态
        verify(sessionService).saveMessage(eq(100L), eq("ASSISTANT"), contains("子代理执行失败"),
                any(), any(), any(), any(), any());
        verify(visibilityService).finishSubagent(eq(100L), eq(7L), eq("FAILED"), eq("exec-fail"));
    }

    // ---------- skip 路径（父会话已取消，追问未实际执行） ----------

    @Test
    void skipWhenParentCancelledRestoresOriginalTerminalPhase() throws Exception {
        when(sessionMapper.selectById(1L)).thenReturn(parentSession(1L));
        // 第一次调用（校验）返回 COMPLETED；第二次调用（恢复前重读）返回 RUNNING（本追问抢占态）
        when(sessionMapper.selectById(100L)).thenReturn(
                childSession(100L, 1L, "SUBAGENT", "COMPLETED"),
                childSession(100L, 1L, "SUBAGENT", "RUNNING"));
        when(subagentExecutionMapper.selectList(any(LambdaQueryWrapper.class))).thenReturn(List.of(execution("reviewer")));
        when(definitionRegistry.getDefinition("reviewer"))
                .thenReturn(AgentDefinition.builder().name("reviewer").build());
        when(sessionMapper.update(any(), any(LambdaUpdateWrapper.class))).thenReturn(1);
        when(sessionCompactionService.loadValidated(100L)).thenReturn(null);
        when(sessionCompactionService.boundaryOf(null)).thenReturn(0L);
        when(agentLoop.getCancelFlag(1L)).thenReturn(null);
        // 父会话已取消 → 子 cancel flag 初始即 true → skip 路径
        when(agentLoop.registerCancelFlag(100L)).thenReturn(new AtomicBoolean(true));
        when(delegateTool.buildSubContext(any(Session.class), any(AgentDefinition.class)))
                .thenReturn(new AgentExecutionContext());
        when(visibilityService.executeVisibleWithTimeout(any(Session.class), any(AgentExecutionContext.class),
                anyBoolean(), any(AtomicBoolean.class), anyLong(), anyLong()))
                .thenReturn(new SubAgentVisibilityService.VisibleRunResult(new SubAgentResultCollector(), "exec-skip"));
        when(subagentExecutionMapper.selectCount(any(LambdaQueryWrapper.class))).thenReturn(2L);
        Message saved = new Message();
        saved.setId(200L);
        when(sessionService.saveMessage(eq(100L), eq("USER"), any(), any(), any(), any(), any(), any()))
                .thenReturn(saved);

        JsonNode result = objectMapper.readTree(tool.execute(
                "{\"child_session_id\":100,\"task\":\"跟进审查\"}", 1L, null));

        assertThat(result.get("cancelled").asBoolean()).isTrue();
        // 原子抢占 1 次 + 恢复原终态 1 次
        verify(sessionMapper, org.mockito.Mockito.times(2)).update(any(), any(LambdaUpdateWrapper.class));
        // 回滚本次追问产生的消息（无应答 USER 不滞留历史）
        verify(messageMapper).delete(any(LambdaQueryWrapper.class));
        // 终态守卫由 TaskTerminalService 拦截：finishSubagent 仍以 CANCELLED 调用，但不覆盖 phase
        verify(visibilityService).finishSubagent(eq(100L), eq(7L), eq("CANCELLED"), eq("exec-skip"));
    }

    // ---------- phase=NULL 崩溃窗口（一般 #1 回归） ----------

    @Test
    void claimSucceedsForNullPhase() throws Exception {
        // 崩溃窗口：子会话已有执行记录但 phase=NULL（未被 CrashRecoveryRunner 恢复），应能抢占成功
        when(sessionMapper.selectById(1L)).thenReturn(parentSession(1L));
        when(sessionMapper.selectById(100L)).thenReturn(childSession(100L, 1L, "SUBAGENT", null));
        when(subagentExecutionMapper.selectList(any(LambdaQueryWrapper.class))).thenReturn(List.of(execution("reviewer")));
        when(definitionRegistry.getDefinition("reviewer"))
                .thenReturn(AgentDefinition.builder().name("reviewer").build());
        when(sessionMapper.update(any(), any(LambdaUpdateWrapper.class))).thenReturn(1);
        when(sessionCompactionService.loadValidated(100L)).thenReturn(null);
        when(sessionCompactionService.boundaryOf(null)).thenReturn(0L);
        when(agentLoop.getCancelFlag(1L)).thenReturn(null);
        when(agentLoop.registerCancelFlag(100L)).thenReturn(new AtomicBoolean(false));
        when(delegateTool.buildSubContext(any(Session.class), any(AgentDefinition.class)))
                .thenReturn(new AgentExecutionContext());
        SubAgentResultCollector collector = new SubAgentResultCollector();
        collector.onThinkingStart();
        collector.onContentDelta("OK");
        collector.onMessageEnd(ChatUsage.builder().totalTokens(5).build());
        when(visibilityService.executeVisibleWithTimeout(any(Session.class), any(AgentExecutionContext.class),
                anyBoolean(), any(AtomicBoolean.class), anyLong(), anyLong()))
                .thenReturn(new SubAgentVisibilityService.VisibleRunResult(collector, "exec-null"));
        when(subagentExecutionMapper.selectCount(any(LambdaQueryWrapper.class))).thenReturn(1L);

        JsonNode result = objectMapper.readTree(tool.execute(
                "{\"child_session_id\":100,\"task\":\"跟进审查\"}", 1L, null));

        assertThat(result.get("success").asBoolean()).isTrue();
        verify(sessionService).cleanupIncompleteTailAfterId(eq(100L), eq(0L));
    }

    // ---------- 执行中取消（非 skip）：回滚消息、phase 置 CANCELLED ----------

    @Test
    void cancelDuringExecutionRollsBackMessages() throws Exception {
        when(sessionMapper.selectById(1L)).thenReturn(parentSession(1L));
        when(sessionMapper.selectById(100L)).thenReturn(childSession(100L, 1L, "SUBAGENT", "COMPLETED"));
        when(subagentExecutionMapper.selectList(any(LambdaQueryWrapper.class))).thenReturn(List.of(execution("reviewer")));
        when(definitionRegistry.getDefinition("reviewer"))
                .thenReturn(AgentDefinition.builder().name("reviewer").build());
        when(sessionMapper.update(any(), any(LambdaUpdateWrapper.class))).thenReturn(1);
        when(sessionCompactionService.loadValidated(100L)).thenReturn(null);
        when(sessionCompactionService.boundaryOf(null)).thenReturn(0L);
        when(agentLoop.getCancelFlag(1L)).thenReturn(null);
        AtomicBoolean childFlag = new AtomicBoolean(false);
        when(agentLoop.registerCancelFlag(100L)).thenReturn(childFlag);
        when(delegateTool.buildSubContext(any(Session.class), any(AgentDefinition.class)))
                .thenReturn(new AgentExecutionContext());
        // skip=false（执行已开始），执行期间子会话被取消 → childFlag 置 true
        when(visibilityService.executeVisibleWithTimeout(any(Session.class), any(AgentExecutionContext.class),
                anyBoolean(), any(AtomicBoolean.class), anyLong(), anyLong()))
                .thenAnswer(inv -> {
                    childFlag.set(true);
                    return new SubAgentVisibilityService.VisibleRunResult(new SubAgentResultCollector(), "exec-mid");
                });
        when(subagentExecutionMapper.selectCount(any(LambdaQueryWrapper.class))).thenReturn(2L);
        Message saved = new Message();
        saved.setId(300L);
        when(sessionService.saveMessage(eq(100L), eq("USER"), any(), any(), any(), any(), any(), any()))
                .thenReturn(saved);

        JsonNode result = objectMapper.readTree(tool.execute(
                "{\"child_session_id\":100,\"task\":\"跟进审查\"}", 1L, null));

        assertThat(result.get("cancelled").asBoolean()).isTrue();
        // 回滚本次追问消息；非 skip 不恢复原终态（由 finishSubagent 置 CANCELLED）
        verify(messageMapper).delete(any(LambdaQueryWrapper.class));
        verify(visibilityService).finishSubagent(eq(100L), eq(7L), eq("CANCELLED"), eq("exec-mid"));
        verify(sessionMapper, org.mockito.Mockito.times(1)).update(any(), any(LambdaUpdateWrapper.class));
    }

    // ---------- 子上下文工具过滤（防递归） ----------

    @Test
    void buildSubContextExcludesDelegateAndFollowupTools() {
        AgentDefinitionRegistry reg = mock(AgentDefinitionRegistry.class);
        HarnessService hs = mock(HarnessService.class);
        AgentLoop al = mock(AgentLoop.class);
        SessionService ss = mock(SessionService.class);
        SessionMapper sm = mock(SessionMapper.class);
        SubagentExecutionMapper sem = mock(SubagentExecutionMapper.class);
        LocalToolSessionRegistry ltsr = mock(LocalToolSessionRegistry.class);
        SubAgentVisibilityService svs = mock(SubAgentVisibilityService.class);
        DelegateTool realDelegate = new DelegateTool(reg, hs, al, ss, sm, sem, ltsr, svs,
                new DelegateConfig(), objectMapper);

        Tool fakeDelegate = mock(Tool.class);
        when(fakeDelegate.getName()).thenReturn("delegate");
        Tool fakeFollowup = mock(Tool.class);
        when(fakeFollowup.getName()).thenReturn("delegate_followup");
        Tool fakeRead = mock(Tool.class);
        when(fakeRead.getName()).thenReturn("read_file");

        AgentExecutionContext ctx = new AgentExecutionContext();
        ctx.setTools(List.of(fakeDelegate, fakeFollowup, fakeRead));
        when(hs.buildContext(100L)).thenReturn(ctx);

        Session child = new Session();
        child.setId(100L);
        AgentDefinition def = AgentDefinition.builder().name("reviewer").build();

        AgentExecutionContext subCtx = realDelegate.buildSubContext(child, def);

        List<String> names = subCtx.getTools().stream().map(Tool::getName).toList();
        assertThat(names).contains("read_file")
                .doesNotContain("delegate", "delegate_followup");
    }
}
