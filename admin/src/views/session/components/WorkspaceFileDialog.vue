<template>
  <el-dialog
    :model-value="visible"
    width="1080px"
    top="6vh"
    append-to-body
    destroy-on-close
    class="workspace-file-dialog"
    @update:model-value="$emit('update:visible', $event)"
  >
    <template #header>
      <div class="wf-header">
        <span class="wf-title">工作区文件 · 会话 #{{ files.state.sessionId ?? '-' }}</span>
        <div class="wf-actions">
          <el-input
            v-model="searchInput"
            size="small"
            class="wf-search"
            clearable
            placeholder="搜索文件名（大小写不敏感）"
            @input="onSearchInput"
            @clear="onSearchClear"
          />
          <!-- 图标 / 列表视图切换：偏好本地记住，对齐桌面端文件管理器的双视图 -->
          <el-radio-group v-model="viewMode" size="small" class="wf-view-mode">
            <el-radio-button value="grid" title="图标视图"><el-icon><Grid /></el-icon></el-radio-button>
            <el-radio-button value="list" title="列表视图"><el-icon><List /></el-icon></el-radio-button>
          </el-radio-group>
          <el-button size="small" :loading="files.state.loading" @click="files.refresh()">刷新</el-button>
          <el-button size="small" type="primary" :loading="zipLoading" @click="onDownloadZip">下载目录 zip</el-button>
        </div>
      </div>
    </template>

    <div class="wf-body" v-loading="files.state.loading">
      <!-- 面包屑：段可点击回跳 -->
      <div class="wf-breadcrumb">
        <span class="wf-crumb" :class="{ active: !files.state.currentDir }" @click="files.navigateTo('')">工作区</span>
        <template v-for="(seg, idx) in breadcrumbSegments" :key="seg.path">
          <span class="wf-sep">/</span>
          <span
            class="wf-crumb"
            :class="{ active: idx === breadcrumbSegments.length - 1 }"
            @click="files.navigateTo(seg.path)"
          >{{ seg.name }}</span>
        </template>
      </div>

      <!-- 搜索结果 -->
      <div v-if="files.state.search" class="wf-panel">
        <div class="wf-panel-bar">
          <span>
            “{{ files.state.search.pattern }}” 的搜索结果{{ files.state.search.truncated ? '（结果过多已截断）' : '' }}
            <span v-if="files.state.searchLoading" class="wf-searching">搜索中…</span>
          </span>
          <el-button text size="small" @click="onSearchClear">退出搜索</el-button>
        </div>
        <div v-if="files.state.search.entries.length === 0 && !files.state.searchLoading" class="wf-empty">未找到匹配文件</div>
        <div v-else-if="viewMode === 'grid'" class="wf-grid-wrap">
          <div
            v-for="entry in files.state.search.entries"
            :key="entry.path"
            class="wf-grid-cell"
            @click="onSearchResultClick(entry)"
          >
            <el-icon class="wf-grid-icon" :class="`is-${iconKindOf(entry.name, entry.isDirectory, entry.isSymlink)}`">
              <FolderOpened v-if="iconKindOf(entry.name, entry.isDirectory, entry.isSymlink) === 'folder'" />
              <Link v-else-if="iconKindOf(entry.name, entry.isDirectory, entry.isSymlink) === 'link'" />
              <Picture v-else-if="iconKindOf(entry.name, entry.isDirectory, entry.isSymlink) === 'image'" />
              <Document v-else />
            </el-icon>
            <span class="wf-grid-name" :title="entry.path">{{ entry.name }}</span>
          </div>
        </div>
        <div v-else class="wf-table-wrap">
          <table class="wf-table">
            <tbody>
              <tr v-for="entry in files.state.search.entries" :key="entry.path" class="wf-row-clickable" @click="onSearchResultClick(entry)">
                <td class="wf-name">
                  <el-icon class="wf-icon" :class="`is-${iconKindOf(entry.name, entry.isDirectory, entry.isSymlink)}`">
                    <FolderOpened v-if="iconKindOf(entry.name, entry.isDirectory, entry.isSymlink) === 'folder'" />
                    <Link v-else-if="iconKindOf(entry.name, entry.isDirectory, entry.isSymlink) === 'link'" />
                    <Picture v-else-if="iconKindOf(entry.name, entry.isDirectory, entry.isSymlink) === 'image'" />
                    <Document v-else />
                  </el-icon>
                  <span class="wf-name-text" :title="entry.path">{{ entry.path }}</span>
                </td>
                <td class="wf-size">{{ formatSize(entry.size) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- 目录列表 -->
      <template v-else>
        <div v-if="files.state.error" class="wf-empty">工作区目录不存在或已被清理</div>
        <div v-else-if="files.state.entries.length === 0 && !files.state.loading" class="wf-empty">空目录</div>
        <template v-else>
          <!-- 图标视图：网格平铺，目录优先由后端 listDirectory 保证 -->
          <div v-if="viewMode === 'grid'" class="wf-grid-wrap">
            <div
              v-for="entry in files.state.entries"
              :key="entry.path"
              class="wf-grid-cell"
              :class="{ 'is-symlink': entry.isSymlink }"
              @click="onRowClick(entry)"
            >
              <el-icon class="wf-grid-icon" :class="`is-${iconKindOf(entry.name, entry.isDirectory, entry.isSymlink)}`">
                <FolderOpened v-if="iconKindOf(entry.name, entry.isDirectory, entry.isSymlink) === 'folder'" />
                <Link v-else-if="iconKindOf(entry.name, entry.isDirectory, entry.isSymlink) === 'link'" />
                <Picture v-else-if="iconKindOf(entry.name, entry.isDirectory, entry.isSymlink) === 'image'" />
                <Document v-else />
              </el-icon>
              <span class="wf-grid-name" :title="`${entry.name}${entry.isSymlink ? '（符号链接，不可进入）' : ''}`">
                {{ entry.name }}
              </span>
              <span class="wf-grid-meta">{{ entry.isDirectory ? formatTime(entry.mtimeMs) : formatSize(entry.size) }}</span>
              <div class="wf-grid-ops" @click.stop>
                <template v-if="!entry.isSymlink">
                  <el-button v-if="!entry.isDirectory" text size="small" @click="emit('preview', entry.path)">预览</el-button>
                  <el-button text size="small" @click="onDownload(entry)">下载</el-button>
                </template>
                <el-tooltip v-else content="符号链接不可进入" placement="top">
                  <span class="wf-symlink-hint">链接</span>
                </el-tooltip>
              </div>
            </div>
          </div>
          <!-- 列表视图：名称 / 大小 / 修改时间 -->
          <div v-else class="wf-table-wrap">
            <table class="wf-table">
              <thead>
                <tr>
                  <th>名称</th>
                  <th class="wf-size">大小</th>
                  <th class="wf-time">修改时间</th>
                  <th class="wf-ops">操作</th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="entry in files.state.entries"
                  :key="entry.path"
                  :class="{ 'is-symlink': entry.isSymlink }"
                  @click="onRowClick(entry)"
                >
                  <td class="wf-name">
                    <el-icon class="wf-icon" :class="`is-${iconKindOf(entry.name, entry.isDirectory, entry.isSymlink)}`">
                      <FolderOpened v-if="iconKindOf(entry.name, entry.isDirectory, entry.isSymlink) === 'folder'" />
                      <Link v-else-if="iconKindOf(entry.name, entry.isDirectory, entry.isSymlink) === 'link'" />
                      <Picture v-else-if="iconKindOf(entry.name, entry.isDirectory, entry.isSymlink) === 'image'" />
                      <Document v-else />
                    </el-icon>
                    <span class="wf-name-text" :title="entry.path">{{ entry.name }}</span>
                    <el-tag v-if="entry.isSymlink" size="small" type="info">链接</el-tag>
                  </td>
                  <td class="wf-size">{{ entry.isDirectory ? '—' : formatSize(entry.size) }}</td>
                  <td class="wf-time">{{ formatTime(entry.mtimeMs) }}</td>
                  <td class="wf-ops">
                    <template v-if="!entry.isSymlink">
                      <el-button v-if="!entry.isDirectory" text size="small" @click.stop="emit('preview', entry.path)">预览</el-button>
                      <el-button text size="small" @click.stop="onDownload(entry)">下载</el-button>
                    </template>
                    <span v-else class="wf-symlink-hint">符号链接不可进入</span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </template>
        <div v-if="files.state.truncated" class="wf-truncated">仅显示前 500 条，请进入子目录查看</div>
      </template>
    </div>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { Document, FolderOpened, Grid, Link, List, Picture } from '@element-plus/icons-vue'
import { formatSize, formatTime, iconKindOf } from '../utils/file-format'
import type { DirectoryEntry, WorkspaceFilesController } from '../composables/useWorkspaceFiles'

const props = defineProps<{
  visible: boolean
  files: WorkspaceFilesController
}>()

const emit = defineEmits<{
  'update:visible': [value: boolean]
  /** 打开文件预览：内容渲染在父级挂载的独立预览弹窗里 */
  preview: [path: string]
}>()

const files = props.files

const searchInput = ref('')
const zipLoading = ref(false)
let searchTimer: ReturnType<typeof setTimeout> | null = null

/** 图标 / 列表视图模式：偏好记在 localStorage，刷新与下次打开保持 */
const VIEW_MODE_KEY = 'mao.admin.workspace-files.viewMode'
const viewMode = ref<'grid' | 'list'>(localStorage.getItem(VIEW_MODE_KEY) === 'list' ? 'list' : 'grid')
watch(viewMode, (mode) => localStorage.setItem(VIEW_MODE_KEY, mode))

const breadcrumbSegments = computed(() => {
  const dir = files.state.currentDir
  if (!dir) return []
  const parts = dir.split('/')
  return parts.map((name, idx) => ({ name, path: parts.slice(0, idx + 1).join('/') }))
})

function onRowClick(entry: DirectoryEntry) {
  if (entry.isSymlink) return
  if (entry.isDirectory) {
    files.enterDir(entry)
    return
  }
  emit('preview', entry.path)
}

function onSearchResultClick(entry: DirectoryEntry) {
  const parent = entry.path.split('/').slice(0, -1).join('/')
  files.navigateTo(parent)
}

async function onDownload(entry: DirectoryEntry) {
  try {
    if (entry.isDirectory) {
      await files.downloadZip(entry.path)
    } else {
      await files.downloadFile(entry.path)
    }
  } catch (e) {
    ElMessage.error((e as Error)?.message || '下载失败')
  }
}

async function onDownloadZip() {
  zipLoading.value = true
  try {
    await files.downloadZip(files.state.currentDir || undefined)
  } catch (e) {
    ElMessage.error((e as Error)?.message || '下载失败')
  } finally {
    zipLoading.value = false
  }
}

function onSearchInput(value: string) {
  if (searchTimer) clearTimeout(searchTimer)
  searchTimer = setTimeout(() => {
    void runSearch(value)
  }, 300)
}

async function runSearch(value: string) {
  try {
    await files.search(value)
  } catch {
    ElMessage.error('搜索失败，请重试')
  }
}

function onSearchClear() {
  if (searchTimer) clearTimeout(searchTimer)
  files.exitSearch()
}
</script>

<style scoped>
/* 非全屏弹窗：固定最大高度，内部改为「面包屑/表格/预览」纵向滚动，
   避免弹窗被内容顶高后超出视口（全屏时期 vh 上限即够，弹窗下不再成立）。 */
.workspace-file-dialog :deep(.el-dialog) {
  max-height: 88vh;
  display: flex;
  flex-direction: column;
  margin-bottom: 0 !important;
}

.workspace-file-dialog :deep(.el-dialog__body) {
  min-height: 0;
  overflow: hidden;
}

.wf-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
}

.wf-title {
  font-size: 15px;
  font-weight: 600;
}

.wf-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.wf-search {
  width: 260px;
}

/* 视图切换器是纯图标按钮，压缩默认内边距避免挤占操作区 */
.wf-view-mode :deep(.el-radio-button__inner) {
  padding: 5px 8px;
}

.wf-body {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.wf-breadcrumb {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 2px;
  font-size: 13px;
  padding: 6px 10px;
  background: var(--el-fill-color-light);
  border-radius: 4px;
  flex-shrink: 0;
}

.wf-sep {
  color: var(--el-text-color-placeholder);
}

.wf-crumb {
  color: var(--el-color-primary);
  cursor: pointer;
  padding: 0 2px;
}

.wf-crumb:hover {
  text-decoration: underline;
}

.wf-crumb.active {
  color: var(--el-text-color-primary);
  font-weight: 600;
  cursor: default;
}

.wf-crumb.active:hover {
  text-decoration: none;
}

.wf-panel {
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 4px;
  overflow: hidden;
}

.wf-panel-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 6px 10px;
  font-size: 13px;
  background: var(--el-fill-color-light);
}

.wf-searching {
  margin-left: 8px;
  color: var(--el-text-color-secondary);
}

/* 表格与预览区各自滚动，父级（.wf-body）不整体撑高弹窗 */
.wf-table-wrap {
  flex: 1 1 auto;
  min-height: 120px;
  max-height: 44vh;
  overflow: auto;
}

/* 图标视图：自适应网格（minmax 100px），与列表区共用滚动约束 */
.wf-grid-wrap {
  flex: 1 1 auto;
  min-height: 120px;
  max-height: 44vh;
  overflow: auto;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(100px, 1fr));
  gap: 4px;
  padding: 10px;
  align-content: start;
}

