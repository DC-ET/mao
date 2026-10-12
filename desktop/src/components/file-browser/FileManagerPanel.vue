<template>
  <div
    ref="rootEl"
    class="file-manager-panel"
    tabindex="0"
    @keydown="onKeydown"
  >
    <div class="fm-header">
      <span class="fm-title">文件管理</span>
      <div class="fm-header-actions">
        <el-radio-group :model-value="viewMode" size="small" @update:model-value="setViewMode">
          <el-radio-button value="grid" title="图标视图"><el-icon><Grid /></el-icon></el-radio-button>
          <el-radio-button value="list" title="列表视图"><el-icon><List /></el-icon></el-radio-button>
        </el-radio-group>
        <el-dropdown size="small" trigger="click" @command="onSortCommand">
          <button class="fm-icon-btn" title="排序">
            <el-icon><Sort /></el-icon>
          </button>
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item :command="{ field: 'name' }">
                <span>按名称</span>
                <el-icon v-if="sortBy === 'name'" class="fm-sort-flag"><CaretTop v-if="sortOrder === 'asc'" /><CaretBottom v-else /></el-icon>
              </el-dropdown-item>
              <el-dropdown-item :command="{ field: 'size' }">
                <span>按大小</span>
                <el-icon v-if="sortBy === 'size'" class="fm-sort-flag"><CaretTop v-if="sortOrder === 'asc'" /><CaretBottom v-else /></el-icon>
              </el-dropdown-item>
              <el-dropdown-item :command="{ field: 'mtime' }">
                <span>按修改时间</span>
                <el-icon v-if="sortBy === 'mtime'" class="fm-sort-flag"><CaretTop v-if="sortOrder === 'asc'" /><CaretBottom v-else /></el-icon>
              </el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
        <button class="fm-icon-btn" title="刷新" :disabled="loading" @click="handleRefresh">
          <el-icon><Refresh /></el-icon>
        </button>
      </div>
    </div>

    <div class="fm-nav-row">
      <button class="fm-icon-btn" title="后退" :disabled="!canGoBack" @click="goBack">
        <el-icon><ArrowLeft /></el-icon>
      </button>
      <button class="fm-icon-btn" title="前进" :disabled="!canGoForward" @click="goForward">
        <el-icon><ArrowRight /></el-icon>
      </button>
      <div class="fm-breadcrumb">
        <span class="fm-crumb" :class="{ active: currentDir === '' }" @click="navigateTo('')">工作区</span>
        <template v-for="seg in breadcrumbs" :key="seg.path">
          <span class="fm-crumb-sep">/</span>
          <span class="fm-crumb" :class="{ active: seg.path === currentDir }" @click="navigateTo(seg.path)">{{ seg.name }}</span>
        </template>
      </div>
      <el-input
        v-model="searchQuery"
        class="fm-search"
        size="small"
        placeholder="搜索整个工作区"
        clearable
        :prefix-icon="Search"
        @keydown.esc="searchQuery = ''"
      />
    </div>

    <div
      class="fm-body"
      v-loading="loading || searching"
      @dragover.prevent="onBodyDragOver"
      @drop.prevent="onBodyDrop"
      @contextmenu.prevent="onBlankContextMenu"
    >
      <template v-if="searchResults">
        <div v-if="searchError" class="fm-empty"><p>{{ searchError }}</p></div>
        <div v-else-if="searchResults.length === 0" class="fm-empty"><p>无匹配文件</p></div>
        <template v-else>
          <div v-if="searchTruncated" class="fm-hint">匹配较多，仅显示前 {{ searchResults.length }} 条</div>
          <div class="fm-search-list">
            <div
              v-for="entry in searchResults"
              :key="entry.path"
              class="fm-search-row"
              @click="jumpToSearchResult(entry)"
            >
              <el-icon class="fm-row-icon"><Document /></el-icon>
              <span class="fm-search-name">{{ entry.name }}</span>
              <span class="fm-search-path">{{ entry.path }}</span>
            </div>
          </div>
        </template>
      </template>
      <template v-else-if="error">
        <div class="fm-empty">
          <p>{{ error }}</p>
          <button class="fm-text-btn" @click="handleRefresh">重试</button>
        </div>
      </template>
      <template v-else-if="!loading && sortedEntries.length === 0 && !creating">
        <div class="fm-empty">
          <el-icon :size="40"><FolderOpened /></el-icon>
          <p>空目录</p>
          <p class="fm-empty-hint">拖拽文件到此处上传，或右键新建</p>
        </div>
      </template>
      <template v-else>
        <FileManagerGrid
          v-if="viewMode === 'grid'"
          :entries="sortedEntries"
          :selected-paths="selectedList"
          :renaming-path="renamingPath"
          :creating="creating"
          :drop-target-path="dropTargetPath"
          @open="handleOpen"
          @contextmenu="openContextMenu"
          @toggle-select="onToggleSelect"
          @commit-rename="commitRename"
          @commit-create="commitCreate"
          @cancel-edit="cancelDraft"
          @item-dragstart="onItemDragstart"
          @folder-dragover="dropTargetPath = $event"
          @folder-dragleave="dropTargetPath = ''"
          @folder-drop="onFolderDrop"
        />
        <FileManagerList
          v-else
          :entries="sortedEntries"
          :selected-paths="selectedList"
          :renaming-path="renamingPath"
          :creating="creating"
          :drop-target-path="dropTargetPath"
          :sort-by="sortBy"
          :sort-order="sortOrder"
          @open="handleOpen"
          @contextmenu="openContextMenu"
          @toggle-select="onToggleSelect"
          @commit-rename="commitRename"
          @commit-create="commitCreate"
          @cancel-edit="cancelDraft"
          @item-dragstart="onItemDragstart"
          @folder-dragover="dropTargetPath = $event"
          @folder-dragleave="dropTargetPath = ''"
          @folder-drop="onFolderDrop"
          @sort="setSort"
        />
      </template>
    </div>

    <div v-if="uploadProgress" class="fm-upload-progress">
      <span>{{ uploadProgress.error ? `${uploadProgress.label}：${uploadProgress.error}` : uploadProgress.label }}</span>
      <el-progress :percentage="uploadProgress.percent" :status="uploadProgress.error ? 'exception' : undefined" />
    </div>

    <div class="fm-statusbar">
      <span class="fm-counts">
        共 {{ sortedEntries.length }} 项
        <template v-if="selectedCount > 0"> · 已选 {{ selectedCount }} 项</template>
        <template v-if="clipboardCount > 0"> · 剪贴板 {{ clipboardCount }} 项</template>
      </span>
      <div class="fm-status-actions">
        <button class="fm-text-btn" @click="pickUpload(false)"><el-icon><Upload /></el-icon>上传文件</button>
        <button class="fm-text-btn" @click="pickUpload(true)"><el-icon><FolderAdd /></el-icon>上传文件夹</button>
        <button class="fm-text-btn" @click="beginCreate('file')"><el-icon><DocumentAdd /></el-icon>新建文件</button>
        <button class="fm-text-btn" @click="beginCreate('dir')"><el-icon><FolderAdd /></el-icon>新建文件夹</button>
        <button class="fm-text-btn" :disabled="selectedCount === 0" @click="handleDelete"><el-icon><Delete /></el-icon>删除</button>
        <button class="fm-text-btn" :disabled="selectedCount === 0" @click="handleDownload"><el-icon><Download /></el-icon>下载</button>
        <button class="fm-text-btn" :disabled="selectedCount === 0" @click="handleCopyPath"><el-icon><DocumentCopy /></el-icon>复制路径</button>
      </div>
    </div>

    <input ref="fileInput" class="fm-hidden-input" type="file" multiple @change="onPickFiles" />
    <input ref="dirInput" class="fm-hidden-input" type="file" multiple webkitdirectory @change="onPickFiles" />

    <FileManagerContextMenu
      :visible="ctxMenu.visible"
      :x="ctxMenu.x"
      :y="ctxMenu.y"
      :entry="ctxMenu.entry"
      :selected-count="selectedCount"
      :can-paste="canPaste"
      @hide="ctxMenu.visible = false"
      @open="handleCtxOpen"
      @create-file="beginCreate('file', ctxTargetDir())"
      @create-dir="beginCreate('dir', ctxTargetDir())"
      @upload-here="pickUpload(false, ctxTargetDir())"
      @rename="handleCtxRename"
      @remove="handleDelete"
      @cut="handleClipboard('cut')"
      @copy="handleClipboard('copy')"
      @paste="handlePaste"
      @download="handleDownload"
      @download-zip="handleDownloadZip"
      @copy-path="handleCopyPath"
      @add-to-chat="handleAddToChat"
      @locate="handleLocate"
      @select-all="selectAll"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, onActivated, onMounted, reactive, ref, toRef } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  ArrowLeft, ArrowRight, CaretBottom, CaretTop, Delete, Document, DocumentAdd, DocumentCopy,
  Download, FolderAdd, FolderOpened, Grid, List, Refresh, Search, Sort, Upload,
} from '@element-plus/icons-vue'
import type { FileNode } from '../../types/file-browser'
import type { WorkspaceFileProvider } from '../../composables/workspace-file-provider'
import type { WorkspacePathChange } from '../../utils/workspace-tab-paths'
import { useFileManager } from '../../composables/useFileManager'
import { useFileClipboard } from '../../composables/useFileClipboard'
import { copyText } from '../../utils/clipboard'
import {
  DRAG_PATHS_MIME, canDropTarget, canDropTargetDir, dedupeMoveSources, isValidEntryName, joinRel, parentDirOf, parseDragPaths,
} from '../../utils/file-manager'
import {
  copyWorkspacePath, deleteWorkspacePath, filesFromDataTransfer, filesFromInput, mkdirWorkspace,
  moveWorkspacePath, renameWorkspacePath, uploadWorkspace, writeWorkspaceFile,
  type UploadItem, type UploadProgress,
} from '../../composables/workspace-file-write'
import FileManagerGrid from './FileManagerGrid.vue'
import FileManagerList from './FileManagerList.vue'
import FileManagerContextMenu from './FileManagerContextMenu.vue'

