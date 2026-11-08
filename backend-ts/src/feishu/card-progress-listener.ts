import type { AgentEventListener } from '../harness/core/agent-event-listener.js';
import type { ChatUsage, ToolCall } from '../harness/llm/chat-request.js';
import { ToolResultSummarizer } from '../session/util/tool-result-summarizer.js';
import { stripCitationMarkers } from '../session/util/citation-markers.js';
import { formatFeishuDuration } from './progress-card.js';

export interface FeishuCardProgress {
  /**
   * @param terminalMessageId 仅 COMPLETED 终态携带：该卡终态回复对应的 ASSISTANT 消息 ID，
   *                          由调用方在读取终态回复的同一时刻确定（与卡片正文同源），
   *                          供完成卡快照按卡归属落库；其余状态不传。
   */
  update(status: 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED', round: number, content: string, tools: string[], terminalMessageId?: number): Promise<void>;
}

type ToolProgress = { name: string; argumentsJson: string | null; summary: string | null; startedAtMs: number | null };

/** 进度卡在途工具耗时刷新的默认间隔：与 app-config `feishu.bot.cardToolTickMs` 默认值一致。 */
const DEFAULT_TOOL_TICK_MS = 3000;
/** 展示阈值：耗时满 1s 才显示（亚秒一闪而过只是噪音；与桌面端 0.0.465 口径一致）。 */
const MIN_ELAPSED_DISPLAY_MS = 1000;

/**
 * Collects one LLM loop round and updates a Feishu progress card at round boundaries.
 *
 * 轮次只有工具调用时（如轮询登录状态），卡片回退展示上一轮最近的正文：
 * Agent 常把登录链接写在 content 里、再用 shell 轮询状态，不兜底的话用户看不到链接，
 * 任务看起来卡住（`carriedContent`）。
 */
export class FeishuCardProgressListener implements AgentEventListener {
  private round = 0;
  private readonly roundOffset: number;
  private content = '';
  /** 上一轮收尾时留下的正文：本轮没有 assistant content 时用它撑住卡片。 */
  private carriedContent = '';
  private readonly tools = new Map<string, ToolProgress>();
  private pending: Promise<void> = Promise.resolve();
  /** 在途工具耗时的周期刷新定时器；仅在有工具在跑期间存在（见 ensureTicker/stopTicker）。 */
  private ticker: ReturnType<typeof setInterval> | null = null;
  /** 终局标志：complete/cancel/fail/onError 后置位，tick 回调里二次把关，防止极端路径下定时器复活。 */
  private finished = false;

  /**
   * @param roundOffset 崩溃恢复/重试时，当前任务已完成的 LLM 轮数。
   *                    AgentLoop 仍从 1 计本趟循环，卡片展示 offset+loopRound。
   * @param tickMs 在途工具耗时刷新间隔（ms）；0 关闭周期刷新（仅事件推送）。
   * @param now 时钟注入点，供测试确定性驱动 tick；生产用 Date.now。
   */
  constructor(
    private readonly progress: FeishuCardProgress,
    roundOffset = 0,
    private readonly tickMs: number = DEFAULT_TOOL_TICK_MS,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.roundOffset = normalizeRoundOffset(roundOffset);
    this.round = this.roundOffset;
  }

  onRoundStart(round: number): void {
    this.round = this.displayRound(round);
    // LLM 请求已发起（真正进入思考阶段）：立即刷新卡片，轮次也随之向上走。
    // 首次调用常要几十秒才产出内容，卡片若停在首卡的「任务已接收，正在准备执行。」，
    // 用户会误以为任务卡住；尚无正文（本轮未产出、上轮也没有可兜底内容）时用思考提示占位。
    const content = this.displayContent();
    this.queue('RUNNING', content.trim() === '' ? THINKING_TEXT : content, this.toolsList(this.now()), this.round);
  }

