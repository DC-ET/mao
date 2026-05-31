package com.agentworkbench.config;

import com.agentworkbench.harness.local.LocalToolWebSocketHandler;
import com.agentworkbench.session.ws.StreamingWsHandler;
import lombok.RequiredArgsConstructor;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.socket.config.annotation.EnableWebSocket;
import org.springframework.web.socket.config.annotation.WebSocketConfigurer;
import org.springframework.web.socket.config.annotation.WebSocketHandlerRegistry;
import org.springframework.web.socket.server.standard.ServletServerContainerFactoryBean;

@Configuration
@EnableWebSocket
@RequiredArgsConstructor
public class WebSocketConfig implements WebSocketConfigurer {

    private final LocalToolWebSocketHandler localToolWebSocketHandler;
    private final StreamingWsHandler streamingWsHandler;

    @Override
    public void registerWebSocketHandlers(WebSocketHandlerRegistry registry) {
        registry.addHandler(localToolWebSocketHandler, "/ws/local-tool")
                .setAllowedOrigins("*");
        registry.addHandler(streamingWsHandler, "/ws/stream")
                .setAllowedOrigins("*");
    }

    @Bean
    public ServletServerContainerFactoryBean createWebSocketContainer() {
        ServletServerContainerFactoryBean container = new ServletServerContainerFactoryBean();
        // Idle timeout: 90s (3 missed heartbeats at 30s interval)
        container.setMaxSessionIdleTimeout(90_000L);
        container.setMaxTextMessageBufferSize(1024 * 1024);
        return container;
    }
}
