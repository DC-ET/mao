<template>
  <el-popover
    ref="popoverRef"
    trigger="click"
    :width="300"
    placement="top-end"
    @before-enter="ensureAgents"
  >
    <template #reference>
      <span class="agent-name clickable" :class="{ compact }" :title="displayName || '切换智能体'">
        {{ label }}
      </span>
    </template>
    <div class="agent-switcher">
      <el-input v-model="filter" size="small" placeholder="搜索智能体" clearable class="agent-filter" />
      <div class="agent-list">
        <button
          v-for="agent in filteredAgents"
          :key="agent.id"
          type="button"
          class="agent-row"
          :class="{ selected: String(agent.id) === String(agentId ?? '') }"
          @click="handleSelect(agent)"
        >
          <img
            v-if="resolveAvatarUrl(agent.avatarUrl)"
            :src="resolveAvatarUrl(agent.avatarUrl)"
            alt=""
            class="row-avatar"
          />
          <span v-else class="row-avatar row-avatar-fallback">{{ agent.name?.charAt(0) }}</span>
          <span class="agent-row-name">{{ agent.name }}</span>
        </button>
        <div v-if="filteredAgents.length === 0" class="agent-empty">暂无可用智能体</div>
      </div>
    </div>
  </el-popover>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useAgentStore, type Agent } from '../../stores/agent'
import { resolveAvatarUrl } from '../../utils/avatar'

const props = defineProps<{
  agentId?: string | null
  agentName?: string | null
  /** 窄屏紧凑展示：与 ModelSelector 的 compact 同语义 */
  compact?: boolean
}>()

const emit = defineEmits<{
  select: [agentId: string]
}>()

const popoverRef = ref()
const agentStore = useAgentStore()
const filter = ref('')

const displayName = computed(() => {
  if (props.agentName) return props.agentName
  if (!props.agentId) return ''
  return agentStore.agents.find(a => String(a.id) === String(props.agentId))?.name || ''
})

const label = computed(() => displayName.value || '切换智能体')

const filteredAgents = computed(() => {
  const q = filter.value.trim().toLowerCase()
  if (!q) return agentStore.agents
  return agentStore.agents.filter(a =>
    a.name?.toLowerCase().includes(q) || a.description?.toLowerCase().includes(q)
  )
})

onMounted(async () => {
  await ensureAgents()
})

async function ensureAgents() {
  if (agentStore.agents.length === 0 && !agentStore.loading) {
    await agentStore.fetchAgents()
  }
}

function handleSelect(agent: Agent) {
  emit('select', String(agent.id))
  popoverRef.value?.hide()
  filter.value = ''
}
</script>

<style scoped>
.agent-name {
  font-size: var(--aw-text-fine);
  color: var(--aw-ink-muted-80);
  font-weight: 500;
  user-select: none;
}

.agent-name.clickable {
  cursor: pointer;
  padding: 2px 8px;
  border-radius: var(--aw-radius-xs);
  transition: background 0.15s;
}

.agent-name.clickable:hover {
  background: var(--aw-canvas-parchment);
}

.agent-name.compact {
  max-width: 120px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.agent-switcher {
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
  padding: 6px 10px;
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

.row-avatar {
  flex-shrink: 0;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  object-fit: cover;
  background: var(--aw-primary);
}

.row-avatar-fallback {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--aw-on-primary);
  font-size: 10px;
  font-weight: 600;
  line-height: 1;
}

.agent-row-name {
  font-size: var(--aw-text-caption);
  color: var(--aw-body);
}

.agent-empty {
  padding: 16px;
  text-align: center;
  color: var(--aw-ink-muted-48);
  font-size: var(--aw-text-fine);
}
</style>
