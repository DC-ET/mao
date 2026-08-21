import type { CliEvent, RunResult } from '../render/types';
import type { AskAnswer, AskQuestion, TodoItem } from '../ws/event-types';

/** A completed round of conversation, frozen for <Static> rendering. */
export interface StaticRound {
  id: string;
  lines: string[];
}

/** Live (in-progress) content that updates in real-time. */
export interface LiveState {
  running: boolean;
  status: string;
  segmentRaw: string;
  toolCalls: ToolCallDisplay[];
  error?: string;
  warnings: string[];
  /** 即时提示（/help、/cancel 确认、排队提示等），实时渲染在输入区上方。 */
  announce: string[];
  todos: TodoItem[];
  contextPct?: string;
  spinnerFrame: number;
}

export interface ToolCallDisplay {
  toolCallId: string;
  toolName: string;
  arguments?: string;
  status: string;
  result?: string;
  preview?: string;
  summary?: string;
}

/** Modal state for ask_user_questions / approval overlays. */
export type ModalState =
  | { type: 'ask'; requestId: string; questions: AskQuestion[] }
  | { type: 'approval'; request: ApprovalRequest; reason: string }
  | null;

export interface ApprovalRequest {
  toolName: string;
  description: string;
  dangerReason?: string | null;
  workspace?: string;
}

/** Props passed to the Ink App component. */
export interface TuiAppProps {
  staticRounds: StaticRound[];
  live: LiveState;
  modal: ModalState;
  draft: string;
  continuation: boolean;
  meta: string;
  verboseTools: boolean;
  historyLines: string[];
  welcomeLines: string[];
  asciiOnly: boolean;
  modelNames?: string[];
  onSubmit: (text: string) => void;
  onCancel: () => void;
  onExit: () => void;
  onAskResponse: (requestId: string, answers: AskAnswer[] | 'fail' | 'cancelled') => void;
  onApprovalResponse: (choice: 'allow' | 'deny' | 'always') => void;
  onSlashClear: () => void;
}

/** Callbacks the Ink TUI exposes to the REPL layer. */
export interface InkTuiHandle {
  pushStaticRound(round: StaticRound): void;
  updateLive(patch: Partial<LiveState>): void;
  setDraft(draft: string): void;
  setContinuation(on: boolean): void;
  setMeta(meta: string): void;
  setModal(modal: ModalState): void;
  setVerboseTools(on: boolean): void;
  pushHistoryLine(line: string): void;
  clearAll(): void;
  unmount(): void;
}

/** A renderer that bridges CliEvent → Ink state. */
export interface InkRendererLike {
  onEvent(evt: CliEvent): void;
  finish?(result: RunResult): void;
  clearTransient?(): void;
  getLastAssistantText(): string;
  getVerboseTools(): boolean;
  setVerboseTools(on: boolean): void;
  setMeta(meta: { agentName?: string; modelName?: string; executionMode?: string; contextWindowTokens?: number }): void;
  announce(message: string): void;
  printHeader(lines: string[]): void;
  noteUser(text: string): void;
  startRound(): void;
  getComposer(): null;
}
