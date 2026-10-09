<template>
  <div class="file-tree">
    <div v-if="!isReady" class="file-tree-empty">
      <p>{{ emptyMessage }}</p>
    </div>
    <template v-else>
      <div class="file-tree-toolbar">
        <el-input
          v-model="filterText"
          placeholder="筛选文件..."
          clearable
          :prefix-icon="Search"
        />
        <button
          v-if="canWrite"
          type="button"
          class="toolbar-refresh"
          aria-label="上传文件"
          @click="pickUpload(false)"
        ><el-icon :size="16"><Upload /></el-icon></button>
        <button
          v-if="canWrite"
          type="button"
          class="toolbar-refresh"
          aria-label="上传文件夹"
          @click="pickUpload(true)"
        ><el-icon :size="16"><FolderAdd /></el-icon></button>
        <button
          type="button"
          class="toolbar-refresh"
          aria-label="刷新文件树"
          :disabled="loading"
          @click="handleRefresh"
        ><el-icon :size="16"><Refresh /></el-icon></button>
        <input ref="fileInput" class="hidden-input" type="file" multiple @change="onPickFiles" />
        <input ref="dirInput" class="hidden-input" type="file" multiple webkitdirectory @change="onPickFiles" />
      </div>
      <div v-if="uploadProgress" class="upload-progress">
        <span>{{ uploadProgress.error || uploadProgress.label }}</span>
        <el-progress :percentage="uploadProgress.percent" :status="uploadProgress.error ? 'exception' : undefined" />
      </div>
      <div class="file-tree-content" v-loading="loading || searching">
        <template v-if="isSearchMode">
          <div v-if="searchError" class="file-tree-empty">
            <p>{{ searchError }}</p>
          </div>
          <div v-else-if="searchResults != null && searchResults.length === 0" class="file-tree-empty">
            <p>无匹配文件</p>
          </div>
          <div v-else class="file-tree-inner" @contextmenu.prevent="openBlankMenu">
            <div v-if="searchTruncated && searchResults?.length" class="search-truncated-hint">
              匹配较多，仅显示前 {{ searchResults.length }} 条
            </div>
            <FileTreeNode
              v-for="node in searchResults ?? []"
              :key="node.path"
              :node="node"
              :depth="0"
              :can-write="canWrite"
              :selected-paths="selectedPaths"
              :drop-path="dropPath"
              :rename-path="renamePath"
              @open-file="handleOpenFile"
              @node-contextmenu="handleNodeContextmenu"
              @toggle-select="toggleSelect"
              @commit-name="commitDraft"
              @cancel-edit="cancelDraft"
            />
          </div>
        </template>
        <template v-else>
          <div
            v-if="treeData.length === 0 && !loading"
            class="file-tree-empty"
            @contextmenu.prevent="openBlankMenu"
            @dragover.prevent="onBlankDragOver"
            @drop.prevent="onBlankDrop"
          >
            <p v-if="createPath !== ''">空目录</p>
            <input
              v-else
              ref="rootCreateInput"
              class="node-name-input"
              placeholder="名称"
              @keydown.enter.prevent="commitDraft(($event.target as HTMLInputElement).value)"
              @keydown.esc.prevent="cancelDraft"
              @blur="commitDraft(($event.target as HTMLInputElement).value)"
            />
          </div>
          <div
            v-else
            class="file-tree-inner"
            @contextmenu.prevent="openBlankMenu"
            @dragover.prevent="onBlankDragOver"
            @drop.prevent="onBlankDrop"
          >
            <div v-if="createPath === ''" class="node-row root-create">
              <input
                ref="rootCreateInput"
                class="node-name-input"
                placeholder="名称"
                @keydown.enter.prevent="commitDraft(($event.target as HTMLInputElement).value)"
                @keydown.esc.prevent="cancelDraft"
                @blur="commitDraft(($event.target as HTMLInputElement).value)"
              />
            </div>
            <FileTreeNode
              v-for="node in treeData"
              :key="node.path"
              :node="node"
              :depth="0"
              :can-write="canWrite"
              :selected-paths="selectedPaths"
              :drop-path="dropPath"
              :rename-path="renamePath"
              :create-path="createPath"
              @open-file="handleOpenFile"
              @toggle-dir="handleToggleDir"
              @retry="handleRetry"
              @node-contextmenu="handleNodeContextmenu"
              @toggle-select="toggleSelect"
              @drag-hover="dropPath = $event"
              @node-drop="handleInternalDrop"
              @external-drop="handleExternalDrop"
              @commit-name="commitDraft"
              @cancel-edit="cancelDraft"
            />
          </div>
        </template>
      </div>
    </template>

    <FileTreeContextMenu
      :visible="ctxMenu.visible"
      :x="ctxMenu.x"
      :y="ctxMenu.y"
      :show-local-actions="executionMode !== 'CLOUD'"
      :show-download-actions="executionMode === 'CLOUD'"
      :is-directory="ctxMenu.node?.isDirectory ?? false"
      :show-open-in-finder="executionMode !== 'CLOUD' && canOpenInFinder"
      :can-write="canWrite"
      :can-paste="clipboard.matches(numericSessionId)"
      :has-node="!!ctxMenu.node"
      @hide="ctxMenu.visible = false"
      @create-file="beginCreate('file')"
      @create-dir="beginCreate('dir')"
      @rename="beginRename"
      @remove="confirmDelete"
      @cut="rememberClipboard('cut')"
      @copy="rememberClipboard('copy')"
      @paste="pasteClipboard"
      @upload="beginUpload"
      @copy-absolute="handleCopyAbsolute"
      @copy-relative="handleCopyRelative"
      @open-in-finder="handleOpenInFinder"
      @add-to-chat="handleAddToChat"
      @download-file="handleDownloadFile"
      @download-directory="handleDownloadDirectory"
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
import { ref, reactive, computed, toRef, watch, onUnmounted, nextTick } from 'vue'
import { Refresh, Search, Upload, FolderAdd } from '@element-plus/icons-vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useFileBrowser } from '../../composables/useFileBrowser'
import type { WorkspaceFileProvider } from '../../composables/workspace-file-provider'
import FileTreeNode from './FileTreeNode.vue'
import FileTreeContextMenu from './FileTreeContextMenu.vue'
import type { FileNode } from '../../types/file-browser'
import { resolveWorkspaceFilePath } from '../../utils/workspace-path'
import { copyText } from '../../utils/clipboard'
import DownloadLinkDialog from '../common/DownloadLinkDialog.vue'
import { isWechatBrowser } from '../../utils/user-agent'
import { isAndroidCapacitor } from '../../utils/capacitor'
import { useFileClipboard } from '../../composables/useFileClipboard'
import {
  copyWorkspacePath,
  deleteWorkspacePath,
  filesFromDataTransfer,
  filesFromInput,
  mkdirWorkspace,
  moveWorkspacePath,
  renameWorkspacePath,
  uploadWorkspace,
  writeWorkspaceFile,
  type UploadProgress,
} from '../../composables/workspace-file-write'
import type { WorkspacePathChange } from '../../utils/workspace-tab-paths'

