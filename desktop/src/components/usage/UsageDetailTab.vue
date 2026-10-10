<template>
  <div class="usage-detail">
    <UsageFilterBar v-model="filters" @search="handleSearch" />

    <UsageRecordTable :records="records" :loading="loading" @go-session="goSession" />

    <div class="pagination-wrap">
      <el-pagination
        v-model:current-page="currentPage"
        v-model:page-size="pageSize"
        :total="total"
        :page-sizes="[10, 20, 50, 100]"
        size="small"
        layout="total, sizes, prev, pager, next"
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
.pagination-wrap {
  display: flex;
  justify-content: flex-end;
  margin-top: 12px;
}
</style>
