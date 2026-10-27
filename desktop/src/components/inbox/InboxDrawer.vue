<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import type { InboxItem, InboxKind } from '@mao/contracts'
import { useInboxStore } from '../../stores/inbox'
import { useSessionStore } from '../../stores/session'
import { formatRelativeTime, useRelativeTime } from '../../composables/useRelativeTime'
import { primeInboxSystemNotify } from '../../composables/useInboxSystemNotify'
import DigestDetailDialog from './DigestDetailDialog.vue'

const props = defineProps<{ modelValue: boolean }>()
const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>()

useRelativeTime()

const inboxStore = useInboxStore()
const sessionStore = useSessionStore()
const router = useRouter()

const visible = computed({
  get: () => props.modelValue,
  set: (value: boolean) => emit('update:modelValue', value)
})

/** kind → 图标 + 展示名。封闭集合，未知 kind 不入列（后端已白名单）。 */
const KIND_META: Record<InboxKind, { label: string; icon: string }> = {
  TASK_COMPLETED: { label: '任务完成', icon: '✓' },
  TASK_FAILED: { label: '任务失败', icon: '✕' },
  QUESTION_PENDING: { label: '待回答提问', icon: '?' },
  APPROVAL_PENDING: { label: '待处理审批', icon: '!' },
  SUBAGENT_DONE: { label: '子代理完成', icon: '⌘' },
  TRIGGER_DISABLED: { label: '触发器停用', icon: '⚡' },
  SCHEDULED_TASK_PAUSED: { label: '任务已暂停', icon: '⏸' },
  BUDGET_WARN: { label: '预算提醒', icon: '¥' },
  TOKEN_DISABLED: { label: 'Token 停用', icon: '⛔' },
  OPEN_API_CALL_FAILED: { label: '开放调用失败', icon: '!' },
  WATCHER_DISABLED: { label: '哨兵已停用', icon: '🛰' },
  WEIXIN_REPLY_WINDOW_CLOSED: { label: '微信回复未送达', icon: '⏱' },
  DAILY_DIGEST: { label: '每日摘要', icon: '📅' }
}

function kindMeta(kind: InboxKind) {
  return KIND_META[kind] ?? { label: '通知', icon: '•' }
}

/** 子代理终态文案：失败/取消不得被表述成完成。 */
function subagentLabel(item: InboxItem): string | null {
  if (item.kind !== 'SUBAGENT_DONE') return null
  const status = typeof item.payload?.status === 'string' ? item.payload.status : ''
  if (status === 'FAILED') return '执行失败'
  if (status === 'CANCELLED') return '已取消'
  if (status === 'COMPLETED') return '已完成'
  return null
}

/** 来源徽标（来源透传机制：payload.source）：定时任务 / Webhook / API / 信号哨兵。 */
const SOURCE_BADGES: Record<string, string> = {
  SCHEDULED: '定时任务',
  WEBHOOK: 'Webhook',
  API: 'API',
  SIGNAL: '信号哨兵'
}

function sourceBadge(item: InboxItem): string | null {
  const source = item.payload?.source
  return typeof source === 'string' ? SOURCE_BADGES[source] ?? null : null
}

watch(visible, async (open) => {
  if (!open) return
  // 每次打开强制重拉权威未读数 + 第一页：即使 inbox_updated 已在 CRITICAL_EVENT_TYPES，
  // 开抽屉仍是兜底（弱网 / 多端并发 / 帧丢失都不影响展示）。
  await inboxStore.fetchList()
})

// 偏好是系统通知的过滤依据（仅 Electron 消费），随组件挂载加载：顶栏不再挂铃铛，
// 这份兜底加载由抽屉承担，避免 store 里的 preference 停留在初值、
// 与设置页保存的结果脱节（关掉的类型会被误弹成系统通知）。
onMounted(() => {
  void inboxStore.fetchInboxPreference()
  if (props.modelValue) void inboxStore.fetchList()
})

// 打开抽屉即把当前列表播种为已知基线：用户主动浏览期间新来的条目只进徽标、
// 不弹系统通知（正在看，属预期取舍）；抽屉关闭后新条目恢复弹窗。
watch(
  () => inboxStore.items,
  (items) => primeInboxSystemNotify(items),
  { deep: true }
)

