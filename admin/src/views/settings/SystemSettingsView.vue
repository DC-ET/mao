<template>
  <div class="system-settings">
    <el-card>
      <template #header>
        <div class="card-header">
          <div>
            <div class="card-title">系统设置</div>
            <div class="card-hint">按分类编辑平台配置，开关可直接切换。</div>
          </div>
          <el-button @click="fetchSettings">
            <el-icon><Refresh /></el-icon>
          </el-button>
        </div>
      </template>

      <el-tabs v-model="activeCategory" v-loading="loading">
        <el-tab-pane v-if="integrationRows.length > 0" label="集成配置" name="__integration__">
          <IntegrationConfigPanel :rows="integrationRows" :saving="saving" @saved="fetchSettings" />
        </el-tab-pane>
        <el-tab-pane
          v-for="category in categories"
          :key="category"
          :label="category"
          :name="category"
        >
          <div class="setting-list">
            <div v-for="row in settingsByCategory[category] || []" :key="row.settingKey" class="setting-row">
              <div class="setting-copy">
                <div class="setting-name">{{ row.description || row.settingKey }}</div>
                <code class="setting-key">{{ row.settingKey }}</code>
              </div>
              <div class="setting-control">
                <el-switch
                  v-if="isBooleanSetting(row.settingKey)"
                  :model-value="row.value === 'true'"
                  :disabled="row.editable !== 1"
                  @change="(val: string | number | boolean) => saveBoolean(row, val === true)"
                />
                <el-select
                  v-else-if="row.settingKey === 'weixin.agentId'"
                  :model-value="row.value || ''"
                  :disabled="row.editable !== 1"
                  clearable
                  filterable
                  placeholder="默认 Agent"
                  style="width: 240px"
                  @change="(val: string) => saveSelect(row, val)"
                >
                  <el-option
                    v-for="agent in agents"
                    :key="agent.id"
                    :label="agentLabel(agent)"
                    :value="String(agent.id)"
                  />
                </el-select>
                <el-select
                  v-else-if="isModelSetting(row.settingKey)"
                  :model-value="row.value || ''"
                  :disabled="row.editable !== 1"
                  clearable
                  filterable
                  placeholder="默认模型"
                  style="width: 240px"
                  @change="(val: string) => saveSelect(row, val)"
                >
                  <el-option
                    v-for="model in models"
                    :key="model.id"
                    :label="modelLabel(model)"
                    :value="String(model.id)"
                  />
                </el-select>
                <template v-else>
                  <span class="setting-value">{{ row.isSecret === 1 && row.value ? '******' : (row.value || '未设置') }}</span>
                  <el-button type="primary" link size="small" :disabled="row.editable !== 1" @click="handleEdit(row)">编辑</el-button>
                </template>
              </div>
            </div>
          </div>
        </el-tab-pane>
      </el-tabs>
    </el-card>

    <ResponsiveDialog v-if="dialogVisible" v-model="dialogVisible" title="编辑配置" width="480px">
      <el-form label-width="90px">
        <el-form-item label="说明">
          <el-input :model-value="currentSetting?.description" disabled />
        </el-form-item>
        <el-form-item label="配置值">
          <el-input
            v-model="settingValue"
            :type="currentSetting?.isSecret === 1 ? 'password' : 'text'"
            :placeholder="currentSetting?.isSecret === 1 && currentSetting?.value ? '已设置，留空表示不修改' : ''"
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="saveSetting">保存</el-button>
      </template>
    </ResponsiveDialog>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, onActivated } from 'vue'
import { ElMessage } from 'element-plus'
import { Refresh } from '@element-plus/icons-vue'
import { api } from '../../api'
import ResponsiveDialog from '../../components/ResponsiveDialog.vue'
import IntegrationConfigPanel from './components/IntegrationConfigPanel.vue'

const MODEL_SELECT_KEYS = new Set(['weixin.modelId', 'session.titleModelId', 'git.commitMessageModelId'])
const INTEGRATION_KEYS = new Set([
  'auth.ldap.enabled', 'auth.ldap.url', 'auth.ldap.baseDn', 'auth.ldap.userDn', 'auth.ldap.password', 'auth.ldap.userSearchBase',
  'auth.feishu.enabled', 'auth.feishu.appId', 'auth.feishu.appSecret', 'auth.feishu.redirectUri',
  'upload.storageMode', 'upload.baseUrl', 'file.maxSizeMb',
  'tools.tavilyApiKey',
  'oss.region', 'oss.accessKeyId', 'oss.accessKeySecret', 'oss.bucket',
  'oss.sts.regionId', 'oss.sts.endpoint', 'oss.sts.accessKeyId', 'oss.sts.accessKeySecret',
  'oss.sts.roleArn', 'oss.sts.roleSessionName', 'oss.sts.expire', 'oss.sts.maxSizeMb',
])

