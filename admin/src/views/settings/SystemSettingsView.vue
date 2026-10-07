<template>
  <div class="system-settings">
    <el-card class="page-card">
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
            <template v-for="group in tocGroups" :key="group.label">
              <div class="toc-group-title">{{ group.label }}</div>
              <div
                v-for="item in group.sections"
                :key="item.id"
                class="toc-item"
                :class="{ active: activeSection === item.id }"
                @click="scrollToSection(item.id)"
              >
                {{ item.label }}
              </div>
            </template>
          </div>
        </aside>

        <div class="settings-content">
          <template v-for="group in tocGroups" :key="group.label">
            <template v-for="section in group.sections" :key="section.id">
              <CompanySsoConfigPanel
                v-if="section.kind === 'company-sso'"
                :row="companySsoRow"
                :can-write="canWrite"
                :ready="settingsLoaded && !loading"
                @saved="fetchSettings"
              />
              <EcpConfigPanel
                v-else-if="section.kind === 'ecp'"
                :row="ecpRow"
                :can-write="canWrite"
                :ready="settingsLoaded && !loading"
                @saved="fetchSettings"
              />
              <template v-else-if="section.kind === 'integration'">
                <el-alert
                  v-if="section.name === firstIntegrationName"
                  type="info"
                  :closable="false"
                  show-icon
                  title="集成配置保存后即时生效；Agent 运行 / Harness 调参为启动时构建，保存后需重启后端生效。加密项保存后仅显示掩码，留空表示不修改。"
                  class="integration-tip"
                />
                <IntegrationConfigPanel
                  :rows="integrationRows"
                  :group-name="section.name"
                  :can-write="canWrite"
                  @saved="fetchSettings"
                />
              </template>
              <section v-else :id="`setting-cat-${section.name}`" class="setting-section">
                <el-card class="group-card" shadow="never">
                  <template #header>
                    <div class="group-header">
                      <span class="group-title">{{ section.name }}</span>
                      <el-button
                        v-if="hasEditable(section.name)"
                        type="primary"
                        size="small"
                        :loading="savingKeys.has(section.name)"
                        :disabled="!canWrite"
                        @click="saveCategory(section.name)"
                      >保存</el-button>
                    </div>
                  </template>
                  <el-form label-position="top" class="group-form">
                    <el-form-item
                      v-for="row in settingsByCategory[section.name]"
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
                          <el-option
                            v-for="agent in agents"
                            :key="agent.id"
                            :label="agentLabel(agent)"
                            :value="String(agent.id)"
                            :disabled="agent.enabled === false"
                          />
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
                        >
                          <template v-if="row.isSecret === 1 && row.value" #append>
                            <el-button
                              v-if="!pendingClearKeys.has(row.settingKey)"
                              :disabled="!canWrite"
                              @click="markSecretClear(row.settingKey)"
                            >清除</el-button>
                            <el-tag v-else type="danger" size="small" closable @close="unmarkSecretClear(row.settingKey)">将清除</el-tag>
                          </template>
                        </el-input>
                        <div v-if="row.settingKey === 'bundle.registry.accessToken' && row.value" class="field-hint">当前 token：{{ row.value }}</div>
                        <div class="field-hint">{{ row.settingKey }}</div>
                      </template>
                    </el-form-item>
                  </el-form>
                </el-card>
              </section>
            </template>
          </template>
        </div>
      </div>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { computed, reactive, ref, nextTick, onBeforeUnmount, onActivated, onMounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Refresh } from '@element-plus/icons-vue'
import { api } from '../../api'
import { useAuthStore } from '../../stores/auth'
import IntegrationConfigPanel from './components/IntegrationConfigPanel.vue'
import CompanySsoConfigPanel from './components/CompanySsoConfigPanel.vue'
import EcpConfigPanel from './components/EcpConfigPanel.vue'
import { COMPANY_SSO_KEY } from './companySsoConfig'
import { ECP_CONFIG_KEY } from './ecpConfig'

const authStore = useAuthStore()
/** 后端 PUT /system-settings/:key 需 settings:write，无权限时禁用全部写控件 */
const canWrite = computed(() => authStore.hasPermission('settings:write'))

const MODEL_SELECT_KEYS = new Set(['weixin.modelId', 'session.titleModelId', 'git.commitMessageModelId', 'approval.modelId', 'memory.extractionModelId'])
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
  'terminal.maxSessionsPerTask', 'terminal.maxSessionsGlobal', 'terminal.idleTimeoutMinutes', 'terminal.maxLifetimeHours', 'terminal.outputBufferBytes',
])

/** 集成组显示名：key 为 IntegrationConfigPanel 的 group name，锚点 id 为 `setting-group-${name}`。 */
const INTEGRATION_LABELS: Record<string, string> = {
  ldap: 'LDAP 认证',
  feishu: '飞书 OAuth 登录',
  upload: '上传配置',
  oss: 'OSS 对象存储',
  agent: 'Agent 运行',
  'harness-llm': 'LLM 超时与重试',
  'harness-compaction': '上下文压缩',
  tools: '网络工具',
  'harness-webpage': '网页抓取',
  'harness-shell': 'Shell 会话',
  terminal: '云端终端',
  notify: '任务通知',
}

