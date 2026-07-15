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
import java.util.Base64;
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
    private final ObjectMapper objectMapper;

    // 获取二维码的客户端 - 较短超时
    private final OkHttpClient qrHttpClient = new OkHttpClient.Builder()
            .connectTimeout(10, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS)
            .build();

    // 查询状态的客户端 - 较短超时，避免长时间阻塞
    private final OkHttpClient statusHttpClient = new OkHttpClient.Builder()
            .connectTimeout(5, TimeUnit.SECONDS)
            .readTimeout(10, TimeUnit.SECONDS)
            .build();

    // 下载图片的客户端
    private final OkHttpClient imageHttpClient = new OkHttpClient.Builder()
            .connectTimeout(10, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS)
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
                String qrImgContent = jsonNode.get("qrcode_img_content").asText();

                // 处理二维码图片 - 如果是URL则下载并转换为base64
                String qrDataUrl;
                if (qrImgContent.startsWith("http://") || qrImgContent.startsWith("https://")) {
                    qrDataUrl = downloadAndConvertToBase64(qrImgContent);
                } else if (qrImgContent.startsWith("data:")) {
                    qrDataUrl = qrImgContent;
                } else {
                    // 可能是纯base64数据
                    qrDataUrl = "data:image/png;base64," + qrImgContent;
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
     * 下载图片并转换为base64 data URL
     */
    private String downloadAndConvertToBase64(String imageUrl) throws IOException {
        Request request = new Request.Builder()
                .url(imageUrl)
                .get()
                .build();

        try (Response response = imageHttpClient.newCall(request).execute()) {
            if (!response.isSuccessful()) {
                log.warn("下载二维码图片失败: HTTP {}, URL: {}", response.code(), imageUrl);
                // 返回一个占位图片或抛出异常
                throw new IOException("下载二维码图片失败: HTTP " + response.code());
            }

            byte[] imageBytes = response.body().bytes();
            String base64 = Base64.getEncoder().encodeToString(imageBytes);
            
            // 根据Content-Type确定MIME类型
            String contentType = response.header("Content-Type", "image/png");
            if (contentType.contains(";")) {
                contentType = contentType.substring(0, contentType.indexOf(";")).trim();
            }
            
            return "data:" + contentType + ";base64," + base64;
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
            log.error("查询扫码状态失败", e);
            throw new BusinessException(ErrorCode.INTERNAL_ERROR, "查询扫码状态失败: " + e.getMessage());
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