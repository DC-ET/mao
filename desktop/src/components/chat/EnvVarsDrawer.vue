<template>
  <el-drawer
    v-model="visible"
    class="env-vars-drawer"
    size="min(560px, calc(100vw - 32px))"
    append-to-body
    destroy-on-close
    :with-header="true"
    title="环境变量"
  >
    <div class="drawer-body">
      <el-alert
        type="info"
        :closable="false"
        show-icon
        title="以下为服务端配置态视图，非逐命令实测值；排查执行问题请以 shell 内 env 输出为准。"
      />

      <section class="drawer-section">
        <div class="section-title">
          <span>当前工作区变量</span>
          <button v-if="hasWorkspace" class="mini-btn" @click="openCreateDialog">
            <el-icon :size="12"><Plus /></el-icon>
            新增
          </button>
        </div>
        <p class="section-hint">
          绑定：<code>{{ workspaceLabel }}</code>。仅对你的会话生效，与用户全局变量互不影响。
        </p>

        <div v-if="!hasWorkspace" class="empty-state">
          当前会话未指定工作区（全局工作区）。工作区变量需在指定项目的会话中配置，或改用设置页的用户全局变量。
        </div>
        <div v-else-if="loadingWorkspace" class="empty-state">加载中...</div>
        <div v-else-if="workspaceVariables.length === 0" class="empty-state">当前工作区暂无变量</div>
        <div v-else class="workspace-list">
          <div v-for="item in workspaceVariables" :key="item.id" class="workspace-item">
            <div class="workspace-item-main">
              <span class="env-key">{{ item.envKey }}</span>
              <span class="env-value">****</span>
              <span v-if="item.note" class="env-note">{{ item.note }}</span>
            </div>
            <div class="workspace-item-actions">
              <template v-if="deletingId === item.id">
                <button class="action-btn action-btn-danger" title="确认删除" @click="confirmDelete(item)">
                  <el-icon :size="12"><Check /></el-icon>
                </button>
                <button class="action-btn" title="取消" @click="deletingId = null">
                  <el-icon :size="12"><Close /></el-icon>
                </button>
              </template>
              <template v-else>
                <button class="action-btn" title="编辑" @click="openEditDialog(item)">
                  <el-icon :size="12"><Edit /></el-icon>
                </button>
                <button class="action-btn action-btn-danger" title="删除" @click="deletingId = item.id">
                  <el-icon :size="12"><Delete /></el-icon>
                </button>
              </template>
            </div>
          </div>
        </div>
      </section>

      <section class="drawer-section">
        <div class="section-title">
          <span>当前生效变量</span>
          <el-tag v-if="!effective.enabled" type="warning" size="small">总开关已关闭</el-tag>
        </div>
        <p class="section-hint">
          优先级：工作区 &gt; 用户全局 &gt; 系统全局；平台内置凭据不可覆盖。值一律 <code>****</code>，不回显。
        </p>

        <div v-if="loadingEffective" class="empty-state">加载中...</div>
        <div v-else-if="effective.items.length === 0" class="empty-state">暂无生效变量</div>
        <div v-else class="source-groups">
          <div v-for="group in sourceGroups" :key="group.source" class="source-group">
            <div class="source-header" @click="toggleGroup(group.source)">
              <el-icon :size="12" class="chevron" :class="{ open: isGroupOpen(group.source) }">
                <ArrowRight />
              </el-icon>
              <span class="source-label">{{ group.label }}</span>
              <span class="source-count">{{ group.items.length }}</span>
            </div>
            <div v-if="isGroupOpen(group.source)" class="source-items">
              <div v-for="item in visibleItems(group)" :key="`${group.source}:${item.envKey}`" class="source-item">
                <span class="env-key">{{ item.envKey }}</span>
                <span v-if="item.note" class="env-note">{{ item.note }}</span>
              </div>
              <div v-if="group.items.length > visibleItems(group).length" class="more-hint">
                共 {{ group.items.length }} 项，已折叠显示前 {{ GROUP_VISIBLE_LIMIT }} 项
              </div>
            </div>
          </div>
        </div>
      </section>

      <p class="footer-hint">
        保存后 Agent 会话最多 5 秒内生效；已打开的交互终端需重开。
        保留键（<code>PATH</code> / <code>HOME</code> / <code>MAO_TOKEN</code> 等）不可配置。
      </p>
    </div>

    <el-dialog
      v-model="dialogVisible"
      :title="isEditing ? '编辑工作区变量' : '新增工作区变量'"
      width="440px"
      class="env-variable-dialog management-dialog"
      append-to-body
      @closed="resetForm"
    >
      <el-form :model="form" label-position="top">
        <el-form-item label="变量名" :error="keyError">
          <el-input
            v-model="form.envKey"
            placeholder="如 JAVA_HOME、GRADLE_USER_HOME"
            :disabled="isEditing"
            @input="validateKey"
          />
        </el-form-item>
        <el-form-item label="变量值">
          <el-input
            v-model="form.envValue"
            type="password"
            show-password
            :placeholder="isEditing ? '重新输入变量值（不回显）' : '变量值'"
          />
        </el-form-item>
        <el-form-item label="备注（选填）">
          <el-input v-model="form.note" placeholder="如：本项目专用 JDK" maxlength="256" />
        </el-form-item>
      </el-form>
      <template #footer>
        <button class="dialog-btn dialog-btn-cancel" @click="dialogVisible = false">取消</button>
        <button class="dialog-btn dialog-btn-confirm" :disabled="!canSubmit || submitting" @click="handleSubmit">
          {{ submitting ? '保存中…' : (isEditing ? '保存' : '创建') }}
        </button>
      </template>
    </el-dialog>
  </el-drawer>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ArrowRight, Check, Close, Delete, Edit, Plus } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import { api } from '../../api'

