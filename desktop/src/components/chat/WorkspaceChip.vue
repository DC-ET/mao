<template>
  <div class="workspace-chip-wrap">
    <el-popover
      v-if="!isMobile"
      v-model:visible="configVisible"
      trigger="click"
      :width="340"
      placement="top-start"
      popper-class="workspace-chip-popper"
      :show-arrow="false"
    >
      <template #reference>
        <button
          type="button"
          class="workspace-chip"
          :class="{ warn: needsAttention }"
          :disabled="disabled"
        >
          <el-icon :size="13">
            <WarningFilled v-if="needsAttention" />
            <FolderOpened v-else-if="executionMode === 'LOCAL'" />
            <Cloudy v-else />
          </el-icon>
          <span class="chip-label">{{ displayLabel }}</span>
          <el-icon class="chip-caret" :size="12"><ArrowDown /></el-icon>
        </button>
      </template>
      <div class="ws-config">
        <div class="ws-section-title">执行模式</div>
        <div class="mode-seg">
          <button type="button" class="mode-btn" :class="{ active: executionMode === 'CLOUD' }" @click="switchMode('CLOUD')">
            <el-icon :size="12"><Cloudy /></el-icon> 云端
          </button>
          <button
            type="button"
            class="mode-btn"
            :class="{ active: executionMode === 'LOCAL' }"
            :disabled="!isElectronClient"
            :title="isElectronClient ? '工具在本地电脑执行' : '浏览器端不支持本地模式'"
            @click="switchMode('LOCAL')"
          >
            <el-icon :size="12"><Monitor /></el-icon> 本地
          </button>
        </div>
        <WorkspaceConfigFields
          :execution-mode="executionMode"
          :workspace="workspace"
          :cloud-project-key="cloudProjectKey"
          :workspace-mode="workspaceMode"
          :git-clone-url="gitCloneUrl"
          :git-branch="gitBranch"
          :cloud-projects="cloudProjects"
          @update:cloud-project-key="onCloudProjectKeyChange"
          @update:workspace-mode="onWorkspaceModeChange"
          @update:git-clone-url="onGitCloneUrlChange"
          @update:git-branch="b => emit('update:gitBranch', b)"
          @update:workspace="w => emit('update:workspace', w)"
        />
      </div>
    </el-popover>

    <template v-else>
      <button
        type="button"
        class="workspace-chip"
        :class="{ warn: needsAttention }"
        :disabled="disabled"
        @click="openConfig"
      >
        <el-icon :size="13">
          <WarningFilled v-if="needsAttention" />
          <FolderOpened v-else-if="executionMode === 'LOCAL'" />
          <Cloudy v-else />
        </el-icon>
        <span class="chip-label">{{ displayLabel }}</span>
        <el-icon class="chip-caret" :size="12"><ArrowDown /></el-icon>
      </button>
      <el-drawer
        v-model="configVisible"
        direction="btt"
        size="min(60vh, 420px)"
        :with-header="true"
        title="工作区设置"
      >
        <div class="ws-config">
          <div class="ws-section-title">执行模式</div>
          <div class="mode-seg">
            <button type="button" class="mode-btn" :class="{ active: executionMode === 'CLOUD' }" @click="switchMode('CLOUD')">
              <el-icon :size="12"><Cloudy /></el-icon> 云端
            </button>
            <button
              type="button"
              class="mode-btn"
              :class="{ active: executionMode === 'LOCAL' }"
              :disabled="!isElectronClient"
              @click="switchMode('LOCAL')"
            >
              <el-icon :size="12"><Monitor /></el-icon> 本地
            </button>
          </div>
          <WorkspaceConfigFields
            :execution-mode="executionMode"
            :workspace="workspace"
            :cloud-project-key="cloudProjectKey"
            :workspace-mode="workspaceMode"
            :git-clone-url="gitCloneUrl"
            :git-branch="gitBranch"
            :cloud-projects="cloudProjects"
            @update:cloud-project-key="onCloudProjectKeyChange"
            @update:workspace-mode="onWorkspaceModeChange"
            @update:git-clone-url="onGitCloneUrlChange"
            @update:git-branch="b => emit('update:gitBranch', b)"
            @update:workspace="w => emit('update:workspace', w)"
          />
        </div>
      </el-drawer>
    </template>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import { ArrowDown, Cloudy, FolderOpened, Monitor, WarningFilled } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import { cloudWorkspaceIndicator, extractGitRepoSlug } from '../../utils/cloud-project'
import WorkspaceConfigFields from './WorkspaceConfigFields.vue'