async function handleItemClick(item: InboxItem) {
  if (!item.isRead) await inboxStore.markRead(item.id)
  // 每日摘要是汇总型条目（无关联会话）：点开详情对话框，不走 session_id 跳转
  if (item.kind === 'DAILY_DIGEST') {
    digestItem.value = item
    return
  }
  // 预算提醒无关联会话（sessionId 恒 null，inbox.service.ts:295）：跳用量抽屉「预算」Tab，
  // 取代原来落到「该通知没有关联会话」的死端（决策 10）。
  if (item.kind === 'BUDGET_WARN') {
    visible.value = false
    // 用量抽屉挂在顶栏 UsageBell 上（本地态），跨组件打开走 window 事件
    window.dispatchEvent(new CustomEvent('open_usage_drawer', { detail: { tab: 'budget' } }))
    return
  }
  if (item.sessionId == null) {
    ElMessage.warning('该通知没有关联会话')
    return
  }
  await openSession(item.sessionId)
}

/** 打开关联会话：会话被删（软删除）时降级提示并保留条目，不白屏。 */
async function openSession(sessionId: number) {
  visible.value = false
  const session = await sessionStore.fetchSession(String(sessionId))
  if (!session) {
    ElMessage.warning('关联会话已不存在，可能已被删除')
    return
  }
  sessionStore.setActiveSession(String(sessionId))
  await router.push(`/tasks/${sessionId}`)
}

/** 摘要详情对话框：行内跳转统一先关抽屉再动作。 */
const digestItem = ref<InboxItem | null>(null)
const digestDialogVisible = computed({
  get: () => digestItem.value != null,
  set: (value: boolean) => {
    if (!value) digestItem.value = null
  }
})

function handleDigestJumpSession(sessionId: number) {
  void openSession(sessionId)
}

function handleDigestJumpRoute(path: string) {
  visible.value = false
  void router.push(path)
}

function handleDigestOpenUsage() {
  visible.value = false
  // 用量抽屉挂在顶栏 UsageBell 上（本地态），跨组件打开走 window 事件
  window.dispatchEvent(new CustomEvent('open_usage_drawer'))
}
</script>

<template>
  <!--
    必须 teleport 到 body：同 UsageDrawer，抽屉由顶栏头像菜单的「站内收件箱」渲染，
    就地渲染会被 .top-nav 的 overflow 裁掉；拖拽区吞点击由全局 style.css 的
    .el-overlay/.el-popper no-drag 规则解决（420px 宽的抽屉左侧尤甚）。
  -->
  <el-drawer
    v-model="visible"
    title="站内收件箱"
    class="inbox-drawer"
    size="min(420px, calc(100vw - 32px))"
    append-to-body
    :with-header="true"
  >
    <div class="inbox-toolbar">
      <el-checkbox
        :model-value="inboxStore.unreadOnly"
        @change="(v: boolean) => inboxStore.setUnreadOnly(v)"
      >
        只看未读
      </el-checkbox>
      <el-button
        text
        type="primary"
        size="small"
        :disabled="inboxStore.unreadCount === 0"
        @click="inboxStore.markAllRead()"
      >
        全部已读
      </el-button>
    </div>

    <div v-if="inboxStore.loadingList" class="inbox-state">加载中...</div>
    <div v-else-if="inboxStore.visibleItems.length === 0" class="inbox-state">暂无通知</div>

    <template v-else>
      <ul class="inbox-list">
        <li
          v-for="item in inboxStore.visibleItems"
          :key="item.id"
          class="inbox-item"
          :class="{ 'is-unread': !item.isRead }"
          role="button"
          tabindex="0"
          @click="handleItemClick(item)"
          @keydown.enter.prevent="handleItemClick(item)"
        >
          <span class="inbox-kind" :class="`kind-${item.kind.toLowerCase()}`">
            {{ kindMeta(item.kind).icon }}
          </span>
          <div class="inbox-body">
            <div class="inbox-title">
              <span class="inbox-title-text">{{ item.title }}</span>
              <span v-if="!item.isRead" class="inbox-dot" aria-label="未读" />
              <span v-if="sourceBadge(item)" class="inbox-badge">{{ sourceBadge(item) }}</span>
              <span v-if="subagentLabel(item)" class="inbox-badge">{{ subagentLabel(item) }}</span>
            </div>
            <p v-if="item.content" class="inbox-content">{{ item.content }}</p>
            <div class="inbox-meta">
              <span>{{ kindMeta(item.kind).label }}</span>
              <span v-if="item.createdAt">{{ formatRelativeTime(item.createdAt) }}</span>
            </div>
          </div>
        </li>
      </ul>
      <div class="inbox-footer">
        <el-button
          v-if="inboxStore.hasMore"
          text
          type="primary"
          size="small"
          :loading="inboxStore.loadingMore"
          @click="inboxStore.loadMore()"
        >
          加载更多
        </el-button>
        <span v-else class="inbox-end">没有更多了</span>
      </div>
    </template>

    <!-- 摘要详情：drawer 之上再叠一层 dialog（两者都 append-to-body，层级由 element-plus 保证） -->
    <DigestDetailDialog
      v-model="digestDialogVisible"
      :item="digestItem"
      @jump-session="handleDigestJumpSession"
      @jump-route="handleDigestJumpRoute"
      @open-usage="handleDigestOpenUsage"
    />
  </el-drawer>
