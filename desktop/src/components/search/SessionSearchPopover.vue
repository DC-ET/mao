<template>
  <div class="theme-toggle search-toggle" role="button" aria-label="搜索会话" @click="openSearch">
    <el-icon :size="16"><Search /></el-icon>
  </div>
  <el-dialog
      v-model="isOpen"
      class="session-search-dialog"
      width="min(760px, calc(100vw - 32px))"
      align-center
      append-to-body
      modal-class="session-search-overlay"
      :show-close="false"
      :lock-scroll="true"
      @opened="onOpened"
      @closed="onClosed"
    >
      <template #header>
        <div class="search-header">
          <div>
            <h2>搜索会话</h2>
            <p>搜索你在主会话和边路任务中发送过的消息</p>
          </div>
          <button class="search-close" type="button" aria-label="关闭搜索" @click="isOpen = false">
            <el-icon :size="18"><Close /></el-icon>
          </button>
        </div>
      </template>
      <div class="search-panel">
        <el-input
          ref="inputRef"
          v-model="keyword"
          class="search-input"
          size="large"
          placeholder="输入关键词搜索会话消息…"
          clearable
          :maxlength="100"
          @input="onKeywordInput"
          @keydown="onPanelKeydown"
        >
          <template #prefix><el-icon :size="18"><Search /></el-icon></template>
        </el-input>
        <template v-if="status !== 'idle' && status !== 'loading'">
          <div class="search-summary">
            <span>{{ status === 'results' ? `找到 ${results.length} 个相关会话` : '搜索结果' }}</span>
            <span class="search-shortcuts"><kbd>↑</kbd><kbd>↓</kbd> 选择 <kbd>Enter</kbd> 打开 <kbd>Esc</kbd> 关闭</span>
          </div>
          <div class="search-body">
          <div v-if="status === 'error'" class="search-tip">搜索失败，请重试</div>
          <div v-else-if="status === 'empty'" class="search-tip">未找到相关会话</div>
          <ul v-else class="search-results">
            <li
              v-for="(item, idx) in results"
              :key="item.id"
              class="search-result-item"
              :class="{ active: idx === activeIndex }"
              @mouseenter="activeIndex = idx"
              @click="handleJump(item)"
            >
              <div class="result-line1">
                <span class="result-title">{{ item.title || '未命名会话' }}</span>
                <el-tag v-if="item.sessionType === 'SIDE_TASK'" size="small" type="warning" class="result-tag">边路</el-tag>
                <span class="result-time">{{ formatRelativeTime(item.updatedAt) }}</span>
              </div>
              <div v-if="item.snippet" class="result-snippet">
                <template v-for="(part, i) in highlightParts(item.snippet, keyword)" :key="i">
                  <mark v-if="part.hit" class="snippet-hit">{{ part.text }}</mark>
                  <span v-else>{{ part.text }}</span>
                </template>
              </div>
            </li>
          </ul>
          </div>
        </template>
      </div>
    </el-dialog>
</template>

<script setup lang="ts">
import { ref, nextTick, onUnmounted } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { Close, Search } from '@element-plus/icons-vue'
import { searchSessions } from '../../api'
import type { SessionSearchItem } from '../../types/chat'
import { useSessionStore, type TaskPhase } from '../../stores/session'
import { openSideTaskTabFor } from '../../composables/useCenterTabs'

const sessionStore = useSessionStore()
const router = useRouter()
const route = useRoute()

const inputRef = ref()
const keyword = ref('')
const results = ref<SessionSearchItem[]>([])
const activeIndex = ref(0)
type SearchStatus = 'idle' | 'loading' | 'empty' | 'error' | 'results'
const status = ref<SearchStatus>('idle')
const isOpen = ref(false)

let requestSeq = 0
let abortController: AbortController | null = null
let debounceTimer: number | null = null

/** 使所有在途请求与防抖定时器失效（关闭、清空、卸载时调用）。 */
function invalidatePending() {
  requestSeq++
  abortController?.abort()
  abortController = null
  if (debounceTimer != null) {
    clearTimeout(debounceTimer)
    debounceTimer = null
  }
}

function openSearch() {
  isOpen.value = true
}

function onOpened() {
  nextTick(() => inputRef.value?.focus())
}

function onClosed() {
  // 关闭后清空，保证下次打开从空态开始；在途请求返回也不会重新显示结果
  invalidatePending()
  keyword.value = ''
  results.value = []
  activeIndex.value = 0
  status.value = 'idle'
}

