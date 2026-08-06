package cn.etarch.mao.weixin.service;

import cn.etarch.mao.weixin.model.WeixinInboundMessageContext;
import cn.etarch.mao.weixin.model.WeixinReply;
import com.fasterxml.jackson.databind.JsonNode;
import jakarta.annotation.PreDestroy;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

@Slf4j
@Service
@RequiredArgsConstructor
public class InboundProcessor {

    private static final int ITEM_TYPE_TEXT = 1;
    private static final int ITEM_TYPE_IMAGE = 2;
    private static final int ITEM_TYPE_FILE = 4;

    private final WeixinInboundHandler inboundHandler;
    private final ContextTokenRepository contextTokenRepository;
    private final WeixinSendService weixinSendService;
    private final WeixinMediaService weixinMediaService;
    private final WeixinVoiceReplyService weixinVoiceReplyService;

    /** 语音回复异步发送线程池（避免阻塞回复主流程） */
    private final ExecutorService voiceReplyExecutor =
            Executors.newFixedThreadPool(2, r -> {
                Thread t = new Thread(r, "weixin-voice-reply");
                t.setDaemon(true);
                return t;
            });

    @PreDestroy
    void shutdown() {
        voiceReplyExecutor.shutdownNow();
    }

    /**
     * 处理入站消息
     */
    public void processInboundMessage(String accountId, JsonNode message) {
        try {
            // 1. 提取消息信息
            String fromUserId = message.get("from_user_id").asText();
            String contextToken = message.has("context_token") ? message.get("context_token").asText() : null;

            // 2. 保存context_token
            if (contextToken != null && !contextToken.isEmpty()) {
                contextTokenRepository.saveOrUpdate(accountId, fromUserId, contextToken);
            }

            // 3. 提取文本、图片与文件
            String body = extractMessageBody(message);
            List<WeixinMediaService.DownloadedMedia> images = downloadImages(message);
            FileDownloadResult fileResult = downloadFiles(message);
            List<WeixinInboundMessageContext.InboundFile> files = fileResult.files();

            if ((body == null || body.isBlank()) && images.isEmpty()
                    && files.isEmpty() && fileResult.failedNames().isEmpty()) {
                log.info("忽略空消息（无文本无图片无文件）, accountId={}, fromUserId={}", accountId, fromUserId);
                return;
            }

            List<String> imageDataUris = new ArrayList<>();
            String mediaPath = null;
            String mediaType = null;
            for (WeixinMediaService.DownloadedMedia media : images) {
                imageDataUris.add(media.dataUri());
                if (mediaPath == null) {
                    mediaPath = media.path().toString();
                    mediaType = media.mimeType();
                }
            }

            // 4. 构建入站消息上下文
            WeixinInboundMessageContext context = WeixinInboundMessageContext.builder()
                    .accountId(accountId)
                    .fromUserId(fromUserId)
                    .body(body != null ? body : "")
                    .contextToken(contextToken)
                    .mediaPath(mediaPath)
                    .mediaType(mediaType)
                    .imageDataUris(imageDataUris)
                    .files(files)
                    .fileDownloadErrors(fileResult.failedNames())
                    .rawMessage(message)
                    .build();

            // 5. 调用业务处理器
            CompletionStage<WeixinReply> replyFuture = inboundHandler.onMessage(context);

            // 6. 处理回复（null 表示被更新消息取消，不下行）
            replyFuture.whenComplete((reply, error) -> {
                if (error != null) {
                    log.error("处理微信消息失败, accountId={}, fromUserId={}", accountId, fromUserId, error);
                    return;
                }

                if (reply == null) {
                    log.debug("微信消息处理已取消（被后续消息接管）, accountId={}, fromUserId={}",
                            accountId, fromUserId);
                    return;
                }

                if (reply.getText() != null && !reply.getText().isEmpty()) {
                    sendReply(accountId, fromUserId, contextToken, reply);
                }
            });

        } catch (Exception e) {
            log.error("处理入站消息失败", e);
        }
    }

    /**
     * 提取消息正文
     */
    private String extractMessageBody(JsonNode message) {
        try {
            JsonNode itemList = message.get("item_list");
            if (itemList == null || !itemList.isArray() || itemList.isEmpty()) {
                return "";
            }

            // 优先提取文本消息
            for (JsonNode item : itemList) {
                int type = item.path("type").asInt(-1);
                if (type == ITEM_TYPE_TEXT) {
                    JsonNode textItem = item.get("text_item");
                    if (textItem != null && textItem.has("text")) {
                        return textItem.get("text").asText();
                    }
                }
            }

            // 语音识别文本（若有）
            for (JsonNode item : itemList) {
                int type = item.path("type").asInt(-1);
                if (type == 3) { // VOICE
                    JsonNode voiceItem = item.get("voice_item");
                    if (voiceItem != null && voiceItem.has("text")) {
                        String text = voiceItem.get("text").asText();
                        if (text != null && !text.isBlank()) {
                            return text;
                        }
                    }
                }
            }

            // 如果没有文本消息，尝试提取消息描述
            if (message.has("description")) {
                return message.get("description").asText();
            }

            return "";
        } catch (Exception e) {
            log.warn("提取消息正文失败", e);
            return "";
        }
    }

