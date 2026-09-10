<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { WsAskUserQuestionAnswer } from '@mao/contracts';
import type { ChatMessage, PendingQuestion } from '../types';
import type { PageActionLogEntry, PageAuthorizationLevel, PageConfirmRequest } from '../page';
import AssistantMark from './AssistantMark.vue';
import MessageBubble from './MessageBubble.vue';
import Composer from './Composer.vue';
import QuestionCard from './QuestionCard.vue';
import PageActionPanel from './PageActionPanel.vue';

const props = defineProps<{
  open: boolean;
  agentAvatarUrl?: string | null;
  position: 'right' | 'left';
  connected: boolean;
  phase: string | null;
  sessionTitle: string;
  sessionError: string | null;
  llmRetryText: string | null;
  messages: ChatMessage[];
  pendingQuestion: PendingQuestion | null;
  questionSubmitting: boolean;
  quotedSelection: string | null;
  pageAuthorization: PageAuthorizationLevel;
  pageTaskActive: boolean;
  pageConfirm: PageConfirmRequest | null;
  pageLogs: PageActionLogEntry[];
}>();

const emit = defineEmits<{
  close: [];
  newSession: [];
  send: [content: string];
  stop: [];
  answer: [requestId: string, answers: WsAskUserQuestionAnswer[]];
  clearSelection: [];
  retry: [];
  setPageAuthorization: [level: PageAuthorizationLevel];
  resolvePageConfirm: [id: string, approved: boolean];
}>();

const listEl = ref<HTMLElement | null>(null);
const composerEl = ref<InstanceType<typeof Composer> | null>(null);

// embed 会话固定为 CLOUD，无工具审批环节，故不含 WAITING_APPROVAL
const running = computed(() => props.phase === 'RUNNING' || props.phase === 'RESUMING');
const isEmpty = computed(() => props.messages.length === 0);
/** header 副标题：运行态优先，其次连接态（连接指示灯颜色只表示已鉴权） */
const statusText = computed(() => (running.value ? '正在处理…' : props.connected ? '在线' : '连接中…'));

/** 距底部阈值内才自动跟随，避免打断用户上滚回看 */
const FOLLOW_THRESHOLD_PX = 40;

function scrollToBottom() {
  const el = listEl.value;
  if (el) el.scrollTop = el.scrollHeight;
}

watch(
  () => props.messages.map((m) => (m.role === 'assistant' ? m.content.length + m.thinking.length + m.toolCalls.length : 1)),
  () => {
    const el = listEl.value;
    // 计算必须在 DOM 更新前取旧的滚动位置：更新后 scrollHeight 已变大
    const nearBottom = !el || el.scrollHeight - el.scrollTop - el.clientHeight < FOLLOW_THRESHOLD_PX;
    if (!nearBottom) return;
    void nextTick(scrollToBottom);
  },
);

// 打开浮窗：滚到底并聚焦输入框（省掉用户一次点击）
watch(
  () => props.open,
  (v) => {
    if (!v) return;
    void nextTick(() => {
      scrollToBottom();
      composerEl.value?.focus();
    });
  },
  { immediate: true },
);

function onKeydown(e: KeyboardEvent) {
  // 不调 stopPropagation：SDK 挂在宿主 document 上监听，拦截会吞掉宿主页自己的 Escape 处理
  if (e.key !== 'Escape' || !props.open) return;
  if (composerEl.value?.isMenuOpen()) {
    composerEl.value.closeMenu();
    return;
  }
  emit('close');
}

onMounted(() => document.addEventListener('keydown', onKeydown));
onBeforeUnmount(() => document.removeEventListener('keydown', onKeydown));
</script>

<template>
  <div v-if="open" class="mao-panel" :data-pos="position" role="dialog" :aria-label="`${sessionTitle}对话`">
    <div class="mao-panel__header">
      <span class="mao-panel__avatar" aria-hidden="true">
        <img v-if="agentAvatarUrl" class="mao-agent-avatar" :src="agentAvatarUrl" alt="" />
        <AssistantMark v-else />
      </span>
      <span class="mao-panel__meta">
        <span class="mao-panel__title">{{ sessionTitle }}</span>
        <span class="mao-panel__status">
          <span class="mao-panel__conn" :class="{ 'mao-panel__conn--on': connected }" />
          {{ statusText }}
        </span>
      </span>
      <button class="mao-panel__btn" type="button" title="新对话" :disabled="running" @click="emit('newSession')">
        <svg viewBox="0 0 24 24"><path d="M19 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2Zm-2 10h-4v4h-2v-4H7v-2h4V7h2v4h4Z"/></svg>
      </button>
      <button class="mao-panel__btn" type="button" title="关闭" @click="emit('close')">
        <svg viewBox="0 0 24 24"><path d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
      </button>
    </div>

    <div ref="listEl" class="mao-messages" aria-live="polite">
      <MessageBubble v-for="m in messages" :key="m.id" :message="m" />
      <div v-if="isEmpty" class="mao-empty">
        <span class="mao-empty__icon" aria-hidden="true">
          <svg viewBox="0 0 24 24"><path d="M20 2H4a2 2 0 0 0-2 2v18l4-4h14a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2ZM7 9h10v2H7V9Zm7 5H7v-2h7v2Zm3-8H7V5h10v1Z"/></svg>
        </span>
        <span class="mao-empty__title">有什么可以帮你？</span>
        <span class="mao-empty__hint">直接提问，我会结合当前页面内容回答；选中页面上的文字即可带上引用。</span>
      </div>
    </div>

    <div v-if="llmRetryText" class="mao-banner mao-banner--info">{{ llmRetryText }}</div>
    <div v-if="sessionError" class="mao-banner mao-banner--error">
      <span>{{ sessionError }}</span>
      <button v-if="!running" class="mao-banner__retry" type="button" @click="emit('retry')">重试</button>
    </div>

    <QuestionCard
      v-if="pendingQuestion"
      :pending="pendingQuestion"
      :submitting="questionSubmitting"
      @submit="(id, answers) => emit('answer', id, answers)"
    />

    <PageActionPanel
      :confirm="pageConfirm"
      :logs="pageConfirm || pageTaskActive ? pageLogs : []"
      @confirm="(id, approved) => emit('resolvePageConfirm', id, approved)"
    />

    <Composer
      ref="composerEl"
      :running="running"
      :quoted-selection="quotedSelection"
      :connection-error="!connected"
      :page-authorization="pageAuthorization"
      @send="(c) => emit('send', c)"
      @stop="emit('stop')"
      @clear-selection="emit('clearSelection')"
      @set-page-authorization="(level) => emit('setPageAuthorization', level)"
    />
  </div>
</template>
