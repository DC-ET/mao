<template>
  <div v-if="items.length > 0" ref="rootRef" class="approval-stack">
    <div class="stack-cards">
      <div
        v-for="(item, index) in items"
        :key="item.requestId"
        class="stack-card"
        :class="{ interactive: index === items.length - 1 }"
      >
        <!-- 非顶层：只显示标题行 -->
        <template v-if="index !== items.length - 1">
          <div class="card-row">
            <el-icon class="card-icon" :size="12"><WarningFilled /></el-icon>
            <span class="card-label">{{ resolveApprovalTitle(item.toolName) }}</span>
          </div>
        </template>

        <!-- 顶层：完整交互 -->
        <template v-else>
          <div class="card-row">
            <el-icon class="card-icon" :size="12"><WarningFilled /></el-icon>
            <span class="card-label">{{ resolveApprovalTitle(item.toolName) }}</span>
            <span v-if="item.deviceName" class="card-device" :title="`在 ${item.deviceName} 上执行`">
              在 {{ item.deviceName }} 上执行
            </span>
            <span v-if="items.length > 1" class="card-badge">{{ items.length }}</span>
          </div>
          <div class="command-line" :class="{ expanded: expandedSet.has(item.requestId) }">
            <code class="command-code">{{ displayText(item) }}</code>
          </div>
          <div v-if="item.dangerReason" class="danger-reason">
            {{ item.dangerReason }}
          </div>
          <div v-if="item.approvalHint" class="hint-line" :title="item.approvalHint.label">
            <span class="hint-text">记住模式</span>
            <span class="hint-value">{{ item.approvalHint.ruleValue }}</span>
          </div>
          <div class="card-actions">
            <button
              v-if="item.description.length > threshold"
              class="cmd-link"
              @click.stop="toggleExpand(item.requestId)"
            >
              {{ expandedSet.has(item.requestId) ? '收起' : '展开' }}
            </button>
            <button class="cmd-link" @click.stop="copyText(item.description)">复制</button>
            <span class="actions-spacer" />
            <button
              class="action-btn reject"
              :disabled="handledIds.has(item.requestId)"
              title="快捷键 N"
              aria-keyshortcuts="N"
              @click="confirm(item.requestId, false, false)"
            >拒绝<kbd aria-hidden="true">N</kbd></button>
            <button
              v-if="item.approvalHint"
              class="action-btn always-allow"
              :disabled="handledIds.has(item.requestId)"
              :title="item.approvalHint.label"
              @click="confirm(item.requestId, true, true)"
            >总是允许</button>
            <button
              class="action-btn approve"
              :disabled="handledIds.has(item.requestId)"
              title="快捷键 Y"
              aria-keyshortcuts="Y"
              @click="confirm(item.requestId, true, false)"
            >执行<kbd aria-hidden="true">Y</kbd></button>
          </div>
        </template>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted } from 'vue'
import { ElMessage } from 'element-plus'
import { WarningFilled } from '@element-plus/icons-vue'
import { copyText as copyToClipboard } from '../../utils/clipboard'
import { resolveApprovalTitle } from '../../utils/approvalTitle'

import type { ApprovalHint } from '@mao/contracts'

export type { ApprovalHint }

export interface ApprovalItem {
  requestId: string
  toolName: string
  description: string
  dangerReason?: string
  /** 服务端生成的「总是允许」hint；缺省 = 不可规则化（denylist 命中等），只有两按钮 */
  approvalHint?: ApprovalHint
  /** 远端卡片展示「在 xxx 上执行」；执行端本地卡没有 */
  deviceName?: string
}

const threshold = 120

const props = defineProps<{
  items: ApprovalItem[]
}>()

const rootRef = ref<HTMLElement | null>(null)

const emit = defineEmits<{
  confirm: [requestId: string, approved: boolean, alwaysAllow: boolean]
}>()

// 点击后立即标记已处理并禁用按钮：审批卡片保留到服务端响应前，防止重复提交
const handledIds = ref(new Set<string>())
const absentAfterHandle = new Set<string>()

// 发送失败会把同一张卡放回队列。单卡时组件被 v-if 卸掉，状态碰巧清空；
// 多卡时组件还在，必须在卡片离开再回来之后重新允许点击。
watch(() => props.items.map((item) => item.requestId), (ids) => {
  const present = new Set(ids)
  for (const id of handledIds.value) {
    if (!present.has(id)) absentAfterHandle.add(id)
  }
  let changed = false
  const next = new Set(handledIds.value)
  for (const id of absentAfterHandle) {
    if (present.has(id) && next.delete(id)) {
      absentAfterHandle.delete(id)
      changed = true
    }
  }
  if (changed) handledIds.value = next
})

