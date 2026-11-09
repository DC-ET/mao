<script setup lang="ts">
import type { IconDef } from './icons';

defineProps<{ icon: IconDef; size?: number }>();
</script>

<template>
  <svg
    class="mao-icon"
    :width="size ?? 14"
    :height="size ?? 14"
    viewBox="0 0 1024 1024"
    aria-hidden="true"
  >
    <path v-for="(d, i) in icon.paths" :key="i" fill="currentColor" :d="d" />
  </svg>
</template>
