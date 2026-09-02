import type { CliEvent, RunResult, Renderer } from '../render/types';
import type { AskAnswer, AskQuestion, TodoItem } from '../ws/event-types';
import type {
  FooterMeta,
  LayoutBudget,
  LiveView,
  PanelLine,
  PanelView,
  StaticBlock,
  Tone,
  TranscriptItem,
  TuiAppProps,
  TuiHandle,
} from './types';
import { classifyMdLine, type MdLine } from './markdown-parse';
import { createTuiApp, type TuiMount } from './app';
import { allocateLive, computeBudget, tailRows, wrapByWidth } from './layout';
import { InputController } from './input-controller';
import { ApprovalController, AskController, type ApprovalChoice } from './modal-controller';
import { BRACKETED_PASTE_OFF, BRACKETED_PASTE_ON, KeyDecoder, type KeyEvent } from './keydecode';
import { pickSymbols, type UiSymbols } from '../ui/symbols';
import { formatTodoSummary } from '../ui/todo-summary';
import { formatContextPercent } from '../util/context';
import { randomUUID } from '../util/uuid';
import { summarizeToolArgs } from '../ui/tool-format';
import { truncateToWidth } from '../ui/width';
import { appendInputHistory, loadInputHistory } from '../config/input-history';
import type { ApprovalRequest } from './types';

export interface InputHandlers {
  onSubmit: (text: string) => void;
  /** Ctrl+C（草稿为空时）。 */
  onCancel: () => void;
  /** Esc（草稿为空、无补全面板时）。 */
  onEscape: () => void;
  /** Ctrl+D（草稿为空时）。 */
  onExit: () => void;
}

export interface InkTuiOptions {
  asciiOnly?: boolean;
  colorFlag?: boolean;
  thinking?: boolean;
  showTurnDividers?: boolean;
  agentName?: string;
  modelName?: string;
  executionMode?: string;
  contextWindowTokens?: number;
  verboseTools?: boolean;
  welcomeLines?: string[];
  modelNames?: string[];
  /** 测试注入：替换 stdout / stdin，避免真的动终端。 */
  stdout?: NodeJS.WriteStream;
  stdin?: NodeJS.ReadStream;
}

/** 渲染合帧窗口：把一串 content_delta 合并成一次 React 渲染。 */
const FRAME_MS = 24;
/** spinner / 计时器刷新间隔。80ms 太密，只是徒增重绘。 */
const TICK_MS = 150;
/** 滞留的 ESC 前缀多久后按「单独 Esc 键」结算：低于终端自身的 escape delay 会误判方向键。 */
const ESC_FLUSH_MS = 40;

type ModalEntry =
  | { kind: 'ask'; requestId: string; controller: AskController }
  | { kind: 'approval'; controller: ApprovalController };

/**
 * 交互式 TUI 渲染器。
 *
 * 关键设计：所有已定稿的内容按行写入 <Static>（写一次、永不重绘），
 * live 区（状态行 / 流式尾巴 / 运行中工具 / 提示 / 弹窗 / 输入框）在每帧前
 * 按终端行数裁剪，保证 Ink 计算出的非 static 树高度恒小于 stdout.rows，
 * 从而永不进入 Ink 的 clearTerminal 全屏重绘分支。
 */
export class InkTuiRenderer implements Renderer {
  private readonly symbols: UiSymbols;
  private readonly asciiOnly: boolean;
  private readonly colorFlag?: boolean;
  private thinkingEnabled: boolean;
  private readonly showTurnDividers: boolean;
  private readonly welcomeLines: string[];
  private readonly out: NodeJS.WriteStream;
  private readonly stdin: NodeJS.ReadStream;

  private agentName: string;
  private modelName: string;
  private executionMode: string;
  private contextWindowTokens: number;
  private verboseToolsFlag: boolean;
  private modelNames: string[];

  private staticBlocks: StaticBlock[] = [];
  private seeded = false;

