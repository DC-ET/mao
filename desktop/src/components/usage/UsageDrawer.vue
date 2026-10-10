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
        <!--
          刷新按钮是 drawer-header 的直接子元素而非塞进 drawer-actions：周期控件 6 项
          约 292px，加上「统计周期」标签与刷新按钮接近 400px，360px 一排放不下会被 flex
          挤到第三行，把头部撑到 130px 高、下方空出一大块。拆开后桌面端仍是同一行
          （标题居左、刷新与周期居右），移动端刷新自动落到标题行右侧，周期控件独占一行。
        -->
        <el-tooltip content="刷新" :show-after="100" placement="bottom">
          <el-button text :icon="Refresh" :loading="refreshing" aria-label="刷新" @click="handleRefresh" />
        </el-tooltip>
        <div class="drawer-actions">
          <span class="period-label">统计周期</span>
          <el-segmented v-model="range" :options="PERIOD_OPTIONS" size="small" />
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
  只放本项目自己的元素。EP 内部结构（.el-drawer__header / __close-btn）的覆盖必须放全局
  style.css：class="usage-drawer" 是通过 fallthrough attrs 传到 el-drawer 内部的
  .el-drawer 元素上的，scoped 的 data-v-* 属性不会跟着 attrs 走，所以带
  [data-v-x] 的选择器匹配不到那些节点（实测 matches=false，规则静默失效）。
*/
.drawer-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  min-width: 0;
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

/* 移动端：头部改为「标题 + 刷新」一行、「统计周期 + 分段控件」一行 */
@media (max-width: 768px) {
  .drawer-header {
    width: 100%;
    align-items: flex-start;
    row-gap: 8px;
  }

  /* 刷新按钮从周期行挪到标题行右侧，与周期控件不再争宽度 */
  .drawer-header > .el-tooltip {
    order: -1;
    margin-left: auto;
  }

  .drawer-actions {
    flex: 1 1 100%;
    gap: 6px;
    flex-wrap: nowrap;
    min-width: 0;
  }

  /* 周期控件保持内容宽度（6 项约 292px）不被压缩：压缩后 EP 会把项内文字截成
     「近 ...」的省略号（393px 实测）。空间不够时由「统计周期」标签让位。 */
  .drawer-actions :deep(.el-segmented) {
    flex: 0 0 auto;
  }

  /* 窄屏隐藏「统计周期」文字标签：分段控件本身就说明了用途，省下的 53px 让 6 项完整显示 */
  .period-label {
    display: none;
  }
}
</style>
