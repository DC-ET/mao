/** 飞书进度卡上尚未提交的一组提问。requestId 只活在内存，与桌面端登记一致。 */
export interface FeishuPendingAsk {
  sessionId: number;
  requestId: string;
  questions: Array<Record<string, unknown>>;
  senderOpenId: string;
}

/**
 * 会话级提问表单状态。每次 PATCH 进度卡前现读，避免后到的进度更新把表单盖掉。
 * 不入库：进程重启后这一轮 tool call 尚未落库，恢复时整卡重写，旧表单自然消失。
 */
export class FeishuAskFormStore {
  private readonly sessions = new Map<number, Map<string, FeishuPendingAsk>>();

  set(sessionId: number, requestId: string, questions: Array<Record<string, unknown>>, senderOpenId: string): void {
    let bucket = this.sessions.get(sessionId);
    if (bucket == null) {
      bucket = new Map();
      this.sessions.set(sessionId, bucket);
    }
    bucket.set(requestId, {
      sessionId,
      requestId,
      questions: [...questions],
      senderOpenId,
    });
  }

  get(sessionId: number, requestId: string): FeishuPendingAsk | null {
    return this.sessions.get(sessionId)?.get(requestId) ?? null;
  }

  /** @returns 是否真的删掉了一组仍在的提问。 */
  remove(sessionId: number, requestId: string): boolean {
    const bucket = this.sessions.get(sessionId);
    if (bucket == null) return false;
    const removed = bucket.delete(requestId);
    if (bucket.size === 0) this.sessions.delete(sessionId);
    return removed;
  }

  clearSession(sessionId: number): void {
    this.sessions.delete(sessionId);
  }

  /** 按登记顺序返回，供同一张卡上堆多个 form。 */
  list(sessionId: number): FeishuPendingAsk[] {
    const bucket = this.sessions.get(sessionId);
    if (bucket == null) return [];
    return [...bucket.values()];
  }
}