const props = defineProps<{
  sessionId: string
  provider: WorkspaceFileProvider | null
}>()

const emit = defineEmits<{
  'open-file': [payload: { path: string; title: string }]
  'add-file-to-chat': [filePath: string]
  'paths-changed': [change: WorkspacePathChange]
  'tree-refresh': []
  'locate-in-tree': [relPath: string]
}>()

const providerRef = toRef(props, 'provider')
const sessionIdRef = toRef(props, 'sessionId')
const fm = useFileManager(providerRef, sessionIdRef)
const {
  numericSessionId, currentDir, entries, loading, error, selectedCount, selectedList,
  viewMode, sortBy, sortOrder, sortedEntries, breadcrumbs, canGoBack, canGoForward,
  searchQuery, searchResults, searching, searchError, searchTruncated,
  renamingPath, creating, dropTargetPath,
  navigateTo, goBack, goForward, refresh, toggleSelect, selectAll, selectOnly,
  beginCreate, beginRename, cancelDraft, setSort, setViewMode, jumpToSearchResult,
} = fm

const clipboard = useFileClipboard()
const canPaste = computed(() => clipboard.matches(numericSessionId.value))
const clipboardCount = computed(() => (canPaste.value ? clipboard.current?.paths.length ?? 0 : 0))

const rootEl = ref<HTMLDivElement>()
const fileInput = ref<HTMLInputElement>()
const dirInput = ref<HTMLInputElement>()
const uploadDir = ref('')
const uploadProgress = ref<UploadProgress | null>(null)
const ctxMenu = reactive<{ visible: boolean; x: number; y: number; entry: FileNode | null }>({
  visible: false, x: 0, y: 0, entry: null,
})

