<template>
  <div class="hub">
    <div class="hub-header">
      <h1 class="hub-title">Agent Hub</h1>
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

    <div v-if="loading" class="loading-state">
      <el-icon class="loading-spinner"><Loading /></el-icon>
    </div>

    <div v-else-if="filteredAgents.length === 0" class="empty-state">
      <el-empty description="暂无可用的 Agent" />
    </div>

    <div v-else class="agent-grid">
      <div
        v-for="agent in filteredAgents"
        :key="agent.id"
        class="agent-card"
        @click="showAgentDetail(agent)"
      >
        <div class="agent-icon">
          <el-avatar :size="48" :src="agent.iconUrl" icon="Monitor" />
        </div>
        <div class="agent-info">
          <h3>{{ agent.name }}</h3>
          <p class="description">{{ agent.description }}</p>
          <div class="meta">
            <span class="rating">
              <el-rate v-model="agent.avgRating" disabled text-color="#ff9900" size="small" />
              <span class="rating-count">({{ agent.ratingCount || 0 }})</span>
            </span>
            <span class="installs">
              <el-icon><Download /></el-icon>
              {{ agent.installCount }}
            </span>
          </div>
          <el-button
            type="primary"
            size="small"
            class="install-btn pill-btn"
            @click.stop="handleInstall(agent)"
            :disabled="agent.installed"
          >
            {{ agent.installed ? '已安装' : '安装' }}
          </el-button>
        </div>
      </div>
    </div>

    <!-- Agent Detail Dialog -->
    <el-dialog v-model="detailVisible" :title="detailAgent?.name" width="600px" class="detail-dialog">
      <div v-if="detailAgent">
        <p class="detail-desc">{{ detailAgent.description }}</p>
        <el-divider />
        <h4 class="detail-section-title">评分</h4>
        <el-rate v-model="myRating" :max="5" show-text @change="handleRate" />
        <el-divider />
        <h4 class="detail-section-title">评论 ({{ comments.length }})</h4>
        <div v-for="comment in comments" :key="comment.id" class="comment-item">
          <div class="comment-header">
            <span class="comment-user">用户 #{{ comment.userId }}</span>
            <span class="comment-time">{{ comment.createdAt }}</span>
          </div>
          <div class="comment-content">{{ comment.content }}</div>
        </div>
        <div v-if="comments.length === 0" class="no-comments">暂无评论</div>
        <el-divider />
        <el-input v-model="newComment" type="textarea" :rows="2" placeholder="发表评论..." />
        <el-button type="primary" class="pill-btn" style="margin-top: 8px" @click="handleComment" :disabled="!newComment.trim()">发表评论</el-button>
      </div>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { Download, Loading } from '@element-plus/icons-vue'
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
  padding: var(--aw-space-section) var(--aw-space-xl);
  max-width: 1068px;
  margin: 0 auto;
}

.hub-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: var(--aw-space-xl);
  flex-wrap: wrap;
  gap: var(--aw-space-sm);
}

.hub-title {
  margin: 0;
  font-family: var(--aw-font-display);
  font-size: var(--aw-text-display-lg);
  font-weight: 600;
  color: var(--aw-ink);
  letter-spacing: 0;
  line-height: 1.1;
}

.header-actions {
  display: flex;
  gap: 10px;
  align-items: center;
}

.search-input {
  width: 240px;
}

.search-input :deep(.el-input__wrapper) {
  border-radius: var(--aw-radius-pill);
}

.category-select {
  width: 130px;
}

.type-select {
  width: 90px;
}

.loading-state {
  display: flex;
  justify-content: center;
  padding: 60px;
}

.loading-spinner {
  font-size: 24px;
  color: var(--aw-ink-muted-48);
  animation: spin 1s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.empty-state {
  padding: 80px;
}

/* Agent Grid */
.agent-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: var(--aw-space-md);
}

.agent-card {
  display: flex;
  align-items: flex-start;
  gap: var(--aw-space-sm);
  padding: var(--aw-space-lg);
  background: var(--aw-canvas);
  border: 1px solid var(--aw-hairline);
  border-radius: var(--aw-radius-lg);
  cursor: pointer;
  transition: border-color 0.2s, transform 0.2s;
}

.agent-card:hover {
  border-color: var(--aw-primary);
  transform: translateY(-1px);
}

.agent-icon {
  flex-shrink: 0;
}

.agent-info {
  min-width: 0;
  flex: 1;
}

.agent-info h3 {
  margin: 0 0 var(--aw-space-xxs);
  font-family: var(--aw-font-display);
  font-size: var(--aw-text-body);
  font-weight: 600;
  color: var(--aw-ink);
  letter-spacing: -0.374px;
}

.description {
  color: var(--aw-ink-muted-80);
  font-size: var(--aw-text-caption);
  margin: 0 0 var(--aw-space-xs);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  line-height: 1.43;
  letter-spacing: -0.224px;
}

.meta {
  display: flex;
  align-items: center;
  gap: var(--aw-space-sm);
  margin-bottom: 10px;
  font-size: var(--aw-text-fine);
  color: var(--aw-ink-muted-48);
}

.rating {
  display: flex;
  align-items: center;
  gap: 4px;
}

.rating-count {
  font-size: var(--aw-text-fine);
  color: var(--aw-ink-muted-48);
}

.installs {
  display: flex;
  align-items: center;
  gap: 2px;
}

.install-btn {
  width: 100%;
  border-radius: var(--aw-radius-pill) !important;
}

/* Dialog */
.detail-desc {
  color: var(--aw-ink-muted-80);
  line-height: 1.47;
  letter-spacing: -0.374px;
  font-size: var(--aw-text-body);
}

.detail-section-title {
  margin: 0 0 var(--aw-space-xs);
  font-family: var(--aw-font-display);
  font-size: var(--aw-text-body);
  font-weight: 600;
  color: var(--aw-ink);
  letter-spacing: -0.374px;
}

.no-comments {
  color: var(--aw-ink-muted-48);
  text-align: center;
  padding: var(--aw-space-lg);
  font-size: var(--aw-text-caption);
}

.comment-item {
  padding: 12px 0;
  border-bottom: 1px solid var(--aw-divider-soft);
}

.comment-item:last-child {
  border-bottom: none;
}

.comment-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 6px;
}

.comment-user {
  font-size: var(--aw-text-body);
  font-weight: 600;
  color: var(--aw-ink);
  letter-spacing: -0.374px;
}

.comment-time {
  font-size: var(--aw-text-fine);
  color: var(--aw-ink-muted-48);
  letter-spacing: -0.12px;
}

.comment-content {
  font-size: var(--aw-text-body);
  color: var(--aw-ink-muted-80);
  line-height: 1.47;
  letter-spacing: -0.374px;
}

.pill-btn {
  border-radius: var(--aw-radius-pill) !important;
}

/* Dialog overrides */
:deep(.el-dialog) {
  border-radius: var(--aw-radius-lg);
}

:deep(.el-dialog__header) {
  padding: 20px 24px 0;
}

:deep(.el-dialog__title) {
  font-family: var(--aw-font-display);
  font-size: var(--aw-text-tagline);
  font-weight: 600;
  letter-spacing: 0.231px;
}

:deep(.el-dialog__body) {
  padding: 16px 24px;
}

:deep(.el-dialog__footer) {
  padding: 0 24px 20px;
}
</style>