function confirm(requestId: string, approved: boolean, alwaysAllow: boolean) {
  if (handledIds.value.has(requestId)) return
  handledIds.value = new Set([...handledIds.value, requestId])
  emit('confirm', requestId, approved, alwaysAllow)
}

// ===== 审批键盘流（批次 29 提案 4）：Y=执行 / N=拒绝，与按钮点击走同一 confirm() / handledIds =====

/** 文本输入焦点守卫：与 TopNav / TaskView 同款三行（口径由 center-tab-efficiency.test.ts 锁定） */
function isTypingTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement
    && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
}

function handleApprovalKeydown(e: KeyboardEvent) {
  if (e.isComposing || e.repeat) return
  // 修饰键组合不触发：Ctrl+Y 是本应用菜单的 redo 加速器（renderer 拦不住），且组合键无审批意图
  if (e.ctrlKey || e.metaKey || e.altKey) return
  if (!isTypingTarget(e.target)) {
    const key = e.key.toLowerCase()
    if (key === 'y' || key === 'n') {
      // KeepAlive 停活的栈不在文档中：后台 Tab 的卡片不响应（活跃 Tab 归属的结构性判定）
      const top = props.items[props.items.length - 1]
      if (!rootRef.value?.isConnected || !top || handledIds.value.has(top.requestId)) return
      // 全屏浮层打开时用户在别的交互面上：el-dialog / el-drawer（.el-overlay 统一根类）、
      // 正文图片查看器（el-image-viewer）、mermaid 全屏层（mermaid-viewer，自绘 append 到 body）
      if ((e.target as HTMLElement | null)?.closest?.('.el-overlay, .el-image-viewer__wrapper, .mermaid-viewer')) return
      e.preventDefault()
      confirm(top.requestId, key === 'y', false)
    }
  }
}

onMounted(() => document.addEventListener('keydown', handleApprovalKeydown))
onUnmounted(() => document.removeEventListener('keydown', handleApprovalKeydown))

const expandedSet = ref(new Set<string>())

function toggleExpand(requestId: string) {
  if (expandedSet.value.has(requestId)) {
    expandedSet.value.delete(requestId)
  } else {
    expandedSet.value.add(requestId)
  }
}

function displayText(item: ApprovalItem): string {
  if (item.description.length <= threshold) return item.description
  if (expandedSet.value.has(item.requestId)) return item.description
  return item.description.substring(0, threshold) + '...'
}

async function copyText(text: string) {
  const ok = await copyToClipboard(text)
  if (ok) ElMessage.success('已复制')
  else ElMessage.error('复制失败')
}
</script>

<style scoped>
.approval-stack {
  flex-shrink: 0;
  margin-bottom: 8px;
  position: relative;
}

.stack-cards {
  position: relative;
}

.stack-card {
  background: var(--aw-canvas-parchment);
  border: 1px solid var(--aw-warning);
  border-radius: var(--aw-radius-md);
  padding: 10px 12px;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.04);
  transition: transform 0.3s ease, opacity 0.3s ease;
}

/* 非顶层卡片堆叠效果 */
.stack-card:not(.interactive) {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  pointer-events: none;
}

.stack-card:nth-last-child(2):not(.interactive) {
  transform: translateY(-5px) scale(0.98);
  opacity: 0.55;
}

.stack-card:nth-last-child(3):not(.interactive) {
  transform: translateY(-10px) scale(0.96);
  opacity: 0.3;
}

.stack-card:nth-last-child(n+4):not(.interactive) {
  transform: translateY(-10px) scale(0.96);
  opacity: 0;
}

.stack-card.interactive {
  position: relative;
  z-index: 1;
}

.card-row {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 6px;
}

.card-icon {
  color: var(--aw-warning);
  flex-shrink: 0;
}

.card-label {
  font-size: var(--aw-text-fine);
  font-weight: 600;
  color: var(--aw-ink);
  flex: 1;
}

.card-device {
  flex-shrink: 0;
  max-width: 45%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11px;
  color: var(--aw-text-secondary, #8e8e93);
}

.card-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  border-radius: 9px;
  background: var(--aw-warning);
  color: #fff;
  font-size: 10px;
  font-weight: 600;
  flex-shrink: 0;
}

