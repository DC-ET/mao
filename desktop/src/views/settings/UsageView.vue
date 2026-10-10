<template>
  <div class="usage-page">
    <div class="page-header">
      <h1 class="page-title">使用记录</h1>
      <p class="page-desc">查看你的 LLM 调用明细，包括对话、压缩、标题生成等场景。</p>
    </div>

    <el-card class="usage-card">
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
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { fetchMyLlmCalls, type MyLlmCallRecord } from '../../api'
import UsageFilterBar from '../../components/usage/UsageFilterBar.vue'
import UsageRecordTable from '../../components/usage/UsageRecordTable.vue'
import { EMPTY_USAGE_FILTERS, type UsageFilters } from '../../components/usage/types'

const router = useRouter()
const loading = ref(false)
const records = ref<MyLlmCallRecord[]>([])
const total = ref(0)
const currentPage = ref(1)
const pageSize = ref(20)
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

function handleSearch() {
  currentPage.value = 1
  fetchRecords()
}

function handleSizeChange() {
  currentPage.value = 1
  fetchRecords()
}

function goSession(sessionId: number) {
  router.push(`/tasks/${sessionId}`)
}

onMounted(fetchRecords)
</script>

<style scoped>
.usage-page {
  max-width: 960px;
}

.page-header {
  margin-bottom: 20px;
}

.page-title {
  margin: 0 0 8px;
  font-size: 20px;
  font-weight: 600;
  color: var(--aw-ink);
}

.page-desc {
  margin: 0;
  font-size: 13px;
  color: var(--aw-ink-muted);
}

.usage-card {
  border: 1px solid var(--aw-divider-soft);
}

.pagination-wrap {
  display: flex;
  justify-content: flex-end;
  margin-top: 16px;
}
</style>
