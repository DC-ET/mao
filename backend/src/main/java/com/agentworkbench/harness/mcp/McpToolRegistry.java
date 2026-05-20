package com.agentworkbench.harness.mcp;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.github.benmanes.caffeine.cache.Cache;
import com.github.benmanes.caffeine.cache.Caffeine;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;

@Slf4j
@Component
public class McpToolRegistry {

    private final McpClient mcpClient;
    private final ObjectMapper objectMapper;

    // Cache discovered tools per server URL (TTL 5 minutes)
    private final Cache<String, List<McpTool>> discoveryCache = Caffeine.newBuilder()
            .expireAfterWrite(5, TimeUnit.MINUTES)
            .maximumSize(100)
            .build();

    public McpToolRegistry(McpClient mcpClient, ObjectMapper objectMapper) {
        this.mcpClient = mcpClient;
        this.objectMapper = objectMapper;
    }

    // serverUrl -> tools
    private final Map<String, List<McpTool>> serverTools = new ConcurrentHashMap<>();
    // toolName -> serverUrl
    private final Map<String, String> toolServerMap = new ConcurrentHashMap<>();

    /**
     * Discover and register tools from an MCP server (with caching)
     */
    public List<McpTool> discoverAndRegister(String serverUrl) {
        List<McpTool> cached = discoveryCache.getIfPresent(serverUrl);
        if (cached != null) {
            log.debug("Using cached tools for MCP server: {} ({} tools)", serverUrl, cached.size());
            return cached;
        }

        List<McpTool> tools = mcpClient.discoverTools(serverUrl);
        serverTools.put(serverUrl, tools);
        for (McpTool tool : tools) {
            toolServerMap.put(tool.getName(), serverUrl);
            log.info("Registered MCP tool: {} from server: {}", tool.getName(), serverUrl);
        }
        discoveryCache.put(serverUrl, tools);
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
            Map<String, Object> args = objectMapper.readValue(arguments, Map.class);
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
        discoveryCache.invalidateAll();
    }
}
