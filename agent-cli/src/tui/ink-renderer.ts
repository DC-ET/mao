import type { CliEvent, RunResult, Renderer } from '../render/types';
import type { StaticRound, ToolCallDisplay, ModalState, InkTuiHandle, FooterMeta, TuiAppProps, TranscriptItem } from './types';
import type { AskAnswer } from '../ws/event-types';
import { createAnsi, shouldUseColor, truncate } from '../util/ansi';
import { pickSymbols, type UiSymbols } from '../ui/symbols';
import { formatTodoSummary } from '../ui/todo-summary';
import { formatContextPercent } from '../util/context';
import { randomUUID } from '../util/uuid';

export interface InputHandlers {
  onSubmit: (text: string) => void;
  onCancel: () => void;
  onExit: () => void;
  onAskResponse: (requestId: string, answers: AskAnswer[] | 'fail' | 'cancelled') => void;
  onApprovalResponse: (choice: 'allow' | 'deny' | 'always') => void;
}

/** 输入区上方最多保留的实时提示行数。 */
const ANNOUNCE_MAX = 8;

/**
 * Manages Ink TUI state and implements the Renderer interface.
 * Bridges CliEvent → Ink component props.
 */
export class InkTuiRenderer implements Renderer {
  private ansi: ReturnType<typeof createAnsi>;
  private symbols: UiSymbols;
  private verboseToolsFlag = false;
  private asciiOnly: boolean;
  private agentName: string;
  private modelName: string;
  private executionMode: string;
  private contextWindowTokens: number;
  private contextPct?: string;
  private todos: import('../ws/event-types').TodoItem[] = [];
  private seenTools = new Set<string>();
  private segmentRaw = '';
  private roundText = '';
  private lastRoundText = '';
  private staticRounds: StaticRound[] = [];
  private liveToolCalls: ToolCallDisplay[] = [];
  private liveError?: string;
  private liveWarnings: string[] = [];
  private liveRunning = false;
  private liveStatus = '';
  private spinnerFrame = 0;
  private spinnerTimer: ReturnType<typeof setInterval> | null = null;
  private announceBuffer: string[] = [];
  /** 实时渲染在输入区上方的即时提示（/help、/cancel 确认、排队提示等）。 */
  private liveAnnounce: string[] = [];
  private pendingUser = '';
  private draft = '';
  private continuation = false;
  private modal: ModalState = null;
  private handle: { update: (patch: Partial<TuiAppProps>) => void; unmount: () => void } | null = null;
  private welcomeLines: string[] = [];
  private historyLines: string[] = [];
  private inputHandlers: InputHandlers = {
    onSubmit: () => {},
    onCancel: () => {},
    onExit: () => {},
    // 默认实现直接 resolve 内部 promise，保证 attach 期间（setInputHandlers 尚未调用）
    // 触发 ask/approval modal 时也能正常闭环。
    onAskResponse: (requestId, answers) => {
      this.modal = null;
      this.resolveAsk(requestId, answers);
    },
    onApprovalResponse: (choice) => {
      this.modal = null;
      this.resolveApproval(choice);
    },
  };
  private modelNames: string[] = [];
  private askResolvers = new Map<string, (answers: import('../ws/event-types').AskAnswer[] | 'fail' | 'cancelled') => void>();
  private approvalResolver: ((choice: 'allow' | 'deny' | 'always') => void) | null = null;

  constructor(opts: {
    asciiOnly?: boolean;
    agentName?: string;
    modelName?: string;
    executionMode?: string;
    contextWindowTokens?: number;
    verboseTools?: boolean;
    welcomeLines?: string[];
    historyLines?: string[];
    modelNames?: string[];
  }) {
    this.asciiOnly = Boolean(opts.asciiOnly);
    this.verboseToolsFlag = Boolean(opts.verboseTools);
    this.agentName = opts.agentName ?? 'Agent';
    this.modelName = opts.modelName ?? 'model';
    this.executionMode = opts.executionMode ?? 'CLOUD';
    this.contextWindowTokens = opts.contextWindowTokens ?? 256000;
    this.welcomeLines = opts.welcomeLines ?? [];
    this.historyLines = opts.historyLines ?? [];
    this.modelNames = opts.modelNames ?? [];
    const color = shouldUseColor({ colorFlag: undefined, printMode: false, stdoutIsTty: true });
    this.ansi = createAnsi(color);
    this.symbols = pickSymbols(this.asciiOnly);
  }