interface EnvVariableItem {
  id: number
  envKey: string
  note?: string | null
  createdAt?: string | null
  updatedAt?: string | null
}

interface EffectiveEnvItem {
  envKey: string
  source: 'SYSTEM' | 'USER' | 'WORKSPACE' | 'BUILTIN' | 'INHERITED'
  note: string | null
}

interface EffectiveEnvResult {
  enabled: boolean
  items: EffectiveEnvItem[]
  totals: { system: number; user: number; workspace: number; builtin: number; inherited: number }
}

const props = defineProps<{
  modelValue: boolean
  sessionId?: number | null
  workspace: string
}>()
const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>()

const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/
const RESERVED_PREFIXES = ['GIT_TOKEN_', 'MYSQL_', 'APP_', 'MAO_']
const RESERVED_KEYS = new Set([
  'GIT_ASKPASS', 'GIT_TERMINAL_PROMPT', 'JWT_SECRET', 'MAO_TOKEN', 'ECP_TOKEN',
  'LARKSUITE_CLI_USER_ACCESS_TOKEN', 'LARKSUITE_CLI_APP_ID', 'HOME', 'PATH', 'PWD', 'OLDPWD',
  'SHELL', 'USER', 'LOGNAME', 'TERM', 'COLORTERM', 'LANG', 'LC_ALL', 'TMPDIR', 'IFS',
  'PS1', 'PS2', 'PS4', 'BASH', 'BASHOPTS', 'BASH_ENV', 'ENV', 'LD_PRELOAD', 'LD_LIBRARY_PATH',
  'LD_AUDIT', 'DYLD_INSERT_LIBRARIES', 'NODE_OPTIONS', 'NODE_EXTRA_CA_CERTS', 'PYTHONSTARTUP',
  'PYTHONPATH', 'MAO_TASK_NAME', 'MAO_DEPS_BIN', 'NPM_CONFIG_PREFIX', 'PIP_TARGET',
  'PIP_BREAK_SYSTEM_PACKAGES',
])
const GROUP_VISIBLE_LIMIT = 30

const visible = computed({
  get: () => props.modelValue,
  set: (value: boolean) => emit('update:modelValue', value)
})

const loadingEffective = ref(false)
const loadingWorkspace = ref(false)
const effective = ref<EffectiveEnvResult>({
  enabled: true,
  items: [],
  totals: { system: 0, user: 0, workspace: 0, builtin: 0, inherited: 0 }
})
const workspaceVariables = ref<EnvVariableItem[]>([])
const openGroups = ref<Set<string>>(new Set(['SYSTEM', 'USER', 'WORKSPACE', 'BUILTIN']))
const deletingId = ref<number | null>(null)

const dialogVisible = ref(false)
const isEditing = ref(false)
const editingId = ref<number | null>(null)
const submitting = ref(false)
const keyError = ref('')
const form = ref({ envKey: '', envValue: '', note: '' })

const SOURCE_LABELS: Record<EffectiveEnvItem['source'], string> = {
  SYSTEM: '系统全局',
  USER: '用户全局',
  WORKSPACE: '当前工作区',
  BUILTIN: '平台内置',
  INHERITED: '继承（服务端环境）'
}
const SOURCE_ORDER: Array<EffectiveEnvItem['source']> = ['WORKSPACE', 'USER', 'SYSTEM', 'BUILTIN', 'INHERITED']

