<template>
  <div class="agent-selector">
    <!-- Header -->
    <div class="selector-header" @click="toggleCollapse">
      <div class="header-left">
        <el-icon class="collapse-icon" :class="{ collapsed }"><ArrowDown /></el-icon>
        <span class="header-title" v-if="!collapsed || !selectedAgent">选择智能体</span>
        <template v-if="collapsed && selectedAgent">
          <el-avatar :size="22" :src="resolveAvatarUrl(selectedAgent.avatarUrl)" class="collapsed-avatar">{{ selectedAgent.name?.charAt(0) }}</el-avatar>
          <span class="collapsed-name">{{ selectedAgent.name }}</span>
        </template>
      </div>
      <button v-if="collapsed && selectedAgent" class="change-btn" @click.stop="expand">更换</button>
    </div>

    <!-- Agent grid -->
    <div v-if="!collapsed" class="agent-scroll">
      <!-- 团队共享分区：管理员上架的推荐 Agent，含推荐语与缺依赖角标 -->
      <template v-if="sharedAgents.length > 0">
        <div class="group-label">团队共享</div>
        <div class="agent-grid shared-grid">
          <div
            v-for="shared in sharedAgents"
            :key="`shared-${shared.agentId}`"
            class="agent-card shared-card"
            :class="{ selected: String(shared.agentId) === String(selectedAgentId) }"
            @click="selectSharedAgent(shared)"
          >
            <el-avatar :size="32" :src="resolveAvatarUrl(shared.avatarUrl)" class="agent-avatar shared-avatar">{{ shared.name?.charAt(0) }}</el-avatar>
            <div class="agent-info">
              <span class="agent-name">
                {{ shared.name }}
                <el-tooltip :content="sharedIssueText(shared)" :disabled="!hasSharedIssues(shared)" placement="top">
                  <el-icon v-if="hasSharedIssues(shared)" class="issue-badge"><WarningFilled /></el-icon>
                </el-tooltip>
              </span>
              <el-tooltip :content="shared.note || shared.description || 'AI Agent'" :disabled="!(shared.note && shared.note.length > 30)" placement="top">
                <span class="agent-desc shared-desc">{{ shared.note || shared.description || 'AI Agent' }}</span>
              </el-tooltip>
            </div>
          </div>
        </div>
      </template>

      <div class="agent-grid">
        <div
          v-for="agent in filteredAgents"
          :key="agent.id"
          class="agent-card"
          :class="{ selected: String(agent.id) === String(selectedAgentId) }"
          @click="selectAgent(agent)"
        >
          <el-avatar :size="32" :src="resolveAvatarUrl(agent.avatarUrl)" class="agent-avatar">{{ agent.name?.charAt(0) }}</el-avatar>
          <div class="agent-info">
            <span class="agent-name">{{ agent.name }}</span>
            <el-tooltip :content="agent.description || 'AI Agent'" :disabled="!(agent.description && agent.description.length > 30)" placement="top">
              <span class="agent-desc">{{ agent.description || 'AI Agent' }}</span>
            </el-tooltip>
          </div>
        </div>
        <div v-if="agentStore.error" class="empty-agents">
          <span>加载失败</span>
          <button class="retry-btn" type="button" @click.stop="agentStore.fetchAgents()">重试</button>
        </div>
        <div v-else-if="filteredAgents.length === 0 && sharedAgents.length === 0" class="empty-agents">暂无可用智能体</div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { ArrowDown, WarningFilled } from '@element-plus/icons-vue'
import { useAgentStore, type Agent, type SharedAgent } from '../../stores/agent'
import { resolveAvatarUrl } from '../../utils/avatar'

const props = defineProps<{
  selectedAgentId: string | null
}>()

const emit = defineEmits<{
  'update:selectedAgentId': [id: string | null]
}>()

const agentStore = useAgentStore()
const collapsed = ref(false)

const filteredAgents = computed(() => agentStore.agents)
const sharedAgents = computed(() => agentStore.sharedAgents)

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

// 缺依赖的共享 Agent 仍可选中（技能/MCP 缺失只降级能力，不阻断建会话）
function selectSharedAgent(shared: SharedAgent) {
  emit('update:selectedAgentId', String(shared.agentId))
  collapsed.value = true
}

function hasSharedIssues(shared: SharedAgent): boolean {
  return shared.missingSkills.length > 0 || shared.mcpIssues.length > 0
}

function sharedIssueText(shared: SharedAgent): string {
  const parts: string[] = []
  if (shared.missingSkills.length > 0) parts.push(`缺少技能：${shared.missingSkills.join('、')}`)
  if (shared.mcpIssues.length > 0) parts.push(`MCP 异常：${shared.mcpIssues.join('、')}`)
  return parts.join('；')
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
  background: var(--aw-primary-hover);
}

.agent-scroll {
  max-height: 280px;
  overflow-y: auto;
  padding: 4px 0;
  scrollbar-width: none;
}
.agent-scroll::-webkit-scrollbar {
  display: none;
}

.group-label {
  font-size: var(--aw-text-micro);
  color: var(--aw-ink-muted-80);
  font-weight: 500;
  padding: 4px 2px 6px;
  display: flex;
  align-items: center;
  gap: 6px;
}
.group-label::after {
  content: '';
  flex: 1;
  height: 1px;
  background: var(--aw-hairline);
}

.agent-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 6px;
  padding: 4px 0;
}

.shared-card {
  border-color: var(--aw-primary-lighter, var(--aw-hairline));
}
.shared-avatar {
  outline: 1.5px solid var(--aw-primary);
  outline-offset: -1.5px;
}
.shared-desc {
  color: var(--aw-primary);
}
.issue-badge {
  font-size: 12px;
  color: var(--el-color-warning);
  vertical-align: -2px;
  margin-left: 2px;
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
  box-shadow: 0 2px 8px var(--aw-primary-hover);
}

.agent-card.selected {
  border-color: var(--aw-primary);
  background: var(--aw-primary-soft);
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
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
}

.retry-btn {
  border: none;
  background: none;
  color: var(--aw-primary);
  cursor: pointer;
  font-size: var(--aw-text-fine);
  padding: 2px 8px;
  border-radius: var(--aw-radius-xs);
}

.retry-btn:hover {
  background: var(--aw-primary-lighter);
}
</style>