  /** Mount the Ink app and return the handle. */
  mount(): InkTuiHandle {
    const { createTuiApp } = require('./app') as typeof import('./app');
    this.staticRounds = this.seedChrome();
    const props = this.buildProps();
    this.handle = createTuiApp(props);
    this.startSpinner();
    return {
      pushStaticRound: (round: StaticRound) => {
        this.staticRounds = [...this.staticRounds, round];
        this.liveToolCalls = [];
        this.liveError = undefined;
        this.liveWarnings = [];
        this.liveRunning = false;
        this.liveStatus = '';
        this.segmentRaw = '';
        this.flush();
      },
      updateLive: (patch: Partial<import('./types').LiveState>) => {
        if (patch.segmentRaw !== undefined) this.segmentRaw = patch.segmentRaw;
        if (patch.running !== undefined) this.liveRunning = patch.running;
        if (patch.status !== undefined) this.liveStatus = patch.status;
        if (patch.error !== undefined) this.liveError = patch.error;
        if (patch.warnings !== undefined) this.liveWarnings = patch.warnings;
        if (patch.toolCalls !== undefined) this.liveToolCalls = patch.toolCalls;
        if (patch.todos !== undefined) this.todos = patch.todos;
        if (patch.contextPct !== undefined) this.contextPct = patch.contextPct;
        if (patch.spinnerFrame !== undefined) this.spinnerFrame = patch.spinnerFrame;
        this.flush();
      },
      setDraft: (draft: string) => {
        this.draft = draft;
        this.flush();
      },
      setContinuation: (on: boolean) => {
        this.continuation = on;
        this.flush();
      },
      setMeta: (meta: string) => {
        this.announceBuffer.push(meta);
        this.flush();
      },
      setModal: (modal: ModalState) => {
        this.modal = modal;
        this.flush();
      },
      setVerboseTools: (on: boolean) => {
        this.verboseToolsFlag = on;
        this.flush();
      },
      pushHistoryLine: (line: string) => {
        this.historyLines = [...this.historyLines, line];
        this.flush();
      },
      clearAll: () => {
        // 真实清屏：清终端 + 重置内部状态（Ink 下一帧会重绘欢迎区）
        process.stdout.write('\x1b[2J\x1b[H');
        this.staticRounds = this.seedChrome(true);
        this.historyLines = [];
        this.liveToolCalls = [];
        this.liveError = undefined;
        this.liveWarnings = [];
        this.liveAnnounce = [];
        this.pendingUser = '';
        this.liveRunning = false;
        this.liveStatus = '';
        this.segmentRaw = '';
        this.announceBuffer = [];
        this.flush();
      },
      unmount: () => {
        this.stopSpinner();
        this.handle?.unmount();
        this.handle = null;
      },
    };
  }

  private buildProps(): TuiAppProps {
    return {
      staticRounds: this.staticRounds,
      live: {
        running: this.liveRunning,
        status: this.liveStatus,
        segmentRaw: this.segmentRaw,
        toolCalls: this.liveToolCalls,
        error: this.liveError,
        warnings: this.liveWarnings,
        announce: this.liveAnnounce,
        userText: this.pendingUser || undefined,
        todos: this.todos,
        contextPct: this.contextPct,
        spinnerFrame: this.spinnerFrame,
      },
      modal: this.modal,
      draft: this.draft,
      continuation: this.continuation,
      footer: this.footerMeta(),
      verboseTools: this.verboseToolsFlag,
      historyLines: this.historyLines,
      welcomeLines: this.welcomeLines,
      asciiOnly: this.asciiOnly,
      modelNames: this.modelNames,
      onSubmit: this.inputHandlers.onSubmit,
      onCancel: this.inputHandlers.onCancel,
      onExit: this.inputHandlers.onExit,
      onAskResponse: this.inputHandlers.onAskResponse,
      onApprovalResponse: this.inputHandlers.onApprovalResponse,
      onSlashClear: () => {},
    };
  }

  setInputHandlers(handlers: InputHandlers): void {
    this.inputHandlers = handlers;
    this.flush();
  }

  setAskResolver(requestId: string, resolve: (answers: import('../ws/event-types').AskAnswer[] | 'fail' | 'cancelled') => void): void {
    this.askResolvers.set(requestId, resolve);
  }

