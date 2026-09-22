<template>
  <el-drawer
    :model-value="visible"
    :title="drawerTitle"
    size="70%"
    destroy-on-close
    @update:model-value="$emit('update:visible', $event)"
    @open="handleOpen"
  >
    <div v-if="user" class="user-detail">
      <el-descriptions :column="3" size="small" border class="user-summary">
        <el-descriptions-item label="用户名">{{ user.username }}</el-descriptions-item>
        <el-descriptions-item label="显示名称">{{ user.displayName || '-' }}</el-descriptions-item>
        <el-descriptions-item label="邮箱">{{ user.email || '-' }}</el-descriptions-item>
        <el-descriptions-item label="角色">
          <el-tag v-for="name in user.roleNames || []" :key="name" size="small" class="role-tag">{{ name }}</el-tag>
          <span v-if="!user.roleNames?.length">-</span>
        </el-descriptions-item>
        <el-descriptions-item label="状态">
          <el-tag :type="user.status === 1 ? 'success' : 'danger'" size="small">
            {{ user.status === 1 ? '启用' : '禁用' }}
          </el-tag>
        </el-descriptions-item>
        <el-descriptions-item label="最后登录">{{ formatDateTime(user.lastLoginAt) || '-' }}</el-descriptions-item>
      </el-descriptions>

      <el-tabs v-model="activeTab" class="detail-tabs">
        <!-- 会话 -->
        <el-tab-pane label="会话" name="sessions">
          <el-table :data="sessions" v-loading="loadingTabs['sessions']" size="small" stripe>
            <template #empty><el-empty description="暂无会话" :image-size="48" /></template>
            <el-table-column prop="id" label="ID" width="64" />
            <el-table-column prop="title" label="标题" min-width="180" show-overflow-tooltip />
            <el-table-column prop="agentName" label="Agent" width="110" show-overflow-tooltip />
            <el-table-column prop="phase" label="阶段" width="100">
              <template #default="{ row }">
                <el-tag :type="phaseTagType(row.phase)" size="small">{{ phaseLabel(row.phase) }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="createdAt" label="创建时间" width="160" :formatter="formatDateTimeColumn" />
            <el-table-column label="操作" width="80" fixed="right">
              <template #default="{ row }">
                <el-button type="primary" link size="small" @click="goSession(row)">查看</el-button>
              </template>
            </el-table-column>
          </el-table>
          <div class="tab-footer">
            <el-pagination
              v-model:current-page="sessionsPage"
              layout="prev, pager, next, total"
              :total="sessionsTotal"
              :page-size="TAB_PAGE_SIZE"
              @current-change="loadSessions"
            />
          </div>
        </el-tab-pane>

        <!-- 定时任务 -->
        <el-tab-pane label="定时任务" name="tasks">
          <el-table :data="tasks" v-loading="loadingTabs['tasks']" size="small" stripe>
            <template #empty><el-empty description="暂无定时任务" :image-size="48" /></template>
            <el-table-column prop="id" label="ID" width="64" />
            <el-table-column prop="name" label="任务名称" min-width="150" show-overflow-tooltip />
            <el-table-column prop="cronExpression" label="Cron" width="130" show-overflow-tooltip />
            <el-table-column prop="status" label="状态" width="80">
              <template #default="{ row }">
                <el-tag :type="row.status === 'ACTIVE' ? 'success' : 'info'" size="small">
                  {{ row.status === 'ACTIVE' ? '启用' : '暂停' }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="lastExecutionStatus" label="上次执行" width="90">
              <template #default="{ row }">
                <span v-if="row.lastExecutionStatus">{{ execStatusLabel(row.lastExecutionStatus) }}</span>
                <span v-else class="text-muted">-</span>
              </template>
            </el-table-column>
            <el-table-column prop="nextFireTime" label="下次触发" width="160" :formatter="formatDateTimeColumn" />
          </el-table>
          <div class="tab-footer">
            <el-pagination
              v-model:current-page="tasksPage"
              layout="prev, pager, next, total"
              :total="tasksTotal"
              :page-size="TAB_PAGE_SIZE"
              @current-change="loadTasks"
            />
          </div>
        </el-tab-pane>

        <!-- 快捷指令 -->
        <el-tab-pane label="快捷指令" name="commands">
          <el-table :data="commands" v-loading="loadingTabs['commands']" size="small" stripe>
            <template #empty><el-empty description="暂无快捷指令" :image-size="48" /></template>
            <el-table-column prop="id" label="ID" width="64" />
            <el-table-column prop="name" label="名称" width="160" show-overflow-tooltip />
            <el-table-column prop="content" label="内容" min-width="240" show-overflow-tooltip />
            <el-table-column prop="createdAt" label="创建时间" width="160" :formatter="formatDateTimeColumn" />
          </el-table>
        </el-tab-pane>

        <!-- 个人技能 -->
        <el-tab-pane label="个人技能" name="skills">
          <el-table :data="skills" v-loading="loadingTabs['skills']" size="small" stripe>
            <template #empty><el-empty description="暂无个人技能" :image-size="48" /></template>
            <el-table-column prop="name" label="名称" width="180" show-overflow-tooltip />
            <el-table-column prop="description" label="描述" min-width="240" show-overflow-tooltip>
              <template #default="{ row }">{{ row.description || '-' }}</template>
            </el-table-column>
            <el-table-column prop="folderPath" label="目录" min-width="160" show-overflow-tooltip />
          </el-table>
        </el-tab-pane>

        <!-- Git 凭证 -->
        <el-tab-pane label="Git 凭证" name="git">
          <el-table :data="gitCredentials" v-loading="loadingTabs['git']" size="small" stripe>
            <template #empty><el-empty description="暂无 Git 凭证" :image-size="48" /></template>
            <el-table-column prop="id" label="ID" width="64" />
            <el-table-column prop="domain" label="域名" width="180" />
            <!-- 后端 toVO 恒返回 '****'，展示原值没有信息量：改为配置状态标签并让出宽度给备注 -->
            <el-table-column label="Token" width="90">
              <template #default="{ row }">
                <el-tag :type="row.accessToken ? 'success' : 'info'" size="small">
                  {{ row.accessToken ? '已配置' : '未配置' }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="description" label="备注" min-width="160" show-overflow-tooltip>
              <template #default="{ row }">{{ row.description || '-' }}</template>
            </el-table-column>
            <el-table-column prop="updatedAt" label="更新时间" width="160" :formatter="formatDateTimeColumn" />
            <el-table-column v-if="canWrite" label="操作" width="80" fixed="right">
              <template #default="{ row }">
                <el-button type="danger" link size="small" @click="handleDeleteGitCredential(row)">删除</el-button>
              </template>
            </el-table-column>
          </el-table>
        </el-tab-pane>

        <!-- MCP 服务器 -->
        <el-tab-pane label="MCP 服务器" name="mcp">
          <el-table :data="mcpServers" v-loading="loadingTabs['mcp']" size="small" stripe>
            <template #empty><el-empty description="暂无个人 MCP 服务器" :image-size="48" /></template>
            <el-table-column prop="id" label="ID" width="64" />
            <el-table-column prop="name" label="名称" width="160" show-overflow-tooltip />
            <el-table-column prop="serverType" label="类型" width="90" />
            <el-table-column prop="command" label="命令 / URL" min-width="220" show-overflow-tooltip>
              <template #default="{ row }">{{ row.command || row.url || '-' }}</template>
            </el-table-column>
            <el-table-column prop="status" label="状态" width="90">
              <template #default="{ row }">
                <el-tag :type="row.status === 'ENABLED' ? 'success' : 'info'" size="small">
                  {{ row.status === 'ENABLED' ? '启用' : '停用' }}
                </el-tag>
              </template>
            </el-table-column>
          </el-table>
        </el-tab-pane>
      </el-tabs>
    </div>
  </el-drawer>
</template>

<script setup lang="ts">
import { ref, reactive, computed } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { api } from '../../api'
import { formatDateTime, formatDateTimeColumn } from '../../utils/datetime'
// 复用全站统一的阶段文案（含 IDLE / WAITING_APPROVAL），勿在本页自造映射
import { phaseLabel } from '../../utils/labels'
import { useAuthStore } from '../../stores/auth'

interface UserRow {
  id: number
  username: string
  displayName?: string | null
  email?: string | null
  status?: number
  roleNames?: string[]
  lastLoginAt?: string | null
}

const props = defineProps<{
  visible: boolean
  user: UserRow | null
}>()

defineEmits<{
  (e: 'update:visible', value: boolean): void
}>()

const TAB_PAGE_SIZE = 10

const authStore = useAuthStore()
const router = useRouter()

const activeTab = ref('sessions')
// 六个 Tab 的数据是并行加载的，加载态必须按 Tab 独立记录：
// 早期用单个字符串 ref，后发起的请求会覆盖先发起的，最先返回的又把它清空，
// 结果默认展示的「会话」Tab 几乎从不显示骨架，其余在途 Tab 也提前失去 spinner。
const loadingTabs = reactive<Record<string, boolean>>({})
const canWrite = computed(() => authStore.hasPermission('user:write'))

const drawerTitle = computed(() =>
  props.user ? `用户详情 - ${props.user.displayName || props.user.username}` : '用户详情'
)

const sessions = ref<any[]>([])
const sessionsPage = ref(1)
const sessionsTotal = ref(0)

const tasks = ref<any[]>([])
const tasksPage = ref(1)
const tasksTotal = ref(0)

const commands = ref<any[]>([])
const skills = ref<any[]>([])
const gitCredentials = ref<any[]>([])
const mcpServers = ref<any[]>([])

function phaseTagType(phase: string): 'primary' | 'success' | 'danger' | 'warning' | 'info' {
  switch (phase) {
    case 'RUNNING': return 'primary'
    case 'RESUMING': return 'primary'
    case 'WAITING_APPROVAL': return 'warning'
    case 'COMPLETED': return 'success'
    case 'FAILED': return 'danger'
    case 'CANCELLED': return 'warning'
    default: return 'info'
  }
}

function execStatusLabel(status: string): string {
  const labels: Record<string, string> = {
    COMPLETED: '成功', FAILED: '失败', SKIPPED: '跳过', QUEUED: '排队中'
  }
  return labels[status] || status
}

function handleOpen() {
  activeTab.value = 'sessions'
  sessionsPage.value = 1
  tasksPage.value = 1
  void loadSessions()
  void loadTasks()
  void loadCommands()
  void loadSkills()
  void loadGitCredentials()
  void loadMcpServers()
}

async function loadSessions() {
  if (!props.user) return
  loadingTabs['sessions'] = true
  try {
    const { data } = await api.get('/admin/sessions', {
      params: { userId: props.user.id, page: sessionsPage.value, size: TAB_PAGE_SIZE }
    })
    sessions.value = data?.records || []
    sessionsTotal.value = data?.total || 0
  } catch { /* 拦截器已提示失败 */ } finally {
    loadingTabs['sessions'] = false
  }
}

async function loadTasks() {
  if (!props.user) return
  loadingTabs['tasks'] = true
  try {
    const { data } = await api.get('/scheduled-tasks/all', {
      params: { userId: props.user.id, pageNum: tasksPage.value, pageSize: TAB_PAGE_SIZE }
    })
    tasks.value = data?.records || []
    tasksTotal.value = data?.total || 0
  } catch { /* 拦截器已提示失败 */ } finally {
    loadingTabs['tasks'] = false
  }
}

async function loadCommands() {
  if (!props.user) return
  loadingTabs['commands'] = true
  try {
    const { data } = await api.get('/admin/user-commands', { params: { userId: props.user.id } })
    commands.value = data || []
  } catch { /* 拦截器已提示失败 */ } finally {
    loadingTabs['commands'] = false
  }
}

async function loadSkills() {
  if (!props.user) return
  loadingTabs['skills'] = true
  try {
    const { data } = await api.get('/admin/user-skills', { params: { userId: props.user.id } })
    skills.value = data || []
  } catch { /* 拦截器已提示失败 */ } finally {
    loadingTabs['skills'] = false
  }
}

async function loadGitCredentials() {
  if (!props.user) return
  loadingTabs['git'] = true
  try {
    const { data } = await api.get(`/admin/users/${props.user.id}/git-credentials`)
    gitCredentials.value = data || []
  } catch { /* 拦截器已提示失败 */ } finally {
    loadingTabs['git'] = false
  }
}

async function loadMcpServers() {
  if (!props.user) return
  loadingTabs['mcp'] = true
  try {
    const { data } = await api.get(`/admin/users/${props.user.id}/mcp-servers`)
    mcpServers.value = data || []
  } catch { /* 拦截器已提示失败 */ } finally {
    loadingTabs['mcp'] = false
  }
}

async function handleDeleteGitCredential(row: any) {
  if (!props.user) return
  try {
    await ElMessageBox.confirm(
      `确定删除用户「${props.user.displayName || props.user.username}」的 ${row.domain} 凭证吗？`,
      '删除 Git 凭证',
      { confirmButtonText: '确认删除', cancelButtonText: '取消', type: 'warning' }
    )
  } catch {
    return
  }
  try {
    await api.delete(`/admin/users/${props.user.id}/git-credentials/${row.id}`)
    ElMessage.success('已删除')
    loadGitCredentials()
  } catch { /* 拦截器已提示失败 */ }
}

function goSession(row: any) {
  router.push(`/sessions/${row.id}`)
}
</script>

<style scoped>
.user-summary {
  margin-bottom: 16px;
}

.role-tag {
  margin-right: 4px;
}

.text-muted {
  color: var(--mao-muted);
}

.tab-footer {
  margin-top: 12px;
  display: flex;
  justify-content: flex-end;
}
</style>
