<script setup lang="ts">
defineProps<{
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
    aria-label="Mao 助手"
    @click="emit('click')"
  >
    <span v-if="running" class="mao-launcher__spinner" />
    <svg viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 5.94 2 10.8c0 2.62 1.32 4.98 3.44 6.6-.14 1.5-.7 3.06-1.7 4.36-.2.26.02.64.34.58 2.62-.44 4.6-1.54 5.86-2.44.66.1 1.36.16 2.06.16 5.52 0 10-3.94 10-8.8S17.52 2 12 2Z"/></svg>
    <span v-if="attention" class="mao-launcher__dot" />
  </button>
</template>
