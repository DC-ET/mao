import { Node, mergeAttributes } from '@tiptap/core'
import { serializeFileRange, type FileRangeQuote } from '../../../utils/selection-quote'

export interface FileReferenceOptions {
  HTMLAttributes: Record<string, any>
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    fileReference: {
      insertFileReference: (attrs: { filePath: string }) => ReturnType
      insertFileRangeQuote: (attrs: FileReferenceAttrs) => ReturnType
    }
  }
}

export interface FileReferenceAttrs {
  filePath: string
  lineStart?: number | null
  lineEnd?: number | null
  snippet?: string | null
  languageId?: string | null
  capturedChangeCount?: number | null
  stale?: string | null
}

function fileReferenceName(filePath: string): string {
  if (!filePath) return ''
  const parts = filePath.split(/[/\\]/)
  return parts[parts.length - 1] || filePath
}

export function fileReferenceLabel(attrs: {
  filePath?: string | null
  lineStart?: number | null
  lineEnd?: number | null
  stale?: string | null
}): string {
  const name = fileReferenceName(attrs.filePath || '')
  if (attrs.lineStart == null) return name
  const end = attrs.lineEnd ?? attrs.lineStart
  const ranged = end === attrs.lineStart ? `${name}:${attrs.lineStart}` : `${name}:${attrs.lineStart}-${end}`
  return attrs.stale === '1' ? `${ranged} · 内容可能已变化` : ranged
}

function attrNumber(element: { getAttribute(name: string): string | null }, name: string): number | null {
  const raw = element.getAttribute(name)
  if (raw == null || raw === '') return null
  const value = Number(raw)
  return Number.isInteger(value) ? value : null
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
      lineStart: {
        default: null,
        parseHTML: (element) => attrNumber(element, 'data-line-start'),
        renderHTML: (attributes) => attributes.lineStart == null ? {} : { 'data-line-start': String(attributes.lineStart) },
      },
      lineEnd: {
        default: null,
        parseHTML: (element) => attrNumber(element, 'data-line-end'),
        renderHTML: (attributes) => attributes.lineEnd == null ? {} : { 'data-line-end': String(attributes.lineEnd) },
      },
      snippet: {
        default: null,
        parseHTML: (element) => {
          const raw = element.getAttribute('data-snippet')
          if (raw == null) return null
          try { return decodeURIComponent(raw) } catch { return raw }
        },
        renderHTML: (attributes) => attributes.snippet == null ? {} : { 'data-snippet': encodeURIComponent(attributes.snippet) },
      },
      languageId: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-language-id'),
        renderHTML: (attributes) => attributes.languageId ? { 'data-language-id': attributes.languageId } : {},
      },
      capturedChangeCount: {
        default: null,
        parseHTML: (element) => attrNumber(element, 'data-captured-change-count'),
        renderHTML: (attributes) => attributes.capturedChangeCount == null
          ? {}
          : { 'data-captured-change-count': String(attributes.capturedChangeCount) },
      },
      stale: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-stale') === '1' ? '1' : null,
        renderHTML: (attributes) => attributes.stale === '1' ? { 'data-stale': '1' } : {},
      },
    }
  },

  parseHTML() {
    return [{ tag: 'span[data-file-reference]' }]
  },

  renderHTML({ node, HTMLAttributes }) {
    const attrs = node.attrs as FileReferenceAttrs
    return [
      'span',
      mergeAttributes(
        { 'data-file-reference': '' },
        this.options.HTMLAttributes,
        HTMLAttributes,
        { class: 'editor-tag editor-tag-file' },
      ),
      fileReferenceLabel(attrs),
    ]
  },

  renderText({ node }) {
    const attrs = node.attrs as FileReferenceAttrs
    if (attrs.lineStart == null) return `@{${attrs.filePath}}@`
    const quote: FileRangeQuote = {
      filePath: attrs.filePath,
      lineStart: attrs.lineStart,
      lineEnd: attrs.lineEnd ?? attrs.lineStart,
      snippet: attrs.snippet ?? null,
      languageId: attrs.languageId || '',
    }
    return serializeFileRange(quote)
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
      insertFileRangeQuote:
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