  // 流式定稿状态
  private tail = '';
  private inFence = false;
  private thinkingTail = '';
  private roundText = '';
  private lastRoundText = '';

  private liveTools: Array<{ toolCallId: string; toolName: string; arguments?: string }> = [];
  private finalizedTools = new Set<string>();
  private seenTools = new Set<string>();
  private announceLines: string[] = [];
  private statusText = '';
  private running = false;
  private roundStartedAt = 0;
  private spinnerFrame = 0;

  private todos: TodoItem[] = [];
  private contextPct?: string;

  private modalQueue: ModalEntry[] = [];
  private askResolvers = new Map<string, (a: AskAnswer[] | 'fail' | 'cancelled') => void>();
  private askPending = new Map<string, AskAnswer[] | 'fail' | 'cancelled'>();

  private input: InputController;
  private decoder = new KeyDecoder();
  private handlers: InputHandlers = {
    onSubmit: () => {},
    onCancel: () => {},
    onEscape: () => {},
    onExit: () => {},
  };

  private mount0: TuiMount | null = null;
  private budget: LayoutBudget;
  private frameTimer: ReturnType<typeof setTimeout> | null = null;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private escTimer: ReturnType<typeof setTimeout> | null = null;
  private stdinAttached = false;

  constructor(opts: InkTuiOptions) {
    this.asciiOnly = Boolean(opts.asciiOnly);
    this.colorFlag = opts.colorFlag;
    this.thinkingEnabled = Boolean(opts.thinking);
    this.showTurnDividers = opts.showTurnDividers !== false;
    this.symbols = pickSymbols(this.asciiOnly);
    this.agentName = opts.agentName ?? 'Agent';
    this.modelName = opts.modelName ?? 'model';
    this.executionMode = opts.executionMode ?? 'CLOUD';
    this.contextWindowTokens = opts.contextWindowTokens ?? 256000;
    this.verboseToolsFlag = Boolean(opts.verboseTools);
    this.welcomeLines = opts.welcomeLines ?? [];
    this.modelNames = opts.modelNames ?? [];
    this.out = opts.stdout ?? process.stdout;
    this.stdin = opts.stdin ?? process.stdin;
    this.budget = computeBudget(this.out.rows, this.out.columns);
    this.input = new InputController({
      handlers: {
        onSubmit: (text) => this.handlers.onSubmit(text),
        onCancel: () => this.handlers.onCancel(),
        onEscape: () => this.handlers.onEscape(),
        onExit: () => this.handlers.onExit(),
        onClearScreen: () => this.clearAll(),
        onChange: () => this.render(true),
      },
      history: loadInputHistory(),
      onHistoryCommit: (text) => appendInputHistory(text),
      modelNames: this.modelNames,
    });
  }

  // === 生命周期 ===

  mount(): TuiHandle {
    this.applyColorLevel();
    this.mount0 = createTuiApp(this.buildProps(), { stdout: this.out, stdin: this.stdin });
    this.attachStdin();
    this.out.on('resize', this.onResize);
    return {
      clearAll: () => this.clearAll(),
      unmount: () => this.unmount(),
    };
  }

  /** 挂载后再喂欢迎区与历史摘要：历史需要先 attach 会话才能取到。 */
  seedChrome(historyLines: string[] = []): void {
    if (this.seeded) return;
    this.seeded = true;
    const items: TranscriptItem[] = [{ kind: 'welcome', lines: this.welcomeLines }];
    if (historyLines.length > 0) items.push({ kind: 'history', lines: historyLines });
    this.pushStatic(items, true);
  }

  private unmount(): void {
    this.stopTick();
    if (this.frameTimer) {
      clearTimeout(this.frameTimer);
      this.frameTimer = null;
    }
    this.detachStdin();
    this.out.off('resize', this.onResize);
    this.mount0?.unmount();
    this.mount0 = null;
  }

