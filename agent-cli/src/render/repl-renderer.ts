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
import { Composer } from '../ui/composer';
import { formatToolResult, formatToolStart, formatUserBlock, summarizeToolArgs } from '../ui/box';
import { truncateToWidth } from '../ui/width';
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
  private readonly composer: Composer | null = null;
  private readonly columns: () => number;
  private readonly asciiOnly: boolean;
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
    this.asciiOnly = Boolean(opts.asciiOnly);
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
      columns: this.columns,
    });
    if (useStatusBar) {
      this.composer = new Composer({
        write: (s) => this.stdout.write(s),
        rows: opts.rows ?? (() => process.stdout.rows || process.stderr.rows || 0),
        columns: this.columns,
        dim: (s) => this.ansi.dim(s),
        cyan: (s) => this.ansi.cyan(s),
        frames: this.symbols.spin,
        ascii: this.asciiOnly,
        getMeta: () => this.metaBits(),
      });
    }
  }

  getComposer(): Composer | null {
    return this.composer;
  }

  /** 顶栏写进备用屏后锁定滚动区，对话不会顶掉身份行，也不会和 bash PS1 叠在一起。 */
  printHeader(lines: string[]): void {
    const cols = Math.max(20, this.columns() || 80);
    const painted = lines.map((l) => this.ansi.dim(truncateToWidth(l, cols)));
    if (this.usingComposer) {
      for (const l of painted) this.stdout.write(`\r\x1b[2K${l}\n`);
      this.composer!.sealHeader(painted.length);
      this.atLineStart = true;
      return;
    }
    for (const l of painted) this.announce(l);
  }

  private get usingComposer(): boolean {
    return Boolean(this.composer?.isActive());
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
    if (this.usingComposer) this.composer!.setDraft(draft);
    else this.status.setDraft(draft, this.atLineStart);
  }

  /** 往 stderr 打持久提示：先清状态行，避免和 spinner 粘在同一行。 */
  announce(message: string): void {
    const line = message.endsWith('\n') ? message : `${message}\n`;
    if (this.usingComposer) {
      if (!this.atLineStart) {
        this.stdout.write('\n');
        this.atLineStart = true;
      }
      this.writeCleared(line);
      return;
    }
    this.status.hide();
    if (!this.atLineStart) {
      this.stderr.write('\n');
      this.atLineStart = true;
    }
    this.stderr.write(line);
    if (this.status.hasText()) this.status.render(true);
  }

  getLastAssistantText(): string {
    return this.lastRoundText;
  }

  noteUser(text: string): void {
    const card = formatUserBlock(text, {
      cols: this.columns() || 80,
      paint: (s) => this.ansi.bgBlock(s),
    });
    this.writeln(card);
    this.writeln('');
  }

  startRound(): void {
    this.seenTools.clear();
    this.atLineStart = true;
    this.segmentRaw = '';
    this.roundText = '';
    if (this.usingComposer) {
      this.composer!.setRunning('思考中…');
      return;
    }
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
        else this.setFooterStatus('思考中…');
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
        const args = summarizeToolArgs(evt.arguments);
        const shown = this.verboseTools ? truncate(args, 200, 1) : truncate(args, 72, 1);
        this.writeln(formatToolStart(evt.toolName, shown, { ascii: this.asciiOnly, paint: (s) => this.ansi.cyan(s) }));
        this.setFooterStatus(`运行 ${evt.toolName}…`);
        break;
      }
      case 'tool_call_result': {
        const summary = evt.summary || evt.preview || '';
        if (this.verboseTools) {
          const extra = summary ? truncate(summary, 2000, 20) : (evt.status || 'ok');
          for (const line of extra.split('\n')) {
            this.writeln(this.ansi.dim(`    ${this.symbols.toolTail}  ${line}`));
          }
        } else {
          const extra = summary ? truncate(summary.replace(/\s+/g, ' '), 100, 1) : (evt.status || 'ok');
          this.writeln(formatToolResult(extra, { ascii: this.asciiOnly, paint: (s) => this.ansi.dim(s) }));
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
        this.nudgeFooter();
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
        this.setFooterStatus(`等待 LLM… ${evt.elapsedSeconds ?? 0}s`);
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
        this.nudgeFooter();
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
    const fallback = (result.result || '').trim();
    if (!this.roundText.trim() && fallback) {
      this.write(fallback.endsWith('\n') ? fallback : `${fallback}\n`);
      this.roundText = fallback;
    }
    this.lastRoundText = this.roundText || result.result || '';
    this.status.stop();
    if (this.usingComposer) this.composer!.setIdle('');
    if (!this.atLineStart) {
      this.stdout.write('\n');
      this.atLineStart = true;
    }
    if (!this.roundText.trim() && result.toolCalls.length === 0 && result.fileChanges.length === 0) {
      this.stdout.write(this.ansi.dim('(无文本回复)') + '\n');
    }
    if (result.fileChanges.length > 0) {
      const add = result.fileChanges.reduce((s, f) => s + f.linesAdded, 0);
      const del = result.fileChanges.reduce((s, f) => s + f.linesDeleted, 0);
      this.stdout.write(this.ansi.dim(`  ${result.fileChanges.length} files  +${add}  -${del}`) + '\n');
    }
    const sec = Math.round(result.durationMs / 1000);
    const ctx = this.contextPct ? ` · ${this.contextPct}` : '';
    const tools = result.toolCalls.length > 0 ? ` · ${result.toolCalls.length} tool${result.toolCalls.length > 1 ? 's' : ''}` : '';
    const todo = formatTodoSummary(this.todos);
    const todoBit = todo ? ` · ${todo}` : '';
    const label =
      result.status === 'COMPLETED' ? `${this.symbols.ok}`
        : result.status === 'CANCELLED' ? `${this.symbols.warn} 已取消`
          : `${this.symbols.err} ${result.status}`;
    const footer = this.ansi.dim(`  ${label}  ${sec}s${ctx}${todoBit}${tools}`) + '\n';
    if (this.usingComposer) this.stdout.write(footer);
    else this.stderr.write(footer);
  }

  clearTransient(): void {
    this.status.stop();
    if (this.usingComposer) this.composer!.setIdle('');
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
    if (!this.usingComposer) this.status.beforeWrite();
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
    if (!this.usingComposer) this.status.afterWrite(this.atLineStart);
  }

  private setFooterStatus(text: string): void {
    if (this.usingComposer) this.composer!.setRunning(text);
    else this.status.setStatus(text, this.atLineStart);
  }

  private nudgeFooter(): void {
    if (this.usingComposer) this.composer!.refresh();
    else this.status.nudge(this.atLineStart);
  }

  private metaBits(): string {
    const ctx = this.contextPct ? ` · ${this.contextPct}` : '';
    const todo = formatTodoSummary(this.todos);
    const todoBit = todo ? ` · ${todo}` : '';
    return `${this.agentName} · ${this.modelName} · ${this.executionMode}${ctx}${todoBit}`;
  }

  private write(s: string): void {
    if (!this.usingComposer) this.status.beforeWrite();
    if (this.usingComposer) this.writeCleared(s);
    else {
      this.stdout.write(s);
      this.atLineStart = s.endsWith('\n');
    }
    if (!this.usingComposer) this.status.afterWrite(this.atLineStart);
  }

  private writeln(s: string): void {
    this.flushAssistantMarkdown();
    if (!this.usingComposer) this.status.beforeWrite();
    if (!this.atLineStart) {
      this.stdout.write('\n');
      this.atLineStart = true;
    }
    if (this.usingComposer) this.writeCleared(s.endsWith('\n') ? s : `${s}\n`);
    else this.stdout.write(s.endsWith('\n') ? s : `${s}\n`);
    this.atLineStart = true;
    if (!this.usingComposer) this.status.afterWrite(true);
  }

  /** 每行开头先清残影，避免主缓冲里的 bash 提示符粘在对话上。 */
  private writeCleared(s: string): void {
    const parts = s.split('\n');
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const last = i === parts.length - 1;
      if (this.atLineStart && part) this.stdout.write('\r\x1b[2K');
      this.stdout.write(part);
      if (!last) {
        this.stdout.write('\n');
        this.atLineStart = true;
      } else {
        this.atLineStart = s.endsWith('\n');
      }
    }
  }
}
