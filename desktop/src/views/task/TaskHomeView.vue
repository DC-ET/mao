<template>
  <div class="task-home">
    <div class="home-header">
      <h1 class="home-title">工作台</h1>
      <p class="home-desc">继续未完成的任务，或选择一个 Agent 开始新任务</p>
    </div>

    <!-- Running tasks -->
    <section v-if="dashboard.running.length > 0" class="home-section">
      <h2 class="section-title">进行中</h2>
      <div class="running-list">
        <div
          v-for="session in dashboard.running"
          :key="session.id"
          class="running-card"
          @click="continueTask(session)"
        >
          <div class="running-card-main">
            <span class="running-dot"></span>
            <div class="running-info">
              <span class="running-title">{{ session.summary || session.title }}</span>
              <span class="running-agent">{{ session.agentName }}</span>
            </div>
          </div>
          <div class="running-card-right">
            <span class="running-phase">{{ phaseLabel(session.phase) }}</span>
            <el-icon class="running-arrow"><ArrowRight /></el-icon>
          </div>
        </div>
      </div>
    </section>

    <!-- Recent tasks -->
    <section v-if="dashboard.recent.length > 0" class="home-section">
      <h2 class="section-title">最近</h2>
      <div class="recent-list">
        <div
          v-for="session in dashboard.recent.slice(0, 6)"
          :key="session.id"
          class="recent-card"
          @click="continueTask(session)"
        >
          <span class="recent-title">{{ session.summary || session.title }}</span>
          <span class="recent-agent">{{ session.agentName }}</span>
        </div>
      </div>
    </section>

    <!-- Agent grid -->
    <section class="home-section">
      <h2 class="section-title">选择 Agent 开始新任务</h2>
      <div class="agent-grid">
        <div
          v-for="agent in agents"
          :key="agent.id"
          class="agent-card"
          @click="startTask(agent)"
        >
          <el-avatar :size="40" class="agent-avatar">
            {{ agent.name?.charAt(0) }}
          </el-avatar>
          <div class="agent-info">
            <span class="agent-name">{{ agent.name }}</span>
            <span class="agent-desc">{{ agent.description || 'AI Agent' }}</span>
          </div>
        </div>
      </div>
    </section>

    <!-- Mode selection dialog -->
    <el-dialog v-model="showModeDialog" title="选择执行模式" width="440px" class="mode-dialog">
      <p class="mode-desc">请选择 Agent 的执行模式：</p>
      <div class="mode-options">
        <div
          class="mode-card"
          :class="{ selected: selectedMode === 'CLOUD' }"
          @click="selectedMode = 'CLOUD'"
        >
          <el-icon :size="28"><Cloudy /></el-icon>
          <h4>云端模式</h4>
          <p>工具在服务器上执行，无需本地环境</p>
        </div>
        <div
          class="mode-card"
          :class="{ selected: selectedMode === 'LOCAL' }"
          @click="selectedMode = 'LOCAL'"
        >
          <el-icon :size="28"><Monitor /></el-icon>
          <h4>本地模式</h4>
          <p>工具在本地执行，需要桌面应用连接</p>
        </div>
      </div>
      <template #footer>
        <el-button class="pill-btn" @click="showModeDialog = false">取消</el-button>
        <el-button type="primary" class="pill-btn" @click="confirmMode">确定</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { ArrowRight, Cloudy, Monitor } from '@element-plus/icons-vue'
import { useTaskDashboardStore } from '../../stores/taskDashboard'
import { useSessionStore, type Session, type TaskPhase } from '../../stores/session'
import { useAgentStore } from '../../stores/agent'

const router = useRouter()
const dashboard = useTaskDashboardStore()
const sessionStore = useSessionStore()
const agentStore = useAgentStore()

const agents = ref<any[]>([])
const showModeDialog = ref(false)
const selectedMode = ref<'CLOUD' | 'LOCAL'>('CLOUD')
const selectedAgent = ref<any>(null)

function phaseLabel(phase: TaskPhase) {
  switch (phase) {
    case 'RUNNING': return '执行中'
    case 'WAITING_USER': return '等待输入'
    case 'WAITING_APPROVAL': return '待审批'
    case 'COMPLETED': return '已完成'
    case 'FAILED': return '失败'
    default: return ''
  }
}

function continueTask(session: Session) {
  sessionStore.setActiveSession(session.id)
  router.push(`/tasks/${session.id}`)
}

function startTask(agent: any) {
  selectedAgent.value = agent
  selectedMode.value = 'CLOUD'
  showModeDialog.value = true
}

async function confirmMode() {
  const agent = selectedAgent.value
  if (!agent) return
  showModeDialog.value = false
  const session = await sessionStore.createSession(agent.id, selectedMode.value)
  if (session) {
    sessionStore.setActiveSession(session.id)
    router.push(`/tasks/${session.id}`)
  }
}

