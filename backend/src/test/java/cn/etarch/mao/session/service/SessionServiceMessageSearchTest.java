package cn.etarch.mao.session.service;

import cn.etarch.mao.agent.entity.Agent;
import cn.etarch.mao.agent.mapper.AgentMapper;
import cn.etarch.mao.agent.service.AgentService;
import cn.etarch.mao.command.service.UserCommandService;
import cn.etarch.mao.common.exception.BusinessException;
import cn.etarch.mao.common.result.ErrorCode;
import cn.etarch.mao.harness.core.EnvironmentInfoProvider;
import cn.etarch.mao.harness.safety.PathSandbox;
import cn.etarch.mao.session.entity.Message;
import cn.etarch.mao.session.entity.Session;
import cn.etarch.mao.session.mapper.FileChangeMapper;
import cn.etarch.mao.session.mapper.MessageMapper;
import cn.etarch.mao.session.mapper.SessionMapper;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.Spy;
import org.mockito.junit.jupiter.MockitoExtension;

import java.time.LocalDateTime;
import java.util.List;
import java.util.Map;
import java.util.Set;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

@ExtendWith(MockitoExtension.class)
class SessionServiceMessageSearchTest {

    @Mock private SessionMapper sessionMapper;
    @Mock private MessageMapper messageMapper;
    @Mock private FileChangeMapper fileChangeMapper;
    @Mock private AgentMapper agentMapper;
    @Mock private AgentService agentService;
    @Mock private PathSandbox pathSandbox;
    @Spy private ObjectMapper objectMapper = new ObjectMapper();
    @Mock private EnvironmentInfoProvider environmentInfoProvider;
    @Mock private UserCommandService userCommandService;
    @Mock private GitOperationService gitOperationService;
    @Mock private SessionCompactionService sessionCompactionService;
    @Mock private SessionCompactionEventService sessionCompactionEventService;

    @InjectMocks private SessionService sessionService;

    private Session session(long id, String title, String sessionType, Long agentId, LocalDateTime updatedAt) {
        Session s = new Session();
        s.setId(id);
        s.setTitle(title);
        s.setSessionType(sessionType);
        s.setAgentId(agentId);
        s.setUpdatedAt(updatedAt);
        s.setPhase("COMPLETED");
        return s;
    }

    private Message message(long id, long sessionId, String content) {
        Message m = new Message();
        m.setId(id);
        m.setSessionId(sessionId);
        m.setRole("USER");
        m.setContent(content);
        return m;
    }

    @Test
    void returnsHitSessionWithSnippetAndAgentName() {
        Session s = session(1L, "修复登录 Bug", "NORMAL", 9L, LocalDateTime.of(2026, 8, 7, 10, 30));
        Message m = message(100L, 1L, "帮我看看登录页面为什么报 500 错误");
        when(sessionMapper.selectMessageSearchCandidates(7L, "登录")).thenReturn(List.of(s));
        when(messageMapper.selectMessagesForSearch(List.of(1L), "登录")).thenReturn(List.of(m));
        when(agentMapper.selectBatchIds(Set.of(9L))).thenReturn(List.of(agent(9L, "默认 Agent")));

        List<SessionService.MessageSearchItem> items = sessionService.searchSessionsByUserMessage(7L, "登录");

        assertThat(items).hasSize(1);
        SessionService.MessageSearchItem item = items.get(0);
        assertThat(item.id()).isEqualTo(1L);
        assertThat(item.title()).isEqualTo("修复登录 Bug");
        assertThat(item.sessionType()).isEqualTo("NORMAL");
        assertThat(item.parentSessionId()).isNull();
        assertThat(item.phase()).isEqualTo("COMPLETED");
        assertThat(item.agentName()).isEqualTo("默认 Agent");
        assertThat(item.snippet()).contains("登录");
        assertThat(item.updatedAt()).isEqualTo("2026-08-07T10:30");
    }