  /**
   * 真实清屏。Ink 的 fullStaticOutput 只增不减，无法单独清空，
   * 因此必须卸载实例、清终端与 scrollback，再挂一个新实例。
   */
  private clearAll(): void {
    const wasSeeded = this.seeded;
    this.mount0?.unmount();
    this.mount0 = null;
    this.out.write('\x1b[2J\x1b[3J\x1b[H');
    this.staticBlocks = [];
    this.seeded = false;
    this.announceLines = [];
    this.mount0 = createTuiApp(this.buildProps(), { stdout: this.out, stdin: this.stdin });
    if (wasSeeded) this.seedChrome();
  }

  private applyColorLevel(): void {
    if (this.colorFlag === undefined) return;
    try {
      const chalk = require('chalk') as { level: number };
      if (this.colorFlag === false) chalk.level = 0;
      else if (chalk.level === 0) chalk.level = 1;
    } catch {
      // chalk 是 ink 的依赖；取不到就沿用其自动探测
    }
  }

  private onResize = (): void => {
    this.budget = computeBudget(this.out.rows, this.out.columns);
    this.render(true);
  };

  // === 键盘 ===

  private attachStdin(): void {
    const stdin = this.stdin;
    if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') return;
    stdin.setEncoding('utf8');
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', this.onStdinData);
    this.out.write(BRACKETED_PASTE_ON);
    this.stdinAttached = true;
  }

  private detachStdin(): void {
    if (!this.stdinAttached) return;
    this.stdinAttached = false;
    if (this.escTimer) {
      clearTimeout(this.escTimer);
      this.escTimer = null;
    }
    this.out.write(BRACKETED_PASTE_OFF);
    this.stdin.off('data', this.onStdinData);
    if (typeof this.stdin.setRawMode === 'function') this.stdin.setRawMode(false);
    this.stdin.pause();
  }

  private onStdinData = (chunk: string | Buffer): void => {
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    this.dispatchKeys(this.decoder.push(text));
    // 单独的 ESC / 未闭合序列会滞留在解码器里，靠短超时收尾，否则 Esc 键永远不生效
    if (this.escTimer) {
      clearTimeout(this.escTimer);
      this.escTimer = null;
    }
    if (this.decoder.hasPending) {
      this.escTimer = setTimeout(() => {
        this.escTimer = null;
        this.dispatchKeys(this.decoder.flush());
      }, ESC_FLUSH_MS);
    }
  };

  private dispatchKeys(events: KeyEvent[]): void {
    for (const ev of events) {
      const head = this.modalQueue[0];
      if (head) {
        head.controller.handleKey(ev);
        this.render(true);
        continue;
      }
      this.input.handleKey(ev);
    }
  }

  setInputHandlers(handlers: InputHandlers): void {
    this.handlers = handlers;
  }

  // === 定稿写入 ===

  private pushStatic(items: TranscriptItem[], spaced = false): void {
    if (items.length === 0) return;
    this.staticBlocks = [...this.staticBlocks, { id: `b${this.staticBlocks.length}-${randomUUID()}`, items, spaced }];
    this.render();
  }

  private note(text: string, tone: Tone = 'dim'): void {
    const items: TranscriptItem[] = text.split('\n').map((line) => ({ kind: 'sys', text: line, tone }));
    this.pushStatic(items);
  }

  /** 命令输出等需要留痕的内容：写入对话记录。 */
  print(text: string, tone: Tone = 'dim'): void {
    this.note(text, tone);
  }

  /** 转瞬即逝的提示：只活在输入框上方，不进对话记录。 */
  announce(message: string): void {
    for (const line of message.split('\n')) this.announceLines.push(line);
    const max = Math.max(1, this.budget.announceRows);
    if (this.announceLines.length > max) {
      this.announceLines.splice(0, this.announceLines.length - max);
    }
    this.render(true);
  }

  noteUser(text: string): void {
    this.pushStatic([{ kind: 'user', text }], false);
  }

  // === Renderer 接口 ===

