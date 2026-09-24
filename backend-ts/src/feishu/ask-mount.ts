import type { FeishuAskMount } from '../harness/tool/tool-dispatcher.js';
import type { FeishuActiveProgressRegistry } from './active-progress.js';
import type { FeishuAskFormStore } from './ask-form-store.js';

/**
 * 把一组提问挂到本会话正在执行的进度卡上。
 * 刷新成功才算挂上：调用方据此跳过「离线回来回答」的 Webhook。
 * 刷新失败时保留表单状态，后续进度更新仍会读到它；同时返回 false，离线用户仍可收到 Webhook。
 */
export function createFeishuAskMount(
  store: FeishuAskFormStore,
  progress: FeishuActiveProgressRegistry,
): FeishuAskMount {
  return {
    hasRunningProgress(sessionId: number): boolean {
      return progress.hasRunning(sessionId);
    },
    async mount(sessionId: number, requestId: string, questions: Array<Record<string, unknown>>): Promise<boolean> {
      if (!progress.hasRunning(sessionId)) return false;
      const senderOpenId = progress.senderOpenId(sessionId);
      // 按钮要带原发送者才能鉴权；空 sender 的表单谁都提交不了。
      if (senderOpenId === '') return false;
      store.set(sessionId, requestId, questions, senderOpenId);
      try {
        const refreshed = await progress.refresh(sessionId);
        if (!refreshed) {
          store.remove(sessionId, requestId);
          return false;
        }
        return true;
      } catch (error) {
        console.warn(`飞书提问表单刷新进度卡失败, sessionId=${sessionId}, requestId=${requestId}`, error);
        return false;
      }
    },
    clearRequest(sessionId: number, requestId: string): void {
      if (!store.remove(sessionId, requestId)) return;
      void progress.refresh(sessionId).catch((error) => {
        console.warn(`飞书提问表单清除后刷新失败, sessionId=${sessionId}, requestId=${requestId}`, error);
      });
    },
  };
}
