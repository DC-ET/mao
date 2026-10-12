<script setup lang="ts">
import { computed } from 'vue'
import type { InboxItem } from '@mao/contracts'
import {
  formatDigestCost,
  parseDigestData,
  shortDate,
  type DigestData,
} from './digest-payload'

const props = defineProps<{
  modelValue: boolean
  item: InboxItem | null
}>()

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  /** 打开会话（失败任务 / 审批项跳转）。 */
  'jump-session': [sessionId: number]
  /** 路由跳转（哨兵列表 / 定时任务面板）。 */
  'jump-route': [path: string]
  /** 打开我的用量（成本板块）。 */
  'open-usage': []
}>()

const visible = computed({
  get: () => props.modelValue,
  set: (value: boolean) => emit('update:modelValue', value),
})

/** payload 解析失败（旧格式 / 损坏）时降级提示，不渲染板块。 */
const data = computed<DigestData | null>(() => parseDigestData(props.item?.payload ?? null))

const dialogTitle = computed(() =>
  data.value != null ? `昨日运营摘要（${shortDate(data.value.coveredDate)}）` : '昨日运营摘要'
)

function jumpSession(sessionId: number | null) {
  if (sessionId == null) return
  visible.value = false
  emit('jump-session', sessionId)
}

function jumpRoute(path: string) {
  visible.value = false
  emit('jump-route', path)
}

function openUsage() {
  visible.value = false
  emit('open-usage')
}
</script>

<template>
  <el-dialog
    v-model="visible"
    :title="dialogTitle"
    width="min(520px, calc(100vw - 32px))"
    class="digest-detail-dialog"
    append-to-body
  >
    <div v-if="data == null" class="digest-empty">摘要数据缺失或格式不受支持</div>
    <template v-else>
      <p class="digest-covered">汇总日期：{{ data.coveredDate }}（Asia/Shanghai）</p>

      <section v-if="data.tasks" class="digest-section">
        <h4 class="digest-section-title">任务</h4>
        <p class="digest-line">完成 {{ data.tasks.completed }} 个，失败 {{ data.tasks.failed }} 个</p>
        <ul v-if="data.tasks.failedTop.length > 0" class="digest-items">
          <li v-for="(task, index) in data.tasks.failedTop" :key="`failed-${index}`" class="digest-item">
            <span class="digest-item-text">
              <span class="digest-item-name">{{ task.title }}</span>
              <span v-if="task.reason" class="digest-item-reason">{{ task.reason }}</span>
            </span>
            <el-button
              v-if="task.sessionId != null"
              text
              type="primary"
              size="small"
              @click="jumpSession(task.sessionId)"
            >
              打开会话
            </el-button>
          </li>
        </ul>
      </section>

      <section v-if="data.scheduled" class="digest-section">
        <h4 class="digest-section-title">定时任务</h4>
        <p class="digest-line">
          执行 {{ data.scheduled.total }} 次（完成 {{ data.scheduled.completed }}，失败 {{ data.scheduled.failed }}）
        </p>
        <ul v-if="data.scheduled.paused.length > 0" class="digest-items">
          <li v-for="(task, index) in data.scheduled.paused" :key="`paused-${index}`" class="digest-item">
            <span class="digest-item-text">已自动暂停：{{ task.name }}</span>
          </li>
        </ul>
        <el-button text type="primary" size="small" @click="jumpRoute('/settings/scheduled-tasks')">
          打开定时任务面板
        </el-button>
      </section>

      <section v-if="data.watchers" class="digest-section">
        <h4 class="digest-section-title">信号哨兵</h4>
        <p class="digest-line">触发 {{ data.watchers.triggered }} 次</p>
        <ul v-if="data.watchers.disabled.length > 0" class="digest-items">
          <li v-for="(watcher, index) in data.watchers.disabled" :key="`disabled-${index}`" class="digest-item">
            <span class="digest-item-text">已自动停用：{{ watcher.name }}</span>
          </li>
        </ul>
        <el-button text type="primary" size="small" @click="jumpRoute('/settings/signal-watchers')">
          打开哨兵列表
        </el-button>
      </section>

      <section v-if="data.approvals" class="digest-section">
        <h4 class="digest-section-title">审批待办</h4>
        <p class="digest-line">待处理 {{ data.approvals.pending }} 条（不限汇总日期，挂起即计数）</p>
        <ul v-if="data.approvals.items.length > 0" class="digest-items">
          <li v-for="(approval, index) in data.approvals.items" :key="`approval-${index}`" class="digest-item">
            <span class="digest-item-text">
              <span class="digest-item-name">{{ approval.title }}</span>
            </span>
            <el-button
              v-if="approval.sessionId != null"
              text
              type="primary"
              size="small"
              @click="jumpSession(approval.sessionId)"
            >
              打开会话
            </el-button>
          </li>
        </ul>
      </section>

      <section v-if="data.cost" class="digest-section">
        <h4 class="digest-section-title">Token 成本</h4>
        <p class="digest-line">合计 {{ formatDigestCost(data.cost.totalMicros) }}</p>
        <ul v-if="data.cost.top.length > 0" class="digest-items">
          <li v-for="(agent, index) in data.cost.top" :key="`cost-${index}`" class="digest-item">
            <span class="digest-item-text">
              <span class="digest-item-name">{{ agent.name }}</span>
              <span class="digest-item-reason">{{ formatDigestCost(agent.micros) }}</span>
            </span>
          </li>
        </ul>
        <p v-if="data.cost.unpricedCalls > 0" class="digest-note">
          另有 {{ data.cost.unpricedCalls }} 次调用未配价格，未计入合计
        </p>
        <p v-if="data.cost.totalMicros === 0 && data.cost.unpricedCalls === 0 && data.cost.calls > 0" class="digest-note">
          全部 {{ data.cost.calls }} 次调用均为免费模型（0 价），未产生成本
        </p>
        <el-button text type="primary" size="small" @click="openUsage">查看我的用量</el-button>
      </section>

      <section v-if="data.openApi" class="digest-section">
        <h4 class="digest-section-title">开放接口</h4>
        <p class="digest-line">
          调用 {{ data.openApi.total }} 次<span v-if="data.openApi.rejected > 0">，其中拒绝 {{ data.openApi.rejected }} 次</span>
        </p>
      </section>
    </template>
  </el-dialog>
</template>

<style scoped>
.digest-covered {
  margin: 0 0 12px;
  font-size: 12px;
  color: var(--aw-ink-muted-48);
}

.digest-empty {
  padding: 24px 0;
  text-align: center;
  font-size: 13px;
  color: var(--aw-ink-muted-48);
}

.digest-section {
  padding: 12px 0;
  border-bottom: 1px solid var(--aw-divider-soft);
}

.digest-section:last-child {
  border-bottom: 0;
}

.digest-section-title {
  margin: 0 0 6px;
  font-size: 13px;
  font-weight: 600;
  color: var(--aw-ink);
}

.digest-line {
  margin: 0;
  font-size: 13px;
  line-height: 1.6;
  color: var(--aw-ink);
}

.digest-items {
  margin: 8px 0 0;
  padding: 0;
  list-style: none;
}

.digest-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 6px 0;
}

.digest-item-text {
  display: flex;
  flex-direction: column;
  min-width: 0;
  font-size: 12px;
  color: var(--aw-ink);
}

.digest-item-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.digest-item-reason {
  margin-top: 2px;
  font-size: 11px;
  color: var(--aw-ink-muted-48);
}

.digest-note {
  margin: 6px 0 0;
  font-size: 11px;
  color: var(--aw-ink-muted-48);
}
</style>
