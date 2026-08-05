package cn.etarch.mao.harness.core;

import cn.etarch.mao.harness.llm.ChatRequest;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Component;

import java.util.Collections;
import java.util.List;

/**
 * 统一活跃上下文 token 计算：有锚点则 {@code lastPromptTokens + 增量消息}，否则全量 request 估算。
 */
@Component
@RequiredArgsConstructor
public class ActiveContextCalculator {

    private final TokenEstimator tokenEstimator;

    public int active(int lastPromptTokens,
                      long contextAnchorMsgId,
                      List<ChatRequest.Message> messagesAfterAnchor,
                      ChatRequest fullRequestFallback) {
        if (lastPromptTokens > 0 && contextAnchorMsgId > 0) {
            List<ChatRequest.Message> delta = messagesAfterAnchor != null
                    ? messagesAfterAnchor : Collections.emptyList();
            return lastPromptTokens + tokenEstimator.estimateMessages(delta);
        }
        if (fullRequestFallback != null) {
            return tokenEstimator.estimateRequestTokens(fullRequestFallback);
        }
        return tokenEstimator.estimateMessages(
                messagesAfterAnchor != null ? messagesAfterAnchor : Collections.emptyList());
    }

    /**
     * 内存路径：用「锚点时刻的消息条数」切增量后缀（含尚未落库的 assistant/tool）。
     * {@code messagesCoveredByAnchor} 是送模前的 {@code messages.size()}，之后追加的消息计入增量。
     * 跨请求等无法用下标切分时（covered &lt; 0），回退到全量 request 估算，避免锚点有效却增量被当成空。
     */
    public int activeFromMessageSuffix(int lastPromptTokens,
                                       long contextAnchorMsgId,
                                       List<ChatRequest.Message> allMessages,
                                       int messagesCoveredByAnchor,
                                       ChatRequest fullRequestFallback) {
        if (lastPromptTokens > 0 && contextAnchorMsgId > 0
                && allMessages != null && messagesCoveredByAnchor >= 0
                && messagesCoveredByAnchor <= allMessages.size()) {
            List<ChatRequest.Message> delta = allMessages.subList(
                    messagesCoveredByAnchor, allMessages.size());
            return lastPromptTokens + tokenEstimator.estimateMessages(delta);
        }
        // covered 未设置（如跨请求刚 load 锚点）：不能用空增量，优先全量 request
        if (fullRequestFallback != null) {
            return tokenEstimator.estimateRequestTokens(fullRequestFallback);
        }
        return active(lastPromptTokens, contextAnchorMsgId, null, null);
    }

    public int estimateMessages(List<ChatRequest.Message> messages) {
        return tokenEstimator.estimateMessages(messages);
    }

    public int estimateRequestTokens(ChatRequest request) {
        return tokenEstimator.estimateRequestTokens(request);
    }

    public int estimateText(String text) {
        return tokenEstimator.countTokens(text != null ? text : "");
    }
}