.wf-grid-cell {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 10px 6px 6px;
  border: 1px solid transparent;
  border-radius: 4px;
  cursor: pointer;
  user-select: none;
}

.wf-grid-cell:hover {
  background: var(--el-fill-color-light);
}

.wf-grid-cell.is-symlink {
  cursor: default;
  opacity: 0.75;
}

.wf-grid-icon {
  font-size: 30px;
  color: var(--el-text-color-secondary);
}

.wf-grid-icon.is-folder {
  color: var(--el-color-primary);
}

.wf-grid-icon.is-image {
  color: #7c5cbf;
}

.wf-grid-icon.is-link {
  color: var(--el-text-color-placeholder);
}

.wf-grid-name {
  max-width: 100%;
  font-size: 12px;
  color: var(--el-text-color-primary);
  text-align: center;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.wf-grid-meta {
  max-width: 100%;
  font-size: 11px;
  color: var(--el-text-color-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 图标卡片操作按钮：默认隐藏，hover / focus-within 时浮现，避免网格被文字按钮铺满 */
.wf-grid-ops {
  display: flex;
  align-items: center;
  gap: 2px;
  min-height: 20px;
  opacity: 0;
  transition: opacity 0.15s;
}

.wf-grid-cell:hover .wf-grid-ops,
.wf-grid-cell:focus-within .wf-grid-ops {
  opacity: 1;
}

.wf-grid-ops :deep(.el-button) {
  padding: 0 2px;
  font-size: 12px;
}

.wf-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}

.wf-table th,
.wf-table td {
  padding: 6px 10px;
  text-align: left;
  border-bottom: 1px solid var(--el-border-color-lighter);
}

.wf-table th {
  background: var(--el-fill-color-lighter);
  color: var(--el-text-color-secondary);
  font-weight: 500;
  position: sticky;
  top: 0;
}

.wf-table tbody tr {
  cursor: pointer;
}

.wf-table tbody tr:hover {
  background: var(--el-fill-color-light);
}

.wf-table tbody tr.is-symlink {
  cursor: default;
  color: var(--el-text-color-disabled);
}

.wf-name {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.wf-icon {
  flex-shrink: 0;
  font-size: 15px;
  color: var(--el-text-color-secondary);
}

.wf-icon.is-folder {
  color: var(--el-color-primary);
}

.wf-icon.is-image {
  color: #7c5cbf;
}

.wf-icon.is-link {
  color: var(--el-text-color-placeholder);
}

.wf-name-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.wf-size {
  width: 110px;
  white-space: nowrap;
}

.wf-time {
  width: 150px;
  white-space: nowrap;
}

.wf-ops {
  width: 150px;
  white-space: nowrap;
}

.wf-symlink-hint {
  font-size: 12px;
  color: var(--el-text-color-placeholder);
}

.wf-truncated {
  padding: 6px 10px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.wf-empty {
  padding: 24px;
  text-align: center;
  color: var(--el-text-color-secondary);
  font-size: 13px;
}

@media (max-width: 768px) {
  /* 窄屏拉满可用宽度（1080px 会超出视口被裁切） */
  .workspace-file-dialog :deep(.el-dialog) {
    width: calc(100vw - 24px) !important;
    max-height: 92vh;
  }

  .wf-search {
    width: 160px;
  }

  .wf-time {
    display: none;
  }

  .wf-table-wrap,
  .wf-grid-wrap {
    max-height: 34vh;
  }

  /* 窄屏图标网格收紧为紧凑密度，操作按钮常显（触屏没有 hover） */
  .wf-grid-wrap {
    grid-template-columns: repeat(auto-fill, minmax(84px, 1fr));
    gap: 2px;
    padding: 8px;
  }

  .wf-grid-cell {
    padding: 8px 4px 6px;
  }

  .wf-grid-icon {
    font-size: 24px;
  }

  .wf-grid-ops {
    opacity: 1;
  }
}
</style>
