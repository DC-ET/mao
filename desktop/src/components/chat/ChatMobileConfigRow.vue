<template>
  <!-- 移动居中态：智能体/工作区配置条（输入与操作行下方，不占工具条横向空间） -->
  <div v-if="isNewTask && layout === 'centered' && isMobileViewport" class="center-meta-row">
    <AgentChip
      :selected-agent-id="selectedAgentId"
      :disabled="disabled"
      :is-mobile="true"
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
      :is-mobile="true"
      @update:execution-mode="handleModeChange"
      @update:workspace="w => emit('update:workspace', w)"
      @update:cloud-project-key="onCloudProjectKeyChange"
      @update:workspace-mode="onWorkspaceModeChange"
      @update:git-clone-url="onGitCloneUrlChange"
      @update:git-branch="b => emit('update:gitBranch', b)"
    />
  </div>
</template>

<script setup lang="ts">
import AgentChip from './AgentChip.vue'
import WorkspaceChip from './WorkspaceChip.vue'
import type { CloudProject } from '../../stores/session'

defineProps<{
  isNewTask: boolean
  layout: 'centered' | 'docked'
  isMobileViewport: boolean
  selectedAgentId: string | null
  disabled: boolean
  executionMode: string
  workspace: string
  cloudProjectKey: string | undefined
  projectKey: string | undefined
  workspaceMode: string
  gitCloneUrl: string | undefined
  gitBranch: string | undefined
  cloudProjects: CloudProject[]
  handleModeChange: (mode: string) => void
  onCloudProjectKeyChange: (value: string) => void
  onWorkspaceModeChange: (mode: string) => void
  onGitCloneUrlChange: (value: string) => void
}>()

const emit = defineEmits<{
  'update:selectedAgentId': [id: string | null]
  'update:workspace': [workspace: string]
  'update:gitBranch': [branch: string]
}>()
</script>