const props = withDefaults(defineProps<{
  executionMode: string
  workspace?: string
  cloudProjectKey?: string
  projectKey?: string
  workspaceMode?: string
  gitCloneUrl?: string
  gitBranch?: string
  cloudProjects?: Array<{ name: string; path: string; isGit: boolean }>
  isNewTask?: boolean
  disabled?: boolean
  isMobile?: boolean
}>(), {
  workspace: '',
  cloudProjectKey: '',
  workspaceMode: 'new',
  gitCloneUrl: '',
  gitBranch: '',
  cloudProjects: () => [],
  isNewTask: false,
  disabled: false,
  isMobile: false,
})

const emit = defineEmits<{
  'update:executionMode': [mode: string]
  'update:workspace': [workspace: string]
  'update:cloudProjectKey': [key: string]
  'update:workspaceMode': [mode: string]
  'update:gitCloneUrl': [url: string]
  'update:gitBranch': [branch: string]
}>()

const isElectronClient = typeof window !== 'undefined' && !!(window as any).electronAPI
const configVisible = ref(false)

const displayLabel = computed(() => {
  if (props.executionMode === 'LOCAL') {
    if (!props.workspace) return '选择目录'
    const parts = props.workspace.replace(/\\/g, '/').split('/').filter(Boolean)
    return parts[parts.length - 1] || props.workspace
  }
  if (props.workspaceMode === 'git') {
    return extractGitRepoSlug(props.gitCloneUrl || '') || (props.gitCloneUrl ? 'Git 仓库' : 'Git 地址')
  }
  return cloudWorkspaceIndicator(
    'CLOUD',
    props.workspace,
    props.isNewTask ? undefined : props.projectKey,
    {
      draftProjectKey: props.isNewTask ? props.cloudProjectKey : undefined,
      workspaceMode: props.isNewTask ? props.workspaceMode : undefined,
      gitCloneUrl: props.isNewTask ? props.gitCloneUrl : undefined,
    }
  ) || '工作区'
})

const needsAttention = computed(() => {
  if (props.executionMode === 'LOCAL') return !props.workspace
  if (props.workspaceMode === 'git') return !props.gitCloneUrl
  return false
})

function openConfig() {
  if (props.disabled) return
  configVisible.value = true
}

function switchMode(mode: string) {
  if (mode === 'LOCAL' && !isElectronClient) {
    ElMessage.warning('浏览器端不支持本地模式，请使用桌面客户端')
    return
  }
  if (mode !== props.executionMode) {
    emit('update:executionMode', mode)
  }
}

function onWorkspaceModeChange(mode: string) {
  emit('update:workspaceMode', mode)
}

function onCloudProjectKeyChange(value: string) {
  emit('update:cloudProjectKey', value || '')
}

function onGitCloneUrlChange(value: string) {
  emit('update:gitCloneUrl', value || '')
}
</script>

<style scoped>
.workspace-chip-wrap {
  position: relative;
  display: inline-flex;
}

.workspace-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 32px;
  max-width: 140px;
  padding: 0 10px;
  border-radius: var(--aw-radius-pill);
  border: 1px solid var(--aw-hairline);
  background: var(--aw-canvas-parchment);
  color: var(--aw-ink);
  font-size: var(--aw-text-fine);
  cursor: pointer;
  transition: border-color 0.15s;
  white-space: nowrap;
}

.workspace-chip:hover:not(:disabled) {
  border-color: var(--aw-primary);
}

.workspace-chip.warn {
  border-color: var(--aw-warning);
  color: var(--aw-warning);
  background: color-mix(in srgb, var(--aw-warning) 8%, transparent);
}

.workspace-chip:disabled {
  opacity: 0.55;
  cursor: default;
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

.ws-config {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.ws-section-title {
  font-size: var(--aw-text-micro);
  color: var(--aw-ink-muted-48);
  font-weight: 500;
}

.mode-seg {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}

.mode-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 30px;
  padding: 0 12px;
  border-radius: var(--aw-radius-pill);
  border: 1px solid var(--aw-hairline);
  background: var(--aw-canvas);
  color: var(--aw-ink-muted-80);
  font-size: var(--aw-text-fine);
  cursor: pointer;
}

.mode-btn.active {
  border-color: var(--aw-primary);
  background: var(--aw-primary-lighter);
  color: var(--aw-primary);
  font-weight: 500;
}

.mode-btn:disabled {
  opacity: 0.45;
  cursor: default;
}

@media (pointer: coarse), (max-width: 768px) {
  .workspace-chip {
    height: 34px;
    max-width: none;
    padding: 0 12px;
    gap: 6px;
  }
}
</style>
