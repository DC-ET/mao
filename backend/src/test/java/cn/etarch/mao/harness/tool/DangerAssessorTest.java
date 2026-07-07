package cn.etarch.mao.harness.tool;

import cn.etarch.mao.harness.llm.ChatRequest;
import cn.etarch.mao.harness.llm.ChatResponse;
import cn.etarch.mao.harness.llm.LlmAdapter;
import cn.etarch.mao.harness.llm.LlmModelConfig;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class DangerAssessorTest {

    private final LlmAdapter llmAdapter = mock(LlmAdapter.class);
    private final DangerAssessor assessor = new DangerAssessor(llmAdapter, new ObjectMapper());
    private final LlmModelConfig modelConfig = LlmModelConfig.builder().modelId("test").build();

    @Test
    void returnsSafeWhenClassifierSaysSafe() {
        when(llmAdapter.chat(any(), any())).thenReturn(response("SAFE"));

        DangerAssessor.DangerResult result = assessor.assess("{\"command\":\"ls -la\"}", modelConfig);

        assertThat(result.dangerous()).isFalse();
        assertThat(result.reason()).isNull();
        verify(llmAdapter).chat(any(ChatRequest.class), any(LlmModelConfig.class));
    }

    @Test
    void returnsDangerousWithReasonWhenClassifierFlagsCommand() {
        when(llmAdapter.chat(any(), any())).thenReturn(response("DANGEROUS: 删除文件"));

        DangerAssessor.DangerResult result = assessor.assess("{\"command\":\"rm -rf target\"}", modelConfig);

        assertThat(result.dangerous()).isTrue();
        assertThat(result.reason()).isEqualTo("删除文件");
    }

    @Test
    void defaultsToDangerousWhenClassifierFails() {
        when(llmAdapter.chat(any(), any())).thenThrow(new RuntimeException("down"));

        DangerAssessor.DangerResult result = assessor.assess("not json", modelConfig);

        assertThat(result.dangerous()).isTrue();
        assertThat(result.reason()).contains("安全评估服务异常");
    }

    private ChatResponse response(String verdict) {
        return ChatResponse.builder()
                .choices(List.of(ChatResponse.Choice.builder()
                        .message(ChatRequest.Message.builder().content(verdict).build())
                        .build()))
                .build();
    }
}
