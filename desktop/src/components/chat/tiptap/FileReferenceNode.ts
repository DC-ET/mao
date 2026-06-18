import { Node, mergeAttributes } from '@tiptap/core'

export interface FileReferenceOptions {
  HTMLAttributes: Record<string, any>
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    fileReference: {
      insertFileReference: (attrs: { filePath: string }) => ReturnType
    }
  }
}

export const FileReferenceNode = Node.create<FileReferenceOptions>({
  name: 'fileReference',
  group: 'inline',
  inline: true,
  atom: true,
  draggable: false,
  selectable: true,

  addOptions() {
    return {
      HTMLAttributes: {},
    }
  },

  addAttributes() {
    return {
      filePath: {
        default: '',
        parseHTML: (element) => element.getAttribute('data-file-path'),
        renderHTML: (attributes) => ({ 'data-file-path': attributes.filePath }),
      },
    }
  },

  parseHTML() {
    return [{ tag: 'span[data-file-reference]' }]
  },

  renderHTML({ HTMLAttributes }) {
    const filePath = (HTMLAttributes['data-file-path'] ?? HTMLAttributes.filePath) as string
    const fileName = filePath?.split('/').pop() || filePath || ''
    return [
      'span',
      mergeAttributes(
        { 'data-file-reference': '' },
        this.options.HTMLAttributes,
        HTMLAttributes,
        { class: 'editor-tag editor-tag-file' },
      ),
      fileName,
    ]
  },

  renderText({ node }) {
    const { filePath } = node.attrs as { filePath: string }
    return `@{${filePath}}@`
  },

  addCommands() {
    return {
      insertFileReference:
        (attrs) =>
        ({ commands }) => {
          return commands.insertContent({
            type: this.name,
            attrs,
          })
        },
    }
  },
})
