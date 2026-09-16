<template>
  <div class="agent-chip-wrap">
    <!-- Desktop popover: button is the popper reference -->
    <el-popover
      v-if="!isMobile"
      v-model:visible="pickerVisible"
      trigger="click"
      :width="320"
      placement="top-start"
      popper-class="agent-chip-popper"
      :show-arrow="false"
    >
      <template #reference>
        <button
          type="button"
          class="agent-chip"
          :class="{ empty: !selectedAgent, warn: !selectedAgent }"
          :disabled="disabled"
        >
          <el-avatar v-if="selectedAgent" :size="18" :src="resolveAvatarUrl(selectedAgent.avatarUrl)" class="chip-avatar">
            {{ selectedAgent.name?.charAt(0) }}
          </el-avatar>
          <el-icon v-else :size="14"><User /></el-icon>
          <span class="chip-label">{{ selectedAgent?.name || '选择智能体' }}</span>
          <el-icon class="chip-caret" :size="12"><ArrowDown /></el-icon>
        </button>
      </template>
      <div class="agent-picker">
        <el-input v-model="filter" size="small" placeholder="搜索智能体" clearable class="agent-filter" />
        <div class="agent-list">
          <button
            v-for="agent in filteredAgents"
            :key="agent.id"
            type="button"
            class="agent-row"
            :class="{ selected: String(agent.id) === String(selectedAgentId) }"
            @click="selectAgent(agent)"
          >
            <el-avatar :size="28" :src="resolveAvatarUrl(agent.avatarUrl)">{{ agent.name?.charAt(0) }}</el-avatar>
            <div class="agent-row-info">
              <span class="agent-row-name">{{ agent.name }}</span>
              <span class="agent-row-desc">{{ agent.description || 'AI Agent' }}</span>
            </div>
          </button>
          <div v-if="filteredAgents.length === 0" class="agent-empty">暂无可用智能体</div>
        </div>
      </div>
    </el-popover>

    <!-- Mobile: chip + bottom sheet -->
    <template v-else>
      <button
        type="button"
        class="agent-chip"
        :class="{ empty: !selectedAgent, warn: !selectedAgent }"
        :disabled="disabled"
        @click="openPicker"
      >
        <el-avatar v-if="selectedAgent" :size="18" :src="resolveAvatarUrl(selectedAgent.avatarUrl)" class="chip-avatar">
          {{ selectedAgent.name?.charAt(0) }}
        </el-avatar>
        <el-icon v-else :size="14"><User /></el-icon>
        <span class="chip-label">{{ selectedAgent?.name || '选择智能体' }}</span>
        <el-icon class="chip-caret" :size="12"><ArrowDown /></el-icon>
      </button>
      <el-drawer
        v-model="pickerVisible"
        direction="btt"
        size="min(60vh, 420px)"
        :with-header="true"
        title="选择智能体"
      >
        <el-input v-model="filter" size="small" placeholder="搜索智能体" clearable class="agent-filter" />
        <div class="agent-list">
          <button
            v-for="agent in filteredAgents"
            :key="agent.id"
            type="button"
            class="agent-row"
            :class="{ selected: String(agent.id) === String(selectedAgentId) }"
            @click="selectAgent(agent)"
          >
            <el-avatar :size="28" :src="resolveAvatarUrl(agent.avatarUrl)">{{ agent.name?.charAt(0) }}</el-avatar>
            <div class="agent-row-info">
              <span class="agent-row-name">{{ agent.name }}</span>
              <span class="agent-row-desc">{{ agent.description || 'AI Agent' }}</span>
            </div>
          </button>
          <div v-if="filteredAgents.length === 0" class="agent-empty">暂无可用智能体</div>
        </div>
      </el-drawer>
    </template>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { ArrowDown, User } from '@element-plus/icons-vue'
import { useAgentStore, type Agent } from '../../stores/agent'
import { resolveAvatarUrl } from '../../utils/avatar'

const props = defineProps<{
  selectedAgentId: string | null
  disabled?: boolean
  isMobile?: boolean
}>()

const emit = defineEmits<{
  'update:selectedAgentId': [id: string | null]
}>()

const agentStore = useAgentStore()
const pickerVisible = ref(false)
const filter = ref('')

const selectedAgent = computed(() => {
  if (!props.selectedAgentId) return null
  return agentStore.agents.find(a => String(a.id) === String(props.selectedAgentId)) || null
})

const filteredAgents = computed(() => {
  const q = filter.value.trim().toLowerCase()
  if (!q) return agentStore.agents
  return agentStore.agents.filter(a =>
    a.name?.toLowerCase().includes(q) || a.description?.toLowerCase().includes(q)
  )
})

onMounted(async () => {
  if (agentStore.agents.length === 0) {
    await agentStore.fetchAgents()
  }
})

function openPicker() {
  if (props.disabled) return
  pickerVisible.value = true
}

function selectAgent(agent: Agent) {
  emit('update:selectedAgentId', String(agent.id))
  pickerVisible.value = false
  filter.value = ''
}
</script>

<style scoped>
.agent-chip-wrap {
  position: relative;
  display: inline-flex;
}

.agent-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 32px;
  max-width: 160px;
  padding: 0 10px;
  border-radius: var(--aw-radius-pill);
  border: 1px solid var(--aw-hairline);
  background: var(--aw-canvas-parchment);
  color: var(--aw-ink);
  font-size: var(--aw-text-fine);
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s;
  white-space: nowrap;
}

.agent-chip:hover:not(:disabled) {
  border-color: var(--aw-primary);
}

.agent-chip.warn {
  border-color: var(--aw-warning);
  color: var(--aw-warning);
  background: color-mix(in srgb, var(--aw-warning) 8%, transparent);
}

.agent-chip:disabled {
  opacity: 0.55;
  cursor: default;
}

.chip-avatar {
  flex-shrink: 0;
  background: var(--aw-primary);
  color: var(--aw-on-primary);
  font-size: 9px;
  font-weight: 600;
}

.chip-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.chip-caret {
  flex-shrink: 0;
  color: var(--aw-ink-muted-48);
}

.agent-picker {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.agent-filter {
  flex-shrink: 0;
}

.agent-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 280px;
  overflow-y: auto;
}

.agent-row {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 8px 10px;
  border: none;
  border-radius: var(--aw-radius-sm);
  background: transparent;
  cursor: pointer;
  text-align: left;
}

.agent-row:hover {
  background: var(--aw-surface-hover);
}

.agent-row.selected {
  background: var(--aw-primary-lighter);
}

.agent-row-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.agent-row-name {
  font-size: var(--aw-text-caption);
  font-weight: 500;
  color: var(--aw-ink);
}

.agent-row-desc {
  font-size: var(--aw-text-micro);
  color: var(--aw-ink-muted-48);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.agent-empty {
  padding: 20px;
  text-align: center;
  color: var(--aw-ink-muted-48);
  font-size: var(--aw-text-fine);
}

@media (pointer: coarse), (max-width: 768px) {
  .agent-chip {
    height: 32px;
    max-width: 148px;
    padding: 0 8px;
    gap: 5px;
  }

  .agent-chip.warn {
    /* 移动端弱化空态强调，避免整条工具条被橙色抢焦点 */
    border-color: color-mix(in srgb, var(--aw-warning) 45%, var(--aw-hairline));
    color: var(--aw-warning);
    background: color-mix(in srgb, var(--aw-warning) 5%, transparent);
  }
}
</style>
