<template>
  <div class="git-change-list">
    <div class="git-toolbar">
      <div class="git-toolbar-title">
        变更
        <span v-if="!loading" class="git-count">{{ files.length }}</span>
      </div>
      <div class="git-toolbar-actions">
        <el-tooltip :content="commitDisabledReason || '提交代码'" placement="top" :show-after="300">
          <span>
            <button class="git-action-btn" :disabled="!!commitDisabledReason" aria-label="提交代码" @click="$emit('commit')">
              <el-icon :size="14" :class="{ spinning: operation === 'commit' }"><Check /></el-icon>
            </button>
          </span>
        </el-tooltip>
        <el-tooltip :content="pullDisabledReason || '拉取代码'" placement="top" :show-after="300">
          <span>
            <button class="git-action-btn" :disabled="!!pullDisabledReason" aria-label="拉取代码" @click="$emit('pull')">
              <el-icon :size="14" :class="{ spinning: operation === 'pull' }"><Download /></el-icon>
            </button>
          </span>
        </el-tooltip>
        <el-tooltip :content="pushDisabledReason || '推送代码'" placement="top" :show-after="300">
          <span>
            <button class="git-action-btn" :disabled="!!pushDisabledReason" aria-label="推送代码" @click="$emit('push')">
              <el-icon :size="14" :class="{ spinning: operation === 'push' }"><Upload /></el-icon>
            </button>
          </span>
        </el-tooltip>
        <button class="git-action-btn" :disabled="loading || !!operation" title="刷新" aria-label="刷新 Git 状态" @click="$emit('refresh')">
          <el-icon :size="14" :class="{ spinning: loading && !operation }"><Refresh /></el-icon>
        </button>
      </div>
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
      :show-open-in-finder="executionMode !== 'CLOUD'"
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
import { Check, Download, Refresh, Upload } from '@element-plus/icons-vue'
import { ElTooltip, ElMessage } from 'element-plus'
import type { GitChangedFile, GitTreeNode } from '../../types/git'
import GitChangeTreeNode from './GitChangeTreeNode.vue'
import GitContextMenu from './GitContextMenu.vue'
import { copyText } from '../../utils/clipboard'
import type { WorkspaceFileProvider } from '../../composables/workspace-file-provider'
import DownloadLinkDialog from '../common/DownloadLinkDialog.vue'
import { isWechatBrowser } from '../../utils/user-agent'
import { isAndroidCapacitor } from '../../utils/capacitor'

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
  operation?: 'commit' | 'pull' | 'push' | null
  executionMode?: string
  workspace?: string
  repoPath?: string
  provider?: WorkspaceFileProvider | null
}>()

const emit = defineEmits<{
  refresh: []
  commit: []
  pull: []
  push: []
  'open-diff': [file: GitChangedFile]
  'add-file-to-chat': [filePath: string]
}>()

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
  const path = ctxMenu.node.kind === 'file' ? ctxMenu.node.file.path : ctxMenu.node.path
  const absPath = getAbsolutePath(path)
  window.electronAPI.showItemInFolder(absPath)
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

function commonSyncDisabledReason() {
  if (props.operation) return 'Git 操作进行中'
  if (props.loading) return '正在读取 Git 状态'
  if (props.error) return 'Git 状态不可用'
  if (props.detachedHead) return 'detached HEAD，请先切换分支'
  if (!props.hasRemote) return '仓库未配置远端'
  if (!props.remoteStatusAvailable) return props.remoteStatusError || '请刷新以确认远端状态'
  return ''
}

const pullDisabledReason = computed(() => {
  const common = commonSyncDisabledReason()
  if (common) return common
  if (!props.upstream) return '当前分支未配置 upstream'
  if ((props.behindCount ?? 0) === 0) return '没有可拉取的更新'
  return ''
})

const pushDisabledReason = computed(() => {
  const common = commonSyncDisabledReason()
  if (common) return common
  if (!props.hasHead || props.hasCommitsToPush === false) return '没有可推送的提交'
  if (props.hasCommitsToPush !== true) return '无法确认可推送状态'
  return ''
})

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
  width: 28px;
  height: 28px;
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

[data-theme="dark"] .git-action-btn:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.06);
}
</style>
