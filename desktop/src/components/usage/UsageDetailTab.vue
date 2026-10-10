<template>
  <div class="usage-detail">
    <UsageFilterBar v-model="filters" @search="handleSearch" />

    <UsageRecordTable :records="records" :loading="loading" @go-session="goSession" />

    <!--
      布局说明：窄屏下 `total, sizes, prev, pager, next` 一串总宽约 451px，而抽屉内容区
      在 393px 手机上只有 321px，右对齐会把「共 N 条」整段推到内容区左侧之外（实测
      left=-78）。所以窄屏只保留 `sizes, prev, pager, next` 并允许横向滚动，
      总数改由分页上方的汇总行给出，桌面端仍显示 EP 自带的 total。
    -->
    <div v-if="compact" class="pagination-summary">共 {{ total }} 条</div>
    <div class="pagination-wrap">
      <el-pagination
        v-model:current-page="currentPage"
        v-model:page-size="pageSize"
        :total="total"
        :page-sizes="[10, 20, 50, 100]"
        size="small"
        :layout="compact ? 'sizes, prev, pager, next' : 'total, sizes, prev, pager, next'"
        @current-change="fetchRecords"
        @size-change="handleSizeChange"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { fetchMyLlmCalls, type MyLlmCallRecord } from '../../api'
import UsageFilterBar from './UsageFilterBar.vue'
import UsageRecordTable from './UsageRecordTable.vue'
import { EMPTY_USAGE_FILTERS, type UsageFilters } from './types'

const props = defineProps<{
  /** 抽屉「刷新」按钮令牌：变化即重拉当前页 */
  refreshKey?: number
}>()

const emit = defineEmits<{
  close: []
}>()

const router = useRouter()
const loading = ref(false)
const records = ref<MyLlmCallRecord[]>([])
const total = ref(0)
const currentPage = ref(1)
const pageSize = ref(10)
const filters = reactive<UsageFilters>({ ...EMPTY_USAGE_FILTERS })

/**
 * 窄屏（≤768px）标志：跟随视口宽度，避免抽屉内容区放不下一整条分页。
 * 分页条的 `total, sizes, prev, pager, next` 连排约 451px，393px 手机上的抽屉内容区
 * 只有 321px，右对齐时「共 N 条」会被整体推到内容区左侧之外（实测 left=-78），
 * 条数选择器也跟着错位。窄屏下改用精简布局，总数移到分页上方的汇总行。
 */
const compact = ref(typeof window !== 'undefined' ? window.innerWidth <= 768 : false)
if (typeof window !== 'undefined') {
  window.addEventListener('resize', () => {
    compact.value = window.innerWidth <= 768
  }, { passive: true })
}

let fetchSeq = 0
async function fetchRecords() {
  const seq = ++fetchSeq
  loading.value = true
  try {
    const data = await fetchMyLlmCalls({
      page: currentPage.value,
      size: pageSize.value,
      scene: filters.scene || undefined,
      modelId: filters.modelId,
      success: filters.success,
    })
    if (seq !== fetchSeq) return
    records.value = data?.records || []
    total.value = data?.total || 0
  } catch { /* handled */ } finally {
    if (seq === fetchSeq) loading.value = false
  }
}

function handleSizeChange() {
  currentPage.value = 1
  fetchRecords()
}

/** 筛选栏「改条件即查」：回到第 1 页再拉，避免停在越界页看到空列表。 */
function handleSearch() {
  currentPage.value = 1
  fetchRecords()
}

function goSession(sessionId: number) {
  emit('close')
  router.push(`/tasks/${sessionId}`)
}

onMounted(fetchRecords)
watch(() => props.refreshKey, fetchRecords)
</script>

<style scoped>
/* 窄屏汇总行：EP 自带的 total 段在窄屏会被挤出内容区，这里单独给一行 */
.pagination-summary {
  margin-top: 12px;
  font-size: 12px;
  color: var(--aw-ink-muted);
}

.pagination-wrap {
  display: flex;
  justify-content: flex-end;
  margin-top: 12px;
}

/*
  窄屏：sizes 选择器 + 页码连排约 325px，仍可能超过内容区（321px），
  允许整条分页横向滚动而不是溢出到屏幕外。
*/
@media (max-width: 768px) {
  .pagination-wrap {
    justify-content: flex-start;
    overflow-x: auto;
    overflow-y: hidden;
    -webkit-overflow-scrolling: touch;
    scrollbar-width: none;
  }

  .pagination-wrap::-webkit-scrollbar {
    display: none;
  }
}
</style>
