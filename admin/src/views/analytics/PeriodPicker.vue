<template>
  <!--
    周期控件整体：触发器 + 预设弹出面板 + 自定义区间行内的两个日期选择器。
    自定义日期条内联在工具栏（而非塞进弹层）：EP 日期面板固定 teleport 到 body，
    放在 el-popover 里会被当成"点击弹层外部"瞬间关掉。
  -->
  <div class="period-control">
    <el-popover
      v-model:visible="open"
      trigger="click"
      placement="bottom-end"
      :width="PANEL_WIDTH"
      :show-arrow="false"
      :offset="6"
      popper-class="period-picker-popper"
    >
      <template #reference>
        <button type="button" class="period-trigger" :aria-expanded="open ? 'true' : 'false'">
          <el-icon class="period-trigger-icon"><Calendar /></el-icon>
          <span class="period-trigger-label">{{ triggerLabel }}</span>
          <el-icon class="period-trigger-caret" :class="{ 'is-open': open }"><ArrowDown /></el-icon>
        </button>
      </template>

      <div class="period-panel">
        <div v-for="group in PERIOD_GROUPS" :key="group.label" class="period-group">
          <div class="period-group-title">{{ group.label }}</div>
          <div class="period-chips" :class="{ 'is-dense': group.options.length > 4 }">
            <button
              v-for="option in group.options"
              :key="String(option.value)"
              type="button"
              class="period-chip"
              :class="{ 'is-selected': isSelected(option.value) }"
              :aria-pressed="isSelected(option.value) ? 'true' : 'false'"
              @click="selectPreset(option.value)"
            >
              {{ option.label }}
            </button>
          </div>
        </div>

        <div class="period-divider" />

        <button
          type="button"
          class="period-custom-entry"
          :class="{ 'is-selected': modelValue === 'custom' }"
          @click="selectCustom"
        >
          <el-icon><Calendar /></el-icon>
          自定义区间
        </button>
        <p class="period-hint">可选近一年内任意区间，最长 {{ MAX_CUSTOM_DAYS }} 天</p>
      </div>
    </el-popover>

    <template v-if="modelValue === 'custom'">
      <el-date-picker
        v-model="startDate"
        class="period-date"
        type="date"
        placeholder="开始日期"
        value-format="YYYY-MM-DD"
        :clearable="false"
        :editable="false"
        :disabled-date="disabledStartDate"
        @change="handleStartChange"
      />
      <span class="period-range-sep">至</span>
      <el-date-picker
        v-model="endDate"
        class="period-date"
        type="date"
        placeholder="结束日期"
        value-format="YYYY-MM-DD"
        :clearable="false"
        :editable="false"
        :disabled-date="disabledEndDate"
        @change="handleEndChange"
      />
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ArrowDown, Calendar } from '@element-plus/icons-vue'
import type { CustomPeriodRange, PeriodValue } from './types'
import {
  MAX_CUSTOM_DAYS,
  MAX_CUSTOM_LOOKBACK_DAYS,
  PERIOD_GROUPS,
  addDaysYmd,
  daysBetweenYmd,
  isValidYmd,
  periodLabel,
  todayYmd
} from './composables/useAnalyticsPeriod'

const props = defineProps<{
  modelValue: PeriodValue
  customRange: CustomPeriodRange
}>()

const emit = defineEmits<{
  (e: 'select', value: PeriodValue): void
  (e: 'custom', range: CustomPeriodRange): void
}>()

const PANEL_WIDTH = 344

const open = ref(false)

const triggerLabel = computed(() => periodLabel(props.modelValue))

function isSelected(value: PeriodValue): boolean {
  return props.modelValue === value
}

/** 点已选中的项不重复触发：避免同周期再拉一次全量数据。 */
function selectPreset(value: PeriodValue) {
  open.value = false
  if (props.modelValue === value) return
  emit('select', value)
}

function selectCustom() {
  open.value = false
  if (props.modelValue === 'custom') return
  emit('select', 'custom')
}

// ---- 自定义区间：两个单日期选择器，禁用规则互相对应，从源头禁掉非法区间 ----

const startDate = ref(props.customRange.start)
const endDate = ref(props.customRange.end)

// 外部（URL 还原 / 切换周期）改了区间就同步回来
watch(
  () => props.customRange,
  (range) => {
    startDate.value = range.start
    endDate.value = range.end
  }
)

/** 可选的起止边界按北京时间取：晚于今天没有数据，早于后端 endOffset 上限会被 clamp 成另一个窗口。 */
const minSelectable = computed(() => midnightOf(addDaysYmd(todayYmd(), -MAX_CUSTOM_LOOKBACK_DAYS)))
const maxSelectable = computed(() => midnightOf(todayYmd()))

function midnightOf(ymd: string): number {
  const [y, m, d] = ymd.split('-').map(Number)
  return new Date(y, m - 1, d).getTime()
}

