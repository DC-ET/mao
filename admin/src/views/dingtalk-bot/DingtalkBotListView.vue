<template>
  <div class="dingtalk-bot-list">
    <el-card>
      <template #header>
        <div class="card-header">
          <div>
            <div class="card-title">钉钉机器人</div>
            <div class="card-hint">管理企业内部应用机器人。每个机器人独立 Agent / 模型，Stream 随启停热生效。</div>
          </div>
          <el-button v-if="canWrite" type="primary" @click="openCreate">
            <el-icon><Plus /></el-icon>
            添加机器人
          </el-button>
        </div>
      </template>

      <el-table v-if="!isMobile" :data="bots" v-loading="loading" stripe>
        <template #empty>
          <el-empty description="暂无钉钉机器人" :image-size="60" />
        </template>
        <el-table-column prop="name" label="名称" min-width="140" />
        <el-table-column prop="clientId" label="Client ID" min-width="180" show-overflow-tooltip />
        <el-table-column prop="robotCode" label="Robot Code" min-width="160" show-overflow-tooltip />
        <el-table-column label="状态" width="90" align="center">
          <template #default="{ row }">
            <el-tag :type="row.enabled ? 'success' : 'info'" size="small">{{ row.enabled ? '启用' : '停用' }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="Agent" min-width="140" show-overflow-tooltip>
          <template #default="{ row }">{{ agentName(row.agentId) }}</template>
        </el-table-column>
        <el-table-column label="模型" min-width="140" show-overflow-tooltip>
          <template #default="{ row }">{{ modelName(row.modelId) }}</template>
        </el-table-column>
        <el-table-column label="Secret" width="100" align="center">
          <template #default="{ row }">
            <el-tag :type="row.clientSecretConfigured ? 'success' : 'danger'" size="small">
              {{ row.clientSecretConfigured ? '已配置' : '未配置' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="连接状态" width="110" align="center">
          <template #default="{ row }">
            <el-tooltip :disabled="!runtimeStatusMap[row.id]?.lastFailureReason" :content="runtimeStatusMap[row.id]?.lastFailureReason || ''" placement="top">
              <el-tag :type="runtimeTagType(runtimeStatusMap[row.id]?.status)" size="small">
                {{ runtimeStatusLabel(runtimeStatusMap[row.id]?.status) }}
              </el-tag>
            </el-tooltip>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="260" fixed="right">
          <template #default="{ row }">
            <template v-if="canWrite">
              <el-button type="primary" link size="small" @click="openEdit(row)">编辑</el-button>
              <el-button :type="row.enabled ? 'warning' : 'success'" link size="small" @click="handleEnabledChange(row)">
                {{ row.enabled ? '停用' : '启用' }}
              </el-button>
              <el-button link size="small" :disabled="!row.enabled" @click="handleReconnect(row)">重连</el-button>
              <el-button type="danger" link size="small" @click="handleDelete(row)">删除</el-button>
            </template>
            <span v-else class="op-muted">—</span>
          </template>
        </el-table-column>
      </el-table>

      <div v-else class="mobile-card-list" v-loading="loading">
        <el-card v-for="row in bots" :key="row.id" shadow="hover">
          <div class="mobile-card-head">
            <span class="mobile-card-title">{{ row.name }}</span>
            <el-tag :type="row.enabled ? 'success' : 'info'" size="small">{{ row.enabled ? '启用' : '停用' }}</el-tag>
          </div>
          <div class="mobile-card-row"><span>Client ID</span><span>{{ row.clientId }}</span></div>
          <div class="mobile-card-row"><span>Robot Code</span><span>{{ row.robotCode }}</span></div>
          <div class="mobile-card-row"><span>连接</span><span>{{ runtimeStatusLabel(runtimeStatusMap[row.id]?.status) }}</span></div>
          <div class="mobile-card-actions" v-if="canWrite">
            <el-button type="primary" link @click="openEdit(row)">编辑</el-button>
            <el-button link :disabled="!row.enabled" @click="handleReconnect(row)">重连</el-button>
            <el-button type="danger" link @click="handleDelete(row)">删除</el-button>
          </div>
        </el-card>
        <el-empty v-if="!loading && bots.length === 0" description="暂无钉钉机器人" />
      </div>
    </el-card>

    <ResponsiveDialog v-if="formVisible" v-model="formVisible" :title="isEdit ? '编辑钉钉机器人' : '添加钉钉机器人'" width="560px">
      <el-form ref="formRef" :model="form" :rules="formRules" label-width="120px">
        <el-form-item label="名称" prop="name">
          <el-input v-model="form.name" maxlength="128" placeholder="例如：研发助手" />
        </el-form-item>
        <el-form-item label="App Key" prop="appKey">
          <el-input v-model="form.appKey" maxlength="64" :disabled="isEdit" placeholder="内部唯一标识" />
        </el-form-item>
        <el-form-item label="Client ID" prop="clientId">
          <el-input v-model="form.clientId" maxlength="128" placeholder="应用 Client ID / AppKey" />
        </el-form-item>
        <el-form-item label="Client Secret" prop="clientSecret">
          <el-input v-model="form.clientSecret" type="password" show-password maxlength="256" :placeholder="isEdit ? '留空则不修改' : '应用 Client Secret'" />
        </el-form-item>
        <el-form-item label="Robot Code" prop="robotCode">
          <el-input v-model="form.robotCode" maxlength="128" placeholder="发送与下载使用，不假定等于 Client ID" />
        </el-form-item>
        <el-form-item label="进度卡模板">
          <el-input v-model="form.progressCardTemplateId" maxlength="128" placeholder="留空则用环境变量" />
        </el-form-item>
        <el-form-item label="排队卡模板">
          <el-input v-model="form.queueCardTemplateId" maxlength="128" placeholder="留空则用环境变量" />
        </el-form-item>
        <el-form-item label="Agent">
          <el-select v-model="form.agentId" clearable filterable placeholder="使用默认 Agent" class="form-select">
            <el-option v-for="agent in agents" :key="agent.id" :label="agentLabel(agent)" :value="agent.id" :disabled="agent.enabled === false" />
          </el-select>
        </el-form-item>
        <el-form-item label="模型">
          <el-select v-model="form.modelId" clearable filterable placeholder="使用默认模型" class="form-select">
            <el-option v-for="model in textModels" :key="model.id" :label="model.isDefault ? `${model.name}（默认）` : model.name" :value="model.id" />
          </el-select>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="formVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="handleSubmit">保存</el-button>
      </template>
    </ResponsiveDialog>
  </div>
</template>

<script setup lang="ts">
import { computed, onActivated, reactive, ref } from 'vue'
import type { FormInstance, FormRules } from 'element-plus'
import { ElMessage, ElMessageBox } from 'element-plus'
import { api } from '../../api'
import { useBreakpoint } from '../../composables/useBreakpoint'
import { useAuthStore } from '../../stores/auth'
import ResponsiveDialog from '../../components/ResponsiveDialog.vue'

interface DingtalkBot {
  id: number
  name: string
  appKey: string
  clientId: string
  robotCode: string
  enabled: number
  agentId?: number | null
  modelId?: number | null
  progressCardTemplateId?: string | null
  queueCardTemplateId?: string | null
  clientSecretConfigured: boolean
}

const { isMobile } = useBreakpoint()
const authStore = useAuthStore()
const canWrite = computed(() => authStore.hasPermission('dingtalk-bot:write'))
const loading = ref(false)
const submitting = ref(false)
const bots = ref<DingtalkBot[]>([])
const runtimeStatusMap = ref<Record<number, { status?: string; lastFailureReason?: string }>>({})
const agents = ref<any[]>([])
const models = ref<any[]>([])
const formVisible = ref(false)
const isEdit = ref(false)
const editingId = ref<number | null>(null)
const formRef = ref<FormInstance>()
const textModels = computed(() => models.value.filter(model => !model.modelType || model.modelType === 'text'))
const form = reactive({
  name: '', appKey: '', clientId: '', clientSecret: '', robotCode: '',
  progressCardTemplateId: '', queueCardTemplateId: '',
  agentId: undefined as number | undefined, modelId: undefined as number | undefined,
})
const formRules: FormRules = {
  name: [{ required: true, message: '请输入名称', trigger: 'blur' }],
  appKey: [{ required: true, message: '请输入 App Key', trigger: 'blur' }],
  clientId: [{ required: true, message: '请输入 Client ID', trigger: 'blur' }],
  robotCode: [{ required: true, message: '请输入 Robot Code', trigger: 'blur' }],
  clientSecret: [{
    validator: (_rule, value, callback) => {
      if (!isEdit.value && !value) callback(new Error('请输入 Client Secret'))
      else callback()
    },
    trigger: 'blur',
  }],
}

async function loadData() {
  loading.value = true
  try {
    const [{ data: botData }, { data: agentData }, { data: modelData }] = await Promise.all([
      api.get('/admin/dingtalk-bots'),
      api.get('/agents', { params: { includeDisabled: true } }),
      api.get('/models/active'),
    ])
    bots.value = botData || []
    agents.value = agentData || []
    models.value = modelData || []
  } catch { /* 拦截器已提示 */ } finally {
    loading.value = false
  }
}

async function loadRuntimeStatus() {
  try {
    const { data } = await api.get('/admin/dingtalk-bots/status')
    const next: Record<number, { status?: string; lastFailureReason?: string }> = {}
    for (const item of data || []) next[item.botId] = item
    runtimeStatusMap.value = next
  } catch { /* 状态失败不挡列表 */ }
}

function runtimeTagType(status?: string): 'success' | 'warning' | 'danger' | 'info' {
  if (status === 'ready') return 'success'
  if (status === 'reconnecting') return 'warning'
  if (status === 'failed') return 'danger'
  return 'info'
}

function runtimeStatusLabel(status?: string) {
  if (status === 'ready') return '已连接'
  if (status === 'reconnecting') return '重连中'
  if (status === 'failed') return '连接失败'
  if (status === 'disabled') return '未运行'
  return '-'
}

function agentLabel(agent: any) {
  const name = agent.isDefault ? `${agent.name}（默认）` : agent.name
  return agent.enabled === false ? `${name}（已停用）` : name
}
function agentName(agentId: number | null | undefined) {
  if (agentId == null) return '默认 Agent'
  const agent = agents.value.find(item => item.id === agentId)
  return agent ? (agent.enabled === false ? `${agent.name}（已停用）` : agent.name) : `Agent #${agentId}`
}
function modelName(modelId: number | null | undefined) {
  if (modelId == null) return '默认模型'
  return models.value.find(model => model.id === modelId)?.name || `模型 #${modelId}`
}

function openCreate() {
  isEdit.value = false
  editingId.value = null
  Object.assign(form, { name: '', appKey: '', clientId: '', clientSecret: '', robotCode: '', progressCardTemplateId: '', queueCardTemplateId: '', agentId: undefined, modelId: undefined })
  formVisible.value = true
}

function openEdit(bot: DingtalkBot) {
  isEdit.value = true
  editingId.value = bot.id
  Object.assign(form, {
    name: bot.name, appKey: bot.appKey, clientId: bot.clientId, clientSecret: '', robotCode: bot.robotCode,
    progressCardTemplateId: bot.progressCardTemplateId ?? '', queueCardTemplateId: bot.queueCardTemplateId ?? '',
    agentId: bot.agentId ?? undefined, modelId: bot.modelId ?? undefined,
  })
  formVisible.value = true
}

async function handleSubmit() {
  const valid = await formRef.value?.validate().catch(() => false)
  if (!valid || submitting.value) return
  const payload: Record<string, unknown> = {
    name: form.name.trim(),
    clientId: form.clientId.trim(),
    robotCode: form.robotCode.trim(),
    agentId: form.agentId ?? null,
    modelId: form.modelId ?? null,
    progressCardTemplateId: form.progressCardTemplateId.trim(),
    queueCardTemplateId: form.queueCardTemplateId.trim(),
  }
  if (!isEdit.value) {
    payload.appKey = form.appKey.trim()
    payload.clientSecret = form.clientSecret
  } else {
    payload.appKey = form.appKey.trim()
    if (form.clientSecret) payload.clientSecret = form.clientSecret
  }
  submitting.value = true
  try {
    if (isEdit.value && editingId.value != null) await api.put(`/admin/dingtalk-bots/${editingId.value}`, payload)
    else await api.post('/admin/dingtalk-bots', payload)
    ElMessage.success(isEdit.value ? '机器人更新成功' : '机器人添加成功')
    formVisible.value = false
    await loadData()
  } catch { /* 拦截器已提示 */ } finally {
    submitting.value = false
  }
}

async function handleEnabledChange(bot: DingtalkBot) {
  const enable = !bot.enabled
  try {
    await ElMessageBox.confirm(`确定要${enable ? '启用' : '停用'}机器人“${bot.name}”吗？`, '确认', { type: enable ? 'success' : 'warning' })
    await api.post(`/admin/dingtalk-bots/${bot.id}/${enable ? 'enable' : 'disable'}`)
    ElMessage.success(`${enable ? '启用' : '停用'}成功`)
    await loadData()
  } catch { /* 取消或拦截器 */ }
}

async function handleReconnect(bot: DingtalkBot) {
  try {
    await api.post(`/admin/dingtalk-bots/${bot.id}/reconnect`)
    ElMessage.success('已触发重连')
    await loadRuntimeStatus()
  } catch { /* 拦截器已提示 */ }
}

async function handleDelete(bot: DingtalkBot) {
  try {
    await ElMessageBox.confirm(`确定要删除机器人“${bot.name}”吗？删除后将停止其 Stream 连接。`, '确认删除', { type: 'warning' })
    await api.delete(`/admin/dingtalk-bots/${bot.id}`)
    ElMessage.success('机器人已删除')
    await loadData()
  } catch { /* 取消或拦截器 */ }
}

onActivated(() => {
  loadData()
  loadRuntimeStatus()
})
</script>

<style scoped>
.card-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.card-title { font-size: 15px; font-weight: 600; color: var(--mao-ink); }
.card-hint { margin-top: 4px; font-size: 13px; color: var(--mao-muted); }
.form-select { width: 100%; }
.mobile-card-list { display: flex; flex-direction: column; gap: 12px; }
.mobile-card-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }
.mobile-card-title { font-size: 15px; font-weight: 600; }
.mobile-card-row { display: flex; justify-content: space-between; gap: 16px; padding: 5px 0; font-size: 13px; }
.mobile-card-actions { display: flex; gap: 8px; margin-top: 8px; }
.op-muted { color: var(--mao-muted); }
</style>