onMounted(() => rootEl.value?.focus())
onActivated(() => rootEl.value?.focus())

function selectedEntries(): FileNode[] {
  return entries.value.filter((e) => selectedList.value.includes(e.path))
}

/** 右键菜单的「在此新建 / 上传到此处」落点：目录取其自身，文件取其父目录，空白处取当前目录 */
function ctxTargetDir(): string {
  const entry = ctxMenu.entry
  if (!entry) return currentDir.value
  return entry.isDirectory ? entry.path : parentDirOf(entry.path)
}

function ensureWritable(): boolean {
  if (numericSessionId.value > 0) return true
  ElMessage.warning('会话未就绪，暂不能操作文件')
  return false
}

/* ---------- 打开 / 导航 ---------- */

function onToggleSelect(entry: FileNode, mods: { meta: boolean; shift: boolean }) {
  toggleSelect(entry.path, mods)
}

function handleOpen(entry: FileNode) {
  if (entry.isDirectory) {
    navigateTo(entry.path)
    return
  }
  emit('open-file', { path: entry.path, title: entry.name })
}

function handleRefresh() {
  void refresh()
}

/* ---------- 新建 / 重命名 ---------- */

async function commitCreate(name: string) {
  const draft = creating.value
  if (!draft) return
  if (!isValidEntryName(name)) {
    ElMessage.warning('名称不合法')
    return
  }
  if (!ensureWritable()) return
  const path = joinRel(draft.dir, name)
  cancelDraft()
  try {
    if (draft.kind === 'dir') {
      await mkdirWorkspace(numericSessionId.value, path)
    } else {
      const result = await writeWorkspaceFile(numericSessionId.value, path, '')
      emit('open-file', { path: result.path, title: name })
    }
  } catch {
    return // 冲突面板与全局 toast 已提示
  }
  emit('tree-refresh')
  await refresh()
}

