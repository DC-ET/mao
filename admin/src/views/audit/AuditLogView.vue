<template>
  <div class="audit-log">
    <el-card>
      <template #header>
        <div class="card-header">
          <span>审计日志</span>
        </div>
      </template>

      <!-- Search -->
      <el-form :inline="true" class="search-form">
        <el-form-item label="用户">
          <el-input v-model="searchForm.username" placeholder="用户名" clearable />
        </el-form-item>
        <el-form-item label="操作类型">
          <el-select v-model="searchForm.action" placeholder="全部" clearable>
            <el-option label="登录" value="LOGIN" />
            <el-option label="创建" value="CREATE" />
            <el-option label="更新" value="UPDATE" />
            <el-option label="删除" value="DELETE" />
          </el-select>
        </el-form-item>
        <el-form-item label="时间范围">
          <el-date-picker
            v-model="searchForm.dateRange"
            type="daterange"
            range-separator="至"
            start-placeholder="开始日期"
            end-placeholder="结束日期"
          />
        </el-form-item>
        <el-form-item>
          <el-button type="primary" @click="handleSearch">查询</el-button>
          <el-button @click="handleExport">导出</el-button>
        </el-form-item>
      </el-form>

      <!-- Table -->
      <el-table :data="logs" v-loading="loading" stripe>
        <el-table-column prop="id" label="ID" width="80" />
        <el-table-column prop="userId" label="用户ID" width="80" />
        <el-table-column prop="method" label="方法" width="80">
          <template #default="{ row }">
            <el-tag :type="row.method === 'GET' ? 'success' : row.method === 'POST' ? 'primary' : 'warning'" size="small">
              {{ row.method }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="endpoint" label="接口路径" min-width="200" show-overflow-tooltip />
        <el-table-column prop="responseCode" label="状态码" width="100">
          <template #default="{ row }">
            <el-tag :type="row.responseCode === 200 ? 'success' : 'danger'" size="small">
              {{ row.responseCode }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="latencyMs" label="耗时(ms)" width="100" />
        <el-table-column prop="createdAt" label="时间" width="180" />
      </el-table>

      <el-pagination
        class="pagination"
        :current-page="currentPage"
        :page-size="pageSize"
        :total="total"
        layout="total, prev, pager, next"
        @current-change="handlePageChange"
      />
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import { api } from '../../api'

const loading = ref(false)
const logs = ref<any[]>([])
const currentPage = ref(1)
const pageSize = ref(20)
const total = ref(0)

const searchForm = ref({
  username: '',
  action: '',
  dateRange: null as any
})

async function fetchLogs() {
  loading.value = true
  try {
    const params: any = {
      page: currentPage.value,
      size: pageSize.value
    }
    if (searchForm.value.action) params.action = searchForm.value.action
    if (searchForm.value.dateRange?.[0]) params.startDate = searchForm.value.dateRange[0].toISOString()
    if (searchForm.value.dateRange?.[1]) params.endDate = searchForm.value.dateRange[1].toISOString()

    const { data } = await api.get('/audit/api-calls', { params })
    logs.value = data?.records || []
    total.value = data?.total || 0
  } finally {
    loading.value = false
  }
}

function handleSearch() {
  currentPage.value = 1
  fetchLogs()
}

function handlePageChange(page: number) {
  currentPage.value = page
  fetchLogs()
}

function handleDetail(row: any) {
  ElMessage.info(`查看日志详情: ${row.id}`)
}

async function handleExport() {
  try {
    const { data } = await api.get('/audit/logs/export', {
      params: {
        action: searchForm.value.action,
        startDate: searchForm.value.dateRange?.[0]?.toISOString(),
        endDate: searchForm.value.dateRange?.[1]?.toISOString()
      }
    })
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `audit-logs-${new Date().toISOString().slice(0, 10)}.json`
    a.click()
    URL.revokeObjectURL(url)
    ElMessage.success('导出成功')
  } catch {
    ElMessage.error('导出失败')
  }
}

onMounted(fetchLogs)
</script>

<style scoped>
.card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.search-form {
  margin-bottom: 20px;
}

.pagination {
  margin-top: 20px;
  justify-content: flex-end;
}
</style>