/** 目录分组声明：右侧卡片渲染顺序与目录一致。integration=集成配置组，category=后端 system_setting 分类；后端新增的未声明分类兜底归入「其他」。 */
const TOC_GROUPS: Array<{ label: string; sections: Array<{ kind: 'company-sso' | 'ecp' | 'integration' | 'category'; name: string }> }> = [
  {
    label: '登录认证',
    sections: [
      { kind: 'company-sso', name: 'company-sso' },
      { kind: 'ecp', name: 'ecp' },
      { kind: 'integration', name: 'ldap' },
      { kind: 'integration', name: 'feishu' },
    ],
  },
  {
    label: '文件与存储',
    sections: [
      { kind: 'integration', name: 'upload' },
      { kind: 'integration', name: 'oss' },
    ],
  },
  {
    label: 'Agent 与模型',
    sections: [
      { kind: 'integration', name: 'agent' },
      { kind: 'category', name: 'Agent 资产' },
      { kind: 'integration', name: 'harness-llm' },
      { kind: 'integration', name: 'harness-compaction' },
      { kind: 'category', name: '会话' },
      { kind: 'category', name: '分享' },
      { kind: 'category', name: '代码' },
      { kind: 'category', name: '审批' },
      { kind: 'category', name: '记忆' },
    ],
  },
  {
    label: '工具与终端',
    sections: [
      { kind: 'integration', name: 'tools' },
      { kind: 'integration', name: 'harness-webpage' },
      { kind: 'integration', name: 'harness-shell' },
      { kind: 'integration', name: 'terminal' },
    ],
  },
  {
    label: '通知与消息',
    sections: [
      { kind: 'integration', name: 'notify' },
      { kind: 'category', name: '微信' },
    ],
  },
  {
    label: '平台与运维',
    sections: [
      { kind: 'category', name: '审计' },
      { kind: 'category', name: '运行环境' },
    ],
  },
]

const loading = ref(false)
const settingsLoaded = ref(false)
const settings = ref<any[]>([])
const companySsoRow = computed(() => settings.value.find((item) => item.settingKey === COMPANY_SSO_KEY))
const ecpRow = computed(() => settings.value.find((item) => item.settingKey === ECP_CONFIG_KEY))
const SPECIAL_KEYS = new Set([...INTEGRATION_KEYS, COMPANY_SSO_KEY, ECP_CONFIG_KEY])
const agents = ref<any[]>([])
const models = ref<any[]>([])
const activeSection = ref('')
/** 分类卡片表单编辑副本：进入/刷新时从 rows 拷贝，保存成功后回写。secret 留空 = 不修改。 */
const plainModel = reactive<Record<string, string>>({})
const savingKeys = ref(new Set<string>())
/** 待清除的 secret key 集合：保存时提交空串（后端 isSecret=1 空串=显式清空），从已设置 secret 的输入框旁触发 */
const pendingClearKeys = ref(new Set<string>())

function markSecretClear(key: string) {
  const next = new Set(pendingClearKeys.value)
  next.add(key)
  pendingClearKeys.value = next
}

function unmarkSecretClear(key: string) {
  const next = new Set(pendingClearKeys.value)
  next.delete(key)
  pendingClearKeys.value = next
}

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

