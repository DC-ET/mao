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
          type="button"
          class="toolbar-refresh"
          aria-label="刷新文件树"
          :disabled="loading"
          @click="handleRefresh"
        ><el-icon :size="16"><Refresh /></el-icon></button>
      </div>
      <div class="file-tree-content" v-loading="loading || searching">
        <template v-if="isSearchMode">
          <div v-if="searchError" class="file-tree-empty">
            <p>{{ searchError }}</p>
          </div>
          <div v-else-if="searchResults != null && searchResults.length === 0" class="file-tree-empty">
            <p>无匹配文件</p>
          </div>
          <div v-else class="file-tree-inner">
            <div v-if="searchTruncated && searchResults?.length" class="search-truncated-hint">
              匹配较多，仅显示前 {{ searchResults.length }} 条
            </div>
            <FileTreeNode
              v-for="node in searchResults ?? []"
              :key="node.path"
              :node="node"
              :depth="0"
              @open-file="handleOpenFile"
              @node-contextmenu="handleNodeContextmenu"
            />
          </div>
        </template>
        <template v-else>
          <div v-if="treeData.length === 0 && !loading" class="file-tree-empty">
            <p>空目录</p>
          </div>
          <div v-else class="file-tree-inner">
            <FileTreeNode
              v-for="node in treeData"
              :key="node.path"
              :node="node"
              :depth="0"
              @open-file="handleOpenFile"
              @toggle-dir="handleToggleDir"
              @retry="handleRetry"
              @node-contextmenu="handleNodeContextmenu"
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
      @hide="ctxMenu.visible = false"
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
import { ref, reactive, computed, toRef, watch, onUnmounted } from 'vue'
import { Refresh, Search } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
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

const props = defineProps<{
  workspace?: string
  executionMode?: string
  provider: WorkspaceFileProvider | null
}>()

const emit = defineEmits<{
  'open-file': [payload: { path: string; title: string }]
  'add-file-to-chat': [filePath: string]
}>()

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
  if (!ctxMenu.node) return
  emit('add-file-to-chat', ctxMenu.node.path)
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