</template>

<style scoped>
.inbox-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--aw-divider-soft);
}

.inbox-state {
  padding: 48px 0;
  text-align: center;
  color: var(--aw-ink-muted-48);
  font-size: 13px;
}

.inbox-list {
  margin: 0;
  padding: 0;
  list-style: none;
}

.inbox-item {
  display: flex;
  gap: 10px;
  padding: 12px 4px;
  border-bottom: 1px solid var(--aw-divider-soft);
  cursor: pointer;
}

.inbox-item:hover {
  background: var(--aw-hover-bg);
}

.inbox-kind {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border-radius: 50%;
  font-size: 12px;
  font-weight: 600;
  background: var(--aw-hover-bg);
  color: var(--aw-ink-muted);
}

.kind-task_completed {
  background: rgba(103, 194, 58, 0.14);
  color: #529b2e;
}

.kind-task_failed {
  background: rgba(245, 108, 108, 0.14);
  color: #d64545;
}

.kind-question_pending {
  background: rgba(230, 162, 60, 0.16);
  color: #b9791a;
}

.kind-approval_pending {
  background: rgba(64, 158, 255, 0.14);
  color: #337ecc;
}

.kind-subagent_done {
  background: rgba(144, 147, 153, 0.16);
  color: var(--aw-ink-muted);
}

.kind-daily_digest {
  background: rgba(103, 194, 58, 0.14);
  color: #529b2e;
}

/* 暗色主题：文字换 Element Plus 暗色色板的亮色口径（与 QuickCommandTag 的暗色适配同款），
   亮色定义的深色文字压在暗底上对比度不足 */
:root[data-theme="dark"] .kind-task_completed,
:root[data-theme="dark"] .kind-daily_digest {
  background: rgba(103, 194, 58, 0.16);
  color: #95d475;
}

:root[data-theme="dark"] .kind-task_failed {
  background: rgba(245, 108, 108, 0.16);
  color: #f89898;
}

:root[data-theme="dark"] .kind-question_pending {
  background: rgba(230, 162, 60, 0.18);
  color: #eebe77;
}

:root[data-theme="dark"] .kind-approval_pending {
  background: rgba(64, 158, 255, 0.18);
  color: #79bbff;
}

.inbox-body {
  flex: 1 1 auto;
  min-width: 0;
}

.inbox-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  font-weight: 500;
  color: var(--aw-ink);
}

.inbox-title-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.inbox-dot {
  flex: 0 0 auto;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #f56c6c;
}

.inbox-badge {
  flex: 0 0 auto;
  padding: 0 6px;
  border-radius: 4px;
  font-size: 11px;
  font-weight: 400;
  color: var(--aw-ink-muted);
  background: var(--aw-hover-bg);
}

.inbox-content {
  margin: 4px 0 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--aw-ink-muted);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.inbox-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 6px;
  font-size: 11px;
  color: var(--aw-ink-muted-48);
}

.inbox-footer {
  padding: 16px 0 8px;
  text-align: center;
}

.inbox-end {
  font-size: 11px;
  color: var(--aw-ink-muted-48);
}
</style>
