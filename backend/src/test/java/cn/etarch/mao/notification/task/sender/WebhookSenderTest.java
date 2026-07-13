package cn.etarch.mao.notification.task.sender;

import com.fasterxml.jackson.databind.ObjectMapper;
import okhttp3.OkHttpClient;
import okhttp3.mockwebserver.MockResponse;
import okhttp3.mockwebserver.MockWebServer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

class WebhookSenderTest {
    private MockWebServer server;
    private OkHttpClient client;
    private ObjectMapper objectMapper;

    @BeforeEach
    void setUp() throws Exception {
        server = new MockWebServer();
        server.start();
        client = new OkHttpClient();
        objectMapper = new ObjectMapper();
    }

    @AfterEach
    void tearDown() throws Exception {
        server.shutdown();
    }

    @Test
    void dingTalkRequiresHttpAndBusinessSuccess() {
        DingTalkWebhookSender sender = new DingTalkWebhookSender(client, objectMapper);
        server.enqueue(new MockResponse().setResponseCode(200).setBody("{\"errcode\":0,\"errmsg\":\"ok\"}"));
        assertTrue(sender.send(server.url("/robot/send").toString(), "test").success());

        server.enqueue(new MockResponse().setResponseCode(200).setBody("{\"errcode\":310000,\"errmsg\":\"invalid\"}"));
        assertFalse(sender.send(server.url("/robot/send").toString(), "test").success());
    }

    @Test
    void feishuSupportsCurrentAndLegacySuccessCodes() {
        FeishuWebhookSender sender = new FeishuWebhookSender(client, objectMapper);
        server.enqueue(new MockResponse().setResponseCode(200).setBody("{\"code\":0,\"msg\":\"success\"}"));
        assertTrue(sender.send(server.url("/hook").toString(), "test").success());

        server.enqueue(new MockResponse().setResponseCode(200).setBody("{\"StatusCode\":0,\"StatusMessage\":\"success\"}"));
        assertTrue(sender.send(server.url("/hook").toString(), "test").success());
    }
}
