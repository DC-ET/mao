<template>
  <el-drawer
    v-model="visible"
    class="usage-drawer"
    size="min(760px, calc(100vw - 32px))"
    :with-header="true"
  >
    <template #header>
      <div class="drawer-header">
        <span class="drawer-title">我的用量</span>
        <div class="drawer-actions">
          <span class="period-label">统计周期</span>
          <el-segmented v-model="range" :options="PERIOD_OPTIONS" size="small" />
          <el-tooltip content="刷新" :show-after="100" placement="bottom">
            <el-button text :icon="Refresh" :loading="refreshing" aria-label="刷新" @click="handleRefresh" />
          </el-tooltip>
        </div>
      </div>
    </template>

    <el-tabs v-model="activeTab" class="usage-tabs">
      <el-tab-pane label="总览" name="overview">
        <UsageOverviewTab :summary="summary" :loading="summaryLoading" />
      </el-tab-pane>
      <el-tab-pane label="趋势" name="trend">
        <UsageTrendTab :range="range" :refresh-key="refreshKey" />
      </el-tab-pane>
      <el-tab-pane label="明细" name="detail">
        <UsageDetailTab :refresh-key="refreshKey" @close="visible = false" />
      </el-tab-pane>
    </el-tabs>
  </el-drawer>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { Refresh } from '@element-plus/icons-vue'
import { fetchMyUsageSummary, type MyUsageSummary, type UsageRange } from '../../api'
import UsageOverviewTab from './UsageOverviewTab.vue'
import UsageTrendTab from './UsageTrendTab.vue'
import UsageDetailTab from './UsageDetailTab.vue'

const props = defineProps<{ modelValue: boolean }>()
const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>()

const visible = computed({
  get: () => props.modelValue,
  set: (value: boolean) => emit('update:modelValue', value),
})

/** 统计周期：日历周期在前，滚动窗口在后（今日/昨日时趋势图自动按小时分桶）。 */
const PERIOD_OPTIONS: Array<{ label: string; value: UsageRange }> = [
  { label: '今日', value: 'today' },
  { label: '昨日', value: 'yesterday' },
  { label: '本周', value: 'week' },
  { label: '本月', value: 'month' },
  { label: '近 7 天', value: 'last7' },
  { label: '近 30 天', value: 'last30' },
]

type UsageTab = 'overview' | 'trend' | 'detail'

const range = ref<UsageRange>('today')
const activeTab = ref<UsageTab>('overview')
const summary = ref<MyUsageSummary | null>(null)
const summaryLoading = ref(false)
const refreshing = ref(false)
/** 手动刷新令牌：趋势/明细 Tab 各自监听它重拉，避免父组件 remount 丢失分页与筛选状态。 */
const refreshKey = ref(0)

let fetchSeq = 0
async function fetchSummary() {
  const seq = ++fetchSeq
  summaryLoading.value = true
  try {
    const data = await fetchMyUsageSummary(range.value)
    if (seq !== fetchSeq) return
    summary.value = data
  } catch { /* handled */ } finally {
    if (seq === fetchSeq) summaryLoading.value = false
  }
}

/** 总览数据只在抽屉打开且停留在总览 Tab 时拉取；切周期立即重拉。 */
watch([visible, activeTab, range], ([open, tab]) => {
  if (open && tab === 'overview') void fetchSummary()
})

async function handleRefresh() {
  refreshing.value = true
  try {
    refreshKey.value += 1
    if (activeTab.value === 'overview') await fetchSummary()
  } finally {
    refreshing.value = false
  }
}
</script>

<style scoped>
.drawer-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

.drawer-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--aw-ink);
}

.drawer-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.period-label {
  font-size: 12px;
  color: var(--aw-ink-muted);
}

.usage-tabs :deep(.el-tabs__header) {
  margin-bottom: 14px;
}
</style>
