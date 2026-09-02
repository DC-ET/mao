<template>
  <div class="system-settings">
    <el-card>
      <template #header>
        <div class="card-header">
          <div>
            <div class="card-title">系统设置</div>
            <div class="card-hint">按分类编辑平台配置，点击左侧目录可快速跳转。</div>
          </div>
          <el-button @click="fetchSettings">
            <el-icon><Refresh /></el-icon>
          </el-button>
        </div>
      </template>

      <div v-loading="loading" class="settings-layout">
        <aside class="toc">
          <div class="toc-title">目录</div>
          <div class="toc-list">
            <div
              v-for="item in toc"
              :key="item.id"
              class="toc-item"
              :class="{ active: activeSection === item.id }"
              @click="scrollToSection(item.id)"
            >
              {{ item.label }}
            </div>
          </div>
        </aside>

        <div class="settings-content">
          <IntegrationConfigPanel
            v-if="integrationRows.length > 0"
            :rows="integrationRows"
            :saving="saving"
            :can-write="canWrite"
            @saved="fetchSettings"
          />
          <section
            v-for="category in categories"
            :key="category"
            :id="`setting-cat-${category}`"
            class="setting-section"
          >
            <h3 class="section-title">{{ category }}</h3>
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
                    :disabled="row.editable !== 1 || !canWrite"
                    @change="(val: string | number | boolean) => saveBoolean(row, val === true)"
                  />
                  <el-select
                    v-else-if="row.settingKey === 'weixin.agentId'"
                    :model-value="row.value || ''"
                    :disabled="row.editable !== 1 || !canWrite"
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
                    :disabled="row.editable !== 1 || !canWrite"
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
                    <el-button type="primary" link size="small" :disabled="row.editable !== 1 || !canWrite" @click="handleEdit(row)">编辑</el-button>
                  </template>
                </div>
              </div>
            </div>
          </section>
        </div>
      </div>
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
import { computed, ref, nextTick, onBeforeUnmount, onActivated } from 'vue'
import { ElMessage } from 'element-plus'
import { Refresh } from '@element-plus/icons-vue'
import { api } from '../../api'
import { useAuthStore } from '../../stores/auth'
import ResponsiveDialog from '../../components/ResponsiveDialog.vue'
import IntegrationConfigPanel from './components/IntegrationConfigPanel.vue'

const authStore = useAuthStore()
/** 后端 PUT /system-settings/:key 需 settings:write，无权限时禁用全部写控件 */
const canWrite = computed(() => authStore.hasPermission('settings:write'))

const MODEL_SELECT_KEYS = new Set(['weixin.modelId', 'session.titleModelId', 'git.commitMessageModelId'])
const INTEGRATION_KEYS = new Set([
  'auth.ldap.enabled', 'auth.ldap.url', 'auth.ldap.baseDn', 'auth.ldap.userDn', 'auth.ldap.password', 'auth.ldap.userSearchBase',
  'auth.feishu.enabled', 'auth.feishu.appId', 'auth.feishu.appSecret', 'auth.feishu.redirectUri',
  'upload.storageMode', 'upload.baseUrl', 'file.maxSizeMb',
  'tools.webSearchProvider', 'tools.tavilyApiKey', 'tools.tinyfishApiKey',
  'oss.region', 'oss.accessKeyId', 'oss.accessKeySecret', 'oss.bucket',
  'oss.sts.regionId', 'oss.sts.endpoint', 'oss.sts.accessKeyId', 'oss.sts.accessKeySecret',
  'oss.sts.roleArn', 'oss.sts.roleSessionName', 'oss.sts.expire', 'oss.sts.maxSizeMb',
  'agent.threadPoolSize', 'agent.threadPoolMax', 'agent.threadPoolQueue', 'ws.idleTimeoutMs',
  'notify.workerDelayMs', 'notify.batchSize', 'notify.maxAttempts',
])

