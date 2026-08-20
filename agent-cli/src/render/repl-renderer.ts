import {
  countRewindRows,
  countVisualRows,
  createAnsi,
  renderMarkdownLite,
  shouldUseColor,
  truncate,
  type Ansi,
} from '../util/ansi';
import { DEFAULT_CONTEXT_WINDOW_TOKENS, formatContextPercent } from '../util/context';
import { StatusLine } from '../ui/status-line';
import { pickSymbols, type UiSymbols } from '../ui/symbols';
import { formatTodoSummary } from '../ui/todo-summary';
import type { TodoItem } from '../ws/event-types';
import type { CliEvent, Renderer, RunResult } from './types';

export interface ReplRendererOptions {
  printMode: boolean;
  thinking: boolean;
  stdoutIsTty: boolean;
  colorFlag?: boolean;
  agentName?: string;
  modelName?: string;
  executionMode?: string;
  contextWindowTokens?: number;
  verboseTools?: boolean;
  asciiOnly?: boolean;
  showTurnDividers?: boolean;
  columns?: () => number;
  rows?: () => number;
  stdout?: { write: (s: string) => void };
  stderr?: { write: (s: string) => void };
}

export class ReplRenderer implements Renderer {
  private readonly ansi: Ansi;
  private readonly thinking: boolean;
  private readonly stdout: { write: (s: string) => void };
  private readonly stderr: { write: (s: string) => void };
  private readonly symbols: UiSymbols;
  private readonly showTurnDividers: boolean;
  private readonly status: StatusLine;
  private readonly columns: () => number;
  private seenTools = new Set<string>();
  private agentName: string;
  private modelName: string;
  private executionMode: string;
  private contextWindowTokens: number;
  private contextPct?: string;
  private verboseTools: boolean;
  private atLineStart = true;
  private todos: TodoItem[] = [];
  private segmentRaw = '';
  private roundText = '';
  private lastRoundText = '';

  constructor(opts: ReplRendererOptions) {
    const color = shouldUseColor({ colorFlag: opts.colorFlag, printMode: false, stdoutIsTty: opts.stdoutIsTty });
    this.ansi = createAnsi(color && !opts.printMode);
    this.thinking = opts.thinking;
    this.stdout = opts.stdout ?? process.stdout;
    this.stderr = opts.stderr ?? process.stderr;
    this.symbols = pickSymbols(Boolean(opts.asciiOnly));
    this.showTurnDividers = opts.showTurnDividers !== false && Boolean(opts.stdoutIsTty) && !opts.printMode;
    this.verboseTools = Boolean(opts.verboseTools);
    this.agentName = opts.agentName ?? 'Agent';
    this.modelName = opts.modelName ?? 'model';
    this.executionMode = opts.executionMode ?? 'CLOUD';
    this.contextWindowTokens = opts.contextWindowTokens ?? DEFAULT_CONTEXT_WINDOW_TOKENS;
    this.columns = opts.columns ?? (() => process.stdout.columns || 0);
    const useStatusBar = opts.stdoutIsTty && !opts.printMode;
    this.status = new StatusLine({
      enabled: useStatusBar,
      stderr: this.stderr,
      clearLine: this.ansi.clearLine,
      dim: (s) => this.ansi.dim(s),
      frames: this.symbols.spin,
      getMeta: () => this.metaBits(),
      rows: opts.rows ?? (() => process.stderr.rows || process.stdout.rows || 0),
    });
  }

  setMeta(meta: { agentName?: string; modelName?: string; executionMode?: string; contextWindowTokens?: number }): void {
    if (meta.agentName) this.agentName = meta.agentName;
    if (meta.modelName) this.modelName = meta.modelName;
    if (meta.executionMode) this.executionMode = meta.executionMode;
    if (meta.contextWindowTokens && meta.contextWindowTokens > 0) this.contextWindowTokens = meta.contextWindowTokens;
  }

  setVerboseTools(on: boolean): void {
    this.verboseTools = on;
  }

  getVerboseTools(): boolean {
    return this.verboseTools;
  }

  setDraft(draft: string): void {
    this.status.setDraft(draft, this.atLineStart);
  }

