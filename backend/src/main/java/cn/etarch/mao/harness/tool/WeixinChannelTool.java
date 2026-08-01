package cn.etarch.mao.harness.tool;

/**
 * 微信通道专属工具标记接口。
 * <p>
 * 实现该接口的工具仅在 {@code projectKey = "weixin-bot"} 的会话中注入给 Agent
 * （见 HarnessService 工具集注入处的过滤逻辑）；其他渠道会话既不进入 LLM 工具
 * schema，也会在执行层被 isToolAllowed 拦截。
 */
public interface WeixinChannelTool {
}