function outOfBounds(date: Date): boolean {
  return date.getTime() > maxSelectable.value || date.getTime() < minSelectable.value
}

/** 起点：不晚于终点，也不早于「终点 −（最长跨度 − 1）」。 */
function disabledStartDate(date: Date): boolean {
  if (outOfBounds(date)) return true
  return date.getTime() > midnightOf(endDate.value) || date.getTime() < midnightOf(addDaysYmd(endDate.value, -(MAX_CUSTOM_DAYS - 1)))
}

/** 终点：不早于起点，也不晚于「起点 +（最长跨度 − 1）」。 */
function disabledEndDate(date: Date): boolean {
  if (outOfBounds(date)) return true
  return date.getTime() < midnightOf(startDate.value) || date.getTime() > midnightOf(addDaysYmd(startDate.value, MAX_CUSTOM_DAYS - 1))
}

function handleStartChange(value: string) {
  if (!isValidYmd(value)) return
  // 保留用户刚选的起点：晚于终点时把终点拉到起点（跨度超限由禁用规则挡在门外）
  applyCustom(value, endDate.value < value ? value : endDate.value)
}

function handleEndChange(value: string) {
  if (!isValidYmd(value)) return
  applyCustom(startDate.value > value ? value : startDate.value, value)
}

/** 兜底收敛跨度（禁用规则挡不住 URL 直接带进来的超长区间），再交给外部应用。 */
function applyCustom(start: string, end: string) {
  if (daysBetweenYmd(start, end) + 1 > MAX_CUSTOM_DAYS) start = addDaysYmd(end, -(MAX_CUSTOM_DAYS - 1))
  startDate.value = start
  endDate.value = end
  emit('custom', { start, end })
}
</script>

<style scoped>
.period-control {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.period-trigger {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 32px;
  padding: 0 10px 0 8px;
  border: 1px solid var(--mao-border);
  border-radius: 6px;
  background: var(--mao-surface);
  color: var(--mao-ink);
  font-size: 13px;
  line-height: 1;
  white-space: nowrap;
  cursor: pointer;
}

.period-trigger:hover {
  border-color: var(--mao-accent);
  color: var(--mao-accent);
}

.period-trigger:focus-visible {
  outline: 2px solid var(--mao-accent-ring);
  outline-offset: 1px;
}

.period-trigger-label {
  font-weight: 500;
}

.period-trigger-caret {
  font-size: 12px;
  color: var(--mao-muted);
  transition: transform 0.15s ease;
}

.period-trigger-caret.is-open {
  transform: rotate(180deg);
}

.period-trigger:hover .period-trigger-caret {
  color: var(--mao-accent);
}

.period-panel {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.period-group-title {
  margin-bottom: 6px;
  font-size: 12px;
  color: var(--mao-muted);
}

.period-chips {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 6px;
}

/* 「最近」组 4 项一行排开，避免 3 列留下一个孤格 */
.period-chips.is-dense {
  grid-template-columns: repeat(4, 1fr);
}

.period-chip {
  height: 30px;
  padding: 0 4px;
  border: 1px solid var(--mao-border);
  border-radius: 6px;
  background: var(--mao-surface);
  color: var(--mao-ink);
  font-size: 13px;
  white-space: nowrap;
  cursor: pointer;
}

.period-chip:hover {
  border-color: var(--mao-accent);
  color: var(--mao-accent);
}

.period-chip.is-selected,
.period-chip.is-selected:hover {
  border-color: var(--mao-accent);
  background: var(--mao-accent);
  color: #ffffff;
}

.period-divider {
  height: 1px;
  background: var(--mao-border);
}

.period-custom-entry {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  width: 100%;
  height: 32px;
  border: 1px solid var(--mao-border);
  border-radius: 6px;
  background: var(--mao-surface);
  color: var(--mao-ink);
  font-size: 13px;
  cursor: pointer;
}

.period-custom-entry:hover {
  border-color: var(--mao-accent);
  color: var(--mao-accent);
}

.period-custom-entry.is-selected {
  border-color: var(--mao-accent);
  background: var(--mao-accent-bg);
  color: var(--mao-accent);
}

.period-hint {
  margin: 6px 0 0;
  font-size: 12px;
  line-height: 1.4;
  color: var(--mao-muted);
}

.period-date {
  width: 132px;
}

.period-range-sep {
  font-size: 12px;
  color: var(--mao-muted);
}

/* 窄屏：自定义日期条独占一行，不与触发器挤在同一行 */
@media (max-width: 768px) {
  .period-control {
    flex-wrap: wrap;
    row-gap: 8px;
  }

  .period-date {
    flex: 1 1 auto;
    min-width: 0;
  }
}
</style>

<style>
/* 弹层 teleport 到 body，scoped 属性选择器匹配不到，只能全局兜宽度 */
.period-picker-popper {
  max-width: calc(100vw - 24px) !important;
}
</style>
