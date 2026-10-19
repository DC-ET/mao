<template>
  <!-- Bottom toolbar -->
  <div class="toolbar">
    <div class="toolbar-left">
      <label class="add-btn" title="上传图片或文件" :class="{ disabled: disabled }">
        <!-- LOCAL 模式不支持非图片文件上传，收窄 accept 避免选完才被拒 -->
        <input type="file" multiple :accept="executionMode === 'LOCAL' ? 'image/*' : ''" :disabled="disabled" @change="handleFileSelect" style="display: none" />
        <el-icon :size="16"><Plus /></el-icon>
      </label>

      <!-- Centered new-task chips（桌面：占工具条；移动：见下方 meta 行） -->
      <template v-if="isNewTask && layout === 'centered' && !isMobileViewport">
        <AgentChip
          :selected-agent-id="selectedAgentId"
          :disabled="disabled"
          :is-mobile="false"
          @update:selected-agent-id="id => emit('update:selectedAgentId', id)"
        />
        <WorkspaceChip
          :execution-mode="executionMode"
          :workspace="workspace"
          :cloud-project-key="cloudProjectKey"
          :project-key="projectKey"
          :workspace-mode="workspaceMode"
          :git-clone-url="gitCloneUrl"
          :git-branch="gitBranch"
          :cloud-projects="cloudProjects"
          :is-new-task="isNewTask"
          :disabled="disabled"
          :is-mobile="false"
          @update:execution-mode="handleModeChange"
          @update:workspace="w => emit('update:workspace', w)"
          @update:cloud-project-key="onCloudProjectKeyChange"
          @update:workspace-mode="onWorkspaceModeChange"
          @update:git-clone-url="onGitCloneUrlChange"
          @update:git-branch="b => emit('update:gitBranch', b)"
        />
      </template>

      <!-- Docked / session workspace indicator -->
      <div
        v-if="!(isNewTask && layout === 'centered')"
        class="workspace-indicator"
        :class="{ 'has-workspace': !!workspace || executionMode === 'CLOUD', 'cloud-mode': executionMode === 'CLOUD' }"
        @click="executionMode !== 'CLOUD' && openWorkspace()"
      >
        <template v-if="executionMode === 'CLOUD'">
          <el-icon :size="14"><Cloudy /></el-icon>
          <span>{{ cloudIndicatorLabel }}</span>
        </template>
        <template v-else>
          <el-icon :size="14">
            <WarningFilled v-if="!workspace" />
            <FolderOpened v-else />
          </el-icon>
          <span>{{ dirName || 'No workspace' }}</span>
        </template>
      </div>
      <PermissionLevelSwitcher
        v-if="executionMode === 'LOCAL'"
        :current-level="permissionLevel"
        @update:permission-level="$event => emit('update:permissionLevel', $event)"
      />
    </div>
    <div class="toolbar-right">
      <ModelSelector
        :model-id="modelId"
        :compact="isMobileViewport && layout === 'centered'"
        @update:model-id="id => emit('update:modelId', id)"
        @select="(id, modelIdStr) => emit('select:model', id, modelIdStr)"
      />
      <button
        v-if="waitingForSave"
        class="send-btn saving"
        title="正在保存..."
        disabled
      >
        <el-icon :size="16" class="is-loading"><Loading /></el-icon>
      </button>
      <button
        v-else-if="loading && !canSend && !initializingWorkspace"
        class="send-btn stop"
        title="停止"
        @click="handleStop()"
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
          <rect x="2" y="2" width="12" height="12" rx="2"/>
        </svg>
      </button>
      <button
        v-else-if="canContinue && !canSend && !initializingWorkspace"
        class="send-btn continue"
        title="继续"
        @click="handleContinue()"
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
          <path d="M5 3.3v9.4c0 .65.72 1.04 1.27.69l7.32-4.7a.82.82 0 0 0 0-1.38L6.27 2.61A.82.82 0 0 0 5 3.3z"/>
        </svg>
      </button>
      <button
        v-else
        class="send-btn"
        :class="{ active: canSend }"
        :disabled="!canSend"
        :title="loading ? '加入队列 (Enter)' : '发送 (Enter)'"
        @click="handleSend()"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
          <path d="M12 19V5M12 5L5 12M12 5L19 12" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { Plus, WarningFilled, FolderOpened, Cloudy, Loading } from '@element-plus/icons-vue'
import PermissionLevelSwitcher from './PermissionLevelSwitcher.vue'
import AgentChip from './AgentChip.vue'
import WorkspaceChip from './WorkspaceChip.vue'
import ModelSelector from './ModelSelector.vue'
import type { CloudProject } from '../../stores/session'

defineProps<{
  disabled: boolean
  executionMode: string
  isNewTask: boolean
  layout: 'centered' | 'docked'
  isMobileViewport: boolean
  selectedAgentId: string | null
  workspace: string
  cloudProjectKey: string | undefined
  projectKey: string | undefined
  workspaceMode: string
  gitCloneUrl: string | undefined
  gitBranch: string | undefined
  cloudProjects: CloudProject[]
  cloudIndicatorLabel: string
  dirName: string
  permissionLevel: string
  modelId?: number
  waitingForSave: boolean
  loading: boolean
  canSend: boolean
  initializingWorkspace: boolean
  canContinue: boolean
  handleFileSelect: (event: Event) => void
  handleModeChange: (mode: string) => void
  onCloudProjectKeyChange: (value: string) => void
  onWorkspaceModeChange: (mode: string) => void
  onGitCloneUrlChange: (value: string) => void
  openWorkspace: () => void
  handleStop: () => void
  handleContinue: () => void
  handleSend: () => void
}>()

const emit = defineEmits<{
  'update:selectedAgentId': [id: string | null]
  'update:workspace': [workspace: string]
  'update:gitBranch': [branch: string]
  'update:permissionLevel': [level: string]
  'update:modelId': [modelId: number]
  'select:model': [modelId: number, modelIdStr: string]
}>()
</script>
