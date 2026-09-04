<script setup lang="ts">
import { computed, toRef } from 'vue';
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
  approve: [requestId: string, approved: boolean];
  answer: [requestId: string, answers: unknown[]];
  clearSelection: [];
  retry: [];
}>();

const phaseRef = toRef(() => props.ui.phase);
const running = computed(
  () => phaseRef.value === 'RUNNING' || phaseRef.value === 'RESUMING' || phaseRef.value === 'WAITING_APPROVAL',
);
const attention = computed(() => props.ui.unread > 0 || props.ui.phase === 'WAITING_APPROVAL' || props.ui.pendingQuestion != null);
</script>

<template>
  <Launcher
    :visible="ui.launcherVisible"
    :position="ui.position"
    :running="running"
    :attention="attention"
    @click="$emit('launcherClick')"
  />
  <ChatPanel
    :open="ui.panelOpen"
    :position="ui.position"
    :connected="ui.connected"
    :phase="ui.phase"
    :session-title="ui.sessionTitle"
    :session-error="ui.sessionError"
    :llm-retry-text="ui.llmRetryText"
    :messages="ui.messages"
    :pending-approval="ui.pendingApproval"
    :pending-question="ui.pendingQuestion"
    :quoted-selection="ui.quotedSelection"
    @close="$emit('close')"
    @new-session="$emit('newSession')"
    @send="(c) => $emit('send', c)"
    @stop="$emit('stop')"
    @approve="(id, ok) => $emit('approve', id, ok)"
    @answer="(id, a) => $emit('answer', id, a)"
    @clear-selection="$emit('clearSelection')"
    @retry="$emit('retry')"
  />
</template>
