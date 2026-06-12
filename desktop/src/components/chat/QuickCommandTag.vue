<template>
  <span class="quick-command-tag" :class="`tag-${type}`">
    {{ name }}
  </span>
</template>

<script setup lang="ts">
defineProps<{
  type: 'skill' | 'command'
  name: string
}>()
</script>

<style scoped>
.quick-command-tag {
  display: inline-flex;
  align-items: center;
  padding: 1px 8px;
  border-radius: 999px;
  font-weight: 500;
  line-height: 1.4;
  vertical-align: baseline;
  white-space: nowrap;
}

.tag-skill {
  background: rgba(0, 102, 204, 0.12);
  color: var(--aw-primary);
}

.tag-command {
  background: rgba(128, 0, 255, 0.12);
  color: #7c3aed;
}

:root[data-theme="dark"] .tag-skill {
  background: rgba(0, 102, 204, 0.2);
  color: #5b9bd5;
}

:root[data-theme="dark"] .tag-command {
  background: rgba(128, 0, 255, 0.2);
  color: #a78bfa;
}
</style>
