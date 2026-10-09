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
            <p>搜索你在主会话和边路任务里说过的话，以及 Agent 的回复</p>
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
          placeholder="输入关键词，多个词用空格分开"
          clearable
          :maxlength="100"
          @input="onKeywordInput"
          @keydown="onPanelKeydown"
        >
          <template #prefix><el-icon :size="18"><Search /></el-icon></template>
        </el-input>
        <div class="search-filters">
          <el-select v-model="agentId" class="search-filter" clearable placeholder="全部 Agent" @change="onFilterChange">
            <el-option v-for="agent in agents" :key="agent.id" :label="agent.name || '未命名'" :value="agent.id" />
          </el-select>
          <el-date-picker
            v-model="dateRange"
            class="search-filter search-filter-date"
            type="daterange"
            value-format="YYYY-MM-DD"
            range-separator="至"
            start-placeholder="开始日期"
            end-placeholder="结束日期"
            @change="onFilterChange"
          />
          <div class="search-type" role="tablist">
            <button type="button" :class="{ on: sessionType === '' }" @click="setSessionType('')">全部</button>
            <button type="button" :class="{ on: sessionType === 'NORMAL' }" @click="setSessionType('NORMAL')">主会话</button>
            <button type="button" :class="{ on: sessionType === 'SIDE_TASK' }" @click="setSessionType('SIDE_TASK')">边路</button>
          </div>
        </div>
        <p class="search-hint">+必须 -排除，引号表示短语。过短的词按原文模糊匹配。</p>
        <template v-if="status !== 'idle'">
          <div class="search-summary">
            <span>{{ status === 'loading' ? '搜索中…' : status === 'results' ? `找到 ${total} 个相关会话` : '搜索结果' }}</span>
            <span class="search-shortcuts"><kbd>↑</kbd><kbd>↓</kbd> 选择 <kbd>Enter</kbd> 打开 <kbd>Esc</kbd> 关闭</span>
          </div>
          <div class="search-body">
          <div v-if="status === 'loading'" class="search-tip">搜索中…</div>
          <div v-else-if="status === 'error'" class="search-tip">搜索失败，请重试</div>
          <div v-else-if="status === 'empty'" class="search-tip">未找到相关会话</div>
          <ul v-else ref="resultsRef" class="search-results">
            <li v-for="group in results" :key="group.sessionId" class="search-group">
              <button type="button" class="search-group-head" @click="toggleGroup(group.sessionId)">
                <span class="result-title">{{ group.title || '未命名会话' }}</span>
                <el-tag v-if="group.status === 'ARCHIVED'" size="small" type="info" class="result-tag">已归档</el-tag>
                <el-tag v-if="group.sessionType === 'SIDE_TASK'" size="small" type="warning" class="result-tag">边路</el-tag>
                <span v-if="group.agentName" class="result-agent">{{ group.agentName }}</span>
                <span class="result-time">{{ formatRelativeTime(group.updatedAt) }}</span>
                <span class="result-count">{{ group.hitCount }} 条命中</span>
              </button>
              <button
                v-for="row in visibleHits(group)"
                :key="row.hit.messageId"
                type="button"
                class="search-result-item"
                :class="{ active: row.flatIndex === activeIndex }"
                @mouseenter="activeIndex = row.flatIndex"
                @click="handleJump(group, row.hit)"
              >
                <div class="result-snippet">
                  <template v-for="(part, i) in highlightParts(row.hit.snippet, keyword)" :key="i">
                    <mark v-if="part.hit" class="snippet-hit">{{ part.text }}</mark>
                    <span v-else>{{ part.text }}</span>
                  </template>
                </div>
              </button>
              <button
                v-if="group.hits.length > 2"
                type="button"
                class="search-expand"
                @click="toggleGroup(group.sessionId)"
              >
                {{ expanded.has(group.sessionId) ? '收起' : '展开' }}
              </button>
            </li>
            <li v-if="results.length < total" class="search-more">
              <button type="button" @click="loadMore">加载更多</button>
            </li>
          </ul>
          </div>
        </template>
      </div>
    </el-dialog>
</template>

