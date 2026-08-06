package cn.etarch.mao.weixin.model;

import lombok.Builder;
import lombok.Data;

import java.util.ArrayList;
import java.util.List;

@Data
@Builder
public class WeixinInboundMessageContext {

    private String accountId;

    private String appCode;

    private String fromUserId;

    private String body;

    private String contextToken;

    /** 首张图片本地路径（兼容字段） */
    private String mediaPath;

    /** 首张图片 MIME（兼容字段） */
    private String mediaType;

    /** 入站图片的 data URI 列表，供多模态 Agent 使用 */
    @Builder.Default
    private List<String> imageDataUris = new ArrayList<>();

    /** 入站文件列表（已下载解密，待保存到会话工作区） */
    @Builder.Default
    private List<InboundFile> files = new ArrayList<>();

    /** 入站文件中下载/解密失败的原始文件名列表（不再静默忽略，交由 handler 提示用户） */
    @Builder.Default
    private List<String> fileDownloadErrors = new ArrayList<>();

    private Object rawMessage;

    /** 入站文件：原始文件名 + 明文字节 + MIME 探测值 */
    public record InboundFile(String fileName, byte[] bytes, String mimeType) {
    }
}
