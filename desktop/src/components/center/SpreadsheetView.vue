<template>
  <div class="spreadsheet-view">
    <div class="sheet-toolbar">
      <span class="sheet-file-name" :title="filePath">{{ fileName }}</span>
      <span v-if="state === 'ready'" class="sheet-meta">{{ metaLabel }}</span>
      <span class="sheet-toolbar-spacer"></span>
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

    <!-- sheet tab 切换（§5.5）：多 sheet 时才显示 -->
    <div v-if="state === 'ready' && sheets.length > 1" class="sheet-tabs">
      <button
        v-for="(sheet, i) in sheets"
        :key="sheet.name"
        class="sheet-tab"
        :class="{ active: i === activeSheet }"
        :title="sheet.name"
        @click="activeSheet = i"
      >
        {{ sheet.name }}
      </button>
    </div>

    <div v-if="state === 'loading'" class="sheet-message">
      <p>正在解析表格…</p>
    </div>

    <div v-else-if="state === 'error'" class="sheet-message error">
      <p>{{ errorMsg }}</p>
      <button v-if="provider?.downloadFile" class="retry-btn" @click="download">下载后在本地查看</button>
      <!-- LOCAL 无 downloadFile：降级态至少给个定位出口，别成死路 -->
      <button v-else-if="canShowInFinder" class="retry-btn" @click="showInFinder">在 Finder 中显示</button>
    </div>

    <div
      v-else-if="state === 'ready'"
      class="sheet-scroll"
      @mouseenter="copyBarVisible = true"
      @mouseleave="scheduleHideCopyBar"
    >
      <!-- hover 复制工具条：与 CsvTableView 共用 useTableCopyBar -->
      <div
        v-show="copyBarVisible"
        class="sheet-copy-bar"
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

      <TableGrid :rows="activeRows" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { Download, Refresh } from '@element-plus/icons-vue'
import TableGrid from './TableGrid.vue'
import { useTableCopyBar } from '../../composables/useTableCopyBar'
import { useShowInFinder } from '../../composables/useShowInFinder'
import { extractWorkbook, XLSX_MAX_BYTES, type XlsxSheet } from '../../utils/xlsx-extract'
import type { WorkspaceFileProvider } from '../../composables/workspace-file-provider'

const props = defineProps<{
  filePath: string
  bytes: Uint8Array
  provider: WorkspaceFileProvider | null
}>()

defineEmits<{
  refresh: []
}>()

const { canShowInFinder, showInFinder } = useShowInFinder(
  () => props.provider,
  () => props.filePath,
)

type LoadState = 'loading' | 'ready' | 'error'

const state = ref<LoadState>('loading')
const errorMsg = ref('')
const sheets = ref<XlsxSheet[]>([])
const activeSheet = ref(0)

const activeRows = computed(() => sheets.value[activeSheet.value]?.rows ?? [])
const colCount = computed(() => activeRows.value[0]?.length ?? 0)
const metaLabel = computed(() => {
  const sheetPart = sheets.value.length > 1 ? `${sheets.value.length} 个工作表 · ` : ''
  return `${sheetPart}${activeRows.value.length} 行 × ${colCount.value} 列`
})

const fileName = computed(() => props.filePath.split(/[/\\]/).pop() || props.filePath)

// 加载代际守卫：快速切换文件 / 连点刷新时丢弃过期响应（§6-A2）
let loadSeq = 0

async function load() {
  const seq = ++loadSeq
  state.value = 'loading'
  errorMsg.value = ''
  sheets.value = []
  activeSheet.value = 0
  // 字节上限先行：超大文件不交给 exceljs 解析（§5.5 / F7）
  if (props.bytes.byteLength > XLSX_MAX_BYTES) {
    state.value = 'error'
    errorMsg.value = '表格过大，请下载后查看'
    return
  }
  try {
    // exceljs 动态 import：库本体（浏览器 UMD 包约 1MB）不进首屏主 chunk（§6-C1）
    const { default: ExcelJS } = await import('exceljs')
    const workbook = new ExcelJS.Workbook()
    // 类型签名收 Buffer，但浏览器 / node 包内部都转交 JSZip.loadAsync（接受 Uint8Array）
    await workbook.xlsx.load(props.bytes as unknown as ArrayBuffer)
    if (seq !== loadSeq) return
    const extracted = extractWorkbook(workbook)
    if (!extracted.ok) {
      // 单 sheet 行数 / 总单元格任一超限：整体降级，不做半截渲染（§5.5）
      state.value = 'error'
      errorMsg.value = '表格过大，请下载后查看'
      return
    }
    sheets.value = extracted.sheets
    state.value = 'ready'
  } catch (e: any) {
    if (seq !== loadSeq) return
    // 畸形 / 加密 / zip64 边界文件：exceljs 解析失败即降级下载（§6-F7）
    state.value = 'error'
    errorMsg.value = e?.message || '表格解析失败'
  }
}

const { copyBarVisible, copied, scheduleHideCopyBar, cancelHideCopyBar, copy } =
  useTableCopyBar(() => activeRows.value)

async function download() {
  await props.provider?.downloadFile?.(props.filePath, fileName.value)
}

// 防御性 watch：FileViewer 的刷新路径是「bytesData 置 null → 子组件卸载 → 新 bytes
// 重挂」，同一实例上 bytes 不会变，正常情况下这里不触发；真被传新 bytes 时重走加载
watch(
  () => props.bytes,
  () => {
    void load()
  },
)

onMounted(async () => {
  await nextTick()
  await load()
})
</script>

<style scoped>
.spreadsheet-view {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
  position: relative;
}

.sheet-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  border-bottom: 1px solid var(--aw-divider-soft);
  background: var(--aw-surface);
}

.sheet-file-name {
  font-size: var(--aw-text-caption);
  color: var(--aw-ink);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sheet-meta {
  font-size: var(--aw-text-fine);
  color: var(--aw-ink-muted-48);
  white-space: nowrap;
}

.sheet-toolbar-spacer {
  flex: 1;
}

.sheet-tabs {
  display: flex;
  gap: 2px;
  padding: 4px 12px 0;
  border-bottom: 1px solid var(--aw-divider-soft);
  background: var(--aw-surface);
  overflow-x: auto;
}

.sheet-tab {
  height: var(--aw-btn-height);
  padding: 0 var(--aw-btn-padding);
  font-size: var(--aw-text-fine);
  color: var(--aw-ink-muted-48);
  background: none;
  border: 1px solid transparent;
  border-bottom: none;
  border-radius: var(--aw-radius-xs) var(--aw-radius-xs) 0 0;
  cursor: pointer;
  white-space: nowrap;
  transition: all 0.15s;
}

.sheet-tab:hover {
  color: var(--aw-ink);
}

.sheet-tab.active {
  color: var(--aw-primary);
  border-color: var(--aw-divider-soft);
  background: var(--aw-canvas-parchment);
}

.sheet-message {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  flex: 1;
  color: var(--aw-ink-muted-48);
  font-size: var(--aw-text-body);
}

.sheet-message.error {
  color: var(--aw-danger);
}

.sheet-message p {
  margin: 0 0 12px;
}

.retry-btn {
  height: var(--aw-btn-height);
  font-size: var(--aw-text-fine);
  color: var(--aw-primary);
  background: none;
  border: 1px solid var(--aw-primary);
  border-radius: var(--aw-radius-xs);
  padding: var(--aw-btn-padding);
  cursor: pointer;
}

.retry-btn:hover {
  background: var(--aw-primary-hover);
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

.sheet-scroll {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  position: relative;
}

.sheet-copy-bar {
  position: absolute;
  top: 8px;
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
</style>