const props = defineProps<{
  workspace?: string
  executionMode?: string
  provider: WorkspaceFileProvider | null
  sessionId?: string
}>()

const emit = defineEmits<{
  'open-file': [payload: { path: string; title: string }]
  'add-file-to-chat': [filePath: string]
  'paths-changed': [change: WorkspacePathChange]
}>()

const numericSessionId = computed(() => {
  const n = Number(props.sessionId)
  return Number.isFinite(n) ? n : 0
})
const canWrite = computed(() => props.executionMode === 'CLOUD' && numericSessionId.value > 0)
const clipboard = useFileClipboard()
const selectedPaths = ref<string[]>([])
const dropPath = ref('')
const renamePath = ref('')
const createPath = ref<string | null>(null)
const createKind = ref<'file' | 'dir'>('file')
const uploadDir = ref('.')
const uploadProgress = ref<UploadProgress | null>(null)
const fileInput = ref<HTMLInputElement>()
const dirInput = ref<HTMLInputElement>()
const rootCreateInput = ref<HTMLInputElement>()
let draftBusy = false

const canOpenInFinder = computed(() => typeof window !== 'undefined' && !!window.electronAPI?.showItemInFolder)

const providerRef = toRef(props, 'provider')
const { treeData, loading, expandDir, refresh } = useFileBrowser(providerRef)

const isReady = computed(() => {
  if (props.executionMode === 'CLOUD') {
    return !!props.provider
  }
  return !!props.workspace
})

