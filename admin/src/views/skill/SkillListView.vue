<template>
  <div class="skill-list">
    <el-card>
      <template #header>
        <div class="card-header">
          <span>Skill 知识文档</span>
          <el-tag type="info" size="small">基于文件系统管理</el-tag>
        </div>
      </template>

      <el-table :data="skillDocs" v-loading="loading" stripe>
        <el-table-column prop="name" label="名称" width="180" />
        <el-table-column prop="description" label="描述" min-width="300" show-overflow-tooltip />
        <el-table-column prop="filePath" label="文件路径" min-width="250" show-overflow-tooltip />
        <el-table-column label="操作" width="120" fixed="right">
          <template #default="{ row }">
            <el-button type="primary" link size="small" @click="handleView(row)">查看内容</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <!-- Skill 内容查看弹窗 -->
    <el-dialog
      v-model="detailVisible"
      :title="`Skill: ${currentDoc?.name || ''}`"
      width="700px"
    >
      <div v-if="currentDoc" class="skill-detail">
        <p><strong>描述：</strong>{{ currentDoc.description }}</p>
        <p><strong>文件路径：</strong>{{ currentDoc.filePath }}</p>
        <el-divider />
        <div class="skill-body">
          <pre>{{ currentDoc.body }}</pre>
        </div>
      </div>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { api } from '../../api'

const loading = ref(false)
const skillDocs = ref<any[]>([])
const detailVisible = ref(false)
const currentDoc = ref<any>(null)

async function fetchSkillDocs() {
  loading.value = true
  try {
    const { data } = await api.get('/skill-docs')
    skillDocs.value = data || []
  } finally {
    loading.value = false
  }
}

async function handleView(row: any) {
  try {
    const { data } = await api.get(`/skill-docs/${row.name}`)
    currentDoc.value = data
    detailVisible.value = true
  } catch {
    // Error handled by interceptor
  }
}

onMounted(fetchSkillDocs)
</script>

<style scoped>
.card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.skill-detail p {
  margin: 8px 0;
}
.skill-body pre {
  background: var(--el-fill-color-light);
  padding: 16px;
  border-radius: 8px;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 500px;
  overflow-y: auto;
  font-size: 13px;
  line-height: 1.6;
}
</style>
