import type {
  PageAction, PageActionResult, PageBatchResult, PageElement, PageObserveResult,
  PageSnapshot, PageToolError, PageToolName,
} from './types';
import { isPageToolName } from './types';
import { PageSnapshotManager } from './snapshot-manager';
import { scanPage } from './scanner';
import { PageExecutor, type AuthorizeAction } from './executor';
import { PageAuthorization, type PageAuthorizationLevel, type PageConfirmRequest, type PageRisk } from './authorization';
import { capturePageScreenshot, type PageScreenshot, type ScreenshotRenderer } from './screenshot';

export interface PageActionLogEntry {
  id: string;
  tool: string;
  summary: string;
  status: 'running' | 'success' | 'error';
  risk: PageRisk;
  at: number;
  error?: string;
}

export interface PageHighlightTarget {
  elementId: string;
  label: string;
  rect: { x: number; y: number; width: number; height: number };
}

export interface PageEngineHooks {
  host?: HTMLElement | null;
  serverUrl: string;
  agentId: number;
  identity: () => string | null;
  currentSessionId: () => number | null;
  scopeVersion?: string;
  screenshotRenderer?: ScreenshotRenderer;
  onAuthorizationChange?: (level: PageAuthorizationLevel, taskSessionId: number | null) => void;
  onConfirmRequest?: (request: PageConfirmRequest | null) => void;
  onLog?: (entry: PageActionLogEntry) => void;
  onHighlight?: (target: PageHighlightTarget | null) => void;
  onTaskStateChange?: (active: boolean) => void;
}

export interface PageToolOutcome {
  success: boolean;
  result?: unknown;
  error?: PageToolError;
  snapshotId?: string;
  pageVersion?: string;
}

const MAX_BATCH_ACTIONS = 50;

/**
 * 页面能力引擎：把后端 page_tool_request 映射为本地扫描/截图/动作执行，
 * 统一处理授权、快照生命周期、动作日志与目标高亮。
 */
export class PageEngine {
  readonly manager: PageSnapshotManager;
  readonly authorization: PageAuthorization;
  private readonly executor: PageExecutor;
  private activeSessionId: number | null = null;
  private cancelled = false;
  private destroyed = false;
  /**
   * 请求代次：断线时递增，使当前在途动作/批量的 shouldAbort 立即生效，
   * 但不阻断重连后的新请求（新请求会捕获递增后的代次）。
   * 不能直接用 cancelled —— 它只在用户 send()/prepareNewTask() 时复位，会误杀断线重试。
   */
  private abortEpoch = 0;

  constructor(private readonly hooks: PageEngineHooks) {
    this.manager = new PageSnapshotManager({ host: hooks.host, includeHidden: false, redactSensitive: true });
    this.authorization = new PageAuthorization({
      serverUrl: hooks.serverUrl,
      agentId: hooks.agentId,
      scopeVersion: hooks.scopeVersion ?? 'v1',
      identity: hooks.identity,
      onStateChange: hooks.onAuthorizationChange,
      onConfirmRequest: hooks.onConfirmRequest,
    });
    this.executor = new PageExecutor(this.manager);
  }

  get authorizationLevel(): PageAuthorizationLevel { return this.authorization.current; }
  get taskActive(): boolean { return this.activeSessionId != null; }
  get isCancelled(): boolean { return this.cancelled; }

  /** 新用户消息：结束上一个（已取消）任务的阻断态，让新一轮页面请求可以开始。 */
  prepareNewTask(): void {
    this.cancelled = false;
    this.activeSessionId = null;
  }

  beginTask(sessionId: number, invalidateSnapshot = false): void {
    if (this.destroyed) return;
    this.cancelled = false;
    this.activeSessionId = sessionId;
    this.authorization.beginTask(sessionId);
    // 后端驱动的新任务必须重新 inspect：清空上一任务遗留的快照。
    // 宿主 inspectPage() → executePageAction() 走 ensureTask，不清空。
    if (invalidateSnapshot) this.manager.invalidate();
    this.hooks.onTaskStateChange?.(true);
  }

  endTask(): void {
    const hadTask = this.activeSessionId != null;
    this.activeSessionId = null;
    // 始终撤销 task 授权：用户可能在任务内尚未产生页面动作时就点了「本次任务授权」，
    // 若因 activeSessionId==null 提前返回，授权会泄漏到下一个任务。
    this.authorization.endTask();
    this.hooks.onHighlight?.(null);
    if (hadTask) this.hooks.onTaskStateChange?.(false);
  }

