<template>
  <div class="message-edit-editor-wrap">
    <EditorContent class="rich-editor" :editor="editor" />
  </div>
</template>

<script setup lang="ts">
import { onBeforeUnmount } from 'vue'
import { EditorContent, useEditor } from '@tiptap/vue-3'
import StarterKit from '@tiptap/starter-kit'
import { QuickCommandNode } from './tiptap/QuickCommandNode'
import { FileReferenceNode } from './tiptap/FileReferenceNode'
import { markedTextToEditorHtml } from '../../utils/editor-tags'

/**
 * 气泡内编辑态的最小 tiptap 编辑器（技术方案 2026-11-11-message-edit-quick-command-tags）：
 * 把 #{name}# / ${name}$ / @{path}@ 标记渲染为原子标签 chip，确认出口 getText 还原为标记文本——
 * payload 与 textarea 时代逐字节一致（userVisibleText 回填口径）。扩展清单与 ChatInput 完全一致
 * （精简 StarterKit + 两标签节点），保证渲染与序列化行为同源；不含面板 / input rule / Placeholder。
 */
const props = defineProps<{
  /** 回填文本（userVisibleText 口径的标记原文）；仅初始一次性注入，不随外部变化重建 */
  modelValue: string
}>()

const emit = defineEmits<{
  'update:modelValue': [text: string]
  confirm: []
  cancel: []
}>()

const editor = useEditor({
  editable: true,
  extensions: [
    StarterKit.configure({
      heading: false,
      codeBlock: false,
      blockquote: false,
      horizontalRule: false,
      bulletList: false,
      orderedList: false,
      listItem: false,
      code: false,
      bold: false,
      italic: false,
      strike: false,
    }),
    QuickCommandNode,
    FileReferenceNode,
  ],
  content: `<p>${markedTextToEditorHtml(props.modelValue)}</p>`,
  editorProps: {
    // Esc / Ctrl|Meta+Enter 与 IME 组合态守卫：口径照搬 textarea 时代的 MessageBubble.onEditKeydown
    handleKeyDown: (_view, event) => {
      if (event.isComposing || event.keyCode === 229) return false
      if (event.key === 'Escape') {
        emit('cancel')
        return true
      }
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
        emit('confirm')
        return true
      }
      return false
    },
  },
  onUpdate: ({ editor: ed }) => {
    // 展示态 mirror；确认出口一律以 getText 为准（§4.3：初始不回写，避免序列化空白差异覆盖用户原文）
    emit('update:modelValue', ed.getText({ blockSeparator: '\n' }))
  },
})

function focus() {
  editor.value?.commands.focus('end')
}

function selectAll() {
  editor.value?.commands.selectAll()
}

onBeforeUnmount(() => editor.value?.destroy())

defineExpose({ focus, selectAll })
</script>

<style src="./chat-input.css"></style>

<style scoped>
/* textarea 时代 MessageBubble .edit-textarea 的视觉原样迁移到 wrap 容器 */
.message-edit-editor-wrap {
  width: 100%;
  min-height: 60px;
  padding: 8px 12px;
  border: 1px solid var(--aw-primary);
  border-radius: var(--aw-radius-sm);
  background: var(--aw-surface);
  color: var(--aw-ink);
  font-size: var(--aw-text-caption);
  line-height: 1.6;
  outline: none;
  transition: border-color 0.15s;
  box-sizing: border-box;
}

.message-edit-editor-wrap:focus-within {
  border-color: var(--aw-primary-focus);
}
</style>
