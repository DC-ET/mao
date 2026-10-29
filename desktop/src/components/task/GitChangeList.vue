<template>
  <div class="git-change-list">
    <div class="git-toolbar">
      <div class="git-toolbar-title">
        变更
        <span v-if="!loading" class="git-count">{{ files.length }}</span>
      </div>
      <div class="git-toolbar-actions">
        <!-- 窄视口 + 检查器上下文（有展开入口）时只留展开按钮，操作移师中央 Git 管理器 -->
        <template v-if="!showExpand || !isMobileDevice()">
          <el-tooltip v-if="!twoStepCommit" :content="commitDisabledReason || '提交代码'" placement="top" :show-after="300">
            <span>
              <button class="git-action-btn" :disabled="!!commitDisabledReason" aria-label="提交代码" @click="$emit('commit')">
                <el-icon :size="14" :class="{ spinning: operation === 'commit' }"><Check /></el-icon>
              </button>
            </span>
          </el-tooltip>
          <el-tooltip v-if="!hideSync" :content="pullDisabledReason || '拉取代码'" placement="top" :show-after="300">
            <span>
              <button class="git-action-btn" :disabled="!!pullDisabledReason" aria-label="拉取代码" @click="$emit('pull')">
                <el-icon :size="14" :class="{ spinning: operation === 'pull' }"><Download /></el-icon>
              </button>
            </span>
          </el-tooltip>
          <el-tooltip v-if="!hideSync" :content="pushDisabledReason || '推送代码'" placement="top" :show-after="300">
            <span>
              <button class="git-action-btn" :disabled="!!pushDisabledReason" aria-label="推送代码" @click="$emit('push')">
                <el-icon :size="14" :class="{ spinning: operation === 'push' }"><Upload /></el-icon>
              </button>
            </span>
          </el-tooltip>
          <button v-if="!hideRefresh" class="git-action-btn" :disabled="loading || !!operation" title="刷新" aria-label="刷新 Git 状态" @click="$emit('refresh')">
            <el-icon :size="14" :class="{ spinning: loading && !operation }"><Refresh /></el-icon>
          </button>
        </template>
        <el-tooltip v-if="showExpand" content="在中央 Tab 打开 Git 管理器" placement="top" :show-after="300">
          <span>
            <button class="git-action-btn" aria-label="打开 Git 管理器" @click="$emit('expand')">
              <el-icon :size="14"><FullScreen /></el-icon>
            </button>
          </span>
        </el-tooltip>
      </div>
    </div>

    <!-- 两步提交（中央 Git 管理器）：提交信息输入框 + LLM 生成 + 提交按钮，替代工具栏的一步 ✓ -->
    <div v-if="twoStepCommit && !error && files.length > 0" class="git-commit-box">
      <div class="git-commit-input-row">
        <textarea
          class="git-commit-input"
          :value="commitMessage"
          rows="3"
          placeholder="提交信息（可用右上角按钮让 LLM 生成，之后可自由编辑）"
          @input="emit('update:commit-message', ($event.target as HTMLTextAreaElement).value)"
        />
        <el-tooltip :content="generateDisabledReason || 'LLM 生成提交信息'" placement="top" :show-after="300">
          <span class="git-commit-generate-wrap">
            <button class="git-commit-generate" :disabled="!!generateDisabledReason" aria-label="生成提交信息" @click="emit('generate-commit-message')">
              <el-icon :size="14" :class="{ spinning: generating }"><MagicStick /></el-icon>
            </button>
          </span>
        </el-tooltip>
      </div>
      <button class="git-commit-submit" :disabled="!!commitWithMessageDisabledReason" @click="emit('commit-with-message')">
        <el-icon :size="14" :class="{ spinning: committing }"><Check /></el-icon>
        提交
      </button>
    </div>

    <div v-if="error" class="git-state git-error">
      <p>{{ error }}</p>
      <button class="git-retry" @click="$emit('refresh')">重试</button>
    </div>
    <div v-else-if="loading && files.length === 0" class="git-state">加载中…</div>
    <div v-else-if="files.length === 0" class="git-state">没有待提交的变更</div>
    <div v-else class="git-tree">
      <div class="git-tree-inner">
        <GitChangeTreeNode
          v-for="node in treeRoots"
          :key="node.path"
          :node="node"
          :depth="0"
          :collapsed="collapsed"
          @toggle="toggleDir"
          @open-diff="(file) => $emit('open-diff', file)"
          @contextmenu="handleNodeContextmenu"
        />
      </div>
    </div>

    <GitContextMenu
      :visible="ctxMenu.visible"
      :x="ctxMenu.x"
      :y="ctxMenu.y"
      :show-open-in-finder="executionMode !== 'CLOUD' && canOpenInFinder"
      :show-download-actions="executionMode === 'CLOUD'"
      @hide="ctxMenu.visible = false"
      @copy-absolute="handleCopyAbsolute"
      @copy-relative="handleCopyRelative"
      @open-in-finder="handleOpenInFinder"
      @add-to-chat="handleAddToChat"
      @download-file="handleDownloadFile"
    />

    <DownloadLinkDialog
      :visible="downloadDialog.visible"
      :url="downloadDialog.url"
      :file-name="downloadDialog.fileName"
      @close="downloadDialog.visible = false"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, reactive, watch } from 'vue'
