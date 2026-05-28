package com.agentworkbench.harness.local;

import com.agentworkbench.session.entity.Session;
import com.agentworkbench.session.mapper.SessionMapper;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;
import org.springframework.web.socket.handler.TextWebSocketHandler;

import java.net.URI;
import java.util.Map;

/**
 * WebSocket handler for local tool execution.
 * Desktop clients connect to /ws/local-tool?sessionId=X&token=Y
 * and receive tool execution requests from the server.
 */
@Slf4j
@Component
@RequiredArgsConstructor
public class LocalToolWebSocketHandler extends TextWebSocketHandler {

    private final LocalToolSessionRegistry sessionRegistry;
    private final SessionMapper sessionMapper;
    private final ObjectMapper objectMapper;

    @Override
    public void afterConnectionEstablished(WebSocketSession session) throws Exception {
        URI uri = session.getUri();
        if (uri == null) {
            session.close(CloseStatus.BAD_DATA);
            return;
        }

        Map<String, String> params = parseQueryParams(uri.getQuery());
        String sessionIdStr = params.get("sessionId");
        String token = params.get("token");

        if (sessionIdStr == null || token == null) {
            session.close(CloseStatus.BAD_DATA.withReason("Missing sessionId or token"));
            return;
        }

        // Store sessionId in session attributes for later use
        Long sessionId = Long.parseLong(sessionIdStr);
        session.getAttributes().put("sessionId", sessionId);
        session.getAttributes().put("token", token);

        // For now, accept all connections. JWT validation can be added later.
        sessionRegistry.register(sessionId, 0L, session);
        log.info("WebSocket connected for local tool session {}", sessionId);

        // Look up workspace from session
        String workspace = "";
        Session sessionEntity = sessionMapper.selectById(sessionId);
        if (sessionEntity != null && sessionEntity.getWorkspace() != null) {
            workspace = sessionEntity.getWorkspace().replace("\\", "\\\\").replace("\"", "\\\"");
        }

        // Send confirmation with workspace
        session.sendMessage(new TextMessage(
                "{\"type\":\"connected\",\"sessionId\":" + sessionId + ",\"workspace\":\"" + workspace + "\"}"));
    }

    @Override
    protected void handleTextMessage(WebSocketSession session, TextMessage message) throws Exception {
        Long sessionId = (Long) session.getAttributes().get("sessionId");
        if (sessionId == null) return;

        try {
            JsonNode node = objectMapper.readTree(message.getPayload());
            String type = node.has("type") ? node.get("type").asText() : "";

            switch (type) {
                case "tool_result": {
                    String requestId = node.get("requestId").asText();
                    String result = node.has("result") ? node.get("result").toString() : "{}";
                    sessionRegistry.completeToolRequest(sessionId, requestId, result);
                    break;
                }
                case "tool_error": {
                    String requestId = node.get("requestId").asText();
                    String error = node.has("error") ? node.get("error").asText() : "Unknown error";
                    sessionRegistry.completeToolRequestError(sessionId, requestId, error);
                    break;
                }
                case "ping":
                    session.sendMessage(new TextMessage("{\"type\":\"pong\"}"));
                    break;
                default:
                    log.warn("Unknown message type '{}' from session {}", type, sessionId);
            }
        } catch (Exception e) {
            log.error("Failed to handle WebSocket message from session {}", sessionId, e);
        }
    }

    @Override
    public void afterConnectionClosed(WebSocketSession session, CloseStatus status) throws Exception {
        Long sessionId = (Long) session.getAttributes().get("sessionId");
        if (sessionId != null) {
            sessionRegistry.unregister(sessionId);
            log.info("WebSocket disconnected for local tool session {} (status={})", sessionId, status);
        }
    }

    @Override
    public void handleTransportError(WebSocketSession session, Throwable exception) throws Exception {
        Long sessionId = (Long) session.getAttributes().get("sessionId");
        log.error("WebSocket transport error for session {}", sessionId, exception);
        session.close(CloseStatus.SERVER_ERROR);
    }

    private Map<String, String> parseQueryParams(String query) {
        Map<String, String> params = new java.util.HashMap<>();
        if (query == null) return params;
        for (String pair : query.split("&")) {
            String[] kv = pair.split("=", 2);
            if (kv.length == 2) {
                params.put(kv[0], kv[1]);
            }
        }
        return params;
    }
}
