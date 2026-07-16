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

    private Object rawMessage;
}
