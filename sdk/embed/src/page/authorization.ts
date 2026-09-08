import type { PageAction, PageElement, PageToolError } from './types';
import { isMutatingAction } from './types';

export type PageAuthorizationLevel = 'per_action' | 'task' | 'full';

export type PageRisk = 'normal' | 'high' | 'sensitive';

export interface PageConfirmRequest {
  id: string;
  tool: string;
  summary: string;
  risk: PageRisk;
  action?: PageAction;
  element?: Pick<PageElement, 'elementId' | 'label' | 'role' | 'text' | 'sensitive'>;
  /** per_action 下的单次确认：approved 只在本次动作有效。 */
  sessionId: number;
}

interface PendingConfirm {
  id: string;
  input: Omit<PageConfirmRequest, 'id'>;
  resolve: (approved: boolean) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

export interface PageAuthorizationOptions {
  serverUrl: string;
  agentId: number;
  scopeVersion: string;
  identity: () => string | null;
  onStateChange?: (level: PageAuthorizationLevel, taskSessionId: number | null) => void;
  onConfirmRequest?: (request: PageConfirmRequest | null) => void;
}

export interface PageAuthorizationDecision {
  allowed: boolean;
  needsConfirmation: boolean;
  error?: PageToolError;
}

const STORAGE_PREFIX = 'mao_embed_page_authorization';

function safeOrigin(serverUrl: string): string {
  try { return new URL(serverUrl).origin; } catch { return serverUrl; }
}

function storageKey(serverUrl: string, agentId: number, origin: string, identity: string, scopeVersion: string): string {
  return `${STORAGE_PREFIX}:${safeOrigin(serverUrl)}:${origin}:${agentId}:${identity}:${scopeVersion}`;
}

const HIGH_RISK_TEXT = ['提交', '确认', '删除', '移除', '支付', '付款', '购买', '下单', '发送', '注销', '解绑', 'submit', 'delete', 'remove', 'pay', 'purchase', 'confirm'];

export class PageAuthorization {
  private level: PageAuthorizationLevel = 'per_action';
  private taskSessionId: number | null = null;
  private key: string | null = null;
  private identity: string | null = null;
  /** 身份尚未就绪时用户已选择 full：拿到身份后补写持久化，避免静默丢失。 */
  private pendingFull = false;
  /** 宿主指定的初始 task 级别：在首个任务开始时生效，不持久化。 */
  private initialTask = false;
  /** 确认请求队列：同一时刻只展示一张卡片，避免并发工具调用互相覆盖。 */
  private readonly confirmQueue: PendingConfirm[] = [];
  private activeConfirm: PendingConfirm | null = null;
  private counter = 0;

  constructor(private readonly options: PageAuthorizationOptions) {
    this.syncIdentity();
  }

  get current(): PageAuthorizationLevel { return this.level; }
  get currentTaskSessionId(): number | null { return this.taskSessionId; }

  /** 级别/身份/任务变化时，已挂起/排队的确认不再有意义：立即以拒绝结束。 */
  private cancelPendingConfirmations(): void {
    this.settlePendingConfirmations(false);
  }

  /** 用户升级到 task/full：当前等待确认的动作已获得更高授权，直接放行。 */
  private approvePendingConfirmations(): void {
    this.settlePendingConfirmations(true);
  }

  /** 连接断开：等待中的确认不再可能被正确回传，立即以拒绝结束。 */
  rejectPendingConfirmations(): void {
    this.cancelPendingConfirmations();
  }

  private settlePendingConfirmations(approved: boolean): void {
    const active = this.activeConfirm;
    const queued = this.confirmQueue.splice(0);
    if (active == null && queued.length === 0) return;
    this.activeConfirm = null;
    if (active) {
      if (active.timer) clearTimeout(active.timer);
      active.resolve(approved);
    }
    for (const entry of queued) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.resolve(approved);
    }
    this.options.onConfirmRequest?.(null);
  }

