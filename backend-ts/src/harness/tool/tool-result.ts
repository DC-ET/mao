export type ToolResultStatus = 'success' | 'error';

/** AI 审批标记：本次调用由谁放行/拒绝。mode=llm 审批模型拍板；mode=jev 前置决策低风险放行。 */
export interface ToolApprovalMark {
  mode: 'llm' | 'jev';
  approved: boolean;
  reason: string;
}

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
  /** PROXY 级 AI 审批的拍板结果；未经 AI 审批的调用为空。 */
  approvalMark?: ToolApprovalMark | null;
}

/** AgentEventListener.onToolCallResult 的 meta 透传类型，是 ToolResult 的子集。 */
export interface ToolCallResultMeta {
  status: ToolResultStatus;
  errorMessage?: string;
  durationMs?: number;
  approvalMark?: ToolApprovalMark | null;
  /** 后端在工具实现内已截断输出（结果 JSON 顶层 `truncated===true`）；实时事件走此通道。 */
  resultTruncated?: boolean;
}

export function toolResultMeta(result: ToolResult): ToolCallResultMeta {
  return {
    status: result.status,
    errorMessage: result.errorMessage,
    durationMs: result.durationMs,
    approvalMark: result.approvalMark ?? undefined,
  };
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
