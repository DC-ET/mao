import type { AskAnswer, AskQuestion, TodoItem } from '../ws/event-types';
import type { MdLine } from './markdown-parse';
import type { InputView } from './input-controller';

export type Tone = 'ok' | 'err' | 'warn' | 'dim' | 'info';

/** 已定稿、写入 <Static> 的转录片段。写进去之后不再重绘。 */
export type TranscriptItem =
  | { kind: 'welcome'; lines: string[] }
  | { kind: 'history'; lines: string[] }
  | { kind: 'user'; text: string }
  /** 助手正文按行定稿：行分类在流式阶段完成，避免整段文本反复重排。 */
  | { kind: 'mdline'; line: MdLine }
  | { kind: 'thinking'; text: string }
  | { kind: 'tool'; name: string; args?: string; result?: string; failed?: boolean }
  | { kind: 'status'; text: string; tone?: Tone }
  | { kind: 'sys'; text: string; tone?: Tone }
  | { kind: 'divider' };

/**
 * 一段已定稿输出。回合内会产生多个 block（流式定稿），
 * spaced 只在回合边界为 true，避免每行之间出现空行。
 */
export interface StaticBlock {
  id: string;
  items: TranscriptItem[];
  spaced?: boolean;
}

export interface FooterMeta {
  agentName: string;
  modelName: string;
  executionMode: string;
  contextPct?: string;
  todo?: string;
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

/**
 * 进行中的内容。渲染前已按终端宽高裁剪：每个字符串恰好占一个终端行，
 * 组件只负责画，不负责决定显示多少。
 */
export interface LiveView {
  /** 单行状态（spinner + 阶段 + 耗时）。 */
  status?: string;
  thinking: string[];
  tail: MdLine[];
  tools: Array<{ id: string; text: string }>;
  announce: string[];
}

export interface ApprovalRequest {
  toolName: string;
  description: string;
  dangerReason?: string | null;
  workspace?: string;
}

export interface PanelLine {
  text: string;
  tone?: Tone;
  bold?: boolean;
  /** 高亮当前选项。 */
  active?: boolean;
}

/** 弹窗视图：已按宽度裁剪，行数即终端行数（不含边框）。 */
export interface PanelView {
  kind: 'ask' | 'approval';
  borderColor: string;
  lines: PanelLine[];
}

/** 布局预算，由终端行列推导；live 区总高度必须恒小于 rows。 */
export interface LayoutBudget {
  rows: number;
  columns: number;
  draftRows: number;
  announceRows: number;
  toolRows: number;
  tailRows: number;
  thinkingRows: number;
  paletteRows: number;
}

export interface TuiAppProps {
  staticBlocks: StaticBlock[];
  live: LiveView;
  input: InputView | null;
  panel: PanelView | null;
  footer: FooterMeta;
  verboseTools: boolean;
  asciiOnly: boolean;
  columns: number;
}

/** REPL 侧持有的 TUI 控制面：只暴露真正被使用的操作。 */
export interface TuiHandle {
  /** 真实清屏：卸载并重挂 Ink（fullStaticOutput 无法单独清空）。 */
  clearAll: () => void;
  unmount: () => void;
}

export type { AskAnswer, AskQuestion, TodoItem };