  /** 用户停止 / 会话切换：取消等待中的确认并让后续动作立即失败。 */
  cancel(): void {
    this.cancelled = true;
    this.authorization.destroy();
    this.endTask();
  }

  setLevel(level: PageAuthorizationLevel, sessionId?: number | null): void {
    this.authorization.setLevel(level, sessionId ?? this.activeSessionId);
  }

  /** 宿主 init 指定的初始级别：full 会被降级，见 PageAuthorization.setInitialLevel。 */
  setInitialLevel(level: PageAuthorizationLevel): void {
    this.authorization.setInitialLevel(level);
  }

  /**
   * 宿主公开 API：只允许 per_action/task。
   * full 必须由用户在浮窗内显式授予并持久化，宿主一行代码不能替用户静默提权。
   */
  setHostLevel(level: PageAuthorizationLevel, sessionId?: number | null): void {
    // 宿主不能授予 full，也不改变用户当前授权（避免把用户已持久化的 full 清掉）。
    if (level === 'full') return;
    // 宿主设置 task 不代表用户批准了当前等待中的确认，不能顺带放行。
    this.authorization.setLevel(level, sessionId ?? this.activeSessionId, false);
  }

  revoke(): void {
    this.authorization.revoke();
  }

  resolveConfirmation(id: string, approved: boolean): void {
    this.authorization.resolveConfirmation(id, approved);
  }

  /** 连接断开：中止在途动作/批量，并拒绝等待中的确认，避免重连后新旧请求并发执行 DOM 动作。 */
  abortInFlight(): void {
    this.abortEpoch += 1;
    this.authorization.rejectPendingConfirmations();
  }

  /** 当前执行是否应中止：用户取消，或本请求的代次已被断线中止。 */
  private aborted(epoch: number): boolean {
    return this.cancelled || epoch !== this.abortEpoch;
  }

  inspect(options: { includeHidden?: boolean; sessionId?: number | null } = {}): PageSnapshot {
    const sessionId = options.sessionId ?? this.hooks.currentSessionId() ?? 0;
    const redact = this.authorization.shouldRedactSensitive(sessionId);
    return this.manager.inspect({ includeHidden: options.includeHidden, redactSensitive: redact });
  }

  observe(snapshotId?: string): PageObserveResult {
    return this.manager.observe(snapshotId);
  }

  async screenshot(options: { maskSensitive?: boolean; reason?: string; sessionId?: number | null } = {}): Promise<PageScreenshot> {
    const sessionId = options.sessionId ?? this.hooks.currentSessionId() ?? 0;
    // 截图遵循与 inspect 相同的授权模型：full / 命中会话的 task 授权范围内允许未遮罩；
    // 仅 per_action 下需要逐次确认。
    const unmaskedAllowed = !this.authorization.shouldRedactSensitive(sessionId);
    let mask = options.maskSensitive !== false;
    if (unmaskedAllowed) mask = options.maskSensitive === true;
    if (!unmaskedAllowed && options.maskSensitive === false) {
      const approved = await this.authorization.requestConfirmation({
        tool: 'page_screenshot',
        summary: `发送未遮罩的当前视口截图${options.reason ? `（用途：${options.reason}）` : ''}`,
        risk: 'sensitive',
        sessionId,
      });
      mask = !approved;
    }
    // 遮罩区域必须按当前 DOM 现算：快照里的 rect 是上次 inspect 时的视口坐标，
    // 滚动或布局变化后用它会把敏感字段漏出、并涂黑错误位置。
    const sensitive = mask
      ? scanPage({ host: this.hooks.host, includeHidden: false, redactSensitive: false, sensitiveOnly: true, maxElements: 5000 })
        .elements
      : [];
    return capturePageScreenshot({
      host: this.hooks.host,
      maskSensitive: mask,
      maskElements: sensitive.map((item) => item.element),
      maskRects: sensitive.map((item) => item.descriptor.rect),
      renderer: this.hooks.screenshotRenderer,
    });
  }

  async executeAction(action: PageAction, snapshotId: string | undefined, sessionId: number): Promise<PageActionResult> {
    this.ensureTask(sessionId);
    const epoch = this.abortEpoch;
    try {
      return await this.executor.execute(action, {
        snapshotId, authorize: this.authorizer(sessionId), shouldAbort: () => this.aborted(epoch),
      });
    } finally {
      this.hooks.onHighlight?.(null);
    }
  }