async function commitRename(path: string, name: string) {
  if (!renamingPath.value) return
  if (!isValidEntryName(name)) {
    ElMessage.warning('名称不合法')
    return
  }
  if (!ensureWritable()) return
  cancelDraft()
  try {
    const result = await renameWorkspacePath(numericSessionId.value, path, name)
    emit('paths-changed', { kind: 'move', from: path, to: result.path })
  } catch {
    return
  }
  emit('tree-refresh')
  await refresh()
}

/* ---------- 删除 ---------- */

async function handleDelete() {
  const targets = selectedEntries()
  if (targets.length === 0) return
  if (!ensureWritable()) return
  const lines = targets.map((e) => (e.isDirectory ? `${e.path}（目录，将删除其下所有内容）` : e.path))
  // 与侧边栏 touchesGit 同口径：任意层级的 .git 都算版本库，不止根目录那个
  const gitHint = targets.some((e) => {
    const p = e.path
    return p === '.git' || p.startsWith('.git/') || p.endsWith('/.git') || p.includes('/.git/')
  })
    ? '\n\n其中包含 Git 版本库，删除后版本历史将无法通过本地恢复。'
    : ''
  try {
    await ElMessageBox.confirm(
      `确定删除以下 ${targets.length} 项？\n\n${lines.join('\n')}${gitHint}\n\n删除不可恢复。`,
      '删除确认',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' },
    )
  } catch {
    return
  }
  const deleted: string[] = []
  for (const entry of targets) {
    try {
      await deleteWorkspacePath(numericSessionId.value, entry.path)
      deleted.push(entry.path)
    } catch {
      break // 用户取消强制或出错：中止剩余项，已删的照实校正
    }
  }
  if (deleted.length > 0) {
    emit('paths-changed', { kind: 'delete', paths: deleted })
    emit('tree-refresh')
  }
  await refresh()
}

/* ---------- 剪贴板 ---------- */

function handleClipboard(op: 'cut' | 'copy') {
  const paths = selectedList.value
  if (paths.length === 0) return
  clipboard.set(op, numericSessionId.value, paths)
}

