/**
 * 快捷命令 / 技能 / 文件引用标记 ↔ 编辑器标签节点 HTML 的转换（自 ChatInput 私有实现原样搬迁，
 * 技术方案 2026-11-11-message-edit-quick-command-tags §4.1）：主输入框队列撤回回填（restoreContent）
 * 与气泡编辑态（MessageEditEditor）共用，转换规则单一来源。
 * 标记三形态与 quick-command-parser.ts 一致：#{name}# 指令 / ${name}$ 技能 / @{path}@ 文件引用。
 */

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** 将含 @{..}@ / ${..}$ / #{..}# 标记的纯文本转换为含 Tag 节点的编辑器 HTML（与 handlePaste 的解析规则一致）。 */
export function markedTextToEditorHtml(text: string): string {
  const parts = text.split(/(@\{[^}]+\}@|\$\{[^}]+\}\$|#\{[^}]+\}#)/)
  return parts
    .map(part => {
      if (!part) return ''
      const fileMatch = part.match(/^@\{(.+)\}@$/)
      const skillMatch = part.match(/^\$\{(.+)\}\$$/)
      const commandMatch = part.match(/^#\{(.+)\}#$/)
      if (fileMatch) {
        const path = escapeHtml(fileMatch[1])
        const name = escapeHtml(fileMatch[1].split('/').pop() || fileMatch[1])
        return `<span data-file-reference data-file-path="${path}">${name}</span>`
      }
      if (skillMatch) {
        const name = escapeHtml(skillMatch[1])
        return `<span data-quick-command data-command-type="skill" data-command-name="${name}">${name}</span>`
      }
      if (commandMatch) {
        const name = escapeHtml(commandMatch[1])
        return `<span data-quick-command data-command-type="command" data-command-name="${name}">${name}</span>`
      }
      return escapeHtml(part).replace(/\n/g, '<br>')
    })
    .join('')
}