import { Check, Download, FullScreen, MagicStick, Refresh, Upload } from '@element-plus/icons-vue'
import { ElTooltip, ElMessage } from 'element-plus'
import type { GitChangedFile, GitOperationType, GitTreeNode } from '../../types/git'
import GitChangeTreeNode from './GitChangeTreeNode.vue'
import GitContextMenu from './GitContextMenu.vue'
import { copyText } from '../../utils/clipboard'
import type { WorkspaceFileProvider } from '../../composables/workspace-file-provider'
import DownloadLinkDialog from '../common/DownloadLinkDialog.vue'
import { isWechatBrowser } from '../../utils/user-agent'
import { isAndroidCapacitor } from '../../utils/capacitor'
import { isMobileDevice } from '../../composables/usePanelLayout'
import { gitPullDisabledReason, gitPushDisabledReason } from '../../utils/git-manager'

const props = defineProps<{
  files: GitChangedFile[]
  loading?: boolean
  error?: string
  hasRemote?: boolean
  hasHead?: boolean
  detachedHead?: boolean
  upstream?: string
  remoteStatusAvailable?: boolean
  remoteStatusError?: string
  aheadCount?: number
  behindCount?: number
  hasCommitsToPush?: boolean
  operation?: GitOperationType | null
  executionMode?: string
  workspace?: string
  repoPath?: string
  provider?: WorkspaceFileProvider | null
  /** 侧边栏 Git 页签展示「展开到中央 Tab」按钮；中央大 Tab 自身不展示 */
  showExpand?: boolean
  /** 中央 Git 管理器：顶部状态条已有刷新入口（含 fetch），工具栏 ↻ 隐藏避免重复；侧边栏不传，默认展示 */
  hideRefresh?: boolean
  /** 中央 Git 管理器：拉取 / 推送已上移到顶部状态条，工具栏不再重复；侧边栏不传，默认展示 */
  hideSync?: boolean
  /** 中央 Git 管理器两步提交：显示提交信息框并隐藏工具栏 ✓；侧边栏不传，保持一步提交 */
  twoStepCommit?: boolean
  /** 提交信息输入框内容（草稿由父级持有，切仓库 / 提交成功后清空） */
  commitMessage?: string
  /** LLM 生成提交信息中（✨ 旋转态） */
  generating?: boolean
  /** 两步提交进行中（提交按钮旋转态） */
  committing?: boolean
}>()

const emit = defineEmits<{
  refresh: []
  commit: []
  pull: []
  push: []
  'update:commit-message': [message: string]
  'generate-commit-message': []
  'commit-with-message': []
  'open-diff': [file: GitChangedFile]
  'add-file-to-chat': [filePath: string]
  expand: []
}>()

const canOpenInFinder = computed(() => typeof window !== 'undefined' && !!window.electronAPI?.showItemInFolder)

const ctxMenu = reactive({
  visible: false,
  x: 0,
  y: 0,
  node: null as GitTreeNode | null,
})

