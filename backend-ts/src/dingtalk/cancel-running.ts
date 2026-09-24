/**
 * 进度卡「取消任务」与私聊 `---` 的终态策略。
 * 内存里已有循环时只靠取消标志收尾，不提前写 CANCELLED。
 * 仅当内存里没有执行、库里仍是 RUNNING/RESUMING 时才补写终态并排空队列。
 */
export async function persistDingtalkCancelIfIdle(options: {
  sessionId: number;
  hadLoop: boolean;
  persistCancelledIfActive: (sessionId: number) => Promise<boolean>;
  drainNextIfPending: (sessionId: number) => Promise<void>;
}): Promise<boolean> {
  if (options.hadLoop) return true;
  const persisted = await options.persistCancelledIfActive(options.sessionId);
  if (persisted) {
    void options.drainNextIfPending(options.sessionId).catch((error) => {
      console.error(`钉钉取消后队列接力失败, sessionId=${options.sessionId}`, error);
    });
  }
  return persisted;
}
