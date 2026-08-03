package cn.etarch.mao.harness.mcp.local;

import cn.etarch.mao.agent.entity.Agent;
import cn.etarch.mao.harness.mcp.entity.McpServer;
import cn.etarch.mao.harness.mcp.mapper.McpServerMapper;
import cn.etarch.mao.harness.mcp.model.McpToolRef;
import cn.etarch.mao.harness.mcp.preference.service.UserMcpPreferenceService;
import cn.etarch.mao.harness.mcp.service.McpServerService;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class McpSyncServiceTest {

    private final McpServerMapper mcpServerMapper = mock(McpServerMapper.class);
    private final McpServerService mcpServerService = mock(McpServerService.class);
    private final McpToolsRegistry toolsRegistry = mock(McpToolsRegistry.class);
    private final UserMcpPreferenceService userMcpPreferenceService = mock(UserMcpPreferenceService.class);
    private final McpSyncService service =
            new McpSyncService(mcpServerMapper, mcpServerService, toolsRegistry,
                    new ObjectMapper(), userMcpPreferenceService);

    private McpServer stdioServer;
    private McpServer httpServer;

    @BeforeEach
    void setUp() {
        stdioServer = new McpServer();
        stdioServer.setId(1L);
        stdioServer.setName("filesystem");
        stdioServer.setServerType(McpServer.TYPE_STDIO);
        stdioServer.setCommand("npx");
        stdioServer.setArgsJson("[\"-y\",\"@modelcontextprotocol/server-filesystem\",\"/tmp\"]");
        stdioServer.setStatus(McpServer.STATUS_ENABLED);

        httpServer = new McpServer();
        httpServer.setId(2L);
        httpServer.setName("github");
        httpServer.setServerType(McpServer.TYPE_HTTP);
        httpServer.setUrl("https://mcp.example.com/github");
        httpServer.setStatus(McpServer.STATUS_ENABLED);
    }

    @Test
    void parsesAgentServerIdsJsonArray() {
        Agent agent = new Agent();
        agent.setMcpServerIds("[1,2,3]");
        assertThat(service.parseAgentServerIds(agent)).containsExactly(1L, 2L, 3L);
    }

    @Test
    void parsesBlankOrInvalidServerIdsAsEmpty() {
        assertThat(service.parseAgentServerIds(new Agent())).isEmpty();
        Agent agent = new Agent();
        agent.setMcpServerIds("not-json");
        assertThat(service.parseAgentServerIds(agent)).isEmpty();
    }

    @Test
    void loadAgentServersKeepsConfiguredOrderAndSkipsMissingOrDisabled() {
        Agent agent = new Agent();
        agent.setMcpServerIds("[1,2,3]");
        when(mcpServerMapper.selectById(1L)).thenReturn(stdioServer);
        when(mcpServerMapper.selectById(2L)).thenReturn(null);          // 已删除
        McpServer disabled = new McpServer();
        disabled.setId(3L);
        disabled.setName("disabled-srv");
        disabled.setStatus(McpServer.STATUS_DISABLED);
        when(mcpServerMapper.selectById(3L)).thenReturn(disabled);

        List<McpServer> servers = service.loadAgentServers(agent);

        assertThat(servers).hasSize(1);
        assertThat(servers.get(0).getId()).isEqualTo(1L);
    }

    @Test
    void loadAgentServersReturnsEmptyWhenNoIds() {
        assertThat(service.loadAgentServers(new Agent())).isEmpty();
        verify(mcpServerMapper, never()).selectById(any());
    }

    @Test
    void loadAgentServersFiltersUserDisabledServers() {
        Agent agent = new Agent();
        agent.setMcpServerIds("[1,2]");
        when(mcpServerMapper.selectById(1L)).thenReturn(stdioServer);
        when(mcpServerMapper.selectById(2L)).thenReturn(httpServer);
        // 用户停用了 server 2（github）
        when(userMcpPreferenceService.getDisabledServerIds(9L)).thenReturn(List.of(2L));

        List<McpServer> servers = service.loadAgentServers(agent, 9L);

        assertThat(servers).hasSize(1);
        assertThat(servers.get(0).getId()).isEqualTo(1L);
    }

    @Test
    void loadAgentServersWithoutUserIdSkipsUserFiltering() {
        Agent agent = new Agent();
        agent.setMcpServerIds("[1]");
        when(mcpServerMapper.selectById(1L)).thenReturn(stdioServer);

        assertThat(service.loadAgentServers(agent)).hasSize(1);
        verify(userMcpPreferenceService, never()).getDisabledServerIds(any());
    }

    @Test
    void loadAgentServersAppendsUserOwnServersAfterGlobalOnes() {
        Agent agent = new Agent();
        agent.setMcpServerIds("[1]");
        when(mcpServerMapper.selectById(1L)).thenReturn(stdioServer);
        // 用户 9 的私有服务器（自动生效）
        McpServer mine = new McpServer();
        mine.setId(100L);
        mine.setUserId(9L);
        mine.setName("my-storage");
        mine.setServerType(McpServer.TYPE_HTTP);
        mine.setUrl("https://my-mcp.example.com");
        mine.setStatus(McpServer.STATUS_ENABLED);
        when(mcpServerMapper.selectList(any())).thenReturn(List.of(mine));

        List<McpServer> servers = service.loadAgentServers(agent, 9L);

        assertThat(servers).hasSize(2);
        assertThat(servers.get(0).getId()).isEqualTo(1L);   // 全局在前
        assertThat(servers.get(1).getId()).isEqualTo(100L); // 私有在后
    }

    @Test
    void loadAgentServersFiltersUserOwnServersDisabledByUser() {
        Agent agent = new Agent();
        agent.setMcpServerIds("[1]");
        when(mcpServerMapper.selectById(1L)).thenReturn(stdioServer);
        McpServer mine = new McpServer();
        mine.setId(100L);
        mine.setUserId(9L);
        mine.setName("my-storage");
        mine.setStatus(McpServer.STATUS_ENABLED);
        when(mcpServerMapper.selectList(any())).thenReturn(List.of(mine));
        // 用户在设置页停用了私有服务器 100
        when(userMcpPreferenceService.getDisabledServerIds(9L)).thenReturn(List.of(100L));

        List<McpServer> servers = service.loadAgentServers(agent, 9L);

        assertThat(servers).hasSize(1);
        assertThat(servers.get(0).getId()).isEqualTo(1L);
    }

    @Test
    void loadAgentServersSkipsUserOwnServersDisabledByAdmin() {
        Agent agent = new Agent();
        agent.setMcpServerIds("[1]");
        when(mcpServerMapper.selectById(1L)).thenReturn(stdioServer);
        // 管理员停用了该用户的私有服务器 → 查询仅返回已启用，这里模拟返回空
        when(mcpServerMapper.selectList(any())).thenReturn(List.of());

        List<McpServer> servers = service.loadAgentServers(agent, 9L);

        assertThat(servers).hasSize(1);
        assertThat(servers.get(0).getId()).isEqualTo(1L);
    }

    @Test
    void buildSyncPayloadForStdioIncludesDecryptedEnv() {
        when(mcpServerService.decryptEnv(stdioServer)).thenReturn(Map.of("API_KEY", "sk-123"));

        Map<String, Object> payload = service.buildSyncPayload(List.of(stdioServer));

        assertThat(payload).containsKey("servers");
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> servers = (List<Map<String, Object>>) payload.get("servers");
        assertThat(servers).hasSize(1);
        Map<String, Object> item = servers.get(0);
        assertThat(item).containsEntry("name", "filesystem")
                .containsEntry("type", "STDIO")
                .containsEntry("command", "npx");
        assertThat((List<?>) item.get("args"))
                .isEqualTo(List.of("-y", "@modelcontextprotocol/server-filesystem", "/tmp"));
        assertThat(item.get("env")).isEqualTo(Map.of("API_KEY", "sk-123"));
    }

    @Test
    void buildSyncPayloadForHttpUsesUrlAndNoCommand() {
        when(mcpServerService.decryptEnv(httpServer)).thenReturn(Map.of());

        Map<String, Object> payload = service.buildSyncPayload(List.of(httpServer));

        @SuppressWarnings("unchecked")
        List<Map<String, Object>> servers = (List<Map<String, Object>>) payload.get("servers");
        Map<String, Object> item = servers.get(0);
        assertThat(item).containsEntry("name", "github")
                .containsEntry("type", "HTTP")
                .containsEntry("url", "https://mcp.example.com/github")
                .doesNotContainKey("command");
    }

    @Test
    void buildSyncPayloadReturnsNullForEmptyServers() {
        assertThat(service.buildSyncPayload(List.of())).isNull();
    }

    @Test
    void recordReportDelegatesToRegistry() {
        McpToolRef tool = new McpToolRef(1L, "filesystem", "read_file", "desc", Map.of());
        service.recordReport(7L, List.of(tool));
        verify(toolsRegistry).report(7L, List.of(tool));
    }

    @Test
    void resolveServerIdByNameLooksUpByUniqueName() {
        when(mcpServerMapper.selectOne(any())).thenReturn(stdioServer);
        assertThat(service.resolveServerIdByName("filesystem")).isEqualTo(1L);
        assertThat(service.resolveServerIdByName(null)).isNull();
        assertThat(service.resolveServerIdByName("  ")).isNull();
    }
}
