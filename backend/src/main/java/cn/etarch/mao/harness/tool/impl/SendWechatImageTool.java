package cn.etarch.mao.harness.tool.impl;

import cn.etarch.mao.harness.tool.ImageFileSupport;
import cn.etarch.mao.harness.tool.Tool;
import cn.etarch.mao.harness.tool.WeixinChannelTool;
import cn.etarch.mao.weixin.service.WeixinMediaToolSupport;
import cn.etarch.mao.weixin.service.WeixinMediaUploadService;
import cn.etarch.mao.weixin.service.WeixinSendService;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Optional;
import java.util.Set;

/**
 * 向微信用户发送图片（仅微信通道会话可用）。
 * <p>
 * 支持本地文件路径（绝对路径或会话工作区相对路径）或 http(s) 图片 URL；
 * 仅支持 PNG/JPG/JPEG/GIF/WebP，大小不超过 20MB。
 * 链路：装载字节 → 格式校验 → getuploadurl(media_type=IMAGE) → AES-128-ECB 加密
 * → CDN 上传 → sendmessage(image_item, type=2)。
 */
@Slf4j
@Component
public class SendWechatImageTool implements Tool, WeixinChannelTool {

    /** 图片大小上限 20MB（微信侧实测图片上限） */
    static final long MAX_IMAGE_BYTES = 20L * 1024 * 1024;

    private static final Set<String> ALLOWED_IMAGE_MIMES = Set.of(
            "image/png", "image/jpeg", "image/gif", "image/webp"
    );

    private final ObjectMapper objectMapper;
    private final WeixinMediaToolSupport toolSupport;
    private final WeixinMediaUploadService uploadService;
    private final WeixinSendService sendService;

    public SendWechatImageTool(ObjectMapper objectMapper,
                               WeixinMediaToolSupport toolSupport,
                               WeixinMediaUploadService uploadService,
                               WeixinSendService sendService) {
        this.objectMapper = objectMapper;
        this.toolSupport = toolSupport;
        this.uploadService = uploadService;
        this.sendService = sendService;
    }

    @Override
    public String getName() {
        return "send_wechat_image";
    }

    @Override
    public String getDescription() {
        return "向微信用户发送一张图片（仅微信通道会话可用）。支持本地文件路径（绝对路径或会话工作区相对路径）或 http(s) 图片 URL；仅支持 PNG/JPG/JPEG/GIF/WebP，大小不超过 20MB。发送成功后微信用户会收到该图片。";
    }

    @Override
    public Map<String, Object> getInputSchema() {
        Map<String, Object> schema = new HashMap<>();
        schema.put("type", "object");
        Map<String, Object> properties = new HashMap<>();
        properties.put("image", Map.of(
                "type", "string",
                "description", "要发送的图片：本地文件路径（绝对路径或工作区相对路径），或 http(s) 图片 URL"
        ));
        schema.put("properties", properties);
        schema.put("required", new String[]{"image"});
        return schema;
    }

    @Override
    public Map<String, Object> getOutputSchema() {
        Map<String, Object> schema = new HashMap<>();
        schema.put("type", "object");
        Map<String, Object> properties = new HashMap<>();
        properties.put("success", Map.of("type", "boolean"));
        properties.put("media_type", Map.of("type", "string"));
        properties.put("size_bytes", Map.of("type", "integer"));
        properties.put("sent_to", Map.of("type", "string"));
        properties.put("error", Map.of("type", "string"));
        schema.put("properties", properties);
        return schema;
    }

    @Override
    public String execute(String arguments) {
        return execute(arguments, null, null, null);
    }

    @Override
    public String execute(String arguments, String workspace) {
        return execute(arguments, null, null, workspace);
    }

    @Override
    public String execute(String arguments, Long sessionId, String workspace) {
        return execute(arguments, sessionId, null, workspace);
    }

    @Override
    public String execute(String arguments, Long sessionId, Long userId, String workspace) {
        try {
            JsonNode args = objectMapper.readTree(arguments);
            String image = args.has("image") ? args.get("image").asText() : "";
            if (image == null || image.isBlank()) {
                return toolSupport.errorJson("缺少必填参数 image（本地文件路径或 http(s) 图片 URL）");
            }

            Optional<WeixinMediaToolSupport.WechatTarget> targetOpt = toolSupport.resolveTarget(userId);
            if (targetOpt.isEmpty()) {
                return toolSupport.errorJson("无法解析微信收件人：请确认已绑定微信Bot账号，且用户给机器人发过至少一条消息");
            }
            WeixinMediaToolSupport.WechatTarget target = targetOpt.get();

            byte[] bytes;
            try {
                bytes = toolSupport.loadBytes(image, workspace, MAX_IMAGE_BYTES);
            } catch (Exception e) {
                return toolSupport.errorJson("读取图片失败: " + e.getMessage());
            }

            // 格式校验：魔数优先，扩展名兜底
            Optional<String> mime = ImageFileSupport.detectMimeFromBytes(bytes);
            if (mime.isEmpty()) {
                mime = ImageFileSupport.mimeFromPath(image);
            }
            if (mime.isEmpty() || !ALLOWED_IMAGE_MIMES.contains(mime.get())) {
                return toolSupport.errorJson("不支持的图片格式（仅支持 PNG/JPG/JPEG/GIF/WebP）: " + image);
            }

            Optional<WeixinMediaUploadService.CdnMedia> mediaOpt =
                    uploadService.uploadImage(target.account(), target.wxUserId(), bytes);
            if (mediaOpt.isEmpty()) {
                return toolSupport.errorJson("图片上传微信 CDN 失败，请稍后重试或检查账号状态");
            }

            boolean sent = sendService.sendImage(target.accountId(), target.wxUserId(), mediaOpt.get());
            if (!sent) {
                return toolSupport.errorJson("图片发送失败：context_token 可能已过期，请用户先在微信给机器人发一条消息");
            }

            Map<String, Object> result = new LinkedHashMap<>();
            result.put("success", true);
            result.put("media_type", "image");
            result.put("size_bytes", bytes.length);
            result.put("sent_to", target.wxUserId());
            return objectMapper.writeValueAsString(result);
        } catch (Exception e) {
            log.error("SendWechatImageTool execution failed", e);
            return toolSupport.errorJson("发送图片失败: " + e.getMessage());
        }
    }
}