  onContentDelta(delta: string): void {
    // 换行、空行经常单独成为一个 delta。累积时不能 trim，否则段末换行被吃掉，
    // 下一段会粘在上一句后面。询问态卡片会停在这份正文上，标题和列表就挤成一段。
    if (delta === '' || this.content.length >= CARD_TEXT_MAX) return;
    const next = this.content + delta;
    this.content = next.length <= CARD_TEXT_MAX ? next : next.slice(0, CARD_TEXT_MAX);
  }

  onToolCallStart(toolCall: ToolCall): void {
    const toolCallId = toolCall.id ?? `tool-${this.tools.size}`;
    const name = toolCall.function?.name ?? '未知工具';
    const previous = this.tools.get(toolCallId);
    // 起表时刻只在首次登记时打点：同 id 的重复 start / 参数增量都不重置，否则耗时永远走不起来。
    this.tools.set(toolCallId, {
      name,
      argumentsJson: toolCall.function?.arguments ?? previous?.argumentsJson ?? null,
      summary: previous?.summary ?? null,
      startedAtMs: previous?.startedAtMs ?? this.now(),
    });
    // 工具触发即推送一次进度，长耗时工具执行期间用户可见"执行中"状态，而不是等结果返回。
    this.queue('RUNNING', this.displayContent(), this.toolValues(this.now()), this.round);
    // 首个在途工具出现即挂周期刷新；后续 tick 每 tickMs 重推一次带耗时的卡。
    this.ensureTicker();
  }

  onToolCallArgsDelta(toolCallId: string, argumentsJson: string): void {
    const tool = this.tools.get(toolCallId);
    if (tool == null) return;
    const before = formatToolLine(tool, this.now());
    tool.argumentsJson = argumentsJson;
    // 流式参数拼完后（尤其是 shell command）立刻刷新卡片，不必等整轮 LLM 流结束。
    if (formatToolLine(tool, this.now()) !== before) {
      this.queue('RUNNING', this.displayContent(), this.toolValues(this.now()), this.round);
    }
  }

  onToolCallResult(toolCallId: string, result: string): void {
    const tool = this.tools.get(toolCallId);
    if (tool == null) {
      // 乱序兜底：结果先于 start 到达的 entry 没有起表时刻，不参与计时。
      this.tools.set(toolCallId, { name: `工具 ${toolCallId}`, argumentsJson: null, summary: trimCardText(result.replace(/\s+/g, ' ')).slice(0, 240), startedAtMs: null });
      return;
    }
    tool.summary = ToolResultSummarizer.summarize(tool.name, tool.argumentsJson, result)
      ?? trimCardText(result.replace(/\s+/g, ' ')).slice(0, 240);
    // 最后一个在途工具结束即停刷新；模型思考阶段卡片静止是既有行为。
    if (!this.hasRunningTool()) this.stopTicker();
  }

  onMessageEnd(_usage: ChatUsage): void {}

  onRoundEnd(round: number): void {
    this.round = this.displayRound(round);
    this.stopTicker();
    this.queue('RUNNING', this.displayContent(), this.toolsList(this.now()), this.round);
    // 本轮正文留给下一轮兜底（如登录链接），随后清空本轮累积。
    if (this.content.trim() !== '') this.carriedContent = this.content;
    this.content = '';
    this.tools.clear();
  }

  onError(error: unknown): void {
    this.finished = true;
    this.stopTicker();
    const message = error instanceof Error ? error.message : 'Agent 执行异常';
    this.queue('FAILED', message);
  }

  async complete(finalContent: string, terminalMessageId?: number): Promise<boolean> {
    this.finished = true;
    this.stopTicker();
    await this.flush();
    // 渠道卡片不渲染来源区，终态正文同样剥掉 [^n^]（与 displayContent 同口径）：
    // 正常路径的入参已由 getLatestAssistantReply 剥过，这里兜住崩溃恢复等其他调用方
    return this.updateTerminal('COMPLETED', this.round, trimCardText(stripCitationMarkers(finalContent)), [], terminalMessageId);
  }

