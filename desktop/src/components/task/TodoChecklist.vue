<template>
  <div class="todo-checklist">
    <div v-if="!todos || todos.length === 0" class="todo-empty">
      暂无任务清单
    </div>
    <template v-else>
      <div class="todo-summary">
        <span class="todo-progress-text">{{ completedCount }}/{{ todos.length }} 已完成</span>
        <div class="todo-progress-bar">
          <div class="todo-progress-fill" :style="{ width: progressPercent + '%' }"></div>
        </div>
      </div>
      <div
        ref="listEl"
        class="todo-list"
        :class="{ 'has-more-below': hasMoreBelow }"
        @scroll.passive="updateOverflowHint"
      >
        <div
          v-for="item in todos"
          :key="item.id"
          class="todo-item"
          :class="`status-${item.status}`"
        >
          <span class="todo-icon">
            <el-icon v-if="item.status === 'completed'" :size="14" class="icon-done"><Select /></el-icon>
            <span v-else-if="item.status === 'in_progress'" class="icon-active"></span>
            <span v-else class="icon-pending"></span>
          </span>
          <span class="todo-content" :title="item.content">{{ item.content }}</span>
        </div>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { Select } from '@element-plus/icons-vue'
import type { TodoItem } from '../../types/chat'
import { focusScrollDelta } from '../../utils/todoScroll'

const props = defineProps<{
  todos?: TodoItem[]
}>()

const listEl = ref<HTMLElement | null>(null)
const hasMoreBelow = ref(false)

const completedCount = computed(() =>
  props.todos?.filter(t => t.status === 'completed').length ?? 0
)

const progressPercent = computed(() =>
  props.todos?.length ? Math.round((completedCount.value / props.todos.length) * 100) : 0
)

/**
 * 焦点项：进行中优先（历史脏数据可能残留多条，取最后一条即最新推进的），
 * 否则最后一条已完成，都没有则取第一项。
 */
const focusIndex = computed(() => {
  const list = props.todos ?? []
  let focus = -1
  for (let i = 0; i < list.length; i++) {
    if (list[i].status === 'in_progress') focus = i
  }
  if (focus >= 0) return focus
  for (let i = 0; i < list.length; i++) {
    if (list[i].status === 'completed') focus = i
  }
  return focus >= 0 ? focus : 0
})

/**
 * 让焦点项落在列表可视区内。列表超出 5 项后内部滚动，不跟随的话
 * 当前推进的项会滑出视野；已在可视区内则不动，避免用户回看时被拽回来。
 */
function revealFocus() {
  const el = listEl.value
  const item = el?.querySelectorAll<HTMLElement>('.todo-item')[focusIndex.value]
  if (el && item) {
    const listRect = el.getBoundingClientRect()
    const itemRect = item.getBoundingClientRect()
    if (itemRect.top < listRect.top || itemRect.bottom > listRect.bottom) {
      el.scrollTop += focusScrollDelta({
        listTop: listRect.top,
        listHeight: el.clientHeight,
        itemTop: itemRect.top,
        itemHeight: itemRect.height,
      })
    }
  }
  updateOverflowHint()
}

/**
 * 滚动条隐藏后不再占侧栏宽度，改用底部渐隐表达「下面还有」；
 * 滚到底或内容本身不溢出时去掉渐隐。
 */
function updateOverflowHint() {
  const el = listEl.value
  hasMoreBelow.value = !!el && el.scrollHeight - el.scrollTop - el.clientHeight > 2
}

watch(focusIndex, () => nextTick(revealFocus))
watch(() => props.todos, () => nextTick(updateOverflowHint))
onMounted(() => nextTick(revealFocus))

/**
 * 「任务」页签用 v-show 隐藏时布局尺寸为 0，自动跟随无从计算；
 * 切回页签后由 TaskInspector 调用该入口重算滚动位置与底部渐隐。
 */
defineExpose({ revealFocus })
</script>

<style scoped>
.todo-checklist {
  padding: 8px 0;
}

.todo-empty {
  font-size: var(--aw-text-caption);
  color: var(--aw-ink-muted-48);
  padding: 8px 0;
}

.todo-summary {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 10px;
}

.todo-progress-text {
  font-size: var(--aw-text-micro);
  color: var(--aw-ink-muted-48);
}

.todo-progress-bar {
  height: 4px;
  background: var(--aw-surface-pearl);
  border-radius: 2px;
  overflow: hidden;
}

.todo-progress-fill {
  height: 100%;
  background: var(--aw-success);
  border-radius: 2px;
  transition: width 0.3s ease;
}

.todo-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  /* 最多约 5 项（14px 字号 × 1.47 行高 + 上下 4px 内边距）：超出后列表内部滚动，
     避免任务多时把右栏整体顶长、把边路任务/子代理挤到屏幕外 */
  max-height: 172px;
  overflow-y: auto;
  overscroll-behavior: contain;
  /* 侧栏本来就窄，滚动条不再占位：自定义 ::-webkit-scrollbar 会把 Android 的
     overlay 滚动条变成常驻占位条，直接吃掉任务名的可用宽度 */
  scrollbar-width: none;
}

.todo-list::-webkit-scrollbar {
  display: none;
}

/* 还能往下滚时底部渐隐，替代滚动条提示下方还有内容；滚到底自动消失 */
.todo-list.has-more-below {
  -webkit-mask-image: linear-gradient(to bottom, #000 calc(100% - 12px), transparent);
  mask-image: linear-gradient(to bottom, #000 calc(100% - 12px), transparent);
}

.todo-item {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  font-size: var(--aw-text-caption);
  color: var(--aw-ink-muted-80);
  letter-spacing: -0.224px;
  padding: 4px 6px;
  border-radius: 4px;
  transition: background 0.15s ease;
}

.todo-item:hover {
  background: var(--aw-surface-pearl);
}

.todo-icon {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 14px;
  margin-top: 2px;
}

.icon-done {
  color: var(--aw-success);
}

.icon-active {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: var(--aw-accent);
  animation: pulse 1.5s infinite ease-in-out;
}

.icon-pending {
  width: 14px;
  height: 14px;
  border: 1.5px solid var(--aw-hairline);
  border-radius: 50%;
  display: inline-block;
}

.todo-content {
  min-width: 0;
  flex: 1;
  /* 任务名完整展示，多行折行而不是截断；长英文标识符也不会撑破侧栏 */
  overflow-wrap: anywhere;
}

/* in_progress: bold highlight + left accent */
.status-in_progress {
  background: var(--aw-accent-bg, rgba(var(--aw-accent-rgb, 59, 130, 246), 0.08));
  border-left: 3px solid var(--aw-accent);
  padding-left: 8px;
}

.status-in_progress .todo-content {
  color: var(--aw-ink);
  font-weight: 600;
}

/* completed: strikethrough + muted */
.status-completed .todo-content {
  color: var(--aw-ink-muted-48);
  text-decoration: line-through;
  opacity: 0.6;
}

/* pending: slightly muted */
.status-pending .todo-content {
  opacity: 0.8;
}

@keyframes pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.5; transform: scale(0.85); }
}
</style>