onMounted(async () => {
  await Promise.all([
    dashboard.fetchDashboard(),
    agentStore.fetchAgents().then(() => {
      agents.value = agentStore.agents || []
    })
  ])
})
</script>

<style scoped>
.task-home {
  max-width: 900px;
  margin: 0 auto;
  padding: var(--aw-space-xl) var(--aw-space-xl) 80px;
}

.home-header {
  margin-bottom: 40px;
}

.home-title {
  margin: 0 0 8px;
  font-family: var(--aw-font-display);
  font-size: var(--aw-text-headline);
  font-weight: 600;
  color: var(--aw-ink);
  letter-spacing: -0.41px;
}

.home-desc {
  margin: 0;
  font-size: var(--aw-text-body);
  color: var(--aw-ink-muted-48);
}

.home-section {
  margin-bottom: 32px;
}

.section-title {
  margin: 0 0 12px;
  font-size: var(--aw-text-tagline);
  font-weight: 600;
  color: var(--aw-ink);
  letter-spacing: 0.231px;
}

/* Running tasks */
.running-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.running-card {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 16px;
  background: var(--aw-canvas);
  border: 1px solid var(--aw-primary);
  border-radius: var(--aw-radius-lg);
  cursor: pointer;
  transition: box-shadow 0.15s;
}

.running-card:hover {
  box-shadow: 0 2px 8px rgba(0, 102, 204, 0.12);
}

.running-card-main {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
}

.running-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--aw-primary);
  flex-shrink: 0;
  animation: pulse 2s ease-in-out infinite;
}

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}

.running-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.running-title {
  font-size: var(--aw-text-body);
  font-weight: 500;
  color: var(--aw-ink);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.running-agent {
  font-size: var(--aw-text-caption);
  color: var(--aw-ink-muted-48);
}

.running-card-right {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.running-phase {
  font-size: var(--aw-text-caption);
  color: var(--aw-primary);
}

.running-arrow {
  color: var(--aw-ink-muted-48);
}

/* Recent tasks */
.recent-list {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: 8px;
}

.recent-card {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 12px 14px;
  background: var(--aw-canvas);
  border: 1px solid var(--aw-hairline);
  border-radius: var(--aw-radius-md);
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s;
}

.recent-card:hover {
  border-color: var(--aw-ink-muted-48);
  background: var(--aw-canvas-parchment);
}

.recent-title {
  font-size: var(--aw-text-caption);
  color: var(--aw-ink);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.recent-agent {
  font-size: var(--aw-text-micro);
  color: var(--aw-ink-muted-48);
}

/* Agent grid */
.agent-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 12px;
}

.agent-card {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 16px;
  background: var(--aw-canvas);
  border: 1px solid var(--aw-hairline);
  border-radius: var(--aw-radius-lg);
  cursor: pointer;
  transition: border-color 0.15s, box-shadow 0.15s;
}

.agent-card:hover {
  border-color: var(--aw-ink-muted-48);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.06);
}

.agent-avatar {
  background: var(--aw-primary);
  color: var(--aw-on-primary);
  font-weight: 600;
  flex-shrink: 0;
}

.agent-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.agent-name {
  font-size: var(--aw-text-body);
  font-weight: 500;
  color: var(--aw-ink);
}

.agent-desc {
  font-size: var(--aw-text-caption);
  color: var(--aw-ink-muted-48);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.pill-btn {
  border-radius: var(--aw-radius-pill) !important;
}

/* Mode Dialog */
.mode-desc {
  margin: 0 0 var(--aw-space-sm);
  color: var(--aw-ink-muted-80);
  font-size: var(--aw-text-caption);
}

.mode-options {
  display: flex;
  gap: var(--aw-space-sm);
}

.mode-card {
  flex: 1;
  padding: var(--aw-space-lg) var(--aw-space-md);
  border: 2px solid var(--aw-hairline);
  border-radius: var(--aw-radius-lg);
  cursor: pointer;
  text-align: center;
  transition: all 0.2s;
  color: var(--aw-ink-muted-48);
}

.mode-card:hover {
  border-color: var(--aw-primary);
}

.mode-card.selected {
  border-color: var(--aw-primary);
  background: rgba(0, 102, 204, 0.05);
}

.mode-card h4 {
  margin: var(--aw-space-xs) 0 var(--aw-space-xxs);
  font-family: var(--aw-font-display);
  font-size: var(--aw-text-body);
  font-weight: 600;
  color: var(--aw-ink);
  letter-spacing: -0.374px;
}

.mode-card p {
  margin: 0;
  font-size: var(--aw-text-fine);
  color: var(--aw-ink-muted-48);
  letter-spacing: -0.12px;
}

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
