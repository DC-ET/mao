import type { PageElement, PageObserveResult, PageSnapshot } from './types';
import { scanPage, signatureOf, tokenOf, type ScanOptions } from './scanner';
import { isVisible } from './visibility';

export interface ResolvedElement {
  element: Element;
  descriptor: PageElement;
  signature: string;
  token: string;
}

export type ResolveFailure = 'snapshot_expired' | 'element_not_available' | 'element_changed';

export interface ResolveResult {
  ok: boolean;
  code?: ResolveFailure;
  resolved?: ResolvedElement;
}

interface SnapshotRecord {
  snapshot: PageSnapshot;
  navVersion: string;
  refs: Map<string, ResolvedElement>;
}

function randomId(): string {
  const cryptoObj = window.crypto;
  if (cryptoObj?.randomUUID) return cryptoObj.randomUUID().slice(0, 12);
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 快照生命周期：
 * - 每次 inspect 生成新的 snapshotId + pageVersion，旧 elementId 立即失效；
 * - 记录导航版本（history 导航 / SPA 路由 / 整页跳转），导航后所有快照失效；
 * - 动作执行前校验元素仍连接、语义签名未变，避免 DOM 复用导致误操作新对象。
 */
export class PageSnapshotManager {
  private record: SnapshotRecord | null = null;
  /** 最近若干快照（按 id）：导航后 record 置空，但仍可用旧快照做 observe 对比。 */
  private readonly history = new Map<string, SnapshotRecord>();
  private destroyed = false;
  private generation = 0;
  private lastHref = '';
  private originalPushState: History['pushState'] | null = null;
  private originalReplaceState: History['replaceState'] | null = null;
  private readonly onPopState = () => this.onNavigation();
  private readonly onHashChange = () => this.onNavigation();
  private readonly onBeforeUnload = () => { this.record = null; };

  constructor(private readonly options: ScanOptions = {}) {
    this.lastHref = location.href;
    this.patchHistory();
    window.addEventListener('popstate', this.onPopState, true);
    window.addEventListener('hashchange', this.onHashChange, true);
    window.addEventListener('beforeunload', this.onBeforeUnload, true);
  }

  get pageVersion(): string {
    this.onNavigation();
    return this.navVersion();
  }

  get current(): PageSnapshot | null {
    this.onNavigation();
    return this.record?.snapshot ?? null;
  }

  get currentSnapshotId(): string | null {
    return this.record?.snapshot.snapshotId ?? null;
  }

  get destroyedFlag(): boolean {
    return this.destroyed;
  }

  inspect(options: { includeHidden?: boolean; redactSensitive?: boolean } = {}): PageSnapshot {
    if (this.destroyed) throw new Error('page_manager_destroyed');
    this.onNavigation();
    const scan = scanPage({
      ...this.options,
      includeHidden: options.includeHidden ?? this.options.includeHidden,
      redactSensitive: options.redactSensitive ?? this.options.redactSensitive,
    });
    const refs = new Map<string, ResolvedElement>();
    const elements = scan.elements.map((item) => {
      refs.set(item.descriptor.elementId, {
        element: item.element, descriptor: item.descriptor, signature: item.signature, token: item.token,
      });
      return item.descriptor;
    });
    const snapshot: PageSnapshot = {
      snapshotId: `snap-${randomId()}`,
      pageVersion: this.navVersion(),
      url: scan.url,
      title: scan.title,
      viewport: { width: window.innerWidth, height: window.innerHeight, devicePixelRatio: window.devicePixelRatio || 1 },
      elements,
      ...(scan.crossOriginFrames > 0
        ? { warnings: [`存在 ${scan.crossOriginFrames} 个跨域 iframe，其内部元素不可读取或操作`] }
        : {}),
    };
    this.record = { snapshot, navVersion: this.navVersion(), refs };
    this.history.set(snapshot.snapshotId, this.record);
    while (this.history.size > 5) {
      const oldest = this.history.keys().next().value;
      if (oldest == null) break;
      this.history.delete(oldest);
    }
    return snapshot;
  }

  resolve(snapshotId: string | undefined, elementId: string | undefined): ResolveResult {
    if (this.destroyed) return { ok: false, code: 'snapshot_expired' };
    this.onNavigation();
    const record = this.record;
    if (!record || !snapshotId || record.snapshot.snapshotId !== snapshotId || record.navVersion !== this.navVersion()) {
      return { ok: false, code: 'snapshot_expired' };
    }
    if (!elementId) return { ok: false, code: 'element_not_available' };
    const resolved = record.refs.get(elementId);
    if (!resolved) return { ok: false, code: 'element_not_available' };
    if (!resolved.element.isConnected) return { ok: false, code: 'element_not_available' };
    // 节点被替换（即使渲染内容完全相同）也必须拒绝旧引用
    if (tokenOf(resolved.element) !== resolved.token) return { ok: false, code: 'element_changed' };
    const currentSignature = signatureOf(resolved.element, resolved.descriptor.role);
    if (currentSignature !== resolved.signature) return { ok: false, code: 'element_changed' };
    return { ok: true, resolved };
  }

  /** 供执行器在动作后刷新某元素的最新描述（值/勾选状态会变）。 */
  refreshDescriptor(elementId: string): void {
    const resolved = this.record?.refs.get(elementId);
    if (resolved) resolved.signature = signatureOf(resolved.element, resolved.descriptor.role);
  }

  observe(previousSnapshotId?: string): PageObserveResult {
    this.onNavigation();
    const previous = previousSnapshotId ? this.history.get(previousSnapshotId) ?? null : null;
    const scan = scanPage({ ...this.options, includeHidden: false, redactSensitive: true });
    const counts = new Map<string, number>();
    for (const item of scan.elements) counts.set(item.signature, (counts.get(item.signature) ?? 0) + 1);
    let added = 0;
    let removed = 0;
    let updated = 0;
    if (previous) {
      const before = new Map<string, number>();
      for (const item of previous.refs.values()) before.set(item.signature, (before.get(item.signature) ?? 0) + 1);
      for (const [signature, count] of counts) {
        const prior = before.get(signature) ?? 0;
        if (count > prior) added += count - prior;
      }
      for (const [signature, count] of before) {
        const now = counts.get(signature) ?? 0;
        if (count > now) removed += count - now;
      }
      // 同一节点身份 token 且签名变化 = 更新；它同时被签名口径计入 added 和 removed，需扣除。
      const beforeTokens = new Map<string, string>();
      for (const item of previous.refs.values()) beforeTokens.set(item.token, item.signature);
      for (const item of scan.elements) {
        const prior = beforeTokens.get(item.token);
        if (prior !== undefined && prior !== item.signature) updated += 1;
      }
      added = Math.max(0, added - updated);
      removed = Math.max(0, removed - updated);
    }
    return {
      pageVersion: this.navVersion(),
      url: scan.url,
      title: scan.title,
      snapshotId: this.record?.snapshot.snapshotId ?? null,
      elementCount: scan.elements.length,
      changes: {
        added,
        removed,
        updated,
        navigated: previous != null && previous.navVersion !== this.navVersion(),
      },
    };
  }

  invalidate(): void {
    this.record = null;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.record = null;
    this.history.clear();
    window.removeEventListener('popstate', this.onPopState, true);
    window.removeEventListener('hashchange', this.onHashChange, true);
    window.removeEventListener('beforeunload', this.onBeforeUnload, true);
    if (this.originalPushState) history.pushState = this.originalPushState;
    if (this.originalReplaceState) history.replaceState = this.originalReplaceState;
  }

  /** 元素当前是否仍然可见（动作前检查）。 */
  static visible(element: Element): boolean {
    return isVisible(element);
  }

  private navVersion(): string {
    return `${this.generation}:${location.href}`;
  }

  private onNavigation(): void {
    if (location.href !== this.lastHref) {
      this.generation++;
      this.lastHref = location.href;
      this.record = null;
    }
  }

  private patchHistory(): void {
    const manager = this;
    this.originalPushState = history.pushState.bind(history);
    this.originalReplaceState = history.replaceState.bind(history);
    history.pushState = function patchedPushState(this: History, ...args: Parameters<History['pushState']>) {
      const result = manager.originalPushState!.apply(this, args);
      manager.onNavigation();
      return result;
    };
    history.replaceState = function patchedReplaceState(this: History, ...args: Parameters<History['replaceState']>) {
      const result = manager.originalReplaceState!.apply(this, args);
      manager.onNavigation();
      return result;
    };
  }
}