  /** 身份变化时重算存储键；跨身份不得继承授权。 */
  syncIdentity(): void {
    const identity = this.options.identity();
    if (identity === this.identity) return;
    this.cancelPendingConfirmations();
    const wasAnonymous = this.identity == null;
    this.identity = identity;
    this.level = 'per_action';
    this.taskSessionId = null;
    this.key = identity == null ? null : storageKey(
      this.options.serverUrl, this.options.agentId, location.origin, identity, this.options.scopeVersion,
    );
    if (wasAnonymous && this.pendingFull && this.key) {
      // 匿名阶段用户已选择 full：补写当前身份并保持授权
      this.pendingFull = false;
      this.level = 'full';
      try { localStorage.setItem(this.key, 'full'); } catch { /* ignore */ }
    } else {
      this.pendingFull = false;
      this.loadPersisted();
    }
    this.emitState();
  }

  /**
   * 宿主 init 指定的初始级别：只允许 per_action 或 task。
   * full 会被降级为 per_action —— 完全授权必须由用户在浮窗内显式授予并持久化，宿主不得静默提权。
   */
  setInitialLevel(level: PageAuthorizationLevel): void {
    this.syncIdentity();
    this.cancelPendingConfirmations();
    this.initialTask = level === 'task';
    if (level === 'full') {
      this.level = 'per_action';
      this.taskSessionId = null;
      this.pendingFull = false;
      try { if (this.key) localStorage.removeItem(this.key); } catch { /* ignore */ }
    } else if (level === 'per_action') {
      this.level = 'per_action';
      this.taskSessionId = null;
    }
    this.emitState();
  }

  /**
   * 宿主/用户显式设置级别。full 按真实身份持久化；task 必须绑定当前会话。
   * approvePending 仅由浮窗用户路径传 true：用户刚升级到更高权限时放行等待中的确认。
   */
  setLevel(level: PageAuthorizationLevel, sessionId?: number | null, approvePending = true): void {
    this.syncIdentity();
    if (level === 'task' && sessionId == null) {
      // 没有任务上下文时 task 无法成立，退回 per_action，避免"实例级"授权。
      // 必须先校验再决定是否放行确认，否则被拒绝的授权会误放行等待中的动作。
      this.initialTask = false;
      this.level = 'per_action';
      this.taskSessionId = null;
      this.emitState();
      return;
    }
    // 升级到 task/full：用户刚授予更高权限，当前等待确认的动作应直接放行；
    // 降级到 per_action：保留正在等待的确认卡片（它本身就是一次 per-action 确认）。
    if (approvePending && (level === 'task' || level === 'full')) this.approvePendingConfirmations();
    this.initialTask = false;
    this.level = level;
    this.taskSessionId = level === 'task' ? sessionId! : null;
    try {
      if (level === 'full') {
        if (this.key) {
          localStorage.setItem(this.key, 'full');
          this.pendingFull = false;
        } else {
          // 身份未就绪：先记住用户意图，syncIdentity 拿到真实身份后补写
          this.pendingFull = true;
        }
      } else {
        this.pendingFull = false;
        if (this.key) localStorage.removeItem(this.key);
      }
    } catch { /* storage unavailable */ }
    this.emitState();
  }

  beginTask(sessionId: number): void {
    this.syncIdentity();
    if (this.taskSessionId === sessionId) return;
    this.taskSessionId = sessionId;
    // 上一次任务授权不得跨会话继续有效
    if (this.level === 'task') {
      this.level = 'per_action';
      this.emitState();
    }
    // 宿主初始 task 级别：首个任务开始时生效（内存级，不持久化）
    if (this.initialTask && this.level === 'per_action') {
      this.initialTask = false;
      this.level = 'task';
      this.emitState();
    }
  }

  /** 任务结束 / 新会话 / destroy：task 授权立即失效，full 保留。 */
  endTask(): void {
    this.cancelPendingConfirmations();
    this.taskSessionId = null;
    if (this.level === 'task') {
      this.level = 'per_action';
      this.emitState();
    }
  }

