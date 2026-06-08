<template>
  <div class="agent-selector">
    <!-- Header -->
    <div class="selector-header" @click="toggleCollapse">
      <div class="header-left">
        <el-icon class="collapse-icon" :class="{ collapsed }"><ArrowDown /></el-icon>
        <span class="header-title" v-if="!collapsed || !selectedAgent">选择智能体</span>
        <template v-if="collapsed && selectedAgent">
          <el-avatar :size="22" class="collapsed-avatar">{{ selectedAgent.name?.charAt(0) }}</el-avatar>
          <span class="collapsed-name">{{ selectedAgent.name }}</span>
        </template>
      </div>
      <button v-if="collapsed && selectedAgent" class="change-btn" @click.stop="expand">更换</button>
    </div>

    <!-- Agent grid -->
    <div v-if="!collapsed" class="agent-grid">
      <div
        v-for="agent in filteredAgents"
        :key="agent.id"
        class="agent-card"
        :class="{ selected: String(agent.id) === String(selectedAgentId) }"
        @click="selectAgent(agent)"
      >
        <el-avatar :size="32" class="agent-avatar">{{ agent.name?.charAt(0) }}</el-avatar>
        <div class="agent-info">
          <span class="agent-name">{{ agent.name }}</span>
          <el-tooltip :content="agent.description || 'AI Agent'" :disabled="!(agent.description && agent.description.length > 30)" placement="top">
            <span class="agent-desc">{{ agent.description || 'AI Agent' }}</span>
          </el-tooltip>
        </div>
      </div>
      <div v-if="filteredAgents.length === 0" class="empty-agents">暂无可用智能体</div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { ArrowDown } from '@element-plus/icons-vue'
import { useAgentStore, type Agent } from '../../stores/agent'

const props = defineProps<{
  selectedAgentId: string | null
}>()

const emit = defineEmits<{
  'update:selectedAgentId': [id: string | null]
}>()

const agentStore = useAgentStore()
const collapsed = ref(false)

const filteredAgents = computed(() => agentStore.agents)

const selectedAgent = computed(() => {
  if (!props.selectedAgentId) return null
  return agentStore.agents.find(a => String(a.id) === String(props.selectedAgentId)) || null
})

onMounted(async () => {
  if (agentStore.agents.length === 0) {
    await agentStore.fetchAgents()
  }
})

function selectAgent(agent: Agent) {
  emit('update:selectedAgentId', String(agent.id))
  collapsed.value = true
}

function toggleCollapse() {
  collapsed.value = !collapsed.value
}

function expand() {
  collapsed.value = false
}
</script>

<style scoped>
.agent-selector {
  margin-bottom: 8px;
}

.selector-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  cursor: pointer;
  user-select: none;
  transition: background 0.15s;
  border-radius: var(--aw-radius-md);
}

.selector-header:hover {
  background: var(--aw-canvas-parchment);
}

.header-left {
  display: flex;
  align-items: center;
  gap: 6px;
}

.collapse-icon {
  font-size: 12px;
  color: var(--aw-ink-muted-48);
  transition: transform 0.2s;
}

.collapse-icon.collapsed {
  transform: rotate(-90deg);
}

.header-title {
  font-size: var(--aw-text-fine);
  color: var(--aw-ink-muted-80);
  font-weight: 500;
}

.collapsed-avatar {
  background: var(--aw-primary);
  color: var(--aw-on-primary);
  font-weight: 600;
  flex-shrink: 0;
  font-size: 10px;
}

.collapsed-name {
  font-size: var(--aw-text-fine);
  font-weight: 500;
  color: var(--aw-ink);
}

.change-btn {
  font-size: var(--aw-text-micro);
  color: var(--aw-primary);
  background: none;
  border: none;
  cursor: pointer;
  padding: 2px 6px;
  border-radius: var(--aw-radius-xs);
}

.change-btn:hover {
  background: rgba(0, 102, 204, 0.08);
}

.agent-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 6px;
  max-height: 240px;
  overflow-y: auto;
  padding: 4px 0;
}

.agent-card {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  background: var(--aw-canvas);
  border: 1.5px solid var(--aw-hairline);
  border-radius: var(--aw-radius-md);
  cursor: pointer;
  transition: border-color 0.15s, box-shadow 0.15s;
}

.agent-card:hover {
  border-color: var(--aw-primary);
  box-shadow: 0 2px 8px rgba(0, 102, 204, 0.08);
}

.agent-card.selected {
  border-color: var(--aw-primary);
  background: rgba(0, 102, 204, 0.05);
}

.agent-avatar {
  background: var(--aw-primary);
  color: var(--aw-on-primary);
  font-weight: 600;
  flex-shrink: 0;
}

.agent-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.agent-name {
  font-size: var(--aw-text-caption);
  font-weight: 500;
  color: var(--aw-ink);
}

.agent-desc {
  font-size: var(--aw-text-micro);
  color: var(--aw-ink-muted-48);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.empty-agents {
  grid-column: 1 / -1;
  text-align: center;
  padding: 24px;
  color: var(--aw-ink-muted-48);
  font-size: var(--aw-text-fine);
}

/* Scrollbar */
.agent-grid {
  scrollbar-width: none;
}

.agent-grid::-webkit-scrollbar {
  display: none;
}
</style>
