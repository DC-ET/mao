import { defineStore } from 'pinia'
import { ref } from 'vue'

/** 单个输入框草稿：文本 + 待发附件。按会话/新建任务/边路任务键隔离。 */
export interface DraftEntry {
  /** TipTap 编辑器 HTML（含 quickCommand / fileReference 自定义节点） */
  html: string
  /** 纯文本（用于空判断） */
  text: string
  /** 待发图片/文件及其 blob 预览 URL（previewUrl '' 表示非图片）；所有权随草稿转移 */
  files: Array<{ file: File; previewUrl: string }>
}

/** TipTap 空文档 getHTML() 的残留结构（空段落/空行），视为无内容 */
function isEmptyHtml(html: string): boolean {
  return html.replace(/<p><\/p>|<br>|<\/?p>/g, '').trim() === ''
}

function isEmptyDraft(entry: DraftEntry): boolean {
  if (entry.files.length > 0) return false
  return !entry.text.trim() && isEmptyHtml(entry.html)
}

export const useDraftStore = defineStore('draft', () => {
  const drafts = ref<Map<string, DraftEntry>>(new Map())
  /** 已被显式清除的键：卸载兜底保存时跳过，防止已删会话/任务的草稿复活 */
  const clearedKeys = new Set<string>()

  function getDraft(key: string): DraftEntry | undefined {
    return drafts.value.get(String(key))
  }

  /** 写入草稿；内容为空时改为删除条目，避免空壳堆积 */
  function setDraft(key: string, entry: DraftEntry): void {
    const k = String(key)
    drafts.value = new Map(drafts.value)
    clearedKeys.delete(k)
    if (isEmptyDraft(entry)) {
      drafts.value.delete(k)
      return
    }
    drafts.value.set(k, entry)
  }

  function hasDraft(key: string): boolean {
    return drafts.value.has(String(key))
  }

  /**
   * 显式清除（发送成功、清空输入、队列回填）。仅删除条目、不记录标记——
   * 发送成功后用户重新输入的内容需能再次保存，不能被永久拦截。
   */
  function clearDraft(key: string): void {
    const k = String(key)
    drafts.value = new Map(drafts.value)
    drafts.value.delete(k)
  }

  /**
   * 删除类清除（删除会话/边路任务、晋升边路任务）。删除条目并记录键标记，
   * 晚到的卸载兜底保存不再写回，防止已删除会话/任务的草稿复活。
   */
  function clearDraftAndMark(key: string): void {
    const k = String(key)
    drafts.value = new Map(drafts.value)
    drafts.value.delete(k)
    clearedKeys.add(k)
  }

  /** 登出时全量清空 */
  function reset(): void {
    drafts.value = new Map()
    clearedKeys.clear()
  }

  function isCleared(key: string): boolean {
    return clearedKeys.has(String(key))
  }

  return { drafts, getDraft, setDraft, hasDraft, clearDraft, clearDraftAndMark, reset, isCleared }
})