const loading = ref(false)
const settings = ref<any[]>([])
const agents = ref<any[]>([])
const models = ref<any[]>([])
const activeCategory = ref('')
const dialogVisible = ref(false)
const currentSetting = ref<any | null>(null)
const settingValue = ref('')
const saving = ref(false)

function isBooleanSetting(key: string | undefined | null) {
  return !!key && key.endsWith('enabled')
}

function isModelSetting(key: string | undefined | null) {
  return !!key && MODEL_SELECT_KEYS.has(key)
}

const integrationRows = computed(() => settings.value.filter((item) => INTEGRATION_KEYS.has(item.settingKey)))

const categories = computed(() => {
  const seen = new Set<string>()
  const list: string[] = []
  for (const item of settings.value) {
    const category = item.category || '未分类'
    if (INTEGRATION_KEYS.has(item.settingKey)) continue
    if (!seen.has(category)) {
      seen.add(category)
      list.push(category)
    }
  }
  return list
})

const settingsByCategory = computed(() => {
  const map: Record<string, any[]> = {}
  for (const item of settings.value) {
    if (INTEGRATION_KEYS.has(item.settingKey)) continue
    const category = item.category || '未分类'
    if (!map[category]) map[category] = []
    map[category].push(item)
  }
  return map
})

async function fetchAgents() {
  try {
    const { data } = await api.get('/agents')
    agents.value = data || []
  } catch {
    agents.value = []
  }
}

async function fetchModels() {
  try {
    const { data } = await api.get('/models/active')
    models.value = data || []
  } catch {
    models.value = []
  }
}

async function fetchSettings() {
  loading.value = true
  try {
    const [{ data }] = await Promise.all([
      api.get('/system-settings'),
      fetchAgents(),
      fetchModels()
    ])
    settings.value = data || []
    const plainCategories = categories.value
    if (!activeCategory.value || (activeCategory.value !== '__integration__' && !plainCategories.includes(activeCategory.value))) {
      activeCategory.value = integrationRows.value.length > 0 ? '__integration__' : (plainCategories[0] || '')
    }
  } finally {
    loading.value = false
  }
}

function agentLabel(agent: any) {
  return agent.isDefault ? `${agent.name}（默认）` : agent.name
}

function modelLabel(model: any) {
  return model.isDefault ? `${model.name}（默认）` : model.name
}

function handleEdit(row: any) {
  currentSetting.value = row
  settingValue.value = row.isSecret === 1 ? '' : (row.value || '')
  dialogVisible.value = true
}

async function persist(row: any, value: string | null) {
  if (row.editable !== 1 || saving.value) return
  saving.value = true
  try {
    await api.put(`/system-settings/${row.settingKey}`, { value })
    await fetchSettings()
    ElMessage.success('配置已更新')
  } finally {
    saving.value = false
  }
}

async function saveBoolean(row: any, enabled: boolean) {
  await persist(row, enabled ? 'true' : 'false')
}

async function saveSelect(row: any, value: string) {
  await persist(row, value || '')
}

async function saveSetting() {
  if (!currentSetting.value) return
  const isSecret = currentSetting.value.isSecret === 1
  // secret 行留空 = 不修改（null 语义）
  const value = isSecret && settingValue.value === '' ? null : settingValue.value
  await persist(currentSetting.value, value)
  dialogVisible.value = false
}

onActivated(async () => {
  await Promise.all([fetchAgents(), fetchModels()])
  await fetchSettings()
})
</script>

<style scoped>
.card-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 12px;
}

.card-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--mao-ink);
}

.card-hint {
  margin-top: 4px;
  font-size: 13px;
  color: var(--mao-muted);
}

.setting-list {
  display: flex;
  flex-direction: column;
}

.setting-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 24px;
  padding: 16px 4px;
  border-bottom: 1px solid var(--mao-border);
}

.setting-row:last-child {
  border-bottom: none;
}

.setting-copy {
  min-width: 0;
}

.setting-name {
  font-size: 14px;
  color: var(--mao-ink);
}

.setting-key {
  display: block;
  margin-top: 4px;
  font-size: 12px;
  color: var(--mao-muted);
}

.setting-control {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.setting-value {
  max-width: 280px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  color: var(--mao-ink);
}

@media (max-width: 768px) {
  .setting-row {
    flex-direction: column;
    align-items: flex-start;
    gap: 10px;
  }

  .setting-control {
    width: 100%;
  }

  .setting-control :deep(.el-select) {
    width: 100% !important;
  }
}
</style>
