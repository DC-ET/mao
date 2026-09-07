<script setup lang="ts">
import AssistantMark from './AssistantMark.vue';

defineProps<{
  agentAvatarUrl?: string | null;
  visible: boolean;
  position: 'right' | 'left';
  running: boolean;
  attention: boolean;
}>();

const emit = defineEmits<{ click: [] }>();
</script>

<template>
  <button
    v-if="visible"
    class="mao-launcher"
    :data-pos="position"
    type="button"
    :aria-label="running ? 'Mao 助手，正在处理' : attention ? 'Mao 助手，有新消息' : '打开 Mao 助手'"
    title="Mao 助手"
    @click="emit('click')"
  >
    <span v-if="running" class="mao-launcher__spinner" aria-hidden="true" />
    <img v-if="agentAvatarUrl" class="mao-agent-avatar" :src="agentAvatarUrl" alt="" />
    <AssistantMark v-else />
    <span v-if="attention" class="mao-launcher__dot" aria-hidden="true" />
  </button>
</template>