    private Agent agent(long id, String name) {
        Agent a = new Agent();
        a.setId(id);
        a.setName(name);
        return a;
    }

    @Test
    void returnsEmptyWhenNoCandidates() {
        when(sessionMapper.selectMessageSearchCandidates(7L, "不存在")).thenReturn(List.of());

        assertThat(sessionService.searchSessionsByUserMessage(7L, "不存在")).isEmpty();
    }

    @Test
    void throwsWhenKeywordBlank() {
        assertThatThrownBy(() -> sessionService.searchSessionsByUserMessage(7L, "   "))
                .isInstanceOfSatisfying(BusinessException.class, e ->
                        assertThat(e.getCode()).isEqualTo(ErrorCode.PARAM_MISSING.getCode()));
    }

    @Test
    void throwsWhenKeywordTooLong() {
        String keyword = "a".repeat(101);
        assertThatThrownBy(() -> sessionService.searchSessionsByUserMessage(7L, keyword))
                .isInstanceOfSatisfying(BusinessException.class, e ->
                        assertThat(e.getCode()).isEqualTo(ErrorCode.PARAM_INVALID.getCode()));
    }

    @Test
    void escapesLikeWildcardsBeforeQuery() {
        // 输入含 % _ \ ，传给 SQL 前须转义（配合 ESCAPE '\'）
        sessionService.searchSessionsByUserMessage(7L, "100%_\\bug");
        verify(sessionMapper).selectMessageSearchCandidates(7L, "100\\%\\_\\\\bug");
    }

    @Test
    void snippetContainsKeywordWhenKeywordInMiddle() {
        String text = "a".repeat(60) + "登录页面" + "b".repeat(60);
        String snippet = SessionService.buildSnippet(text, "登录页面");

        assertThat(snippet).contains("登录页面");
        assertThat(snippet).startsWith("…").endsWith("…");
        // 总长控制在约 80 字内（关键词 4 字 + 前后各 ~25 字 + 省略号）
        assertThat(snippet.length()).isLessThanOrEqualTo(82);
    }

    @Test
    void rejectsMultimodalFalseHit() {
        // SQL LIKE 命中 JSON 字段/URL，但纯文本不含关键词 → 剔除（不产生不可解释结果）
        String jsonContent = "[{\"type\":\"text\",\"text\":\"帮我看看这个图片\"},"
                + "{\"type\":\"image_url\",\"url\":\"http://x/login.png\"}]";
        Session s = session(2L, "图片会话", "NORMAL", null, LocalDateTime.now());
        Message m = message(200L, 2L, jsonContent);
        when(sessionMapper.selectMessageSearchCandidates(7L, "image\\_url")).thenReturn(List.of(s));
        when(messageMapper.selectMessagesForSearch(List.of(2L), "image\\_url")).thenReturn(List.of(m));

        assertThat(sessionService.searchSessionsByUserMessage(7L, "image_url")).isEmpty();
    }

    @Test
    void acceptsMultimodalTextPart() {
        String jsonContent = "[{\"type\":\"text\",\"text\":\"登录页面报错了\"},"
                + "{\"type\":\"image_url\",\"url\":\"http://x/a.png\"}]";
        Session s = session(3L, "带图会话", "NORMAL", null, LocalDateTime.now());
        Message m = message(300L, 3L, jsonContent);
        when(sessionMapper.selectMessageSearchCandidates(7L, "登录")).thenReturn(List.of(s));
        when(messageMapper.selectMessagesForSearch(List.of(3L), "登录")).thenReturn(List.of(m));

        List<SessionService.MessageSearchItem> items = sessionService.searchSessionsByUserMessage(7L, "登录");

        assertThat(items).hasSize(1);
        assertThat(items.get(0).snippet()).contains("登录页面报错了").doesNotContain("image_url");
    }

