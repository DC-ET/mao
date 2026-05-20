<template>
  <div class="hub-manage">
    <el-card>
      <template #header>
        <div class="card-header">
          <span>Hub 管理</span>
        </div>
      </template>

      <el-table :data="hubAgents" v-loading="loading" stripe>
        <el-table-column prop="id" label="ID" width="80" />
        <el-table-column prop="name" label="名称" width="150" />
        <el-table-column prop="description" label="描述" min-width="200" show-overflow-tooltip />
        <el-table-column prop="creatorName" label="创建者" width="120" />
        <el-table-column prop="installCount" label="安装数" width="100" />
        <el-table-column prop="status" label="状态" width="100">
          <template #default="{ row }">
            <el-tag :type="row.status === 'PUBLISHED' ? 'success' : 'warning'" size="small">
              {{ row.status === 'PUBLISHED' ? '已发布' : '待审核' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="publishedAt" label="发布时间" width="180" />
        <el-table-column label="操作" width="150" fixed="right">
          <template #default="{ row }">
            <el-button type="primary" link size="small" @click="handleApprove(row)">审核</el-button>
            <el-button type="danger" link size="small" @click="handleReject(row)">下架</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { api } from '../../api'

const loading = ref(false)
const hubAgents = ref<any[]>([])

async function fetchHubAgents() {
  loading.value = true
  try {
    const { data } = await api.get('/hub/agents')
    hubAgents.value = data || []
  } finally {
    loading.value = false
  }
}

async function handleApprove(row: any) {
  try {
    await ElMessageBox.confirm('确定要审核通过此 Agent 吗？', '确认')
    await api.put(`/hub/agents/${row.id}/approve`)
    ElMessage.success('审核通过')
    fetchHubAgents()
  } catch {
    // Cancelled
  }
}

async function handleReject(row: any) {
  try {
    await ElMessageBox.confirm(`确定要下架 Agent "${row.name}" 吗？`, '确认', {
      type: 'warning'
    })
    await api.put(`/hub/agents/${row.id}/reject`)
    ElMessage.success('已下架')
    fetchHubAgents()
  } catch {
    // Cancelled
  }
}

onMounted(fetchHubAgents)
</script>

<style scoped>
.card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
</style>
