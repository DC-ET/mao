package cn.etarch.mao.harness.tool.impl;

import cn.etarch.mao.harness.tool.Tool;
import cn.etarch.mao.harness.tool.WeixinChannelTool;
import cn.etarch.mao.weixin.service.WeixinMediaToolSupport;
import cn.etarch.mao.weixin.service.WeixinMediaUploadService;
import cn.etarch.mao.weixin.service.WeixinSendService;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.io.UnsupportedEncodingException;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;

/**
 * 向微信用户发送文件（仅微信通道会话可用）。
 * <p>
 * 支持本地文件路径（绝对路径或会话工作区相对路径）或 http(s) 下载 URL；
 * 大小不超过 100MB；可用 file_name 指定微信端显示的文件名（默认取 URL 最后一段或本地文件名）。
 * 链路：装载字节 → getuploadurl(media_type=FILE) → AES-128-ECB 加密
 * → CDN 上传 → sendmessage(file_item, type=4)。
 */
@Slf4j
@Component
public class SendWechatFileTool implements Tool, WeixinChannelTool {

    /** 文件大小上限 100MB */
    static final long MAX_FILE_BYTES = 100L * 1024 * 1024;

    private static final DateTimeFormatter FILE_TS = DateTimeFormatter.ofPattern("yyyyMMdd-HHmmss");

    private final ObjectMapper objectMapper;
    private final WeixinMediaToolSupport toolSupport;
    private final WeixinMediaUploadService uploadService;
    private final WeixinSendService sendService;

    public SendWechatFileTool(ObjectMapper objectMapper,
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
        return "send_wechat_file";
    }

    @Override
    public String getDescription() {
        return "向微信用户发送一个文件（仅微信通道会话可用）。支持本地文件路径（绝对路径或会话工作区相对路径）或 http(s) 下载 URL；大小不超过 100MB；可用 file_name 指定微信端显示的文件名（默认取 URL 最后一段或本地文件名）。发送成功后微信用户会收到该文件。";
    }

    @Override
    public Map<String, Object> getInputSchema() {
        Map<String, Object> schema = new HashMap<>();
        schema.put("type", "object");
        Map<String, Object> properties = new HashMap<>();
        properties.put("file", Map.of(
                "type", "string",
                "description", "要发送的文件：本地文件路径（绝对路径或工作区相对路径），或 http(s) 下载 URL"
        ));
        properties.put("file_name", Map.of(
                "type", "string",
                "description", "微信端显示的文件名（可选，默认取 URL 最后一段或本地文件名）"
        ));
        schema.put("properties", properties);
        schema.put("required", new String[]{"file"});
        return schema;
    }

    @Override
    public Map<String, Object> getOutputSchema() {
        Map<String, Object> schema = new HashMap<>();
        schema.put("type", "object");
        Map<String, Object> properties = new HashMap<>();
        properties.put("success", Map.of("type", "boolean"));
        properties.put("media_type", Map.of("type", "string"));
        properties.put("file_name", Map.of("type", "string"));
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
            String file = args.has("file") ? args.get("file").asText() : "";
            if (file == null || file.isBlank()) {
                return toolSupport.errorJson("缺少必填参数 file（本地文件路径或 http(s) 下载 URL）");
            }
            String requestedName = args.has("file_name") ? args.get("file_name").asText() : "";

            Optional<WeixinMediaToolSupport.WechatTarget> targetOpt = toolSupport.resolveTarget(userId);
            if (targetOpt.isEmpty()) {
                return toolSupport.errorJson("无法解析微信收件人：请确认已绑定微信Bot账号，且用户给机器人发过至少一条消息");
            }
            WeixinMediaToolSupport.WechatTarget target = targetOpt.get();

            byte[] bytes;
            try {
                bytes = toolSupport.loadBytes(file, workspace, MAX_FILE_BYTES);
            } catch (Exception e) {
                return toolSupport.errorJson("读取文件失败: " + e.getMessage());
            }

            String fileName = resolveFileName(requestedName, file);

            Optional<WeixinMediaUploadService.CdnMedia> mediaOpt =
                    uploadService.uploadFile(target.account(), target.wxUserId(), bytes);
            if (mediaOpt.isEmpty()) {
                return toolSupport.errorJson("文件上传微信 CDN 失败，请稍后重试或检查账号状态");
            }

            boolean sent = sendService.sendFile(target.accountId(), target.wxUserId(), mediaOpt.get(), fileName);
            if (!sent) {
                return toolSupport.errorJson("文件发送失败：context_token 可能已过期，请用户先在微信给机器人发一条消息");
            }

            Map<String, Object> result = new LinkedHashMap<>();
            result.put("success", true);
            result.put("media_type", "file");
            result.put("file_name", fileName);
            result.put("size_bytes", bytes.length);
            result.put("sent_to", target.wxUserId());
            return objectMapper.writeValueAsString(result);
        } catch (Exception e) {
            log.error("SendWechatFileTool execution failed", e);
            return toolSupport.errorJson("发送文件失败: " + e.getMessage());
        }
    }

    /**
     * 文件名字段推断：参数 > URL 尾段（含扩展名） > 本地文件名 > file-<时间戳><扩展名>。
     */
    static String resolveFileName(String requestedName, String file) {
        if (requestedName != null && !requestedName.isBlank()) {
            return requestedName.trim();
        }
        String tail = tailSegment(file);
        if (tail != null && !tail.isBlank()) {
            return tail;
        }
        String ext = extensionOf(file);
        return "file-" + LocalDateTime.now().format(FILE_TS) + ext;
    }

    /** 取 URL/路径最后一段（解码后），忽略末尾斜杠；host 或空路径返回 null */
    static String tailSegment(String file) {
        if (file == null || file.isBlank()) {
            return null;
        }
        String trimmed = file.trim();
        int q = trimmed.indexOf('?');
        if (q >= 0) {
            trimmed = trimmed.substring(0, q);
        }
        if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
            try {
                java.net.URI uri = new java.net.URI(trimmed);
                String path = uri.getPath();
                trimmed = path != null ? path : "";
            } catch (Exception e) {
                trimmed = trimmed.replace('\\', '/');
            }
        } else {
            trimmed = trimmed.replace('\\', '/');
        }
        while (trimmed.endsWith("/")) {
            trimmed = trimmed.substring(0, trimmed.length() - 1);
        }
        int slash = trimmed.lastIndexOf('/');
        String tail = slash >= 0 ? trimmed.substring(slash + 1) : trimmed;
        if (tail.isBlank()) {
            return null;
        }
        try {
            tail = URLDecoder.decode(tail, StandardCharsets.UTF_8.name());
        } catch (UnsupportedEncodingException | IllegalArgumentException ignored) {
            // 保留原值
        }
        return tail;
    }

    /** 从 URL/路径末尾推断扩展名（含点），无扩展名返回空串 */
    static String extensionOf(String file) {
        String tail = tailSegment(file);
        if (tail == null) {
            return "";
        }
        int dot = tail.lastIndexOf('.');
        if (dot > 0 && dot < tail.length() - 1) {
            return tail.substring(dot).toLowerCase(Locale.ROOT);
        }
        return "";
    }
}
