package cn.etarch.mao.weixin.service;

import cn.etarch.mao.weixin.model.WeixinInboundMessageContext;
import cn.etarch.mao.weixin.model.WeixinReply;

import java.util.concurrent.CompletionStage;

public interface WeixinInboundHandler {

    boolean authorizeDirectMessage(String accountId, String fromUserId, String text);

    CompletionStage<WeixinReply> onMessage(WeixinInboundMessageContext context);
}