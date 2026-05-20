<template>
  <div class="hub">
    <el-row :gutter="20">
      <el-col :span="24">
        <div class="hub-header">
          <h2>Agent Hub</h2>
          <el-input
            v-model="searchQuery"
            placeholder="搜索 Agent..."
            prefix-icon="Search"
            clearable
            class="search-input"
          />
        </div>
      </el-col>
    </el-row>

    <el-row :gutter="20">
      <el-col :span="6" v-for="agent in filteredAgents" :key="agent.id">
        <el-card class="agent-card">
          <div class="agent-icon">
            <el-avatar :size="64" :src="agent.iconUrl" icon="Monitor" />
          </div>
          <h3>{{ agent.name }}</h3>
          <p class="description">{{ agent.description }}</p>
          <div class="meta">
            <span class="creator">
              <el-icon><User /></el-icon>
              {{ agent.creatorName }}
            </span>
            <span class="installs">
              <el-icon><Download /></el-icon>
              {{ agent.installCount }} 次安装
            </span>
          </div>
          <div class="tags">
            <el-tag
              v-for="tag in agent.tags"
              :key="tag"
              size="small"
              class="tag"
            >
              {{ tag }}
            </el-tag>
          </div>
          <el-button
            type="primary"
            class="install-btn"
            @click="handleInstall(agent)"
            :disabled="agent.installed"
          >
            {{ agent.installed ? '已安装' : '安装' }}
          </el-button>
        </el-card>
      </el-col>

      <!-- Empty state -->
      <el-col :span="24" v-if="filteredAgents.length === 0 && !loading">
        <el-empty description="暂无可用的 Agent" />
      </el-col>
    </el-row>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import { api } from '../../api'

const loading = ref(false)
const searchQuery = ref('')
const agents = ref<any[]>([])

const filteredAgents = computed(() => {
  if (!searchQuery.value) return agents.value
  const query = searchQuery.value.toLowerCase()
  return agents.value.filter(agent =>
    agent.name.toLowerCase().includes(query) ||
    agent.description?.toLowerCase().includes(query)
  )
})

async function fetchHubAgents() {
  loading.value = true
  try {
    const { data } = await api.get('/hub/agents')
    agents.value = data || []
  } finally {
    loading.value = false
  }
}

async function handleInstall(agent: any) {
  try {
    await api.post(`/hub/agents/${agent.id}/install`)
    agent.installed = true
    agent.installCount++
    ElMessage.success(`已安装 ${agent.name}`)
  } catch {
    // Error handled by interceptor
  }
}

onMounted(fetchHubAgents)
</script>

<style scoped>
.hub {
  padding: 20px 0;
}

.hub-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 20px;
}

.hub-header h2 {
  margin: 0;
  color: #303133;
}

.search-input {
  width: 300px;
}

.agent-card {
  margin-bottom: 20px;
  transition: all 0.3s;
}

.agent-card:hover {
  transform: translateY(-5px);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
}

.agent-icon {
  text-align: center;
  margin-bottom: 12px;
}

.agent-card h3 {
  text-align: center;
  margin: 0 0 8px 0;
  color: #303133;
}

.description {
  color: #909399;
  font-size: 12px;
  text-align: center;
  margin: 0 0 12px 0;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.meta {
  display: flex;
  justify-content: center;
  gap: 16px;
  margin-bottom: 12px;
  font-size: 12px;
  color: #909399;
}

.meta .el-icon {
  margin-right: 4px;
}

.tags {
  display: flex;
  justify-content: center;
  gap: 4px;
  flex-wrap: wrap;
  margin-bottom: 12px;
}

.install-btn {
  width: 100%;
}
</style>
