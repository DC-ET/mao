<template>
  <div ref="scrollEl" class="table-grid-scroll" @scroll.passive="onScroll">
    <table v-if="rows.length > 0" class="table-grid">
      <thead>
        <tr>
          <th
            v-for="(cell, col) in headerCells"
            :key="col"
            :class="{ numeric: numericCols.has(col) }"
            :title="cell"
          >
            {{ cell }}
          </th>
        </tr>
      </thead>
      <tbody>
        <!-- 虚拟滚动（技术方案 §5.3 / §5.5）：行数 > 200 用定高 padding 行撑滚动区，
             只渲染可视窗口；≤200 行全量渲染 -->
        <tr v-if="virtual" class="pad-row" :style="{ height: `${padTop}px` }"></tr>
        <tr
          v-for="(row, i) in visibleRows"
          :key="startIdx + i"
          :class="{ odd: (startIdx + i) % 2 === 1 }"
        >
          <td
            v-for="(cell, col) in row"
            :key="col"
            :class="{ numeric: numericCols.has(col) }"
            :title="cell"
          >
            {{ cell }}
          </td>
        </tr>
        <tr v-if="virtual" class="pad-row" :style="{ height: `${padBottom}px` }"></tr>
      </tbody>
    </table>
    <p v-else class="table-grid-empty">无数据</p>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onActivated, onMounted, ref, watch } from 'vue'
import { isNumericColumn } from '../../utils/csv-parse'

const props = defineProps<{
  /** 行数组，首行按表头渲染（CSV 与 XLSX 同口径） */
  rows: string[][]
}>()

const ROW_HEIGHT = 32
const VIRTUAL_THRESHOLD = 200
const OVERSCAN = 10

const headerCells = computed(() => props.rows[0] ?? [])
const bodyRows = computed(() => props.rows.slice(1))

/** 数值列右对齐启发式（§5.3）：数据行（不含表头）该列 ≥80% 非空单元格可 Number() 解析 */
const numericCols = computed(() => {
  const cols = new Set<number>()
  const width = props.rows[0]?.length ?? 0
  const data = bodyRows.value
  for (let col = 0; col < width; col++) {
    if (isNumericColumn(data, col)) cols.add(col)
  }
  return cols
})

// ---- 窗口化虚拟滚动 ----
const scrollEl = ref<HTMLElement>()
const scrollTop = ref(0)
const viewportHeight = ref(0)
const virtual = computed(() => bodyRows.value.length > VIRTUAL_THRESHOLD)

const startIdx = computed(() =>
  virtual.value ? Math.max(0, Math.floor(scrollTop.value / ROW_HEIGHT) - OVERSCAN) : 0,
)
const endIdx = computed(() =>
  virtual.value
    ? Math.min(bodyRows.value.length, Math.ceil((scrollTop.value + viewportHeight.value) / ROW_HEIGHT) + OVERSCAN)
    : bodyRows.value.length,
)
const visibleRows = computed(() => bodyRows.value.slice(startIdx.value, endIdx.value))
const padTop = computed(() => startIdx.value * ROW_HEIGHT)
const padBottom = computed(() => Math.max(0, (bodyRows.value.length - endIdx.value) * ROW_HEIGHT))

function measureViewport() {
  viewportHeight.value = scrollEl.value?.clientHeight ?? 0
}

function onScroll() {
  scrollTop.value = scrollEl.value?.scrollTop ?? 0
  measureViewport()
}

// 换数据源（CSV 刷新 / sheet 切换）回到顶部：留在旧滚动位会看到错位窗口
watch(
  () => props.rows,
  () => {
    scrollTop.value = 0
    if (scrollEl.value) scrollEl.value.scrollTop = 0
  },
)

// KeepAlive 隐藏期间 clientHeight 为 0：重新激活时补量，否则窗口塌缩成 overscan 几行
onMounted(async () => {
  await nextTick()
  measureViewport()
})
onActivated(async () => {
  await nextTick()
  measureViewport()
})
</script>

<style scoped>
.table-grid-scroll {
  flex: 1;
  min-height: 0;
  overflow: auto;
}

.table-grid {
  border-collapse: separate;
  border-spacing: 0;
  width: max-content;
  min-width: 100%;
  font-size: var(--aw-text-caption);
  font-family: var(--aw-font-mono);
}

.table-grid thead th {
  position: sticky;
  top: 0;
  z-index: 2;
  padding: 8px 12px;
  text-align: left;
  white-space: nowrap;
  font-weight: 600;
  color: var(--aw-ink);
  background: var(--aw-canvas-parchment);
  border-bottom: 1px solid var(--aw-divider-soft);
}

.table-grid tbody tr {
  height: 32px;
}

.table-grid tbody tr:hover td {
  background: var(--aw-primary-hover);
}

.table-grid tbody tr.odd td {
  background: rgba(127, 127, 127, 0.04);
}

.table-grid tbody tr.odd:hover td {
  background: var(--aw-primary-hover);
}

.table-grid td {
  padding: 6px 12px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 480px;
  color: var(--aw-ink);
  border-bottom: 1px solid var(--aw-divider-soft);
}

.table-grid .numeric {
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.pad-row {
  height: 0;
  padding: 0;
  border: none;
}

.table-grid-empty {
  margin: 0;
  padding: 24px;
  text-align: center;
  font-size: var(--aw-text-caption);
  color: var(--aw-ink-muted-48);
}

/* Scrollbar */
.table-grid-scroll::-webkit-scrollbar {
  width: 6px;
  height: 6px;
}

.table-grid-scroll::-webkit-scrollbar-track {
  background: transparent;
}

.table-grid-scroll::-webkit-scrollbar-thumb {
  background: var(--aw-hairline);
  border-radius: 3px;
}
</style>
