import type { WsAskUserQuestionItem, WsClientType, WsTaskPhase } from '@mao/contracts';

export interface MaoChatTheme {
  /** 主色，默认取 Mao 品牌蓝 */
  primary?: string;
}

export interface MaoChatInitOptions {
  /** Mao 服务地址，如 https://mao.etarch.cn（REST 前缀 /api/v1、WS /api/ws/stream 自动推导） */
  serverUrl: string;
  /** 必填：页面助手绑定的 agent id */
  agentId: number;
  /** token 供给：SDK 不落盘，过期（401/WS 鉴权失败）时重新调用 */
  getToken: () => Promise<string>;
  /** 页面上下文供给：每次发送前实时采集；返回值变化时才拼入引用块 */
  context?: () => Record<string, unknown> | Promise<Record<string, unknown>>;
  theme?: MaoChatTheme;
  position?: 'right' | 'left';
  /** 隐藏自带浮动按钮（宿主自绘入口），用 chat.open() 打开 */
  launcher?: { visible?: boolean };
  /** 事件透传（宿主埋点/状态联动） */
  onEvent?: (event: MaoChatEvent) => void;
}

export interface MaoChatInstance {
  open(): void;
  close(): void;
  toggle(): void;
  newSession(): Promise<void>;
  setContext(ctx: Record<string, unknown>): void;
  destroy(): void;
}

/** 透传给宿主的事件 */
export type MaoChatEvent =
  | { type: 'phase'; phase: WsTaskPhase; sessionId: number }
  | { type: 'error'; message: string }
  | { type: 'unread'; count: number };

/** 浮窗内一条消息的运行时形态 */
export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  thinking: string;
  streaming: boolean;
  error: boolean;
  /** 工具调用卡片 */
  toolCalls: ToolCallItem[];
}

export interface ToolCallItem {
  toolCallId: string;
  toolName: string;
  displayName: string;
  argsText: string;
  status: 'running' | 'done' | 'error';
  resultText: string;
}

export interface PendingQuestion {
  requestId: string;
  questions: WsAskUserQuestionItem[];
}

/** 连接/会话生命周期驱动 UI 的一组响应式状态 */
export interface ChatUiState {
  connected: boolean;
  open: boolean;
  phase: WsTaskPhase | null;
  llmRetryText: string | null;
  executionError: string | null;
  unread: number;
  pendingQuestion: PendingQuestion | null;
  quotedSelection: string | null;
  sessionError: string | null;
}

export const DEFAULT_WS_SILENCE_TIMEOUT_MS = 30_000;
export const HEARTBEAT_INTERVAL_MS = 5_000;
export const CONTEXT_LIMIT_BYTES = 8 * 1024;

export function resolveWsUrl(serverUrl: string): string {
  const trimmed = serverUrl.replace(/\/+$/, '');
  const base = trimmed.endsWith('/api') ? trimmed : `${trimmed}/api`;
  return `${base.replace(/^http/, 'ws')}/ws/stream?client=embed`;
}

export function resolveApiBase(serverUrl: string): string {
  const trimmed = serverUrl.replace(/\/+$/, '');
  return trimmed.endsWith('/api/v1') ? trimmed : `${trimmed}/api/v1`;
}

export function normalizeClientType(client: string | undefined): WsClientType {
  if (client?.toLowerCase() === 'embed') return 'embed';
  return 'browser';
}
