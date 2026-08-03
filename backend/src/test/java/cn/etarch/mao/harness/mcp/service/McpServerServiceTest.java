package cn.etarch.mao.harness.mcp.service;

import cn.etarch.mao.agent.mapper.AgentMapper;
import cn.etarch.mao.common.exception.BusinessException;
import cn.etarch.mao.harness.mcp.crypto.McpSecretCipher;
import cn.etarch.mao.harness.mcp.entity.McpServer;
import cn.etarch.mao.harness.mcp.mapper.McpServerMapper;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

class McpServerServiceTest {

    private final McpServerMapper mcpServerMapper = mock(McpServerMapper.class);
    private final AgentMapper agentMapper = mock(AgentMapper.class);
    private final McpSecretCipher secretCipher = new McpSecretCipher("test-secret");
    private final McpServerService service =
            new McpServerService(mcpServerMapper, agentMapper, secretCipher, new ObjectMapper());

    private McpServer enabled;
    private McpServer disabled;

    @BeforeEach
    void setUp() {
        enabled = new McpServer();
        enabled.setId(1L);
        enabled.setName("filesystem");
        enabled.setServerType(McpServer.TYPE_STDIO);
        enabled.setCommand("npx");
        enabled.setArgsJson("[\"-y\",\"@modelcontextprotocol/server-filesystem\"]");
        enabled.setStatus(McpServer.STATUS_ENABLED);

        disabled = new McpServer();
        disabled.setId(2L);
        disabled.setName("old-server");
        disabled.setStatus(McpServer.STATUS_DISABLED);
    }

    @Test
    void validateForAgentReturnsDeduplicatedExistingEnabledIdsInOrder() {
        when(mcpServerMapper.selectById(1L)).thenReturn(enabled);
        assertThat(service.validateForAgent(List.of(1L, 1L, 1L))).isEqualTo(List.of(1L));
    }

    @Test
    void validateForAgentRejectsMissingServer() {
        when(mcpServerMapper.selectById(99L)).thenReturn(null);
        assertThatThrownBy(() -> service.validateForAgent(List.of(99L)))
                .isInstanceOf(BusinessException.class)
                .hasMessageContaining("不存在");
    }

    @Test
    void validateForAgentRejectsDisabledServer() {
        when(mcpServerMapper.selectById(2L)).thenReturn(disabled);
        assertThatThrownBy(() -> service.validateForAgent(List.of(2L)))
                .isInstanceOf(BusinessException.class)
                .hasMessageContaining("已停用");
    }

    @Test
    void validateForAgentReturnsEmptyForNullOrEmpty() {
        assertThat(service.validateForAgent(null)).isEmpty();
        assertThat(service.validateForAgent(List.of())).isEmpty();
    }

    @Test
    void rejectsServerNameWithConsecutiveUnderscores() {
        assertThatThrownBy(() -> service.create("foo__bar", null, McpServer.TYPE_STDIO,
                "npx", List.of("-y", "x"), null, null))
                .isInstanceOf(BusinessException.class)
                .hasMessageContaining("连续下划线");
    }

    @Test
    void acceptsServerNameWithSingleUnderscore() {
        when(mcpServerMapper.selectCount(any())).thenReturn(0L);
        McpServer created = service.create("foo_bar", null, McpServer.TYPE_STDIO,
                "npx", List.of("-y", "x"), null, null);
        assertThat(created.getName()).isEqualTo("foo_bar");
        assertThat(created.getStatus()).isEqualTo(McpServer.STATUS_ENABLED);
    }

    @Test
    void createStoresEncryptedEnvAndDecryptsRoundTrip() {
        McpServer created = service.create("github", null, McpServer.TYPE_HTTP,
                null, null, "https://mcp.example.com/github",
                java.util.Map.of("API_KEY", "sk-secret-123"));
        assertThat(created.getEnvJson()).isNotBlank();
        assertThat(created.getEnvJson()).doesNotContain("sk-secret-123");
        assertThat(service.decryptEnv(created)).containsEntry("API_KEY", "sk-secret-123");
    }
}