/** 集成配置目录条目：锚点 id 与 IntegrationConfigPanel 内 group-card 的 id 保持一致。 */
const INTEGRATION_TOC = [
  { id: 'setting-group-ldap', label: 'LDAP 认证' },
  { id: 'setting-group-feishu', label: '飞书 OAuth 登录' },
  { id: 'setting-group-upload', label: '上传配置' },
  { id: 'setting-group-oss', label: 'OSS 对象存储' },
  { id: 'setting-group-tools', label: '网络工具' },
  { id: 'setting-group-agent', label: 'Agent 运行' },
  { id: 'setting-group-notify', label: '任务通知' },
]

const loading = ref(false)
const settings = ref<any[]>([])
const agents = ref<any[]>([])
const models = ref<any[]>([])
const dialogVisible = ref(false)
const currentSetting = ref<any | null>(null)
const settingValue = ref('')
const saving = ref(false)
const activeSection = ref('')

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

/** 目录索引：集成配置在前，普通分类在后。 */
const toc = computed(() => {
  const list: Array<{ id: string; label: string }> = []
  if (integrationRows.value.length > 0) list.push(...INTEGRATION_TOC)
  for (const category of categories.value) {
    list.push({ id: `setting-cat-${category}`, label: category })
  }
  return list
})

function scrollToSection(id: string) {
  activeSection.value = id
  const el = document.getElementById(id)
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

let observer: IntersectionObserver | null = null

/** 监听各分组锚点进入可视区，高亮当前所在分组。 */
function setupObserver() {
  observer?.disconnect()
  const els = toc.value
    .map((item) => document.getElementById(item.id))
    .filter((el): el is HTMLElement => el != null)
  if (els.length === 0) return
  observer = new IntersectionObserver(
    (entries) => {
      const visible = entries
        .filter((e) => e.isIntersecting)
        .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)
      if (visible.length > 0) {
        activeSection.value = (visible[0].target as HTMLElement).id
      }
    },
    { rootMargin: '-15% 0px -75% 0px', threshold: 0 }
  )
  for (const el of els) observer.observe(el)
}

onBeforeUnmount(() => {
  observer?.disconnect()
  observer = null
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
    await nextTick(setupObserver)
  } catch { /* 拦截器已提示失败，吞掉避免误报页面异常 */ } finally {
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

async function persist(row: any, value: string | null): Promise<boolean> {
  if (row.editable !== 1 || saving.value) return false
  saving.value = true
  try {
    await api.put(`/system-settings/${row.settingKey}`, { value })
    await fetchSettings()
    ElMessage.success('配置已更新')
    return true
  } catch { /* 拦截器已提示失败，吞掉避免误报页面异常 */ return false } finally {
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
  const ok = await persist(currentSetting.value, value)
  if (ok) dialogVisible.value = false
}

onActivated(() => {
  void fetchSettings()
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

.settings-layout {
  display: flex;
  align-items: flex-start;
  gap: 24px;
}

.toc {
  position: sticky;
  top: 12px;
  flex-shrink: 0;
  width: 168px;
  max-height: calc(100vh - 200px);
  overflow-y: auto;
}

.toc-title {
  font-size: 12px;
  color: var(--mao-muted);
  margin-bottom: 8px;
  letter-spacing: 0.5px;
}

.toc-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  border-left: 1px solid var(--mao-border);
  padding-left: 12px;
}

.toc-item {
  padding: 6px 8px;
  border-radius: 6px;
  font-size: 13px;
  color: var(--mao-muted);
  cursor: pointer;
  line-height: 1.4;
  transition: color 0.15s, background 0.15s;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.toc-item:hover {
  color: var(--mao-ink);
  background: var(--mao-accent-bg);
}

.toc-item.active {
  color: var(--mao-accent);
  background: var(--mao-accent-bg);
  font-weight: 600;
}

.settings-content {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 24px;
}

.setting-section {
  scroll-margin-top: 12px;
}

.section-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--mao-ink);
  margin: 0 0 4px;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--mao-border);
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
  .settings-layout {
    flex-direction: column;
    gap: 16px;
  }

  .toc {
    position: static;
    width: 100%;
    max-height: none;
  }

  .toc-list {
    flex-direction: row;
    flex-wrap: wrap;
    border-left: none;
    padding-left: 0;
    gap: 6px;
  }

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
