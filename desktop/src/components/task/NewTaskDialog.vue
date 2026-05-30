<template>
  <el-dialog
    :model-value="modelValue"
    title="新建任务"
    width="560px"
    class="new-task-dialog"
    @update:model-value="$emit('update:modelValue', $event)"
    @open="onOpen"
  >
    <!-- Step 1: Select agent -->
    <div v-if="!selectedAgent" class="dialog-section">
      <p class="section-label">选择智能体</p>
      <div class="agent-grid">
        <div
          v-for="agent in agents"
          :key="agent.id"
          class="agent-card"
          @click="selectedAgent = agent"
        >
          <el-avatar :size="36" class="agent-avatar">
            {{ agent.name?.charAt(0) }}
          </el-avatar>
          <div class="agent-info">
            <span class="agent-name">{{ agent.name }}</span>
            <span class="agent-desc">{{ agent.description || 'AI Agent' }}</span>
          </div>
        </div>
      </div>
    </div>

    <!-- Step 2: Select mode -->
    <div v-else class="dialog-section">
      <div class="selected-agent-bar">
        <el-avatar :size="28" class="agent-avatar-sm">
          {{ selectedAgent.name?.charAt(0) }}
        </el-avatar>
        <span class="selected-agent-name">{{ selectedAgent.name }}</span>
        <button class="change-btn" @click="selectedAgent = null">更换</button>
      </div>
      <p class="section-label">选择执行模式</p>
      <div class="mode-options">
        <div
          class="mode-card"
          :class="{ selected: selectedMode === 'CLOUD' }"
          @click="selectedMode = 'CLOUD'"
        >
          <el-icon :size="24"><Cloudy /></el-icon>
          <h4>云端模式</h4>
          <p>工具在服务器上执行，无需本地环境</p>
        </div>
        <div
          class="mode-card"
          :class="{ selected: selectedMode === 'LOCAL' }"
          @click="selectedMode = 'LOCAL'"
        >
          <el-icon :size="24"><Monitor /></el-icon>
          <h4>本地模式</h4>
          <p>工具在本地执行，需要桌面应用连接</p>
        </div>
      </div>
      <div v-if="selectedMode === 'LOCAL'" class="workspace-row">
        <el-button class="pill-btn" @click="selectWorkspace">
          {{ workspace ? workspace : '选择工作目录' }}
        </el-button>
      </div>
    </div>

    <template #footer>
      <el-button class="pill-btn" @click="close">取消</el-button>
      <el-button
        type="primary"
        class="pill-btn"
        :disabled="!selectedAgent || (selectedMode === 'LOCAL' && !workspace)"
        @click="confirm"
      >
        开始
      </el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { Cloudy, Monitor } from '@element-plus/icons-vue'
import { useSessionStore } from '../../stores/session'
import { useAgentStore, type Agent } from '../../stores/agent'

const props = defineProps<{
  modelValue: boolean
  defaultAgentId?: string
  defaultMode?: 'CLOUD' | 'LOCAL'
  defaultWorkspace?: string
}>()

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  created: [session: any]
}>()

const sessionStore = useSessionStore()
const agentStore = useAgentStore()

const agents = ref<Agent[]>([])
const selectedAgent = ref<Agent | null>(null)
const selectedMode = ref<'CLOUD' | 'LOCAL'>('CLOUD')
const workspace = ref('')

async function onOpen() {
  selectedAgent.value = null
  selectedMode.value = props.defaultMode || 'CLOUD'
  workspace.value = props.defaultWorkspace || ''
  if (agentStore.agents.length === 0) {
    await agentStore.fetchAgents()
  }
  agents.value = agentStore.agents

  // Pre-select agent from defaults
  if (props.defaultAgentId) {
    const match = agents.value.find(a => String(a.id) === String(props.defaultAgentId))
    if (match) selectedAgent.value = match
  }
}

async function selectWorkspace() {
  const isElectron = typeof window !== 'undefined' && (window as any).electronAPI
  if (isElectron) {
    const dir = await (window as any).electronAPI.selectDirectory()
    if (dir) workspace.value = dir
  }
}

async function confirm() {
  if (!selectedAgent.value) return
  const session = await sessionStore.createSession(
    selectedAgent.value.id,
    selectedMode.value,
    workspace.value || undefined
  )
  if (session) {
    emit('created', session)
  }
}

function close() {
  emit('update:modelValue', false)
}
</script>

<style scoped>
.dialog-section {
  min-height: 200px;
}

.section-label {
  margin: 0 0 12px;
  font-size: var(--aw-text-caption);
  font-weight: 500;
  color: var(--aw-ink-muted-80);
}

.agent-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 8px;
  max-height: 360px;
  overflow-y: auto;
}

.agent-card {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px;
  background: var(--aw-canvas);
  border: 1px solid var(--aw-hairline);
  border-radius: var(--aw-radius-md);
  cursor: pointer;
  transition: border-color 0.15s, box-shadow 0.15s;
}

.agent-card:hover {
  border-color: var(--aw-primary);
  box-shadow: 0 2px 8px rgba(0, 102, 204, 0.08);
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

.selected-agent-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: var(--aw-canvas-parchment);
  border-radius: var(--aw-radius-md);
  margin-bottom: 16px;
}

.agent-avatar-sm {
  background: var(--aw-primary);
  color: var(--aw-on-primary);
  font-weight: 600;
  flex-shrink: 0;
  font-size: 12px;
}

.selected-agent-name {
  font-size: var(--aw-text-caption);
  font-weight: 500;
  color: var(--aw-ink);
  flex: 1;
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

.mode-options {
  display: flex;
  gap: 10px;
}

.mode-card {
  flex: 1;
  padding: 16px;
  border: 2px solid var(--aw-hairline);
  border-radius: var(--aw-radius-lg);
  cursor: pointer;
  text-align: center;
  transition: all 0.2s;
  color: var(--aw-ink-muted-48);
}

.mode-card:hover {
  border-color: var(--aw-primary);
}

.mode-card.selected {
  border-color: var(--aw-primary);
  background: rgba(0, 102, 204, 0.05);
}

.mode-card h4 {
  margin: 6px 0 2px;
  font-family: var(--aw-font-display);
  font-size: var(--aw-text-caption);
  font-weight: 600;
  color: var(--aw-ink);
}

.mode-card p {
  margin: 0;
  font-size: var(--aw-text-fine);
  color: var(--aw-ink-muted-48);
}

.workspace-row {
  margin-top: 12px;
  max-width: 100%;
  overflow: hidden;
}

:deep(.workspace-row .pill-btn) {
  max-width: 100% !important;
  width: 100% !important;
  display: block !important;
  text-align: left !important;
  font-size: 12px !important;
  overflow: hidden !important;
  text-overflow: ellipsis !important;
  white-space: nowrap !important;
  box-sizing: border-box !important;
}

.pill-btn {
  border-radius: var(--aw-radius-pill) !important;
}

:deep(.el-dialog) {
  border-radius: var(--aw-radius-lg);
}

:deep(.el-dialog__header) {
  padding: 20px 24px 0;
}

:deep(.el-dialog__title) {
  font-family: var(--aw-font-display);
  font-size: var(--aw-text-tagline);
  font-weight: 600;
}

:deep(.el-dialog__body) {
  padding: 16px 24px;
  overflow: hidden;
}

:deep(.workspace-row .pill-btn span) {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  display: block;
  max-width: 100%;
}

:deep(.el-dialog__footer) {
  padding: 0 24px 20px;
}
</style>