const emptyMessage = computed(() => {
  if (props.executionMode === 'CLOUD') {
    return '请先开始对话'
  }
  return '请先选择工作区目录'
})

const ctxMenu = reactive({
  visible: false,
  x: 0,
  y: 0,
  node: null as FileNode | null,
})

function handleNodeContextmenu(payload: { node: FileNode; x: number; y: number }) {
  ctxMenu.x = payload.x
  ctxMenu.y = payload.y
  ctxMenu.node = payload.node
  ctxMenu.visible = true
}

function getAbsolutePath(nodePath: string): string {
  if (props.provider?.getAbsolutePath) {
    return props.provider.getAbsolutePath(nodePath)
  }
  if (!props.workspace) return nodePath
  return resolveWorkspaceFilePath(props.workspace, nodePath)
}

function handleCopyAbsolute() {
  if (!ctxMenu.node) return
  copyText(getAbsolutePath(ctxMenu.node.path))
}

function handleCopyRelative() {
  if (!ctxMenu.node) return
  copyText(ctxMenu.node.path)
}

function handleOpenInFinder() {
  if (!ctxMenu.node) return
  if (!canOpenInFinder.value) {
    ElMessage.info('当前环境不支持在文件管理器中打开')
    return
  }
  const absPath = getAbsolutePath(ctxMenu.node.path)
  window.electronAPI?.showItemInFolder?.(absPath)
}

function handleAddToChat() {
  const paths = actionPaths()
  if (paths.length === 0 && ctxMenu.node) paths.push(ctxMenu.node.path)
  for (const path of paths) emit('add-file-to-chat', path)
}

function actionPaths(): string[] {
  const node = ctxMenu.node
  if (!node) return []
  if (selectedPaths.value.includes(node.path) && selectedPaths.value.length > 1) return [...selectedPaths.value]
  return [node.path]
}

function parentOf(path: string): string {
  const index = path.lastIndexOf('/')
  return index < 0 ? '' : path.slice(0, index)
}

function joinRel(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name
}

function topLevel(paths: string[]): string[] {
  return paths.filter((path) => !paths.some((other) => other !== path && (path === other || path.startsWith(`${other}/`))))
}

function touchesGit(path: string): boolean {
  return path === '.git' || path.startsWith('.git/') || path.endsWith('/.git') || path.includes('/.git/')
}

function findNode(nodes: FileNode[], path: string): FileNode | null {
  for (const node of nodes) {
    if (node.path === path) return node
    if (node.children) {
      const found = findNode(node.children, path)
      if (found) return found
    }
  }
  return null
}

function pathIsDir(path: string): boolean {
  if (ctxMenu.node?.path === path) return !!ctxMenu.node.isDirectory
  return !!findNode(treeData.value, path)?.isDirectory
}

function openBlankMenu(event: MouseEvent) {
  if (!canWrite.value) return
  ctxMenu.x = event.clientX
  ctxMenu.y = event.clientY
  ctxMenu.node = null
  ctxMenu.visible = true
}

function toggleSelect(path: string) {
  const index = selectedPaths.value.indexOf(path)
  if (index >= 0) selectedPaths.value.splice(index, 1)
  else selectedPaths.value.push(path)
}

function beginCreate(kind: 'file' | 'dir') {
  const node = ctxMenu.node
  const dir = !node ? '' : node.isDirectory ? node.path : parentOf(node.path)
  createKind.value = kind
  renamePath.value = ''
  createPath.value = dir
  if (dir) {
    const found = findNode(treeData.value, dir)
    if (found) expandDir(found)
  } else {
    void nextTick(() => rootCreateInput.value?.focus())
  }
}

function beginRename() {
  if (!ctxMenu.node) return
  createPath.value = null
  renamePath.value = ctxMenu.node.path
}

function cancelDraft() {
  createPath.value = null
  renamePath.value = ''
}

async function commitDraft(name: string) {
  if (draftBusy) return
  const renaming = renamePath.value
  const creating = createPath.value
  if (!renaming && creating == null) return
  const trimmed = name.trim()
  if (!trimmed || trimmed.includes('/') || trimmed.includes('\0') || trimmed === '.' || trimmed === '..') {
    if (trimmed) ElMessage.warning('名称不合法')
    cancelDraft()
    return
  }
  draftBusy = true
  const sessionId = numericSessionId.value
  try {
    if (renaming) {
      const result = await renameWorkspacePath(sessionId, renaming, trimmed)
      emit('paths-changed', { kind: 'move', from: renaming, to: result.path })
    } else if (createKind.value === 'dir') {
      await mkdirWorkspace(sessionId, joinRel(creating ?? '', trimmed))
    } else {
      const result = await writeWorkspaceFile(sessionId, joinRel(creating ?? '', trimmed), '')
      emit('open-file', { path: result.path, title: trimmed })
    }
    await refresh()
  } catch {
    // 冲突面板和全局 toast 已经提示过
  } finally {
    draftBusy = false
    cancelDraft()
  }
}

