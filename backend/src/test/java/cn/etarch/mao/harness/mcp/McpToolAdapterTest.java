package cn.etarch.mao.harness.mcp;

import cn.etarch.mao.harness.mcp.model.McpToolRef;
import org.junit.jupiter.api.Test;

import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class McpToolAdapterTest {

    private final McpToolRef ref = new McpToolRef(
            42L, "filesystem", "read_file",
            "读取文件内容",
            Map.of("type", "object", "properties", Map.of("path", Map.of("type", "string"))));

    @Test
    void exposesNamespacedToolName() {
        McpToolAdapter adapter = new McpToolAdapter(ref, null);
        assertThat(adapter.getName()).isEqualTo("mcp__filesystem__read_file");
    }

    @Test
    void passesThroughDescriptionAndInputSchema() {
        McpToolAdapter adapter = new McpToolAdapter(ref, null);
        assertThat(adapter.getDescription()).isEqualTo("读取文件内容");
        assertThat(adapter.getInputSchema()).containsEntry("type", "object");
        assertThat(adapter.getInputSchema().get("properties")).isNotNull();
    }

    @Test
    void delegatesExecutionToClientManagerWithSessionAndWorkspace() {
        McpClientManager clientManager = mock(McpClientManager.class);
        when(clientManager.callTool(7L, 42L, "read_file", "{\"path\":\"/tmp/a.txt\"}"))
                .thenReturn("{\"result\":\"content\"}");

        McpToolAdapter adapter = new McpToolAdapter(ref, clientManager);
        String result = adapter.execute("{\"path\":\"/tmp/a.txt\"}", 7L, 9L, "/workspace");

        assertThat(result).isEqualTo("{\"result\":\"content\"}");
        verify(clientManager).callTool(7L, 42L, "read_file", "{\"path\":\"/tmp/a.txt\"}");
    }

    @Test
    void returnsErrorWhenNoClientManagerConfigured() {
        McpToolAdapter adapter = new McpToolAdapter(ref, null);
        String result = adapter.execute("{}", 7L, 9L, null);
        assertThat(result).contains("\"error\"").contains("LOCAL");
    }

    @Test
    void shortExecuteOverloadsFallThroughToFullSignature() {
        McpClientManager clientManager = mock(McpClientManager.class);
        when(clientManager.callTool(null, 42L, "read_file", "{}")).thenReturn("ok");

        McpToolAdapter adapter = new McpToolAdapter(ref, clientManager);
        assertThat(adapter.execute("{}")).isEqualTo("ok");
        assertThat(adapter.execute("{}", null)).isEqualTo("ok");
        assertThat(adapter.execute("{}", null, null)).isEqualTo("ok");
    }
}
