<template>
  <aside class="library-sidebar">
    <el-input
      v-model="filterText"
      class="sidebar-search"
      placeholder="搜索 Agent 库"
      clearable
      size="small"
      aria-label="搜索 Agent 库"
    />
    <div class="lib-list">
      <button
        v-for="lib in filteredLibraries"
        :key="lib.agentId"
        type="button"
        class="lib-item"
        :class="{ 'is-active': lib.agentId === store.selectedAgentId }"
        :aria-label="`打开 ${lib.agentName} 的经验库（${lib.docCount} 篇）`"
        @click="store.selectAgent(lib.agentId)"
      >
        <span class="lib-top">
          <span class="status-dot" :class="lib.enabled ? 'is-on' : 'is-off'" :title="lib.enabled ? '已启用' : '已停用'" />
          <span class="lib-name" :title="lib.agentName">{{ lib.agentName }}</span>
        </span>
        <span class="lib-meta">
          <span>{{ lib.docCount }} 篇 · {{ formatSize(lib.totalBytes) }}</span>
          <span class="lib-time">{{ formatDate(lib.lastUpdatedAt) }}</span>
        </span>
      </button>
      <el-empty
        v-if="filteredLibraries.length === 0 && store.orphans.length === 0"
        description="暂无经验库；Agent 完成复杂任务后会自行沉淀"
        :image-size="60"
      />
    </div>
    <el-collapse v-if="store.orphans.length > 0" class="orphan-collapse">
      <el-collapse-item :title="`孤儿库（${store.orphans.length}）`">
        <div v-for="o in store.orphans" :key="o.agentId" class="lib-item is-orphan">
          <span class="lib-name" :title="`Agent #${o.agentId} 已删除，目录残留`">Agent #{{ o.agentId }}（已删除）</span>
          <span class="lib-meta">{{ o.docCount }} 篇 · {{ formatSize(o.totalBytes) }}</span>
        </div>
      </el-collapse-item>
    </el-collapse>
  </aside>
</template>

<script setup lang="ts">
import { computed, inject, ref } from 'vue'
import { EXPERIENCE_LIBRARY_KEY } from '../composables/useExperienceLibrary'
import { formatDate, formatSize } from '../experience-format'

const store = inject(EXPERIENCE_LIBRARY_KEY)!

const filterText = ref('')
const filteredLibraries = computed(() => {
  const kw = filterText.value.trim().toLowerCase()
  if (kw === '') return store.libraries
  return store.libraries.filter((lib) => lib.agentName.toLowerCase().includes(kw))
})
</script>

<style scoped>
.library-sidebar {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
}
.sidebar-search {
  flex-shrink: 0;
}
.lib-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  overflow-y: auto;
}
.lib-item {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px 10px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 6px;
  background: transparent;
  text-align: left;
  cursor: pointer;
  font: inherit;
  color: inherit;
}
.lib-item:hover {
  border-color: var(--el-color-primary-light-5);
  background: var(--el-fill-color-light);
}
.lib-item.is-active {
  border-color: var(--el-color-primary);
  background: var(--el-color-primary-light-9);
}
button.lib-item {
  width: 100%;
}
.lib-item.is-orphan {
  cursor: default;
  color: var(--el-text-color-secondary);
}
.lib-top {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}
.status-dot.is-on {
  background: var(--el-color-success);
}
.status-dot.is-off {
  background: var(--el-text-color-disabled);
}
.lib-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 600;
  font-size: 13px;
}
.lib-meta {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.orphan-collapse {
  border-top: 1px dashed var(--el-border-color-lighter);
}
</style>