const downloadDialog = reactive({
  visible: false,
  url: '',
  fileName: '',
})

function handleNodeContextmenu(payload: { node: GitTreeNode; x: number; y: number }) {
  ctxMenu.x = payload.x
  ctxMenu.y = payload.y
  ctxMenu.node = payload.node
  ctxMenu.visible = true
}

function getAbsolutePath(nodePath: string): string {
  if (!props.workspace) return nodePath
  // 使用与 FileTree 相同的路径解析逻辑
  const isAbsolutePath = (filePath: string): boolean => {
    const normalized = filePath.replace(/\\/g, '/')
    return /^[a-zA-Z]:/.test(normalized) || normalized.startsWith('/')
  }

  if (isAbsolutePath(nodePath)) return nodePath
  const sep = props.workspace.includes('\\') ? '\\' : '/'
  return props.workspace.replace(/[\\/]+$/, '') + sep + nodePath.replace(/^[\\/]+/, '')
}

function handleCopyAbsolute() {
  if (!ctxMenu.node) return
  const path = ctxMenu.node.kind === 'file' ? ctxMenu.node.file.path : ctxMenu.node.path
  copyText(getAbsolutePath(path))
}

function handleCopyRelative() {
  if (!ctxMenu.node) return
  const path = ctxMenu.node.kind === 'file' ? ctxMenu.node.file.path : ctxMenu.node.path
  copyText(path)
}

function handleOpenInFinder() {
  if (!ctxMenu.node) return
  if (!canOpenInFinder.value) {
    ElMessage.info('当前环境不支持在文件管理器中打开')
    return
  }
  const path = ctxMenu.node.kind === 'file' ? ctxMenu.node.file.path : ctxMenu.node.path
  const absPath = getAbsolutePath(path)
  window.electronAPI?.showItemInFolder?.(absPath)
}

function handleAddToChat() {
  if (!ctxMenu.node) return
  const path = ctxMenu.node.kind === 'file' ? ctxMenu.node.file.path : ctxMenu.node.path
  emit('add-file-to-chat', path)
}

async function handleDownloadFile() {
  const node = ctxMenu.node
  if (!node || node.kind !== 'file') return
  if (!props.provider?.downloadFile) {
    ElMessage.warning('当前模式不支持下载')
    return
  }
  try {
    const relativePath = props.repoPath
      ? `${props.repoPath.replace(/[\\/]+$/, '')}/${node.file.path.replace(/^[\\/]+/, '')}`
      : node.file.path
    const result = await props.provider.downloadFile(relativePath, node.name)
    if (result.ok) {
      if ((isWechatBrowser() || isAndroidCapacitor()) && result.url) {
        // 微信浏览器和安卓 WebView 可能阻止 Blob 自动下载，显示可鉴权的下载链接
        downloadDialog.url = result.url
        downloadDialog.fileName = node.name
        downloadDialog.visible = true
      } else {
        ElMessage.success(`已触发下载：${node.name}`)
      }
    } else {
      ElMessage.error(result.error || '下载失败')
      // 如果有URL，显示下载链接对话框
      if (result.url) {
        downloadDialog.url = result.url
        downloadDialog.fileName = node.name
        downloadDialog.visible = true
      }
    }
  } catch (e: any) {
    ElMessage.error(e?.message || '下载失败')
  }
}

const commitDisabledReason = computed(() => {
  if (props.operation) return 'Git 操作进行中'
  if (props.loading) return '正在读取 Git 状态'
  if (props.error) return 'Git 状态不可用'
  if (props.files.length === 0) return '没有待提交的变更'
  return ''
})

/** ✨ 生成：没有可生成的变更时按钮上直接说明原因 */
const generateDisabledReason = computed(() => {
  if (props.generating) return '正在生成提交信息…'
  if (props.committing) return '提交进行中'
  if (props.operation) return 'Git 操作进行中'
  if (props.loading) return '正在读取 Git 状态'
  if (props.error) return 'Git 状态不可用'
  if (props.files.length === 0) return '没有待提交的变更'
  return ''
})

