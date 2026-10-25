<template>
  <div class="record-drawer-layer">
    <!-- 遮罩只挡面板内：抽屉的 sessionId 上下文严格属于轨迹面板自身 -->
    <div class="record-drawer-mask" @click="emit('close')" />
    <aside class="record-drawer" role="dialog" aria-modal="true">
      <header class="drawer-head">
        <span class="drawer-title">{{ title }}</span>
        <button type="button" class="drawer-close" title="关闭（Esc）" @click="emit('close')">×</button>
      </header>

      <div v-if="loading" class="drawer-body drawer-state">加载中…</div>
      <div v-else-if="error" class="drawer-body drawer-state drawer-error">{{ error }}</div>
      <div v-else-if="record == null" class="drawer-body drawer-state">记录不存在或已删除</div>

      <!-- 工具记录：参数 / 结果 / 计时与元信息 / 请求构成 -->
      <template v-else-if="record.kind === 'tool'">
        <nav class="drawer-tabs">
          <button
            v-for="tab in TOOL_TABS"
            :key="tab"
            type="button"
            class="drawer-tab"
            :class="{ active: activeTab === tab }"
            @click="activeTab = tab"
          >{{ tab }}</button>
        </nav>
        <div class="drawer-body">
          <template v-if="activeTab === '参数'">
            <JsonText :raw="record.data.argumentsJson" empty-text="未找到该调用的参数（声明消息可能已被编辑截断）" />
          </template>
          <template v-else-if="activeTab === '结果'">
            <JsonText :raw="record.data.resultContent" empty-text="未找到该调用的结果（工具消息可能已被截断）" />
          </template>
          <template v-else-if="activeTab === '计时与元信息'">
            <CallMetaTable v-if="record.data.call != null" :call="record.data.call" />
            <div v-else class="drawer-state">未配对到模型调用记录</div>
          </template>
          <template v-else>
            <RunTraceCallPrompt v-if="record.data.call != null" :call="record.data.call" />
            <div v-else class="drawer-state">未配对到模型调用记录</div>
          </template>
        </div>
      </template>

      <!-- 消息记录：单页（主键直查，无窗口推导）。空态 VO 的 role 为 null → 整体不存在态 -->
      <template v-else-if="record.kind === 'message'">
        <div v-if="record.data.role == null" class="drawer-body drawer-state">记录不存在或已删除</div>
        <div v-else class="drawer-body">
          <div class="message-meta">
            <span class="message-role">{{ roleLabel }}</span>
            <span v-if="record.data.edited" class="message-edited" :title="`编辑于 ${record.data.updatedAt ?? '—'}`">已编辑</span>
            <span v-if="messageSummary.attachments != null" class="message-attachments">{{ messageSummary.attachments }}</span>
            <span v-if="record.data.tokenCount != null" class="message-tokens" title="消息 token 数">{{ formatTokensLabel(record.data.tokenCount) }}</span>
          </div>
          <!-- 多模态：合并文本分片为主展示，原始分片数组收进折叠详情 -->
          <template v-if="messageSummary.multimodal">
            <pre v-if="messageSummary.text !== ''" class="message-pre">{{ messageSummary.text }}</pre>
            <div v-else class="drawer-state">该消息无文本分片</div>
            <details class="message-raw">
              <summary class="message-raw-summary">多模态原文 JSON</summary>
              <JsonText :raw="record.data.content" empty-text="无原文" />
            </details>
          </template>
          <!-- 普通文本：合法 JSON（任务负载等）给格式化切换，纯文本原样 -->
          <JsonText v-else :raw="record.data.content" empty-text="该消息无正文内容" />
        </div>
      </template>

      <!-- 轮次记录：回复 / 工具 / 计时与元信息 / 请求构成 -->
      <template v-else-if="record.data.call != null">
        <nav class="drawer-tabs">
          <button
            v-for="tab in CALL_TABS"
            :key="tab"
            type="button"
            class="drawer-tab"
            :class="{ active: activeTab === tab }"
            @click="activeTab = tab"
          >{{ tab }}</button>
        </nav>
        <div class="drawer-body">
          <template v-if="activeTab === '回复'">
            <RunTraceRecordReply v-if="record.data.messages.length > 0" :messages="record.data.messages" />
            <div v-else class="drawer-state">{{ replyEmptyText }}</div>
          </template>
          <template v-else-if="activeTab === '工具'">
            <div v-if="record.data.tools.length > 0" class="round-tools">
              <div class="round-tools-label">本轮工具（{{ record.data.tools.length }}）</div>
              <button
                v-for="tool in record.data.tools"
                :key="tool.toolCallId"
                type="button"
                class="round-tool-row"
                @click="emit('open-tool', tool.toolCallId)"
              >
                <span class="round-tool-name">{{ toolDisplayName(tool.name) }}</span>
                <span v-if="tool.target" class="round-tool-target" :title="tool.target">{{ tool.target }}</span>
              </button>
            </div>
            <div v-else class="drawer-state">本轮没有工具调用</div>
          </template>
          <template v-else-if="activeTab === '计时与元信息'">
            <CallMetaTable :call="record.data.call" />
          </template>
          <template v-else>
            <RunTraceCallPrompt :call="record.data.call" />
          </template>
        </div>
      </template>

      <!-- 轮次记录但调用行不存在（空态 VO）：不渲染 tab，给整体空态 -->
      <div v-else class="drawer-body drawer-state">未找到该轮次的模型调用记录</div>
    </aside>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { api } from '../../api'
