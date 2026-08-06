package cn.etarch.mao.config;

import cn.etarch.mao.session.ws.StreamingWsHandler;
import lombok.RequiredArgsConstructor;
import org.springframework.beans.factory.annotation.Value;
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

    private final StreamingWsHandler streamingWsHandler;

    @Value("${app.ws.idle-timeout-ms:90000}")
    private long idleTimeoutMs;

    @Override
    public void registerWebSocketHandlers(WebSocketHandlerRegistry registry) {
        registry.addHandler(streamingWsHandler, "/ws/stream")
                .setAllowedOrigins("*");
    }

    @Bean
    public ServletServerContainerFactoryBean createWebSocketContainer() {
        ServletServerContainerFactoryBean container = new ServletServerContainerFactoryBean();
        // Idle timeout: 90s by default (configurable via app.ws.idle-timeout-ms)
        container.setMaxSessionIdleTimeout(idleTimeoutMs);
        container.setMaxTextMessageBufferSize(1024 * 1024);
        return container;
    }
}
