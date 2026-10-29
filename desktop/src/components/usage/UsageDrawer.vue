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
          刷新按钮是 drawer-header 的直接子元素而非塞进 drawer-actions：周期触发器约 90px，
          选中自定义区间时还会多出两个日期选择器（约 270px），和「统计周期」标签、刷新按钮
          挤在一行里，360px 一排放不下会被 flex 挤到第三行，把头部撑高、下方空出一大块。
          拆开后桌面端仍是同一行（标题居左、刷新与周期居右），移动端刷新自动落到标题行
          右侧，周期控件独占一行。
        -->
        <el-tooltip content="刷新" :show-after="100" placement="bottom">
          <el-button text :icon="Refresh" :loading="refreshing" aria-label="刷新" @click="handleRefresh" />
        </el-tooltip>
        <div class="drawer-actions">
          <span class="period-label">统计周期</span>
          <!--
            周期控件是弹层式（与管理后台同一套交互）：日历周期 / 最近分组平铺在弹出面板里，
            选中「自定义区间」后起止两个日期选择器内联出现在这里。两个日期都必填，否则请求
            不带日期会被后端回落 last30（看得到刷新但没有对应数据）。
          -->
          <PeriodPicker
            :model-value="range"
            :custom-range="customRange"
            @select="handleRangeSelect"
            @custom="handleCustomRange"
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
      <!--
        预算 Tab 固定月度，不消费 range/dateRange（决策 7：两种周期语义混用比没有更糟）；
        周期与重置日在 Tab 内自标，刷新走 refreshKey 令牌（C10 取舍 (a)）。
      -->
      <el-tab-pane label="预算" name="budget">
        <UsageBudgetTab :refresh-key="refreshKey" />
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
import { defaultCustomDateRange, usageDateRange } from './usage-range'
import PeriodPicker from './PeriodPicker.vue'
import UsageOverviewTab from './UsageOverviewTab.vue'
import UsageTrendTab from './UsageTrendTab.vue'
import UsageDetailTab from './UsageDetailTab.vue'
import UsageBudgetTab from './UsageBudgetTab.vue'

const props = defineProps<{
  modelValue: boolean
  /**
   * 跨组件打开请求（收件箱 BUDGET_WARN 跳转 / P3 横幅跳转）：带目标 Tab + nonce。
   * nonce 自增保证连续两次同 Tab 跳转都触发（Vue watch 浅比较不认同值对象，C8）。
   */
  openRequest?: { tab: UsageTab; nonce: number } | null
}>()
const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>()

const visible = computed({
  get: () => props.modelValue,
  set: (value: boolean) => emit('update:modelValue', value),
})

/** 统计周期：预设项由弹层选择器切换，自定义区间（range=custom）另带起止日。 */
const range = ref<UsageRange>('today')

export type UsageTab = 'overview' | 'trend' | 'detail' | 'budget'

const activeTab = ref<UsageTab>('overview')
const summary = ref<MyUsageSummary | null>(null)
const summaryLoading = ref(false)
const refreshing = ref(false)
/** 手动刷新令牌：趋势/明细 Tab 各自监听它重拉，避免父组件 remount 丢失分页与筛选状态。 */
const refreshKey = ref(0)
/**
 * 自定义区间（range=custom）：默认最近 7 天，避免刚切到「自定义」时是空值。
 * 切到其他周期时保留在内存里，切回来还是用户选过的那一段。
 */
const customRange = ref<UsageDateRange>(defaultCustomDateRange())
/** 随 range 派生的请求参数：非 custom 不下发，避免多余 query 干扰后端窗口计算。 */
const dateRange = computed<UsageDateRange | undefined>(() =>
  usageDateRange(range.value, customRange.value))

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

/** 跨组件打开请求：按 detail.tab 切 Tab（openRequest 由 UsageBell 持有 nonce，同值也触发）。 */
watch(() => props.openRequest, (req) => {
  if (req?.tab) activeTab.value = req.tab
})

/** 弹层里选中的预设周期：直接切换，自定义区间在内存里留着，切回来还是用户选过的那一段。 */
function handleRangeSelect(value: UsageRange) {
  range.value = value
}

/** 自定义日期改动：子组件已把区间收敛到合法范围（跨度 ≤ 90 天、起止有序），直接采用。 */
function handleCustomRange(next: UsageDateRange) {
  range.value = 'custom'
  customRange.value = next
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

/* 移动端：头部改为「标题 + 刷新」一行、「统计周期 + 周期触发器」一行 */
@media (max-width: 768px) {
  .drawer-header {
    width: 100%;
    align-items: flex-start;
    /* 6px 而非 8px：选「自定义」时触发器与日期选择器各占一行，头部要压在 90px 内 */
    row-gap: 6px;
  }

  /* 刷新按钮从周期行挪到标题行右侧，与周期控件不再争宽度 */
  .drawer-header > .el-tooltip {
    order: -1;
    margin-left: auto;
  }

  /* wrap 而非 nowrap：选「自定义」时两个日期选择器独占一行，不和触发器挤在一起 */
  .drawer-actions {
    flex: 1 1 100%;
    gap: 6px;
    flex-wrap: wrap;
    min-width: 0;
  }

  /* 窄屏隐藏「统计周期」文字标签：触发器本身就说明了用途，省下的宽度给日期选择器 */
  .period-label {
    display: none;
  }
}
</style>