function onKeywordInput() {
  if (debounceTimer != null) clearTimeout(debounceTimer)
  const kw = keyword.value.trim()
  if (!kw) {
    invalidatePending()
    results.value = []
    activeIndex.value = 0
    status.value = 'idle'
    return
  }
  // 使旧关键词的在途请求立即失效（不影响防抖 timer）：否则旧响应会在本次防抖窗口内
  // 落地并把 status 覆盖回 'results'，绕过 Enter 守卫跳到与当前输入无关的旧会话
  requestSeq++
  abortController?.abort()
  abortController = null
  // 防抖窗口期内先清空旧结果并置 loading：旧关键词的结果不再可被 Enter/键盘导航选中
  results.value = []
  activeIndex.value = 0
  status.value = 'loading'
  debounceTimer = window.setTimeout(() => { runSearch(kw) }, 300)
}

async function runSearch(kw: string) {
  const seq = ++requestSeq
  abortController?.abort()
  const controller = new AbortController()
  abortController = controller
  // 清空旧结果与选中索引：避免在途/加载期间 Enter 或键盘导航落到上一次搜索的旧结果
  results.value = []
  activeIndex.value = 0
  status.value = 'loading'
  try {
    const items = await searchSessions(kw, { signal: controller.signal })
    if (seq !== requestSeq) return
    results.value = items
    activeIndex.value = 0
    status.value = items.length > 0 ? 'results' : 'empty'
  } catch (e) {
    if (seq !== requestSeq) return
    if (controller.signal.aborted) return
    status.value = 'error'
  }
}

function onPanelKeydown(e: KeyboardEvent) {
  const len = results.value.length
  if (e.key === 'ArrowDown') {
    if (len > 0) {
      e.preventDefault()
      activeIndex.value = (activeIndex.value + 1) % len
    }
  } else if (e.key === 'ArrowUp') {
    if (len > 0) {
      e.preventDefault()
      activeIndex.value = (activeIndex.value - 1 + len) % len
    }
  } else if (e.key === 'Enter') {
    // 仅结果态可跳转：加载中/防抖窗口期/空态下 Enter 不落旧结果
    if (status.value !== 'results') return
    const item = results.value[activeIndex.value]
    if (item) {
      e.preventDefault()
      void handleJump(item)
    }
  } else if (e.key === 'Escape') {
    isOpen.value = false
  }
}

async function handleJump(item: SessionSearchItem) {
  isOpen.value = false
  if (item.sessionType === 'SIDE_TASK') {
    const parentId = String(item.parentSessionId ?? '')
    if (!parentId) return
    // 边路任务状态用搜索结果真实值，不硬编码 IDLE；不传 createdAt（搜索结果只有 updatedAt，不得冒充创建时间）
    sessionStore.addSideTask(parentId, {
      id: item.id,
      title: item.title || '任务',
      phase: (item.phase || 'IDLE') as TaskPhase,
    })
    const target = `/tasks/${parentId}`
    if (route.path === target) {
      openSideTaskTabFor(parentId, item.id, item.title || '任务')
    } else {
      await router.push(target)
      // 路由加载（loadSession）是否完成不影响：Tab Map 是模块级单例，按显式 parentSessionId 写入
      openSideTaskTabFor(parentId, item.id, item.title || '任务')
    }
  } else {
    await router.push(`/tasks/${item.id}`)
  }
}

