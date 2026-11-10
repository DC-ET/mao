/**
 * ProseMirror 段落插入（技术方案 docs/plan/2026-11-10-rich-paste-annotate-technical-design.md §4.3）。
 * 从 ChatInput.vue 文件分支（原 :624-632 内联实现）抽出的公共函数：图文混排粘贴的 text/plain
 * 手插与 HTML→Markdown 转换产物插入共用，行为与原内联实现逐字节等价——Markdown 以源文本
 * 按 \n 拆行建 paragraph 节点（输入框「纯文本 + 特殊节点」心智，不用 insertContent(html)）。
 */
import type { EditorView } from '@tiptap/pm/view'
import { Fragment, Slice } from '@tiptap/pm/model'

export function insertPlainParagraphs(view: EditorView, text: string): void {
  const { state } = view
  const paragraphs = text
    .split(/\r?\n/)
    .map(line => state.schema.nodes.paragraph.create(null, line ? state.schema.text(line) : undefined))
  const tr = state.tr.replaceSelection(new Slice(Fragment.fromArray(paragraphs), 1, 1))
  view.dispatch(tr.scrollIntoView())
}