  onEvent(evt: CliEvent): void {
    switch (evt.type) {
      case 'content_delta':
        this.running = true;
        this.statusText = '生成中…';
        this.roundText += evt.delta;
        this.appendContent(evt.delta);
        break;
      case 'thinking_start':
        this.running = true;
        this.statusText = '思考中…';
        this.render();
        break;
      case 'thinking_delta':
        if (!this.thinkingEnabled) {
          this.statusText = '思考中…';
          this.render();
          break;
        }
        this.appendThinking(evt.delta);
        break;
      case 'thinking_end':
        this.flushThinking();
        break;
      case 'tool_call_start': {
        if (this.seenTools.has(evt.toolCallId)) break;
        this.seenTools.add(evt.toolCallId);
        this.flushTail();
        this.liveTools = [...this.liveTools, {
          toolCallId: evt.toolCallId,
          toolName: evt.toolName,
          arguments: evt.arguments,
        }];
        this.running = true;
        this.statusText = `运行 ${evt.toolName}…`;
        this.render();
        break;
      }
      case 'tool_call_result': {
        const live = this.liveTools.find((t) => t.toolCallId === evt.toolCallId);
        this.liveTools = this.liveTools.filter((t) => t.toolCallId !== evt.toolCallId);
        this.finalizedTools.add(evt.toolCallId);
        const failed = !/^SUCCESS$/i.test(evt.status);
        this.pushStatic([{
          kind: 'tool',
          name: evt.toolName || live?.toolName || 'tool',
          args: live?.arguments,
          result: evt.summary || evt.preview || evt.result || (failed ? evt.status : 'ok'),
          failed,
        }]);
        break;
      }
      case 'file_change':
        this.note(`  +${evt.linesAdded} -${evt.linesDeleted}  ${evt.path}`, 'ok');
        break;
      case 'todo_updated':
        this.todos = evt.todos ?? [];
        this.render();
        break;
      case 'compaction_start':
        this.statusText = '压缩上下文…';
        this.render();
        break;
      case 'compaction_end':
        this.note(`${this.symbols.ok} 上下文压缩完成（节省 ${evt.savedTokens ?? '?'} tokens，${evt.durationMs ?? '?'}ms）`, 'warn');
        break;
      case 'llm_retry':
        this.note(`${this.symbols.warn} LLM 重试 ${evt.attempt ?? '?'}/${evt.maxRetries ?? '?'}（${evt.reason ?? ''}，${evt.delaySeconds ?? '?'}s 后）`, 'warn');
        break;
      case 'llm_waiting':
        this.statusText = `等待 LLM… ${evt.elapsedSeconds ?? 0}s`;
        this.render();
        break;
      case 'llm_stream_reset':
        // 服务端重开流：丢弃本段未定稿尾巴，已定稿的行保留
        this.tail = '';
        this.render();
        break;
      case 'error':
        this.flushTail();
        this.note(`${this.symbols.err} ${evt.message}`, 'err');
        break;
      case 'session_already_running':
        this.note('会话忙，已排队，占用的执行结束后自动重发。', 'warn');
        break;
      case 'reconnected':
        this.note(`${this.symbols.warn} 连接中断已恢复，可能丢失部分输出`, 'warn');
        break;
      case 'context_window':
        this.contextPct = formatContextPercent(evt.estimated, evt.actual, this.contextWindowTokens);
        this.render();
        break;
      case 'side_session_created':
        this.note(`（已创建 Side Task #${evt.sideSessionId}${evt.title ? `: ${evt.title}` : ''}，本 CLI 不 attach）`);
        break;
      case 'subagent_session_created':
        this.note(`（已创建子代理会话 #${evt.childSessionId}${evt.title ? `: ${evt.title}` : ''}，本 CLI 不 attach）`);
        break;
      case 'ask_user_questions':
        this.openAsk(evt.requestId, evt.questions);
        break;
      case 'ask_user_questions_cancelled':
        this.cancelAsk(evt.requestId);
        break;
      default:
        break;
    }
  }