const workspaceLabel = computed(() => props.workspace?.trim() ? props.workspace : '全局工作区（未指定项目）')
const hasWorkspace = computed(() => !!props.workspace?.trim())

const sourceGroups = computed(() => SOURCE_ORDER
  .map((source) => ({
    source,
    label: SOURCE_LABELS[source],
    items: effective.value.items.filter((item) => item.source === source)
  }))
  .filter((group) => group.items.length > 0))

function isGroupOpen(source: string): boolean {
  return openGroups.value.has(source)
}

function toggleGroup(source: string) {
  const next = new Set(openGroups.value)
  if (next.has(source)) next.delete(source)
  else next.add(source)
  openGroups.value = next
}

function visibleItems(group: { source: EffectiveEnvItem['source']; items: EffectiveEnvItem[] }) {
  if (group.source === 'INHERITED' || group.source === 'BUILTIN') {
    return group.items.slice(0, GROUP_VISIBLE_LIMIT)
  }
  return group.items
}

function isReservedKey(key: string): boolean {
  const upper = key.toUpperCase()
  return RESERVED_KEYS.has(upper) || RESERVED_PREFIXES.some((prefix) => upper.startsWith(prefix))
}

function validateKey() {
  const key = form.value.envKey.trim()
  if (!key) {
    keyError.value = ''
    return
  }
  if (!KEY_PATTERN.test(key)) {
    keyError.value = '变量名须以字母或下划线开头，仅含字母/数字/下划线，最长 128 字符'
    return
  }
  keyError.value = isReservedKey(key) ? `${key} 为平台保留变量，不允许配置` : ''
}

const canSubmit = computed(() => {
  if (submitting.value) return false
  if (!form.value.envKey.trim() || !KEY_PATTERN.test(form.value.envKey.trim())) return false
  if (isReservedKey(form.value.envKey.trim())) return false
  return form.value.envValue !== ''
})

async function loadEffective() {
  if (!props.sessionId) return
  loadingEffective.value = true
  try {
    const { data } = await api.get(`/sessions/${props.sessionId}/effective-env`)
    effective.value = data || { enabled: true, items: [], totals: { system: 0, user: 0, workspace: 0, builtin: 0, inherited: 0 } }
  } catch {
    // handled by interceptor
  } finally {
    loadingEffective.value = false
  }
}

async function loadWorkspaceVariables() {
  // 未指定工作区的会话绑定全局根：服务端允许存在这类变量，但抽屉不在此处管理（需显式项目）
  if (!props.workspace?.trim()) {
    workspaceVariables.value = []
    loadingWorkspace.value = false
    return
  }
  loadingWorkspace.value = true
  try {
    const { data } = await api.get('/user/workspace-env-variables', {
      params: { workspace: props.workspace?.trim() ? props.workspace : undefined }
    })
    workspaceVariables.value = data || []
  } catch {
    // handled by interceptor
  } finally {
    loadingWorkspace.value = false
  }
}

async function reload() {
  deletingId.value = null
  await Promise.all([loadEffective(), loadWorkspaceVariables()])
}

function openCreateDialog() {
  isEditing.value = false
  editingId.value = null
  form.value = { envKey: '', envValue: '', note: '' }
  keyError.value = ''
  dialogVisible.value = true
}

function openEditDialog(item: EnvVariableItem) {
  isEditing.value = true
  editingId.value = item.id
  form.value = { envKey: item.envKey, envValue: '', note: item.note || '' }
  keyError.value = ''
  dialogVisible.value = true
}

function resetForm() {
  form.value = { envKey: '', envValue: '', note: '' }
  isEditing.value = false
  editingId.value = null
  keyError.value = ''
}

async function handleSubmit() {
  if (!canSubmit.value) return
  submitting.value = true
  try {
    if (isEditing.value && editingId.value != null) {
      await api.put(`/user/workspace-env-variables/${editingId.value}`, {
        envValue: form.value.envValue,
        note: form.value.note.trim()
      })
      ElMessage.success('变量已更新')
    } else {
      await api.post('/user/workspace-env-variables', {
        workspacePath: props.workspace,
        envKey: form.value.envKey.trim(),
        envValue: form.value.envValue,
        note: form.value.note.trim() || undefined
      })
      ElMessage.success('变量已创建')
    }
    dialogVisible.value = false
    await reload()
  } catch {
    // handled by interceptor
  } finally {
    submitting.value = false
  }
}

