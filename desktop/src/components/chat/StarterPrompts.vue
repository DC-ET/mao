<template>
  <div class="starter-prompts" :class="{ 'is-mobile': isMobile }">
    <button
      v-for="(item, idx) in visibleItems"
      :key="idx"
      type="button"
      class="starter-item"
      @click="emit('select', item.text)"
    >
      <el-icon :size="14" class="starter-icon"><component :is="item.icon" /></el-icon>
      <span class="starter-text">{{ item.text }}</span>
    </button>
  </div>
</template>

<script setup lang="ts">
import { computed, type Component } from 'vue'
import { Document, List, MagicStick, Connection } from '@element-plus/icons-vue'

const props = defineProps<{
  isMobile?: boolean
  maxItems?: number
}>()

const emit = defineEmits<{
  select: [text: string]
}>()

const ALL_ITEMS: Array<{ icon: Component; text: string }> = [
  { icon: Connection, text: '审查最近的代码变更并给出风险清单' },
  { icon: List, text: '把这份需求拆成可执行的 TODO' },
  { icon: Document, text: '生成一份本周进展摘要' },
  { icon: MagicStick, text: '用一句话介绍当前工作区' },
]

const visibleItems = computed(() => {
  const max = props.maxItems ?? (props.isMobile ? 2 : 4)
  return ALL_ITEMS.slice(0, max)
})
</script>

<style scoped>
.starter-prompts {
  display: flex;
  flex-direction: column;
  gap: 2px;
  width: min(720px, 100%);
  margin: 18px auto 0;
}

.starter-item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  min-height: 38px;
  padding: 8px 10px;
  border: none;
  border-radius: var(--aw-radius-sm);
  background: transparent;
  color: var(--aw-ink-muted-64);
  font-size: var(--aw-text-caption);
  cursor: pointer;
  text-align: left;
  transition: background 0.15s, color 0.15s;
}

.starter-item:hover {
  background: var(--aw-canvas-parchment);
  color: var(--aw-ink);
}

.starter-icon {
  flex-shrink: 0;
  color: var(--aw-ink-muted-40);
}

.starter-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

@media (max-width: 768px) {
  .starter-prompts {
    margin-top: 14px;
    width: 100%;
  }

  .starter-item {
    min-height: 36px;
    padding: 8px 4px;
    gap: 8px;
    font-size: var(--aw-text-fine);
  }
}
</style>