function formatRelativeTime(value?: string | null): string {
  if (!value) return ''
  const t = new Date(value).getTime()
  if (Number.isNaN(t)) return ''
  const diff = Date.now() - t
  if (diff < 60_000) return '刚刚'
  const minutes = Math.floor(diff / 60_000)
  if (minutes < 60) return `${minutes}分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}小时前`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}天前`
  const months = Math.floor(days / 30)
  if (months < 12) return `${months}个月前`
  return `${Math.floor(months / 12)}年前`
}

/** 大小写不敏感区间高亮：生成「普通段 / 命中段」数组，模板以插值 + <mark> 渲染，不使用 v-html。 */
function highlightParts(text: string, kw: string): Array<{ text: string; hit: boolean }> {
  const trimmed = kw.trim()
  if (!trimmed || !text) return [{ text: text || '', hit: false }]
  const lowerText = text.toLowerCase()
  const lowerKw = trimmed.toLowerCase()
  const parts: Array<{ text: string; hit: boolean }> = []
  let pos = 0
  for (;;) {
    const idx = lowerText.indexOf(lowerKw, pos)
    if (idx === -1) {
      if (pos < text.length) parts.push({ text: text.slice(pos), hit: false })
      break
    }
    if (idx > pos) parts.push({ text: text.slice(pos, idx), hit: false })
    parts.push({ text: text.slice(idx, idx + trimmed.length), hit: true })
    pos = idx + trimmed.length
    if (pos >= text.length) break
  }
  return parts
}

function toggle() {
  isOpen.value = !isOpen.value
}

onUnmounted(() => { invalidatePending() })

defineExpose({ toggle, open: openSearch })
</script>

<style scoped>
.search-toggle {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: var(--aw-radius-xs);
  cursor: pointer;
  color: var(--aw-nav-text-muted);
  transition: color 0.15s, background 0.15s;
}

.search-toggle:hover {
  color: var(--aw-nav-text);
  background: rgba(0, 0, 0, 0.06);
}

[data-theme="dark"] .search-toggle:hover {
  background: rgba(255, 255, 255, 0.08);
}
</style>

<style>
/* ElDialog 内容 teleport 到 body，需用非 scoped 样式 */
.session-search-overlay.el-overlay {
  display: flex;
  align-items: center;
  justify-content: center;
}

.session-search-overlay .el-overlay-dialog {
  position: static;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  padding: 24px 16px;
  overflow: auto;
}

.session-search-dialog.el-dialog {
  max-height: min(720px, calc(100vh - 48px));
  margin: 0;
  padding: 0;
  overflow: hidden;
  border-radius: 16px;
  box-shadow: 0 24px 80px rgba(0, 0, 0, 0.22);
}

.session-search-dialog .el-dialog__header {
  margin: 0;
  padding: 22px 24px 16px;
}

.session-search-dialog .el-dialog__body {
  padding: 0 24px 24px;
}

.session-search-dialog .search-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 24px;
}

.session-search-dialog .search-header h2 {
  margin: 0;
  color: var(--aw-ink);
  font-size: 20px;
  line-height: 1.4;
}

.session-search-dialog .search-header p {
  margin: 4px 0 0;
  color: var(--aw-ink-muted-48);
  font-size: 13px;
}

.session-search-dialog .search-close {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  padding: 0;
  border: 0;
  border-radius: 8px;
  color: var(--aw-ink-muted-48);
  background: transparent;
  cursor: pointer;
}

.session-search-dialog .search-close:hover {
  color: var(--aw-ink);
  background: var(--aw-surface-hover);
}

.session-search-dialog .search-panel {
  min-width: 0;
}

.session-search-dialog .search-input {
  width: 100%;
}

.session-search-dialog .search-summary {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  min-height: 38px;
  color: var(--aw-ink-muted-48);
  font-size: 12px;
}

.session-search-dialog .search-shortcuts {
  display: flex;
  align-items: center;
  gap: 5px;
}

.session-search-dialog kbd {
  min-width: 20px;
  padding: 1px 5px;
  border: 1px solid var(--aw-border);
  border-radius: 5px;
  color: var(--aw-ink-muted-80);
  background: var(--aw-surface-hover);
  font: inherit;
  text-align: center;
}

.session-search-dialog .search-body {
  max-height: min(440px, calc(100vh - 260px));
  overflow-y: auto;
  border: 1px solid var(--aw-border);
  border-radius: 12px;
}

.session-search-dialog .search-tip {
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--aw-ink-muted-48);
  font-size: 13px;
  text-align: center;
  padding: 24px;
}

.session-search-dialog .search-results {
  list-style: none;
  margin: 0;
  padding: 8px;
}

.session-search-dialog .search-result-item {
  padding: 13px 14px;
  border-radius: 9px;
  cursor: pointer;
}

.session-search-dialog .search-result-item.active,
.session-search-dialog .search-result-item:hover {
  background: var(--aw-surface-hover);
}

.session-search-dialog .result-line1 {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.session-search-dialog .result-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--aw-ink);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  flex: 1;
  min-width: 0;
}

.session-search-dialog .result-tag {
  flex-shrink: 0;
}

.session-search-dialog .result-time {
  flex-shrink: 0;
  font-size: 12px;
  color: var(--aw-ink-muted-48);
}

.session-search-dialog .result-snippet {
  margin-top: 6px;
  font-size: 13px;
  line-height: 1.55;
  color: var(--aw-ink-muted-80);
  word-break: break-all;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.session-search-dialog .snippet-hit {
  background: rgba(255, 193, 7, 0.35);
  color: var(--aw-ink);
  border-radius: 2px;
  padding: 0 1px;
}
</style>
