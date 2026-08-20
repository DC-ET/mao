import { createAnsi, renderMarkdownLite, shouldUseColor, truncate, type Ansi } from '../util/ansi';
import { DEFAULT_CONTEXT_WINDOW_TOKENS, formatContextPercent } from '../util/context';
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
  stdout?: { write: (s: string) => void };
  stderr?: { write: (s: string) => void };
}

export class ReplRenderer implements Renderer {
  private readonly ansi: Ansi;
  private readonly thinking: boolean;
  private readonly useStatusBar: boolean;
  private readonly stdout: { write: (s: string) => void };
  private readonly stderr: { write: (s: string) => void };
  private seenTools = new Set<string>();
  private agentName: string;
  private modelName: string;
  private executionMode: string;
  private contextWindowTokens: number;
  private contextPct?: string;
  private startedAt = Date.now();
  private spinnerTimer: ReturnType<typeof setInterval> | null = null;
  private spinnerFrame = 0;
  private status = '';
  private atLineStart = true;
  private statusVisible = false;
  private readonly frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

  constructor(opts: ReplRendererOptions) {
    const color = shouldUseColor({ colorFlag: opts.colorFlag, printMode: false, stdoutIsTty: opts.stdoutIsTty });
    this.ansi = createAnsi(color && !opts.printMode);
    this.thinking = opts.thinking;
    this.useStatusBar = opts.stdoutIsTty && !opts.printMode;
    this.stdout = opts.stdout ?? process.stdout;
    this.stderr = opts.stderr ?? process.stderr;
    this.agentName = opts.agentName ?? 'Agent';
    this.modelName = opts.modelName ?? 'model';
    this.executionMode = opts.executionMode ?? 'CLOUD';
    this.contextWindowTokens = opts.contextWindowTokens ?? DEFAULT_CONTEXT_WINDOW_TOKENS;
  }

  setMeta(meta: { agentName?: string; modelName?: string; executionMode?: string; contextWindowTokens?: number }): void {
    if (meta.agentName) this.agentName = meta.agentName;
    if (meta.modelName) this.modelName = meta.modelName;
    if (meta.executionMode) this.executionMode = meta.executionMode;
    if (meta.contextWindowTokens && meta.contextWindowTokens > 0) this.contextWindowTokens = meta.contextWindowTokens;
  }

  startRound(): void {
    this.seenTools.clear();
    this.startedAt = Date.now();
    this.atLineStart = true;
    this.setStatus('思考中…');
  }