  async cancel(interrupted = false): Promise<boolean> {
    this.finished = true;
    this.stopTicker();
    await this.flush();
    const message = interrupted ? '已被下一条指令中断。' : '任务已取消。';
    return this.updateTerminal('CANCELLED', this.round, message, []);
  }

  async fail(message: string): Promise<boolean> {
    this.finished = true;
    this.stopTicker();
    await this.flush();
    // 终态卡不展示执行中耗时（耗时是 RUNNING 态的专属语义）：nowMs 传 null 关闭耗时后缀。
    return this.updateTerminal('FAILED', this.round, trimCardText(message), this.toolValues(null));
  }

  private queue(status: 'RUNNING' | 'FAILED', content = this.content, tools = this.toolValues(this.now()), round = this.round): void {
    this.pending = this.pending.then(async () => { await this.safeUpdate(status, round, content, tools); });
  }

  /**
   * 卡片正文：本轮有 assistant content 用本轮的，否则回退到上一轮最近一条。
   * 空串视为没有正文（只有换行的 delta 不兜底），保证纯工具轮仍显示上轮的链接/说明。
   * 渠道卡片不渲染来源区，[^n^] 标记在此统一剥掉（与最终文本出口同口径）。
   */
  private displayContent(): string {
    const raw = this.content.trim() === '' ? this.carriedContent : this.content;
    return stripCitationMarkers(raw);
  }

