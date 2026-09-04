/**
 * 选中文本采集：selectionchange 监听（200ms debounce），
 * 仅跟踪宿主文档（跨 Shadow DOM 边界），浮窗内部选中不触发。
 */
export class SelectionTracker {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private onChange: (selection: string | null) => void;

  constructor(onChange: (selection: string | null) => void) {
    this.onChange = onChange;
    document.addEventListener('selectionchange', this.handleSelectionChange);
  }

  private handleSelectionChange = () => {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.onChange(this.currentSelection());
    }, 200);
  };

  private currentSelection(): string | null {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
    const text = sel.toString();
    return text && text.trim() ? text : null;
  }

  /** 发送时取当前选中；发送后宿主选中态通常被清除，无需主动干预 */
  peek(): string | null {
    return this.currentSelection();
  }

  destroy() {
    document.removeEventListener('selectionchange', this.handleSelectionChange);
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
