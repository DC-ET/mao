<template>
  <!-- New task config bar (docked bottom layout only; centered uses chips in toolbar) -->
  <div v-if="isNewTask && layout === 'docked'" class="new-task-config-bar">
    <AgentSelector
      :selected-agent-id="selectedAgentId"
      @update:selected-agent-id="(id: string | null) => emit('update:selectedAgentId', id)"
    />
    <div class="config-row" :class="{ 'is-mobile': isTouchDevice }">
      <div class="mode-selector">
        <el-radio-group :model-value="executionMode" size="small" @change="handleModeChange">
          <el-tooltip content="工具在云端服务器上执行，无需本地环境，随时随地可用" placement="top" :show-after="400">
            <el-radio-button value="CLOUD">
              <el-icon :size="12"><Cloudy /></el-icon> 云端模式
            </el-radio-button>
          </el-tooltip>
          <el-tooltip content="工具在你本地电脑上执行，可直接访问本地文件和开发环境，需要桌面应用保持连接" placement="top" :show-after="400">
            <el-radio-button value="LOCAL" :disabled="!isElectronClient">
              <el-icon :size="12"><Monitor /></el-icon> 本地模式
            </el-radio-button>
          </el-tooltip>
        </el-radio-group>
      </div>
      <el-select
        v-if="executionMode === 'CLOUD'"
        :model-value="workspaceMode"
        size="small"
        class="workspace-mode-select"
        popper-class="workspace-mode-select-dropdown"
        @update:model-value="onWorkspaceModeChange"
      >
        <el-option
          v-for="opt in workspaceModeOptions"
          :key="opt.value"
          :label="opt.label"
          :value="opt.value"
        />
      </el-select>
      <div
        v-if="executionMode === 'LOCAL'"
        class="workspace-selector"
        :class="{ 'has-workspace': !!workspace }"
        @click="selectWorkspace"
      >
        <el-icon :size="13">
          <WarningFilled v-if="!workspace" />
          <FolderOpened v-else />
        </el-icon>
        <span>{{ workspace ? dirName : '选择工作目录' }}</span>
      </div>
      <div v-if="executionMode === 'CLOUD'" class="cloud-workspace-detail">
        <!-- 总览「用于新任务」带入的显式目录（临时/其他工作区）：只读展示，改动工作区来源即让位 -->
        <div v-if="explicitWorkspace" class="cloud-workspace-fixed">
          <el-icon :size="13"><FolderOpened /></el-icon>
          <span class="cloud-workspace-fixed-name" :title="explicitWorkspace">{{ dirName || explicitWorkspace }}</span>
          <el-tag size="small" round>复用</el-tag>
        </div>
        <template v-else-if="workspaceMode === 'existing'">
          <el-select
            :model-value="cloudProjectKey"
            placeholder="选择工作区"
            size="small"
            class="cloud-project-select"
            popper-class="cloud-project-select-dropdown"
            @update:model-value="onCloudProjectKeyChange"
          >
            <el-option
              v-for="p in cloudProjects"
              :key="p.name"
              :label="p.name"
              :value="p.name"
            >
              <div class="cloud-project-option">
                <span class="cloud-project-option-name">{{ p.name }}</span>
                <span v-if="p.sizeBytes != null || p.activeSessions != null" class="cloud-project-option-sub">
                  {{ cloudProjectSubtitle(p) }}
                </span>
              </div>
            </el-option>
          </el-select>
        </template>
        <template v-else-if="workspaceMode === 'git'">
          <el-input
            :model-value="gitCloneUrl"
            placeholder="Git 地址，如 https://git.example.com/xx/xxx.git"
            size="small"
            clearable
            class="cloud-project-input"
            @update:model-value="onGitCloneUrlChange"
          />
        </template>
        <template v-else>
          <el-input
            :model-value="cloudProjectKey"
            placeholder="项目（可选，留空=独立）"
            size="small"
            clearable
            class="cloud-project-input"
            @update:model-value="onCloudProjectKeyChange"
          />
        </template>
      </div>
    </div>
    <div class="config-divider"></div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { Cloudy, Monitor, WarningFilled, FolderOpened } from '@element-plus/icons-vue'
import AgentSelector from '../task/AgentSelector.vue'
import type { CloudProject } from '../../stores/session'
import { formatSize } from '../../utils/file-manager'

const props = defineProps<{
  isNewTask: boolean
  layout: 'centered' | 'docked'
  isTouchDevice: boolean
  isElectronClient: boolean
  executionMode: string
  workspaceMode: string
  workspaceModeOptions: { label: string; value: string }[]
  workspace: string
  dirName: string
  cloudProjectKey: string | undefined
  gitCloneUrl: string | undefined
  cloudProjects: CloudProject[]
  selectedAgentId: string | null
  handleModeChange: (mode: string) => void
  onWorkspaceModeChange: (mode: string) => void
  onCloudProjectKeyChange: (value: string) => void
  onGitCloneUrlChange: (value: string) => void
  selectWorkspace: () => void
}>()

/** 新建态带入的显式工作区（总览「用于新任务」）：无 cloudProjectKey 时以只读条目展示，
 *  有项目键时仍走「现有工作区」下拉（路径与 projects/{key} 一致，下拉才是可控入口） */
const explicitWorkspace = computed(() =>
  props.executionMode === 'CLOUD' && props.workspace && !props.cloudProjectKey ? props.workspace : '')

/** 「复用已有工作区」条目副标题：大小 + 会话数（overview 富化字段缺省时不显示副标题） */
function cloudProjectSubtitle(p: CloudProject): string {
  const parts: string[] = []
  if (p.sizeBytes != null) parts.push(formatSize(p.sizeBytes))
  if (p.activeSessions != null || p.archivedSessions != null) {
    parts.push(`进行中 ${p.activeSessions ?? 0} · 归档 ${p.archivedSessions ?? 0}`)
  }
  return parts.join(' · ')
}

const emit = defineEmits<{
  'update:selectedAgentId': [id: string | null]
}>()
</script>

<style scoped>
.cloud-workspace-fixed {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  max-width: 100%;
  height: 24px;
  padding: 0 8px;
  border-radius: var(--aw-radius-pill);
  background: var(--aw-canvas-parchment);
  color: var(--aw-ink);
  font-size: var(--aw-text-fine);
}

.cloud-workspace-fixed-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cloud-project-option {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}

.cloud-project-option-name {
  font-size: var(--aw-text-caption);
}

.cloud-project-option-sub {
  font-size: var(--aw-text-micro);
  color: var(--aw-ink-muted-48);
}
</style>
