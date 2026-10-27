<template>
  <div class="csv-table-view">
    <div class="csv-toolbar">
      <span class="csv-file-name" :title="filePath">{{ fileName }}</span>
      <span v-if="rows.length > 0" class="csv-meta">{{ rows.length }} 行 × {{ colCount }} 列</span>
      <span class="csv-toolbar-spacer"></span>
      <button class="tool-btn" title="刷新" @click="$emit('refresh')">
        <el-icon :size="14"><Refresh /></el-icon>
      </button>
      <button
        v-if="provider?.downloadFile"
        class="tool-btn"
        title="下载"
        @click="download"
      >
        <el-icon :size="14"><Download /></el-icon>
      </button>
    </div>

    <div
      class="csv-scroll"
      @mouseenter="copyBarVisible = true"
      @mouseleave="scheduleHideCopyBar"
    >
      <!-- hover 复制工具条：组件自有按钮走 Vue @click，不走 document 级委托 -->
      <div
        v-show="copyBarVisible"
        class="csv-copy-bar"
        @mouseenter="cancelHideCopyBar"
        @mouseleave="scheduleHideCopyBar"
      >
        <button class="tool-btn text" @click="copy('csv')">
          {{ copied === 'csv' ? '已复制' : '复制 CSV' }}
        </button>
        <button class="tool-btn text" @click="copy('markdown')">
          {{ copied === 'markdown' ? '已复制' : '复制 Markdown' }}
        </button>
      </div>

      <TableGrid :rows="rows" />
    </div>

    <div v-if="showTruncation" class="truncation-notice">仅显示前 5000 行</div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { Download, Refresh } from '@element-plus/icons-vue'
import TableGrid from './TableGrid.vue'
import { useTableCopyBar } from '../../composables/useTableCopyBar'
import { parseCsv } from '../../utils/csv-parse'
import type { WorkspaceFileProvider } from '../../composables/workspace-file-provider'

const props = defineProps<{
  filePath: string
  content: string
  /** FileViewer 传来的 readFile 截断标记（total_lines > 5000） */
  truncated: boolean
  provider: WorkspaceFileProvider | null
}>()

defineEmits<{
  refresh: []
}>()

const parsed = computed(() => parseCsv(props.content))
const rows = computed(() => parsed.value.rows)
const colCount = computed(() => (rows.value[0]?.length ?? 0))
/** 解析器自身触顶（行列上限）与 readFile 截断任一发生都展示提示 */
const showTruncation = computed(() => props.truncated || parsed.value.truncated)

const fileName = computed(() => props.filePath.split(/[/\\]/).pop() || props.filePath)

async function download() {
  await props.provider?.downloadFile?.(props.filePath, fileName.value)
}

// ---- hover 复制工具条（CSV 与 XLSX 共用，useTableCopyBar）----
const {
  copyBarVisible,
  copied,
  scheduleHideCopyBar,
  cancelHideCopyBar,
  copy,
} = useTableCopyBar(() => rows.value)
</script>

<style scoped>
.csv-table-view {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
  position: relative;
}

.csv-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  border-bottom: 1px solid var(--aw-divider-soft);
  background: var(--aw-surface);
}

.csv-file-name {
  font-size: var(--aw-text-caption);
  color: var(--aw-ink);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.csv-meta {
  font-size: var(--aw-text-fine);
  color: var(--aw-ink-muted-48);
  white-space: nowrap;
}

.csv-toolbar-spacer {
  flex: 1;
}

.tool-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  height: var(--aw-btn-height);
  padding: 0 var(--aw-btn-padding);
  background: var(--aw-surface);
  border: 1px solid var(--aw-divider-soft);
  border-radius: var(--aw-radius-xs);
  cursor: pointer;
  color: var(--aw-ink-muted-48);
  font-size: var(--aw-text-fine);
  transition: all 0.15s;
}

.tool-btn:hover {
  color: var(--aw-ink);
}

.csv-copy-bar {
  position: absolute;
  top: 44px;
  right: 16px;
  z-index: 10;
  display: flex;
  gap: 4px;
  padding: 4px;
  background: var(--aw-surface);
  border: 1px solid var(--aw-divider-soft);
  border-radius: var(--aw-radius-xs);
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.08);
  backdrop-filter: blur(8px);
}

.csv-scroll {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  position: relative;
}

.truncation-notice {
  padding: 8px 16px;
  text-align: center;
  font-size: var(--aw-text-caption);
  color: var(--aw-ink-muted-48);
  border-top: 1px solid var(--aw-divider-soft);
  background: var(--aw-canvas-parchment);
}
</style>