    @Test
    void skipsFalseHitSessionAndKeepsTextHitSession() {
        Session imageOnly = session(4L, "仅图片", "NORMAL", null, LocalDateTime.now());
        Session textHit = session(5L, "文本命中", "NORMAL", null, LocalDateTime.now());
        Message imageMsg = message(401L, 4L,
                "[{\"type\":\"image_url\",\"url\":\"http://x/登录.png\"}]");
        Message textMsg = message(501L, 5L, "这里提到登录页面");

        when(sessionMapper.selectMessageSearchCandidates(7L, "登录")).thenReturn(List.of(imageOnly, textHit));
        when(messageMapper.selectMessagesForSearch(List.of(4L, 5L), "登录"))
                .thenReturn(List.of(imageMsg, textMsg));

        List<SessionService.MessageSearchItem> items = sessionService.searchSessionsByUserMessage(7L, "登录");

        assertThat(items).hasSize(1);
        assertThat(items.get(0).id()).isEqualTo(5L);
    }

    @Test
    void usesFirstHitMessageForSnippet() {
        Session s = session(6L, "多条命中", "NORMAL", null, LocalDateTime.now());
        Message first = message(1L, 6L, "开头 abc登录");
        Message second = message(2L, 6L, "xyz登录123");
        when(sessionMapper.selectMessageSearchCandidates(7L, "登录")).thenReturn(List.of(s));
        when(messageMapper.selectMessagesForSearch(List.of(6L), "登录")).thenReturn(List.of(first, second));

        List<SessionService.MessageSearchItem> items = sessionService.searchSessionsByUserMessage(7L, "登录");

        assertThat(items).hasSize(1);
        assertThat(items.get(0).snippet()).contains("开头");
    }

    @Test
    void caseInsensitiveMatchConsistentWithCollation() {
        assertThat(SessionService.buildSnippet("Login failed for user", "login")).isNotNull();
        assertThat(SessionService.buildSnippet("登录 Login 页面", "login")).isNotNull();
        assertThat(SessionService.buildSnippet("没有这个单词", "Login")).isNull();
    }

    @Test
    void keywordNotInTextReturnsNullSnippet() {
        assertThat(SessionService.buildSnippet("完全无关的内容", "关键词")).isNull();
    }

    @Test
    void extractVisibleTextHandlesPlainAndMultimodal() {
        assertThat(sessionService.extractVisibleText("纯文本消息")).isEqualTo("纯文本消息");
        assertThat(sessionService.extractVisibleText(
                "[{\"type\":\"text\",\"text\":\"文本A\"},{\"type\":\"image_url\",\"url\":\"u\"}]"))
                .isEqualTo("文本A");
        assertThat(sessionService.extractVisibleText(null)).isNull();
        // 非法 JSON 回退原文，第二层校验会再次判断
        assertThat(sessionService.extractVisibleText("[broken")).isEqualTo("[broken");
        // 恰好是合法 JSON 数组的普通文本（无 type 字段）→ 按纯文本处理，不做多模态提取
        assertThat(sessionService.extractVisibleText("[\"登录\",\"500\"]")).isEqualTo("[\"登录\",\"500\"]");
        assertThat(sessionService.extractVisibleText("[1,2,3]")).isEqualTo("[1,2,3]");
        // 混合数组（部分元素非 ContentPart）→ 按纯文本处理，避免丢失非 text 元素内容
        assertThat(sessionService.extractVisibleText("[1,{\"type\":\"text\",\"text\":\"abc\"}]"))
                .isEqualTo("[1,{\"type\":\"text\",\"text\":\"abc\"}]");
        // 空数组按纯文本处理
        assertThat(sessionService.extractVisibleText("[]")).isEqualTo("[]");
    }