async function confirmDelete(item: EnvVariableItem) {
  try {
    await api.delete(`/user/workspace-env-variables/${item.id}`)
    ElMessage.success(`已删除 ${item.envKey}`)
    deletingId.value = null
    await reload()
  } catch {
    // handled by interceptor
  }
}

watch(() => props.modelValue, (open) => {
  if (open) void reload()
})
</script>

<style scoped>
.drawer-body {
  display: flex;
  flex-direction: column;
  gap: 20px;
  padding-bottom: 16px;
}

.drawer-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.section-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 14px;
  font-weight: 600;
  color: var(--aw-ink);
}

.section-hint {
  margin: 0;
  font-size: 12px;
  color: var(--aw-ink-muted);
  line-height: 1.6;
}

.section-hint code,
.footer-hint code {
  padding: 0 3px;
  border-radius: 3px;
  background: var(--aw-surface-hover);
  font-family: var(--aw-font-mono, monospace);
}

.empty-state {
  padding: 20px 12px;
  text-align: center;
  color: var(--aw-ink-muted);
  font-size: 12px;
}

.source-groups {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.source-group {
  border: 1px solid var(--aw-divider-soft);
  border-radius: 8px;
  background: var(--aw-surface);
  overflow: hidden;
}

.source-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 10px;
  cursor: pointer;
  user-select: none;
}

.source-header:hover {
  background: var(--aw-surface-hover);
}

.chevron {
  transition: transform 0.15s;
}

.chevron.open {
  transform: rotate(90deg);
}

.source-label {
  flex: 1;
  font-size: 12px;
  font-weight: 500;
  color: var(--aw-ink);
}

.source-count {
  min-width: 20px;
  padding: 0 6px;
  border-radius: 999px;
  background: var(--aw-surface-hover);
  color: var(--aw-ink-muted);
  font-size: 11px;
  text-align: center;
}

.source-items {
  border-top: 1px solid var(--aw-divider-soft);
  max-height: 220px;
  overflow: auto;
}

.source-item {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 5px 10px;
  font-size: 12px;
  border-bottom: 1px solid var(--aw-divider-soft);
}

.source-item:last-child {
  border-bottom: none;
}

.env-key {
  font-family: var(--aw-font-mono, monospace);
  color: var(--aw-ink);
  word-break: break-all;
}

.env-value {
  font-family: var(--aw-font-mono, monospace);
  color: var(--aw-ink-muted);
}

.env-note {
  color: var(--aw-ink-muted);
  font-size: 11px;
}

.more-hint {
  padding: 6px 10px;
  color: var(--aw-ink-muted);
  font-size: 11px;
}

.workspace-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.workspace-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border: 1px solid var(--aw-divider-soft);
  border-radius: 8px;
  background: var(--aw-surface);
}

.workspace-item-main {
  display: flex;
  align-items: baseline;
  gap: 8px;
  flex: 1;
  min-width: 0;
  flex-wrap: wrap;
  font-size: 12px;
}

.workspace-item-actions {
  display: flex;
  gap: 2px;
  flex: 0 0 auto;
}

.action-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border: none;
  border-radius: 6px;
  background: var(--aw-surface-hover);
  color: var(--aw-ink-muted);
  cursor: pointer;
}

.action-btn:hover {
  color: var(--aw-ink);
}

.action-btn-danger:hover {
  color: var(--aw-danger);
}

.mini-btn {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  height: 24px;
  padding: 0 8px;
  border: 1px solid var(--aw-divider-soft);
  border-radius: 6px;
  background: var(--aw-surface);
  color: var(--aw-ink);
  font-size: 12px;
  cursor: pointer;
}

.mini-btn:hover {
  background: var(--aw-surface-hover);
}

.footer-hint {
  margin: 0;
  padding-top: 4px;
  border-top: 1px solid var(--aw-divider-soft);
  color: var(--aw-ink-muted);
  font-size: 11px;
  line-height: 1.6;
}

.dialog-btn {
  height: var(--aw-btn-height);
  padding: var(--aw-btn-padding);
  border-radius: var(--aw-radius-xs);
  border: 1px solid var(--aw-divider-soft);
  background: var(--aw-surface);
  color: var(--aw-ink);
  font-size: var(--aw-text-fine);
  cursor: pointer;
}

.dialog-btn-confirm {
  margin-left: 8px;
  border-color: var(--aw-primary);
  background: var(--aw-primary);
  color: #fff;
}

.dialog-btn-confirm:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
