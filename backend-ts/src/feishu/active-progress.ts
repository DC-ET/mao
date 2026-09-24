import type { FeishuProgressHandle } from './patched-progress.js';

interface ActiveProgressEntry {
  senderOpenId: string;
  handle: FeishuProgressHandle;
}

/** 本进程内正在续更的飞书进度卡。提问只挂这里，不查找父会话或其他会话的卡。 */
export class FeishuActiveProgressRegistry {
  private readonly handles = new Map<number, ActiveProgressEntry>();

  bind(sessionId: number, senderOpenId: string, handle: FeishuProgressHandle): void {
    this.handles.set(sessionId, { senderOpenId, handle });
  }

  current(sessionId: number): FeishuProgressHandle | null {
    return this.handles.get(sessionId)?.handle ?? null;
  }

  hasRunning(sessionId: number): boolean {
    return this.handles.get(sessionId)?.handle.isRunning() === true;
  }

  senderOpenId(sessionId: number): string {
    return this.handles.get(sessionId)?.senderOpenId ?? '';
  }

  /** 进度已不是 RUNNING 时返回 false，避免把终态卡刷回执行中。 */
  async refresh(sessionId: number): Promise<boolean> {
    const entry = this.handles.get(sessionId);
    if (entry == null || !entry.handle.isRunning()) return false;
    await entry.handle.refresh();
    return true;
  }

  render(sessionId: number): Record<string, unknown> | null {
    const handle = this.handles.get(sessionId)?.handle;
    if (handle == null) return null;
    return handle.renderCurrent();
  }
}