  async executeBatch(actions: PageAction[], snapshotId: string | undefined, sessionId: number): Promise<PageBatchResult> {
    this.ensureTask(sessionId);
    const truncated = actions.length > MAX_BATCH_ACTIONS;
    const epoch = this.abortEpoch;
    const result = await this.executor.executeBatch(actions.slice(0, MAX_BATCH_ACTIONS), {
      snapshotId,
      authorize: this.authorizer(sessionId),
      shouldAbort: () => this.aborted(epoch),
      stopOnConfirmation: this.authorization.current === 'per_action',
      onStep: (step) => this.logStep(describeAction(step.action, this.descriptorOf(step.action)), step),
    });
    return truncated ? { ...result, truncated: true } : result;
  }

  private ensureTask(sessionId: number): void {
    // 宿主公开 API：复位取消态；有真实会话时让 task 授权绑定到该会话。
    // 不设置 activeSessionId / 不通知 UI，避免宿主单独操作时面板进入页面任务态。
    if (this.activeSessionId == null && this.cancelled) this.cancelled = false;
    if (sessionId <= 0) return;
    this.authorization.beginTask(sessionId);
  }

  async handleRequest(tool: PageToolName, args: Record<string, unknown>, sessionId: number): Promise<PageToolOutcome> {
    if (this.destroyed) return { success: false, error: { code: 'internal_error', message: '页面执行器已销毁' } };
    const expected = this.hooks.currentSessionId();
    if (expected != null && expected !== sessionId) {
      return { success: false, error: { code: 'internal_error', message: '页面请求与当前会话不匹配，已忽略' } };
    }
    if (this.cancelled) return { success: false, error: { code: 'task_cancelled', message: '页面任务已取消' } };
    if (this.activeSessionId == null) this.beginTask(sessionId, true);
    this.authorization.syncIdentity();

    try {
      switch (tool) {
        case 'page_inspect': return this.handleInspect(args, sessionId);
        case 'page_observe': return this.handleObserve(args);
        case 'page_screenshot': return await this.handleScreenshot(args, sessionId);
        case 'page_wait': return await this.handleSingle({ type: 'wait', ms: numberArg(args.ms), until: args.until === 'stable' ? 'stable' : undefined }, undefined, sessionId);
        case 'page_scroll': return await this.handleSingle({
          type: 'scroll', elementId: stringArg(args.elementId),
          x: numberArg(args.x), y: numberArg(args.y),
          to: args.to === 'top' || args.to === 'bottom' ? args.to : undefined,
        }, stringArg(args.snapshotId), sessionId);
        case 'page_focus': return await this.handleSingle({ type: 'focus', elementId: requiredElement(args) }, requiredSnapshot(args), sessionId);
        case 'page_fill': return await this.handleSingle({ type: 'fill', elementId: requiredElement(args), value: stringArg(args.value) ?? '' }, requiredSnapshot(args), sessionId);
        case 'page_select': return await this.handleSingle({ type: 'select', elementId: requiredElement(args), value: stringArg(args.value) ?? '' }, requiredSnapshot(args), sessionId);
        case 'page_check': return await this.handleSingle({ type: 'check', elementId: requiredElement(args) }, requiredSnapshot(args), sessionId);
        case 'page_uncheck': return await this.handleSingle({ type: 'uncheck', elementId: requiredElement(args) }, requiredSnapshot(args), sessionId);
        case 'page_click': return await this.handleSingle({ type: 'click', elementId: requiredElement(args) }, requiredSnapshot(args), sessionId);
        case 'page_keyboard': return await this.handleSingle({
          type: 'keyboard', elementId: stringArg(args.elementId), key: stringArg(args.key) ?? '',
          modifiers: Array.isArray(args.modifiers) ? args.modifiers.map(String) : undefined,
          text: stringArg(args.text),
        }, stringArg(args.snapshotId), sessionId);
        case 'page_actions': return await this.handleBatch(args, sessionId);
        default: return { success: false, error: { code: 'invalid_arguments', message: `未知页面工具: ${tool}` } };
      }
    } catch (e) {
      return { success: false, error: { code: 'internal_error', message: e instanceof Error ? e.message : String(e) } };
    }
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.cancelled = true;
    this.authorization.destroy();
    this.manager.destroy();
    this.activeSessionId = null;
  }

