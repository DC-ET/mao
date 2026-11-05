<template>
  <div class="tool-call-card" :class="[`status-${toolCall.status}`]">
    <div class="tool-header" @click="toggleExpand">
      <div class="tool-info">
        <span class="tool-summary">{{ displaySummary }}</span>
      </div>
      <div class="tool-status">
        <button
          v-if="isDelegate && childSessionId && !hideProcess"
          class="view-subagent-btn"
          title="查看子代理过程"
          @click.stop="openSubagentProcess"
        >
          查看过程
        </button>
        <el-tooltip v-if="approvalBadge" :content="approvalBadge.reason" placement="top">
          <span class="approval-badge" :class="approvalBadge.kind">{{ approvalBadge.label }}</span>
        </el-tooltip>
        <el-tooltip v-if="toolCall.resultTruncated" content="后端已截断工具输出（超出工具自身的输出上限），此处展示的是截断后的内容" placement="top">
          <span class="truncated-badge">输出已截断</span>
        </el-tooltip>
        <span v-if="toolCall.status === 'running'" class="status-spinner"></span>
        <el-icon v-else-if="toolCall.status === 'success'" class="status-icon success"><Select /></el-icon>
        <el-icon v-else-if="toolCall.status === 'error'" class="status-icon error"><CloseBold /></el-icon>
        <el-icon
          v-if="hasExpandableBody"
          class="expand-icon"
          :class="{ expanded: isExpanded }"
        ><ArrowDown /></el-icon>
      </div>
    </div>
    <div v-if="isExpanded && hasExpandableBody" class="tool-body">
      <div v-if="formattedInput" class="tool-result">
        <template v-if="richView">
          <!-- 富视图骨架（edit_file / shell / read_file）：默认只渲染自然形态，原始输入/输出
                JSON 收起在同一个开关后，避免转义噪音盖住命令、输出与文件内容本身 -->
          <ToolCallDiffView v-if="editDiffView" :blocks="editDiffView.blocks" />
          <template v-else-if="shellView">
            <ToolShellView
              :command="shellView.primary"
              :label="shellView.primaryLabel"
              :output="shellView.output"
              :error="shellView.error"
            />
          </template>
          <template v-else-if="fileView">
            <div v-if="fileView.content" class="code-block-wrapper">
              <div class="result-label">内容</div>
              <ToolFileContent :content="fileView.content" :start-line="fileView.startLine" />
            </div>
          </template>
          <div class="diff-footer-row">
            <span v-if="richBadge" class="exit-badge" :class="richBadge.ok ? 'ok' : 'fail'">
              {{ richBadge.text }}
            </span>
            <span v-if="richSummary" class="edit-summary" :title="richTitle">{{ richSummary }}</span>
            <button class="expand-result-btn" @click="showRawIo = !showRawIo">
              {{ showRawIo ? '收起原始输入输出' : '查看原始输入输出' }}
            </button>
          </div>
          <template v-if="showRawIo">
            <div class="result-label">输入</div>
            <div class="code-block-wrapper">
              <pre class="result-content"><code>{{ formattedInput }}</code></pre>
              <button class="copy-btn" title="复制" @click="copyText(formattedInput)">
                <el-icon :size="14"><CopyDocument /></el-icon>
              </button>
            </div>
            <div class="result-label">输出</div>
            <div v-if="displayResultText" class="code-block-wrapper">
              <pre class="result-content"><code>{{ displayResultText }}</code></pre>
              <button class="copy-btn" title="复制完整输出" @click="copyText(fullResultText)">
                <el-icon :size="14"><CopyDocument /></el-icon>
              </button>
            </div>
            <div v-if="isResultTruncated" class="result-expand-row">
              <button class="expand-result-btn" @click="showFullResult = !showFullResult">
                {{ showFullResult ? '收起完整输出' : '展开完整输出' }}
              </button>
            </div>
          </template>
        </template>
        <template v-else>
          <div class="result-label">输入</div>
          <div class="code-block-wrapper">
            <pre class="result-content"><code>{{ formattedInput }}</code></pre>
            <button class="copy-btn" title="复制" @click="copyText(formattedInput)">
              <el-icon :size="14"><CopyDocument /></el-icon>
            </button>
          </div>
        </template>
      </div>
      <div v-if="(toolCall.result || imagePreviewUrl) && !richView" class="tool-result">
        <div class="result-label">输出</div>
        <el-image
          v-if="imagePreviewUrl"
          :src="imagePreviewUrl"
          :preview-src-list="[imagePreviewUrl]"
          :initial-index="0"
          fit="contain"
          class="image-preview"
          :preview-teleported="true"
          @click.stop
        />
        <div v-if="displayResultText" class="code-block-wrapper">
          <pre class="result-content"><code>{{ displayResultText }}</code></pre>
          <button class="copy-btn" title="复制完整输出" @click="copyText(fullResultText)">
            <el-icon :size="14"><CopyDocument /></el-icon>
          </button>
        </div>
        <div v-if="isResultTruncated" class="result-expand-row">
          <button class="expand-result-btn" @click="showFullResult = !showFullResult">
            {{ showFullResult ? '收起完整输出' : '展开完整输出' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, inject } from 'vue'
import { ElMessage } from 'element-plus'
import { Select, CloseBold, ArrowDown, CopyDocument } from '@element-plus/icons-vue'
import type { ToolCall } from '../../composables/useChat'
import { useSessionStore } from '../../stores/session'
import { copyText as copyToClipboard } from '../../utils/clipboard'
import { getToolDisplayName, getToolInputPreview } from '../../utils/toolDisplay'
import { buildEditDiff } from '../../utils/toolDiff'
import ToolCallDiffView from './ToolCallDiffView.vue'
import ToolFileContent from './ToolFileContent.vue'
import ToolShellView from './ToolShellView.vue'

/** 工具结果 JSON 的安全解析：非 JSON / 非对象返回 null，富视图据此回退原始展示。 */
function parseResultNode(result?: string): Record<string, unknown> | null {
  if (!result) return null
  try {
    const node = JSON.parse(result) as unknown
    return node && typeof node === 'object' && !Array.isArray(node) ? node as Record<string, unknown> : null
  } catch {
    return null
  }
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/**
 * edit_file 结果摘要：成功时一行「替换 N 处 · +a -d」（行数取后端 file_change 口径，
 * 缺失时回退 diff 片段自算）；失败时直显 error 文案；执行中/解析失败返回空串。
 */
function readEditSummary(result: string | undefined, diff: { added: number; deleted: number }): string {
  const node = parseResultNode(result)
  if (!node) return ''
  if (node.success === true) {
    const fc = (node.file_change ?? {}) as Record<string, unknown>
    const added = Number(fc.lines_added ?? diff.added)
    const deleted = Number(fc.lines_deleted ?? diff.deleted)
    const parts: string[] = []
    const replacements = Number(node.replacements)
    if (Number.isFinite(replacements) && replacements > 0) parts.push(`替换 ${replacements} 处`)
    parts.push(`+${added} -${deleted}`)
    return parts.join(' · ')
  }
  return textOf(node.error)
}

const props = withDefaults(defineProps<{
  toolCall: ToolCall
  hideProcess?: boolean
}>(), {
  hideProcess: false
})

const sessionStore = useSessionStore()
const openSubagent = inject<(payload: { childSessionId: number; title?: string }) => void>('openSubagent', () => {})

const isExpanded = ref(props.toolCall.isExpanded ?? false)

watch(
  () => props.toolCall.isExpanded,
  val => {
    if (val !== undefined) isExpanded.value = val
  }
)

const isDelegate = computed(() => ['delegate', 'delegate_followup', 'spawn_subagent', 'subagent_followup'].includes(props.toolCall.name))

/** 审批放行徽标：替我审批的 LLM 拍板 / Jev 前置决策低风险放行 / 规则静默放行（V135） */
const approvalBadge = computed(() => {
  const mark = props.toolCall.approvalMark
  if (!mark) return null
  if (mark.mode === 'jev') return { kind: 'jev', label: '低风险放行', reason: mark.reason }
  if (mark.mode === 'rule') return { kind: 'rule', label: '规则放行', reason: mark.reason }
  return mark.approved
    ? { kind: 'approved', label: 'AI 已批准', reason: mark.reason }
    : { kind: 'denied', label: 'AI 已拒绝', reason: mark.reason }
})

const childSessionId = computed(() => {
  const result = props.toolCall.result
  if (result) {
    try {
      const obj = JSON.parse(result)
      const id = obj?.child_session_id ?? obj?.childSessionId
      if (id != null && Number(id) > 0) return Number(id)
    } catch {
      // ignore
    }
  }
  // 并行 delegate：优先按 tool_call_id 绑定
  const byToolCall = sessionStore.findSubagentByToolCallId(props.toolCall.id)
  if (byToolCall) return byToolCall

  const parentId = sessionStore.activeSessionId
  if (!parentId) return null
  const agentType = typeof props.toolCall.input?.agent_type === 'string'
    ? props.toolCall.input.agent_type
    : undefined
  const task = typeof props.toolCall.input?.task === 'string'
    ? props.toolCall.input.task
    : undefined
  // 仅在能唯一匹配时返回，避免多个 RUNNING 时绑错
  return sessionStore.findSubagentChildId(parentId, {
    runningOnly: props.toolCall.status === 'running' || props.toolCall.status === 'pending',
    agentType,
    task,
  })
})

function openSubagentProcess() {
  const id = childSessionId.value
  if (!id) {
    ElMessage.info('子代理会话尚未就绪')
    return
  }
  const title = typeof props.toolCall.input?.task === 'string'
    ? `子代理: ${String(props.toolCall.input.task).slice(0, 40)}`
    : '子代理'
  openSubagent({ childSessionId: id, title })
}

const displaySummary = computed(() => {
  if (props.toolCall.summary) return props.toolCall.summary
  const displayName = getToolDisplayName(props.toolCall.name)
  if (props.toolCall.argsStreaming && !inputPreview.value) {
    const raw = props.toolCall.argumentsText || ''
    if (raw) return `${displayName} · ${raw.slice(-80)}`
    return `${displayName} · 参数加载中...`
  }
  const preview = inputPreview.value
  return preview ? `${displayName} · ${preview}` : displayName
})

const inputPreview = computed(() => getToolInputPreview(props.toolCall.name, props.toolCall.input))

const formattedInput = computed(() => {
  const input = props.toolCall.input
  if (!input) return ''
  try {
    return JSON.stringify(input, null, 2)
  } catch {
    return ''
  }
})

/**
 * edit_file 的替换片段 diff：入参自带完整 old/new_string，无需等 file_change 事件，
 * 实时流式与历史回放同源（后端落库前只剥 file_change_diff，不动入参）。
 * 无变化或参数缺失时返回 null，卡片回退原始 JSON 展示。
 */
const editDiffView = computed(() => {
  if (props.toolCall.name !== 'edit_file') return null
  const input = props.toolCall.input
  if (!input) return null
  const oldStr = typeof input.old_string === 'string' ? input.old_string : ''
  const newStr = typeof input.new_string === 'string' ? input.new_string : ''
  if (oldStr === '' && newStr === '') return null
  const diff = buildEditDiff(oldStr, newStr)
  if (diff.blocks.length === 0) return null
  return { ...diff, summary: readEditSummary(props.toolCall.result, diff) }
})

/**
 * shell 富视图：命令（exec）/ stdin（write_stdin）+ 终端输出原文，渲染为终端会话块。
 * 多动作工具：close/list 等无命令也无输出的动作拿不到可渲染内容，返回 null 走原始 JSON。
 */
const shellView = computed(() => {
  if (props.toolCall.name !== 'shell') return null
  const input = props.toolCall.input
  if (!input) return null
  const action = typeof input.action === 'string' ? input.action : 'exec'
  const node = parseResultNode(props.toolCall.result)
  const primary = action === 'exec'
    ? textOf(input.command)
    : action === 'write_stdin' ? textOf(input.input) : ''
  const output = textOf(node?.output)
  const error = textOf(node?.error)
  // 命令尚未返回结果时也值得展示（执行中）；两者皆无才回退
  if (!primary && !output && !error) return null
  const exitRaw = node?.exit_code
  const exitCode = typeof exitRaw === 'number' && Number.isFinite(exitRaw) ? exitRaw : null
  const summaryParts: string[] = []
  if (!error) {
    if (node?.truncated === true) summaryParts.push('输出已截断')
    const workdir = textOf(node?.current_workdir)
    if (workdir) summaryParts.push(workdir.length > 40 ? `…${workdir.slice(-39)}` : workdir)
    const message = textOf(node?.message)
    if (message) summaryParts.push(message)
  }
  return {
    primary,
    primaryLabel: action === 'write_stdin' ? 'stdin' : '命令',
    output,
    error,
    /** 完整工作目录：底栏摘要里只显示截断末段，全路径走 title 悬浮查看 */
    workdir: textOf(node?.current_workdir),
    badge: exitCode == null ? null : { text: `exit ${exitCode}`, ok: exitCode === 0 },
    summary: summaryParts.join(' · '),
  }
})

/**
 * read_file 富视图：文件内容 + 行号槽（起始行号取 offset），底栏给总行数与读取范围。
 * 图片读取（media_type=image）保持图片预览 + 原始输出，不进此分支。
 */
const fileView = computed(() => {
  if (props.toolCall.name !== 'read_file') return null
  if (imagePreviewUrl.value) return null
  const input = props.toolCall.input
  if (!input) return null
  const node = parseResultNode(props.toolCall.result)
  if (!node) return null
  const error = textOf(node.error)
  const content = textOf(node.content)
  if (!error && !content) return null
  const totalLines = typeof node.total_lines === 'number' && node.total_lines > 0 ? node.total_lines : null
  const offset = typeof input.offset === 'number' && input.offset > 0 ? input.offset : 0
  const contentLines = content === '' ? 0 : content.split('\n').length
  const summaryParts: string[] = []
  if (error) summaryParts.push(error)
  else {
    if (totalLines != null) summaryParts.push(`共 ${totalLines} 行`)
    if (contentLines > 0) summaryParts.push(`第 ${offset + 1}–${offset + contentLines} 行`)
  }
  return {
    content: error ? '' : content,
    startLine: offset + 1,
    summary: summaryParts.join(' · '),
  }
})

const richView = computed(() => editDiffView.value ?? shellView.value ?? fileView.value)
const richSummary = computed(() =>
  editDiffView.value?.summary ?? shellView.value?.summary ?? fileView.value?.summary ?? '')
const richBadge = computed(() => shellView.value?.badge ?? null)
/** 底栏摘要的悬浮全量文案：目前只有 shell 的完整工作目录需要（摘要里显示的是截断末段） */
const richTitle = computed(() => shellView.value?.workdir ?? '')

const showRawIo = ref(false)

const hasExpandableBody = computed(
  () => !!(formattedInput.value || props.toolCall.result || imagePreviewUrl.value)
)

const imagePreviewUrl = computed(() => {
  if (props.toolCall.preview?.data_uri) {
    return props.toolCall.preview.data_uri
  }
  const r = props.toolCall.result || ''
  try {
    const obj = JSON.parse(r)
    if (obj?.media_type === 'image' && obj?.data_uri) {
      return obj.data_uri as string
    }
  } catch {
    // not json
  }
  return ''
})

/** 未截断的完整输出文本（图片结果展示 content 字段，其余展示原文）。 */
const fullResultText = computed(() => {
  if (imagePreviewUrl.value) {
    const r = props.toolCall.result || ''
    try {
      const obj = JSON.parse(r)
      if (obj?.content) return String(obj.content)
    } catch {
      // fall through
    }
  }
  return props.toolCall.result || ''
})

const isResultTruncated = computed(() => fullResultText.value.length > 4000)

const showFullResult = ref(false)

const displayResultText = computed(() => {
  const full = fullResultText.value
  if (isResultTruncated.value && !showFullResult.value) {
    return full.slice(0, 4000) + '\n…（输出已截断）'
  }
  return full
})

async function copyText(text: string) {
  const ok = await copyToClipboard(text)
  if (ok) ElMessage.success('已复制')
  else ElMessage.error('复制失败')
}

function toggleExpand() {
  if (!hasExpandableBody.value) return
  isExpanded.value = !isExpanded.value
}
</script>

<style scoped>
.tool-call-card {
  padding: 0px 5px;
  overflow: hidden;
  background: var(--aw-canvas);
  transition: border-color 0.2s;
}

.tool-call-card.status-running {
  border-color: var(--aw-primary);
}

.tool-call-card.status-error {
  border-color: var(--aw-danger);
}

.tool-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 2px 0px;
  cursor: pointer;
  user-select: none;
  transition: background 0.15s;
}

.tool-info {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-right: 5px;
  min-width: 0;
  flex: 1;
}

.tool-summary {
  font-size: 12px;
  color: var(--aw-ink-muted-48);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  letter-spacing: -0.12px;
}

.tool-status {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}

.view-subagent-btn {
  height: var(--aw-btn-height);
  border: 1px solid var(--aw-hairline);
  background: transparent;
  color: var(--aw-primary);
  font-size: var(--aw-text-fine);
  padding: var(--aw-btn-padding);
  border-radius: var(--aw-radius-sm);
  cursor: pointer;
  line-height: 1.4;
}

.view-subagent-btn:hover {
  background: var(--aw-canvas-parchment);
}

.status-spinner {
  width: 14px;
  height: 14px;
  border: 2px solid var(--aw-hairline);
  border-top-color: var(--aw-primary);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.status-icon.success { color: var(--aw-success); }
.status-icon.error { color: var(--aw-danger); }

.approval-badge {
  font-size: 11px;
  line-height: 1;
  padding: 3px 6px;
  border-radius: var(--aw-radius-xs);
  cursor: default;
  white-space: nowrap;
}

.approval-badge.approved,
.approval-badge.jev,
.approval-badge.rule {
  color: var(--aw-success);
  background: color-mix(in srgb, var(--aw-success) 12%, transparent);
}

.approval-badge.denied {
  color: var(--aw-danger);
  background: color-mix(in srgb, var(--aw-danger) 12%, transparent);
}

.truncated-badge {
  font-size: 11px;
  line-height: 1;
  padding: 3px 6px;
  border-radius: var(--aw-radius-xs);
  cursor: default;
  white-space: nowrap;
  color: var(--aw-warning, #b45309);
  background: color-mix(in srgb, var(--aw-warning, #b45309) 12%, transparent);
}

.expand-icon {
  color: var(--aw-ink-muted-48);
  transition: transform 0.2s;
  font-size: 12px;
  transform: rotate(-90deg);
}

.expand-icon.expanded {
  transform: rotate(0deg);
}

.tool-body {
  border-top: 1px solid var(--aw-divider-soft);
  padding: 10px 14px;
}

.code-block-wrapper {
  position: relative;
  margin-bottom: 8px;
}

.code-block-wrapper:last-child {
  margin-bottom: 0;
}

.copy-btn {
  width: var(--aw-btn-height);
  height: var(--aw-btn-height);
  padding: 0;
  position: absolute;
  top: 6px;
  right: 6px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: var(--aw-radius-sm);
  background: var(--aw-surface-glass);
  color: var(--aw-ink-muted-48);
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.15s, color 0.15s;
}

.code-block-wrapper:hover .copy-btn {
  opacity: 1;
}

.copy-btn:hover {
  color: var(--aw-ink);
}

.tool-command code {
  font-family: var(--aw-font-mono);
  font-size: var(--aw-text-caption);
  color: var(--aw-text-code);
  background: none;
  padding: 0;
}

.result-label {
  font-size: var(--aw-text-fine);
  color: var(--aw-ink-muted-48);
  margin-bottom: 4px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.result-expand-row {
  margin-top: 2px;
}

/* edit_file diff 视图底栏：左为结果摘要/失败原因，右为原始输入输出开关 */
.diff-footer-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  margin-top: 2px;
}

.exit-badge {
  flex-shrink: 0;
  font-family: var(--aw-font-mono);
  font-size: var(--aw-text-fine);
  line-height: 1;
  padding: 3px 6px;
  border-radius: var(--aw-radius-xs);
  cursor: default;
  white-space: nowrap;
}

.exit-badge.ok {
  color: var(--aw-success);
  background: color-mix(in srgb, var(--aw-success) 12%, transparent);
}

.exit-badge.fail {
  color: var(--aw-danger);
  background: color-mix(in srgb, var(--aw-danger) 12%, transparent);
}

.edit-summary {
  font-family: var(--aw-font-mono);
  font-size: var(--aw-text-fine);
  color: var(--aw-ink-muted-48);
  white-space: pre-wrap;
  word-break: break-all;
}

.expand-result-btn {
  border: none;
  background: none;
  padding: 0;
  font-size: var(--aw-text-fine);
  color: var(--aw-primary);
  cursor: pointer;
}

.expand-result-btn:hover {
  text-decoration: underline;
}

.result-content {
  margin: 0;
  padding: 8px 12px;
  background: var(--aw-surface-code);
  border-radius: var(--aw-radius-sm);
  overflow-x: auto;
  max-height: 200px;
  overflow-y: auto;
}

.result-content code {
  font-family: var(--aw-font-mono);
  font-size: var(--aw-text-caption);
  color: var(--aw-text-code);
  background: none;
  padding: 0;
  white-space: pre;
}

.image-preview {
  display: block;
  max-width: 120px;
  max-height: 90px;
  border-radius: var(--aw-radius-sm);
  margin-bottom: 8px;
  border: 1px solid var(--aw-divider-soft);
  cursor: zoom-in;
}

.image-preview :deep(img) {
  max-width: 120px;
  max-height: 90px;
  object-fit: contain;
}
</style>
