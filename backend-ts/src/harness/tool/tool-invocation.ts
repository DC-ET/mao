import type { LlmModelConfig } from '../llm/chat-request.js';
import type { Tool } from './tool.js';

/**
 * ToolInvocation：一次工具调用的完整上下文。
 * 取代历史 dispatch() 通过位置参数传递执行上下文的方式。
 */
export interface ToolInvocation {
  callId: string;
  toolName: string;
  argumentsJson: string;
  executionMode: string | null;
  sessionId: number | null;
  userId: number | null;
  executionUserId: number | null;
  workspace: string | null;
  permissionLevel: string | null;
  modelConfig: LlmModelConfig | null;
  sessionTools: Tool[] | null;
  /** 「替我审批」的上下文快照（用户指令 + 工具调用轨迹）；仅 LOCAL 模式构建，其余为 null。 */
  contextSnapshot?: string | null;
}
