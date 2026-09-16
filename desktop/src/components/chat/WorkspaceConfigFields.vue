<template>
  <div class="ws-fields" :class="{ 'is-mobile': isMobile }">
    <template v-if="executionMode === 'CLOUD'">
      <div class="ws-section-title">工作区</div>
      <div class="mode-seg workspace-mode-seg">
        <button
          v-for="opt in workspaceModeOptions"
          :key="opt.value"
          type="button"
          class="mode-btn"
          :class="{ active: workspaceMode === opt.value }"
          @click="emit('update:workspaceMode', opt.value)"
        >
          {{ opt.label }}
        </button>
      </div>
      <el-select
        v-if="workspaceMode === 'existing'"
        :model-value="cloudProjectKey"
        placeholder="选择工作区"
        :size="fieldSize"
        class="ws-field"
        popper-class="ws-field-select-dropdown"
        @update:model-value="(v: string) => emit('update:cloudProjectKey', v || '')"
      >
        <el-option v-for="p in cloudProjects" :key="p.name" :label="p.name" :value="p.name" />
      </el-select>
      <template v-else-if="workspaceMode === 'git'">
        <el-input
          :model-value="gitCloneUrl"
          placeholder="HTTPS Git 地址"
          :size="fieldSize"
          clearable
          class="ws-field"
          @update:model-value="(v: string) => emit('update:gitCloneUrl', v || '')"
        />
        <el-input
          :model-value="gitBranch"
          placeholder="分支（可选）"
          :size="fieldSize"
          clearable
          class="ws-field"
          @update:model-value="(v: string) => emit('update:gitBranch', v || '')"
        />
      </template>
      <el-input
        v-else
        :model-value="cloudProjectKey"
        placeholder="项目名（留空=临时工作区）"
        :size="fieldSize"
        clearable
        class="ws-field"
        @update:model-value="(v: string) => emit('update:cloudProjectKey', v || '')"
      />
    </template>

    <template v-else>
      <div class="ws-section-title">本地目录</div>
      <button type="button" class="local-dir-btn" @click="selectWorkspace">
        <el-icon :size="14">
          <WarningFilled v-if="!workspace" />
          <FolderOpened v-else />
        </el-icon>
        <span>{{ workspace || '选择工作目录' }}</span>
      </button>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { FolderOpened, WarningFilled } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'

const props = defineProps<{
  executionMode: string
  workspace?: string
  cloudProjectKey?: string
  workspaceMode?: string
  gitCloneUrl?: string
  gitBranch?: string
  cloudProjects?: Array<{ name: string; path: string; isGit: boolean }>
  /** 移动端底部抽屉：表单控件放大到触屏可用尺寸（输入框 40px，与智能体搜索框一致） */
  isMobile?: boolean
}>()

/** 触屏抽屉用大号控件（40px / 14px），桌面 popover 保持 small（24px） */
const fieldSize = computed(() => (props.isMobile ? 'large' : 'small'))

const emit = defineEmits<{
  'update:cloudProjectKey': [key: string]
  'update:workspaceMode': [mode: string]
  'update:gitCloneUrl': [url: string]
  'update:gitBranch': [branch: string]
  'update:workspace': [workspace: string]
}>()

const workspaceModeOptions = computed(() => {
  const options: { label: string; value: string }[] = [
    { label: '空白', value: 'new' },
    { label: 'Git', value: 'git' },
  ]
  if ((props.cloudProjects?.length ?? 0) > 0) {
    options.unshift({ label: '现有', value: 'existing' })
  }
  return options
})

async function selectWorkspace() {
  const api = (window as any).electronAPI
  if (api?.selectDirectory) {
    const dir = await api.selectDirectory()
    if (dir) emit('update:workspace', dir)
  } else {
    ElMessage.warning('浏览器端不能选择本地目录，请使用桌面客户端')
  }
}
</script>

<style scoped>
.ws-fields {
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

.ws-field {
  width: 100%;
}

/* 触屏抽屉：分段按钮与目录按钮对齐大号输入框高度 */
.ws-fields.is-mobile .mode-btn {
  height: 40px;
  padding: 0 16px;
  font-size: var(--aw-text-caption);
}

.ws-fields.is-mobile .local-dir-btn {
  min-height: 40px;
  font-size: var(--aw-text-caption);
}

.local-dir-btn {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-height: 36px;
  padding: 0 12px;
  border-radius: var(--aw-radius-sm);
  border: 1px solid var(--aw-hairline);
  background: var(--aw-canvas);
  color: var(--aw-ink);
  font-size: var(--aw-text-fine);
  cursor: pointer;
  text-align: left;
}

.local-dir-btn span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>

<style>
/* 工作区下拉列表：选项文字与「模型选择」列表一致（深色常规字重），
   选中项去掉 Element Plus 默认的加粗 + 主色，仅用淡蓝底标示 */
.ws-field-select-dropdown.el-select-dropdown {
  border-radius: var(--aw-radius-md);
}

.ws-field-select-dropdown .el-select-dropdown__item {
  font-weight: 400;
  color: var(--aw-body);
}

.ws-field-select-dropdown .el-select-dropdown__item.is-selected {
  font-weight: 400;
  color: var(--aw-body);
  background: var(--aw-primary-lighter);
}
</style>
