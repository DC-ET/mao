package cn.etarch.mao.weixin.service;

import cn.etarch.mao.common.exception.BusinessException;
import cn.etarch.mao.common.result.ErrorCode;
import cn.etarch.mao.weixin.config.WeixinBotConfig;
import cn.etarch.mao.weixin.entity.WeixinChannelAccount;
import cn.etarch.mao.weixin.model.QrcodeResponse;
import cn.etarch.mao.weixin.model.QrcodeStatusResponse;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import okhttp3.*;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.time.LocalDateTime;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;

@Slf4j
@Service
@RequiredArgsConstructor
public class QrLoginService {

    private final WeixinBotConfig config;
    private final WeixinAccountRepository accountRepository;
    private final WeixinMonitorService monitorService;
    private final ObjectMapper objectMapper;

    // 获取二维码的客户端 - 较短超时
    private final OkHttpClient qrHttpClient = new OkHttpClient.Builder()
            .connectTimeout(10, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS)
            .callTimeout(35, TimeUnit.SECONDS)
            .build();

    // 查询状态的客户端 - callTimeout 限制整个请求生命周期
    // 微信 get_qrcode_status 是长轮询接口，readTimeout 可能因 chunked keep-alive 不触发
    private final OkHttpClient statusHttpClient = new OkHttpClient.Builder()
            .connectTimeout(5, TimeUnit.SECONDS)
            .readTimeout(8, TimeUnit.SECONDS)
            .callTimeout(10, TimeUnit.SECONDS)
            .build();

    // 临时存储二维码会话信息: sessionKey -> qrcode
    private final Map<String, String> qrcodeSessionMap = new ConcurrentHashMap<>();

    /**
     * 获取微信扫码二维码
     */
    public QrcodeResponse getQrcode(Long userId) {
        if (!config.isEnabled()) {
            throw new BusinessException(ErrorCode.PARAM_INVALID, "微信Bot功能未启用");
        }

        try {
            String url = config.getIlinkBaseUrl() + "/ilink/bot/get_bot_qrcode?bot_type=3";
            Request request = new Request.Builder()
                    .url(url)
                    .get()
                    .addHeader("Content-Type", "application/json")
                    .build();

            try (Response response = qrHttpClient.newCall(request).execute()) {
                if (!response.isSuccessful()) {
                    throw new BusinessException(ErrorCode.INTERNAL_ERROR, "获取二维码失败: HTTP " + response.code());
                }

                String responseBody = response.body().string();
                log.info("获取二维码响应: {}", responseBody);
                
                JsonNode jsonNode = objectMapper.readTree(responseBody);
                String qrcode = jsonNode.get("qrcode").asText();
                JsonNode qrImgNode = jsonNode.get("qrcode_img_content");
                String qrImgContent = qrImgNode != null ? qrImgNode.asText() : "";

                // 处理二维码图片
                String qrDataUrl;
                if (qrImgContent.startsWith("http://") || qrImgContent.startsWith("https://")) {
                    // 微信返回的是页面URL，前端会用 qrcode 库生成二维码图片
                    qrDataUrl = qrImgContent;
                } else if (qrImgContent.startsWith("data:")) {
                    qrDataUrl = qrImgContent;
                } else if (!qrImgContent.isEmpty()) {
                    // 可能是纯base64数据
                    qrDataUrl = "data:image/png;base64," + qrImgContent;
                } else {
                    throw new BusinessException(ErrorCode.INTERNAL_ERROR, "获取二维码失败: 图片内容为空");
                }

                // 生成会话Key
                String sessionKey = UUID.randomUUID().toString();
                qrcodeSessionMap.put(sessionKey, qrcode);

                return QrcodeResponse.builder()
                        .sessionKey(sessionKey)
                        .qrDataUrl(qrDataUrl)
                        .message("使用微信扫描以下二维码，以完成连接。")
                        .build();
            }
        } catch (IOException e) {
            log.error("获取微信二维码失败", e);
            throw new BusinessException(ErrorCode.INTERNAL_ERROR, "获取二维码失败: " + e.getMessage());
        }
    }

    /**
     * 查询扫码状态
     */
    public QrcodeStatusResponse getQrcodeStatus(String sessionKey) {
        String qrcode = qrcodeSessionMap.get(sessionKey);
        if (qrcode == null) {
            throw new BusinessException(ErrorCode.PARAM_INVALID, "无效的会话Key");
        }

        try {
            String url = config.getIlinkBaseUrl() + "/ilink/bot/get_qrcode_status?qrcode=" + qrcode;
            log.info("查询扫码状态: {}", url);
            
            Request request = new Request.Builder()
                    .url(url)
                    .get()
                    .addHeader("Content-Type", "application/json")
                    .build();

            try (Response response = statusHttpClient.newCall(request).execute()) {
                if (!response.isSuccessful()) {
                    log.error("查询扫码状态失败: HTTP {}", response.code());
                    throw new BusinessException(ErrorCode.INTERNAL_ERROR, "查询扫码状态失败: HTTP " + response.code());
                }

                String responseBody = response.body().string();
                log.info("扫码状态响应: {}", responseBody);
                
                JsonNode jsonNode = objectMapper.readTree(responseBody);
                String status = jsonNode.get("status").asText();

                QrcodeStatusResponse.QrcodeStatusResponseBuilder builder = QrcodeStatusResponse.builder()
                        .status(status);

                if ("confirmed".equals(status)) {
                    builder.botToken(jsonNode.get("bot_token").asText())
                            .baseUrl(jsonNode.get("baseurl").asText())
                            .ilinkUserId(jsonNode.get("ilink_user_id").asText());
                }

                return builder.build();
            }
        } catch (IOException e) {
            // 微信长轮询接口可能因 callTimeout/readTimeout 超时
            // 此时并非真正的错误，而是扫码尚未完成，返回 wait 状态
            log.debug("查询扫码状态超时（视为wait）: {}", e.getMessage());
            return QrcodeStatusResponse.builder()
                    .status("wait")
                    .build();
        }
    }

    /**
     * 保存绑定凭据
     */
    public void saveBindingCredentials(Long userId, String botToken, String baseUrl, String ilinkUserId) {
        String accountId = "user_" + userId;

        // 构建payload JSON
        Map<String, Object> payload = Map.of(
                "token", botToken,
                "baseUrl", baseUrl,
                "userId", ilinkUserId,
                "savedAt", LocalDateTime.now().toString()
        );

        try {
            String payloadJson = objectMapper.writeValueAsString(payload);

            // 检查是否已存在
            WeixinChannelAccount existingAccount = accountRepository.findByUserId(userId);
            if (existingAccount != null) {
                existingAccount.setPayloadJson(payloadJson);
                existingAccount.setGetUpdatesBuf(null);
                existingAccount.setEnabled(1);
                accountRepository.update(existingAccount);
            } else {
                WeixinChannelAccount account = new WeixinChannelAccount();
                account.setUserId(userId);
                account.setAccountId(accountId);
                account.setPayloadJson(payloadJson);
                account.setEnabled(1);
                accountRepository.create(account);
            }

            log.info("保存微信Bot绑定凭据成功, userId={}", userId);

            // 启动该账号的消息监控
            monitorService.startMonitor(accountId);
        } catch (Exception e) {
            log.error("保存微信Bot绑定凭据失败", e);
            throw new BusinessException(ErrorCode.INTERNAL_ERROR, "保存绑定凭据失败");
        }
    }

    /**
     * 清除二维码会话
     */
    public void clearQrcodeSession(String sessionKey) {
        qrcodeSessionMap.remove(sessionKey);
    }
}