/** 提交按钮：输入框为空时禁用（消息内容不限定格式，只查非空） */
const commitWithMessageDisabledReason = computed(() => {
  if (props.committing) return '提交进行中'
  if (props.generating) return '正在生成提交信息…'
  if (props.operation) return 'Git 操作进行中'
  if (props.loading) return '正在读取 Git 状态'
  if (props.error) return 'Git 状态不可用'
  if (props.files.length === 0) return '没有待提交的变更'
  if (!(props.commitMessage ?? '').trim()) return '请先填写提交信息'
  return ''
})

/** 拉取 / 推送禁用原因与中央 Git 管理器顶部状态条同一口径（utils/git-manager），避免两处漂移 */
const pullDisabledReason = computed(() => gitPullDisabledReason(props))
const pushDisabledReason = computed(() => gitPushDisabledReason(props))

/** Paths of collapsed directories (default: all expanded) */
const collapsed = reactive(new Set<string>())

const treeRoots = computed(() => buildGitTree(props.files))

watch(
  () => props.files,
  () => {
    const valid = new Set<string>()
    collectDirPaths(treeRoots.value, valid)
    for (const path of [...collapsed]) {
      if (!valid.has(path)) collapsed.delete(path)
    }
  },
)

function toggleDir(path: string) {
  if (collapsed.has(path)) collapsed.delete(path)
  else collapsed.add(path)
}

function collectDirPaths(nodes: GitTreeNode[], out: Set<string>) {
  for (const node of nodes) {
    if (node.kind === 'dir') {
      out.add(node.path)
      collectDirPaths(node.children, out)
    }
  }
}

function buildGitTree(files: GitChangedFile[]): GitTreeNode[] {
  type MutableDir = {
    kind: 'dir'
    name: string
    path: string
    dirs: Map<string, MutableDir>
    files: Map<string, GitChangedFile>
  }

  const root: MutableDir = {
    kind: 'dir',
    name: '',
    path: '',
    dirs: new Map(),
    files: new Map(),
  }

  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path))

  for (const file of sorted) {
    const parts = file.path.split('/').filter(Boolean)
    if (parts.length === 0) continue

    let current = root
    for (let i = 0; i < parts.length - 1; i++) {
      const name = parts[i]
      const dirPath = parts.slice(0, i + 1).join('/')
      let child = current.dirs.get(name)
      if (!child) {
        child = {
          kind: 'dir',
          name,
          path: dirPath,
          dirs: new Map(),
          files: new Map(),
        }
        current.dirs.set(name, child)
      }
      current = child
    }

    const fileName = parts[parts.length - 1]
    current.files.set(fileName, file)
  }

  function finalize(dir: MutableDir): GitTreeNode {
    const children: GitTreeNode[] = []

    const dirNames = [...dir.dirs.keys()].sort((a, b) => a.localeCompare(b))
    for (const name of dirNames) {
      children.push(finalize(dir.dirs.get(name)!))
    }

    const fileNames = [...dir.files.keys()].sort((a, b) => a.localeCompare(b))
    for (const name of fileNames) {
      const file = dir.files.get(name)!
      children.push({
        kind: 'file',
        name,
        path: file.path,
        file,
      })
    }

    return {
      kind: 'dir',
      name: dir.name,
      path: dir.path,
      children: compressChildren(children),
    }
  }

  /** Merge single-child directory chains into package-style names: a/b/c */
  function compressChildren(nodes: GitTreeNode[]): GitTreeNode[] {
    return nodes.map((node) => {
      if (node.kind !== 'dir') return node
      let current = node
      const parts = [current.name]
      while (
        current.children.length === 1
        && current.children[0].kind === 'dir'
      ) {
        current = current.children[0]
        parts.push(current.name)
      }
      return {
        kind: 'dir' as const,
        name: parts.filter(Boolean).join('/'),
        path: current.path,
        children: compressChildren(current.children),
      }
    })
  }

  const tree = finalize(root)
  return tree.kind === 'dir' ? tree.children : []
}
</script>

<style scoped>
.git-change-list {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

.git-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px;
  border-bottom: 1px solid var(--aw-divider-soft);
  flex-shrink: 0;
}