  onEvent(evt: CliEvent): void {
    switch (evt.type) {
      case 'content_delta':
        this.write(renderMarkdownLite(evt.delta, this.ansi));
        break;
      case 'thinking_start':
        if (this.thinking) this.writeln(this.ansi.dim('💭 思考'));
        else this.setStatus('💭 思考中…');
        break;
      case 'thinking_delta':
        if (this.thinking) this.write(this.ansi.dim(evt.delta));
        break;
      case 'thinking_end':
        if (this.thinking && !this.atLineStart) this.write('\n');
        break;
      case 'tool_call_start': {
        if (this.seenTools.has(evt.toolCallId)) break;
        this.seenTools.add(evt.toolCallId);
        const args = evt.arguments ? truncate(evt.arguments, 200, 3).replace(/\s+/g, ' ') : '';
        this.writeln(this.ansi.cyan(`▸ ${evt.toolName}  ${args}`));
        this.setStatus(`运行 ${evt.toolName}…`);
        break;
      }
      case 'tool_call_result': {
        const summary = evt.summary || evt.preview || '';
        const extra = summary ? truncate(summary, 2000, 20) : `status=${evt.status}`;
        this.writeln(this.ansi.dim(`  ${extra}`));
        break;
      }
      case 'file_change': {
        const sign = `+${evt.linesAdded} -${evt.linesDeleted}`;
        this.writeln(this.ansi.green(`  ${sign} ${evt.path}`));
        break;
      }
      case 'compaction_start':
        this.writeln(this.ansi.yellow('⟳ 正在压缩上下文…'));
        break;
      case 'compaction_end':
        this.writeln(this.ansi.yellow(`✔ 上下文压缩完成（节省 ${evt.savedTokens ?? '?'} tokens，${evt.durationMs ?? '?'}ms）`));
        break;
      case 'llm_retry':
        this.writeln(this.ansi.yellow(`⟳ LLM 重试 ${evt.attempt ?? '?'}/${evt.maxRetries ?? '?'}（${evt.reason ?? ''}，${evt.delaySeconds ?? '?'}s 后）`));
        break;
      case 'llm_waiting':
        this.setStatus(`等待 LLM… ${evt.elapsedSeconds ?? 0}s`);
        break;
      case 'error':
        this.writeln(this.ansi.red(`✖ ${evt.message}`));
        break;
      case 'session_already_running':
        this.writeln(this.ansi.yellow('该会话仍在执行，已放弃本次发送（可 /cancel 后重试）'));
        break;
      case 'reconnected':
        this.writeln(this.ansi.yellow('⚠ 连接中断已恢复，可能丢失部分输出'));
        break;
      case 'context_window':
        this.contextPct = formatContextPercent(evt.estimated, evt.actual, this.contextWindowTokens);
        if (this.atLineStart) this.redrawStatus();
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
    this.stopSpinnerTimer();
    this.hideStatus();
    if (!this.atLineStart) {
      this.stdout.write('\n');
      this.atLineStart = true;
    }
    if (result.fileChanges.length > 0) {
      const add = result.fileChanges.reduce((s, f) => s + f.linesAdded, 0);
      const del = result.fileChanges.reduce((s, f) => s + f.linesDeleted, 0);
      this.stdout.write(this.ansi.dim(`${result.fileChanges.length} files changed: +${add} -${del}`) + '\n');
    }
    const sec = Math.round((Date.now() - this.startedAt) / 1000);
    const ctx = this.contextPct ? `  Context: ${this.contextPct}` : '';
    this.stderr.write(this.ansi.dim(`  Agent: ${this.agentName}  Model: ${this.modelName}  ${this.executionMode}${ctx}  ${sec}s`) + '\n');
  }

  clearTransient(): void {
    this.stopSpinnerTimer();
    this.hideStatus();
  }

  private setStatus(text: string): void {
    this.status = text;
    if (!this.useStatusBar) return;
    if (!this.atLineStart) return;
    if (!this.spinnerTimer) {
      this.spinnerTimer = setInterval(() => {
        this.spinnerFrame = (this.spinnerFrame + 1) % this.frames.length;
        this.redrawStatus();
      }, 80);
    }
    this.redrawStatus();
  }

  private stopSpinnerTimer(): void {
    if (this.spinnerTimer) {
      clearInterval(this.spinnerTimer);
      this.spinnerTimer = null;
    }
  }

  private hideStatus(): void {
    if (this.statusVisible && this.atLineStart) {
      this.stderr.write(this.ansi.clearLine || '\r\x1b[K');
    }
    this.statusVisible = false;
  }

  private redrawStatus(): void {
    if (!this.useStatusBar || !this.atLineStart) return;
    const sec = Math.round((Date.now() - this.startedAt) / 1000);
    const spin = `${this.frames[this.spinnerFrame]} `;
    const ctx = this.contextPct ? `  Context: ${this.contextPct}` : '';
    const line = `${spin}Agent: ${this.agentName}  Model: ${this.modelName}  ${this.executionMode}${ctx}  ${sec}s  ${this.status}`;
    this.stderr.write((this.ansi.clearLine || '\r\x1b[K') + this.ansi.dim(line));
    this.statusVisible = true;
  }

  private write(s: string): void {
    this.stopSpinnerTimer();
    this.hideStatus();
    this.stdout.write(s);
    this.atLineStart = s.endsWith('\n');
  }

  private writeln(s: string): void {
    this.stopSpinnerTimer();
    this.hideStatus();
    if (!this.atLineStart) this.stdout.write('\n');
    this.stdout.write(s + (s.endsWith('\n') ? '' : '\n'));
    this.atLineStart = true;
  }
}