import { useSessionStore } from '../../stores/session'
import { getToolDisplayName } from '../../utils/toolDisplay'
import { messageContentSummary } from '../../utils/trace-display'
import type { TraceDrawerTarget, TraceLoadedRecord } from '../../types/trace'
import JsonText from './RunTraceRecordJsonText.vue'
import CallMetaTable from './RunTraceCallMetaTable.vue'
import RunTraceCallPrompt from './RunTraceCallPrompt.vue'
import RunTraceRecordReply from './RunTraceRecordReply.vue'

/**
 * 记录详情抽屉（技术方案 2026-10-22-run-trace-deep-dive §5.6 与
 * 2026-10-25-run-trace-content-and-prompt §5.6）。
 *
 * 面板内 position: absolute 的自绘抽屉，不用 el-drawer——后者默认 append-to-body，
 * 会挂到全局 body 下，正是「轨迹 Tab 打开时边栏会话错配」类问题的温床。
 * 数据按需拉取并进 session store 的 traceRecords（按 sessionId + key 分桶），
 * 已缓存的记录再点直接展开，不重复请求。
 *
 * tab 结构：工具记录 = 参数 / 结果 / 计时与元信息 / 请求构成；
 * 轮次记录 = 回复（默认）/ 工具 / 计时与元信息 / 请求构成；
 * 消息记录 = 单页。轮次记录的 call 行不存在（空态 VO）时不渲染 tab。
 */

const props = defineProps<{
  sessionId: string
  target: TraceDrawerTarget
}>()

const emit = defineEmits<{
  close: []
  /** 轮次抽屉内点工具行：父组件切 key 重新拉取 */
  'open-tool': [toolCallId: string]
}>()

const TOOL_TABS = ['参数', '结果', '计时与元信息', '请求构成'] as const
const CALL_TABS = ['回复', '工具', '计时与元信息', '请求构成'] as const

const sessionStore = useSessionStore()
const activeTab = ref<string>(defaultTab())

const loading = ref(false)
const error = ref('')

function defaultTab(): string {
  return props.target.kind === 'tool' ? '参数' : '回复'
}

const recordKey = computed(() => {
  if (props.target.kind === 'tool') return `tool:${props.target.toolCallId}`
  if (props.target.kind === 'call') return `call:${props.target.llmCallId}`
  return `message:${props.target.messageId}`
})

const title = computed(() => {
  if (props.target.kind === 'tool') return '工具调用详情'
  if (props.target.kind === 'call') return `轮次详情 #${props.target.llmCallId}`
  return '消息详情'
})

const record = ref<TraceLoadedRecord | null>(null)
/** 请求序号：快速连续切换 target（缓存未命中要发请求）时，只认最后一次的结果 */
let loadSeq = 0

