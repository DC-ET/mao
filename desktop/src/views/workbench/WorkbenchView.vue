<template>
  <div class="workbench">
    <el-row :gutter="20">
      <el-col :span="24">
        <h2>我的 Agent</h2>
      </el-col>
    </el-row>

    <el-row :gutter="20">
      <el-col :span="6" v-for="agent in agents" :key="agent.id">
        <el-card class="agent-card" @click="handleSelectAgent(agent)">
          <div class="agent-icon">
            <el-avatar :size="64" :src="agent.iconUrl" icon="Monitor" />
          </div>
          <h3>{{ agent.name }}</h3>
          <p class="description">{{ agent.description }}</p>
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
        </el-card>
      </el-col>

      <!-- Empty state -->
      <el-col :span="24" v-if="agents.length === 0 && !loading">
        <el-empty description="暂无可用的 Agent">
          <el-button type="primary" @click="router.push('/hub')">
            去 Hub 发现
          </el-button>
        </el-empty>
      </el-col>
    </el-row>

    <!-- Recent sessions -->
    <el-row :gutter="20" class="recent-sessions">
      <el-col :span="24">
        <h2>最近对话</h2>
      </el-col>

      <el-col :span="8" v-for="session in recentSessions" :key="session.id">
        <el-card class="session-card" @click="handleResumeSession(session)">
          <div class="session-info">
            <h4>{{ session.title || '新对话' }}</h4>
            <p class="agent-name">{{ session.agentName }}</p>
            <p class="time">{{ session.updatedAt }}</p>
          </div>
        </el-card>
      </el-col>
    </el-row>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { api } from '../../api'

const router = useRouter()
const loading = ref(false)
const agents = ref<any[]>([])
const recentSessions = ref<any[]>([])

async function fetchData() {
  loading.value = true
  try {
    // Fetch agents
    const agentRes = await api.get('/agents')
    agents.value = agentRes.data || []

    // Fetch recent sessions
    const sessionRes = await api.get('/sessions')
    recentSessions.value = (sessionRes.data || []).slice(0, 6)
  } finally {
    loading.value = false
  }
}

function handleSelectAgent(agent: any) {
  router.push(`/chat/${agent.id}`)
}

function handleResumeSession(session: any) {
  router.push(`/chat/${session.agentId}?sessionId=${session.id}`)
}

onMounted(fetchData)
</script>

<style scoped>
.workbench {
  padding: 20px 0;
}

.workbench h2 {
  margin: 0 0 20px 0;
  color: #303133;
}

.agent-card {
  cursor: pointer;
  transition: all 0.3s;
  margin-bottom: 20px;
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

.tags {
  display: flex;
  justify-content: center;
  gap: 4px;
  flex-wrap: wrap;
}

.recent-sessions {
  margin-top: 40px;
}

.session-card {
  cursor: pointer;
  transition: all 0.3s;
  margin-bottom: 20px;
}

.session-card:hover {
  transform: translateY(-3px);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
}

.session-info h4 {
  margin: 0 0 8px 0;
  color: #303133;
  font-size: 14px;
}

.agent-name {
  color: #409eff;
  font-size: 12px;
  margin: 0 0 4px 0;
}

.time {
  color: #909399;
  font-size: 12px;
  margin: 0;
}
</style>
