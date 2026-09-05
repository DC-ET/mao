/**
 * 选中文本采集：selectionchange 监听（200ms debounce）。
 * 仅跟踪宿主文档：浮窗（Shadow DOM）内部的选中会被忽略，
 * 否则用户复制助手回答就会污染下一条消息的引用块。
 *
 * 关键语义：选区折叠（用户点击输入框、点页面空白处）**不清除**已捕获的引用。
 * 用户选中文本后必然要点进浮窗输入框才能提问，此时宿主选区一定被折叠；
 * 若据此清空引用，引用功能等于不可用。引用只在三种情况下消失：
 * 用户关闭 chip（dismiss）、随消息发出（consume）、选中了另一段文本（覆盖）。
 */
export class SelectionTracker {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private onChange: (selection: string | null) => void;
  /** 被屏蔽的文本：用户关闭了 chip，或已随上一条消息发出 */
  private blocked: string | null = null;
  /** 屏蔽是否已失效（选区离开过该文本）：失效后用户重新选中同一段即可恢复引用 */
  private blockedStale = false;

  constructor(
    onChange: (selection: string | null) => void,
    /** SDK 的 Shadow DOM 宿主节点：落在其内的选区一律忽略 */
    private readonly host: HTMLElement | null = null,
  ) {
    this.onChange = onChange;
    document.addEventListener('selectionchange', this.handleSelectionChange);
  }

  private handleSelectionChange = () => {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      const raw = this.rawSelection();
      // 选区离开被屏蔽文本（含折叠）：屏蔽失效，用户重新选中同一段时恢复引用
      if (this.blocked != null && raw !== this.blocked) this.blockedStale = true;
      // 折叠/落在浮窗内：保持当前引用不动（用户点输入框准备打字属于此路径）
      if (raw == null) return;
      if (raw === this.blocked) {
        if (!this.blockedStale) return;
        this.blocked = null;
        this.blockedStale = false;
      }
      this.onChange(raw);
    }, 200);
  };

  /** 选区是否落在 SDK 浮窗内部（Shadow DOM 内的选中同样触发 document.selectionchange） */
  private isInsideHost(sel: Selection): boolean {
    if (!this.host) return false;
    const nodes = [sel.anchorNode, sel.focusNode];
    for (const node of nodes) {
      if (!node) continue;
      if (this.host.contains(node)) return true;
      // Shadow DOM 内的节点 getRootNode() 是 ShadowRoot，其 host 即本 SDK 的挂载点
      const root = node.getRootNode?.();
      if (root && (root as ShadowRoot).host === this.host) return true;
    }
    return false;
  }

  private rawSelection(): string | null {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
    if (this.isInsideHost(sel)) return null;
    const text = sel.toString();
    return text && text.trim() ? text : null;
  }

  /**
   * 发送时兜底读取实时选区（覆盖 200ms debounce 窗口内的新选中）。
   * 仍处于屏蔽期的文本不返回。
   */
  peek(): string | null {
    const raw = this.rawSelection();
    if (raw == null) return null;
    if (raw === this.blocked && !this.blockedStale) return null;
    return raw;
  }

  /**
   * 用户关闭引用 chip：这段文本不再作为引用（重新选中可恢复）。
   * 传入 text 是因为点击浮窗内按钮已把宿主选区折叠，此时读不到原文本。
   */
  dismiss(text?: string | null) {
    this.block(text ?? this.rawSelection());
  }

  /** 随本条消息发出：一次性屏蔽，避免下一条消息重复携带同一段文本 */
  consume(text: string) {
    this.block(text);
  }

  /** 撤销一次性屏蔽（发送失败回滚时恢复引用） */
  unconsume() {
    this.blocked = null;
    this.blockedStale = false;
  }

  private block(text: string | null) {
    this.blocked = text;
    this.blockedStale = false;
    this.onChange(null);
  }

  destroy() {
    document.removeEventListener('selectionchange', this.handleSelectionChange);
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
