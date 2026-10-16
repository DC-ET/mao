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
        <div v-else class="wf-table-wrap">
          <table class="wf-table">
            <tbody>
              <tr v-for="entry in files.state.search.entries" :key="entry.path" class="wf-row-clickable" @click="onSearchResultClick(entry)">
                <td class="wf-name">
                  <span class="wf-icon">📄</span>
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
                  <span class="wf-icon">{{ entry.isDirectory ? (entry.isSymlink ? '🔗' : '📁') : '📄' }}</span>
                  <span class="wf-name-text" :title="entry.path">{{ entry.name }}</span>
                  <el-tag v-if="entry.isSymlink" size="small" type="info">链接</el-tag>
                </td>
                <td class="wf-size">{{ entry.isDirectory ? '—' : formatSize(entry.size) }}</td>
                <td class="wf-time">{{ formatTime(entry.mtimeMs) }}</td>
                <td class="wf-ops">
                  <template v-if="!entry.isSymlink">
                    <el-button v-if="!entry.isDirectory" text size="small" @click.stop="files.previewFile(entry.path)">预览</el-button>
                    <el-button text size="small" @click.stop="onDownload(entry)">下载</el-button>
                  </template>
                  <span v-else class="wf-symlink-hint">符号链接不可进入</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <div v-if="files.state.truncated" class="wf-truncated">仅显示前 500 条，请进入子目录查看</div>
      </template>

      <!-- 预览面板 -->
      <div v-if="preview" ref="previewRef" class="wf-panel wf-preview">
        <div class="wf-panel-bar">
          <span class="wf-preview-path" :title="preview.path">{{ preview.path }}</span>
          <div class="wf-preview-actions">
            <template v-if="preview.data && preview.isMarkdown">
              <el-button text size="small" :type="preview.markdownRendered ? 'primary' : 'default'" @click="setMarkdownView(true)">渲染态</el-button>
              <el-button text size="small" :type="!preview.markdownRendered ? 'primary' : 'default'" @click="setMarkdownView(false)">源码</el-button>
            </template>
            <el-button text size="small" @click="files.closePreview()">关闭预览</el-button>
          </div>
        </div>
        <div class="wf-preview-body">
          <div v-if="preview.loading" class="wf-empty">加载中…</div>
          <template v-else-if="preview.error">
            <div class="wf-preview-error">
              <div>暂不支持预览，请下载后查看</div>
              <div class="wf-preview-error-detail">{{ preview.error }}</div>
              <el-button size="small" type="primary" @click="onDownloadPath(preview.path)">下载</el-button>
            </div>
          </template>
          <template v-else-if="preview.pdfUrl">
            <iframe class="wf-pdf" :src="preview.pdfUrl" title="PDF 预览" />
          </template>
          <template v-else-if="preview.data?.media_type === 'image'">
            <div class="wf-image-summary">{{ preview.data.content }}</div>
            <img class="wf-image" :src="preview.data.data_uri" :alt="preview.path" />
          </template>
          <template v-else-if="preview.data">
            <div v-if="preview.isMarkdown && preview.markdownRendered" class="markdown-body wf-markdown" v-html="renderMarkdown(preview.data.content)" />
            <pre v-else class="wf-text">{{ preview.data.content }}</pre>
            <div v-if="textTruncated" class="wf-truncated">仅显示前 {{ textDisplayedLines }} 行 / 共 {{ preview.data.total_lines }} 行</div>
          </template>
        </div>
      </div>
    </div>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { formatSize, formatTime } from '../utils/file-format'
import { renderMarkdown } from '../composables/useMarkdown'
import type { DirectoryEntry, WorkspaceFilesController } from '../composables/useWorkspaceFiles'

const props = defineProps<{
  visible: boolean
  files: WorkspaceFilesController
}>()

const emit = defineEmits<{
  'update:visible': [value: boolean]
}>()

const files = props.files
const preview = computed(() => files.state.preview)

const searchInput = ref('')
const zipLoading = ref(false)
const previewRef = ref<HTMLElement | null>(null)
let searchTimer: ReturnType<typeof setTimeout> | null = null

const breadcrumbSegments = computed(() => {
  const dir = files.state.currentDir
  if (!dir) return []
  const parts = dir.split('/')
  return parts.map((name, idx) => ({ name, path: parts.slice(0, idx + 1).join('/') }))
})

const textDisplayedLines = computed(() => {
  const data = files.state.preview?.data
  if (data == null || data.media_type != null) return 0
  return data.content.length === 0 ? 0 : data.content.split('\n').length
})

const textTruncated = computed(() => {
  const p = files.state.preview
  return p?.data != null && p.data.media_type == null && textDisplayedLines.value < p.data.total_lines
})

function onRowClick(entry: DirectoryEntry) {
  if (entry.isSymlink) return
  if (entry.isDirectory) {
    files.enterDir(entry)
    return
  }
  void files.previewFile(entry.path)
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

async function onDownloadPath(path: string) {
  try {
    await files.downloadFile(path)
  } catch (e) {
    ElMessage.error((e as Error)?.message || '下载失败')
  }
}

function setMarkdownView(rendered: boolean) {
  const p = files.state.preview
  if (p && p.markdownRendered !== rendered) {
    files.toggleMarkdownView()
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

// 预览目标变化后滚动到预览面板，避免全屏 Dialog 里预览在视口外
watch(
  () => files.state.preview?.path,
  async () => {
    if (files.state.preview == null) return
    await nextTick()
    previewRef.value?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  },
)
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

.wf-preview-path {
  font-family: 'SF Mono', Monaco, Consolas, monospace;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.wf-preview-actions {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}

.wf-preview-body {
  padding: 10px;
  max-height: 36vh;
  overflow: auto;
}

.wf-preview-error {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 8px;
  font-size: 13px;
}

.wf-preview-error-detail {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.wf-text {
  margin: 0;
  padding: 10px;
  font-family: 'SF Mono', Monaco, Consolas, monospace;
  font-size: 12px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-all;
  background: var(--el-fill-color-light);
  border-radius: 4px;
}

.wf-image-summary {
  margin-bottom: 8px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.wf-image {
  max-width: 100%;
  max-height: 30vh;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 4px;
}

.wf-pdf {
  width: 100%;
  height: 34vh;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 4px;
}

/* Markdown 渲染态复用聊天记录样式（marked + DOMPurify 产物） */
.wf-markdown :deep(p) {
  margin: 4px 0;
  font-size: 13px;
  line-height: 1.8;
}

.wf-markdown :deep(pre) {
  margin: 4px 0;
  border-radius: 4px;
  overflow: hidden;
}

.wf-markdown :deep(.code-block-header) {
  display: flex;
  justify-content: space-between;
  padding: 6px 12px;
  background: var(--el-fill-color);
  font-size: 12px;
}

.wf-markdown :deep(code) {
  font-family: 'SF Mono', Monaco, Consolas, monospace;
  font-size: 12px;
}

.wf-markdown :deep(.hljs) {
  padding: 12px;
  background: var(--el-fill-color-light);
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
  .wf-preview-body {
    max-height: 34vh;
  }
}
</style>
