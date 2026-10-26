<template>
  <!-- 右缘浮动把手 + 轮次目录浮层。
       定位宿主是 ChatPanel 的 .messages-wrap（position:relative）：absolute 直接挂滚动容器
       .messages 内会随内容滚走，且祖先链无定位祖先时回落视口（0.0.337 类 bug）。 -->
  <div ref="rootEl" class="round-directory">
    <button
      v-if="rows.length > 0"
      type="button"
      class="round-directory-handle"
      :class="{ active: open }"
      title="轮次目录"
      aria-label="轮次目录"
      :aria-expanded="open"
      @click.stop="toggle"
    >
      <el-icon :size="14"><List /></el-icon>
    </button>
    <div v-if="open && rows.length > 0" class="round-directory-popover" @click.stop>
      <div class="round-directory-title">轮次目录</div>
      <button
        v-for="row in rows"
        :key="row.id"
        type="button"
        class="round-directory-row"
        @click="locate(row.id)"
      >
        <span class="round-index">{{ row.index }}</span>
        <span class="round-summary">{{ row.summary || '（无文字）' }}</span>
        <span class="round-meta">
          <span v-if="row.time" class="round-time">{{ row.time }}</span>
          <span v-if="row.steps" class="round-steps">{{ row.steps }}</span>
        </span>
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onUnmounted, ref, toRef, watch } from 'vue'
import { List } from '@element-plus/icons-vue'
import type { ChatMessage } from '../../types/chat'
import { toRoundDirectoryRows, useMessageRounds } from '../../composables/useMessageRounds'
import { useRelativeTime } from '../../composables/useRelativeTime'

const props = defineProps<{
  messages: ChatMessage[]
  /** 执行中为 true：执行中轮不进目录（流式期间目录高频变化且当前轮就在屏幕底部） */
  sending: boolean
}>()

const emit = defineEmits<{
  /** 定位到某轮的用户消息：由 ChatPanel 转交 useMessageLocate.flash（含 pauseFollow 与滚动） */
  locate: [messageId: string]
}>()

useRelativeTime()

// 目录即已加载窗口索引（决策 7）：自行派生一份纯 computed，不共享 ChatRoundList 的
// roundsExpanded 可变状态——展开由 ChatRoundList 的 flashId 监听完成，同源于全局搜索跳转。
const { historyRounds } = useMessageRounds(toRef(props, 'messages'), toRef(props, 'sending'))

const rows = computed(() => toRoundDirectoryRows(historyRounds.value))

const open = ref(false)
const rootEl = ref<HTMLElement | null>(null)

function toggle() {
  open.value = !open.value
}

function locate(messageId: string) {
  open.value = false
  emit('locate', messageId)
}

// 打开期间点外部收起；Esc 同样收起。监听挂 document，rootEl 外点击（含把手自身）一律关闭。
function onDocumentClick(e: MouseEvent) {
  const target = e.target as Node | null
  if (target && rootEl.value?.contains(target)) return
  open.value = false
}
function onDocumentKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape' && open.value) {
    e.stopPropagation()
    open.value = false
  }
}
watch(open, (isOpen) => {
  if (isOpen) {
    document.addEventListener('click', onDocumentClick)
    document.addEventListener('keydown', onDocumentKeydown)
  } else {
    document.removeEventListener('click', onDocumentClick)
    document.removeEventListener('keydown', onDocumentKeydown)
  }
})
onUnmounted(() => {
  document.removeEventListener('click', onDocumentClick)
  document.removeEventListener('keydown', onDocumentKeydown)
})
</script>

<style scoped>
.round-directory {
  position: absolute;
  right: 2px;
  top: 50%;
  transform: translateY(-50%);
  z-index: 5;
}

.round-directory-handle {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 44px;
  border: 1px solid var(--aw-divider-soft);
  border-right: 0;
  border-radius: var(--aw-radius-xs) 0 0 var(--aw-radius-xs);
  background: var(--aw-surface, #fff);
  color: var(--aw-ink-muted-48);
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
}

.round-directory-handle:hover,
.round-directory-handle.active {
  background: var(--aw-primary-lighter);
  color: var(--aw-primary);
}

.round-directory-popover {
  position: absolute;
  right: calc(100% + 6px);
  top: 50%;
  transform: translateY(-50%);
  width: 264px;
  max-height: min(440px, 70vh);
  overflow-y: auto;
  padding: 6px;
  border: 1px solid var(--aw-divider-soft);
  border-radius: var(--aw-radius-sm);
  background: var(--aw-surface, #fff);
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.12);
}

.round-directory-title {
  padding: 2px 6px 6px;
  font-size: var(--aw-text-micro);
  font-weight: 600;
  color: var(--aw-ink-muted-48);
  letter-spacing: 0.5px;
}

.round-directory-row {
  display: flex;
  align-items: baseline;
  gap: 6px;
  width: 100%;
  padding: 6px;
  border: 0;
  border-radius: var(--aw-radius-xs);
  background: transparent;
  cursor: pointer;
  text-align: left;
  font: inherit;
}

.round-directory-row:hover {
  background: var(--aw-canvas-parchment);
}

.round-index {
  flex-shrink: 0;
  min-width: 16px;
  font-family: var(--aw-font-mono);
  font-size: var(--aw-text-micro);
  color: var(--aw-ink-muted-48);
}

.round-summary {
  flex: 1;
  min-width: 0;
  font-size: var(--aw-text-caption);
  color: var(--aw-ink);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.round-meta {
  flex-shrink: 0;
  display: flex;
  align-items: baseline;
  gap: 6px;
  font-size: var(--aw-text-micro);
  color: var(--aw-ink-muted-48);
  white-space: nowrap;
}

[data-theme="dark"] .round-directory-handle,
[data-theme="dark"] .round-directory-popover {
  background: #2a2a2a;
  border-color: var(--aw-hairline);
}

[data-theme="dark"] .round-directory-popover {
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
}
</style>