async function load() {
  const seq = ++loadSeq
  const key = recordKey.value
  const cached = sessionStore.getTraceRecord(props.sessionId, key)
  if (cached != null) {
    // 同步路径也要收尾 loading：watch 触发时 loading 已被置 true，
    // 缓存命中若直接从 try 前 return，会把「加载中…」永久留在抽屉里。
    if (seq === loadSeq) {
      record.value = cached
      loading.value = false
    }
    return
  }
  loading.value = true
  error.value = ''
  try {
    const url = props.target.kind === 'tool'
      ? `/sessions/${props.sessionId}/trace/records/tool/${encodeURIComponent(props.target.toolCallId)}`
      : props.target.kind === 'call'
        ? `/sessions/${props.sessionId}/trace/records/call/${props.target.llmCallId}`
        : `/sessions/${props.sessionId}/trace/records/message/${props.target.messageId}`
    const { data } = await api.get(url)
    // target 已切走：丢弃过期响应，不清 loading（新一轮 load 自己会管）
    if (seq !== loadSeq) return
    const loaded: TraceLoadedRecord = props.target.kind === 'tool'
      ? { kind: 'tool', data: data as Extract<TraceLoadedRecord, { kind: 'tool' }>['data'] }
      : props.target.kind === 'call'
        ? { kind: 'call', data: data as Extract<TraceLoadedRecord, { kind: 'call' }>['data'] }
        : { kind: 'message', data: data as Extract<TraceLoadedRecord, { kind: 'message' }>['data'] }
    sessionStore.setTraceRecord(props.sessionId, key, loaded)
    record.value = loaded
  } catch {
    if (seq !== loadSeq) return
    // 拦截器已提示；这里给出抽屉内的可读状态，不留空白面板
    error.value = '加载失败，请重试'
  } finally {
    if (seq === loadSeq) loading.value = false
  }
}

onMounted(() => {
  void load()
  // Esc 关闭：与遮罩 / × 三种方式都生效（抽屉是排障视图，不该卡住用户）
  window.addEventListener('keydown', onKeydown)
})

onUnmounted(() => {
  window.removeEventListener('keydown', onKeydown)
})

// target 切换（含跨 kind：轮次抽屉点工具行 / 主面板从 run 预览切进来）：
// 实例被复用（v-if 是 null → 非 null，onMounted 不会再跑），必须 watch 重载并
// 把 tab 重置到新 kind 的默认页，否则「轮次详情」标题配着「参数」tab 的内容。
watch(recordKey, () => {
  record.value = null
  error.value = ''
  activeTab.value = defaultTab()
  void load()
})

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    event.stopPropagation()
    emit('close')
  }
}

function toolDisplayName(name: string): string {
  return getToolDisplayName(name)
}

/* ===== 消息抽屉展示 ===== */

const messageSummary = computed(() =>
  record.value?.kind === 'message'
    ? messageContentSummary(record.value.data.content)
    : { text: '', attachments: null, multimodal: false },
)

const roleLabel = computed(() => {
  if (record.value?.kind !== 'message') return ''
  const role = record.value.data.role
  if (role === 'USER') return '用户消息'
  if (role === 'ASSISTANT') return '助手消息'
  if (role === 'TOOL') return '工具消息'
  if (role === 'SYSTEM') return '系统消息'
  return role != null && role !== '' ? role : '未知来源'
})

function formatTokensLabel(tokens: number): string {
  return `${tokens.toLocaleString('zh-CN')} tok`
}

/* ===== 轮次抽屉空态区分 ===== */

/** 回复 tab 空态：调用行缺时间戳 → 无法定位；有时间戳但没有落库回复 → 崩溃恢复 / 中断。 */
const replyEmptyText = computed(() => {
  if (record.value?.kind !== 'call') return ''
  if (record.value.data.call?.createdAt == null) return '该轮回复暂无法定位（本轮调用缺少时间戳）'
  return '该轮回复未落库（崩溃恢复 / 中断）'
})
</script>

<style scoped>
.record-drawer-layer {
  position: absolute;
  inset: 0;
  z-index: 20;
}

.record-drawer-mask {
  position: absolute;
  inset: 0;
  background: rgba(0, 0, 0, 0.18);
}

.record-drawer {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  width: 380px;
  max-width: 90%;
  display: flex;
  flex-direction: column;
  background: var(--aw-surface);
  border-left: 1px solid var(--aw-hairline);
  box-shadow: -4px 0 16px rgba(0, 0, 0, 0.12);
}

