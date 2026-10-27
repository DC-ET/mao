import type { Editor } from '@tiptap/vue-3'

/**
 * 输入框里行区间引用的「内容可能已变化」重算（技术方案 2026-10-27-selection-quote）。
 * 文件被再次修改时按修订号把 stale 标记打上 / 撤掉。这是用户不可见的内部状态同步，
 * 事务必须带 addToHistory=false——否则每个 file_change 事件都会往撤销栈推一步，
 * Ctrl+Z 会先撤销这个刷新而不是用户刚打的字。
 *
 * @param editor 输入框的 tiptap 编辑器
 * @param revisionOf 文件路径 → 当前修订号（调用方按会话工作区解析）
 */
export function refreshFileQuoteStaleFlags(
  editor: Editor,
  revisionOf: (filePath: string) => number,
): void {
  if (editor.isDestroyed) return
  let tr = editor.state.tr
  let changed = false
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name !== 'fileReference' || node.attrs.lineStart == null) return
    const current = revisionOf(node.attrs.filePath as string)
    const captured = Number(node.attrs.capturedChangeCount ?? 0)
    const stale = current > captured ? '1' : null
    if ((node.attrs.stale ?? null) !== stale) {
      tr = tr.setNodeMarkup(pos, undefined, { ...node.attrs, stale })
      changed = true
    }
  })
  if (changed) editor.view.dispatch(tr.setMeta('addToHistory', false))
}
