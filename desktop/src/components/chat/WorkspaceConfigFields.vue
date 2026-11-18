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
      <!-- 浏览器新建 LOCAL（技术方案 2026-11-17）：只能复用已有本地工作区，下拉展示绑定设备与在线态 -->
      <el-select
        v-if="!isElectron"
        :model-value="workspace"
        placeholder="选择已有本地工作区"
        :size="fieldSize"
        class="ws-field"
        popper-class="ws-local-field-select-dropdown"
        @update:model-value="(v: string) => emit('update:workspace', v || '')"
      >
        <el-option
          v-for="lw in localWorkspaces"
          :key="lw.workspace"
          :label="lw.name"
          :value="lw.workspace"
        >
          <div class="ws-local-option">
            <span class="ws-local-option-name">{{ lw.name }}</span>
            <span class="ws-local-option-sub">{{ localWorkspaceDeviceLabel(lw) }}</span>
          </div>
        </el-option>
      </el-select>
      <button v-else type="button" class="local-dir-btn" @click="selectWorkspace">
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
import type { LocalWorkspaceSummary } from '../../stores/session'
import { localWorkspaceDeviceLabel } from '../../utils/local-workspace'

const props = withDefaults(defineProps<{
  executionMode: string
  workspace?: string
  cloudProjectKey?: string
  workspaceMode?: string
  gitCloneUrl?: string
  gitBranch?: string
  cloudProjects?: Array<{ name: string; path: string; isGit: boolean }>
  /** 已有本地工作区条目（技术方案 2026-11-17）：浏览器新建 LOCAL 的下拉数据源 */
  localWorkspaces?: LocalWorkspaceSummary[]
  /** 移动端底部抽屉：表单控件放大到触屏可用尺寸（输入框 40px，与智能体搜索框一致） */
  isMobile?: boolean
}>(), {
  localWorkspaces: () => [],
})

/** 触屏抽屉用大号控件（40px / 14px），桌面 popover 保持 small（24px） */
const fieldSize = computed(() => (props.isMobile ? 'large' : 'small'))

// 浏览器新建 LOCAL（技术方案 2026-11-17）：无 electronAPI 时本地目录区渲染「已有工作区」下拉
const isElectron = typeof window !== 'undefined' && !!(window as any).electronAPI

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
  height: var(--aw-btn-height);
  padding: var(--aw-btn-padding);
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
  /* 全宽目录行按设计左对齐（图标 + 路径从左侧起排），压过全局 button 的居中 */
  justify-content: flex-start;
}

.local-dir-btn span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>

<style>
/* 工作区下拉：选项文字样式已统一在全局（style.css 的 .el-select-dropdown 规则，
   14px / 深色 / 常规字重 / 选中淡蓝底），这里只补圆角 */
.ws-field-select-dropdown.el-select-dropdown {
  border-radius: var(--aw-radius-md);
}
</style>