  startRound(): void {
    this.seenTools.clear();
    this.finalizedTools.clear();
    this.liveTools = [];
    this.tail = '';
    this.inFence = false;
    this.thinkingTail = '';
    this.roundText = '';
    this.running = true;
    this.statusText = '思考中…';
    this.roundStartedAt = Date.now();
    this.startTick();
    this.render(true);
  }

  finish(result: RunResult): void {
    this.flushThinking();
    this.flushTail();
    this.stopTick();

    const items: TranscriptItem[] = [];
    // 补齐未收到 result 的工具（取消 / 失败时可能残留）
    for (const tc of result.toolCalls) {
      if (this.finalizedTools.has(tc.toolCallId)) continue;
      items.push({
        kind: 'tool',
        name: tc.toolName,
        args: tc.arguments,
        result: tc.result || tc.status || '未完成',
        failed: !/^SUCCESS$/i.test(tc.status),
      });
    }

    if (!this.roundText.trim() && result.toolCalls.length === 0 && result.fileChanges.length === 0) {
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
    const n = result.toolCalls.length;
    const tools = n > 0 ? ` · ${n} tool${n > 1 ? 's' : ''}` : '';
    const tone: Tone = result.status === 'COMPLETED' ? 'ok' : result.status === 'CANCELLED' ? 'warn' : 'err';
    const label =
      result.status === 'COMPLETED' ? this.symbols.ok
        : result.status === 'CANCELLED' ? `${this.symbols.warn} 已取消`
          : `${this.symbols.err} ${result.status}`;
    items.push({ kind: 'status', text: `  ${label}  ${sec}s${ctx}${todoBit}${tools}`, tone });
    if (this.showTurnDividers) items.push({ kind: 'divider' });

    this.lastRoundText = this.roundText || result.result || '';
    this.pushStatic(items, true);

    this.running = false;
    this.statusText = '';
    this.liveTools = [];
    this.roundText = '';
    this.seenTools.clear();
    this.finalizedTools.clear();
    this.render(true);
  }

  clearTransient(): void {
    this.announceLines = [];
    this.statusText = '';
    this.render(true);
  }

  // === 流式定稿 ===

  private appendContent(delta: string): void {
    this.tail += delta;
    const items: TranscriptItem[] = [];
    let idx = this.tail.indexOf('\n');
    while (idx !== -1) {
      const raw = this.tail.slice(0, idx);
      this.tail = this.tail.slice(idx + 1);
      const res = classifyMdLine(raw, this.inFence);
      this.inFence = res.inFence;
      items.push({ kind: 'mdline', line: res.line });
      idx = this.tail.indexOf('\n');
    }
    if (items.length > 0) this.pushStatic(items);
    else this.render();
  }

  /** 把未完成的尾行也定稿（回合结束 / 工具插入前）。 */
  private flushTail(): void {
    if (!this.tail) return;
    const res = classifyMdLine(this.tail, this.inFence);
    this.inFence = res.inFence;
    this.tail = '';
    this.pushStatic([{ kind: 'mdline', line: res.line }]);
  }

  private appendThinking(delta: string): void {
    this.thinkingTail += delta;
    const items: TranscriptItem[] = [];
    let idx = this.thinkingTail.indexOf('\n');
    while (idx !== -1) {
      const raw = this.thinkingTail.slice(0, idx);
      this.thinkingTail = this.thinkingTail.slice(idx + 1);
      if (raw.trim()) items.push({ kind: 'thinking', text: `  ${raw}` });
      idx = this.thinkingTail.indexOf('\n');
    }
    if (items.length > 0) this.pushStatic(items);
    else this.render();
  }

  private flushThinking(): void {
    if (!this.thinkingTail.trim()) {
      this.thinkingTail = '';
      return;
    }
    const text = `  ${this.thinkingTail}`;
    this.thinkingTail = '';
    this.pushStatic([{ kind: 'thinking', text }]);
  }

  // === 弹窗 ===

  private openAsk(requestId: string, questions: AskQuestion[]): void {
    if (this.modalQueue.some((m) => m.kind === 'ask' && m.requestId === requestId)) return;
    const controller = new AskController(requestId, questions, (answers) => {
      this.closeModal((m) => m.kind === 'ask' && m.requestId === requestId);
      this.deliverAsk(requestId, answers);
    });
    this.modalQueue = [...this.modalQueue, { kind: 'ask', requestId, controller }];
    this.render(true);
  }

  private cancelAsk(requestId: string): void {
    const found = this.modalQueue.some((m) => m.kind === 'ask' && m.requestId === requestId);
    if (found) this.closeModal((m) => m.kind === 'ask' && m.requestId === requestId);
    this.deliverAsk(requestId, 'cancelled');
  }

  private closeModal(match: (m: ModalEntry) => boolean): void {
    this.modalQueue = this.modalQueue.filter((m) => !match(m));
    this.render(true);
  }

  setAskResolver(requestId: string, resolve: (a: AskAnswer[] | 'fail' | 'cancelled') => void): void {
    const buffered = this.askPending.get(requestId);
    if (buffered !== undefined) {
      this.askPending.delete(requestId);
      resolve(buffered);
      return;
    }
    this.askResolvers.set(requestId, resolve);
  }

  private deliverAsk(requestId: string, answers: AskAnswer[] | 'fail' | 'cancelled'): void {
    const resolve = this.askResolvers.get(requestId);
    if (!resolve) {
      // 事件先到、askHandler 后注册：先缓存，避免答案丢失导致服务端悬挂
      this.askPending.set(requestId, answers);
      return;
    }
    this.askResolvers.delete(requestId);
    resolve(answers);
  }

  /** LOCAL 审批：入队展示，FIFO 串行，避免 resolver 相互覆盖。 */
  requestApproval(req: ApprovalRequest, reason: string): Promise<ApprovalChoice> {
    return new Promise((resolve) => {
      const controller = new ApprovalController(req, reason, (choice) => {
        this.closeModal((m) => m.kind === 'approval' && m.controller === controller);
        resolve(choice);
      });
      this.modalQueue = [...this.modalQueue, { kind: 'approval', controller }];
      this.render(true);
    });
  }

  // === 兼容 REPL 的读写接口 ===

  getLastAssistantText(): string {
    return this.lastRoundText;
  }

  getVerboseTools(): boolean {
    return this.verboseToolsFlag;
  }

  setVerboseTools(on: boolean): void {
    this.verboseToolsFlag = on;
    this.render(true);
  }

  getThinking(): boolean {
    return this.thinkingEnabled;
  }

  setThinking(on: boolean): void {
    this.thinkingEnabled = on;
    if (!on) this.thinkingTail = '';
    this.render(true);
  }

  setMeta(meta: { agentName?: string; modelName?: string; executionMode?: string; contextWindowTokens?: number }): void {
    if (meta.agentName) this.agentName = meta.agentName;
    if (meta.modelName) this.modelName = meta.modelName;
    if (meta.executionMode) this.executionMode = meta.executionMode;
    if (meta.contextWindowTokens && meta.contextWindowTokens > 0) this.contextWindowTokens = meta.contextWindowTokens;
    this.render(true);
  }

  setModelNames(names: string[]): void {
    this.modelNames = names;
    this.input.setModelNames(names);
  }

  // === 帧调度 ===

  private startTick(): void {
    if (this.tickTimer) return;
    this.tickTimer = setInterval(() => {
      this.spinnerFrame = (this.spinnerFrame + 1) % this.symbols.spin.length;
      this.render(true);
    }, TICK_MS);
  }

  private stopTick(): void {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
  }

  private render(immediate = false): void {
    if (!this.mount0) return;
    if (immediate) {
      if (this.frameTimer) {
        clearTimeout(this.frameTimer);
        this.frameTimer = null;
      }
      this.mount0.update(this.buildProps());
      return;
    }
    if (this.frameTimer) return;
    this.frameTimer = setTimeout(() => {
      this.frameTimer = null;
      this.mount0?.update(this.buildProps());
    }, FRAME_MS);
  }

  private buildProps(): TuiAppProps {
    const b = this.budget;
    const panelBudgetRows = Math.max(4, b.rows - 6);
    const panel = this.buildPanel(panelBudgetRows);
    const inputView = panel
      ? null
      : this.input.view({ columns: b.columns, maxRows: b.draftRows, paletteRows: b.paletteRows });
    // footer 1 行 + 输入框/弹窗高度
    const reserved = 1 + (panel ? panel.lines.length + 2 : inputView?.height ?? 0);
    const sizes = allocateLive({
      budget: b,
      reserved,
      want: {
        status: this.running || Boolean(this.statusText),
        announce: this.announceLines.length,
        tools: this.liveTools.length,
        tail: this.tail ? Math.max(1, Math.ceil(this.tail.length / Math.max(1, b.columns))) : 0,
        thinking: this.thinkingTail ? 1 : 0,
      },
    });

    return {
      staticBlocks: this.staticBlocks,
      live: this.buildLive(sizes),
      input: inputView,
      panel,
      footer: this.footerMeta(),
      verboseTools: this.verboseToolsFlag,
      asciiOnly: this.asciiOnly,
      columns: b.columns,
    };
  }

  private buildLive(sizes: { status: number; announce: number; tools: number; tail: number; thinking: number }): LiveView {
    const cols = this.budget.columns;
    const live: LiveView = {
      thinking: [],
      tail: [],
      tools: [],
      announce: [],
    };

    if (sizes.thinking > 0 && this.thinkingTail) {
      live.thinking = tailRows(`  ${this.thinkingTail}`, cols, sizes.thinking);
    }

    if (sizes.tail > 0 && this.tail) {
      const cls = classifyMdLine(this.tail, this.inFence).line;
      const source = cls.kind === 'heading' ? cls.text : this.tail;
      live.tail = tailRows(source, cols, sizes.tail).map<MdLine>((text) => ({
        kind: cls.kind,
        text,
        level: cls.level,
      }));
    }

    if (sizes.tools > 0) {
      const shown = this.liveTools.slice(Math.max(0, this.liveTools.length - sizes.tools));
      live.tools = shown.map((t) => {
        const args = summarizeToolArgs(t.arguments);
        const line = `${this.symbols.tool} ${t.toolName}${args ? `  ${args}` : ''}`;
        return { id: t.toolCallId, text: truncateToWidth(line, cols) };
      });
    }

    if (sizes.status > 0) {
      const spin = this.running ? `${this.symbols.spin[this.spinnerFrame % this.symbols.spin.length]} ` : '';
      const elapsed = this.running && this.roundStartedAt
        ? `  ${Math.max(0, Math.round((Date.now() - this.roundStartedAt) / 1000))}s`
        : '';
      live.status = truncateToWidth(`${spin}${this.statusText || '处理中…'}${elapsed}`, cols);
    }

    if (sizes.announce > 0) {
      const shown = this.announceLines.slice(Math.max(0, this.announceLines.length - sizes.announce));
      live.announce = shown.map((l) => truncateToWidth(l, cols));
    }

    return live;
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

  private buildPanel(maxRows: number): PanelView | null {
    const head = this.modalQueue[0];
    if (!head) return null;
    const queued = this.modalQueue.length - 1;
    const cols = Math.max(20, this.budget.columns - 4);
    const panel = head.kind === 'ask'
      ? this.buildAskPanel(head.controller, cols, maxRows)
      : this.buildApprovalPanel(head.controller, cols, maxRows);
    if (queued > 0) {
      panel.lines.push({ text: `  （还有 ${queued} 个待处理）`, tone: 'dim' });
    }
    return panel;
  }

  private buildAskPanel(controller: AskController, cols: number, maxRows: number): PanelView {
    const s = controller.state;
    const lines: PanelLine[] = [];
    lines.push({ text: `? Agent 想确认（${s.index + 1}/${s.total}）`, tone: 'info', bold: true });
    for (const row of wrapByWidth(s.question, cols - 2)) lines.push({ text: `  ${row}` });

    if (s.customMode) {
      const shown = s.custom.slice(Math.max(0, s.custom.length - (cols - 10)));
      lines.push({ text: `  自定义: ${shown}${this.asciiOnly ? '_' : '▏'}` });
      lines.push({
        text: s.options.length > 0 ? '  Enter 提交  Esc 返回选项' : '  Enter 提交  Esc 取消',
        tone: 'dim',
      });
      return { kind: 'ask', borderColor: 'cyan', lines };
    }

    const room = Math.max(2, maxRows - lines.length - 1);
    const active = s.options.findIndex((o) => o.active);
    let from = 0;
    if (s.options.length > room) {
      from = Math.min(Math.max(0, active - Math.floor(room / 2)), s.options.length - room);
    }
    const slice = s.options.slice(from, from + room);
    slice.forEach((opt, i) => {
      const n = from + i + 1;
      const mark = s.multiSelect ? (opt.checked ? '[x]' : '[ ]') : '   ';
      const pointer = opt.active ? `${this.symbols.pointer} ` : '  ';
      const desc = opt.description ? ` — ${opt.description}` : '';
      lines.push({
        text: truncateToWidth(`${pointer}${mark} ${n}) ${opt.label}${desc}`, cols),
        active: opt.active,
      });
    });
    if (s.options.length > room) lines.push({ text: `  … 共 ${s.options.length} 项`, tone: 'dim' });
    lines.push({
      text: s.multiSelect
        ? (this.asciiOnly ? '  Up/Down 选择  Space 勾选  Enter 提交  数字快捷  c 自定义  Esc 取消' : '  ↑↓ 选择  Space 勾选  Enter 提交  数字快捷  c 自定义  Esc 取消')
        : (this.asciiOnly ? '  Up/Down 选择  Enter 确认  数字快捷  c 自定义  Esc 取消' : '  ↑↓ 选择  Enter 确认  数字快捷  c 自定义  Esc 取消'),
      tone: 'dim',
    });
    return { kind: 'ask', borderColor: 'cyan', lines };
  }

  private buildApprovalPanel(controller: ApprovalController, cols: number, maxRows: number): PanelView {
    const s = controller.state;
    const lines: PanelLine[] = [];
    lines.push({ text: `${this.symbols.warn} 需要批准 · ${s.request.toolName}`, tone: 'warn', bold: true });
    const descRows = wrapByWidth(s.request.description, cols - 2).slice(0, Math.max(1, maxRows - 5));
    for (const row of descRows) lines.push({ text: `  ${row}` });
    if (s.request.dangerReason) {
      lines.push({ text: truncateToWidth(`  危险: ${s.request.dangerReason}`, cols), tone: 'err' });
    } else if (s.reason) {
      lines.push({ text: truncateToWidth(`  ${s.reason}`, cols), tone: 'dim' });
    }
    if (s.request.workspace) {
      lines.push({ text: truncateToWidth(`  工作区: ${s.request.workspace}`, cols), tone: 'dim' });
    }
    if (s.confirming) {
      const what = s.confirming === 'allow' ? '允许这一次' : '本会话允许同类';
      lines.push({ text: `  再按 Enter 确认「${what}」，Esc 返回`, tone: 'err', bold: true });
    } else {
      lines.push({
        text: s.dangerous
          ? '  [y] 允许这次  [a] 本会话同类  [n] 拒绝  （危险操作需再按 Enter 确认）'
          : '  [y] 允许这次  [n] 拒绝  [a] 本会话允许同类  Esc 拒绝',
        tone: 'dim',
      });
    }
    return { kind: 'approval', borderColor: 'yellow', lines };
  }
}