async function confirmDelete() {
  const paths = topLevel(actionPaths())
  if (paths.length === 0 || numericSessionId.value <= 0) return
  const lines = paths.map((path) => pathIsDir(path) ? `${path}（目录，将删除其下所有内容）` : path)
  const git = paths.some(touchesGit) ? '\n将删除 Git 版本库。' : ''
  try {
    await ElMessageBox.confirm(`${lines.join('\n')}\n\n删除不可恢复。${git}`, '删除文件', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消',
    })
  } catch {
    return
  }
  try {
    for (const path of paths) await deleteWorkspacePath(numericSessionId.value, path)
    emit('paths-changed', { kind: 'delete', paths })
    selectedPaths.value = selectedPaths.value.filter((path) => !paths.some((root) => path === root || path.startsWith(`${root}/`)))
    await refresh()
  } catch {
    await refresh()
  }
}

function rememberClipboard(op: 'cut' | 'copy') {
  const paths = actionPaths()
  if (paths.length === 0 || numericSessionId.value <= 0) return
  clipboard.set(op, numericSessionId.value, paths)
}

async function pasteClipboard() {
  const clip = clipboard.current
  if (!clip || clip.sessionId !== numericSessionId.value) {
    ElMessage.warning('不能跨会话粘贴')
    return
  }
  const node = ctxMenu.node
  const dest = !node ? '.' : node.isDirectory ? node.path : (parentOf(node.path) || '.')
  try {
    for (const from of clip.paths) {
      if (clip.op === 'cut') {
        const result = await moveWorkspacePath(numericSessionId.value, from, dest)
        emit('paths-changed', { kind: 'move', from, to: result.path })
      } else {
        await copyWorkspacePath(numericSessionId.value, from, dest)
      }
    }
    if (clip.op === 'cut') clipboard.clear()
    await refresh()
  } catch {
    await refresh()
  }
}

function beginUpload() {
  const node = ctxMenu.node
  uploadDir.value = !node ? '.' : node.isDirectory ? (node.path || '.') : (parentOf(node.path) || '.')
  fileInput.value?.click()
}

function pickUpload(directory: boolean) {
  uploadDir.value = '.'
  if (directory) dirInput.value?.click()
  else fileInput.value?.click()
}

async function onPickFiles(event: Event) {
  const input = event.target as HTMLInputElement
  const items = filesFromInput(input.files)
  input.value = ''
  await doUpload(uploadDir.value || '.', items)
}

async function doUpload(dir: string, items: { file: File; relativePath: string }[]) {
  if (items.length === 0 || numericSessionId.value <= 0) return
  uploadProgress.value = { label: items.length === 1 ? items[0].relativePath : `${items.length} 个文件`, percent: 0, error: '' }
  try {
    await uploadWorkspace(numericSessionId.value, dir, items, (progress) => { uploadProgress.value = progress })
    await refresh()
  } catch {
    // 进度条上保留失败文案
  } finally {
    window.setTimeout(() => { uploadProgress.value = null }, 1600)
  }
}

async function handleInternalDrop(payload: { target: FileNode; paths: string[] }) {
  dropPath.value = ''
  if (numericSessionId.value <= 0) return
  try {
    for (const from of payload.paths) {
      if (from === payload.target.path || payload.target.path.startsWith(`${from}/`)) continue
      const result = await moveWorkspacePath(numericSessionId.value, from, payload.target.path)
      emit('paths-changed', { kind: 'move', from, to: result.path })
    }
    selectedPaths.value = []
    await refresh()
  } catch {
    await refresh()
  }
}

async function handleExternalDrop(payload: { target: FileNode; data: DataTransfer }) {
  dropPath.value = ''
  const items = await filesFromDataTransfer(payload.data)
  await doUpload(payload.target.path || '.', items)
}