    @Test
    void skipsMultimodalFalseHitInsideSameSessionAndUsesLaterTextHit() {
        // 同一会话：首条命中为多模态假命中（关键词在图片 URL），后续有真实文本命中 → 不应剔除整个会话
        Session s = session(14L, "先图后文", "NORMAL", null, LocalDateTime.now());
        Message imageMsg = message(1L, 14L,
                "[{\"type\":\"image_url\",\"url\":\"http://x/登录.png\"}]");
        Message textMsg = message(2L, 14L, "后续提到了登录页面");
        when(sessionMapper.selectMessageSearchCandidates(7L, "登录")).thenReturn(List.of(s));
        when(messageMapper.selectMessagesForSearch(List.of(14L), "登录"))
                .thenReturn(List.of(imageMsg, textMsg));

        List<SessionService.MessageSearchItem> items = sessionService.searchSessionsByUserMessage(7L, "登录");

        assertThat(items).hasSize(1);
        assertThat(items.get(0).id()).isEqualTo(14L);
        assertThat(items.get(0).snippet()).contains("登录").doesNotContain("image_url");
    }

    @Test
    void plainJsonArrayMessageMatchesAsText() {
        // 用户输入恰好是合法 JSON 数组（如 ["登录","500"]），应按纯文本匹配而非多模态剔除
        String jsonContent = "[\"登录\",\"500\"]";
        Session s = session(13L, "数组文本", "NORMAL", null, LocalDateTime.now());
        Message m = message(1L, 13L, jsonContent);
        when(sessionMapper.selectMessageSearchCandidates(7L, "登录")).thenReturn(List.of(s));
        when(messageMapper.selectMessagesForSearch(List.of(13L), "登录")).thenReturn(List.of(m));

        List<SessionService.MessageSearchItem> items = sessionService.searchSessionsByUserMessage(7L, "登录");

        assertThat(items).hasSize(1);
        assertThat(items.get(0).snippet()).contains("登录");
    }

    @Test
    void updatedAtSortComesFromCandidateOrder() {
        // 候选已按 updated_at DESC 排序（SQL 保证），Service 保持原序即可
        Session newer = session(10L, "较新", "NORMAL", null, LocalDateTime.of(2026, 8, 7, 12, 0));
        Session older = session(11L, "较旧", "NORMAL", null, LocalDateTime.of(2026, 8, 1, 9, 0));
        Message msgNew = message(1L, 10L, "新的登录问题");
        Message msgOld = message(2L, 11L, "旧的登录问题");
        when(sessionMapper.selectMessageSearchCandidates(7L, "登录")).thenReturn(List.of(newer, older));
        when(messageMapper.selectMessagesForSearch(List.of(10L, 11L), "登录")).thenReturn(List.of(msgNew, msgOld));

        List<SessionService.MessageSearchItem> items = sessionService.searchSessionsByUserMessage(7L, "登录");

        assertThat(items.stream().map(SessionService.MessageSearchItem::id).toList())
                .containsExactly(10L, 11L);
    }

    @Test
    void emptyGroupingSurvivesNullContentMessages() {
        // 候选会话存在，但命中消息 content 为 null（异常数据）→ 不抛错、剔除该会话
        Session s = session(12L, "空内容", "NORMAL", null, LocalDateTime.now());
        Message m = message(1L, 12L, null);
        when(sessionMapper.selectMessageSearchCandidates(7L, "关键词")).thenReturn(List.of(s));
        when(messageMapper.selectMessagesForSearch(List.of(12L), "关键词")).thenReturn(List.of(m));

        assertThat(sessionService.searchSessionsByUserMessage(7L, "关键词")).isEmpty();
    }

    @Test
    void mapKeysNormalizedForGrouping() {
        // 回归：groupingBy 的 key 应为 Long 而非可变的 Message 对象引用
        Map<Long, List<Message>> grouped = List.of(message(1L, 42L, "内容"))
                .stream().collect(java.util.stream.Collectors.groupingBy(Message::getSessionId));
        assertThat(grouped.keySet()).containsExactly(42L);
    }
}