  getLastAssistantText(): string {
    return this.lastRoundText;
  }

  startRound(): void {
    this.seenTools.clear();
    this.atLineStart = true;
    this.segmentRaw = '';
    this.roundText = '';
    this.status.startRound();
    if (this.showTurnDividers) this.writeln(this.ansi.dim('──'));
    this.status.setStatus('思考中…', this.atLineStart);
  }

  onEvent(evt: CliEvent): void {
    switch (evt.type) {
      case 'content_delta':
        this.segmentRaw += evt.delta;
        this.roundText += evt.delta;
        this.write(evt.delta);
        break;
      case 'thinking_start':
        this.flushAssistantMarkdown();
        if (this.thinking) this.writeln(this.ansi.dim(`${this.symbols.think} 思考`));
        else this.status.setStatus(`${this.symbols.think} 思考中…`, this.atLineStart);
        break;
      case 'thinking_delta':
        if (this.thinking) this.write(this.ansi.dim(evt.delta));
        break;
      case 'thinking_end':
        if (this.thinking && !this.atLineStart) this.write('\n');
        break;
      case 'tool_call_start': {
        this.flushAssistantMarkdown();
        if (this.seenTools.has(evt.toolCallId)) break;
        this.seenTools.add(evt.toolCallId);
        const args = evt.arguments ? truncate(evt.arguments, this.verboseTools ? 200 : 80, 1).replace(/\s+/g, ' ') : '';
        this.writeln(this.ansi.cyan(`${this.symbols.tool} ${evt.toolName}  ${args}`));
        this.status.setStatus(`运行 ${evt.toolName}…`, this.atLineStart);
        break;
      }
      case 'tool_call_result': {
        const summary = evt.summary || evt.preview || '';
        if (this.verboseTools) {
          const extra = summary ? truncate(summary, 2000, 20) : `status=${evt.status}`;
          this.writeln(this.ansi.dim(`  ${extra}`));
        } else {
          const extra = summary ? truncate(summary.replace(/\s+/g, ' '), 120, 1) : (evt.status || 'ok');
          this.writeln(this.ansi.dim(`  ${extra}`));
        }
        break;
      }
      case 'file_change': {
        const sign = `+${evt.linesAdded} -${evt.linesDeleted}`;
        this.writeln(this.ansi.green(`  ${sign} ${evt.path}`));
        break;
      }
      case 'todo_updated':
        this.todos = evt.todos ?? [];
        this.status.nudge(this.atLineStart);
        break;
      case 'compaction_start':
        this.flushAssistantMarkdown();
        this.writeln(this.ansi.yellow(`${this.symbols.spin[0]} 正在压缩上下文…`));
        break;
      case 'compaction_end':
        this.writeln(this.ansi.yellow(`${this.symbols.ok} 上下文压缩完成（节省 ${evt.savedTokens ?? '?'} tokens，${evt.durationMs ?? '?'}ms）`));
        break;
      case 'llm_retry':
        this.writeln(this.ansi.yellow(`${this.symbols.spin[0]} LLM 重试 ${evt.attempt ?? '?'}/${evt.maxRetries ?? '?'}（${evt.reason ?? ''}，${evt.delaySeconds ?? '?'}s 后）`));
        break;
      case 'llm_waiting':
        this.status.setStatus(`等待 LLM… ${evt.elapsedSeconds ?? 0}s`, this.atLineStart);
        break;
      case 'llm_stream_reset':
        this.segmentRaw = '';
        break;
      case 'error':
        this.flushAssistantMarkdown();
        this.writeln(this.ansi.red(`${this.symbols.err} ${evt.message}`));
        break;
      case 'session_already_running':
        this.writeln(this.ansi.yellow('该会话仍在执行，已放弃本次发送（可 /cancel 后重试）'));
        break;
      case 'reconnected':
        this.writeln(this.ansi.yellow(`${this.symbols.warn} 连接中断已恢复，可能丢失部分输出`));
        break;
      case 'context_window':
        this.contextPct = formatContextPercent(evt.estimated, evt.actual, this.contextWindowTokens);
        this.status.nudge(this.atLineStart);
        break;
      case 'side_session_created':
        this.writeln(this.ansi.dim(`（已创建 Side Task #${evt.sideSessionId}${evt.title ? `: ${evt.title}` : ''}，本 CLI 不 attach）`));
        break;
      case 'subagent_session_created':
        this.writeln(this.ansi.dim(`（已创建子代理会话 #${evt.childSessionId}${evt.title ? `: ${evt.title}` : ''}，本 CLI 不 attach）`));
        break;
      default:
        break;
    }
  }

