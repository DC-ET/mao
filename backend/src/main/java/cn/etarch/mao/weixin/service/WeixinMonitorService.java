package cn.etarch.mao.weixin.service;

import cn.etarch.mao.weixin.config.WeixinBotConfig;
import cn.etarch.mao.weixin.entity.WeixinChannelAccount;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.annotation.PostConstruct;
import jakarta.annotation.PreDestroy;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import okhttp3.*;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.util.*;
import java.util.concurrent.*;

/**
 * 微信消息监控服务。
 * 为每个启用的账号启动一个长轮询线程，通过 iLink getUpdates API 拉取新消息，
 * 交由 InboundProcessor 处理。
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class WeixinMonitorService {

    private final WeixinBotConfig config;
    private final WeixinAccountRepository accountRepository;
    private final InboundProcessor inboundProcessor;
    private final ObjectMapper objectMapper;

    private final ConcurrentHashMap<String, Future<?>> activeMonitors = new ConcurrentHashMap<>();
    private ExecutorService executor;
    private OkHttpClient httpClient;

    @PostConstruct
    public void init() {
        if (!config.isEnabled() || !config.getMonitor().isEnabled()) {
            log.info("微信Bot监控未启用");
            return;
        }

        httpClient = new OkHttpClient.Builder()
                .connectTimeout(10, TimeUnit.SECONDS)
                // readTimeout 需大于 longPollTimeoutMs，否则长轮询会提前超时
                .readTimeout(config.getMonitor().getLongPollTimeoutMs() / 1000 + 15, TimeUnit.SECONDS)
                .build();

        executor = Executors.newCachedThreadPool(r -> {
            Thread t = new Thread(r, "weixin-monitor");
            t.setDaemon(true);
            return t;
        });
        startAll();
    }

    @PreDestroy
    public void shutdown() {
        activeMonitors.values().forEach(f -> f.cancel(true));
        activeMonitors.clear();
        if (executor != null) {
            executor.shutdownNow();
        }
        log.info("微信Bot监控已停止");
    }

    /**
     * 启动所有已启用账号的监控
     */
    public void startAll() {
        List<WeixinChannelAccount> accounts = accountRepository.findAllEnabled();
        for (WeixinChannelAccount account : accounts) {
            startMonitor(account.getAccountId());
        }
        log.info("微信Bot监控已启动, 账号数={}", activeMonitors.size());
    }

    /**
     * 启动单个账号的监控
     */
    public void startMonitor(String accountId) {
        if (activeMonitors.containsKey(accountId)) {
            log.debug("账号监控已在运行, accountId={}", accountId);
            return;
        }
        Future<?> future = executor.submit(() -> monitorLoop(accountId));
        activeMonitors.put(accountId, future);
        log.info("启动账号监控, accountId={}", accountId);
    }

    /**
     * 停止单个账号的监控
     */
    public void stopMonitor(String accountId) {
        Future<?> future = activeMonitors.remove(accountId);
        if (future != null) {
            future.cancel(true);
            log.info("停止账号监控, accountId={}", accountId);
        }
    }

    /**
     * 单账号长轮询循环
     */
    private void monitorLoop(String accountId) {
        int consecutiveFailures = 0;

        while (!Thread.currentThread().isInterrupted()) {
            try {
                WeixinChannelAccount account = accountRepository.findByAccountId(accountId);
                if (account == null || account.getEnabled() == null || account.getEnabled() != 1) {
                    log.info("账号已禁用或不存在，停止监控, accountId={}", accountId);
                    break;
                }

                // 解析凭据
                JsonNode payload = objectMapper.readTree(account.getPayloadJson());
                String botToken = payload.get("token").asText();
                String baseUrl = payload.get("baseUrl").asText();

                // 获取更新
                String cursor = account.getGetUpdatesBuf();
                GetUpdatesResult result = getUpdates(baseUrl, botToken, cursor);

                // 重置失败计数
                consecutiveFailures = 0;

                // 更新游标（iLink 响应中的 get_updates_buf）
                if (result.newBuf() != null) {
                    accountRepository.updateGetUpdatesBuf(account.getId(), result.newBuf());
                }

                // 逐条处理消息
                if (!result.messages().isEmpty()) {
                    log.info("收到{}条微信消息, accountId={}", result.messages().size(), accountId);
                    for (JsonNode message : result.messages()) {
                        try {
                            inboundProcessor.processInboundMessage(accountId, message);
                        } catch (Exception e) {
                            log.error("处理单条消息异常, accountId={}", accountId, e);
                        }
                    }
                }

            } catch (SessionExpiredException e) {
                // session 过期：禁用账号，停止监控
                log.warn("账号 session 过期，禁用账号, accountId={}", accountId, e);
                WeixinChannelAccount expiredAccount = accountRepository.findByAccountId(accountId);
                if (expiredAccount != null) {
                    accountRepository.disableAccount(expiredAccount.getId());
                }
                break;
            } catch (Exception e) {
                if (e instanceof InterruptedException) {
                    Thread.currentThread().interrupt();
                    break;
                }

                consecutiveFailures++;
                log.error("账号监控异常, accountId={}, failures={}", accountId, consecutiveFailures, e);

                if (consecutiveFailures >= config.getMonitor().getMaxConsecutiveFailures()) {
                    log.error("连续失败{}次，停止监控, accountId={}", consecutiveFailures, accountId);
                    break;
                }

                // 指数退避
                try {
                    long backoff = Math.min(30_000L, (long) Math.pow(2, consecutiveFailures) * 1000);
                    Thread.sleep(backoff);
                } catch (InterruptedException ie) {
                    Thread.currentThread().interrupt();
                    break;
                }
            }
        }

        activeMonitors.remove(accountId);
        log.info("账号监控循环结束, accountId={}", accountId);
    }

    /**
     * 调用 iLink POST /ilink/bot/getupdates API 获取新消息
     */
    private GetUpdatesResult getUpdates(String baseUrl, String botToken, String cursor) throws IOException {
        // 构建请求体
        Map<String, Object> body = new java.util.LinkedHashMap<>();
        body.put("get_updates_buf", cursor != null ? cursor : "");
        body.put("base_info", Map.of("channel_version", "mao-server-1.0"));

        String jsonBody = objectMapper.writeValueAsString(body);
        String url = baseUrl + "/ilink/bot/getupdates";

        Request request = new Request.Builder()
                .url(url)
                .post(RequestBody.create(jsonBody, MediaType.parse("application/json")))
                .addHeader("Content-Type", "application/json")
                .addHeader("AuthorizationType", "ilink_bot_token")
                .addHeader("Authorization", "Bearer " + botToken)
                .build();

        try (Response response = httpClient.newCall(request).execute()) {
            if (!response.isSuccessful()) {
                throw new IOException("getupdates 失败: HTTP " + response.code());
            }

            String responseBody = response.body().string();
            JsonNode jsonNode = objectMapper.readTree(responseBody);

            int ret = jsonNode.has("ret") ? jsonNode.get("ret").asInt(-1) : 0;
            int errcode = jsonNode.has("errcode") ? jsonNode.get("errcode").asInt(-1) : 0;

            if (ret != 0 || errcode != 0) {
                String errmsg = jsonNode.has("errmsg") ? jsonNode.get("errmsg").asText() : "unknown";

                // session 过期（errcode=-14）：主动禁用账号，停止监控
                if (errcode == -14) {
                    throw new SessionExpiredException("getupdates session 过期: errcode=" + errcode + ", errmsg=" + errmsg);
                }

                throw new IOException("getupdates 业务错误: ret=" + ret + ", errcode=" + errcode + ", errmsg=" + errmsg);
            }

            // 提取新游标
            String newBuf = jsonNode.has("get_updates_buf") ? jsonNode.get("get_updates_buf").asText(null) : null;

            // 提取消息列表
            JsonNode msgsNode = jsonNode.get("msgs");
            List<JsonNode> messages;
            if (msgsNode != null && msgsNode.isArray()) {
                messages = objectMapper.convertValue(
                        msgsNode,
                        objectMapper.getTypeFactory().constructCollectionType(List.class, JsonNode.class)
                );
            } else {
                messages = List.of();
            }

            return new GetUpdatesResult(messages, newBuf);
        }
    }

    /**
     * getupdates 响应结果
     */
    private record GetUpdatesResult(List<JsonNode> messages, String newBuf) {}

    /**
     * 已废弃：游标由 getupdates 响应中的 get_updates_buf 直接提供
     */
    @SuppressWarnings("unused")
    private String computeNextCursor(String currentCursor, int messageCount) {
        return currentCursor;
    }

    /**
     * iLink session 过期异常（errcode=-14）
     */
    private static class SessionExpiredException extends RuntimeException {
        SessionExpiredException(String message) {
            super(message);
        }
    }
}
