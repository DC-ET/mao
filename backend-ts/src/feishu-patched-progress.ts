import * as Lark from '@larksuiteoapi/node-sdk';
import { createFeishuPatchedProgress, type FeishuProgressHandle } from './feishu/patched-progress.js';
import type { FeishuCardProgress } from './feishu/card-progress-listener.js';
import { buildFeishuProgressCard } from './feishu/progress-card.js';
import type { FeishuActiveProgressRegistry } from './feishu/active-progress.js';
import type { FeishuAskFormStore } from './feishu/ask-form-store.js';
import type { MysqlFeishuCardSnapshotRepository } from './feishu/card-snapshot.repository.js';
import type { BackgroundSubagentManager } from './harness/delegate/background-subagent-manager.js';
import type { FeedbackDbLookup } from './feedback/feedback.service.js';

export interface PatchedProgressDeps {
  feishuActiveProgress: FeishuActiveProgressRegistry;
  feishuAskFormStore: FeishuAskFormStore;
  feishuCardSnapshotRepo: MysqlFeishuCardSnapshotRepository;
  backgroundSubagentManager: BackgroundSubagentManager;
  feedbackMessageLookup: FeedbackDbLookup;
}

export function createPatchedProgressHelper(deps: PatchedProgressDeps) {
  const { feishuActiveProgress, feishuAskFormStore, feishuCardSnapshotRepo, backgroundSubagentManager, feedbackMessageLookup } = deps;

  return (
    client: Lark.Client,
    cardMessageId: string,
    sessionId: number,
    cancelAction: { sessionId: number; sender: string; botId?: number } | null,
    startedAtMs: number,
    sessionDetailUrl?: string,
    seed?: { round?: number; content?: string },
    botId?: number,
  ): FeishuCardProgress => {
    const gate: { progress: FeishuProgressHandle | null } = { progress: null };
    const progress = createFeishuPatchedProgress({
      listAsks: () => (
        gate.progress != null && feishuActiveProgress.current(sessionId) === gate.progress
          ? feishuAskFormStore.list(sessionId)
          : []
      ),
      clearAsks: () => {
        if (gate.progress != null && feishuActiveProgress.current(sessionId) === gate.progress) {
          feishuAskFormStore.clearSession(sessionId);
        }
      },
      patch: async (card) => {
        await client.im.v1.message.patch({ path: { message_id: cardMessageId }, data: { content: JSON.stringify(card) } });
      },
      buildCard: ({ status, round, content, tools, subagents, pendingAsks, elapsedMs, disliked }) => buildFeishuProgressCard(
        status, round, content, tools, cancelAction ?? undefined, elapsedMs, sessionDetailUrl, pendingAsks, disliked, subagents,
      ),
      loadSubagents: async () => {
        const running = await backgroundSubagentManager.listRunning(sessionId);
        return running.map((subagent) => ({
          taskId: subagent.taskId,
          agentType: subagent.agentType,
          title: subagent.title,
          status: subagent.status,
          round: subagent.round,
        }));
      },
      persistTerminal: botId == null ? undefined : async ({ round, content, elapsedMs, messageId }) => {
        const terminalMessageId = messageId ?? await feedbackMessageLookup.findLatestAssistantMessageId(sessionId);
        if (terminalMessageId == null) {
          console.warn(`飞书完成卡快照跳过: 终态时未找到ASSISTANT消息, sessionId=${sessionId}, cardMessageId=${cardMessageId}`);
          return;
        }
        await feishuCardSnapshotRepo.upsert({
          cardMessageId, sessionId, botId, messageId: terminalMessageId,
          status: 'COMPLETED', round, elapsedMs: elapsedMs ?? 0, content,
        });
      },
      startedAtMs,
      seed: { status: 'RUNNING', round: seed?.round ?? 0, content: seed?.content ?? '', tools: [] },
    });
    gate.progress = progress;
    feishuActiveProgress.bind(sessionId, cancelAction?.sender ?? '', progress, cardMessageId);
    return progress;
  };
}
