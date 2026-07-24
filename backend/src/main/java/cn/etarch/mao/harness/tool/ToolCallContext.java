package cn.etarch.mao.harness.tool;

/**
 * 当前线程正在执行的 tool_call_id（供并行工具调用时关联上下文，如 delegate → 子会话）。
 */
public final class ToolCallContext {

    private static final ThreadLocal<String> TOOL_CALL_ID = new ThreadLocal<>();

    private ToolCallContext() {
    }

    public static void setToolCallId(String toolCallId) {
        if (toolCallId == null || toolCallId.isBlank()) {
            TOOL_CALL_ID.remove();
        } else {
            TOOL_CALL_ID.set(toolCallId);
        }
    }

    public static String getToolCallId() {
        return TOOL_CALL_ID.get();
    }

    public static void clear() {
        TOOL_CALL_ID.remove();
    }
}