  revoke(): void {
    this.cancelPendingConfirmations();
    this.level = 'per_action';
    this.taskSessionId = null;
    this.pendingFull = false;
    this.initialTask = false;
    try { if (this.key) localStorage.removeItem(this.key); } catch { /* ignore */ }
    this.emitState();
  }

  /** 判断是否允许执行，以及 per_action 下是否需要用户逐次确认。 */
  decide(_tool: string, sessionId: number, action?: PageAction, _element?: PageElement): PageAuthorizationDecision {
    this.syncIdentity();
    if (this.level === 'full') return { allowed: true, needsConfirmation: false };
    if (this.level === 'task') {
      if (this.taskSessionId !== sessionId) {
        return { allowed: false, needsConfirmation: false, error: { code: 'authorization_required', message: '本次任务授权已失效，请重新授权' } };
      }
      return { allowed: true, needsConfirmation: false };
    }
    const mutating = action != null && isMutatingAction(action.type);
    if (!mutating) return { allowed: true, needsConfirmation: false };
    return { allowed: true, needsConfirmation: true };
  }

  riskOf(action: PageAction | undefined, element?: PageElement): PageRisk {
    if (element?.sensitive) return 'sensitive';
    if (action?.type === 'click') {
      const haystack = `${element?.label ?? ''} ${element?.text ?? ''} ${element?.type ?? ''}`.toLowerCase();
      if (element?.type === 'submit' || HIGH_RISK_TEXT.some((word) => haystack.includes(word.toLowerCase()))) return 'high';
    }
    return 'normal';
  }

  /** 请求用户确认；返回是否批准。同一时刻只展示一张卡片，其余排队。UI 未接入时按拒绝处理。 */
  requestConfirmation(input: Omit<PageConfirmRequest, 'id'>): Promise<boolean> {
    if (!this.options.onConfirmRequest) return Promise.resolve(false);
    const id = `pc-${Date.now().toString(36)}-${++this.counter}`;
    return new Promise<boolean>((resolve) => {
      this.confirmQueue.push({ id, input, resolve, timer: null });
      this.pumpConfirmQueue();
    });
  }

  resolveConfirmation(id: string, approved: boolean): void {
    this.finishConfirm(id, approved);
  }

  private pumpConfirmQueue(): void {
    if (this.activeConfirm != null) return;
    const next = this.confirmQueue.shift();
    if (!next) return;
    this.activeConfirm = next;
    next.timer = setTimeout(() => this.finishConfirm(next.id, false), 120_000);
    this.options.onConfirmRequest?.({ ...next.input, id: next.id });
  }

  private finishConfirm(id: string, approved: boolean): void {
    if (this.activeConfirm?.id === id) {
      const entry = this.activeConfirm;
      this.activeConfirm = null;
      if (entry.timer) clearTimeout(entry.timer);
      this.options.onConfirmRequest?.(null);
      entry.resolve(approved);
      this.pumpConfirmQueue();
      return;
    }
    const index = this.confirmQueue.findIndex((entry) => entry.id === id);
    if (index < 0) return;
    const [entry] = this.confirmQueue.splice(index, 1);
    if (entry?.timer) clearTimeout(entry.timer);
    entry?.resolve(approved);
  }

  /** 低授权级别下敏感字段值脱敏。 */
  shouldRedactSensitive(sessionId: number): boolean {
    this.syncIdentity();
    if (this.level === 'full') return false;
    if (this.level === 'task') return this.taskSessionId !== sessionId;
    return true;
  }

  destroy(): void {
    this.cancelPendingConfirmations();
  }

  private loadPersisted(): void {
    if (!this.key) return;
    try {
      if (localStorage.getItem(this.key) === 'full') this.level = 'full';
    } catch { /* ignore */ }
  }

  private emitState(): void {
    this.options.onStateChange?.(this.level, this.taskSessionId);
  }
}