  private async safeUpdate(status: 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED', round: number, content: string, tools: string[], terminalMessageId?: number): Promise<boolean> {
    try {
      await this.progress.update(status, round, trimCardText(content), tools, terminalMessageId);
      return true;
    } catch (error) {
      console.warn(`飞书进度卡片更新失败: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  private async updateTerminal(status: 'COMPLETED' | 'FAILED' | 'CANCELLED', round: number, content: string, tools: string[], terminalMessageId?: number): Promise<boolean> {
    return this.safeUpdate(status, round, content, tools, terminalMessageId);
  }

  /**
   * @param nowMs 计时基准：事件/tick 推送传当前时刻（在途行带耗时后缀）；
   *              null 用于终态卡（FAILED 可能残留未结束工具），不展示执行中耗时。
   */
  private toolValues(nowMs: number | null): string[] {
    return [...this.tools.values()].map((tool) => formatToolLine(tool, nowMs));
  }

  private toolsList(nowMs: number | null): string[] {
    return this.toolValues(nowMs);
  }

  /** 是否有在途工具：无 summary 且已起表（乱序兜底 entry 无起表时刻，不算在途）。 */
  private hasRunningTool(): boolean {
    for (const tool of this.tools.values()) {
      if (tool.summary == null && tool.startedAtMs != null) return true;
    }
    return false;
  }

  private ensureTicker(): void {
    if (this.finished || this.ticker != null || this.tickMs <= 0) return;
    this.ticker = setInterval(() => this.tick(), this.tickMs);
    // 双保险：即使异常路径漏了 stopTicker，也不拖住 Node 进程退出。
    this.ticker.unref?.();
  }

  private stopTicker(): void {
    if (this.ticker == null) return;
    clearInterval(this.ticker);
    this.ticker = null;
  }

  private tick(): void {
    if (this.finished || !this.hasRunningTool()) return;
    this.queue('RUNNING', this.displayContent(), this.toolValues(this.now()), this.round);
  }

  private displayRound(loopRound: number): number {
    const n = Number.isFinite(loopRound) ? Math.max(0, Math.floor(loopRound)) : 0;
    return this.roundOffset + n;
  }

  private async flush(): Promise<void> {
    await this.pending;
  }
}

const CARD_TEXT_MAX = 6000;

/** 轮次开始（LLM 请求已发起）但没有任何正文时的占位文案：区别于首卡「正在准备执行」，明确 agent 已进入思考阶段。 */
const THINKING_TEXT = '正在思考…';

/** 只去掉整段首尾空白。内部换行必须保留，发出卡片时再调用。 */
function trimCardText(value: string): string {
  return value.trim().slice(0, CARD_TEXT_MAX);
}

function normalizeRoundOffset(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value);
}

/**
 * 当前任务已完成的 LLM 轮数：最后一条 USER 之后的 ASSISTANT 条数。
 * 崩溃恢复与失败重试用来把飞书卡片轮次接上，避免从 0/1 重计。
 */
export function countCompletedAgentRounds(messages: Array<{ role?: string | null }> | null | undefined): number {
  if (messages == null || messages.length === 0) return 0;
  let start = 0;
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === 'USER') start = i + 1;
  }
  let count = 0;
  for (let i = start; i < messages.length; i++) {
    if (messages[i].role === 'ASSISTANT') count++;
  }
  return count;
}

/** 飞书工作区命令常以 `cd …/oc_<id> &&` 开头，前缀约 80 字；留出后面的实际命令。 */
const RUNNING_COMMAND_MAX = 240;

/**
 * 工具行文案：
 * - 已结束（有 summary）：`name：摘要`，不带耗时（耗时是执行中专属语义，摘要保持结果语义纯净）。
 * - 在途且有 detail：`name：detail（执行中 · 1 分 30 秒）`；无 detail：`name：执行中…（1 分 30 秒）`。
 * - 耗时满 1s 才显示；nowMs 为 null（终态卡）不显示。
 */
function formatToolLine(tool: ToolProgress, nowMs: number | null): string {
  if (tool.summary) return `${tool.name}：${tool.summary}`;
  const elapsed = runningElapsedText(tool, nowMs);
  const running = runningToolDetail(tool);
  if (running) {
    const base = `${tool.name}：${running}（执行中）`;
    return elapsed == null ? base : `${tool.name}：${running}（执行中 · ${elapsed}）`;
  }
  const base = `${tool.name}：执行中…`;
  return elapsed == null ? base : `${base}（${elapsed}）`;
}

/** 在途耗时文案：未起表 / 不足 1s / 非计时场景（nowMs=null）返回 null，不追加后缀。 */
function runningElapsedText(tool: ToolProgress, nowMs: number | null): string | null {
  if (nowMs == null || tool.startedAtMs == null) return null;
  const elapsedMs = nowMs - tool.startedAtMs;
  if (elapsedMs < MIN_ELAPSED_DISPLAY_MS) return null;
  return formatFeishuDuration(elapsedMs);
}

/** 执行中优先展示 shell 命令；其它工具复用摘要器的无结果预览（有具体参数时）。 */
function runningToolDetail(tool: ToolProgress): string | null {
  if (tool.name.toLowerCase() === 'shell') {
    const command = extractShellCommand(tool.argumentsJson);
    if (command) return `\`${escapeInlineCode(truncateCard(command, RUNNING_COMMAND_MAX))}\``;
  }
  const preview = ToolResultSummarizer.summarize(tool.name, tool.argumentsJson, null);
  if (preview == null || preview.trim() === '') return null;
  if (preview.toLowerCase() === tool.name.toLowerCase()) return null;
  if (GENERIC_RUNNING_LABELS.has(preview)) return null;
  return preview;
}

const GENERIC_RUNNING_LABELS = new Set([
  'Shell 命令',
  '读取 文件',
  '写入 文件',
  '编辑 文件',
]);

function extractShellCommand(argumentsJson: string | null): string | null {
  const args = parseArgsObject(argumentsJson);
  if (args == null) return null;
  const command = args.command;
  if (typeof command !== 'string') return null;
  const normalized = command.replace(/\s+/g, ' ').trim();
  return normalized === '' ? null : normalized;
}

function parseArgsObject(argumentsJson: string | null): Record<string, unknown> | null {
  if (argumentsJson == null || argumentsJson.trim() === '') return null;
  try {
    const parsed: unknown = JSON.parse(argumentsJson);
    if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function escapeInlineCode(text: string): string {
  return text.replace(/`/g, "'");
}

function truncateCard(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}