<script setup lang="ts">
import { ref, computed, nextTick, onUnmounted, watch } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { Close, Search } from '@element-plus/icons-vue'
import { api, searchSessions } from '../../api'
import type { MessageSearchGroup, MessageSearchHit } from '../../types/chat'
import { useSessionStore, type TaskPhase } from '../../stores/session'
import { openSideTaskTabFor } from '../../composables/useCenterTabs'
import { highlightParts } from './search-highlight'

const sessionStore = useSessionStore()
const router = useRouter()
const route = useRoute()

const inputRef = ref()
const resultsRef = ref<HTMLUListElement>()
const keyword = ref('')
const results = ref<MessageSearchGroup[]>([])
const total = ref(0)
const page = ref(1)
const activeIndex = ref(0)
const agentId = ref<number | null>(null)
const dateRange = ref<[string, string] | null>(null)
const sessionType = ref<'' | 'NORMAL' | 'SIDE_TASK'>('')
const agents = ref<Array<{ id: number; name: string | null }>>([])
const expanded = ref(new Set<number>())
type SearchStatus = 'idle' | 'loading' | 'empty' | 'error' | 'results'
const status = ref<SearchStatus>('idle')
const isOpen = ref(false)

let requestSeq = 0
let abortController: AbortController | null = null
let debounceTimer: number | null = null

interface VisibleHit {
  hit: MessageSearchHit
  flatIndex: number
}

const flatHits = computed(() => {
  const rows: Array<{ group: MessageSearchGroup; hit: MessageSearchHit }> = []
  for (const group of results.value) {
    const hits = expanded.value.has(group.sessionId) ? group.hits : group.hits.slice(0, 2)
    for (const hit of hits) rows.push({ group, hit })
  }
  return rows
})

function visibleHits(group: MessageSearchGroup): VisibleHit[] {
  return flatHits.value
    .map((row, index) => ({ ...row, flatIndex: index }))
    .filter((row) => row.group.sessionId === group.sessionId)
    .map((row) => ({ hit: row.hit, flatIndex: row.flatIndex }))
}

function toggleGroup(sessionId: number) {
  const next = new Set(expanded.value)
  if (next.has(sessionId)) next.delete(sessionId)
  else next.add(sessionId)
  expanded.value = next
}

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

async function loadAgents() {
  if (agents.value.length > 0) return
  try {
    const { data } = await api.get('/agents')
    agents.value = ((data || []) as Array<{ id: number; name: string | null; enabled?: number | boolean | null }>)
      .filter((agent) => agent.enabled !== false && agent.enabled !== 0)
  } catch {
    agents.value = []
  }
}

function onOpened() {
  nextTick(() => inputRef.value?.focus())
  void loadAgents()
}

function onClosed() {
  invalidatePending()
  keyword.value = ''
  results.value = []
  total.value = 0
  page.value = 1
  activeIndex.value = 0
  expanded.value = new Set()
  status.value = 'idle'
}

function onKeywordInput() {
  page.value = 1
  scheduleSearch(false)
}

function onFilterChange() {
  page.value = 1
  scheduleSearch(false)
}

function setSessionType(value: '' | 'NORMAL' | 'SIDE_TASK') {
  sessionType.value = value
  onFilterChange()
}

function scheduleSearch(append: boolean) {
  if (debounceTimer != null) clearTimeout(debounceTimer)
  const kw = keyword.value.trim()
  if (!kw) {
    invalidatePending()
    results.value = []
    total.value = 0
    activeIndex.value = 0
    status.value = 'idle'
    return
  }
  requestSeq++
  abortController?.abort()
  abortController = null
  if (!append) {
    results.value = []
    activeIndex.value = 0
    status.value = 'loading'
  }
  debounceTimer = window.setTimeout(() => { void runSearch(kw, append) }, 300)
}

function loadMore() {
  page.value += 1
  void runSearch(keyword.value.trim(), true)
}

