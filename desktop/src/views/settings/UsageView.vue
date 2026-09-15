<template>
  <div class="usage-page">
    <div class="page-header">
      <h1 class="page-title">使用记录</h1>
      <p class="page-desc">查看你的 LLM 调用明细，包括对话、压缩、标题生成等场景。</p>
    </div>

    <el-card class="usage-card">
      <el-form :inline="true" class="search-form">
        <el-form-item label="场景">
          <el-select v-model="filters.scene" clearable placeholder="全部" style="width: 160px" @change="handleSearch">
            <el-option v-for="opt in LLM_CALL_SCENE_OPTIONS" :key="opt.value" :label="opt.label" :value="opt.value" />
          </el-select>
        </el-form-item>
        <el-form-item label="结果">
          <el-select v-model="filters.success" clearable placeholder="全部" style="width: 120px" @change="handleSearch">
            <el-option label="成功" :value="true" />
            <el-option label="失败" :value="false" />
          </el-select>
        </el-form-item>
        <el-form-item>
          <el-button type="primary" @click="handleSearch">查询</el-button>
          <el-button @click="handleReset">重置</el-button>
        </el-form-item>
      </el-form>

      <el-table :data="records" v-loading="loading" stripe size="small">
        <template #empty>
          <el-empty description="暂无调用记录" :image-size="48" />
        </template>
        <el-table-column label="时间" width="170">
          <template #default="{ row }">{{ formatDateTime(row.createdAt) }}</template>
        </el-table-column>
        <el-table-column label="场景" width="120">
          <template #default="{ row }">{{ llmCallSceneLabel(row.scene) }}</template>
        </el-table-column>
        <el-table-column label="模型" min-width="140" show-overflow-tooltip>
          <template #default="{ row }">{{ row.modelName || row.providerModelId || '-' }}</template>
        </el-table-column>
        <el-table-column label="入 Token" width="100" align="right">
          <template #default="{ row }">{{ formatNumber(row.promptTokens || 0) }}</template>
        </el-table-column>
        <el-table-column label="出 Token" width="100" align="right">
          <template #default="{ row }">{{ formatNumber(row.completionTokens || 0) }}</template>
        </el-table-column>
        <el-table-column label="耗时" width="90" align="right">
          <template #default="{ row }">{{ formatMs(row.durationMs) }}</template>
        </el-table-column>
        <el-table-column label="结果" width="80">
          <template #default="{ row }">
            <el-tag size="small" :type="row.success === 1 ? 'success' : 'danger'">
              {{ row.success === 1 ? '成功' : '失败' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="会话" width="100">
          <template #default="{ row }">
            <el-button v-if="row.sessionId" type="primary" link size="small" @click="goSession(row.sessionId)">
              #{{ row.sessionId }}
            </el-button>
            <span v-else>-</span>
          </template>
        </el-table-column>
      </el-table>

      <div class="pagination-wrap">
        <el-pagination
          v-model:current-page="currentPage"
          v-model:page-size="pageSize"
          :total="total"
          :page-sizes="[20, 50]"
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
import { api } from '../../api'
import { formatDateTime } from '../../utils/datetime'
import { LLM_CALL_SCENE_OPTIONS, llmCallSceneLabel, formatMs } from '../../utils/llmCallLabels'

const router = useRouter()
const loading = ref(false)
const records = ref<any[]>([])
const total = ref(0)
const currentPage = ref(1)
const pageSize = ref(20)
const filters = reactive({
  scene: '',
  success: undefined as boolean | undefined,
})

function formatNumber(value: number) {
  return new Intl.NumberFormat('zh-CN').format(value)
}

let fetchSeq = 0
async function fetchRecords() {
  const seq = ++fetchSeq
  loading.value = true
  try {
    const params: Record<string, unknown> = {
      page: currentPage.value,
      size: pageSize.value,
    }
    if (filters.scene) params.scene = filters.scene
    if (filters.success !== undefined) params.success = filters.success
    const { data } = await api.get('/llm-calls/me', { params })
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

function handleReset() {
  filters.scene = ''
  filters.success = undefined
  handleSearch()
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

.search-form {
  margin-bottom: 16px;
}

.pagination-wrap {
  display: flex;
  justify-content: flex-end;
  margin-top: 16px;
}
</style>