async function handlePaste() {
  const clip = clipboard.current
  if (!clip || clip.sessionId !== numericSessionId.value || clip.paths.length === 0) {
    ElMessage.warning('剪贴板为空或不能跨会话粘贴')
    return
  }
  if (!ensureWritable()) return
  const sources = dedupeMoveSources(clip.paths)
  // 后端 path-sandbox 拒收空串，根目录落点必须传 '.'（与 uploadWorkspace、侧边栏 pasteClipboard 同口径）
  const destDir = currentDir.value
  const dest = destDir || '.'
  // cut 到源所在目录是无操作，后端会以「不能移动到自身」拒绝：先滤掉，避免无谓错误 toast；
  // copy 不过滤：同目录复制由后端以「不能复制到自身」直接拒绝，跨目录遇同名才走 3045 覆盖询问。
  const targets = clip.op === 'cut' ? sources.filter((src) => parentDirOf(src) !== destDir) : sources
  if (targets.length === 0) {
    if (clip.op === 'cut') clipboard.clear()
    return
  }
  try {
    for (const src of targets) {
      if (clip.op === 'cut') {
        const result = await moveWorkspacePath(numericSessionId.value, src, dest)
        emit('paths-changed', { kind: 'move', from: src, to: result.path })
      } else {
        await copyWorkspacePath(numericSessionId.value, src, dest)
      }
    }
    // 全部完成后才清剪切板：中途失败（用户取消强制/覆盖）时保留剩余项，与侧边栏 pasteClipboard 一致
    if (clip.op === 'cut') clipboard.clear()
  } catch {
    // 冲突面板与全局 toast 已提示
  }
  emit('tree-refresh')
  await refresh()
}

/* ---------- 拖拽移动 ---------- */

function onItemDragstart(_entry: FileNode, e: DragEvent) {
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
}

async function moveSourcesTo(sources: string[], dir: string, dirIsCurrent = false) {
  if (sources.length === 0) return
  if (!ensureWritable()) return
  // 落到当前目录时它不在自己的子列表里，只能做关系校验；落到可见文件夹才查表确认是目录
  const movable = sources.filter((src) =>
    dirIsCurrent ? canDropTargetDir([src], dir) : canDropTarget([src], dir, entries.value),
  )
  if (movable.length === 0) return
  // 后端 path-sandbox 拒收空串，根目录落点必须传 '.'（与 uploadWorkspace、侧边栏同口径）
  const dest = dir || '.'
  for (const src of movable) {
    try {
      const result = await moveWorkspacePath(numericSessionId.value, src, dest)
      emit('paths-changed', { kind: 'move', from: src, to: result.path })
    } catch {
      break
    }
  }
  emit('tree-refresh')
  await refresh()
}

function onFolderDrop(entry: FileNode, e: DragEvent) {
  dropTargetPath.value = ''
  const paths = parseDragPaths(e.dataTransfer?.getData(DRAG_PATHS_MIME) ?? null)
  if (paths.length > 0) {
    void moveSourcesTo(paths, entry.path)
    return
  }
  if (e.dataTransfer?.files.length) {
    void (async () => {
      const items = await filesFromDataTransfer(e.dataTransfer as DataTransfer)
      await handleFiles(items, entry.path)
    })()
  }
}

function onBodyDragOver(e: DragEvent) {
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
}

function onBodyDrop(e: DragEvent) {
  dropTargetPath.value = ''
  const paths = parseDragPaths(e.dataTransfer?.getData(DRAG_PATHS_MIME) ?? null)
  if (paths.length > 0) {
    void moveSourcesTo(paths, currentDir.value, true)
    return
  }
  if (e.dataTransfer?.files.length) {
    void (async () => {
      const items = await filesFromDataTransfer(e.dataTransfer as DataTransfer)
      await handleFiles(items, currentDir.value)
    })()
  }
}

/* ---------- 上传 ---------- */

function pickUpload(folder: boolean, dir: string = currentDir.value) {
  uploadDir.value = dir
  if (folder) dirInput.value?.click()
  else fileInput.value?.click()
}

function onPickFiles(e: Event) {
  const input = e.target as HTMLInputElement
  const items = filesFromInput(input.files)
  input.value = ''
  void handleFiles(items, uploadDir.value)
}

async function handleFiles(items: UploadItem[], dir: string) {
  if (items.length === 0) return
  if (!ensureWritable()) return
  uploadProgress.value = {
    label: items.length === 1 ? items[0].relativePath : `${items.length} 个文件`,
    percent: 0,
    error: '',
  }
  let ok = false
  try {
    await uploadWorkspace(numericSessionId.value, dir, items, (p) => {
      uploadProgress.value = p
    })
    ok = true
  } catch {
    // 3044/3045 的询问面板与错误 toast 已由 withPrompts 处理
  } finally {
    uploadProgress.value = null
  }
  if (ok) {
    ElMessage.success('上传成功')
    emit('tree-refresh')
    if (dir === currentDir.value) await refresh()
  }
}

