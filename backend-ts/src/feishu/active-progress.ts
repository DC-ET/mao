import type { FeishuProgressHandle } from './patched-progress.js';

interface ActiveProgressEntry {
  senderOpenId: string;
  handle: FeishuProgressHandle;
  /** 该句柄对应的飞书卡片 messageId（点踩按卡归属时反查用；崩溃恢复/重试同卡换句柄时覆盖）。 */
  cardMessageId?: string;
}

/** 本进程内正在续更的飞书进度卡。提问只挂这里，不查找父会话或其他会话的卡。 */
export class FeishuActiveProgressRegistry {
  private readonly handles = new Map<number, ActiveProgressEntry>();
  /** cardMessageId → 句柄：点任意一张完成卡（含旧卡）时按卡渲染/置点踩态，与 session 键解耦。 */
  private readonly byCard = new Map<string, FeishuProgressHandle>();

  bind(sessionId: number, senderOpenId: string, handle: FeishuProgressHandle, cardMessageId?: string): void {
    this.handles.set(sessionId, { senderOpenId, handle, cardMessageId });
    // 旧卡句柄保留在 byCard：会话起新任务后点旧完成卡仍按该卡终态重绘；同卡重试/崩溃恢复则覆盖。
    if (cardMessageId != null && cardMessageId !== '') this.byCard.set(cardMessageId, handle);
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

  /** 按被点卡片渲染（一级降级）：未绑定过该卡（如进程重启后的旧卡）返回 null，交快照表重建。 */
  renderByCard(cardMessageId: string): Record<string, unknown> | null {
    const handle = this.byCard.get(cardMessageId);
    if (handle == null) return null;
    return handle.renderCurrent();
  }

  /** 按被点卡片置点踩态：只影响该卡句柄，不串到会话最新任务的卡片上。未命中时静默忽略。 */
  setDislikedByCard(cardMessageId: string, disliked: boolean): void {
    this.byCard.get(cardMessageId)?.setDisliked(disliked);
  }
}
