import { nextTick, onMounted, onUnmounted, ref, watch, type Ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api } from '../api';
import { useSessionStore } from '../stores/session';
import { mapCompactionEvents, mapMessagesWithFileChanges } from '../utils/chatMessage';
import { scrollElementToMessage } from '../components/search/search-highlight';

export const LOCATE_FLASH_KEY = Symbol('locateFlash');

export interface LocatedMessagePage {
  messages?: Array<Record<string, unknown>>;
  hasMore?: boolean;
  nextBeforeMessageId?: number | null;
  hasNewer?: boolean;
  compactionEvents?: Array<Record<string, unknown>>;
}

/**
 * 只有 locateSessionId 等于本面板会话时才消费定位参数。
 * 消息已在列表里则只滚动；否则用 aroundMessageId 整表替换，不用尾部合并。
 */
export function useMessageLocate(options: {
  sessionId: () => string | null | undefined;
  container: Ref<HTMLElement | undefined | null>;
}) {
  const route = useRoute();
  const router = useRouter();
  const sessionStore = useSessionStore();
  const flashId = ref<string | null>(null);
  let flashTimer: number | null = null;
  let consuming = false;

  function flash(messageId: string) {
    flashId.value = messageId;
    if (flashTimer != null) window.clearTimeout(flashTimer);
    flashTimer = window.setTimeout(() => {
      if (flashId.value === messageId) flashId.value = null;
    }, 2000);
    void nextTick(() => {
      scrollElementToMessage(options.container.value, messageId);
    });
  }

  async function consume() {
    const messageId = route.query.locateMessageId;
    const locateSessionId = route.query.locateSessionId;
    const current = options.sessionId();
    if (typeof messageId !== 'string' || messageId === '' || typeof locateSessionId !== 'string') return;
    if (current == null || locateSessionId !== String(current)) return;
    if (consuming) return;
    consuming = true;
    const query = { ...route.query };
    delete query.locateMessageId;
    delete query.locateSessionId;
    try {
      await router.replace({ path: route.path, query });
      const existing = sessionStore.getMessages(current).some((message) => String(message.id) === messageId);
      if (existing) {
        flash(messageId);
        return;
      }
      const { data } = await api.get(`/sessions/${locateSessionId}/messages`, {
        params: { aroundMessageId: messageId, roundLimit: 5 },
        skipErrorToast: true,
      } as never);
      const page = (data ?? {}) as LocatedMessagePage;
      const { messages, allChanges } = mapMessagesWithFileChanges(page.messages ?? []);
      sessionStore.setHistoryAnchored(current, page.hasNewer === true);
      sessionStore.setMessages(current, messages);
      sessionStore.setFileChanges(current, allChanges);
      if (Array.isArray(page.compactionEvents)) {
        sessionStore.setCompactionEvents(current, mapCompactionEvents(page.compactionEvents));
      }
      sessionStore.setMessagePageState(
        current,
        page.hasMore === true,
        page.nextBeforeMessageId != null ? String(page.nextBeforeMessageId) : null,
      );
      flash(messageId);
    } catch {
      // 定位失败时留在当前列表，不把错误当成搜索失败
    } finally {
      consuming = false;
    }
  }

  watch(
    () => [route.query.locateMessageId, route.query.locateSessionId, options.sessionId()] as const,
    () => { void consume(); },
  );
  onMounted(() => { void consume(); });
  onUnmounted(() => {
    if (flashTimer != null) window.clearTimeout(flashTimer);
  });

  return { flashId };
}
