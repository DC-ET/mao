package com.agentworkbench.harness.mcp;

import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

@Slf4j
@Component
@RequiredArgsConstructor
public class McpToolRegistry {

    private final McpClient mcpClient;

    // serverUrl -> tools
    private final Map<String, List<McpTool>> serverTools = new ConcurrentHashMap<>();
    // toolName -> serverUrl
    private final Map<String, String> toolServerMap = new ConcurrentHashMap<>();

    /**
     * Discover and register tools from an MCP server
     */
    public List<McpTool> discoverAndRegister(String serverUrl) {
        List<McpTool> tools = mcpClient.discoverTools(serverUrl);
        serverTools.put(serverUrl, tools);
        for (McpTool tool : tools) {
            toolServerMap.put(tool.getName(), serverUrl);
            log.info("Registered MCP tool: {} from server: {}", tool.getName(), serverUrl);
        }
        return tools;
    }

    /**
     * Get all registered MCP tools
     */
    public List<McpTool> getAllTools() {
        List<McpTool> all = new ArrayList<>();
        for (List<McpTool> tools : serverTools.values()) {
            all.addAll(tools);
        }
        return all;
    }

    /**
     * Check if a tool name belongs to an MCP server
     */
    public boolean hasTool(String toolName) {
        return toolServerMap.containsKey(toolName);
    }

    /**
     * Call an MCP tool by name
     */
    public String callTool(String toolName, String arguments) {
        String serverUrl = toolServerMap.get(toolName);
        if (serverUrl == null) {
            throw new IllegalArgumentException("MCP tool not found: " + toolName);
        }
        try {
            @SuppressWarnings("unchecked")
            Map<String, Object> args = new com.fasterxml.jackson.databind.ObjectMapper()
                    .readValue(arguments, Map.class);
            return mcpClient.callTool(serverUrl, toolName, args);
        } catch (Exception e) {
            log.error("Failed to call MCP tool: {}", toolName, e);
            return "Error: " + e.getMessage();
        }
    }

    /**
     * Clear all registered tools
     */
    public void clear() {
        serverTools.clear();
        toolServerMap.clear();
    }
}
