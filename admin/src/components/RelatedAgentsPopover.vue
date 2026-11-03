<template>
  <span v-if="agents.length === 0">0</span>
  <el-popover v-else placement="top" :width="260" trigger="hover">
    <template #reference>
      <span class="related-agents-trigger">{{ agents.length }}</span>
    </template>
    <div class="related-agents-list">
      <button
        v-for="agent in agents"
        :key="agent.id"
        type="button"
        class="related-agents-item"
        @click="goAgent(agent)"
      >
        <span :class="{ 'is-disabled': !agent.enabled }">{{ agent.name }}{{ agent.enabled ? '' : '（已停用）' }}</span>
      </button>
    </div>
  </el-popover>
</template>

<script setup lang="ts">
import { useRouter } from 'vue-router'
import type { RelatedAgent } from '../composables/useAgentRelations'

defineProps<{ agents: RelatedAgent[] }>()

const router = useRouter()

/** 点击 Agent 名直跳管理页并按名称过滤（AgentListView 读取 ?keyword= 预填）。 */
function goAgent(agent: RelatedAgent) {
  void router.push({ path: '/agents', query: { keyword: agent.name } })
}
</script>

<style scoped>
.related-agents-trigger {
  color: var(--el-color-primary);
  cursor: pointer;
}
.related-agents-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 260px;
  overflow: auto;
}
.related-agents-item {
  padding: 4px 6px;
  border: none;
  border-radius: 4px;
  background: transparent;
  text-align: left;
  font-size: 13px;
  color: var(--el-text-color-primary);
  cursor: pointer;
}
.related-agents-item:hover {
  background: var(--el-fill-color-light);
}
.related-agents-item .is-disabled {
  color: var(--el-text-color-secondary);
}
</style>
