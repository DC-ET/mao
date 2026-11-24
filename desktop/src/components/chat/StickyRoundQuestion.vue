<template>
  <!-- 长回答里本轮问题滚出视口后吸顶：定位宿主同 RoundDirectory，是 ChatPanel 的 .messages-wrap -->
  <button
    v-if="question"
    type="button"
    class="sticky-round-question"
    :title="`回到我的问题：${question.full}`"
    :aria-label="`回到我的问题：${question.full}`"
    @click="emit('locate', question.id)"
  >
    <span class="sticky-label">我的问题</span>
    <span class="sticky-text">{{ question.text }}</span>
    <el-icon class="sticky-icon" :size="12"><Top /></el-icon>
  </button>
</template>

<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, watch } from 'vue'
import { Top } from '@element-plus/icons-vue'
import type { ChatMessage } from '../../types/chat'
import { userAskExcerpt } from '../../utils/selection-quote'
import { pickStickyQuestionId, type BubbleRect } from '../../utils/stickyRoundQuestion'

const props = defineProps<{
  container: HTMLElement | undefined
  messages: ChatMessage[]
}>()

const emit = defineEmits<{
  /** 定位到用户消息：由 ChatPanel 转交 useMessageLocate.flash（与轮次目录同一路径） */
  locate: [messageId: string]
}>()

/** 吸顶条高度 + 上边距，下一条问题滚进这段区间就让位 */
const RESERVE_PX = 48

const stickyId = ref<string | null>(null)

const question = computed(() => {
  const id = stickyId.value
  if (id == null) return null
  const msg = props.messages.find(m => String(m.id) === id)
  if (!msg) return null
  const excerpt = userAskExcerpt(msg.content ?? '').trim()
  const fallback = msg.images?.length ? '（图片）' : '（无文字）'
  const text = excerpt.replace(/\s+/g, ' ') || fallback
  return { id, text, full: text.slice(0, 200) }
})

function measure() {
  const el = props.container
  if (!el) {
    stickyId.value = null
    return
  }
  const viewportTop = el.getBoundingClientRect().top
  const bubbles: BubbleRect[] = []
  el.querySelectorAll<HTMLElement>('.message-bubble.user[id^="msg-"]').forEach((node) => {
    const rect = node.getBoundingClientRect()
    bubbles.push({ id: node.id.slice(4), top: rect.top, bottom: rect.bottom })
  })
  stickyId.value = pickStickyQuestionId(bubbles, viewportTop, RESERVE_PX)
}

let rafId = 0
function schedule() {
  if (rafId) return
  rafId = requestAnimationFrame(() => {
    rafId = 0
    measure()
  })
}

watch(() => props.container, (el, oldEl) => {
  oldEl?.removeEventListener('scroll', schedule)
  el?.addEventListener('scroll', schedule, { passive: true })
  schedule()
}, { immediate: true, flush: 'post' })

// 流式追加 / 切换会话 / 展开折叠步骤都会改变气泡位置，不一定伴随 scroll 事件
watch([() => props.messages, () => props.messages.length], () => { void nextTick(schedule) })

onUnmounted(() => {
  props.container?.removeEventListener('scroll', schedule)
  if (rafId) cancelAnimationFrame(rafId)
})
</script>

<style scoped>
.sticky-round-question {
  position: absolute;
  top: 6px;
  right: 8px;
  z-index: 4;
  display: flex;
  align-items: center;
  gap: 8px;
  max-width: min(75%, 560px);
  padding: 5px 10px;
  border: 1px solid var(--aw-primary-line);
  border-radius: var(--aw-radius-sm);
  /* 底色与用户气泡同源；先垫不透明面色，避免透出下面滚动的正文 */
  background: linear-gradient(rgba(var(--aw-accent-rgb), 0.14), rgba(var(--aw-accent-rgb), 0.14)), var(--aw-surface, #fff);
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.08);
  color: var(--aw-ink);
  font: inherit;
  font-size: var(--aw-text-fine);
  line-height: 1.5;
  text-align: left;
  cursor: pointer;
  transition: box-shadow 0.15s, border-color 0.15s;
}

.sticky-round-question:hover {
  border-color: var(--aw-primary);
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.12);
}

.sticky-label {
  flex-shrink: 0;
  color: var(--aw-primary);
  font-weight: 600;
}

.sticky-text {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sticky-icon {
  flex-shrink: 0;
  color: var(--aw-ink-muted-48);
}

.sticky-round-question:hover .sticky-icon {
  color: var(--aw-primary);
}

[data-theme="dark"] .sticky-round-question {
  background: linear-gradient(rgba(var(--aw-accent-rgb), 0.2), rgba(var(--aw-accent-rgb), 0.2)), #2a2a2a;
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.4);
}

[data-theme="dark"] .sticky-label {
  color: var(--aw-primary-on-dark);
}
</style>