function onBlankDragOver() {
  dropPath.value = ''
}

async function onBlankDrop(event: DragEvent) {
  dropPath.value = ''
  const raw = event.dataTransfer?.getData('application/x-mao-paths')
  if (raw) {
    try {
      const paths = JSON.parse(raw) as string[]
      for (const from of paths) {
        const result = await moveWorkspacePath(numericSessionId.value, from, '.')
        emit('paths-changed', { kind: 'move', from, to: result.path })
      }
      selectedPaths.value = []
      await refresh()
      return
    } catch {
      await refresh()
      return
    }
  }
  if (!event.dataTransfer) return
  const items = await filesFromDataTransfer(event.dataTransfer)
  await doUpload('.', items)
}

const downloading = ref(false)
const downloadDialog = reactive({
  visible: false,
  url: '',
  fileName: '',
})

async function handleDownloadFile() {
  const node = ctxMenu.node
  if (!node || downloading.value) return
  if (!props.provider?.downloadFile) {
    ElMessage.warning('当前模式不支持下载')
    return
  }
  downloading.value = true
  try {
    // 搜索结果节点 name 为完整相对路径，下载文件名回退为最后一段
    const suggestedName = node.name.includes('/')
      ? node.name.slice(node.name.lastIndexOf('/') + 1)
      : node.name
    const result = await props.provider.downloadFile(node.path, suggestedName)
    if (result.ok) {
      if ((isWechatBrowser() || isAndroidCapacitor()) && result.url) {
        // 微信浏览器和安卓 WebView 可能阻止 Blob 自动下载，显示可鉴权的下载链接
        downloadDialog.url = result.url
        downloadDialog.fileName = suggestedName
        downloadDialog.visible = true
      } else {
        ElMessage.success(`已触发下载：${node.name}`)
      }
    } else {
      ElMessage.error(result.error || '下载失败')
      // 如果有URL，显示下载链接对话框
      if (result.url) {
        downloadDialog.url = result.url
        downloadDialog.fileName = suggestedName
        downloadDialog.visible = true
      }
    }
  } finally {
    downloading.value = false
  }
}

async function handleDownloadDirectory() {
  const node = ctxMenu.node
  if (!node || downloading.value) return
  if (!props.provider?.downloadDirectory) {
    ElMessage.warning('当前模式不支持下载')
    return
  }
  downloading.value = true
  ElMessage.info(`正在打包 ${node.name}…`)
  try {
    // 合并压缩后的目录节点 name 可能含斜杠，弹窗展示的文件名回退为最后一段
    const baseName = node.name.includes('/')
      ? node.name.slice(node.name.lastIndexOf('/') + 1)
      : node.name
    const result = await props.provider.downloadDirectory(node.path, `${baseName}.zip`)
    if (result.ok) {
      if ((isWechatBrowser() || isAndroidCapacitor()) && result.url) {
        // 微信浏览器和安卓 WebView 可能阻止 Blob 自动下载，显示可鉴权的下载链接
        downloadDialog.url = result.url
        downloadDialog.fileName = `${baseName}.zip`
        downloadDialog.visible = true
      } else {
        ElMessage.success(`已触发下载：${baseName}.zip`)
      }
    } else {
      ElMessage.error(result.error || '下载失败')
      // 如果有URL，显示下载链接对话框
      if (result.url) {
        downloadDialog.url = result.url
        downloadDialog.fileName = `${baseName}.zip`
        downloadDialog.visible = true
      }
    }
  } finally {
    downloading.value = false
  }
}

const SEARCH_DEBOUNCE_MS = 300
const SEARCH_RESULT_LIMIT = 100

const filterText = ref('')
const searchResults = ref<FileNode[] | null>(null)
const searching = ref(false)
const searchError = ref('')
const searchTruncated = ref(false)
let searchSeq = 0
let searchDebounceTimer: ReturnType<typeof setTimeout> | null = null

const isSearchMode = computed(() => filterText.value.trim().length > 0)

function resetSearchState() {
  searchSeq++
  if (searchDebounceTimer) {
    clearTimeout(searchDebounceTimer)
    searchDebounceTimer = null
  }
  searchResults.value = null
  searching.value = false
  searchError.value = ''
  searchTruncated.value = false
}