/* ---------- 下载 / 复制路径 / 聊天 / 定位 ---------- */

async function handleDownload() {
  const targets = selectedEntries()
  if (targets.length === 0) return
  if (!props.provider) {
    ElMessage.warning('当前模式不支持下载')
    return
  }
  const files = targets.filter((e) => !e.isDirectory)
  const dirs = targets.filter((e) => e.isDirectory)
  if (files.length > 3) ElMessage.info(`将逐个下载 ${files.length} 个文件`)
  let failures = 0
  for (const f of files) {
    const res = await props.provider.downloadFile?.(f.path, f.name)
    if (res && !res.ok) failures++
  }
  for (const d of dirs) {
    const res = await props.provider.downloadDirectory?.(d.path, d.name)
    if (res && !res.ok) failures++
  }
  if (failures > 0) ElMessage.error(`${failures} 个条目下载失败`)
}

async function handleDownloadZip() {
  const entry = ctxMenu.entry
  if (!entry || !props.provider) return
  const res = await props.provider.downloadDirectory?.(entry.path, entry.name)
  if (res && !res.ok) ElMessage.error(res.error || '下载失败')
}

function handleCopyPath() {
  const paths = selectedList.value
  if (paths.length === 0) return
  const abs = paths.map((p) => props.provider?.getAbsolutePath?.(p) ?? p)
  copyText(abs.join('\n'))
}

function handleAddToChat() {
  const paths = selectedList.value
  if (paths.length === 0) return
  for (const p of paths) {
    emit('add-file-to-chat', props.provider?.getAbsolutePath?.(p) ?? p)
  }
}

function handleLocate() {
  const entry = ctxMenu.entry
  if (!entry) return
  emit('locate-in-tree', entry.path)
}

/* ---------- 右键菜单 ---------- */

function openContextMenu(payload: { entry: FileNode | null; x: number; y: number }) {
  const entry = payload.entry
  // 右键未选中条目时把选区校正为该项：菜单的删除/剪切/复制/下载作用于 selectedList，
  // 不校正就会打到陈旧多选上，甚至删错文件（与侧边栏 actionPaths 同一范式）。
  // 右键已选中条目时保留整个选区，批量操作语义不变。
  if (entry && !selectedList.value.includes(entry.path)) selectOnly(entry.path)
  ctxMenu.entry = entry
  ctxMenu.x = payload.x
  ctxMenu.y = payload.y
  ctxMenu.visible = true
}

function onBlankContextMenu(e: MouseEvent) {
  if (searchResults.value) return
  openContextMenu({ entry: null, x: e.clientX, y: e.clientY })
}

function handleCtxOpen() {
  const entry = ctxMenu.entry
  if (entry) handleOpen(entry)
}

function handleCtxRename() {
  const entry = ctxMenu.entry
  if (entry) beginRename(entry.path)
}

/* ---------- 快捷键 ---------- */

function onKeydown(e: KeyboardEvent) {
  const el = e.target as HTMLElement | null
  if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) return
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
    e.preventDefault()
    selectAll()
    return
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c') {
    handleClipboard('copy')
    return
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'x') {
    handleClipboard('cut')
    return
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v') {
    void handlePaste()
    return
  }
  if (e.key === 'Escape') {
    if (creating.value || renamingPath.value) cancelDraft()
    else if (searchQuery.value) searchQuery.value = ''
    return
  }
  if (e.key === 'Enter') {
    const first = selectedEntries()[0]
    if (first) handleOpen(first)
    return
  }
  if (e.key === 'F2') {
    const first = selectedEntries()[0]
    if (first) beginRename(first.path)
    return
  }
  if (e.key === 'Delete') {
    void handleDelete()
  }
}

function onSortCommand(command: { field: 'name' | 'size' | 'mtime' }) {
  setSort(command.field)
}

</script>

<style scoped>
.file-manager-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  outline: none;
  background: var(--aw-surface, #fff);
}

