export type ToolResultStatus = 'success' | 'error';

/**
 * ToolResult：一次工具调用的结构化结果。
 * content 保持与旧字符串结果逐字节一致，供模型上下文与持久化；
 * status/errorMessage/durationMs 供 UI、审计与多端消费。
 */
export interface ToolResult {
  callId: string;
  status: ToolResultStatus;
  content: string;
  errorMessage?: string;
  durationMs?: number;
}

/** AgentEventListener.onToolCallResult 的 meta 透传类型，是 ToolResult 的子集。 */
export interface ToolCallResultMeta {
  status: ToolResultStatus;
  errorMessage?: string;
  durationMs?: number;
}

export function toolResultMeta(result: ToolResult): ToolCallResultMeta {
  return { status: result.status, errorMessage: result.errorMessage, durationMs: result.durationMs };
}

/**
 * 执行层的"错误启发式"落点：JSON 解析含 error 键即 error。
 * 规则与旧 ws-streaming-event-listener.isErrorResult 完全一致，仅位置从展示层前移到执行层，
 * 判定结果全体下游共享，不再各层重复猜测。
 */
export function normalizeToolResult(callId: string, raw: string, durationMs?: number): ToolResult {
  let isErr = false;
  let errorMessage: string | undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      parsed != null
      && typeof parsed === 'object'
      && !Array.isArray(parsed)
    ) {
      const node = parsed as Record<string, unknown>;
      // 规则对齐旧 isErrorResult：含 error 键即 error；否则 exit_code 存在且非 0 即 error
      if ('error' in node) {
        isErr = true;
        const v = node.error;
        if (typeof v === 'string' && v.trim() !== '') errorMessage = v;
      } else if ('exit_code' in node && Number(node.exit_code) !== 0) {
        isErr = true;
      }
    }
  } catch {
    // 非 JSON 结果视为正常文本
  }
  return { callId, status: isErr ? 'error' : 'success', content: raw, errorMessage, durationMs };
}
