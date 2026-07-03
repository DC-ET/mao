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
          :class="{ selected: selectedMode === 'LOCAL', disabled: !isElectronClient }"
          @click="selectMode('LOCAL')"
        >
          <el-icon :size="24"><Monitor /></el-icon>
          <h4>本地模式</h4>
          <p>工具在本地执行，需要桌面应用连接</p>
        </div>
      </div>

      <!-- LOCAL: workspace selection -->
      <div v-if="selectedMode === 'LOCAL'" class="workspace-row">
        <el-button class="pill-btn" @click="selectWorkspace">
          {{ localWorkspace || '选择工作目录' }}
        </el-button>
      </div>

      <!-- CLOUD: workspace source selection -->
      <div v-if="selectedMode === 'CLOUD'" class="workspace-source-section">
        <p class="section-label">工作区来源</p>
        <div class="source-options">
          <div
            v-if="cloudProjects.length > 0"
            class="source-option"
            :class="{ selected: workspaceMode === 'existing' }"
            @click="workspaceMode = 'existing'"
          >
            选择已有工作区
          </div>
          <div
            class="source-option"
            :class="{ selected: workspaceMode === 'new' }"
            @click="workspaceMode = 'new'"
          >
            创建新工作区
          </div>
          <div
            class="source-option"
            :class="{ selected: workspaceMode === 'git' }"
            @click="workspaceMode = 'git'"
          >
            初始化 Git 工作区
          </div>
        </div>

        <!-- Existing project selector -->
        <div v-if="workspaceMode === 'existing'" class="workspace-row">
          <el-select
            v-model="selectedProject"
            placeholder="选择已有工作区"
            class="project-select"
          >
            <el-option
              v-for="p in cloudProjects"
              :key="p.name"
              :label="p.name"
              :value="p.name"
            >
              <span>{{ p.name }}</span>
              <span v-if="p.isGit" class="git-badge">Git</span>
            </el-option>
          </el-select>
        </div>

        <!-- New project input -->
        <div v-if="workspaceMode === 'new'" class="workspace-row">
          <el-input
            v-model="newProjectName"
            placeholder="项目名（可留空，留空=独立工作区）"
            clearable
            class="project-input"
          />
        </div>

        <!-- Git clone input -->
        <div v-if="workspaceMode === 'git'" class="workspace-row">
          <el-input
            v-model="gitCloneUrl"
            placeholder="Git 仓库地址，如 https://github.com/user/repo.git 或 git@github.com:user/repo.git"
            clearable
            class="project-input"
          />
          <el-input
            v-model="gitBranch"
            placeholder="分支（可选，默认使用默认分支）"
            clearable
            class="project-input branch-input"
          />
        </div>
      </div>
    </div>

    <template #footer>
      <el-button class="pill-btn" :disabled="isCreating" @click="close">取消</el-button>
      <el-button
        type="primary"
        class="pill-btn"
        :disabled="!canConfirm || isCreating"
        :loading="isCreating"
        @click="confirm"
      >
        {{ isCreating ? createLoadingText : '开始' }}
      </el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import { Cloudy, Monitor } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import { useSessionStore, type SessionEnvironmentInfo, type CloudProject } from '../../stores/session'
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
const localWorkspace = ref('')
const isElectronClient = typeof window !== 'undefined' && !!(window as any).electronAPI

// Cloud workspace mode
type WorkspaceMode = 'existing' | 'new' | 'git'
const workspaceMode = ref<WorkspaceMode>('new')
const cloudProjects = ref<CloudProject[]>([])
const selectedProject = ref('')
const newProjectName = ref('')
const gitCloneUrl = ref('')
const gitBranch = ref('')
const isCreating = ref(false)
const createLoadingText = ref('')

const canConfirm = computed(() => {
  if (!selectedAgent.value) return false
  if (selectedMode.value === 'LOCAL') return true
  if (selectedMode.value === 'CLOUD') {
    if (workspaceMode.value === 'existing') return !!selectedProject.value
    if (workspaceMode.value === 'git') return !!gitCloneUrl.value
    return true
  }
  return false
})

