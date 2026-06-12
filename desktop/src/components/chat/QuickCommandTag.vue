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
  padding: 2px 8px;
  border-radius: 10px;
  font-weight: 500;
  line-height: 1.4;
  vertical-align: baseline;
  white-space: nowrap;
}

.tag-skill {
  background: #0066cc;
  color: white;
}

.tag-command {
  background: #7c3aed;
  color: white;
}

:root[data-theme="dark"] .tag-skill {
  background: #5b9bd5;
  color: white;
}

:root[data-theme="dark"] .tag-command {
  background: #a78bfa;
  color: white;
}
</style>