  resolveAsk(requestId: string, answers: import('../ws/event-types').AskAnswer[] | 'fail' | 'cancelled'): void {
    const resolve = this.askResolvers.get(requestId);
    if (resolve) {
      this.askResolvers.delete(requestId);
      resolve(answers);
    }
  }

  /** LOCAL 审批：显示 approval modal 并等待用户选择。 */
  requestApproval(req: { toolName: string; description: string; dangerReason?: string | null; workspace?: string }, reason: string): Promise<'allow' | 'deny' | 'always'> {
    return new Promise((resolve) => {
      // 单槽 modal：若已有 ask modal 打开，先以空答案提交（而非静默 cancelled），
      // 让服务端结束问答继续执行，避免 waitForAnswer 长时间阻塞
      if (this.modal?.type === 'ask') {
        this.resolveAsk(this.modal.requestId, []);
      }
      this.approvalResolver = resolve;
      this.modal = { type: 'approval', request: req, reason };
      this.flush();
    });
  }

  resolveApproval(choice: 'allow' | 'deny' | 'always'): void {
    this.modal = null;
    this.flush();
    const resolve = this.approvalResolver;
    this.approvalResolver = null;
    if (resolve) resolve(choice);
  }

  hasModal(): boolean {
    return this.modal !== null;
  }

  setHistoryLines(lines: string[]): void {
    this.historyLines = [...lines];
    if (lines.length === 0) {
      this.flush();
      return;
    }
    const without = this.staticRounds.filter((r) => r.id !== 'history' && !r.id.startsWith('history-'));
    const welcomeIdx = without.findIndex((r) => r.id === 'welcome' || r.id.startsWith('welcome-'));
    const historyRound = { id: `history-${Date.now()}`, items: [{ kind: 'history' as const, lines }] };
    const next = [...without];
    next.splice(Math.max(welcomeIdx + 1, 0), 0, historyRound);
    this.staticRounds = next;
    this.flush();
  }

  private seedChrome(freshId = false): StaticRound[] {
    const id = freshId ? `welcome-${Date.now()}` : 'welcome';
    return [{ id, items: [{ kind: 'welcome', lines: this.welcomeLines }] }];
  }

  private footerMeta(): FooterMeta {
    return {
      agentName: this.agentName,
      modelName: this.modelName,
      executionMode: this.executionMode,
      contextPct: this.contextPct,
      todo: formatTodoSummary(this.todos),
    };
  }

  private flush(): void {
    if (!this.handle) return;
    this.handle.update(this.buildProps());
  }

  private startSpinner(): void {
    if (this.spinnerTimer) return;
    this.spinnerTimer = setInterval(() => {
      this.spinnerFrame = (this.spinnerFrame + 1) % this.symbols.spin.length;
      if (this.liveRunning) this.flush();
    }, 80);
  }

  private stopSpinner(): void {
    if (this.spinnerTimer) {
      clearInterval(this.spinnerTimer);
      this.spinnerTimer = null;
    }
  }

  // === Renderer interface ===

