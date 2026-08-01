package cn.etarch.mao.weixin.service;

import cn.etarch.mao.harness.safety.PathSandbox;
import cn.etarch.mao.harness.tool.ImageFileSupport;
import cn.etarch.mao.weixin.entity.WeixinChannelAccount;
import cn.etarch.mao.weixin.entity.WeixinChannelContextToken;
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import org.springframework.stereotype.Component;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.TimeUnit;

/**
 * 微信媒体发送工具的共享支撑：
 * <ul>
 *   <li>resolveTarget：userId → 绑定账号 + 第一个 wxUserId（与定时任务投递解析一致）</li>
 *   <li>loadBytes：装载媒体字节（本地路径或 http(s) URL），带大小上限</li>
 *   <li>errorJson：统一结构化错误返回</li>
 * </ul>
 */
@Slf4j
@Component
@RequiredArgsConstructor
public class WeixinMediaToolSupport {

    private final WeixinAccountRepository accountRepository;
    private final ContextTokenRepository contextTokenRepository;
    private final PathSandbox pathSandbox;
    private final ObjectMapper objectMapper;

    private final OkHttpClient httpClient = new OkHttpClient.Builder()
            .connectTimeout(10, TimeUnit.SECONDS)
            .readTimeout(180, TimeUnit.SECONDS)
            .build();

    /** 解析结果：accountId（下行用）+ wxUserId（收件人）+ 账号实体（上传用） */
    public record WechatTarget(String accountId, String wxUserId, WeixinChannelAccount account) {
    }

    /**
     * 解析收件人：userId → 绑定账号 + context_token 表中第一个 wxUserId。
     * 未绑定账号或用户从未给 Bot 发过消息（无 context_token 记录）时返回 empty。
     */
    public Optional<WechatTarget> resolveTarget(Long userId) {
        if (userId == null) {
            return Optional.empty();
        }
        WeixinChannelAccount account = accountRepository.findByUserId(userId);
        if (account == null) {
            log.warn("微信媒体发送：用户未绑定微信Bot账号, userId={}", userId);
            return Optional.empty();
        }
        List<WeixinChannelContextToken> tokens = contextTokenRepository.findByAccountId(account.getAccountId());
        if (tokens == null || tokens.isEmpty()) {
            log.warn("微信媒体发送：账号无 context_token 记录, accountId={}", account.getAccountId());
            return Optional.empty();
        }
        return Optional.of(new WechatTarget(account.getAccountId(), tokens.get(0).getWxUserId(), account));
    }

    /**
     * 装载媒体字节：http(s) URL 走服务端下载；其余按本地路径解析
     * （绝对路径直接读取，相对路径以会话工作区为基准）。
     *
     * @throws Exception 路径非法、文件不存在、超过大小上限、下载失败等
     */
    public byte[] loadBytes(String pathOrUrl, String workspace, long maxBytes) throws Exception {
        if (pathOrUrl == null || pathOrUrl.isBlank()) {
            throw new IllegalArgumentException("媒体来源不能为空");
        }
        String trimmed = pathOrUrl.trim();
        if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
            return downloadFromUrl(trimmed, maxBytes);
        }
        return readLocalFile(trimmed, workspace, maxBytes);
    }

    private byte[] readLocalFile(String path, String workspace, long maxBytes) throws Exception {
        Path filePath = pathSandbox.resolveLenient(path, workspace);
        if (!Files.exists(filePath) || !Files.isRegularFile(filePath)) {
            throw new IllegalArgumentException("文件不存在或不是普通文件: " + path);
        }
        long size = Files.size(filePath);
        if (size > maxBytes) {
            throw new IllegalArgumentException("文件过大（" + ImageFileSupport.formatSize(size)
                    + "），上限 " + ImageFileSupport.formatSize(maxBytes));
        }
        return Files.readAllBytes(filePath);
    }

    private byte[] downloadFromUrl(String url, long maxBytes) throws Exception {
        Request request = new Request.Builder().url(url).get().build();
        try (Response response = httpClient.newCall(request).execute()) {
            if (!response.isSuccessful() || response.body() == null) {
                throw new IOException("下载失败: HTTP " + response.code());
            }
            try (InputStream in = response.body().byteStream();
                 ByteArrayOutputStream out = new ByteArrayOutputStream()) {
                byte[] buf = new byte[8192];
                int n;
                long total = 0;
                while ((n = in.read(buf)) != -1) {
                    total += n;
                    if (total > maxBytes) {
                        throw new IllegalArgumentException("文件过大，上限 "
                                + ImageFileSupport.formatSize(maxBytes));
                    }
                    out.write(buf, 0, n);
                }
                return out.toByteArray();
            }
        }
    }

    /** 构造统一错误 JSON：{"error": "..."} */
    public String errorJson(String message) {
        try {
            return objectMapper.writeValueAsString(Map.of("error", message));
        } catch (Exception e) {
            return "{\"error\":\"" + message.replace("\"", "'") + "\"}";
        }
    }
}