.git-toolbar-title {
  font-size: var(--aw-text-caption);
  font-weight: 600;
  color: var(--aw-ink);
  letter-spacing: 0.5px;
  text-transform: uppercase;
  display: flex;
  align-items: center;
  gap: 6px;
}

.git-count {
  font-family: var(--aw-font-mono);
  font-weight: 500;
  color: var(--aw-ink-muted-48);
  text-transform: none;
  letter-spacing: 0;
}

.git-toolbar-actions {
  display: flex;
  align-items: center;
  flex-shrink: 0;
}

.git-action-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: var(--aw-btn-height);
  height: var(--aw-btn-height);
  border: none;
  border-radius: var(--aw-radius-xs);
  background: transparent;
  color: var(--aw-ink-muted-48);
  cursor: pointer;
}

.git-action-btn:hover:not(:disabled) {
  background: rgba(0, 0, 0, 0.06);
  color: var(--aw-primary);
}

.git-action-btn:disabled {
  opacity: 0.38;
  cursor: default;
}

.spinning {
  animation: git-spin 0.8s linear infinite;
}

@keyframes git-spin {
  to { transform: rotate(360deg); }
}

.git-commit-box {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--aw-divider-soft);
  flex-shrink: 0;
}

.git-commit-input-row {
  position: relative;
  display: flex;
  align-items: flex-start;
  gap: 6px;
}

.git-commit-input {
  flex: 1;
  min-width: 0;
  min-height: 58px;
  padding: 38px 8px 6px; /* 顶部为框内左上角悬浮的 ✨ 按钮预留 */
  border: 1px solid var(--aw-hairline);
  border-radius: var(--aw-radius-sm);
  background: var(--aw-surface-pearl);
  color: var(--aw-ink);
  font-family: var(--aw-font-mono);
  font-size: var(--aw-text-fine);
  line-height: 1.5;
  resize: vertical;
}

.git-commit-input:focus {
  outline: none;
  border-color: var(--aw-primary);
}

/* tooltip 以 span 为锚点：绝对定位加在包裹层上，避免锚点漂到输入框右缘 */
.git-commit-generate-wrap {
  position: absolute;
  top: 6px;
  right: 8px;
  z-index: 1;
  display: inline-flex;
}

.git-commit-generate {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: var(--aw-btn-height);
  height: var(--aw-btn-height);
  border: 1px solid var(--aw-divider-soft);
  border-radius: var(--aw-radius-sm);
  background: var(--aw-surface-pearl);
  color: var(--aw-ink-muted-48);
  cursor: pointer;
}

.git-commit-generate:hover:not(:disabled) {
  background: var(--aw-primary-hover);
  color: var(--aw-primary);
}

.git-commit-generate:disabled {
  opacity: 0.38;
  cursor: default;
}

.git-commit-submit {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 6px 12px;
  border: none;
  border-radius: var(--aw-radius-sm);
  background: var(--aw-primary);
  color: var(--aw-on-primary);
  font-size: var(--aw-text-caption);
  cursor: pointer;
}

.git-commit-submit:hover:not(:disabled) {
  filter: brightness(0.95);
}

.git-commit-submit:disabled {
  opacity: 0.5;
  cursor: default;
}

.git-state {
  padding: 24px 16px;
  text-align: center;
  color: var(--aw-ink-muted-48);
  font-size: var(--aw-text-caption);
}

.git-error p {
  margin: 0 0 8px;
}

.git-retry {
  border: none;
  background: transparent;
  color: var(--aw-primary);
  cursor: pointer;
  font-size: var(--aw-text-caption);
}

.git-tree {
  overflow: auto;
  flex: 1;
  min-height: 0;
  padding: 4px 0;
}

.git-tree-inner {
  width: max-content;
  min-width: 100%;
}

[data-theme="dark"] .git-toolbar {
  border-bottom-color: var(--aw-hairline);
}

[data-theme="dark"] .git-commit-box {
  border-bottom-color: var(--aw-hairline);
}

[data-theme="dark"] .git-action-btn:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.06);
}
</style>