watch(filterText, (val) => {
  const keyword = val.trim()
  if (searchDebounceTimer) {
    clearTimeout(searchDebounceTimer)
    searchDebounceTimer = null
  }
  if (!keyword) {
    resetSearchState()
    return
  }
  // 防抖后经 provider.searchFiles 一次拿全部匹配。
  // 勿改回全树逐层加载：多仓库工作区会产生数千并发目录请求，
  // 耗尽浏览器资源（ERR_INSUFFICIENT_RESOURCES）导致满屏网络错误。
  searchDebounceTimer = setTimeout(async () => {
    searchDebounceTimer = null
    const provider = props.provider
    if (!provider) return
    const seq = ++searchSeq
    searching.value = true
    searchError.value = ''
    try {
      const result = await provider.searchFiles(keyword, SEARCH_RESULT_LIMIT)
      if (seq !== searchSeq) return
      if (result.error) {
        searchError.value = result.error
        searchResults.value = []
        searchTruncated.value = false
        return
      }
      searchResults.value = (result.entries ?? []).map((entry) => ({
        // 行内展示完整相对路径，便于区分不同目录下的同名文件
        name: entry.path,
        path: entry.path,
        isDirectory: false,
        isSymlink: false,
        size: entry.size,
      }))
      searchTruncated.value = !!result.truncated
    } finally {
      if (seq === searchSeq) searching.value = false
    }
  }, SEARCH_DEBOUNCE_MS)
})

watch(providerRef, () => {
  // 切换会话/工作区：清空筛选，避免上一会话的搜索结果串台
  filterText.value = ''
  resetSearchState()
})

function handleOpenFile(payload: { path: string; title: string }) {
  // 搜索结果行展示的是完整相对路径，打开页签标题回退为文件名
  const title = payload.title.includes('/')
    ? payload.title.slice(payload.title.lastIndexOf('/') + 1)
    : payload.title
  emit('open-file', { path: payload.path, title })
}

function handleToggleDir(node: FileNode) {
  expandDir(node)
}

function handleRetry(node: FileNode) {
  node.error = undefined
  node.children = undefined
  expandDir(node)
}

function handleRefresh() {
  if (loading.value) return
  refresh()
}

onUnmounted(() => {
  resetSearchState()
})
</script>

<style scoped>
.file-tree {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
}

.file-tree-toolbar {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 8px 8px 4px 8px;
  
}

.file-tree-toolbar :deep(.el-input) {
  flex: 1;
  font-size: 14px;
}

.toolbar-refresh {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  font-size: 16px;
  color: var(--aw-ink-muted-48);
  cursor: pointer;
  padding: 0;
  border: none;
  background: transparent;
  border-radius: var(--aw-radius-xs);
  transition: color 0.15s, background 0.15s;
}

.toolbar-refresh:hover:not(:disabled) {
  color: var(--aw-ink);
  background: var(--aw-canvas-parchment);
}

.toolbar-refresh:disabled {
  opacity: 0.4;
  cursor: default;
}

.file-tree-content {
  flex: 1;
  overflow: auto;
  min-height: 0;
}

.file-tree-inner {
  width: max-content;
  min-width: 100%;
  padding: 2px 0;
}

.file-tree-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: var(--aw-ink-muted-48);
  font-size: var(--aw-text-caption);
}

.hidden-input {
  display: none;
}

.upload-progress {
  padding: 4px 10px 0;
  font-size: var(--aw-text-fine);
  color: var(--aw-ink-muted-64);
}

.root-create,
.node-name-input {
  margin: 4px 8px;
}

.node-name-input {
  width: calc(100% - 16px);
  font-size: var(--aw-text-caption);
  color: var(--aw-ink);
  background: var(--aw-surface, #fff);
  border: 1px solid var(--aw-primary);
  border-radius: var(--aw-radius-xs);
  padding: 2px 4px;
}

.search-truncated-hint {
  padding: 4px 10px;
  color: var(--aw-ink-muted-48);
  font-size: var(--aw-text-fine);
  white-space: nowrap;
}

.file-tree-empty p {
  margin: 0;
}

.file-tree-content::-webkit-scrollbar {
  width: 4px;
  height: 4px;
}

.file-tree-content::-webkit-scrollbar-track {
  background: transparent;
}

.file-tree-content::-webkit-scrollbar-thumb {
  background: var(--aw-hairline);
  border-radius: 2px;
}

[data-theme="dark"] .toolbar-refresh:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.06);
}
</style>
