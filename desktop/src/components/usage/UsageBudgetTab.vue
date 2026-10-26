<template>
  <div class="usage-budget" v-loading="loading">
    <!--
      错误态：整请求失败（决策 9——个人视图宁缺毋假，不做部分数据展示）。
      拦截器已 toast，这里给原地重试入口。
    -->
    <div v-if="error && !loading" class="budget-error">
      <span>预算信息加载失败，请稍后重试</span>
      <el-button text type="primary" @click="fetchBudgets">重试</el-button>
    </div>

    <!-- 空态：没有生效预算 ≠ 功能坏掉，说明预算由管理员配置（C12） -->
    <el-empty v-else-if="!loading && !error && items.length === 0" :image-size="48">
      <template #description>
        <div class="budget-empty">
          <div>当前没有生效的预算限制</div>
          <div class="budget-empty-sub">团队预算由管理员配置，越线时会通过任务收件箱提醒</div>
        </div>
      </template>
    </el-empty>

    <template v-else-if="!loading && !error && items.length > 0">
      <div v-for="item in sortedItems" :key="item.id" class="budget-card">
        <div class="budget-card-head">
          <span class="budget-scope">{{ budgetScopeLabel(item.scope) }}</span>
          <el-tag :type="statusTagType(item.status)" size="small">{{ budgetStatusLabel(item) }}</el-tag>
        </div>
        <el-progress
          :percentage="budgetSpendPercent(item)"
          :color="budgetProgressColor(item)"
          :stroke-width="10"
        />
        <div class="budget-card-spend">
          当期消耗 {{ formatBudgetValue(item.periodSpend, item.limitType) }} /
          上限 {{ formatBudgetValue(item.limitValue, item.limitType) }}（{{ budgetLimitTypeLabel(item.limitType) }}口径）
        </div>
        <!-- 预算恒为月度，不消费抽屉的统计周期选择器（决策 7）；周期与重置日服务端算好原样展示（C6） -->
        <div class="budget-card-period">月度周期 · {{ item.period }} · 服务器本地时区</div>
        <div class="budget-card-reset">重置时间：{{ item.resetAt }}</div>
      </div>

      <!--
        P3 归因：本期消耗按 Agent。复用 /llm-calls/me/summary?range=month（与预算周期同口径，零后端改动）。
        辅助信息：加载失败静默，不影响主视图；无消耗行时整块不渲染。
      -->
      <div v-if="agentRows.length > 0" class="budget-agents">
        <div class="budget-agents-title">
          本期消耗按 Agent<span class="budget-agents-sub">与预算同为月度周期</span>
        </div>
        <div v-for="row in agentRows" :key="row.agentId ?? 'none'" class="budget-agent-row">
          <span class="budget-agent-name">{{ agentLabel(row) }}</span>
          <span class="budget-agent-cost">{{ formatCost(row.cost) }}</span>
        </div>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import type { BudgetStatus, MyBudgetItemVO } from '@mao/contracts'
import { fetchMyBudgets, fetchMyUsageSummary, type UsageAgentRow } from '../../api'
import { formatCost } from '../../utils/usageFormat'
import {
  budgetLimitTypeLabel,
  budgetProgressColor,
  budgetScopeLabel,
  budgetSpendPercent,
  budgetStatusLabel,
  formatBudgetValue,
  sortBudgetItems,
} from './budget-status'

const props = defineProps<{
  /** 抽屉「刷新」按钮令牌：变化即重拉，不 remount（与趋势/明细 Tab 同模式） */
  refreshKey?: number
}>()

const items = ref<MyBudgetItemVO[]>([])
const loading = ref(false)
const error = ref(false)

/** 展示序：BLOCKED 置顶 → WARNED → NORMAL，同状态内保服务端返回序（C7）。 */
const sortedItems = computed(() => sortBudgetItems(items.value))

/** P3 归因行：按成本降序（最大的消耗方在最上方）。 */
const agentRows = ref<UsageAgentRow[]>([])

function statusTagType(status: BudgetStatus): 'success' | 'warning' | 'danger' {
  return status === 'BLOCKED' ? 'danger' : status === 'WARNED' ? 'warning' : 'success'
}

function agentLabel(row: UsageAgentRow): string {
  // 无归属调用（压缩/标题等系统场景）agentId 为 null；Agent 已删查不到名字时兜底用 ID（同 UsageOverviewTab 口径）
  return row.agentName || (row.agentId != null ? `Agent #${row.agentId}` : '无 Agent')
}

let fetchSeq = 0
async function fetchBudgets() {
  const seq = ++fetchSeq
  loading.value = true
  try {
    const data = await fetchMyBudgets()
    if (seq !== fetchSeq) return
    items.value = data?.items ?? []
    error.value = false
  } catch {
    if (seq !== fetchSeq) return
    // 失败即整视图降级：不展示可能不完整的数字（决策 9）
    error.value = true
  } finally {
    if (seq === fetchSeq) loading.value = false
  }
}

/** P3 归因：失败静默（辅助信息），不影响预算主视图。 */
async function fetchAgentAttribution() {
  try {
    const data = await fetchMyUsageSummary('month')
    agentRows.value = (data?.byAgent ?? [])
      .filter((r) => (r.cost ?? 0) > 0)
      .sort((a, b) => (b.cost ?? 0) - (a.cost ?? 0))
  } catch { /* handled：辅助信息，静默 */ }
}

onMounted(() => {
  void fetchBudgets()
  void fetchAgentAttribution()
})
// 刷新令牌变化即重拉；切走再切回不自动重拉（el-tab-pane 懒渲染不销毁，C10 取舍 (a)）
watch(() => props.refreshKey, fetchBudgets)
</script>

<style scoped>
.usage-budget {
  min-height: 300px;
}

.budget-error {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 24px 0;
  font-size: 13px;
  color: var(--aw-ink-muted);
}

.budget-empty {
  line-height: 1.8;
}

.budget-empty-sub {
  font-size: 12px;
  color: var(--aw-ink-muted);
}

.budget-card {
  padding: 14px 16px;
  margin-bottom: 12px;
  border: 1px solid var(--aw-divider-soft);
  border-radius: var(--aw-radius-sm);
}

.budget-card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
}

.budget-scope {
  font-size: 13px;
  font-weight: 600;
  color: var(--aw-ink);
}

.budget-card-spend {
  margin-top: 8px;
  font-size: 12px;
  color: var(--aw-ink-muted);
}

.budget-card-period,
.budget-card-reset {
  margin-top: 4px;
  font-size: 12px;
  color: var(--aw-ink-muted);
}

.budget-agents {
  margin-top: 20px;
  padding-top: 14px;
  border-top: 1px solid var(--aw-divider-soft);
}

.budget-agents-title {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 8px;
  font-size: 13px;
  font-weight: 600;
  color: var(--aw-ink);
}

.budget-agents-sub {
  font-size: 11px;
  font-weight: 400;
  color: var(--aw-ink-muted);
}

.budget-agent-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 0;
  font-size: 12px;
}

.budget-agent-name {
  color: var(--aw-ink);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.budget-agent-cost {
  color: var(--aw-ink-muted);
  flex-shrink: 0;
  padding-left: 12px;
}
</style>