async function onOpen() {
  selectedAgent.value = null
  selectedMode.value = props.defaultMode || 'CLOUD'
  localWorkspace.value = props.defaultWorkspace || ''
  isCreating.value = false
  createLoadingText.value = ''

  if (agentStore.agents.length === 0) {
    await agentStore.fetchAgents()
  }
  agents.value = agentStore.agents

  // Pre-select agent from defaults
  if (props.defaultAgentId) {
    const match = agents.value.find(a => String(a.id) === String(props.defaultAgentId))
    if (match) selectedAgent.value = match
  }

  // Load cloud projects and set default workspace mode
  cloudProjects.value = await sessionStore.fetchCloudProjects()
  workspaceMode.value = cloudProjects.value.length > 0 ? 'existing' : 'new'
  selectedProject.value = ''
  newProjectName.value = ''
  gitCloneUrl.value = ''
  gitBranch.value = ''
}

function selectMode(mode: 'CLOUD' | 'LOCAL') {
  if (mode === 'LOCAL' && !isElectronClient) {
    ElMessage.warning('浏览器端不支持本地模式，请使用桌面客户端')
    return
  }
  selectedMode.value = mode
}

async function selectWorkspace() {
  if (isElectronClient) {
    const dir = await (window as any).electronAPI.selectDirectory()
    if (dir) localWorkspace.value = dir
  } else {
    ElMessage.warning('浏览器端不能选择本地目录，请使用桌面客户端')
  }
}

async function confirm() {
  if (!selectedAgent.value) return
  if (selectedMode.value === 'LOCAL' && !isElectronClient) {
    ElMessage.error('浏览器端不支持本地模式，请使用桌面客户端创建本地任务')
    return
  }

  isCreating.value = true

  if (selectedMode.value === 'CLOUD' && workspaceMode.value === 'git') {
    createLoadingText.value = '正在克隆仓库...（可能需要 1-2 分钟）'
  } else {
    createLoadingText.value = '正在初始化...'
  }

  try {
    let environmentInfo: SessionEnvironmentInfo | undefined
    if (selectedMode.value === 'LOCAL' && isElectronClient && (window as any).electronAPI?.getEnvironmentInfo) {
      environmentInfo = await (window as any).electronAPI.getEnvironmentInfo(localWorkspace.value || undefined)
    }

    const cloudProjectKey = workspaceMode.value === 'existing'
      ? selectedProject.value || undefined
      : workspaceMode.value === 'new'
        ? newProjectName.value || undefined
        : undefined

    const session = await sessionStore.createSession(
      selectedAgent.value.id,
      selectedMode.value,
      selectedMode.value === 'LOCAL' ? localWorkspace.value || undefined : undefined,
      environmentInfo,
      undefined,
      undefined,
      cloudProjectKey,
      selectedMode.value === 'CLOUD' ? workspaceMode.value : undefined,
      selectedMode.value === 'CLOUD' && workspaceMode.value === 'git' ? gitCloneUrl.value : undefined,
      selectedMode.value === 'CLOUD' && workspaceMode.value === 'git' ? (gitBranch.value || undefined) : undefined
    )
    if (session) {
      emit('created', session)
    }
  } catch (e: any) {
    ElMessage.error(e?.response?.data?.message || e?.message || '创建失败')
  } finally {
    isCreating.value = false
    createLoadingText.value = ''
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
  margin: 16px 0 10px;
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

.mode-card.disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

.mode-card.disabled:hover {
  border-color: var(--aw-hairline);
}

.mode-card.disabled.selected:hover {
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

/* Workspace source options */
.workspace-source-section {
  margin-top: 2px;
}

.source-options {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}

.source-option {
  flex: 1;
  min-width: 100px;
  padding: 8px 10px;
  border: 1px solid var(--aw-hairline);
  border-radius: var(--aw-radius-md);
  cursor: pointer;
  text-align: center;
  font-size: var(--aw-text-fine);
  font-weight: 500;
  color: var(--aw-ink-muted-64);
  transition: all 0.15s;
}

.source-option:hover {
  border-color: var(--aw-primary);
  color: var(--aw-ink);
}

.source-option.selected {
  border-color: var(--aw-primary);
  background: rgba(0, 102, 204, 0.06);
  color: var(--aw-primary);
}

.workspace-row {
  margin-top: 10px;
  max-width: 100%;
}

.project-select {
  width: 100%;
}

.project-input {
  width: 100%;
}

.branch-input {
  margin-top: 8px;
}

.git-badge {
  margin-left: 8px;
  padding: 0 5px;
  font-size: 11px;
  color: var(--aw-primary);
  border: 1px solid var(--aw-primary);
  border-radius: 3px;
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

:deep(.el-dialog__footer) {
  padding: 0 24px 20px;
}
</style>
