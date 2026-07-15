package cn.etarch.mao.weixin.model;

import lombok.Builder;
import lombok.Data;

@Data
@Builder
public class WeixinInboundMessageContext {

    private String accountId;

    private String appCode;

    private String fromUserId;

    private String body;

    private String contextToken;

    private String mediaPath;

    private String mediaType;

    private Object rawMessage;
}