  private handleInspect(args: Record<string, unknown>, sessionId: number): PageToolOutcome {
    const snapshot = this.inspect({ includeHidden: args.includeHidden === true, sessionId });
    return { success: true, result: snapshot, snapshotId: snapshot.snapshotId, pageVersion: snapshot.pageVersion };
  }

  private handleObserve(args: Record<string, unknown>): PageToolOutcome {
    const result = this.observe(stringArg(args.snapshotId));
    return { success: true, result, snapshotId: result.snapshotId ?? undefined, pageVersion: result.pageVersion };
  }

  private async handleScreenshot(args: Record<string, unknown>, sessionId: number): Promise<PageToolOutcome> {
    try {
      const shot = await this.screenshot({
        maskSensitive: args.maskSensitive === true ? true : args.maskSensitive === false ? false : undefined,
        reason: stringArg(args.reason) ?? undefined,
        sessionId,
      });
      return { success: true, result: shot, pageVersion: this.manager.pageVersion };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const code = message.startsWith('screenshot_too_large')
        ? 'screenshot_too_large'
        : message.includes('timeout') ? 'screenshot_timeout' : 'screenshot_failed';
      return { success: false, error: { code, message } };
    }
  }

  private async handleSingle(action: PageAction, snapshotId: string | undefined, sessionId: number): Promise<PageToolOutcome> {
    const target = this.resolveTarget(action, snapshotId);
    if ('error' in target) return { success: false, error: target.error };
    const epoch = this.abortEpoch;
    try {
      const result = await this.executor.execute(action, {
        snapshotId, authorize: this.authorizer(sessionId), shouldAbort: () => this.aborted(epoch),
      });
      this.logStep(describeAction(action, this.descriptorOf(action)), result);
      return {
        success: result.success,
        result,
        ...(result.error ? { error: result.error } : {}),
        snapshotId: result.snapshotId,
        pageVersion: result.pageVersion,
      };
    } finally {
      this.hooks.onHighlight?.(null);
    }
  }

  private async handleBatch(args: Record<string, unknown>, sessionId: number): Promise<PageToolOutcome> {
    const raw = Array.isArray(args.actions) ? args.actions : [];
    const hasInvalid = raw.some((action) => action == null || typeof action !== 'object'
      || typeof (action as { type?: unknown }).type !== 'string');
    if (hasInvalid) return { success: false, error: { code: 'invalid_arguments', message: 'actions 中存在非法动作' } };
    const rawActions = raw.map((action) => normalizeAction(action as PageAction));
    if (rawActions.length === 0) return { success: false, error: { code: 'invalid_arguments', message: 'actions 不能为空' } };
    const snapshotId = stringArg(args.snapshotId);
    for (const action of rawActions) {
      const target = this.resolveTarget(action, snapshotId);
      if ('error' in target) return { success: false, error: target.error };
    }
    try {
      const result = await this.executeBatch(rawActions, snapshotId, sessionId);
      return {
        success: result.steps.every((step) => step.success),
        result,
        snapshotId: result.snapshotId,
        pageVersion: result.pageVersion,
      };
    } finally {
      this.hooks.onHighlight?.(null);
    }
  }

  private resolveTarget(action: PageAction, snapshotId: string | undefined): { ok: true } | { error: PageToolError } {
    if (action.type === 'wait') return { ok: true };
    const elementId = 'elementId' in action ? action.elementId : undefined;
    if (elementId && !snapshotId) {
      return { error: { code: 'invalid_arguments', message: '缺少 snapshotId，请重新 page_inspect' } };
    }
    return { ok: true };
  }

  private authorizer(sessionId: number): AuthorizeAction {
    return async (action, resolved) => {
      if (this.cancelled) return { allowed: false, error: { code: 'task_cancelled', message: '页面任务已取消' } };
      const tool = toolForAction(action.type);
      const descriptor = resolved?.descriptor;
      const decision = this.authorization.decide(tool, sessionId, action, descriptor);
      if (!decision.allowed) return { allowed: false, error: decision.error };
      if (!decision.needsConfirmation) return { allowed: true };
      const risk = this.authorization.riskOf(action, descriptor);
      this.hooks.onHighlight?.(descriptor ? highlightOf(descriptor) : null);
      const approved = await this.authorization.requestConfirmation({
        tool,
        summary: describeAction(action, descriptor),
        risk,
        action,
        element: descriptor,
        sessionId,
      });
      return approved
        ? { allowed: true, needsConfirmation: true }
        : { allowed: false, needsConfirmation: true, error: { code: 'authorization_denied', message: '用户未批准该页面操作' } };
    };
  }

