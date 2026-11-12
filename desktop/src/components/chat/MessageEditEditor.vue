<template>
  <div ref="wrapRef" class="message-edit-editor-wrap">
    <QuickCommandPanel
      ref="quickCommandPanelRef"
      :visible="commandPanelVisible"
      :skills="panelSkills"
      :commands="quickCommands.commands"
      :filter="commandPanelFilter"
      :placement="commandPanelPlacement"
      @select="handleCommandSelect"
      @close="closePanel"
    />
    <FileReferencePanel
      ref="fileReferencePanelRef"
      :visible="filePanelVisible"
      :files="workspaceFiles"
      :filter="filePanelFilter"
      :loading="filePanelLoading"
      :load-error="fileListError"
      :placement="filePanelPlacement"
      @select="handleFileReferenceSelect"
      @close="closeFilePanel"
      @retry="retryFileFetch"
    />
    <EditorContent class="rich-editor" :editor="editor" />
  </div>
</template>

<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue'
import { EditorContent, useEditor } from '@tiptap/vue-3'
import StarterKit from '@tiptap/starter-kit'
import { QuickCommandNode } from './tiptap/QuickCommandNode'
import { FileReferenceNode } from './tiptap/FileReferenceNode'
import { markedTextToEditorHtml } from '../../utils/editor-tags'
import QuickCommandPanel from './QuickCommandPanel.vue'
import FileReferencePanel from './FileReferencePanel.vue'
import { useEditorTagPanels, type EditorPanelHandle } from '../../composables/useEditorTagPanels'
import { useSessionStore } from '../../stores/session'

/**
 * 气泡内编辑态的最小 tiptap 编辑器（技术方案 2026-11-11-message-edit-quick-command-tags）：
 * 把 #{name}# / ${name}$ / @{path}@ 标记渲染为原子标签 chip，确认出口 getText 还原为标记文本——
 * payload 与 textarea 时代逐字节一致（userVisibleText 回填口径）。扩展清单与 ChatInput 完全一致
 * （精简 StarterKit + 两标签节点），保证渲染与序列化行为同源；不含 input rule / Placeholder。
 * 指令/技能/文件面板由共享 composable 提供（技术方案 2026-11-12）：`/` 与 `@` 触发，不接裸词自动补全。
 */
const props = defineProps<{
  /** 回填文本（userVisibleText 口径的标记原文）；仅初始一次性注入，不随外部变化重建 */
  modelValue: string
  /** 所属会话：文件面板按会话的执行模式/工作区取数（边路会话不在 store 时走既有失败降级） */
  sessionId?: string
}>()

const emit = defineEmits<{
  'update:modelValue': [text: string]
  confirm: []
  cancel: []
}>()

const sessionStore = useSessionStore()
const wrapRef = ref<HTMLElement | null>(null)
const quickCommandPanelRef = ref<EditorPanelHandle>()
const fileReferencePanelRef = ref<EditorPanelHandle>()

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
    handleKeyDown: (_view, event) => {
      // 面板开时 ↑↓/Enter/Esc 分层消费（共享实现）；面板关时回落下方既有守卫段
      if (panels.handleEditorKeyDown(_view, event)) return true
      // Esc / Ctrl|Meta+Enter 与 IME 组合态守卫：口径照搬 textarea 时代的 MessageBubble.onEditKeydown
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
    panels.handleEditorUpdate()
  },
})

// 面板逻辑与 ChatInput 同源（技术方案 2026-11-12 §4.5）：编辑态差异全部为入参——
// 只接 `/` 触发（`、` 是中文高频标点）、不接裸词自动补全、Esc 回落取消编辑、
// anchorEl 触发翻转测量（短会话向上弹出被 .messages 裁掉时改向下）。
const panels = useEditorTagPanels({
  editorRef: editor,
  quickCommandPanelRef,
  fileReferencePanelRef,
  getContext: () => {
    const s = props.sessionId ? sessionStore.sessionEntities.get(props.sessionId) ?? null : null
    return {
      executionMode: s?.executionMode ?? 'CLOUD',
      workspace: s?.workspace,
      sessionId: props.sessionId ?? null,
    }
  },
  slashTriggers: ['/'],
  autoComplete: false,
  onEscape: () => emit('cancel'),
  anchorEl: () => wrapRef.value,
})

const {
  quickCommands,
  panelSkills,
  commandPanelVisible,
  commandPanelFilter,
  commandPanelPlacement,
  handleCommandSelect,
  closePanel,
  filePanelVisible,
  filePanelFilter,
  filePanelLoading,
  fileListError,
  workspaceFiles,
  filePanelPlacement,
  handleFileReferenceSelect,
  closeFilePanel,
  retryFileFetch,
} = panels

function focus() {
  editor.value?.commands.focus('end')
}

function selectAll() {
  editor.value?.commands.selectAll()
}

onBeforeUnmount(() => {
  panels.closeAll()
  editor.value?.destroy()
})

defineExpose({ focus, selectAll })
</script>

<style src="./chat-input.css"></style>

<style scoped>
/* textarea 时代 MessageBubble .edit-textarea 的视觉原样迁移到 wrap 容器；
 * position: relative 供面板 absolute 锚定（技术方案 2026-11-12 §4.5） */
.message-edit-editor-wrap {
  position: relative;
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
