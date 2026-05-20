<template>
  <div class="hub">
    <el-row :gutter="20">
      <el-col :span="24">
        <div class="hub-header">
          <h2>Agent Hub</h2>
          <div class="header-actions">
            <el-select v-model="selectedCategory" placeholder="全部分类" clearable class="category-select">
              <el-option v-for="cat in categories" :key="cat" :label="cat" :value="cat" />
            </el-select>
            <el-select v-model="listType" class="type-select">
              <el-option label="推荐" value="recommended" />
              <el-option label="最热" value="hot" />
              <el-option label="最新" value="new" />
              <el-option label="全部" value="all" />
            </el-select>
            <el-input
              v-model="searchQuery"
              placeholder="搜索 Agent..."
              prefix-icon="Search"
              clearable
              class="search-input"
            />
          </div>
        </div>
      </el-col>
    </el-row>

    <el-row :gutter="20">
      <el-col :span="6" v-for="agent in filteredAgents" :key="agent.id">
        <el-card class="agent-card" @click="showAgentDetail(agent)">
          <div class="agent-icon">
            <el-avatar :size="64" :src="agent.iconUrl" icon="Monitor" />
          </div>
          <h3>{{ agent.name }}</h3>
          <p class="description">{{ agent.description }}</p>
          <div class="rating-row">
            <el-rate v-model="agent.avgRating" disabled show-score text-color="#ff9900" size="small" />
            <span class="rating-count">({{ agent.ratingCount || 0 }})</span>
          </div>
          <div class="meta">
            <span class="installs">
              <el-icon><Download /></el-icon>
              {{ agent.installCount }} 次安装
            </span>
            <el-tag v-if="agent.category" size="small" type="info">{{ agent.category }}</el-tag>
          </div>
          <el-button
            type="primary"
            class="install-btn"
            @click.stop="handleInstall(agent)"
            :disabled="agent.installed"
          >
            {{ agent.installed ? '已安装' : '安装' }}
          </el-button>
        </el-card>
      </el-col>

      <el-col :span="24" v-if="filteredAgents.length === 0 && !loading">
        <el-empty description="暂无可用的 Agent" />
      </el-col>
    </el-row>

    <!-- Agent Detail Dialog -->
    <el-dialog v-model="detailVisible" :title="detailAgent?.name" width="600px">
      <div v-if="detailAgent">
        <p>{{ detailAgent.description }}</p>
        <el-divider />
        <h4>评分</h4>
        <el-rate v-model="myRating" :max="5" show-text @change="handleRate" />
        <el-divider />
        <h4>评论 ({{ comments.length }})</h4>
        <div v-for="comment in comments" :key="comment.id" class="comment-item">
          <div class="comment-header">
            <span class="comment-user">用户 #{{ comment.userId }}</span>
            <span class="comment-time">{{ comment.createdAt }}</span>
          </div>
          <div class="comment-content">{{ comment.content }}</div>
        </div>
        <div v-if="comments.length === 0" style="color: #909399; text-align: center; padding: 20px">暂无评论</div>
        <el-divider />
        <el-input v-model="newComment" type="textarea" :rows="2" placeholder="发表评论..." />
        <el-button type="primary" style="margin-top: 8px" @click="handleComment" :disabled="!newComment.trim()">发表评论</el-button>
      </div>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { api } from '../../api'

const loading = ref(false)
const searchQuery = ref('')
const agents = ref<any[]>([])
const categories = ref<string[]>([])
const selectedCategory = ref('')
const listType = ref('recommended')

const detailVisible = ref(false)
const detailAgent = ref<any>(null)
const comments = ref<any[]>([])
const myRating = ref(0)
const newComment = ref('')

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
    let endpoint = '/hub/agents'
    const params: any = {}
    if (listType.value === 'recommended') {
      endpoint = '/hub/agents/recommended'
      params.limit = 20
    } else if (listType.value === 'hot' || listType.value === 'new') {
      endpoint = '/hub/agents/ranking'
      params.type = listType.value
      params.limit = 20
    }
    if (selectedCategory.value) {
      params.category = selectedCategory.value
    }
    const { data } = await api.get(endpoint, { params })
    agents.value = data || []
  } finally {
    loading.value = false
  }
}

async function fetchCategories() {
  const { data } = await api.get('/hub/categories')
  categories.value = (data as any) || []
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

async function showAgentDetail(agent: any) {
  detailAgent.value = agent
  myRating.value = agent.avgRating || 0
  newComment.value = ''
  detailVisible.value = true
  // Fetch comments
  const { data } = await api.get(`/hub/agents/${agent.id}/comments`)
  comments.value = (data as any) || []
}

async function handleRate(score: number) {
  if (!detailAgent.value) return
  try {
    await api.post(`/hub/agents/${detailAgent.value.id}/rate`, { score })
    ElMessage.success('评分成功')
    fetchHubAgents()
  } catch {
    // Error handled
  }
}

async function handleComment() {
  if (!detailAgent.value || !newComment.value.trim()) return
  try {
    await api.post(`/hub/agents/${detailAgent.value.id}/comments`, { content: newComment.value })
    ElMessage.success('评论成功')
    newComment.value = ''
    const { data } = await api.get(`/hub/agents/${detailAgent.value.id}/comments`)
    comments.value = (data as any) || []
  } catch {
    // Error handled
  }
}

watch([selectedCategory, listType], () => fetchHubAgents())

onMounted(() => {
  fetchHubAgents()
  fetchCategories()
})
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

.header-actions {
  display: flex;
  gap: 12px;
  align-items: center;
}

.category-select {
  width: 140px;
}

.type-select {
  width: 100px;
}

.rating-row {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  margin-bottom: 12px;
}

.rating-count {
  font-size: 12px;
  color: #909399;
}

.comment-item {
  padding: 12px 0;
  border-bottom: 1px solid #f0f0f0;
}

.comment-item:last-child {
  border-bottom: none;
}

.comment-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
}

.comment-user {
  font-size: 14px;
  font-weight: 500;
  color: #303133;
}

.comment-time {
  font-size: 12px;
  color: #c0c4cc;
}

.comment-content {
  font-size: 14px;
  color: #606266;
  line-height: 1.6;
}
</style>