  onEvent(evt: CliEvent): void {
    switch (evt.type) {
      case 'content_delta':
        this.segmentRaw += evt.delta;
        this.roundText += evt.delta;
        this.liveRunning = true;
        this.liveStatus = '思考中…';
        this.flush();
        break;
      case 'thinking_start':
        this.liveRunning = true;
        this.liveStatus = '思考中…';
        this.flush();
        break;
      case 'thinking_delta':
        break;
      case 'thinking_end':
        break;
      case 'tool_call_start': {
        if (this.seenTools.has(evt.toolCallId)) break;
        this.seenTools.add(evt.toolCallId);
        const tc: ToolCallDisplay = {
          toolCallId: evt.toolCallId,
          toolName: evt.toolName,
          arguments: evt.arguments,
          status: 'RUNNING',
        };
        this.liveToolCalls = [...this.liveToolCalls, tc];
        this.liveRunning = true;
        this.liveStatus = `运行 ${evt.toolName}…`;
        this.segmentRaw = '';
        this.flush();
        break;
      }
      case 'tool_call_result': {
        this.liveToolCalls = this.liveToolCalls.map((tc) =>
          tc.toolCallId === evt.toolCallId
            ? {
                ...tc,
                status: evt.status,
                result: evt.result,
                preview: evt.preview,
                summary: evt.summary,
              }
            : tc,
        );
        this.flush();
        break;
      }
      case 'file_change': {
        const sign = `+${evt.linesAdded} -${evt.linesDeleted}`;
        this.liveWarnings = [...this.liveWarnings, this.ansi.green(`  ${sign} ${evt.path}`)];
        this.flush();
        break;
      }
      case 'todo_updated':
        this.todos = evt.todos ?? [];
        this.flush();
        break;
      case 'compaction_start':
        this.liveWarnings = [...this.liveWarnings, this.ansi.yellow(`${this.symbols.spin[0]} 正在压缩上下文…`)];
        this.flush();
        break;
      case 'compaction_end':
        this.liveWarnings = [...this.liveWarnings, this.ansi.yellow(`${this.symbols.ok} 上下文压缩完成（节省 ${evt.savedTokens ?? '?'} tokens，${evt.durationMs ?? '?'}ms）`)];
        this.flush();
        break;
      case 'llm_retry':
        this.liveWarnings = [...this.liveWarnings, this.ansi.yellow(`${this.symbols.spin[0]} LLM 重试 ${evt.attempt ?? '?'}/${evt.maxRetries ?? '?'}（${evt.reason ?? ''}，${evt.delaySeconds ?? '?'}s 后）`)];
        this.flush();
        break;
      case 'llm_waiting':
        this.liveStatus = `等待 LLM… ${evt.elapsedSeconds ?? 0}s`;
        this.flush();
        break;
      case 'llm_stream_reset':
        this.segmentRaw = '';
        this.roundText = '';
        this.flush();
        break;
      case 'error':
        this.liveError = evt.message;
        this.flush();
        break;
      case 'session_already_running':
        this.liveWarnings = [...this.liveWarnings, this.ansi.yellow('该会话仍在执行，已放弃本次发送（可 /cancel 后重试）')];
        this.flush();
        break;
      case 'reconnected':
        this.liveWarnings = [...this.liveWarnings, this.ansi.yellow(`${this.symbols.warn} 连接中断已恢复，可能丢失部分输出`)];
        this.flush();
        break;
      case 'context_window':
        this.contextPct = formatContextPercent(evt.estimated, evt.actual, this.contextWindowTokens);
        this.flush();
        break;
      case 'side_session_created':
        this.liveWarnings = [...this.liveWarnings, this.ansi.dim(`（已创建 Side Task #${evt.sideSessionId}${evt.title ? `: ${evt.title}` : ''}，本 CLI 不 attach）`)];
        this.flush();
        break;
      case 'subagent_session_created':
        this.liveWarnings = [...this.liveWarnings, this.ansi.dim(`（已创建子代理会话 #${evt.childSessionId}${evt.title ? `: ${evt.title}` : ''}，本 CLI 不 attach）`)];
        this.flush();
        break;
      case 'ask_user_questions':
        // 单槽 modal：
        // - approval 打开时先按 deny 收尾其 resolver（拒绝未决审批）
        // - 旧 ask（不同 requestId）打开时先以空答案提交，避免 resolver 泄漏
        if (this.modal?.type === 'approval') {
          this.resolveApproval('deny');
        } else if (this.modal?.type === 'ask' && this.modal.requestId !== evt.requestId) {
          this.resolveAsk(this.modal.requestId, []);
        }
        this.modal = { type: 'ask', requestId: evt.requestId, questions: evt.questions };
        this.flush();
        break;
      case 'ask_user_questions_cancelled':
        // 服务端在每次问答应答后都会回发 cancelled 作为确认（断线重连也会重放）。
        // 仅当当前 modal 是该 requestId 的 ask 时才关闭，避免误关 approval modal 泄漏 resolver。
        if (this.modal?.type === 'ask' && this.modal.requestId === evt.requestId) {
          this.modal = null;
          // 以 'cancelled' 区分「服务端取消」与「用户 fail」，
          // handleQuestions 对 cancelled 静默收尾（不置 questionFailedFlag、不发 cancel）
          this.resolveAsk(evt.requestId, 'cancelled');
        }
        this.flush();
        break;
      default:
        break;
    }
  }

