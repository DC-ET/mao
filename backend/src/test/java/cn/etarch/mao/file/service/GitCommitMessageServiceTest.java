package cn.etarch.mao.file.service;

import cn.etarch.mao.common.exception.BusinessException;
import cn.etarch.mao.harness.core.HarnessService;
import cn.etarch.mao.harness.llm.ChatRequest;
import cn.etarch.mao.harness.llm.ChatResponse;
import cn.etarch.mao.harness.llm.ChatUsage;
import cn.etarch.mao.harness.llm.LlmAdapter;
import cn.etarch.mao.model.entity.LlmModel;
import cn.etarch.mao.session.entity.Session;
import cn.etarch.mao.usage.service.LlmUsageService;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;

import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

class GitCommitMessageServiceTest {

    @Test
    void retriesInvalidFormatAndRecordsBothCalls() {
        HarnessService harness = mock(HarnessService.class);
        LlmUsageService usage = mock(LlmUsageService.class);
        LlmAdapter adapter = mock(LlmAdapter.class);
        when(harness.resolveModel(9L)).thenReturn(model());
        AtomicInteger calls = new AtomicInteger();
        when(adapter.chat(any(), any())).thenAnswer(invocation -> response(
                calls.getAndIncrement() == 0 ? "not conventional" : "fix(git): 修复提交操作\n\n- 增加安全校验"));
        GitCommitMessageService service = new GitCommitMessageService(adapter, harness, usage, new ObjectMapper());

        GitCommitMessageService.CommitMessage result = service.generate(session(), input("src/A.java", "diff"));

        assertThat(result.title()).isEqualTo("fix(git): 修复提交操作");
        verify(adapter, times(2)).chat(any(), any());
        verify(usage, times(2)).record(eq(1L), eq(2L), eq(9L),
                eq(LlmUsageService.SCENE_GIT_COMMIT_MESSAGE), any(ChatUsage.class), eq(true));
        service.shutdown();
    }

    @Test
    void rejectsSensitiveDiffAndOversizeInput() {
        GitCommitMessageService service = new GitCommitMessageService(
                mock(LlmAdapter.class), mock(HarnessService.class), mock(LlmUsageService.class), new ObjectMapper());
        GitCommitMessageService.CommitGenerationInput input = input(".env", "password=x");
        input.getFiles().get(0).setSensitive(true);

        assertThatThrownBy(() -> service.validateInput(input)).isInstanceOf(BusinessException.class)
                .hasMessageContaining("敏感");
        service.shutdown();
    }

    @Test
    void promptContainsOnlyStructuredChangesAndNoTools() {
        HarnessService harness = mock(HarnessService.class);
        when(harness.resolveModel(9L)).thenReturn(model());
        LlmAdapter adapter = mock(LlmAdapter.class);
        when(adapter.chat(any(), any())).thenReturn(response("feat(api): 增加接口\n\n- 增加本地活动记录接口"));
        GitCommitMessageService service = new GitCommitMessageService(
                adapter, harness, mock(LlmUsageService.class), new ObjectMapper());

        service.generate(session(), input("src/A.java", "+新增"));

        ArgumentCaptor<ChatRequest> request = ArgumentCaptor.forClass(ChatRequest.class);
        verify(adapter).chat(request.capture(), any());
        assertThat(request.getValue().getTools()).isEmpty();
        assertThat(request.getValue().getMessages()).hasSize(2);
        assertThat(request.getValue().getMessages().get(1).getContent().toString()).contains("src/A.java", "+新增");
        service.shutdown();
    }

    private static GitCommitMessageService.CommitGenerationInput input(String path, String diff) {
        GitCommitMessageService.CommitFile file = new GitCommitMessageService.CommitFile();
        file.setPath(path); file.setChangeType("MODIFIED"); file.setDiff(diff);
        GitCommitMessageService.CommitGenerationInput input = new GitCommitMessageService.CommitGenerationInput();
        input.setFiles(List.of(file)); input.setDiffBytes(diff.getBytes(java.nio.charset.StandardCharsets.UTF_8).length);
        return input;
    }

    private static ChatResponse response(String content) {
        return ChatResponse.builder().usage(new ChatUsage(10, 5, 15)).choices(List.of(
                ChatResponse.Choice.builder().message(ChatRequest.Message.builder().content(content).build()).build())).build();
    }
    private static Session session() { Session s = new Session(); s.setId(2L); s.setUserId(1L); s.setModelId(9L); return s; }
    private static LlmModel model() { LlmModel m = new LlmModel(); m.setId(9L); m.setName("test"); m.setModelId("test"); return m; }
}