.drawer-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--aw-space-xxs);
  padding: var(--aw-space-xxs) var(--aw-space-xs);
  border-bottom: 1px solid var(--aw-divider-soft);
}

.drawer-title {
  font-size: var(--aw-text-fine);
  font-weight: 600;
  color: var(--aw-ink);
}

.drawer-close {
  border: none;
  background: transparent;
  font-size: 16px;
  line-height: 1;
  color: var(--aw-ink-muted-40);
  cursor: pointer;
  padding: 2px 6px;
  border-radius: var(--aw-radius-xs);
}

.drawer-close:hover {
  color: var(--aw-ink);
  background: var(--aw-surface-hover);
}

.drawer-tabs {
  display: flex;
  gap: 2px;
  padding: var(--aw-space-xxs) var(--aw-space-xs) 0;
  border-bottom: 1px solid var(--aw-divider-soft);
}

.drawer-tab {
  font-size: var(--aw-text-fine);
  font-family: var(--aw-font-text);
  padding: 3px 8px;
  border: none;
  border-bottom: 2px solid transparent;
  background: transparent;
  color: var(--aw-ink-muted-64);
  cursor: pointer;
}

.drawer-tab.active {
  color: var(--aw-primary);
  border-bottom-color: var(--aw-primary);
}

.drawer-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: var(--aw-space-xxs) var(--aw-space-xs);
  font-size: var(--aw-text-fine);
}

.drawer-state {
  color: var(--aw-ink-muted-40);
  padding: var(--aw-space-xs) 0;
}

.drawer-error {
  color: var(--aw-danger);
}

/* ===== 消息抽屉 ===== */
.message-meta {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  padding-bottom: var(--aw-space-xxs);
  border-bottom: 1px solid var(--aw-divider-soft);
  margin-bottom: var(--aw-space-xxs);
}

.message-role {
  font-size: var(--aw-text-micro);
  font-weight: 600;
  color: var(--aw-ink);
}

.message-edited {
  font-size: var(--aw-text-micro);
  color: var(--aw-status-waiting);
}

.message-attachments {
  font-size: var(--aw-text-micro);
  color: var(--aw-diff-info);
}

.message-tokens {
  font-size: var(--aw-text-micro);
  font-family: var(--aw-font-mono);
  color: var(--aw-ink-muted-40);
  margin-left: auto;
}

.message-pre {
  margin: 0;
  padding: var(--aw-space-xxs);
  border: 1px solid var(--aw-divider-soft);
  border-radius: var(--aw-radius-xs);
  background: var(--aw-surface-pearl);
  font-family: var(--aw-font-text);
  font-size: var(--aw-text-fine);
  line-height: 1.6;
  color: var(--aw-ink);
  white-space: pre-wrap;
  word-break: break-word;
}

.message-raw {
  margin-top: var(--aw-space-xxs);
}

.message-raw-summary {
  font-size: var(--aw-text-micro);
  color: var(--aw-ink-muted-40);
  cursor: pointer;
  user-select: none;
}

/* ===== 轮次抽屉 ===== */
.round-tools {
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.round-tools-label {
  font-size: var(--aw-text-micro);
  color: var(--aw-ink-muted-40);
  padding-bottom: 2px;
}

.round-tool-row {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 2px 4px;
  border: none;
  border-radius: var(--aw-radius-xs);
  background: transparent;
  cursor: pointer;
  text-align: left;
  font-family: var(--aw-font-text);
  font-size: var(--aw-text-fine);
  color: var(--aw-ink-muted-64);
}

.round-tool-row:hover {
  background: var(--aw-primary-hover);
  color: var(--aw-primary);
}

.round-tool-name {
  flex-shrink: 0;
}

.round-tool-target {
  flex: 1;
  min-width: 0;
  font-family: var(--aw-font-mono);
  font-size: var(--aw-text-micro);
  color: var(--aw-ink-muted-40);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* Dark mode */
[data-theme="dark"] .record-drawer {
  box-shadow: -4px 0 16px rgba(0, 0, 0, 0.4);
}

[data-theme="dark"] .record-drawer-mask {
  background: rgba(0, 0, 0, 0.4);
}
</style>
