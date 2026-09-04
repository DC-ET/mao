<script setup lang="ts">
defineProps<{
  messages: unknown[];
  emptyHint: string;
}>();
</script>

<template>
  <div class="mao-messages">
    <slot />
    <div v-if="messages.length === 0" class="mao-empty">{{ emptyHint }}</div>
  </div>
</template>