    private List<WeixinMediaService.DownloadedMedia> downloadImages(JsonNode message) {
        List<WeixinMediaService.DownloadedMedia> result = new ArrayList<>();
        JsonNode itemList = message.get("item_list");
        if (itemList == null || !itemList.isArray()) {
            return result;
        }

        for (JsonNode item : itemList) {
            int type = item.path("type").asInt(-1);
            if (type != ITEM_TYPE_IMAGE) {
                continue;
            }
            JsonNode imageItem = item.get("image_item");
            Optional<WeixinMediaService.DownloadedMedia> downloaded = weixinMediaService.downloadImage(imageItem);
            if (downloaded.isPresent()) {
                result.add(downloaded.get());
            } else {
                log.warn("微信图片下载失败，跳过该图片项");
            }
        }
        return result;
    }

    /**
     * 下载消息中的文件项（file_item, type=4）。
     * 下载/解密失败的项不再静默丢弃：失败原始文件名记录在 failedNames，交由上层提示用户。
     */
    private FileDownloadResult downloadFiles(JsonNode message) {
        List<WeixinInboundMessageContext.InboundFile> files = new ArrayList<>();
        List<String> failedNames = new ArrayList<>();
        JsonNode itemList = message.get("item_list");
        if (itemList == null || !itemList.isArray()) {
            return new FileDownloadResult(files, failedNames);
        }

        for (JsonNode item : itemList) {
            int type = item.path("type").asInt(-1);
            if (type != ITEM_TYPE_FILE) {
                continue;
            }
            JsonNode fileItem = item.get("file_item");
            String fileName = extractFileDisplayName(fileItem);
            Optional<WeixinMediaService.DownloadedFile> downloaded = weixinMediaService.downloadFile(fileItem);
            if (downloaded.isPresent()) {
                WeixinMediaService.DownloadedFile file = downloaded.get();
                files.add(new WeixinInboundMessageContext.InboundFile(
                        file.fileName(), file.bytes(), file.mimeType()));
            } else {
                log.warn("微信文件下载失败，记录失败项, fileName={}", fileName);
                failedNames.add(fileName);
            }
        }
        return new FileDownloadResult(files, failedNames);
    }

    /**
     * 提取文件项显示名（失败提示用）：优先 file_name，缺失时用默认名。
     */
    private String extractFileDisplayName(JsonNode fileItem) {
        if (fileItem != null && !fileItem.isNull()) {
            JsonNode name = fileItem.get("file_name");
            if (name != null && !name.isNull() && !name.asText().isBlank()) {
                return name.asText();
            }
        }
        return "未知文件";
    }

    /** 文件下载结果：成功文件 + 失败文件名列表 */
    private record FileDownloadResult(
            List<WeixinInboundMessageContext.InboundFile> files,
            List<String> failedNames) {
    }

    /**
     * 发送回复消息
     */
    private void sendReply(String accountId, String toUserId, String contextToken, WeixinReply reply) {
        try {
            if (contextToken == null || contextToken.isEmpty()) {
                log.warn("无法发送回复: 缺少context_token, accountId={}, toUserId={}", accountId, toUserId);
                return;
            }

            boolean success = weixinSendService.sendText(accountId, toUserId, reply.getText());
            if (success) {
                log.debug("发送微信回复成功, accountId={}, toUserId={}", accountId, toUserId);
            } else {
                log.warn("发送微信回复失败, accountId={}, toUserId={}", accountId, toUserId);
            }

            // 文本发送成功后，尝试附带语音回复（失败自动回退，不影响文本）
            String text = reply.getText();
            if (success && text != null && !text.isEmpty()) {
                voiceReplyExecutor.execute(() -> {
                    boolean voiceSent = weixinVoiceReplyService.sendVoiceReply(accountId, toUserId, text);
                    if (!voiceSent) {
                        log.debug("微信语音回复未发送（开关关闭或链路失败）, accountId={}, toUserId={}",
                                accountId, toUserId);
                    }
                });
            }
        } catch (Exception e) {
            log.error("发送回复消息失败", e);
        }
    }
}
