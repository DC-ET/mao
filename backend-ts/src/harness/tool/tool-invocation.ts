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
  /**
   * 运行身份（技术方案 2026-11-04 §5.5）：executionUserId ?? session.userId。
   * 执行期资源类工具（产物/缓存/发送）按它寻址；缺省 null，dispatcher 回落 executionUserId/userId。
   */
  runtimeUserId?: number | null;
  /**
   * 会话 Agent 的按轮快照（2026-11-07 容器复合键方案 §5.6）：buildContext 每轮取
   * agent.id 填充，docker 容器键 (runtimeUserId, agentId) 用它路由；轮中切换 Agent
   * 不影响本轮（下一轮 buildContext 重算）。缺省 null 时 dispatcher 按 sessionId 查库兜底。
   */
  agentId?: number | null;
  workspace: string | null;
  permissionLevel: string | null;
  modelConfig: LlmModelConfig | null;
  sessionTools: Tool[] | null;
  /** 「替我审批」的上下文快照（用户指令 + 工具调用轨迹）；仅 LOCAL 模式构建，其余为 null。 */
  contextSnapshot?: string | null;
}
