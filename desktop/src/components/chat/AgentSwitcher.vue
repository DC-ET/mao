<template>
  <el-popover
    ref="popoverRef"
    trigger="click"
    width="auto"
    placement="left-start"
    popper-class="agent-switch-popper"
    :popper-style="popperStyle"
    @before-enter="ensureAgents"
  >
    <template #reference>
      <button type="button" class="agent-switch-trigger" title="切换智能体">
        <slot />
      </button>
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
          :title="agent.name"
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
}>()

const emit = defineEmits<{
  select: [agentId: string]
}>()

const popoverRef = ref()
const agentStore = useAgentStore()
const filter = ref('')

// 外壳按内容收缩。min/max 含 12px 内边距和 1px 边框，比内容区多 26px
const popperStyle = {
  width: 'max-content',
  minWidth: 'min(206px, calc(100vw - 16px))',
  maxWidth: 'min(346px, calc(100vw - 16px))',
}

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
.agent-switch-trigger {
  display: flex;
  justify-content: flex-start;
  width: 100%;
  margin: 0;
  padding: 4px 6px 4px 0;
  border: none;
  border-radius: var(--aw-radius-sm);
  background: transparent;
  color: inherit;
  cursor: pointer;
  text-align: left;
}

.agent-switch-trigger:hover {
  background: var(--aw-canvas-parchment);
}

.agent-switcher {
  display: flex;
  flex-direction: column;
  gap: 8px;
  /* 宽度跟着最长名称走。搜索框 width:0 + min-width:100%，不参与撑宽 */
  width: max-content;
  min-width: min(180px, 100%);
  max-width: 100%;
}

.agent-filter {
  flex-shrink: 0;
  width: 0;
  min-width: 100%;
}

.agent-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  width: 100%;
  min-width: 0;
  max-height: 280px;
  overflow-y: auto;
}

.agent-row {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  min-width: 0;
  box-sizing: border-box;
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
  min-width: 0;
  overflow: hidden;
  font-size: var(--aw-text-caption);
  color: var(--aw-body);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.agent-empty {
  padding: 16px;
  text-align: center;
  color: var(--aw-ink-muted-48);
  font-size: var(--aw-text-fine);
}
</style>