.command-line {
  margin-bottom: 8px;
  overflow: hidden;
}

.command-line.expanded {
  max-height: 200px;
  overflow-y: auto;
}

.command-code {
  display: block;
  font-family: var(--aw-font-mono);
  font-size: var(--aw-text-fine);
  color: var(--aw-ink);
  background: none;
  white-space: pre-wrap;
  word-break: break-all;
  line-height: 1.5;
}

.danger-reason {
  margin-bottom: 8px;
  padding: 6px 8px;
  border-radius: var(--aw-radius-xs);
  border: 1px solid color-mix(in srgb, var(--aw-danger) 35%, var(--aw-hairline));
  background: color-mix(in srgb, var(--aw-danger) 6%, var(--aw-canvas));
  color: var(--aw-danger);
  font-size: var(--aw-text-fine);
  line-height: 1.45;
  white-space: pre-wrap;
  word-break: break-word;
}

.hint-line {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 8px;
  padding: 6px 8px;
  border-radius: var(--aw-radius-xs);
  border: 1px solid color-mix(in srgb, var(--aw-success) 30%, var(--aw-hairline));
  background: color-mix(in srgb, var(--aw-success) 7%, var(--aw-canvas));
  min-width: 0;
}

.hint-value {
  font-family: var(--aw-font-mono);
  font-size: var(--aw-text-fine);
  font-weight: 600;
  color: var(--aw-ink);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  flex-shrink: 1;
}

.hint-text {
  font-size: var(--aw-text-fine);
  color: var(--aw-ink-muted);
  flex-shrink: 0;
}

.card-actions {
  display: flex;
  align-items: center;
  gap: 4px;
}

.cmd-link {
  background: none;
  border: none;
  color: var(--aw-primary);
  font-size: var(--aw-text-fine);
  cursor: pointer;
  padding: 2px 4px;
  border-radius: var(--aw-radius-xs);
}

.cmd-link:hover {
  background: var(--aw-primary-hover);
}

.actions-spacer {
  flex: 1;
}

.action-btn {
  height: var(--aw-btn-height);
  /* 上下 padding 让给键帽：24px 胶囊扣掉 --aw-btn-padding 的 5px 后内容区只剩 14px，16px 键帽放不下 */
  padding: 0 11px;
  gap: 6px;
  border-radius: var(--aw-radius-pill);
  border: 1px solid var(--aw-hairline);
  background: var(--aw-canvas);
  font-size: var(--aw-text-fine);
  font-weight: 500;
  cursor: pointer;
  transition: all 0.15s;
}

.action-btn kbd {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  box-sizing: border-box;
  min-width: 16px;
  height: 16px;
  padding: 0 3px;
  border: 1px solid color-mix(in srgb, currentColor 45%, transparent);
  border-radius: 4px;
  background: color-mix(in srgb, currentColor 8%, transparent);
  color: inherit;
  font: inherit;
  font-size: 11px;
  font-weight: 600;
  line-height: 1;
}

.action-btn:hover {
  transform: scale(1.04);
}

.action-btn:active {
  transform: scale(0.96);
}

.action-btn.reject {
  color: var(--aw-ink-muted-80);
}

.action-btn.reject:hover {
  border-color: var(--aw-danger);
  color: var(--aw-danger);
  background: color-mix(in srgb, var(--aw-danger) 6%, transparent);
}

.action-btn.approve {
  border-color: var(--aw-primary);
  color: var(--aw-primary);
  background: color-mix(in srgb, var(--aw-primary) 6%, transparent);
}

.action-btn.approve:hover {
  background: color-mix(in srgb, var(--aw-primary) 12%, transparent);
}

.action-btn.always-allow {
  border-color: var(--aw-success);
  color: var(--aw-success);
  background: color-mix(in srgb, var(--aw-success) 6%, transparent);
}

.action-btn.always-allow:hover {
  background: color-mix(in srgb, var(--aw-success) 14%, transparent);
}

/* 审批键盘流（批次 29 提案 4）：键盘聚焦可见轮廓，色走各按钮既有令牌 */
.action-btn.approve:focus-visible {
  outline: 2px solid var(--aw-primary);
  outline-offset: 1px;
}

.action-btn.reject:focus-visible {
  outline: 2px solid var(--aw-danger);
  outline-offset: 1px;
}

.action-btn.always-allow:focus-visible {
  outline: 2px solid var(--aw-success);
  outline-offset: 1px;
}
</style>
