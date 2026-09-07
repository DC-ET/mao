<script setup lang="ts">
import { computed, toRef } from 'vue';
import type { WsAskUserQuestionAnswer } from '@mao/contracts';
import type { UiState } from '../controller';
import Launcher from './Launcher.vue';
import ChatPanel from './ChatPanel.vue';

const props = defineProps<{ ui: UiState }>();

defineEmits<{
  launcherClick: [];
  close: [];
  newSession: [];
  send: [content: string];
  stop: [];
  answer: [requestId: string, answers: WsAskUserQuestionAnswer[]];
  clearSelection: [];
  retry: [];
}>();

const phaseRef = toRef(() => props.ui.phase);
// embed 会话固定为 CLOUD，无工具审批环节，故不含 WAITING_APPROVAL
const running = computed(() => phaseRef.value === 'RUNNING' || phaseRef.value === 'RESUMING');
const attention = computed(() => props.ui.unread > 0 || props.ui.pendingQuestion != null);
</script>

<template>
  <Launcher
    :visible="ui.launcherVisible"
    :agent-avatar-url="ui.agentAvatarUrl"
    :position="ui.position"
    :running="running"
    :attention="attention"
    @click="$emit('launcherClick')"
  />
  <ChatPanel
    :open="ui.panelOpen"
    :agent-avatar-url="ui.agentAvatarUrl"
    :position="ui.position"
    :connected="ui.connected"
    :phase="ui.phase"
    :session-title="ui.sessionTitle"
    :session-error="ui.sessionError"
    :llm-retry-text="ui.llmRetryText"
    :messages="ui.messages"
    :pending-question="ui.pendingQuestion"
    :question-submitting="ui.questionSubmitting"
    :quoted-selection="ui.quotedSelection"
    @close="$emit('close')"
    @new-session="$emit('newSession')"
    @send="(c) => $emit('send', c)"
    @stop="$emit('stop')"
    @answer="(id, a) => $emit('answer', id, a)"
    @clear-selection="$emit('clearSelection')"
    @retry="$emit('retry')"
  />
</template>
