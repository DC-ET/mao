// hover 复制工具条共享逻辑（技术方案 §5.3 / §5.5）：CsvTableView 与
// SpreadsheetView 的表格即数据源，直接序列化 rows 走 tableCopy，无需 DOM 兜底。
import { onUnmounted, ref } from 'vue'
import { tableToCsv, rowsToMarkdown } from '../utils/tableCopy'
import { copyWithFallback } from '../utils/codeCopy'

const COPY_FEEDBACK_MS = 1500
const HIDE_DELAY_MS = 200

export function useTableCopyBar(getRows: () => string[][]) {
  const copyBarVisible = ref(false)
  const copied = ref<'csv' | 'markdown' | null>(null)
  let hideCopyBarTimer: ReturnType<typeof setTimeout> | null = null
  let copiedTimer: ReturnType<typeof setTimeout> | null = null

  function scheduleHideCopyBar() {
    cancelHideCopyBar()
    // 延迟隐藏：给鼠标从表格移入工具条的时间
    hideCopyBarTimer = setTimeout(() => {
      copyBarVisible.value = false
    }, HIDE_DELAY_MS)
  }

  function cancelHideCopyBar() {
    if (hideCopyBarTimer) {
      clearTimeout(hideCopyBarTimer)
      hideCopyBarTimer = null
    }
  }

  function copy(mode: 'csv' | 'markdown') {
    const rows = getRows()
    copyWithFallback(mode === 'csv' ? tableToCsv(rows) : rowsToMarkdown(rows))
    copied.value = mode
    if (copiedTimer) clearTimeout(copiedTimer)
    copiedTimer = setTimeout(() => {
      copied.value = null
    }, COPY_FEEDBACK_MS)
  }

  onUnmounted(() => {
    if (hideCopyBarTimer) clearTimeout(hideCopyBarTimer)
    if (copiedTimer) clearTimeout(copiedTimer)
  })

  return { copyBarVisible, copied, scheduleHideCopyBar, cancelHideCopyBar, copy }
}
