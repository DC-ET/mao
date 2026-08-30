<template>
  <div class="feishu-bot-list">
    <el-card>
      <template #header>
        <div class="card-header">
          <div>
            <div class="card-title">飞书机器人</div>
            <div class="card-hint">管理飞书自建应用机器人，并为每个机器人配置独立的 Agent 和模型。</div>
          </div>
          <el-button type="primary" @click="openCreate">
            <el-icon><Plus /></el-icon>
            添加机器人
          </el-button>
        </div>
      </template>

      <el-table v-if="!isMobile" :data="bots" v-loading="loading" stripe>
        <template #empty>
          <el-empty description="暂无飞书机器人" :image-size="60" />
        </template>
        <el-table-column prop="name" label="名称" min-width="140" />
        <el-table-column prop="appId" label="App ID" min-width="180" show-overflow-tooltip />
        <el-table-column label="状态" width="90" align="center">
          <template #default="{ row }">
            <el-tag :type="row.enabled ? 'success' : 'info'" size="small">
              {{ row.enabled ? '启用' : '停用' }}
            </el-tag>
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
            <el-tag :type="row.appSecretConfigured ? 'success' : 'danger'" size="small">
              {{ row.appSecretConfigured ? '已配置' : '未配置' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="210" fixed="right">
          <template #default="{ row }">
            <el-button type="primary" link size="small" @click="openEdit(row)">编辑</el-button>
            <el-button
              :type="row.enabled ? 'warning' : 'success'"
              link
              size="small"
              @click="handleEnabledChange(row)"
            >
              {{ row.enabled ? '停用' : '启用' }}
            </el-button>
            <el-button type="danger" link size="small" @click="handleDelete(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>

      <div v-else class="mobile-card-list" v-loading="loading">
        <el-card v-for="row in bots" :key="row.id" shadow="hover">
          <div class="mobile-card-head">
            <span class="mobile-card-title">{{ row.name }}</span>
            <el-tag :type="row.enabled ? 'success' : 'info'" size="small">
              {{ row.enabled ? '启用' : '停用' }}
            </el-tag>
          </div>
          <div class="mobile-card-row"><span>App ID</span><span>{{ row.appId }}</span></div>
          <div class="mobile-card-row"><span>Agent</span><span>{{ agentName(row.agentId) }}</span></div>
          <div class="mobile-card-row"><span>模型</span><span>{{ modelName(row.modelId) }}</span></div>
          <div class="mobile-card-row"><span>Secret</span><span>{{ row.appSecretConfigured ? '已配置' : '未配置' }}</span></div>
          <div class="mobile-card-actions">
            <el-button type="primary" link @click="openEdit(row)">编辑</el-button>
            <el-button :type="row.enabled ? 'warning' : 'success'" link @click="handleEnabledChange(row)">
              {{ row.enabled ? '停用' : '启用' }}
            </el-button>
            <el-button type="danger" link @click="handleDelete(row)">删除</el-button>
          </div>
        </el-card>
        <el-empty v-if="!loading && bots.length === 0" description="暂无飞书机器人" />
      </div>
    </el-card>

    <ResponsiveDialog v-if="formVisible" v-model="formVisible" :title="isEdit ? '编辑飞书机器人' : '添加飞书机器人'" width="560px">
      <el-form ref="formRef" :model="form" :rules="formRules" label-width="100px">
        <el-form-item label="名称" prop="name">
          <el-input v-model="form.name" maxlength="128" show-word-limit placeholder="例如：研发助手" />
        </el-form-item>
        <el-form-item label="App Key" prop="appKey">
          <el-input v-model="form.appKey" maxlength="64" placeholder="例如：feishu-bot-1" />
          <div class="form-hint">机器人内部唯一标识。</div>
        </el-form-item>
        <el-form-item label="App ID" prop="appId">
          <el-input v-model="form.appId" maxlength="128" placeholder="飞书应用 App ID" />
        </el-form-item>
        <el-form-item label="App Secret" prop="appSecret">
          <el-input v-model="form.appSecret" type="password" show-password maxlength="256" :placeholder="isEdit ? '留空则不修改' : '飞书应用 App Secret'" />
        </el-form-item>
        <el-form-item label="Agent">
          <el-select v-model="form.agentId" clearable filterable placeholder="使用默认 Agent" class="form-select">
            <el-option v-for="agent in agents" :key="agent.id" :label="agentLabel(agent)" :value="agent.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="模型">
          <el-select v-model="form.modelId" clearable filterable placeholder="使用默认模型" class="form-select">
            <el-option v-for="model in textModels" :key="model.id" :label="modelLabel(model)" :value="model.id" />
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
import ResponsiveDialog from '../../components/ResponsiveDialog.vue'

interface FeishuBot {
  id: number
  name: string
  appKey: string
  appId: string
  enabled: number
  agentId?: number | null
  modelId?: number | null
  appSecretConfigured: boolean
}

const { isMobile } = useBreakpoint()
const loading = ref(false)
const submitting = ref(false)
const bots = ref<FeishuBot[]>([])
const agents = ref<any[]>([])
const models = ref<any[]>([])
const formVisible = ref(false)
const isEdit = ref(false)
const editingId = ref<number | null>(null)
const formRef = ref<FormInstance>()

const textModels = computed(() => models.value.filter(model => !model.modelType || model.modelType === 'text'))

const form = reactive({
  name: '',
  appKey: '',
  appId: '',
  appSecret: '',
  agentId: undefined as number | undefined,
  modelId: undefined as number | undefined,
})

const formRules: FormRules = {
  name: [{ required: true, message: '请输入机器人名称', trigger: 'blur' }],
  appKey: [{ required: true, message: '请输入 App Key', trigger: 'blur' }],
  appId: [{ required: true, message: '请输入 App ID', trigger: 'blur' }],
  appSecret: [{
    validator: (_rule, value, callback) => {
      if (!isEdit.value && !value) callback(new Error('请输入 App Secret'))
      else callback()
    },
    trigger: 'blur'
  }]
}

async function loadData() {
  loading.value = true
  try {
    const [{ data: botData }, { data: agentData }, { data: modelData }] = await Promise.all([
      api.get('/admin/feishu-bots'),
      api.get('/agents'),
      api.get('/models/active')
    ])
    bots.value = botData || []
    agents.value = agentData || []
    models.value = modelData || []
  } catch { /* 拦截器已提示失败，吞掉避免误报页面异常 */ } finally {
    loading.value = false
  }
}

function resetForm() {
  Object.assign(form, { name: '', appKey: '', appId: '', appSecret: '', agentId: undefined, modelId: undefined })
}

function openCreate() {
  isEdit.value = false
  editingId.value = null
  resetForm()
  formVisible.value = true
}

function openEdit(bot: FeishuBot) {
  isEdit.value = true
  editingId.value = bot.id
  Object.assign(form, {
    name: bot.name,
    appKey: bot.appKey,
    appId: bot.appId,
    appSecret: '',
    agentId: bot.agentId ?? undefined,
    modelId: bot.modelId ?? undefined,
  })
  formVisible.value = true
}

function agentLabel(agent: any) {
  return agent.isDefault ? `${agent.name}（默认）` : agent.name
}

function modelLabel(model: any) {
  return model.isDefault ? `${model.name}（默认）` : model.name
}

function agentName(agentId: number | null | undefined) {
  if (agentId == null) return '默认 Agent'
  return agents.value.find(agent => agent.id === agentId)?.name || `Agent #${agentId}`
}

function modelName(modelId: number | null | undefined) {
  if (modelId == null) return '默认模型'
  return models.value.find(model => model.id === modelId)?.name || `模型 #${modelId}`
}

async function handleSubmit() {
  const valid = await formRef.value?.validate().catch(() => false)
  if (!valid || submitting.value) return

  const payload: Record<string, unknown> = {
    name: form.name.trim(),
    agentId: form.agentId ?? null,
    modelId: form.modelId ?? null,
  }
  if (isEdit.value) {
    Object.assign(payload, { appKey: form.appKey.trim(), appId: form.appId.trim() })
    if (form.appSecret) payload.appSecret = form.appSecret
  } else {
    Object.assign(payload, { appKey: form.appKey.trim(), appId: form.appId.trim(), appSecret: form.appSecret })
  }

  submitting.value = true
  try {
    if (isEdit.value && editingId.value != null) {
      await api.put(`/admin/feishu-bots/${editingId.value}`, payload)
      ElMessage.success('机器人更新成功')
    } else {
      await api.post('/admin/feishu-bots', payload)
      ElMessage.success('机器人添加成功')
    }
    formVisible.value = false
    await loadData()
  } catch { /* 拦截器已提示失败，吞掉避免误报页面异常 */ } finally {
    submitting.value = false
  }
}

async function handleEnabledChange(bot: FeishuBot) {
  const enable = !bot.enabled
  const action = enable ? '启用' : '停用'
  try {
    await ElMessageBox.confirm(`确定要${action}机器人“${bot.name}”吗？`, '确认', { type: enable ? 'success' : 'warning' })
    await api.post(`/admin/feishu-bots/${bot.id}/${enable ? 'enable' : 'disable'}`)
    ElMessage.success(`${action}成功`)
    await loadData()
  } catch {
    // Cancelled or handled by the API interceptor.
  }
}

async function handleDelete(bot: FeishuBot) {
  try {
    await ElMessageBox.confirm(`确定要删除机器人“${bot.name}”吗？删除后将停止其长连接。`, '确认删除', { type: 'warning' })
    await api.delete(`/admin/feishu-bots/${bot.id}`)
    ElMessage.success('机器人已删除')
    await loadData()
  } catch {
    // Cancelled or handled by the API interceptor.
  }
}

onActivated(loadData)
</script>

<style scoped>
.card-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.card-title { font-size: 15px; font-weight: 600; color: var(--mao-ink); }
.card-hint { margin-top: 4px; font-size: 13px; color: var(--mao-muted); }
.form-hint { margin-top: 4px; font-size: 12px; color: var(--mao-muted); }
.form-select { width: 100%; }
.mobile-card-list { display: flex; flex-direction: column; gap: 12px; }
.mobile-card-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }
.mobile-card-title { font-size: 15px; font-weight: 600; color: var(--mao-ink); }
.mobile-card-row { display: flex; justify-content: space-between; gap: 16px; padding: 5px 0; font-size: 13px; }
.mobile-card-row span:first-child { color: var(--mao-muted); flex-shrink: 0; }
.mobile-card-row span:last-child { overflow: hidden; text-align: right; text-overflow: ellipsis; white-space: nowrap; }
.mobile-card-actions { display: flex; gap: 8px; margin-top: 8px; }
</style>