  finish(result: RunResult): void {
    this.flushAssistantMarkdown();
    this.lastRoundText = this.roundText || result.result || '';
    this.status.stop();
    if (!this.atLineStart) {
      this.stdout.write('\n');
      this.atLineStart = true;
    }
    if (result.fileChanges.length > 0) {
      const add = result.fileChanges.reduce((s, f) => s + f.linesAdded, 0);
      const del = result.fileChanges.reduce((s, f) => s + f.linesDeleted, 0);
      this.stdout.write(this.ansi.dim(`${result.fileChanges.length} files changed: +${add} -${del}`) + '\n');
    }
    const sec = Math.round(result.durationMs / 1000);
    const ctx = this.contextPct ? `  Context: ${this.contextPct}` : '';
    const tools = result.toolCalls.length > 0 ? `  ${result.toolCalls.length} tool${result.toolCalls.length > 1 ? 's' : ''}` : '';
    const todo = formatTodoSummary(this.todos);
    const todoBit = todo ? `  ${todo}` : '';
    const label =
      result.status === 'COMPLETED' ? `${this.symbols.ok} 完成`
        : result.status === 'CANCELLED' ? `${this.symbols.warn} 已取消`
          : `${this.symbols.err} ${result.status}`;
    this.stderr.write(this.ansi.dim(`  ${label} · ${this.agentName}  ${this.modelName}  ${this.executionMode}${ctx}${todoBit}${tools}  ${sec}s`) + '\n');
  }

  clearTransient(): void {
    this.status.stop();
  }

  private flushAssistantMarkdown(): void {
    const raw = this.segmentRaw;
    this.segmentRaw = '';
    if (!raw || !this.ansi.enabled) return;
    const cols = this.columns();
    if (cols < 20) return;
    const rendered = renderMarkdownLite(raw, this.ansi);
    if (rendered === raw) return;
    if (countVisualRows(rendered, cols) !== countVisualRows(raw, cols)) return;
    const rewind = countRewindRows(raw, cols);
    this.status.beforeWrite();
    if (rewind > 0) this.stdout.write(`\x1b[${rewind}A`);
    this.stdout.write('\r');
    const lines = rendered.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const last = i === lines.length - 1;
      if (last && lines[i] === '' && rendered.endsWith('\n')) {
        this.stdout.write('\x1b[2K\n');
        break;
      }
      this.stdout.write(`\x1b[2K${lines[i]}`);
      if (!last) this.stdout.write('\n');
      else if (rendered.endsWith('\n')) this.stdout.write('\n');
    }
    this.atLineStart = rendered.endsWith('\n') || raw.endsWith('\n');
    this.status.afterWrite(this.atLineStart);
  }

  private metaBits(): string {
    const ctx = this.contextPct ? `  Context: ${this.contextPct}` : '';
    const todo = formatTodoSummary(this.todos);
    const todoBit = todo ? `  ${todo}` : '';
    return `Agent: ${this.agentName}  Model: ${this.modelName}  ${this.executionMode}${ctx}${todoBit}`;
  }

  private write(s: string): void {
    this.status.beforeWrite();
    this.stdout.write(s);
    this.atLineStart = s.endsWith('\n');
    this.status.afterWrite(this.atLineStart);
  }

  private writeln(s: string): void {
    this.flushAssistantMarkdown();
    this.status.beforeWrite();
    if (!this.atLineStart) this.stdout.write('\n');
    this.stdout.write(s + (s.endsWith('\n') ? '' : '\n'));
    this.atLineStart = true;
    this.status.afterWrite(true);
  }
}