// 无条件以服务端值覆盖：早期只填 undefined 的键，导致「刷新」对已渲染字段完全无效——
// 既不丢弃本地未保存编辑也不拉取最新值，多人同时改配置时还会用陈旧值覆盖别人的修改。
// secret 字段仍统一置空，空串在保存时语义为「不修改」。
function syncPlainModel() {
  for (const row of settings.value) {
    if (SPECIAL_KEYS.has(row.settingKey)) continue
    plainModel[row.settingKey] = row.isSecret === 1 ? '' : (row.value ?? '')
  }
  // 待清除标记是绑在刷新前那批值上的，同步后必须一起丢弃，否则下次保存会误清空 secret
  if (pendingClearKeys.value.size > 0) {
    pendingClearKeys.value = new Set()
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
      if (pendingClearKeys.value.has(row.settingKey)) {
        // 显式清除：提交空串，后端对 isSecret=1 的空串做清空落库
        items.push({ key: row.settingKey, value: '' })
        continue
      }
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
    const clearedKeys = new Set(pendingClearKeys.value)
    pendingClearKeys.value = new Set()
    for (const item of items) {
      const row = rows.find((r: any) => r.settingKey === item.key)
      if (row) {
        if (row.isSecret === 1) {
          if (clearedKeys.has(row.settingKey)) {
            row.value = ''
            plainModel[row.settingKey] = ''
          } else if (item.value == null) {
            // 留空未修改，保留已设置标记
          } else {
            row.value = '******'
            plainModel[row.settingKey] = ''
          }
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
    if (SPECIAL_KEYS.has(item.settingKey)) continue
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
    if (SPECIAL_KEYS.has(item.settingKey)) continue
    const category = item.category || '未分类'
    if (!map[category]) map[category] = []
    map[category].push(item)
  }
  return map
})

interface TocSection {
  id: string
  label: string
  kind: 'company-sso' | 'ecp' | 'integration' | 'category'
  name: string
}

interface TocGroup {
  label: string
  sections: TocSection[]
}

/** 目录分组：按 TOC_GROUPS 声明过滤出实际有内容的条目（集成组依赖集成配置行存在，分类依赖后端返回该分类）。 */
const tocGroups = computed<TocGroup[]>(() => {
  const integrationVisible = integrationRows.value.length > 0
  const knownCategories = new Set(categories.value)
  const declaredCategories = new Set<string>()
  const groups: TocGroup[] = []
  for (const group of TOC_GROUPS) {
    const sections: TocSection[] = []
    for (const decl of group.sections) {
      if (decl.kind === 'integration' && !integrationVisible) continue
      if (decl.kind === 'category') {
        declaredCategories.add(decl.name)
        if (!knownCategories.has(decl.name)) continue
      }
      sections.push({
        kind: decl.kind,
        name: decl.name,
        id: decl.kind === 'category'
          ? `setting-cat-${decl.name}`
          : decl.kind === 'company-sso'
            ? 'setting-group-company-sso'
            : decl.kind === 'ecp'
              ? 'setting-group-ecp'
              : `setting-group-${decl.name}`,
        label: decl.kind === 'integration'
          ? (INTEGRATION_LABELS[decl.name] ?? decl.name)
          : decl.kind === 'company-sso'
            ? '公司 SSO'
            : decl.kind === 'ecp'
              ? 'ECP 飞书登录'
              : decl.name,
      })
    }
    if (sections.length > 0) groups.push({ label: group.label, sections })
  }
  const unknown = categories.value.filter((category) => !declaredCategories.has(category))
  if (unknown.length > 0) {
    groups.push({ label: '其他', sections: unknown.map((name) => ({ kind: 'category' as const, name, id: `setting-cat-${name}`, label: name })) })
  }
  return groups
})

/** 目录平铺条目：滚动跳转与高亮用。 */
const toc = computed(() => tocGroups.value.flatMap((group) => group.sections))

const firstIntegrationName = computed(() => toc.value.find((section) => section.kind === 'integration')?.name ?? '')

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
    const { data } = await api.get('/agents', { params: { includeDisabled: true } })
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
    settingsLoaded.value = true
    syncPlainModel()
    await nextTick(setupObserver)
  } catch { /* 拦截器已提示失败，吞掉避免误报页面异常 */ } finally {
    loading.value = false
  }
}

function agentLabel(agent: any) {
  const name = agent.isDefault ? `${agent.name}（默认）` : agent.name
  return agent.enabled === false ? `${name}（已停用）` : name
}

function modelLabel(model: any) {
  return model.isDefault ? `${model.name}（默认）` : model.name
}

function hasUnsavedEdits(): boolean {
  if (pendingClearKeys.value.size > 0) return true
  for (const row of settings.value) {
    if (SPECIAL_KEYS.has(row.settingKey)) continue
    const current = plainModel[row.settingKey] ?? ''
    const baseline = row.isSecret === 1 ? '' : (row.value ?? '')
    if (current !== baseline) return true
  }
  return false
}

let firstActivation = true
onMounted(() => {
  void fetchSettings()
})

onActivated(() => {
  if (firstActivation) {
    firstActivation = false
    return
  }
  if (!hasUnsavedEdits()) {
    void fetchSettings()
    return
  }
  ElMessageBox.confirm('当前有未保存的修改，刷新将丢弃这些改动。', '未保存的修改', {
    confirmButtonText: '丢弃并刷新',
    cancelButtonText: '保留本地编辑',
    type: 'warning'
  })
    .then(() => {
      void fetchSettings()
    })
    .catch(() => {
      // 保留本地编辑，不覆盖 plainModel / pendingClearKeys
    })
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

/* Element Plus 卡片默认 overflow: hidden / body auto，会把 sticky 目录关在卡片内使其失效；
   本页放开这两层，让 .toc 相对真正的页面滚动容器 .layout-content 粘滞 */
.page-card {
  overflow: visible;
}

.page-card > :deep(.el-card__body) {
  overflow: visible;
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

.toc-group-title {
  margin: 10px 0 2px;
  padding: 0 8px;
  font-size: 11px;
  font-weight: 600;
  color: var(--mao-muted);
  letter-spacing: 0.5px;
}

.toc-group-title:first-child {
  margin-top: 0;
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

.integration-tip {
  border-radius: 8px;
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
