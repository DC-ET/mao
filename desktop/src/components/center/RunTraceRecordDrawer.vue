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

      <!-- 工具记录：参数 / 结果 / 计时与元信息 三个 tab -->
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
          <template v-else>
            <CallMetaTable v-if="record.data.call != null" :call="record.data.call" />
            <div v-else class="drawer-state">未配对到模型调用记录</div>
          </template>
        </div>
      </template>

      <!-- 轮次记录：单页，完整元信息 + token 明细 + 本轮工具清单（可跳转） -->
      <template v-else>
        <div class="drawer-body">
          <CallMetaTable v-if="record.data.call != null" :call="record.data.call" />
          <div v-else class="drawer-state">未找到该轮次的模型调用记录</div>
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
        </div>
      </template>
    </aside>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { api } from '../../api'
import { useSessionStore } from '../../stores/session'
import { getToolDisplayName } from '../../utils/toolDisplay'
import type { TraceCallRecord, TraceDrawerTarget, TraceLoadedRecord, TraceToolRecord } from '../../types/trace'
import JsonText from './RunTraceRecordJsonText.vue'
import CallMetaTable from './RunTraceCallMetaTable.vue'

/**
 * 记录详情抽屉（技术方案 2026-10-22-run-trace-deep-dive §5.6）。
 *
 * 面板内 position: absolute 的自绘抽屉，不用 el-drawer——后者默认 append-to-body，
 * 会挂到全局 body 下，正是「轨迹 Tab 打开时边栏会话错配」类问题的温床。
 * 数据按需拉取并进 session store 的 traceRecords（按 sessionId + key 分桶），
 * 已缓存的记录再点直接展开，不重复请求。
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

const TOOL_TABS = ['参数', '结果', '计时与元信息'] as const
type ToolTab = typeof TOOL_TABS[number]

const sessionStore = useSessionStore()
const activeTab = ref<ToolTab>('参数')
const loading = ref(false)
const error = ref('')

const recordKey = computed(() =>
  props.target.kind === 'tool' ? `tool:${props.target.toolCallId}` : `call:${props.target.llmCallId}`
)

const title = computed(() => {
  if (props.target.kind === 'tool') return '工具调用详情'
  return `轮次详情 #${props.target.llmCallId}`
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
      : `/sessions/${props.sessionId}/trace/records/call/${props.target.llmCallId}`
    const { data } = await api.get(url)
    // target 已切走：丢弃过期响应，不清 loading（新一轮 load 自己会管）
    if (seq !== loadSeq) return
    const loaded: TraceLoadedRecord = props.target.kind === 'tool'
      ? { kind: 'tool', data: data as TraceToolRecord }
      : { kind: 'call', data: data as TraceCallRecord }
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

// 轮次抽屉点「本轮工具」跳转到工具抽屉：父组件只改 drawerTarget，不销毁本组件
// （v-if 是 null → 非 null，实例被复用），onMounted 不会再跑。必须 watch target 重载，
// 否则标题变成「工具调用详情」而内容还是上一份轮次记录——比空白更难排查。
watch(recordKey, () => {
  record.value = null
  error.value = ''
  activeTab.value = '参数'
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

.round-tools {
  margin-top: var(--aw-space-xs);
  border-top: 1px solid var(--aw-divider-soft);
  padding-top: var(--aw-space-xxs);
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