  private logStep(summary: string, result: PageActionResult): void {
    const text = result.error ? `${summary} · ${result.error.message}` : summary;
    this.hooks.onLog?.({
      id: `log-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      tool: toolForAction(result.action.type),
      summary: text,
      status: result.success ? 'success' : 'error',
      risk: this.authorization.riskOf(result.action),
      at: Date.now(),
      ...(result.error ? { error: result.error.message } : {}),
    });
  }

  /** 日志/确认文案用：从当前快照取元素描述，失败时仍尽量带上名称。 */
  private descriptorOf(action: PageAction): PageElement | undefined {
    const elementId = 'elementId' in action ? action.elementId : undefined;
    if (!elementId) return undefined;
    return this.manager.current?.elements.find((el) => el.elementId === elementId);
  }
}

function highlightOf(element: PageElement): PageHighlightTarget {
  return { elementId: element.elementId, label: element.label || element.text || element.role, rect: element.rect };
}

function toolForAction(type: PageAction['type']): PageToolName {
  switch (type) {
    case 'click': return 'page_click';
    case 'focus': return 'page_focus';
    case 'fill': return 'page_fill';
    case 'select': return 'page_select';
    case 'check': return 'page_check';
    case 'uncheck': return 'page_uncheck';
    case 'keyboard': return 'page_keyboard';
    case 'scroll': return 'page_scroll';
    case 'wait': return 'page_wait';
  }
}

function describeAction(action: PageAction, element?: PageElement): string {
  const target = formatTarget(element);
  switch (action.type) {
    case 'click': return `点击${target}`;
    case 'focus': return `聚焦${target}`;
    case 'fill': {
      const value = element?.sensitive ? '（已遮罩）' : formatSnippet(action.value);
      return value ? `填写${target}为 ${value}` : `填写${target}`;
    }
    case 'select': return `选择${target} 的选项${action.value ? `「${formatSnippet(action.value)}」` : ''}`;
    case 'check': return `勾选${target}`;
    case 'uncheck': return `取消勾选${target}`;
    case 'keyboard': return `按键 ${action.key}${target}`;
    case 'scroll': return action.to ? `滚动到${action.to === 'top' ? '顶部' : '底部'}` : '滚动页面';
    case 'wait': return action.until === 'stable' ? '等待页面稳定' : `等待 ${action.ms ?? 300}ms`;
  }
}

const KIND_FALLBACK: Record<PageElement['kind'], string> = {
  button: '按钮',
  'form-control': '输入框',
  link: '链接',
  other: '控件',
};

function formatTarget(element?: PageElement): string {
  const name = formatSnippet(element?.label || element?.text || '');
  if (name) return `「${name}」`;
  if (!element) return '';
  return `「${KIND_FALLBACK[element.kind] || '控件'}」`;
}

function formatSnippet(value: string | undefined): string {
  const text = (value ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length > 24 ? `${text.slice(0, 24)}…` : text;
}

function stringArg(value: unknown): string | undefined {
  if (typeof value === 'string') return value === '' ? undefined : value;
  // 模型对数字/布尔输入常输出 JSON number/boolean：后端 asText 会放行，SDK 必须同口径，
  // 否则会被兜成空串（page_fill 清空字段却报成功）。
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return String(value);
  return undefined;
}

function textArg(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return String(value);
  return undefined;
}

/** 批量动作来自模型 JSON：统一把 value/key/text/ms/x/y 归一化，避免类型口径不一致。 */
function normalizeAction(action: PageAction): PageAction {
  const source = action as unknown as Record<string, unknown>;
  const next = { ...source } as Record<string, unknown>;
  for (const key of ['value', 'key', 'text']) {
    if (key in next) {
      const normalized = textArg(next[key]);
      if (normalized === undefined) delete next[key];
      else next[key] = normalized;
    }
  }
  for (const key of ['ms', 'x', 'y']) {
    if (key in next) {
      const normalized = numberArg(next[key]);
      if (normalized === undefined) delete next[key];
      else next[key] = normalized;
    }
  }
  return next as unknown as PageAction;
}

function numberArg(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function requiredElement(args: Record<string, unknown>): string {
  return stringArg(args.elementId) ?? '';
}

function requiredSnapshot(args: Record<string, unknown>): string | undefined {
  return stringArg(args.snapshotId);
}

export { isPageToolName };
