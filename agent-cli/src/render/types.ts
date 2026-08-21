import type { AskAnswer, AskQuestion, TodoItem } from '../ws/event-types';

export type CliEvent =
  | { type: 'session_started'; sessionId: number; executionId?: string }
  | { type: 'content_delta'; delta: string }
  | { type: 'thinking_start' }
  | { type: 'thinking_delta'; delta: string }
  | { type: 'thinking_end' }
  | { type: 'tool_call_start'; toolCallId: string; toolName: string; arguments?: string }
  | { type: 'tool_call_args_delta'; toolCallId: string; arguments: string }
  | { type: 'tool_call_result'; toolCallId: string; toolName?: string; status: string; result?: string; preview?: string; summary?: string }
  | { type: 'file_change'; path: string; changeType: string; linesAdded: number; linesDeleted: number }
  | { type: 'message_end'; promptTokens: number; completionTokens: number; totalTokens: number }
  | { type: 'context_window'; estimated?: number; actual?: number }
  | { type: 'compaction_start'; messageCount?: number; estimatedTokens?: number }
  | { type: 'compaction_end'; savedTokens?: number; durationMs?: number }
  | { type: 'llm_waiting'; phase?: string; elapsedSeconds?: number }
  | { type: 'llm_retry'; reason?: string; attempt?: number; maxRetries?: number; delaySeconds?: number }
  | { type: 'llm_stream_reset' }
  | { type: 'ask_user_questions'; requestId: string; questions: AskQuestion[] }
  | { type: 'ask_user_questions_cancelled'; requestId: string }
  | { type: 'todo_updated'; todos: TodoItem[] }
  | { type: 'activity'; summary?: string; status?: string }
  | { type: 'session_status'; phase: string; executionId?: string }
  | { type: 'session_already_running'; message?: string; executionId?: string }
  | { type: 'error'; message: string }
  | { type: 'reconnected' }
  | { type: 'user_message_saved'; messageId: number }
  | { type: 'side_session_created'; sideSessionId: number; title?: string }
  | { type: 'subagent_session_created'; childSessionId: number; title?: string };

export interface ToolCallRecord {
  toolCallId: string;
  toolName: string;
  status: string;
  arguments?: string;
  result?: string;
}

export interface FileChangeRecord {
  path: string;
  type: string;
  linesAdded: number;
  linesDeleted: number;
}

export interface UsageRecord {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface RunResult {
  type: 'result';
  sessionId: number;
  executionId: string;
  status: string;
  result: string;
  usage: UsageRecord;
  toolCalls: ToolCallRecord[];
  fileChanges: FileChangeRecord[];
  durationMs: number;
  reconnected?: boolean;
  error?: string;
}

export interface Renderer {
  onEvent(evt: CliEvent): void;
  finish?(result: RunResult): void;
  clearTransient?(): void;
}

export type AskHandler = (requestId: string, questions: AskQuestion[]) => Promise<AskAnswer[] | 'fail' | 'cancelled'>;
