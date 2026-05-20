<template>
  <div class="skill-list">
    <el-card>
      <template #header>
        <div class="card-header">
          <span>Skills 管理</span>
          <el-button type="primary" @click="handleCreate">
            <el-icon><Plus /></el-icon>
            添加 Skill
          </el-button>
        </div>
      </template>

      <el-table :data="skills" v-loading="loading" stripe>
        <el-table-column prop="id" label="ID" width="80" />
        <el-table-column prop="name" label="名称" width="150" />
        <el-table-column prop="description" label="描述" min-width="200" show-overflow-tooltip />
        <el-table-column prop="type" label="类型" width="100">
          <template #default="{ row }">
            <el-tag size="small">{{ row.type }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="status" label="状态" width="100">
          <template #default="{ row }">
            <el-tag :type="row.status === 'ACTIVE' ? 'success' : 'info'" size="small">
              {{ row.status === 'ACTIVE' ? '启用' : '禁用' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="150" fixed="right">
          <template #default="{ row }">
            <el-button type="primary" link size="small" @click="handleEdit(row)">编辑</el-button>
            <el-button type="danger" link size="small" @click="handleDelete(row)">删除</el-button>
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
const skills = ref<any[]>([])

async function fetchSkills() {
  loading.value = true
  try {
    const { data } = await api.get('/skills')
    skills.value = data || []
  } finally {
    loading.value = false
  }
}

function handleCreate() {
  ElMessage.info('添加 Skill 功能开发中')
}

function handleEdit(row: any) {
  ElMessage.info(`编辑 Skill: ${row.name}`)
}

async function handleDelete(row: any) {
  try {
    await ElMessageBox.confirm(`确定要删除 Skill "${row.name}" 吗？`, '确认', {
      type: 'warning'
    })
    await api.delete(`/skills/${row.id}`)
    ElMessage.success('删除成功')
    fetchSkills()
  } catch {
    // Cancelled
  }
}

onMounted(fetchSkills)
</script>

<style scoped>
.card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
</style>
