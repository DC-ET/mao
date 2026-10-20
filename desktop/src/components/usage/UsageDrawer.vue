<template>
    <!--
      必须 teleport 到 body：抽屉由顶栏 UsageBell 渲染，就地渲染会被 .top-nav
      的 overflow 裁掉。注意 teleport 只解决裁剪——.top-nav 是 Electron 拖拽区
      （几何区域，与绘制层级无关），抽屉画在拖拽带上方时落在带里的点击仍会被
      系统吞掉；那部分由全局 style.css 的 .el-overlay/.el-popper no-drag 规则
      从拖拽区里抠掉（统计周期最左侧几项与刷新按钮曾因此点不动）。
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
          <!--
            自定义区间只在 range=custom 时出现：两个日期都必填，否则请求不带日期会被后端
            回落 last30（看得到刷新但没有对应数据）。用 daterange 而不是两个 date 选择器，
            省一行宽度，也天然禁止 start > end。
          -->
          <el-date-picker
            v-if="range === 'custom'"
            v-model="customRange"
            class="period-range"
            type="daterange"
            unlink-panels
            range-separator="至"
            start-placeholder="开始日期"
            end-placeholder="结束日期"
            value-format="YYYY-MM-DD"
            :clearable="false"
            :editable="false"
            size="small"
            @change="handleCustomRangeChange"
          />
        </div>
      </div>
    </template>

    <el-tabs v-model="activeTab" class="usage-tabs">
      <el-tab-pane label="总览" name="overview">
        <UsageOverviewTab :summary="summary" :loading="summaryLoading" />
      </el-tab-pane>
      <el-tab-pane label="趋势" name="trend">
        <UsageTrendTab :range="range" :date-range="dateRange" :refresh-key="refreshKey" />
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
import {
  fetchMyUsageSummary,
  type MyUsageSummary,
  type UsageDateRange,
  type UsageRange,
} from '../../api'
import { USAGE_PERIOD_OPTIONS, defaultCustomDateRange, usageDateRange } from './usage-range'
import UsageOverviewTab from './UsageOverviewTab.vue'
import UsageTrendTab from './UsageTrendTab.vue'
import UsageDetailTab from './UsageDetailTab.vue'

const props = defineProps<{ modelValue: boolean }>()
const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>()

const visible = computed({
  get: () => props.modelValue,
  set: (value: boolean) => emit('update:modelValue', value),
})

/** 统计周期：日历周期在前，滚动窗口在后，自定义区间收尾（今日/昨日时趋势图自动按小时分桶）。 */
const PERIOD_OPTIONS = USAGE_PERIOD_OPTIONS

/** 自定义区间（UsageDateRange）→ 日期区间选择器要的 [start, end] 元组。 */
function toCustomTuple(range: UsageDateRange): [string, string] {
  return [range.startDate, range.endDate]
}

type UsageTab = 'overview' | 'trend' | 'detail'

const range = ref<UsageRange>('today')
const activeTab = ref<UsageTab>('overview')
const summary = ref<MyUsageSummary | null>(null)
const summaryLoading = ref(false)
const refreshing = ref(false)
/** 手动刷新令牌：趋势/明细 Tab 各自监听它重拉，避免父组件 remount 丢失分页与筛选状态。 */
const refreshKey = ref(0)
/**
 * 自定义区间（range=custom）：默认最近 7 天，避免刚切到「自定义」时是空值。
 * 日期选择器给的是 [start, end] 元组，请求只需要起止两个字段。
 */
const customRange = ref<[string, string]>(toCustomTuple(defaultCustomDateRange()))
/** 随 range 派生的请求参数：非 custom 不下发，避免多余 query 干扰后端窗口计算。 */
const dateRange = computed<UsageDateRange | undefined>(() =>
  usageDateRange(range.value, { startDate: customRange.value[0], endDate: customRange.value[1] }))

let fetchSeq = 0
async function fetchSummary() {
  const seq = ++fetchSeq
  summaryLoading.value = true
  try {
    const data = await fetchMyUsageSummary(range.value, dateRange.value)
    if (seq !== fetchSeq) return
    summary.value = data
  } catch { /* handled */ } finally {
    if (seq === fetchSeq) summaryLoading.value = false
  }
}

/** 总览数据只在抽屉打开且停留在总览 Tab 时拉取；切周期/改自定义日期立即重拉。 */
watch([visible, activeTab, range, dateRange], ([open, tab]) => {
  if (open && tab === 'overview') void fetchSummary()
})

/** 自定义日期改动：只在上限/下限都合法时重拉（EP 允许中途出现半成品状态）。 */
function handleCustomRangeChange(value: [string, string] | null) {
  if (!value || value.length !== 2 || !value[0] || !value[1]) return
  customRange.value = [value[0], value[1]]
}

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
    /* 6px 而非 8px：选「自定义」时周期控件与日期区间各占一行，头部要压在 90px 内 */
    row-gap: 6px;
  }

  /* 刷新按钮从周期行挪到标题行右侧，与周期控件不再争宽度 */
  .drawer-header > .el-tooltip {
    order: -1;
    margin-left: auto;
  }

  /* wrap 而非 nowrap：选「自定义」时日期区间选择器独占一行，不和 9 项周期挤在一起 */
  .drawer-actions {
    flex: 1 1 100%;
    gap: 6px;
    flex-wrap: wrap;
    min-width: 0;
  }

  /*
    周期控件 9 项内容宽约 438px，393px 手机的抽屉内容区只有 321px。不能靠压缩项宽
    解决——EP 会把项内文字截成「近 ...」的省略号（393px 实测）。改为保留内容宽度
    （group 用 max-content）+ 容器横向滚动，窄屏下左右滑动看完整周期。
  */
  .drawer-actions :deep(.el-segmented) {
    flex: 0 1 auto;
    min-width: 0;
    max-width: 100%;
    overflow-x: auto;
    overflow-y: hidden;
    scrollbar-width: thin;
    -webkit-overflow-scrolling: touch;
  }

  .drawer-actions :deep(.el-segmented__group) {
    width: max-content;
  }

  /* 窄屏隐藏「统计周期」文字标签：分段控件本身就说明了用途，省下的宽度给周期项 */
  .period-label {
    display: none;
  }

  /* 自定义区间选择器独占整行：两个日期 + 分隔符在 321px 里排得开 */
  .period-range {
    flex: 1 1 100%;
    width: 100%;
  }
}
</style>
