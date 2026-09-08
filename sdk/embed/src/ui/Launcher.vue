<script setup lang="ts">
import { computed } from 'vue';
import AssistantMark from './AssistantMark.vue';

const props = defineProps<{
  agentAvatarUrl?: string | null;
  agentName?: string;
  visible: boolean;
  position: 'right' | 'left';
  running: boolean;
  attention: boolean;
  dragging?: boolean;
}>();

const emit = defineEmits<{ click: [event: MouseEvent] }>();
const labelName = computed(() => props.agentName?.trim() || 'Mao 助手');
</script>

<template>
  <button
    v-if="visible"
    class="mao-launcher"
    :class="{ 'mao-launcher--dragging': dragging }"
    :data-pos="position"
    type="button"
    :aria-label="running ? `${labelName}，正在处理` : attention ? `${labelName}，有新消息` : `打开 ${labelName}`"
    title="点击打开，拖动调整位置"
    @dragstart.prevent
    @click="emit('click', $event)"
  >
    <span v-if="running" class="mao-launcher__spinner" aria-hidden="true" />
    <img v-if="agentAvatarUrl" class="mao-agent-avatar" :src="agentAvatarUrl" alt="" />
    <AssistantMark v-else />
    <span v-if="attention" class="mao-launcher__dot" aria-hidden="true" />
  </button>
</template>
