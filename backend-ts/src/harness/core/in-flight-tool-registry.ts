/**
 * 正在执行的工具调用（纯内存态）。
 *
 * 一轮 assistant 消息（含 tool_calls）要等该轮全部工具执行完才落库（见 agent-loop 里
 * executeToolCalls 之后的 onSaveToolRound），所以管理后台只读 DB 时，正在跑的工具整段看不见。
 * 「哪个工具正在跑」只有运行进程自己知道，因此在派发前后登记/注销，供管理端接口补进行中卡片。
 */

export interface InFlightToolCall {
  /** tool_call id（模型下发，落库后同 id 用于关联 TOOL 消息） */
  id: string;
  name: string;
  /** 模型下发的原始 arguments JSON 字符串 */
  arguments: string;
  /** 开始执行的毫秒时间戳 */
  startedAt: number;
}

export class InFlightToolRegistry {
  private readonly bySession = new Map<number, Map<string, InFlightToolCall>>();

  start(sessionId: number, call: Omit<InFlightToolCall, 'startedAt'>): void {
    if (!call.id) return;
    const calls = this.bySession.get(sessionId) ?? new Map<string, InFlightToolCall>();
    calls.set(call.id, { ...call, startedAt: Date.now() });
    this.bySession.set(sessionId, calls);
  }

  finish(sessionId: number, toolCallId: string): void {
    const calls = this.bySession.get(sessionId);
    if (!calls) return;
    calls.delete(toolCallId);
    if (calls.size === 0) this.bySession.delete(sessionId);
  }

  listForSession(sessionId: number): InFlightToolCall[] {
    const calls = this.bySession.get(sessionId);
    if (!calls) return [];
    return [...calls.values()].sort((a, b) => a.startedAt - b.startedAt);
  }

  /** 一次执行结束时整体清空：异常/取消路径漏掉 finish 也不会留下幽灵卡片。 */
  clear(sessionId: number): void {
    this.bySession.delete(sessionId);
  }
}
