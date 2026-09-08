<script setup lang="ts">
import { computed } from 'vue';
import type { PageHighlightTarget } from '../page';

const props = defineProps<{ target: PageHighlightTarget | null }>();

const style = computed(() => {
  const rect = props.target?.rect;
  if (!rect) return {};
  return {
    left: `${rect.x}px`,
    top: `${rect.y}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
  };
});
</script>

<template>
  <div v-if="target" class="mao-page-highlight" :style="style" aria-hidden="true">
    <span class="mao-page-highlight__label">{{ target.label }}</span>
  </div>
</template>
