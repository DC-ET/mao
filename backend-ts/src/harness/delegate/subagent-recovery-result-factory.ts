import type { SubagentExecution } from '../../session/types.js';

export class SubagentRecoveryResultFactory {
  static build(execution: SubagentExecution): Record<string, unknown> {
    const cancelled = execution.status === 'CANCELLED';
    const success = execution.status === 'COMPLETED';
    const result = execution.result || (success ? '(子代理未产生文本输出)' : '子代理恢复失败');
    const payload: Record<string, unknown> = {
      success,
      cancelled,
      agent_type: execution.agentType ?? '',
      child_session_id: execution.childSessionId,
      result,
      rounds: execution.totalRounds ?? 0,
      tool_calls: execution.totalToolCalls ?? 0,
    };
    if (execution.invocationType === 'FOLLOWUP') payload.follow_up = true;
    if (!success) payload.error = result;
    const promptTokens = execution.totalPromptTokens ?? 0;
    const completionTokens = execution.totalCompletionTokens ?? 0;
    if (promptTokens > 0 || completionTokens > 0) {
      payload.usage = {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
      };
    }
    return payload;
  }

  static invocationArguments(execution: SubagentExecution): Record<string, unknown> {
    return execution.invocationType === 'FOLLOWUP'
      ? { child_session_id: execution.childSessionId, task: execution.taskDescription ?? '' }
      : { agent_type: execution.agentType ?? '', task: execution.taskDescription ?? '' };
  }
}