  finish(result: RunResult): void {
    const items: TranscriptItem[] = [];

    if (this.pendingUser) {
      items.push({ kind: 'user', text: this.pendingUser });
    }
    this.pendingUser = '';

    for (const line of this.announceBuffer) {
      if (line) items.push({ kind: 'sys', text: line });
    }
    this.announceBuffer = [];

    for (const tc of result.toolCalls) {
      const summary = tc.result ?? '';
      const extra = this.verboseToolsFlag
        ? (summary ? truncate(summary, 2000, 20) : (tc.status || 'ok'))
        : (summary ? truncate(summary.replace(/\s+/g, ' '), 100, 1) : (tc.status || 'ok'));
      items.push({ kind: 'tool', name: tc.toolName, args: tc.arguments, result: extra });
    }

    const fallback = (result.result || '').trim();
    const text = this.roundText || fallback;
    if (text) {
      items.push({ kind: 'assistant', text });
    } else if (result.toolCalls.length === 0 && result.fileChanges.length === 0) {
      items.push({ kind: 'sys', text: '(无文本回复)' });
    }

    if (result.fileChanges.length > 0) {
      const add = result.fileChanges.reduce((s, f) => s + f.linesAdded, 0);
      const del = result.fileChanges.reduce((s, f) => s + f.linesDeleted, 0);
      items.push({ kind: 'sys', text: `  ${result.fileChanges.length} files  +${add}  -${del}` });
    }

    const sec = Math.round(result.durationMs / 1000);
    const ctx = this.contextPct ? ` · ${this.contextPct}` : '';
    const todo = formatTodoSummary(this.todos);
    const todoBit = todo ? ` · ${todo}` : '';
    const tools = result.toolCalls.length > 0 ? ` · ${result.toolCalls.length} tool${result.toolCalls.length > 1 ? 's' : ''}` : '';
    const tone: 'ok' | 'err' | 'warn' =
      result.status === 'COMPLETED' ? 'ok'
        : result.status === 'CANCELLED' ? 'warn'
          : 'err';
    const label =
      result.status === 'COMPLETED' ? `${this.symbols.ok}`
        : result.status === 'CANCELLED' ? `${this.symbols.warn} 已取消`
          : `${this.symbols.err} ${result.status}`;
    items.push({ kind: 'status', text: `  ${label}  ${sec}s${ctx}${todoBit}${tools}`, tone });

    const round: StaticRound = { id: result.executionId || randomUUID(), items };
    this.staticRounds = [...this.staticRounds, round];
    this.lastRoundText = this.roundText || result.result || '';

    this.liveRunning = false;
    this.liveStatus = '';
    this.segmentRaw = '';
    this.roundText = '';
    this.liveToolCalls = [];
    this.liveError = undefined;
    this.liveWarnings = [];
    this.liveAnnounce = [];
    this.seenTools.clear();

    this.flush();
  }

  clearTransient(): void {
    this.liveRunning = false;
    this.liveStatus = '';
    this.liveError = undefined;
    this.liveWarnings = [];
    this.flush();
  }

  // === Compatibility methods for REPL ===

  getLastAssistantText(): string {
    return this.lastRoundText;
  }

  getVerboseTools(): boolean {
    return this.verboseToolsFlag;
  }

  setVerboseTools(on: boolean): void {
    this.verboseToolsFlag = on;
    this.flush();
  }

  setMeta(meta: { agentName?: string; modelName?: string; executionMode?: string; contextWindowTokens?: number }): void {
    if (meta.agentName) this.agentName = meta.agentName;
    if (meta.modelName) this.modelName = meta.modelName;
    if (meta.executionMode) this.executionMode = meta.executionMode;
    if (meta.contextWindowTokens && meta.contextWindowTokens > 0) this.contextWindowTokens = meta.contextWindowTokens;
    this.flush();
  }

  announce(message: string): void {
    this.announceBuffer.push(message);
    this.pushLiveAnnounce(message);
  }

  printHeader(lines: string[]): void {
    for (const line of lines) {
      this.announceBuffer.push(this.ansi.dim(line));
      this.pushLiveAnnounce(this.ansi.dim(line));
    }
  }

  noteUser(text: string): void {
    this.pendingUser = text;
    this.flush();
  }

  private pushLiveAnnounce(line: string): void {
    this.liveAnnounce.push(line);
    if (this.liveAnnounce.length > ANNOUNCE_MAX) {
      this.liveAnnounce.splice(0, this.liveAnnounce.length - ANNOUNCE_MAX);
    }
    this.flush();
  }

  startRound(): void {
    this.seenTools.clear();
    this.segmentRaw = '';
    this.roundText = '';
    this.liveRunning = true;
    this.liveStatus = '思考中…';
    this.liveToolCalls = [];
    this.liveError = undefined;
    this.liveWarnings = [];
    this.flush();
  }

  getComposer(): null {
    return null;
  }
}
