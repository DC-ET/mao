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
            :can-write="canWrite"
            @saved="fetchSettings"
          />
          <section
            v-for="category in categories"
            :key="category"
            :id="`setting-cat-${category}`"
            class="setting-section"
          >
            <el-card class="group-card" shadow="never">
              <template #header>
                <div class="group-header">
                  <span class="group-title">{{ category }}</span>
                  <el-button
                    v-if="hasEditable(category)"
                    type="primary"
                    size="small"
                    :loading="savingKeys.has(category)"
                    :disabled="!canWrite"
                    @click="saveCategory(category)"
                  >保存</el-button>
                </div>
              </template>
              <el-form label-position="top" class="group-form">
                <el-form-item
                  v-for="row in settingsByCategory[category]"
                  :key="row.settingKey"
                  :label="row.description || row.settingKey"
                >
                  <div v-if="row.editable !== 1" class="field-readonly">{{ row.value || '未设置' }}</div>
                  <template v-else>
                    <el-switch
                      v-if="isBooleanSetting(row.settingKey)"
                      :model-value="plainModel[row.settingKey] === 'true'"
                      :disabled="!canWrite"
                      @change="(val: string | number | boolean) => { plainModel[row.settingKey] = val === true ? 'true' : 'false' }"
                    />
                    <el-select
                      v-else-if="row.settingKey === 'weixin.agentId'"
                      v-model="plainModel[row.settingKey]"
                      :disabled="!canWrite"
                      clearable
                      filterable
                      placeholder="默认 Agent"
                      style="width: 100%"
                    >
                      <el-option v-for="agent in agents" :key="agent.id" :label="agentLabel(agent)" :value="String(agent.id)" />
                    </el-select>
                    <el-select
                      v-else-if="isModelSetting(row.settingKey)"
                      v-model="plainModel[row.settingKey]"
                      :disabled="!canWrite"
                      clearable
                      filterable
                      placeholder="默认模型"
                      style="width: 100%"
                    >
                      <el-option v-for="model in models" :key="model.id" :label="modelLabel(model)" :value="String(model.id)" />
                    </el-select>
                    <el-input-number
                      v-else-if="isNumericKey(row.settingKey)"
                      :model-value="toNumberOrNull(plainModel[row.settingKey])"
                      :min="1"
                      :step="1"
                      step-strictly
                      controls-position="right"
                      :disabled="!canWrite"
                      style="width: 100%"
                      @update:model-value="(val: number | undefined) => { plainModel[row.settingKey] = val == null ? '' : String(val) }"
                    />
                    <el-input
                      v-else
                      v-model="plainModel[row.settingKey]"
                      :type="row.isSecret === 1 ? 'password' : 'text'"
                      :placeholder="row.isSecret === 1 && row.value ? '已设置，留空表示不修改' : ''"
                      :disabled="!canWrite"
                      autocomplete="new-password"
                    />
                    <div class="field-hint">{{ row.settingKey }}</div>
                  </template>
                </el-form-item>
              </el-form>
            </el-card>
          </section>
        </div>
      </div>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { computed, reactive, ref, nextTick, onBeforeUnmount, onActivated } from 'vue'
import { ElMessage } from 'element-plus'
import { Refresh } from '@element-plus/icons-vue'
import { api } from '../../api'
import { useAuthStore } from '../../stores/auth'
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
  'harness.compaction.enabled', 'harness.compaction.contextWindowTokens', 'harness.compaction.triggerRatio', 'harness.compaction.maxSummaryTokens', 'harness.compaction.loopMidwayCompact',
  'harness.llm.rateLimitMaxRetries', 'harness.llm.rateLimitRetryDelaySeconds', 'harness.llm.rateLimitMaxRetryDelaySeconds', 'harness.llm.callTimeoutSeconds', 'harness.llm.httpCallTimeoutSeconds', 'harness.llm.streamIdleTimeoutSeconds',
  'harness.webPage.connectTimeout', 'harness.webPage.readTimeout', 'harness.webPage.maxRawBytes', 'harness.webPage.maxOutputLength', 'harness.webPage.userAgent',
  'harness.shell.maxSessionsPerConversation', 'harness.shell.sessionIdleTimeoutMinutes', 'harness.shell.sessionMaxLifetimeHours',
  'harness.delegate.timeoutSeconds', 'harness.delegate.cancelGraceSeconds',
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
  { id: 'setting-group-harness-compaction', label: '上下文压缩' },
  { id: 'setting-group-harness-llm', label: 'LLM 超时与重试' },
  { id: 'setting-group-harness-webpage', label: '网页抓取' },
  { id: 'setting-group-harness-shell', label: 'Shell 会话' },
  { id: 'setting-group-harness-delegate', label: '子代理执行' },
]