async function runSearch(kw: string, append: boolean) {
  const seq = ++requestSeq
  abortController?.abort()
  const controller = new AbortController()
  abortController = controller
  if (!append) {
    results.value = []
    activeIndex.value = 0
    status.value = 'loading'
  }
  try {
    const result = await searchSessions(kw, {
      signal: controller.signal,
      agentId: agentId.value,
      dateFrom: dateRange.value?.[0] ?? null,
      dateTo: dateRange.value?.[1] ?? null,
      sessionType: sessionType.value || null,
      page: page.value,
      size: 20,
    })
    if (seq !== requestSeq) return
    results.value = append ? results.value.concat(result.items ?? []) : (result.items ?? [])
    total.value = result.total ?? results.value.length
    if (!append) activeIndex.value = 0
    status.value = results.value.length > 0 ? 'results' : 'empty'
  } catch {
    if (seq !== requestSeq) return
    if (controller.signal.aborted) return
    status.value = 'error'
  }
}

function onPanelKeydown(e: KeyboardEvent) {
  const len = flatHits.value.length
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
    if (status.value !== 'results') return
    const row = flatHits.value[activeIndex.value]
    if (row) {
      e.preventDefault()
      void handleJump(row.group, row.hit)
    }
  } else if (e.key === 'Escape') {
    isOpen.value = false
  }
}

watch(activeIndex, async () => {
  await nextTick()
  const active = resultsRef.value?.querySelector<HTMLElement>('.search-result-item.active')
  active?.scrollIntoView({ block: 'nearest' })
})

async function handleJump(group: MessageSearchGroup, hit: MessageSearchHit) {
  isOpen.value = false
  const locateQuery = {
    locateMessageId: String(hit.messageId),
    locateSessionId: String(group.sessionId),
  }
  if (group.sessionType === 'SIDE_TASK') {
    const rootId = String(group.rootSessionId ?? group.parentSessionId ?? '')
    if (!rootId) return
    sessionStore.addSideTask(rootId, {
      id: group.sessionId,
      title: group.title || '任务',
      phase: (group.phase || 'IDLE') as TaskPhase,
    })
    const target = `/tasks/${rootId}`
    if (route.path === target) {
      openSideTaskTabFor(rootId, group.sessionId, group.title || '任务')
      await router.replace({ path: target, query: { ...route.query, ...locateQuery } })
    } else {
      await router.push({ path: target, query: locateQuery })
      openSideTaskTabFor(rootId, group.sessionId, group.title || '任务')
    }
  } else {
    await router.push({ path: `/tasks/${group.sessionId}`, query: locateQuery })
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
  position: relative;
}

@media (pointer: coarse) {
  .search-toggle::before {
    content: '';
    position: absolute;
    inset: 50% auto auto 50%;
    width: 44px;
    height: 44px;
    transform: translate(-50%, -50%);
  }
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

.session-search-dialog .search-hint {
  margin: 6px 0 0;
  color: var(--aw-ink-muted-48);
  font-size: 12px;
}

.session-search-dialog .search-filters {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 10px;
}

.session-search-dialog .search-filter {
  width: 160px;
}

.session-search-dialog .search-filter-date {
  width: 240px;
}

.session-search-dialog .search-type {
  display: inline-flex;
  border: 1px solid var(--aw-border);
  border-radius: 8px;
  overflow: hidden;
}

.session-search-dialog .search-type button {
  border: 0;
  background: transparent;
  padding: 6px 10px;
  cursor: pointer;
  color: var(--aw-ink-muted-80);
  font: inherit;
  font-size: 12px;
}

.session-search-dialog .search-type button.on {
  background: var(--aw-surface-hover);
  color: var(--aw-ink);
}

.session-search-dialog .search-group-head,
.session-search-dialog .search-expand,
.session-search-dialog .search-more button,
.session-search-dialog .search-result-item {
  width: 100%;
  text-align: left;
  border: 0;
  background: transparent;
  font: inherit;
}

.session-search-dialog .search-group-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 14px 0;
  cursor: pointer;
}

.session-search-dialog .result-agent,
.session-search-dialog .result-count {
  flex-shrink: 0;
  font-size: 12px;
  color: var(--aw-ink-muted-48);
}

.session-search-dialog .search-expand,
.session-search-dialog .search-more {
  padding: 0 14px 8px;
}

.session-search-dialog .search-expand,
.session-search-dialog .search-more button {
  color: var(--aw-accent, #409eff);
  cursor: pointer;
  font-size: 12px;
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
