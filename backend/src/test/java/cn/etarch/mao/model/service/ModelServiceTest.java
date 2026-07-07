package cn.etarch.mao.model.service;

import cn.etarch.mao.common.exception.BusinessException;
import cn.etarch.mao.harness.llm.ChatRequest;
import cn.etarch.mao.harness.llm.ChatResponse;
import cn.etarch.mao.harness.llm.LlmModelConfig;
import cn.etarch.mao.harness.llm.OpenAiLlmAdapter;
import cn.etarch.mao.model.entity.LlmModel;
import cn.etarch.mao.model.mapper.LlmModelMapper;
import cn.etarch.mao.session.mapper.SessionMapper;
import com.baomidou.mybatisplus.core.conditions.query.QueryWrapper;
import com.baomidou.mybatisplus.core.conditions.update.UpdateWrapper;
import com.baomidou.mybatisplus.extension.plugins.pagination.Page;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;

import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

@SuppressWarnings("unchecked")
class ModelServiceTest {

    private final LlmModelMapper modelMapper = mock(LlmModelMapper.class);
    private final SessionMapper sessionMapper = mock(SessionMapper.class);
    private final OpenAiLlmAdapter llmAdapter = mock(OpenAiLlmAdapter.class);
    private final ModelService service = new ModelService(modelMapper, sessionMapper, llmAdapter);

    @Test
    void listAndLookupMethodsDelegateToMapper() {
        Page<LlmModel> expectedPage = Page.of(2, 5);
        List<LlmModel> active = List.of(model(1L, "gpt", 0, 1));
        LlmModel defaultModel = model(2L, "default", 1, 1);
        when(modelMapper.selectPage(any(Page.class), any(QueryWrapper.class))).thenReturn(expectedPage);
        when(modelMapper.selectList(any(QueryWrapper.class))).thenReturn(active);
        when(modelMapper.selectOne(any(QueryWrapper.class))).thenReturn(defaultModel);
        when(modelMapper.selectObjs(any(QueryWrapper.class))).thenReturn(List.of(" anthropic ", "openai", "", 7));

        assertThat(service.listModels(2, 5, null, null, null, null, null)).isSameAs(expectedPage);
        assertThat(service.listProviders()).containsExactly("anthropic", "openai");
        assertThat(service.listActiveModels()).isEqualTo(active);
        assertThat(service.getDefaultModel()).isSameAs(defaultModel);
    }

    @Test
    void getModelThrowsWhenMissing() {
        when(modelMapper.selectById(99L)).thenReturn(null);

        assertThatThrownBy(() -> service.getModel(99L))
                .isInstanceOf(BusinessException.class);
    }

    @Test
    void createModelAppliesDefaultsAndClearsExistingDefault() {
        LlmModel created = service.createModel(
                "  Name  ", "openai", "https://api", "key", "gpt-4o", null, 1, 128000);

        assertThat(created.getName()).isEqualTo("  Name  ");
        assertThat(created.getSupportsVision()).isZero();
        assertThat(created.getIsDefault()).isEqualTo(1);
        assertThat(created.getContextWindowTokens()).isEqualTo(128000);
        assertThat(created.getStatus()).isEqualTo(1);
        verify(modelMapper).update(any(LlmModel.class), any(QueryWrapper.class));
        verify(modelMapper).insert(created);
    }

    @Test
    void updateModelOnlyChangesProvidedFieldsAndCanSetDefault() {
        LlmModel existing = model(7L, "old", 0, 1);
        when(modelMapper.selectById(7L)).thenReturn(existing);

        LlmModel updated = service.updateModel(
                7L, "new", null, "https://new", null, "gpt-4.1", 1, 1, 256000);

        assertThat(updated.getName()).isEqualTo("new");
        assertThat(updated.getProvider()).isEqualTo("openai");
        assertThat(updated.getBaseUrl()).isEqualTo("https://new");
        assertThat(updated.getModelId()).isEqualTo("gpt-4.1");
        assertThat(updated.getSupportsVision()).isEqualTo(1);
        assertThat(updated.getIsDefault()).isEqualTo(1);
        assertThat(updated.getContextWindowTokens()).isEqualTo(256000);
        verify(modelMapper).update(any(LlmModel.class), any(QueryWrapper.class));
        verify(modelMapper).updateById(existing);
    }

    @Test
    void deleteModelRejectsDefaultAndReassignsSessionsForNormalModel() {
        LlmModel defaultModel = model(1L, "default", 1, 1);
        LlmModel oldModel = model(2L, "old", 0, 1);
        when(modelMapper.selectById(1L)).thenReturn(defaultModel);

        assertThatThrownBy(() -> service.deleteModel(1L))
                .isInstanceOf(BusinessException.class);

        when(modelMapper.selectById(2L)).thenReturn(oldModel);
        when(modelMapper.selectOne(any(QueryWrapper.class))).thenReturn(defaultModel);
        service.deleteModel(2L);

        verify(sessionMapper).update(eq(null), any(UpdateWrapper.class));
        verify(modelMapper).deleteById(2L);
    }

    @Test
    void updateStatusValidatesValueAndProtectsOnlyActiveDefault() {
        LlmModel defaultModel = model(3L, "default", 1, 1);
        when(modelMapper.selectById(3L)).thenReturn(defaultModel);
        when(modelMapper.selectCount(any(QueryWrapper.class))).thenReturn(0L);

        assertThatThrownBy(() -> service.updateStatus(3L, 2))
                .isInstanceOf(BusinessException.class);
        assertThatThrownBy(() -> service.updateStatus(3L, 0))
                .isInstanceOf(BusinessException.class);

        when(modelMapper.selectCount(any(QueryWrapper.class))).thenReturn(1L);
        service.updateStatus(3L, 0);

        assertThat(defaultModel.getStatus()).isZero();
        assertThat(defaultModel.getIsDefault()).isZero();
        verify(modelMapper).updateById(defaultModel);
    }

    @Test
    void testConnectivityCallsAdapterAndWrapsFailure() throws Exception {
        LlmModel model = model(8L, "ok", 0, 1);
        when(modelMapper.selectById(8L)).thenReturn(model);
        when(llmAdapter.chat(any(ChatRequest.class), any(LlmModelConfig.class)))
                .thenReturn(ChatResponse.builder().choices(List.of()).build());

        service.testConnectivity(8L);

        ArgumentCaptor<LlmModelConfig> configCaptor = ArgumentCaptor.forClass(LlmModelConfig.class);
        verify(llmAdapter).chat(any(ChatRequest.class), configCaptor.capture());
        assertThat(configCaptor.getValue().getModelId()).isEqualTo("model-ok");

        when(llmAdapter.chat(any(ChatRequest.class), any(LlmModelConfig.class)))
                .thenThrow(new RuntimeException("boom"));
        assertThatThrownBy(() -> service.testConnectivity(8L))
                .isInstanceOf(BusinessException.class)
                .hasMessageContaining("模型连通性测试失败");
    }

    private static LlmModel model(Long id, String name, Integer isDefault, Integer status) {
        LlmModel model = new LlmModel();
        model.setId(id);
        model.setName(name);
        model.setProvider("openai");
        model.setBaseUrl("https://api.example.test");
        model.setApiKey("key");
        model.setModelId("model-" + name);
        model.setIsDefault(isDefault);
        model.setStatus(status);
        return model;
    }
}
