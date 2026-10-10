<template>
  <!--
    必须 teleport 到 body：抽屉由顶栏 UsageBell 渲染，而 .top-nav 带
    -webkit-app-region: drag（Electron 窗口拖拽区），仅 .nav-right 自身
    盒子是 no-drag。留在原处时抽屉头部会伸进拖拽区，落在里面的点击被系统
    吞掉——统计周期最左侧几项（如今日/昨日）就点不动。
  -->
  <el-drawer
    v-model="visible"
    class="usage-drawer"
    size="min(760px, calc(100vw - 32px))"
    append-to-body
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
/*
  el-drawer__header 的样式是 `& > :first-child { flex: 1 }`：插槽内容会占满头部全宽，
  把默认关闭按钮挤出屏幕（移动端实测按钮被推到 left=407，视口只有 393 宽，完全看不见）。
  这里让插槽内容不抢占关闭按钮的位置：桌面端用 margin-right 留位，移动端改用
  padding-right + 关闭按钮绝对定位，周期控件因此能拿满整行宽度（6 项约 292px，
  360px 一放得下，不必横向滚动）。
*/
.drawer-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  flex: 0 1 auto;
  min-width: 0;
  margin-right: 36px;
}

.drawer-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--aw-ink);
  white-space: nowrap;
}

.drawer-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  flex-wrap: wrap;
}

.period-label {
  font-size: 12px;
  color: var(--aw-ink-muted);
  white-space: nowrap;
}

.usage-tabs :deep(.el-tabs__header) {
  margin-bottom: 14px;
}

/* 移动端：头部纵向堆叠，周期控件单独占满一行，避免挤出屏幕 */
@media (max-width: 768px) {
  .usage-drawer :deep(.el-drawer__header) {
    position: relative;
    padding-right: 40px;
  }

  /* 关闭按钮脱离文档流固定在右上角，不再与内容争宽度 */
  .usage-drawer :deep(.el-drawer__close-btn) {
    position: absolute;
    top: 20px;
    right: 12px;
    z-index: 1;
  }

  .drawer-header {
    margin-right: 0;
    width: 100%;
  }

  .drawer-actions {
    flex: 1 1 100%;
    gap: 6px;
  }
}
</style>