.file-manager-panel:focus-visible {
  box-shadow: inset 0 0 0 1px var(--aw-primary, #0066cc);
}

.fm-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 10px 14px 6px;
}

.fm-title {
  font-size: var(--aw-text-body, 14px);
  font-weight: 600;
  color: var(--aw-ink, #1a1a1a);
}

.fm-header-actions {
  display: flex;
  align-items: center;
  gap: 6px;
}

.fm-icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border: none;
  border-radius: var(--aw-radius-xs, 4px);
  background: transparent;
  color: var(--aw-ink-muted, #666);
  cursor: pointer;
}

.fm-icon-btn:hover:not(:disabled) {
  background: var(--aw-canvas-parchment, #f5f5f5);
  color: var(--aw-ink, #1a1a1a);
}

.fm-icon-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.fm-sort-flag {
  margin-left: 4px;
  font-size: 10px;
}

.fm-nav-row {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 14px 8px;
  border-bottom: 1px solid var(--aw-divider-soft, #e0e0e0);
}

.fm-breadcrumb {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  white-space: nowrap;
  overflow: hidden;
}

.fm-crumb {
  padding: 2px 4px;
  border-radius: var(--aw-radius-xs, 4px);
  font-size: var(--aw-text-caption, 12px);
  color: var(--aw-ink-muted, #666);
  cursor: pointer;
}

.fm-crumb:hover {
  color: var(--aw-primary, #0066cc);
}

.fm-crumb.active {
  color: var(--aw-ink, #1a1a1a);
  font-weight: 600;
}

.fm-crumb-sep {
  color: var(--aw-ink-muted-48, #999);
}

.fm-search {
  width: 200px;
  flex-shrink: 0;
}

.fm-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  position: relative;
}

.fm-hint {
  padding: 6px 16px 0;
  font-size: var(--aw-text-fine, 11px);
  color: var(--aw-ink-muted-48, #999);
}

.fm-search-list {
  display: flex;
  flex-direction: column;
  padding: 4px 0 12px;
}

.fm-search-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 16px;
  font-size: var(--aw-text-caption, 12px);
  color: var(--aw-ink, #1a1a1a);
  cursor: pointer;
}

.fm-search-row:hover {
  background: var(--aw-canvas-parchment, #f5f5f5);
}

.fm-search-name {
  flex-shrink: 0;
}

.fm-search-path {
  min-width: 0;
  color: var(--aw-ink-muted-48, #999);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.fm-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 48px 16px;
  color: var(--aw-ink-muted, #666);
  font-size: var(--aw-text-caption, 12px);
}

.fm-empty p {
  margin: 0;
}

.fm-empty-hint {
  color: var(--aw-ink-muted-48, #999);
}

.fm-upload-progress {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px 14px;
  border-top: 1px solid var(--aw-divider-soft, #e0e0e0);
  font-size: var(--aw-text-caption, 12px);
  color: var(--aw-ink, #1a1a1a);
}

.fm-statusbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 14px;
  border-top: 1px solid var(--aw-divider-soft, #e0e0e0);
  font-size: var(--aw-text-fine, 11px);
  color: var(--aw-ink-muted, #666);
}

.fm-status-actions {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-wrap: wrap;
}

.fm-text-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 8px;
  border: none;
  border-radius: var(--aw-radius-xs, 4px);
  background: transparent;
  color: var(--aw-ink-muted, #666);
  font-size: var(--aw-text-fine, 11px);
  cursor: pointer;
}

.fm-text-btn:hover:not(:disabled) {
  background: var(--aw-canvas-parchment, #f5f5f5);
  color: var(--aw-primary, #0066cc);
}

.fm-text-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.fm-hidden-input {
  display: none;
}

[data-theme="dark"] .file-manager-panel {
  background: var(--aw-surface, #2a2a2a);
}

[data-theme="dark"] .fm-icon-btn:hover:not(:disabled),
[data-theme="dark"] .fm-text-btn:hover:not(:disabled),
[data-theme="dark"] .fm-search-row:hover {
  background: rgba(255, 255, 255, 0.06);
}

[data-theme="dark"] .fm-title,
[data-theme="dark"] .fm-crumb.active {
  color: var(--aw-ink, #e0e0e0);
}
</style>
