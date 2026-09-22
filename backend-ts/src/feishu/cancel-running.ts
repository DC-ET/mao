/**
 * 进度卡「取消任务」的终态策略。
 * 已有 AgentLoop（含崩溃恢复续跑）时只靠取消标志收尾，不提前落 CANCELLED：
 * 提前终态会删进度卡、给未完成工具补占位，并且恢复路径没有飞书 busy 标记，
 * 新消息会与仍在跑的循环并行。
 * 仅当内存里没有执行（DB 残留 RUNNING/RESUMING）时才补写终态并排空队列。
 */
export async function persistFeishuCancelIfIdle(options: {
  sessionId: number;
  hadLoop: boolean;
  persistCancelledIfActive: (sessionId: number) => Promise<boolean>;
  drainNextIfPending: (sessionId: number) => Promise<void>;
}): Promise<boolean> {
  if (options.hadLoop) return true;
  const persisted = await options.persistCancelledIfActive(options.sessionId);
  if (persisted) {
    void options.drainNextIfPending(options.sessionId).catch((error) => {
      console.error(`飞书取消后队列接力失败, sessionId=${options.sessionId}`, error);
    });
  }
  return persisted;
}