const loading = ref(false)
const settings = ref<any[]>([])
const agents = ref<any[]>([])
const models = ref<any[]>([])
const activeSection = ref('')
/** 分类卡片表单编辑副本：进入/刷新时从 rows 拷贝，保存成功后回写。secret 留空 = 不修改。 */
const plainModel = reactive<Record<string, string>>({})
const savingKeys = ref(new Set<string>())

/** 数值类配置键：渲染为数字输入。 */
const NUMERIC_KEYS = new Set(['audit.retentionDays', 'agent.threadPoolSize', 'agent.threadPoolMax', 'agent.threadPoolQueue', 'ws.idleTimeoutMs', 'notify.workerDelayMs', 'notify.batchSize', 'notify.maxAttempts', 'file.maxSizeMb'])

function isNumericKey(key: string): boolean {
  return NUMERIC_KEYS.has(key)
}

function toNumberOrNull(raw: string | undefined): number | undefined {
  if (raw == null || String(raw).trim() === '') return undefined
  const n = Number(raw)
  return Number.isFinite(n) ? n : undefined
}

function syncPlainModel() {
  for (const row of settings.value) {
    if (INTEGRATION_KEYS.has(row.settingKey)) continue
    if (plainModel[row.settingKey] === undefined) {
      plainModel[row.settingKey] = row.isSecret === 1 ? '' : (row.value ?? '')
    }
  }
}

function hasEditable(category: string): boolean {
  return (settingsByCategory.value[category] || []).some((row) => row.editable === 1)
}

/** 分类卡片批量保存：先整体校验数值，再走 batch 接口，失败任一条则整体报错。 */
async function saveCategory(category: string) {
  if (!canWrite.value || savingKeys.value.has(category)) return
  const rows = settingsByCategory.value[category] || []
  const items: Array<{ key: string; value: string | null }> = []
  for (const row of rows) {
    if (row.editable !== 1) continue
    const raw = plainModel[row.settingKey] ?? ''
    if (row.isSecret === 1) {
      // secret 语义：非空=保存新值；空串=不修改（null）
      items.push({ key: row.settingKey, value: raw !== '' ? raw : null })
      continue
    }
    if (isNumericKey(row.settingKey) && String(raw).trim() !== '') {
      const n = Number(raw)
      if (!Number.isInteger(n) || n <= 0) {
        ElMessage.error(`「${row.description || row.settingKey}」需为正整数`)
        return
      }
    }
    items.push({ key: row.settingKey, value: raw })
  }
  if (items.length === 0) return
  savingKeys.value = new Set([...savingKeys.value, category])
  try {
    await api.put('/system-settings/batch', { items })
    for (const item of items) {
      const row = rows.find((r: any) => r.settingKey === item.key)
      if (row) {
        if (row.isSecret === 1) {
          row.value = item.value == null ? row.value : '******'
          plainModel[row.settingKey] = ''
        } else {
          row.value = item.value ?? ''
          plainModel[row.settingKey] = item.value ?? ''
        }
      }
    }
    ElMessage.success('已保存，配置即时生效')
  } finally {
    const next = new Set(savingKeys.value)
    next.delete(category)
    savingKeys.value = next
  }
}

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
    syncPlainModel()
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

/* 分类卡片：与 IntegrationConfigPanel 的 group-card 同款风格 */
.group-card {
  border-radius: 10px;
}

.group-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.group-title {
  font-weight: 600;
  font-size: 14px;
  color: var(--mao-ink);
}

.group-form :deep(.el-form-item) {
  margin-bottom: 16px;
}

.group-form :deep(.el-form-item:last-child) {
  margin-bottom: 0;
}

.field-hint {
  font-size: 12px;
  color: var(--mao-muted);
  line-height: 1.4;
  margin-top: 2px;
}

.field-readonly {
  font-size: 14px;
  color: var(--mao-ink);
  padding: 6px 0;
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
}
</style>
