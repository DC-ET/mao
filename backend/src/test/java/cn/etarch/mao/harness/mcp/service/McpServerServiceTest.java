package cn.etarch.mao.harness.mcp.service;

import cn.etarch.mao.agent.mapper.AgentMapper;
import cn.etarch.mao.common.exception.BusinessException;
import cn.etarch.mao.harness.mcp.crypto.McpSecretCipher;
import cn.etarch.mao.harness.mcp.entity.McpServer;
import cn.etarch.mao.harness.mcp.mapper.McpServerMapper;
import cn.etarch.mao.harness.mcp.preference.service.UserMcpPreferenceService;
import cn.etarch.mao.user.mapper.UserMapper;
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
    private final UserMapper userMapper = mock(UserMapper.class);
    private final UserMcpPreferenceService userMcpPreferenceService = mock(UserMcpPreferenceService.class);
    private final McpServerService service =
            new McpServerService(mcpServerMapper, agentMapper, secretCipher, new ObjectMapper(),
                    userMapper, userMcpPreferenceService);

    private McpServer enabled;
    private McpServer disabled;

    @BeforeEach
    void setUp() {
        enabled = new McpServer();
        enabled.setId(1L);
        enabled.setUserId(McpServerService.GLOBAL_USER_ID);
        enabled.setName("filesystem");
        enabled.setServerType(McpServer.TYPE_STDIO);
        enabled.setCommand("npx");
        enabled.setArgsJson("[\"-y\",\"@modelcontextprotocol/server-filesystem\"]");
        enabled.setStatus(McpServer.STATUS_ENABLED);

        disabled = new McpServer();
        disabled.setId(2L);
        disabled.setUserId(McpServerService.GLOBAL_USER_ID);
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

    @Test
    void validateForAgentRejectsUserOwnServer() {
        McpServer mine = new McpServer();
        mine.setId(100L);
        mine.setUserId(9L);
        mine.setName("my-storage");
        mine.setStatus(McpServer.STATUS_ENABLED);
        when(mcpServerMapper.selectById(100L)).thenReturn(mine);
        assertThatThrownBy(() -> service.validateForAgent(List.of(100L)))
                .isInstanceOf(BusinessException.class)
                .hasMessageContaining("私有服务器");
    }

    @Test
    void createMineAssignsOwnerAndRejectsNameConflictingWithGlobal() {
        // 第 1 次 createMine：同用户查重 0 + 跨归属（全局）查重 0；第 2 次 createMine：同用户查重 0 + 全局查重 1
        when(mcpServerMapper.selectCount(any())).thenReturn(0L, 0L, 0L, 1L);
        McpServer mine = service.createMine(9L, "my-storage", null, McpServer.TYPE_HTTP,
                null, null, "https://my.example.com", null);
        assertThat(mine.getUserId()).isEqualTo(9L);
        assertThat(mine.getStatus()).isEqualTo(McpServer.STATUS_ENABLED);

        // 私有服务器名称与全局服务器冲突
        assertThatThrownBy(() -> service.createMine(9L, "my-storage", null, McpServer.TYPE_HTTP,
                null, null, "https://my.example.com", null))
                .isInstanceOf(BusinessException.class)
                .hasMessageContaining("全局");
    }

    @Test
    void createGlobalRejectsNameConflictingWithUserOwnServer() {
        // 全局创建 foo：同归属（全局）查重 0 + 跨归属（私有）查重 1 → 拒绝
        when(mcpServerMapper.selectCount(any())).thenReturn(0L, 1L);
        assertThatThrownBy(() -> service.create("foo", null, McpServer.TYPE_HTTP,
                null, null, "https://global.example.com", null))
                .isInstanceOf(BusinessException.class)
                .hasMessageContaining("其他 MCP 服务器");
    }

    @Test
    void createMineAllowsSameNameForDifferentUsers() {
        // 用户 9 创建 foo：同归属 0 + 全局 0；用户 10 创建 foo：同归属 0 + 全局 0（私有之间不冲突）
        when(mcpServerMapper.selectCount(any())).thenReturn(0L, 0L, 0L, 0L);
        McpServer a = service.createMine(9L, "foo", null, McpServer.TYPE_HTTP,
                null, null, "https://a.example.com", null);
        McpServer b = service.createMine(10L, "foo", null, McpServer.TYPE_HTTP,
                null, null, "https://b.example.com", null);
        assertThat(a.getUserId()).isEqualTo(9L);
        assertThat(b.getUserId()).isEqualTo(10L);
    }

    @Test
    void getMineRejectsServerOwnedByAnotherUser() {
        McpServer mine = new McpServer();
        mine.setId(100L);
        mine.setUserId(9L);
        mine.setName("my-storage");
        when(mcpServerMapper.selectById(100L)).thenReturn(mine);
        assertThatThrownBy(() -> service.getMine(10L, 100L))
                .isInstanceOf(BusinessException.class)
                .hasMessageContaining("无权");
    }
}
